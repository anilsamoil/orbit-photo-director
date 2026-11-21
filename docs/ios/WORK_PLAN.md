# SNAP for iPhone and iPad: work plan

Who does what, in what order, and how each piece is shown to work. Read [the design doc](../designs/ios-app.md) for why and [ARCHITECTURE.md](ARCHITECTURE.md) for the shape. This file is the one the implementer and the organizer work from.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| Implementer | Codex | One work package per pull request, in a worktree. Writes the tests the package names. Attaches the proof. |
| Organizer | Grokbot (poteto) | Opens one tracking issue per work package. Keeps the order and the gates. Reviews and proves each pull request. Keeps `DECISIONS.md` and `STATUS.md`. Chases owner steps. Schedules refresh builds. |
| Owner | The operator | The steps in [OWNER_STEPS.md](OWNER_STEPS.md). Approves the Worker deploy, each release build and each gate that says so. |
| Planner | Claude | Wrote this plan. Revises it when a gate changes the facts. |

## Rules for every work package

1. Work in a git worktree. The main checkout runs the live generator daemon. Do not switch, reset or clean it.
2. One work package, one pull request. A pull request names its package id in the title: `ios W-10: web host seam, browser side`.
3. Preserve the website's existing behavior. W-20 blocks access to personal artifacts of deleted profiles on both map hosts. `bun run typecheck`, `bun run test` and `node scripts/verify-map-pins.mjs` stay green, and every rule in `AGENTS.md` still holds.
4. Nothing in `generator/` changes in release 1.
5. A package is done when its "Done when" list is true and its proof is attached to the pull request. "It compiles" is not done. A check that could not be run is written down as not run.
6. The Mac has Swift and no Xcode. `OPDKit` must build and test there with `swift test`, using Swift Testing. Anything that needs Xcode runs on the hosted workflow until Xcode is installed locally.
7. No secret in the repository, in a log or in a pull request. This repository is public. Agents never create, read or move Apple credentials; the owner places them.
8. A new dependency needs a line in `DECISIONS.md` with the reason. The host template and its core packages, chosen at gate G1, are the one set approved in advance.
9. A real bug found in existing code goes into `docs/ios/FOLLOWUPS.md` with a failing test or a clear reproduction, not into the package's pull request.
10. A decision made during the work goes into `DECISIONS.md`: one line, the date, the reason.

## Gates

A gate is a point where work stops until something is shown. The organizer records each result in `STATUS.md`.

| Gate | Shown by | Passes when | If it fails |
| --- | --- | --- | --- |
| G0 Signing prerequisites | Owner | The developer membership is active, the app record and app identifier exist, and the Xcode authentication key with signing access is in the protected `ios-release` environment. Ground delivery setup is in owner step 4. | Unsigned work continues. |
| G1 Host proof | W-02 on a simulator, then W-03 on a ground device | Every check in W-02 passes in the simulator matrix and on a signed ground build installed using TestFlight or W-74. Record the host choice. W-11, W-32 and W-41 may start after the simulator half, at risk. | Try the other host. If neither can draw Map and ISS view from a local origin, stop and tell the owner: the fallback is hardening the website. |
| G2 Offline acceptance | W-72, on the hosted workflow | Cold-launch offline; Earth draws; the ISS prediction moves; a target remains usable; an alert appears while locked; a recorded shot survives restart and uploads once. Then a new build installed over the previous one keeps the credential, the plan, the outbox, the kept tiles and the settings, and the queued entries upload once. | Fix before signing the feature release candidate in W-70. W-03 provides the earlier signed host proof. |
| G3 Ground device | Ground tester, checklist from W-72 | After G2, run the same checks with a test account on the App Store submission candidate installed through TestFlight or its matching W-74 export. Upgrade from a signed predecessor feature build on that channel. Pass W-33's controlled run on a development-signed build from the same revision, normal-path checks on the distribution candidate, and restore onto a second physical ground device. Use an iPad on iPadOS 26 first, and also an iPhone on iOS 26 if available. If a matching iPad is unavailable, use the closest eligible ground device plus the iPad destination on the closest available iOS 26 Simulator runtime. Record the actual ground and simulator versions, device classes and gaps in `STATUS.md`. | Fix before submitting that candidate to App Review. |
| G6 No-expiry route | W-71, then the ground tester | Apple approves the build and the listing is live, unlisted if approved or public if Apple declines the request. On the G3 ground device, install from the App Store over the ground build actually installed through TestFlight or W-74, without uninstalling. Verify every G2 state item survives and queued logs upload once. Launch offline and confirm the App Store build has no expiry date, banner or pending expiry alert. | Hold G7. Fix the failed check and resubmit if it requires a new build. |
| G7 Device approval | Owner, with W-71's approval packet | After G3 and G6 pass, the owner requests installation from the App Store listing. NASA approves SNAP and installs it on both orbit devices. | The website remains the tool. Answer what the device managers ask. |
| G4 Orbit | Owner, ten-minute checklist from W-72 | After G7, launch the NASA-installed App Store build. Enroll, go through a LOS period, check Queue and Upcoming coverage, see an alert, and log a shot. | The website remains the tool. Fix and resend. |
| G5 Crew | Owner | Fourteen days of orbit use with no lockout and no lost log. | Hold the crew rollout. |

### Testing without the iPad in orbit

NASA approval applies to every app on the orbit devices. SNAP uses simulators and a ground device for preflight testing.

- **Simulators.** The hosted workflow runs without Apple credentials. W-02 and W-72 use an 11-inch iPad Pro destination if available, or the closest iPad model, on the available iOS 26 Simulator runtime closest to the orbit iPad's version. Also use an iPhone 17 Pro destination if available, or the closest iPhone model, on the iOS 26 runtime closest to the orbit iPhone's version. Repeat on the newest supported runtime when it differs. Record the chosen runtime versions, destinations and gaps from the orbit targets. Use this same iPad selection for the G3 simulator fallback. The deployment target stays at 26.0.
- **Ground device.** The tester uses internal TestFlight or a W-74 ad hoc build on a registered device (owner step 4). G1 validates the host and its memory behavior. G3 exercises the integrated app, including background refresh and alert delivery.
- **Orbit: the App Store, installed by NASA.** The App Store is the only channel to the orbit devices, preferably unlisted, with a public listing if Apple declines the unlisted request (W-71). No TestFlight and no direct install reaches them.

### Delivery to the orbit devices

NASA manages the orbit devices, an 11-inch iPad Pro with M4 on iPadOS 26.6.2 and an iPhone 17 Pro on iOS 26.6.1. Every app needs NASA approval (G7).

1. The App Store listing (W-71), unlisted if Apple approves the request or public otherwise. After G3 and G6 pass, the owner asks NASA to approve and install the listed app. Builds do not expire. Each build goes through App Review, which takes days, so orbit fixes are slower than with TestFlight. For the first listing, choose public App Store distribution before submission and request unlisted distribution. Later versions inherit the approved method. Apple fixes public versus private distribution at approval. A later switch between public and private needs a new app record and review, but public-to-unlisted remains possible. See Apple's [distribution methods](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods/) and [unlisted distribution](https://developer.apple.com/support/unlisted-app-distribution/).
2. TestFlight and W-74 ad hoc delivery serve ground testing only. NASA will not approve TestFlight in orbit.
3. If NASA does not approve the app: the plan's fallback, hardening the website.

Download size has no project limit. Keep updates small for the station link. Schedule large downloads overnight.

## Order of work

Wave 0 needs no Apple account and starts now. The packages inside a wave can run in parallel unless "Needs" says otherwise.

```
Wave 0   W-00 ─┬─ W-01 ── W-02 (G1)
               ├─ W-10
               ├─ W-20 (design note, review, code; no deploy)
               ├─ W-30 ── W-31
               └─ W-40
G0       W-03 (needs W-02, G0, and ground setup): TestFlight or W-74 → signed ground host proof (G1)
         W-74 (ad hoc route only, needs W-02, G0, and device registration) feeds W-03
Wave 1   W-11 (needs W-10, W-02)   W-12 (needs W-10)   W-32 (needs W-30, W-31, W-02)   W-41 (needs W-40, W-11)
         W-21 (needs W-20, owner)   W-63 (needs W-30, W-10, W-20)
         W-32 also needs W-11
         W-71 policy preparation publishes the URL before W-21 enables deletion or W-72 builds the candidate
Wave 2   W-42   W-50   W-33 (needs W-50)   W-61   W-62
         W-60 (needs W-21, W-32, W-12, W-41, W-50)            then W-72 (G2)
Wave 3   W-70 (needs W-03, W-63, G2) → G3 (TestFlight or W-74) → W-71 submission → G6
         G3 and G6 → G7 (owner request, NASA approval and install) → G4 → G5 → W-73
Later    W-80 and up, each with a measured reason
```

Target, not a promise: G2 about two weeks after Wave 0 starts. The first build in orbit follows App Review, the ground App Store upgrade at G6 and NASA installation at G7.

## Work packages

Sizes are agent effort: S is under a day, M is one to three days, L is more.

### W-00 Land the plan (S)
- **Change:** merge `docs/designs/ios-app.md` and `docs/ios/`. Add an "iOS app" paragraph to `AGENTS.md` that links them. Create `docs/ios/DECISIONS.md`, `FOLLOWUPS.md` and `STATUS.md`.
- **Done when:** an agent starting from `AGENTS.md` reaches this file in two links.

### W-01 App skeleton and hosted workflow, unsigned (M)
- **Change:** create `app/` from the default host template (Capacitor, Swift Package Manager, no CocoaPods), loading a placeholder page. Add `.github/workflows/ios.yml`: one job runs `swift test` in `app/OPDKit`; one job builds the app for the iOS Simulator and runs a launch test that saves a screenshot.
- **Done when:** the workflow is green on the pull request with no secrets; the screenshot and the test result bundle are artifacts; the runner image and Xcode version are pinned; `DECISIONS.md` records the generated layout.
- **Traps:** never use `pull_request_target` with a checkout of the pull request's code. Pull requests from forks get no secrets, and must not need any.

### W-02 Host proof, gate G1 (M)
- **Needs:** W-01.
- **Change:** a proof build that loads the real frontend with the fixture plan and the network disabled, and a test that checks, inside the web view:
  1. `isSecureContext` is true and `crypto.subtle.digest('SHA-256', ...)` matches a native digest of the same bytes.
  2. The MapLibre worker module starts, and the dynamic import of the map chunk resolves.
  3. A WebGL2 context is created.
  4. Map draws a tile served from a local source: a pixel probe finds non-background colour.
  5. ISS view draws from the offline fixture. Keep the pixel probe and reuse the geometry assertions in [the existing ISS G1 proof](../../frontend/src/map/adapters/maplibre/iss-g1-page.ts). Check the active projection is `vertical-perspective` at horizon, nadir, and zoom 12, and check the existing horizon limb-error limit of less than 1°. Run the geometry checks with bundled tiles and the network off.
  6. A bodyless `GET` for a plan and a bodyless `DELETE` for a target cross the bridge with their method, path and headers intact. Log `POST` and target `PUT` cross with the original fixture body intact, byte for byte. The receiving side checks that `GET` and `DELETE` carry no body.
  7. The tile route delivers at least 50 tiles a second.
  8. `localStorage` survives quitting and relaunching.
  9. After the web process is terminated, the shell reloads and the same tab is showing.
  10. A ten-minute scripted pan and zoom on Map and on ISS view finishes without a web process termination; peak memory is recorded.
- **Done when:** `docs/ios/G1-HOST-PROOF.md` lists each check with its result and the evidence, and `DECISIONS.md` records the host: the default, or a custom `WKWebView` host with its own scheme handler if a check fails under the default and passes under the custom host.
- **Traps:** a simulator proves items 1 to 9. Item 10 is only indicative on a simulator; W-03 repeats all ten on a real device. Set the deployment target to 26.0 and use the simulator matrix in [Testing without the iPad in orbit](#testing-without-the-ipad-in-orbit). Record the actual runtime and device gaps in the proof. A custom scheme handler may not receive request bodies; that is why item 6 exists.

### W-03 Signed host proof on a ground device (S)
- **Needs:** W-02, G0 and the ground route setup in owner step 4. The ad hoc route also needs W-74's signed fixture export.
- **Ground delivery.** Use internal TestFlight when available. Otherwise use W-74 on a registered ground device.
- **Change:** archive the W-02 proof on a clean hosted runner. Enable automatic provisioning and Apple Distribution signing for export. The App Store Connect API key authenticates Xcode through `xcodebuild` authentication flags and `-allowProvisioningUpdates`. In `ios-release`, `APP_STORE_CONNECT_KEY_ID` is the key ID string, `APP_STORE_CONNECT_ISSUER_ID` is the issuer ID UUID, and `APP_STORE_CONNECT_PRIVATE_KEY` is the full contents of the downloaded `.p8` file. Use Apple's [Xcode cloud-signing workflow](https://developer.apple.com/videos/play/wwdc2021/10204/?time=778).
- **Done when:** after owner approval, the clean workflow runner archives and exports the signed proof. For TestFlight, confirm upload, processing, availability to the internal tester, and installation. For W-74, confirm ad hoc export for the registered device, delivery and installation. A ground tester runs all ten W-02 checks and records the build, channel, device model, OS version and results in `G1-HOST-PROOF.md`. Record only redacted signing and delivery evidence.

### W-10 Web host seam, browser side (M)
- **Change:** add `frontend/src/host/` with the interface in ARCHITECTURE.md and `browser.ts`. Move every same-origin `fetch` to `host.request` (21 non-test files call `fetch`; classify each call as same-origin or other-origin first). Move the snapshot and the calibration queue storage behind `host.snapshot` and `host.outbox`. Add `routes.json` and `tile-layers.json`, and build the map sources and the prefetch URLs in `frontend/src/tile-precache.ts` through `host.tileUrl`.
- **Tests first:** a contract test that records every same-origin request (URL, method, headers, cache mode, body) for manifest, artifacts, log post and read, session, target routes, kp, aurora, wx, cloud, launch pointer and catalog, hazards, lightning and the probe. It is green on the old code and committed before anything moves. This is the rule in `AGENTS.md` for moving a capability.
- **Done when:** that contract test is still green; the new boundary tests fail on a planted violation (bare same-origin `fetch`, unclassified path, tile template outside the catalogue, `host.kind` read outside the seam); the three frontend checks are green; `drive all` in verify-opd is green.
- **Traps:** `main.ts` and `map/index.ts` are outside coverage, so the contract test is their only guard. `src/map/` allows no comments and no module-level `let`.

### W-11 Web host seam, iOS side (M)
- **Needs:** W-10, W-02. At risk until W-03 passes.
- **Change:** `ios.ts` over the bridge. A Vite mode `ios` that builds to `frontend/dist-ios` with no service worker, no PWA manifest and no `registerSW.js`. Mirror tier 2 storage by account, with separate storage for the baseline. Hide the `/api/app` recovery link and the install hints when `identity.v1` is present.
- **Done when:** unit tests drive `ios.ts` against a fake bridge for every route class. The `ios` build runs in the W-01 app on the fixture plan. Switching profile from the profile menu reloads the shell inside the app. A switch of active account clears the outgoing web state before restoring the incoming account's mirror. W-10's contract test confirms the browser build's behaviour is unchanged.

### W-12 Extended queue on the device (M)
- **Needs:** W-10.
- **Change:** `frontend/src/plan-extend/`, a pure module that runs in a Web Worker: passes for the published and personal targets from now to seven days out, with geometry, lighting regime and the three non-cloud score factors. Signed out, it uses the curated targets built into the app and the ISS element set from CelesTrak, or the one built into the app. It propagates the orbit once into a shared ephemeris and tests every target against it; the dropped-pin finder propagates per pin and is too slow for this. A published scored pass replaces the device pass for the same target when their closest approaches are within five minutes. Queue shows up to five passes in the next 90 minutes. It lists published picks first by score, then device passes by time. Upcoming lists published picks first, then device passes by time. Device passes carry `provenance: 'device'` and the "geometry only" tag, with no cloud number. Mark a device pass approximate when its closest-approach time minus the epoch of the orbit data used exceeds 48 hours, subject to the accuracy check. A script writes reference vectors from the Python pass finder for a fixed orbit and target set; use the generator's 800 km distance limit (`generator/config.py:56`), not the pin finder's 1,500 km.
- **Accuracy check:** predict passes from an element set seven days old and compare them with passes from the newest set, over a period that includes a reboost. Record the closest-approach timing error against a limit of 60 seconds, and set the "approximate" threshold from the result.
- **Done when:** the TypeScript results match the reference vectors inside the generator's sampling step; the accuracy check is recorded in `DECISIONS.md` with its threshold; computation time is measured on the closest ground device to the orbit iPad and the bar is set from that measurement, using a coarser time step with refinement near each closest approach if the ephemeris alone is too slow; a pass is marked approximate when its closest-approach time minus the epoch of the orbit data used exceeds the threshold, and the mark is recomputed when newer orbit data is installed; the feature is on for the `ios` host and off for the `browser` host behind one flag; with the flag off the website renders exactly as before; after the published Queue expires, Queue still shows a qualifying device pass in the next 90 minutes when one exists, and Upcoming shows qualifying later passes through the seven-day prediction horizon.
- Use one fixture to assert both lists. Within 90 minutes, include two later published picks out of score order and at least four earlier device passes out of time order. Assert that Queue shows the two published picks by score, followed by the three earliest device passes. Beyond 90 minutes, include published picks and device passes out of time order. Assert that Upcoming shows the published picks first, followed by device passes in time order. With the published Queue expired and the network off, assert that a qualifying next-90-minute pass appears in Queue. Place qualifying later passes beyond the published horizon, including one near the end of day seven. Assert that Upcoming includes those passes and Queue excludes them.
- **Traps:** pass times start from the wall clock, not the scrubbed map time. Do not import from `src/map/`.

### W-20 Device access in the Worker (L, security-sensitive)
- **Change.** Review the design note before implementation and review the Worker changes before deployment.
  1. `docs/ios/DEVICE-ACCESS.md`: both sign-in choices (Sign in with Apple and Google through Access), open account creation for any Apple ID or Google account with no approval step, per-account quotas, sign-out, account deletion, the threat model, the enrollment sequence including the single-use Apple session in step 3a, token storage, revocation, rate limits, and why the same-origin write rule does not apply to bearer-token requests. Specify a separate Google enrollment Access application and audience that admits accounts absent from the website allowlist. The `calibration-auth.ts` allowlist check must not apply to `/d/*` or the enrollment callback; website and owner routes keep their existing authorization.
  2. A security review of that note before any code.
  3. `worker/src/device-auth.ts` and its routing: `/api/device/enroll` (behind Access), `/d/enroll`, `/d/*` for the plan, published data and the API, and an owner-only list and revoke route behind Access.
  3a. Implement the [Apple enrollment and revocation contract](ARCHITECTURE.md#sign-in-with-apple). Verify the incoming identity token and its session nonce. Atomically consume the unexpired, unused session, exchange the authorization code, and verify the returned subject. Before issuing device access, durably store the encrypted response and replace the retained credential on re-enrollment. Key the account on the verified Apple user identifier. Apply per-account quotas. Deletion uses the latest committed credential, with fresh authorization and manual revocation available for recovery. Keep per-device revocation in the owner's device list.
  4. Implement [artifact authorization](ARCHITECTURE.md#plan-artifact-authorization) for device and website reads. On both map hosts, implement uncached online browser revalidation and removal of deleted-profile views, snapshots, personal target state, and service worker entries. Implement the [deletion contract](ARCHITECTURE.md#profiles-sign-out-and-deletion), including both reconnect checks and the published artifact purge. Route both publisher scripts through the deletion check on artifact writes and the manifest flip. Before finalizing cleanup, use the retention decision from [owner step 7a](OWNER_STEPS.md#7a-log-retention-policy).
  5. Implement the [log cutover and acknowledgment contract](ARCHITECTURE.md#log-acknowledgment-and-recovery). Index retained legacy writes before enabling the new writer. Both the website and device log POST routes use the same month-independent reservation. Adopt the stored legacy payload, receipt time and monthly destination. Encode the profile and raw dedupe key separately for new monthly objects. Any retry completes or verifies the reserved write before returning `{ok:true}`.
  6. Supply a standalone enrollment smoke client and instructions for W-21. The client uses the system browser for Google enrollment, then reads the device manifest and writes a synthetic log entry through the device routes. It runs without the W-60 app and keeps credentials out of logs and artifacts.
- **Access tests.** A Google enrollment code expires at five minutes, works once and requires the matching verifier. Unknown and ordinarily revoked device tokens get a `401` with no detail. Authorized `/d/session` success matches the shape of `/api/browser/session`. A device cannot reach a human-only route. New Apple and Google accounts absent from the website allowlist enroll without approval and get only their own profile. Rate limits and per-account quotas hold. `/d/manifest.json` includes the account's own and legitimately shared artifacts and omits unrelated profile variants. Direct `/d/v/*` reads with known paths succeed for the shared grant and fail for the unrelated profile, including when the account has a manifest from before a grant was removed. The same grant checks apply to profile writes.
- **Log tests.** Seed legacy monthly records with stored receipt times. Retry in the same month, the next month and a non-adjacent month, including across `/api/log` and `/d/api/log`. Assert one write and the original destination and payload. Race both routes after cutover, interrupt before and after the monthly write, and check that success requires the reserved monthly object. Identical entries for two profiles are distinct. Identical keys for the same shared profile dedupe across accounts. Distinct profile and raw-key tuples that collide under the old prefix or sanitization produce separate monthly objects.
- **Deletion tests.** Enroll a new Apple account and delete it using only the retained refresh credential. Verify successful provider revocation and confirmed cleanup without a fresh code. Repeat after consent withdrawal and verified re-enrollment on the same account. Restart the Worker before deletion. Have the provider fixture return `200` for the superseded credential and verify the job instead revokes the new authorization. Inject a replacement storage failure and verify the Worker issues no device access. Race replacement with deletion acceptance and verify the winning account state determines the job credential. Exercise fresh authorization, expired codes, wrong-account proof, exchange and revocation failures, and the manual path. Lose the first deletion response and interrupt the Worker. Verify the receipt recovers the same job and the former token has access only to the deletion signal on `/d/session`.
- **Retained-account deletion check tests.** After sign-out, use the separate check credential without an account session. Verify it cannot read any account data or deletion receipt status, even while the account is live. After deletion acceptance it returns only `410 account_deleted`. A live or unknown verifier returns no deletion confirmation. A new account created by the same Apple or Google identity gets a different binding.
- **Log retention tests.** Seed the deleted profile with legacy and new-format monthly records, matching canonical dedupe payloads, and a reservation whose monthly write never completed. Check both stores and the monthly read path against the approved policy at deletion and, if the policy permits retention, across the published expiry. Verify that replay cannot recreate an expired or purged payload and unrelated profiles remain intact. W-71 checks the published policy against these cases.
- **Artifact deletion tests.** Seed current and retained personal artifacts and give a separate account an active grant. Keep the grantee enrolled with its old manifest. At acceptance, its refreshed manifest omits the deleted profile and both previously readable direct paths return `404`. Delay purge and verify the receipt stays pending until the published objects and serving cache copies are gone. Shared and unrelated artifacts remain readable.
- **Browser deletion tests.** Run the browser proof on both `map.astroanil.dev` and `map.expedition75.com`. As the grantee, prewarm the controlling service worker's personal-artifact cache and the saved personal Queue and Upcoming snapshot before deletion. Hold the manifest version fixed. Confirm that an open connected tab revalidates and loses the deleted profile, and that a tab returning to the foreground or reconnecting drops it as well. Verify a direct online request through the service worker cannot return the cached personal artifact. Inspect browser storage and verify that a reload, including after going offline again, cannot restore the profile. Keep an unrelated profile and shared data as controls.
- **Apple enrollment tests.** Reject a token with the wrong audience, issuer or signature, or an expired token. Even with a valid token, reject a missing or expired session, a missing or mismatched signed nonce, an invalid or consumed code, and a mismatched returned subject. Exchange or secure-storage failure issues no account or device access. Reject replay after a successful exchange. Concurrent submissions of the same valid proof issue exactly one device credential. An older session submitted after a successful re-enrollment cannot replace the new credential.
- **Done when:** the review signs off and the new tests and existing Worker suite pass. W-21 owns deployment.

### W-21 Deploy device access (S, owner approves)
- **Needs:** W-20.
- **Change.** Configure the `/d/*` Access bypass on both map hosts and the separate Google enrollment Access application with W-20's open-signup policy. Follow the runbook to pause log writes, index the retained legacy records, and enable both routes on the shared writer before resuming writes.
- **Deletion cutover.** Keep deletion disabled while deploying the Worker, browser client, and service worker on both map hosts. On each origin, start with a prewarmed tab on the old client and service worker. Verify that the new service worker moves that tab to the revalidating client when it takes control, with a reload if needed. Pause scheduled and manual artifact publishing. Drain in-flight uploads or cancel them and verify all writes have settled. Cut over both `scripts/deploy.sh` (rclone) and `scripts/deploy_wrangler.sh` (Wrangler), including daemon overrides and manual invocations. Disable the old direct R2 write access for the published artifact keys and the manifest. Enable deletion only after the publisher proof passes and W-71's policy is public. Rollback keeps the guarded path or pauses publication. Keep existing deletion markers, read denial, and cleanup active through rollback.
- **Publisher proof.** Run both actual scripts against disposable fixtures. For each path, start an upload and hold a write in flight while accepting deletion. Verify the deletion job stays pending until that write settles or is blocked and the purge passes. Run the same path with stale output prepared before deletion, then exercise rollback and replay it. Inspect current and retained objects and the manifest in R2 and read back through both serving hosts. The deleted profile must stay absent through rollback and replay, and unrelated artifacts must remain readable.
- **Done when.** The cutover and publisher proof pass. Use W-20's standalone smoke client against the deployed routes to enroll a disposable account. Confirm it reads the manifest and writes one synthetic log entry that appears once in its own test profile. W-60 later tests both sign-in choices in the integrated app.

### W-30 OPDKit: PlanStore and SyncEngine (M)
- **Change:** the two parts as described in ARCHITECTURE.md, with injected clock, file root and transport. Each installed plan belongs to the account whose grant-filtered manifest authorized the download.
- **Done when:** `swift test` is green on the Mac and on the workflow. The fault tests stop an install between every pair of steps. The account's `current` pointer always resolves to a complete verified plan. An older version never replaces a newer one for that account. A plan missing a required field leaves that account's previous plan current and records the reason for diagnostics. A late sync for a switched-away account cannot publish its plan to the active session.

### W-31 OPDKit: Outbox (S)
- **Needs:** W-30 for the package.
- Key each durable entry by its account, original selected profile, and dedupe key. Drain only the signed-in account's entries to their original selected profiles.
- **Done when:** an entry survives a process stop at any point after `enqueue` returns; a lost response plus a retry yields one server record in the fake transport; a rejected entry moves to a kept "rejected" folder and is counted in diagnostics; nothing is dropped for space. Test restart and profile switch with two same-key entries in different profiles of one account. Test account switch with two same-key entries in a shared profile under different authorized accounts. In each case, both entries survive and the fake transport acknowledges each entry once for its original account and profile. The switched-away account's entry stays pending until that account signs in again.

### W-32 Native transport and bridge (M)
- **Needs:** W-30, W-31, W-11, W-02. At risk until W-03 passes.
- **Change:** `OPDHost` implements `request` by route class from `routes.json`, the events, the snapshot read and the outbox calls.
- **Done when:** a simulator test loads the frontend on a fixture plan with the network off and Queue, Upcoming, Map and ISS view render. The bridge serves the active account's installed manifest and artifacts from its own plan only. A path missing from `routes.json` returns 404 and writes a diagnostics entry.

### W-33 Background refresh (S)
- **Needs:** W-32, W-50 (the alert roll-forward it runs).
- **Change:** use the [native storage protection contract](ARCHITECTURE.md#native-parts) for the device-bound Keychain token and the files the job needs.
- **Done when:** the handler runs sync, the outbox drain and the alert roll-forward inside 25 seconds against a fake clock and transport. Test that protected storage unavailable before first unlock defers the job, preserves local state, and leaves requests and alerts untouched. Verify task registration, resubmission, and the last three runs in diagnostics.
- **Controlled ground run at G3.** Build the candidate's exact source revision with development signing and the same production refresh handler and storage settings. Use a physical device paired to Xcode with Developer Mode enabled and enroll a disposable account. With the link blocked, seed an unsent log and stage a newer remote plan. After first unlock, pause in Xcode just after successful task submission. Lock the device, restore the link, use Apple's debugger trigger, and resume. Verify the handler reads the real Keychain credential, installs the plan through the protected files, drains the log once, and rolls alerts forward while locked. Test safe deferral before first unlock with the protected-storage-unavailable test above. Stage a second log and newer plan with the link blocked before reboot. Repeat the locked run after first unlock and verify the second log and plan complete. Record the revision and redacted results. [Apple's background task testing instructions](https://developer.apple.com/documentation/backgroundtasks/starting-and-terminating-tasks-during-development)
- **Distribution candidate at G3.** On the TestFlight candidate or matching W-74 export, verify live enrollment, background task registration and successful submission, and plan sync and once-only outbox drain after reboot and unlock. Record any system-scheduled refresh and its result in diagnostics. iOS controls callback timing. Verify the distribution build contains no private debugger hooks or references.
- **Second-device restore at G3.** On the distribution build, seed a disposable account, its installed plan, and an unsent log. Take an encrypted computer backup. Restore it onto the second physical ground device from [owner step 4](OWNER_STEPS.md#4-a-ground-tester). Make the matching distribution build available on the destination without deleting the restored app container. Confirm the seeded account files restored, the old Keychain credential is absent, and SNAP stays on the baseline until fresh enrollment. Verify the Worker issues a distinct device credential and record only the result, device models, and OS versions. [Apple's backup restore instructions](https://support.apple.com/en-us/118105)

### W-40 Baseline map pack (M)
- **Change.** `app/tiles/build.py` produces separate raster MBTiles files for Blue Marble and Black Marble 2016 at zoom 0 to 5. Bundle Natural Earth lines and labels in a separate GeoJSON asset with the resources required to render them offline. Include attribution in each raster database and in metadata for the Natural Earth asset. Record each source, licence or credit line, and retrieval date in `app/tiles/SOURCES.md`. Each release asset has a SHA-256 pinned in `app/tiles/pack.lock.json` and checked by the workflow.
- **Done when.** A pack-level test reads the distinct Blue Marble and Black Marble 2016 tiles at the same coordinate and verifies attribution metadata for both rasters and the Natural Earth asset. Report the pack's measured bytes and its contribution to the app download. W-70 records device-size estimates and channel-specific measurements when available. W-42 checks visible attribution offline. Record the single, throttled GIBS source fetch.
- **Traps:** no Esri tile goes in the pack. If a source's terms are unclear, leave it out and write it in `FOLLOWUPS.md`.

### W-41 Tile gateway (M)
- **Needs:** W-40, W-11.
- **Change:** follow the [XYZ and MBTiles lookup contract](ARCHITECTURE.md#tiles). Convert the row at the baseline database lookup.
- **Done when:** the lookup order is baseline, tile store, network; a unit test proves the network is not touched when local bytes exist. The tile store holds at most 512 MiB (536,870,912 bytes) of downloaded tile payloads across all layers, excluding the bundled baseline, plans and outbox. A fill-and-evict test exceeds the cap, removes expired tiles before least-recently-used tiles, verifies the byte total never exceeds the cap after a write, and keeps the baseline, plans and outbox intact. A tile larger than the cap is not stored. The iOS host skips Esri world-view and per-target prefetch by default, and viewed Esri tiles have no disk retention. Enable offline Esri use only under the permission recorded for the [exact sources and use](../designs/ios-app.md#esri-rights). After each new plan, permitted GIBS prefetch near the top three targets goes through `host.tileUrl`. Requested zooms 6, 8, and 10 yield GIBS source zooms 6, 8, and 9 (`frontend/src/tile-precache.ts:218`). Tests capture those requests, verify zero default Esri prefetch requests and disk writes, and confirm the browser's prefetch is unchanged.

### W-42 The map with no network (S)
- **Needs:** W-41.
- **Done when.** With the network off, an empty downloaded tile store, and Esri disabled, pixel probes confirm that Earth draws on Map at world view and at zoom 3, 5, and 7 with clouds on and off. Both baseline rasters are independently selectable and ISS view draws offline. The labels toggle shows Natural Earth labels. Required attribution for both rasters and Natural Earth is visible offline. The website's style contract tests are unchanged for the `browser` host.
- **Tile geography proof.** Request XYZ tile `3/1/2` for each baseline raster through the real offline gateway. Compare the returned bytes to the expected digest recorded independently from the source imagery before MBTiles packing. Verify the mirror tile `3/1/5` has different bytes so an inverted lookup fails the proof.

### W-50 Alerts (M)
- **Needs:** W-32, W-12.
- **Change:** the alert plan builder on the web side; `AlertPlanner` in `OPDKit`; the notification adapter in `OPDHost`; settings for lead time, targets and a sleep window; the "Alerts set through ..." line; the two reserved slots. On the `ios` host the Remind button sets an alert instead of exporting a calendar file.
- **Done when:** the planner never exceeds the limit. It removes alerts that left the plan and reports the last scheduled alert as the coverage end. The sleep window holds across midnight UTC. A simulator test sees the pending requests after a plan is set. Scope native notification IDs by account and profile. Use synthetic sign-out, account switch, deletion, and grant removal events to verify that the adapter clears matching pending and delivered notifications and preserves unrelated scopes. Background roll-forward cannot restore removed alerts. The UI shows when notification permission is denied.

### W-60 Enrollment and identity (M)
- **Needs:** W-21, W-32, W-12 (device-computed passes), W-41 (baseline tile gateway), W-50 (scoped pending and delivered notification cleanup).
- **Done when:** a first launch shows the curated targets, device-computed passes and map with no sign-in. Both sign-in choices enroll and show the profile name. Relaunch restores the same account. Sign-out restores the baseline, hides the outgoing account's plan and mirrored cache, and keeps its unsent entries scoped to that account. An ordinary `401` shows a banner and preserves the installed plan.
- **Deletion proof.** Confirm deletion once and return to the baseline after acceptance. Delete a newly enrolled Apple account using its retained credential without opening the native sheet. Exercise fresh authorization and manual revocation through the UI. Use the [deletion receipt](ARCHITECTURE.md#apple-deletion-receipt) to show the expected 24-hour timeframe, pending or manual-action state, and confirmed completion. Test delayed completion after relaunch and after loss of the first response. The app retrieves the same job without the old device credential and shows completion after the Worker confirms it.
- **Consent withdrawal proof.** Withdraw Sign in with Apple consent with unsent logs, a pending alert, and a delivered alert on the device. Verify the account signs out, both alerts clear, the baseline appears, and no SNAP deletion job exists. Relaunch and run the online deletion check. Verify the outbox survives and the same Apple account can re-enroll and upload its original pending log once. Then delete the re-enrolled account without opening a new Apple sheet and verify the replacement Apple authorization is revoked.
- **Reconnect proof.** Enroll a second device on the same test account, seed its local plan, mirrors, outbox, and pending and delivered alerts, then take it offline before deletion. On reconnect, verify the SNAP deletion signal clears those files, web state, credentials, and both notification lists before any drain or roll-forward. The baseline replaces the deleted active account. Repeat with the Apple credential-revocation notification arriving first. It signs out and clears alerts, and the outbox survives until the separate SNAP check confirms deletion. Repeat after signing out or switching to a different account before deletion. With the old device token absent, verify that the deletion-only check purges the old account without signing it back in. Preserve the other account's files, views, logs, and alerts. Verify a separate still-enrolled grantee loses the deleted profile's installed artifacts, views, and alerts on session refresh without a plan version change. Its own plan and alerts remain available.

### W-61 Lifecycle and recovery (S)
- **Done when:** web process termination reloads to the same tab; a lost WebGL context rebuilds the map; a memory warning reaches the web side; links to other sites open in Safari; the layouts hold at iPhone 17 Pro and iPad Pro 11-inch sizes (the orbit devices) in both orientations and at iPad split-view widths; the keep-awake setting works.

### W-62 Diagnostics and build lifetime (S)
- **Done when:** diagnostics show the build, plan version and age, orbit data age, storage in use, alert coverage, outbox and rejected counts, last sync results and token state. "Export" produces a text file with no token or personal target coordinates.
- **Expiry checks:** once the installed channel is confirmed, TestFlight uses the matching build's confirmed deadline from App Store Connect and ad hoc uses its signed provisioning profile expiry. Both ground channels show the date, a banner at 30 days and a local alert at 10 days. An App Store install shows "App Store build, no expiry" and clears any prior expiry alert. A missing or unverifiable [receipt](https://developer.apple.com/documentation/foundation/bundle/appstorereceipturl) cannot delay offline launch. If the channel cannot be confirmed, show that state and suppress stale expiry warnings. Test TestFlight, ad hoc, App Store, and offline first launch and replacement with no receipt.

### W-63 Old builds keep working (S)
- **Needs:** W-30, W-10, and the W-20 Worker contract.
- **Change:** seed a synthetic older build contract with artifact fields and `/d/*` responses. Model a superseded, unenrolled build that has never reported its build number. Tests in `tests/` and `worker/test/` check current generator output and Worker responses against it. W-70 captures the actual contract of each candidate. The first distributed App Store build is the compatibility floor throughout release 1. Keep fixtures for every distributed App Store build from that floor, including superseded builds with no build report. Keep ground build fixtures until expiry or verified replacement.
- **Done when:** remove a required field from the generator output and then from a Worker response in separate negative tests. Each CI check fails and names the synthetic build and missing field. Verify that SyncEngine returns the update-needed result for an unreadable plan.

### W-70 Signed release candidate and ground delivery (M)
- **Needs:** W-03 (the release job), W-63 (the contract checks), G2.
- **Change:** run the W-03 workflow on a clean hosted runner, from `main` and the `ios-release` environment with the owner as required reviewer. Xcode uses automatic provisioning and an Apple Distribution certificate to sign the export. The API key authenticates Xcode via `APP_STORE_CONNECT_KEY_ID` (key ID string), `APP_STORE_CONNECT_ISSUER_ID` (issuer ID UUID) and `APP_STORE_CONNECT_PRIVATE_KEY` (full `.p8` contents). Assign build numbers from the workflow run. Upload the signed candidate to App Store Connect for App Store submission. If ground delivery uses TestFlight, make the same candidate available to the internal group using an upload eligible for App Review. Record the build's [TestFlight expiration date](https://developer.apple.com/documentation/appstoreconnectapi/build/attributes-data.dictionary) and make it available to W-62 as build metadata. While TestFlight ground testing continues, cut a refresh build when the newest one is 45 days old. W-74 provides the matching ground export if TestFlight delivery is unavailable.
- **Done when:** a clean workflow run archives, signs and uploads the candidate, and App Store Connect finishes processing it for submission. On the TestFlight path, verify the matching build is available to the internal tester. On the W-74 path, verify the matching export installs on the registered ground device. Before submission, capture the candidate's actual required artifact fields and `/d/*` responses as W-63 fixtures keyed by version and build. Keep all secret values out of logs and artifacts.
- **First listing.** Hand off the processed candidate to W-71 for initial listing setup after G3. Mark the App Store update-size measurement inapplicable because there is no App Store predecessor. G6 still proves state migration from the ground channel.
- **Later versions.** Upload the candidate to the existing app record and use its approved distribution method. Measure the App Store update once the new version is available, using an installed, released App Store predecessor.
- **Size report.** Before approval, record the estimated download and install sizes for the iPhone and iPad variants from App Store Connect's App File Sizes, alongside W-40's measured baseline size. For each measured update, record the delivered bytes, device variant, channel, and predecessor and candidate version and build. For a ground-channel measurement, install the predecessor on that channel. [App Store Connect file sizes](https://developer.apple.com/help/app-store-connect/manage-builds/view-builds-and-metadata/#view-the-file-sizes-of-a-build)

### W-71 App Store submission, the route to orbit (M)
- **Needs to submit:** authenticated G2 acceptance from W-72 and a G3 pass for the submission candidate from W-70. Preparation can start in Wave 1.
- **Change:** prepare review notes and materials for the W-72 demo, privacy manifest, export-compliance configuration, listing text and privacy answers. Prepare the unlisted distribution request for the first listing. Later releases use the distribution method already approved for the app record.
- **Privacy policy.** In Wave 1, get the recorded retention decision from [owner step 7a](OWNER_STEPS.md#7a-log-retention-policy) before publishing. Publish one public policy URL and supply it to W-72 for a **Privacy Policy** link in signed-out and signed-in Settings. Set the same URL in the App Store Connect Privacy Policy field. The policy states what data is collected, how and why it is used, how shared data is protected, what is retained and for how long, and how to withdraw consent or request deletion. Before submission, run W-20's log retention tests against the published policy and verify cleanup matches it for monthly records and canonical dedupe payloads. Verify on a clean signed-out candidate with network access that the Settings link opens the readable policy without sign-in. Confirm the listing metadata has the same URL. [App Review guideline 5.1.1(i)](https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage)
- **NASA approval packet.** Prepare a five-minute packet in Wave 1. Cover what the app does, what it stores, the one permission it asks for, and the absence of tracking and third-party analytics. Inventory every app outbound origin. Include frontend same-origin requests in `routes.json`, tile upstreams in `tile-layers.json`, direct orbit-data requests including CelesTrak, native Apple sign-in, Google sign-in through Cloudflare Access, and the privacy-policy URL. List Worker-to-provider traffic separately.
- **Done when:** the owner has a submission folder with the candidate's G2 and G3 evidence, review notes and listing materials. A request inventory check covers frontend and native traffic, including sign-in redirects. In the signed-out demo fixture, cold-launch with the network off, draw the map and ISS view, show device-computed passes, and deliver a local alert from the fixture at a predictable offset after granting permission. The review notes cover the app's offline capabilities and give reviewers access to account features through an isolated demo account with synthetic data. Verify enrollment, stored plans, shot logging and deletion with the reviewer setup from a clean device. Use a disposable account for the deletion check and confirm the reviewer account remains usable. Give access details privately through App Store Connect. If a demo account cannot be provided, get Apple's prior approval for a fully featured demo per [guideline 2.1(a)](https://developer.apple.com/app-store/review/guidelines/#app-completeness).
- **Traps:** include the offline checks for guideline 4.2. Guideline 4.8 requires Sign in with Apple beside Google, and guideline 5.1.1(v) requires account deletion in the app. These come from W-20 and W-60. Enable the Sign in with Apple capability on the app identifier. [Owner step 8](OWNER_STEPS.md#8-app-store-listing-and-releases) covers the first listing and later releases. Request G7 only after both G3 and G6 pass.

### W-72 Acceptance scripts (S)
- **Needs:** W-12, W-32, W-33, W-42, W-50, W-60, W-61 and W-62.
- **Change:** add the signed-out App Review demo on a bundled synthetic fixture, the privacy manifest, export-compliance configuration, and Settings link to the public policy URL supplied by W-71's Wave 1 preparation. Include them in the candidate before running G2.
- **Done when:** the workflow passes authenticated G2 using [the same simulator matrix as W-02](#testing-without-the-ipad-in-orbit). Record the destinations, actual runtime versions and gaps. Use an enrolled synthetic account and a test transport. Exercise the actual Keychain and on-disk state without live provider credentials in CI. Install a predecessor feature build with the same app identity that supports enrollment, plan, outbox, tiles and settings. Create that state, including unsent logs, then install the candidate over the predecessor without uninstalling. Verify the credential, plan, outbox, kept tiles and settings survive and queued entries upload once. Use a seeded predecessor feature build for the first release. G3 exercises live sign-in and sync on the ground device.
- **Compatibility proof.** Serve an unreadable plan. Verify the app keeps the last usable plan and pending logs and shows the update message.
- **Account isolation.** Use two enrolled fixture accounts with a shared profile and one private profile for the first account. Confirm a private alert is already in Notification Center and another is pending. Take the device offline and sign out to the baseline, then activate the second account in the fixture. Its installed plan and mirrored caches must be the only account state available. Verify the private alert is gone from Notification Center, the pending alert is canceled, and late sync or scheduling cannot restore either. Verify the second account can schedule its own alert for the shared profile.
- **Ground proof:** `docs/ios/ACCEPTANCE.md` repeats the update test and includes W-33's same-revision development run, distribution candidate checks, and second-device restore procedure. For G3, record each build's source revision, version, build, signing and delivery channel, and each ground device's model and OS version. Use the G3 fallback matrix when needed. For G6, record the TestFlight or W-74 build actually installed on that device and seed unsent logs on it before installing from the live App Store listing. If the store does not offer replacement over the same version, prepare an earlier feature build on the same ground channel and device, and seed the full test state there. The G6 in-place installation must preserve the app container. Repeat the state and expiry checks.
- **Orbit checklist:** include each expected result and a place to record the outcome. Use a window with a qualifying pass in the next 90 minutes to check Queue. Check Upcoming for qualifying later passes through the seven-day horizon. W-12's offline fixture proves day-seven coverage even on days with no qualifying pass that late.

### W-73 Crew rollout (S)
- **Needs:** G5.
- **Done when:** crewmates have the App Store link and NASA's approval for their devices; a one-page enrollment guide for crew exists; the device list and the revoke steps are in the runbook.

### W-74 Ground delivery without TestFlight (M, when TestFlight is unavailable to the ground tester)
- **Needs:** G0, the W-02 fixture build and an Apple-registered ground device (owner step 4).
- **Change:** export an Apple Distribution-signed ad hoc build provisioned for the registered ground device. Use the same app identifier, stable Keychain access groups and state layout as the App Store build. For the submission candidate, export from the same archive with the same source revision, version and build number. Keep the HTTPS install page behind the map's existing sign-in. Give the iOS installer temporary HTTPS access to the manifest and signed package without depending on Safari's Access cookie. Record how the owner registers the device through Apple.
- **Done when:** a clean hosted workflow produces the signed W-02 fixture export after owner approval. The registered device downloads both installer resources, installs the fixture, launches and relaunches offline, and shows the fixture baseline and map. Install a newer signed W-02 fixture over the first with the same app identity and verify the stored tab survives. Record the installed build and expiry from the ad hoc provisioning profile.
- **Gate proof.** This ground route is available before W-03 and needs no TestFlight group. Use it for the same ten host checks at W-03 and the authenticated ground checklist at G3. Verify W-62's expiry behavior on the ground feature build. At G6 install from the live App Store listing over the installed ad hoc build on that same device. NASA installs only the App Store release in orbit at G7.
- **Traps:** keep certificates, profiles, private keys and device identifiers out of the repository and logs.

### Later, not scheduled

W-80 Lock Screen countdown and a widget. W-81 Shoot and Skip buttons on the alert. W-82 Swift orbit math, if W-80 or long closed-app alert coverage needs it, with the same reference vectors as W-12. W-83 a native Queue screen. W-84 a native map, once MapLibre Native's globe view is in a stable release and proven on the ISS view's camera. W-85 device-to-device plan sharing. W-86 a longer plan from the generator, if the device extension proves too thin. W-87 batch photo labelling.

## Where each second-opinion finding went

| Finding | Severity | Handled in |
| --- | --- | --- |
| F1 custom scheme is a compatibility gate | High | W-02 items 1, 2, 6 |
| F2 web view keeps WebGL and memory failure modes | High | W-02 items 9, 10; W-61 |
| F3 browser storage carries operational state | High | Storage tiers; W-30, W-31, W-11; the update step in G2, G3 and W-72 |
| F4 the auth change was incomplete | Critical | W-20, W-21, W-60 |
| F5 bundled tiles need a rights decision | High | W-40; [the Esri rights question](../designs/ios-app.md#esri-rights) |
| F6 a whole-Earth pack needs a set resolution | High | W-40 (zoom 0 to 5), W-41, W-42 |
| F7 published artifacts cannot hold a queue for days | High | W-12 |
| F8 a moving dot can be wrong | High | Orbit data age in W-62 and in the readout; alert text carries the age; W-12's accuracy check sets when passes are marked approximate |
| F9 background refresh cannot keep alerts topped up | High | W-50, W-33; corrected premise 2(c) |
| F10 the web outbox drops old entries | High | W-31 |
| F11 one repository, two drifting products | Medium | W-10 boundary tests, `routes.json`, W-12 reference vectors, W-63 contract fixtures |
| F12 shipping automation first | High | W-01 before features; W-70 |
| F13 the 90-day build lifetime | Critical | W-62, W-70 refresh job, W-71, gate G6 |
| F14 remote diagnosis | Medium | W-62 |

## Risks the organizer watches

| Risk | Sign | Response |
| --- | --- | --- |
| The host proof fails | A W-02 check is red on both hosts | Stop. Tell the owner. The fallback is website hardening. |
| Accounts take long | G0 not done a week after Wave 0 starts | Keep building unsigned. Raise it in every status. |
| The website moves under the seam | A new same-origin request or storage key | The boundary tests catch requests. The storage mirror covers keys. |
| A ground build nears expiry | `STATUS.md` shows under 30 days for TestFlight or ad hoc | Cut a replacement on that channel and ask the ground tester to install it over the current build. |
| Device memory on older iPads | Web process terminations at G3 | Lower the raster cache and the concurrent renderers; record the device floor. |
| NASA approval is slow or refused | G7 still open when G6 passes | Ask what NASA needs; keep the packet current. The website stays the tool meanwhile. |
| App Review rejects the app | W-71 rejected under guideline 4.2 or for sign-in | Fix the named reason; make demo mode show more offline value. |
| No app reaches the orbit devices | NASA declines, or App Review never passes | Stop. Tell the owner. The fallback is website hardening. |
| Downloads or tile storage grow | W-40 pack size, W-70 size report and W-41 cap tests | Report measured baseline bytes, preapproval device-size estimates, and available channel-specific update measurements. The zoom 0 to 5 baseline estimate is about 68 MB. Schedule large downloads overnight. Downloaded tiles have a separate 512 MiB cap. |
| The live service is disturbed | Any change under `generator/` or in the main checkout | Reject the pull request. |

## Status

The organizer keeps `docs/ios/STATUS.md` current: what shipped, what is in flight, what waits on the owner, the gate reached, and the days until a TestFlight or ad hoc ground build expires. Plain language, short enough to read on a phone.
