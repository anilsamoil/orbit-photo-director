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
3. The website does not change. `bun run typecheck`, `bun run test` and `node scripts/verify-map-pins.mjs` stay green, and every rule in `AGENTS.md` still holds.
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
| G0 Accounts | Owner | The developer membership is active (done 2026-11-16), the app record exists, the API key is in the `ios-release` environment, the ground tester is an internal tester in App Store Connect | Unsigned work continues. Nothing ships. |
| G1 Host proof | W-02 on a simulator, then W-03 on a ground device | Every check in W-02 passes on a simulator, then on a signed build on a ground device; the host choice is recorded. W-11, W-32 and W-41 may start after the simulator half, at risk. | Try the other host. If neither can draw Map and ISS view from a local origin, stop and tell the owner: the fallback is hardening the website. |
| G2 Offline acceptance | W-72, on the hosted workflow | Cold-launch offline; Earth draws; the ISS prediction moves; a target remains usable; an alert appears while locked; a recorded shot survives restart and uploads once. Then a new build installed over the previous one keeps the credential, the plan, the outbox, the kept tiles and the settings, and the queued entries upload once. | Fix before any signed release build |
| G3 Ground device | Ground tester, checklist from W-72 | The same lines, from a TestFlight install, on a real device on Earth matching the orbit iPad first: iOS or iPadOS 26 and, if possible, an iPad. The iPhone is covered by the iOS 26 simulator, plus an iPhone on iOS 26 if the tester has one. With no matching device, the closest one plus the exact simulator runtime stand in, and the gap goes into `STATUS.md`. | Fix before the build goes to orbit |
| G7 Device approval | Owner, with W-71's approval packet, once the app is in the App Store | NASA approves SNAP and installs it on the iPad and the iPhone in orbit | The website remains the tool. Answer what the device managers ask. |
| G4 Orbit | Owner, ten-minute checklist from W-72 | Needs G6 and G7. Install from the unlisted App Store link (or the device managers' push), enroll, one LOS period, one alert, one logged shot | The website remains the tool. Fix and resend. |
| G5 Crew | Owner | Fourteen days of the owner's use with no lockout and no lost log | Hold the crew rollout |
| G6 No-expiry route | W-71, then the ground tester | The unlisted App Store listing is approved; the ground tester installs the App Store build over the TestFlight build, state carries over, and no expiry date shows | Fix the named reason and resubmit. Apple declining unlisted distribution: use a public listing. |

### Testing without the iPad in orbit

On 2026-11-16 the App Store on the iPad in orbit refused TestFlight, while other App Store apps installed. Testing does not depend on that iPad:

- **Every day: simulators.** The hosted workflow runs the app in the iOS Simulator on GitHub's Macs from W-01 on, with no Apple account. G2 runs there. Once Xcode is on the Mac on Earth (owner step 5), Claude and Codex can also drive the simulator from their own sessions and take screenshots.
- **Before orbit: one real device on Earth.** G3 needs a person on the ground with an iPhone or iPad (owner step 4). A simulator cannot show real memory limits, real background refresh or real alert delivery.
- **Orbit: a route that works on that iPad.** The App Store works there, so the unlisted App Store listing (W-71) is the route. W-74 prepares a fallback that needs neither TestFlight nor the App Store.

### Delivery routes to the iPad in orbit, in order of preference

The orbit devices (an 11-inch iPad Pro with M4 on iPadOS 26.6.2 and an iPhone 17 Pro on iOS 26.6.1) are managed: every app needs approval from the agency's device management (gate G7). The owner is seeking that approval.

1. The unlisted App Store listing (W-71). Once the app is in the App Store, the owner asks NASA to approve it and install it on the devices. Builds do not expire. Each build goes through App Review, which takes days, so orbit fixes are slower than with TestFlight.
2. A custom app sent to the agency's Apple Business Manager, if the device managers prefer to install the app and its updates through their own device management. Also goes through App Review.
3. TestFlight: the device managers will not approve it. Ground tester only.
4. Ad hoc install over the air (W-74). Also needs the device managers' approval, so it is a last resort. The iPad's device identifier is registered in the developer account, the build is signed for the registered devices, and the iPad installs it by tapping a link in Safari. It needs neither TestFlight nor the App Store. The signing lasts up to a year, so it also avoids the 90-day lapse. It does not work if device management on that iPad forbids installing apps.
5. If no app can be installed on that iPad: the plan's fallback, hardening the website.

Download size is not a constraint: the owner downloads large apps overnight. Updates should still stay small, because each one is a download over the station link.

## Order of work

Wave 0 needs no Apple account and starts now. The packages inside a wave can run in parallel unless "Needs" says otherwise.

```
Wave 0   W-00 ─┬─ W-01 ── W-02 (G1)
               ├─ W-10
               ├─ W-20 (design note, review, code; no deploy)
               ├─ W-30 ── W-31
               └─ W-40
G0       W-03 (needs W-02, G0): signed host proof on a ground device, second half of G1
Wave 1   W-11 (needs W-10, W-02)   W-12 (needs W-10)   W-32 (needs W-30, W-31, W-02)   W-41 (needs W-40, W-11)
         W-21 (needs W-20, owner)   W-60 (needs W-21, W-32)   W-63 (needs W-30, W-10)
Wave 2   W-33   W-42   W-50   W-61   W-62          then W-72 (G2)
Wave 3   W-70 (needs G0, G2)   G3   W-71 (needs G2, submits in parallel with G3)   G6   G7 (owner, after G6)   G4   W-74 (needs G0, W-01)   W-73 (G5)
Later    W-80 and up, each with a measured reason
```

Target, not a promise: G2 about two weeks after Wave 0 starts. The first build in orbit follows App Review approval of W-71, typically a few days after submission, longer if the review asks for changes.

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
  5. ISS view draws with `projection: 'vertical-perspective'`: the same probe.
  6. A request with a body crosses the bridge intact, byte for byte, for GET, POST, PUT and DELETE.
  7. The tile route delivers at least 50 tiles a second.
  8. `localStorage` survives quitting and relaunching.
  9. After the web process is terminated, the shell reloads and the same tab is showing.
  10. A ten-minute scripted pan and zoom on Map and on ISS view finishes without a web process termination; peak memory is recorded.
- **Done when:** `docs/ios/G1-HOST-PROOF.md` lists each check with its result and the evidence, and `DECISIONS.md` records the host: the default, or a custom `WKWebView` host with its own scheme handler if a check fails under the default and passes under the custom host.
- **Traps:** a simulator proves items 1 to 9. Item 10 is only indicative on a simulator; W-03 repeats all ten on a real device. The iPad in orbit runs iPadOS 26.6.2: set the deployment target to 26.0 and run the checks on an iPadOS 26 simulator runtime as well as the newest one. A custom scheme handler may not receive request bodies; that is why item 6 exists.

### W-03 Signed host proof on a ground device (S)
- **Needs:** W-02, G0.
- **Change:** the release job's first use. Sign the W-02 proof build with the App Store Connect API key from the `ios-release` environment secrets `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID` and `APP_STORE_CONNECT_PRIVATE_KEY`, upload it to TestFlight, and have the ground tester install it and run the ten checks.
- **Done when:** the build reached TestFlight from a workflow run with only the owner's approval; the ground tester's results for all ten checks are in `G1-HOST-PROOF.md`, with the device model and OS version. This also proves signing, upload and install before any feature depends on them.

### W-10 Web host seam, browser side (M)
- **Change:** add `frontend/src/host/` with the interface in ARCHITECTURE.md and `browser.ts`. Move every same-origin `fetch` to `host.request` (21 non-test files call `fetch`; classify each call as same-origin or other-origin first). Move the snapshot and the calibration queue storage behind `host.snapshot` and `host.outbox`. Add `routes.json` and `tile-layers.json`, and build the map sources and the prefetch URLs in `frontend/src/tile-precache.ts` through `host.tileUrl`.
- **Tests first:** a contract test that records every same-origin request (URL, method, headers, cache mode, body) for manifest, artifacts, log post and read, session, target routes, kp, aurora, wx, cloud, launch pointer and catalog, hazards, lightning and the probe. It is green on the old code and committed before anything moves. This is the rule in `AGENTS.md` for moving a capability.
- **Done when:** that contract test is still green; the new boundary tests fail on a planted violation (bare same-origin `fetch`, unclassified path, tile template outside the catalogue, `host.kind` read outside the seam); the three frontend checks are green; `drive all` in verify-opd is green.
- **Traps:** `main.ts` and `map/index.ts` are outside coverage, so the contract test is their only guard. `src/map/` allows no comments and no module-level `let`.

### W-11 Web host seam, iOS side (M)
- **Needs:** W-10, W-02. At risk until W-03 passes.
- **Change:** `ios.ts` over the bridge. A Vite mode `ios` that builds to `frontend/dist-ios` with no service worker, no PWA manifest and no `registerSW.js`. The tier 2 storage mirror. The `/api/app` recovery link and the install hints are hidden when `identity.v1` is present.
- **Done when:** unit tests drive `ios.ts` against a fake bridge for every route class; the `ios` build runs in the W-01 app on the fixture plan; switching profile from the profile menu reloads the shell inside the app; the browser build's behaviour is unchanged (W-10's contract test).

### W-12 Extended queue on the device (M)
- **Needs:** W-10.
- **Change:** `frontend/src/plan-extend/`, a pure module that runs in a Web Worker: passes for the published and personal targets from now to seven days out, with geometry, lighting regime and the three non-cloud score factors. Signed out, it uses the curated targets built into the app and the ISS element set from CelesTrak, or the one built into the app. It propagates the orbit once into a shared ephemeris and tests every target against it; the dropped-pin finder propagates per pin and is too slow for this. A published scored pass replaces the device pass for the same target and time. Entries carry `provenance: 'device'`; Queue and Upcoming show them merged by time with published passes, tagged "geometry only", with no cloud number. A device pass from orbit data more than 48 hours old is marked approximate. A script writes reference vectors from the Python pass finder for a fixed orbit and target set; use the generator's 800 km distance limit (`generator/config.py:56`), not the pin finder's 1,500 km.
- **Accuracy check:** predict passes from an element set seven days old and compare them with passes from the newest set, over a period that includes a reboost. Record the closest-approach timing error against a limit of 60 seconds, and set the "approximate" threshold from the result.
- **Done when:** the TypeScript results match the reference vectors inside the generator's sampling step; the accuracy check is recorded in `DECISIONS.md` with its threshold; computation time is measured on the closest ground device to the orbit iPad and the bar is set from that measurement, using a coarser time step with refinement near each closest approach if the ephemeris alone is too slow; a pass is marked approximate when its closest-approach time minus the epoch of the orbit data used exceeds the threshold, and the mark is recomputed when newer orbit data is installed; the feature is on for the `ios` host and off for the `browser` host behind one flag; with the flag off the website renders exactly as before; between 90 minutes and seven days after the last sync, Queue is not empty while any target has a pass in the next 90 minutes.
- **Traps:** pass times start from the wall clock, not the scrubbed map time. Do not import from `src/map/`.

### W-20 Device access in the Worker (L, security-sensitive)
- **Change, in three steps, each reviewed:**
  1. `docs/ios/DEVICE-ACCESS.md`: both sign-in choices (Sign in with Apple and Google through Access), open account creation for any Apple ID or Google account, per-account quotas, sign-out, account deletion, the threat model, the enrollment sequence, token storage, revocation, rate limits, and why the same-origin write rule does not apply to bearer-token requests. Compare it with the service-token fallback in ARCHITECTURE.md and pick one.
  2. A security review of that note before any code.
  3. `worker/src/device-auth.ts` and its routing: `/api/device/enroll` (behind Access), `/d/enroll`, `/d/*` for the plan, published data and the API, and an owner-only list and revoke route behind Access.
  3a. `/d/enroll/apple`: verify the Apple identity token (signature against Apple's published keys, issuer, audience equal to the bundle ID, expiry), key the account on the Apple user identifier, create a new account at once; per-account quotas on targets and log entries. `/d/account/delete` for the signed-in account. Revocation in the owner's device list.
  4. Log dedupe that does not depend on the month the request arrives. Today the object key is `log/<arrival yyyymm>/<dedupe key>` (`worker/src/index.ts:285-291`), so a retry after a month change writes a second record. Keep the arrival-month keys, so every existing reader of `log/` still finds new entries, and check the previous month's key before writing. Existing records stay readable.
- **Tests, in the style of `worker/test/access-gate.test.ts`:** a code is single use; a code expires at five minutes; a wrong verifier fails; an unknown or revoked token is 401 with no detail; a token cannot read or write a profile its account is not granted; `/d/session` returns the same shape as `/api/browser/session`; `/d/*` cannot reach a human-only route; the daily rate limit holds; an Apple token with the wrong audience, issuer or signature, or expired, is refused; a new Apple or Google account gets its own profile at once and reaches no other; an account over its quota is refused with a clear error; account deletion removes the profile's targets and tokens and the deleted token is refused afterwards; a log entry first stored on the last day of a month and retried on the first day of the next is stored once; the existing Worker suite stays green.
- **Done when:** the review signs off and the tests are green. Nothing is deployed in this package.

### W-21 Deploy device access (S, owner approves)
- **Needs:** W-20.
- **Change:** an Access bypass application for `/d/*` on both map hosts; the Worker deploy by the runbook.
- **Done when:** a test device enrolled under a profile made for testing reads the manifest and writes one log entry that appears once. No rating is fabricated in a real profile.

### W-30 OPDKit: PlanStore and SyncEngine (M)
- **Change:** the two parts as described in ARCHITECTURE.md, with injected clock, file root and transport.
- **Done when:** `swift test` is green on the Mac and on the workflow; the fault tests stop an install between every pair of steps and `current` always resolves to a complete verified plan; an older version never replaces a newer one; a plan missing a field this build requires is not installed, the previous plan stays current, and the reason is recorded for diagnostics.

### W-31 OPDKit: Outbox (S)
- **Needs:** W-30 for the package.
- **Done when:** an entry survives a process stop at any point after `enqueue` returns; a lost response plus a retry yields one server record in the fake transport; a rejected entry moves to a kept "rejected" folder and is counted in diagnostics; nothing is dropped for space.

### W-32 Native transport and bridge (M)
- **Needs:** W-30, W-31, W-02. At risk until W-03 passes.
- **Change:** `OPDHost` implements `request` by route class from `routes.json`, the events, the snapshot read and the outbox calls.
- **Done when:** a simulator test loads the frontend on a fixture plan with the network off and Queue, Upcoming, Map and ISS view render; a path missing from `routes.json` returns 404 and writes a diagnostics entry.

### W-33 Background refresh (S)
- **Needs:** W-32.
- **Done when:** the handler runs sync, the outbox drain and the alert roll-forward inside 25 seconds against a fake clock and transport; the task is registered and resubmitted; diagnostics shows the last three runs. The system decides how often it runs; no test claims a frequency.

### W-40 Baseline map pack (M)
- **Change:** `app/tiles/build.py` produces one MBTiles file: Blue Marble and Black Marble 2016 at zoom 0 to 5, and Natural Earth lines and labels. `app/tiles/SOURCES.md` records each source, its licence or credit line, and the retrieval date. The pack is a release asset; `app/tiles/pack.lock.json` pins its SHA-256 and the workflow verifies it.
- **Done when:** the pack's size is reported and the app download stays inside the size budget; every source's credit shows in the app with no network; the fetch from GIBS was throttled and done once.
- **Traps:** no Esri tile goes in the pack. If a source's terms are unclear, leave it out and write it in `FOLLOWUPS.md`.

### W-41 Tile gateway (M)
- **Needs:** W-40, W-11.
- **Done when:** the lookup order is baseline, tile store, network; a unit test proves the network is not touched when local bytes exist; the baseline is never evicted; the size budget holds under a fill test; the app fetches exactly the tiles the website prefetches today (world view of the switchable layers once a session, dark grey and GIBS at zoom 6, 8 and 10 near the top three targets after each new plan) and the gateway stores them under each layer's policy.

### W-42 The map with no network (S)
- **Needs:** W-41.
- **Done when:** with the network off, pixel probes find Earth, not black, on Map at world view and at zoom 3, 5 and 7, with clouds on and off, and on ISS view; the labels toggle shows Natural Earth labels; the website's style contract tests are unchanged for the `browser` host.

### W-50 Alerts (M)
- **Needs:** W-32, W-12.
- **Change:** the alert plan builder on the web side; `AlertPlanner` in `OPDKit`; the notification adapter in `OPDHost`; settings for lead time, targets and a sleep window; the "Alerts set through ..." line; the two reserved slots. On the `ios` host the Remind button sets an alert instead of exporting a calendar file.
- **Done when:** the planner never schedules more than the limit; alerts that left the plan are removed; the coverage end equals the last scheduled alert; the sleep window holds across midnight UTC; a simulator test sees the pending requests after a plan is set; permission denied is shown as a state, not an error.

### W-60 Enrollment and identity (M)
- **Needs:** W-21, W-32.
- **Done when:** a first launch opens on the baseline with no sign-in: curated targets, device-computed passes from the built-in or CelesTrak element set, the map; a Sign in button offers Sign in with Apple and Google; either completes enrollment and the profile name shows; relaunch needs no sign-in; sign out returns to the baseline and keeps that account's unsent entries; "Delete account" asks once, deletes server-side and returns to the baseline; a rejected token shows a banner and reading continues.

### W-61 Lifecycle and recovery (S)
- **Done when:** web process termination reloads to the same tab; a lost WebGL context rebuilds the map; a memory warning reaches the web side; links to other sites open in Safari; the layouts hold at iPhone 17 Pro and iPad Pro 11-inch sizes (the orbit devices) in both orientations and at iPad split-view widths; the keep-awake setting works.

### W-62 Diagnostics and build lifetime (S)
- **Done when:** one page shows the build and its expiry date, the plan version and age, the orbit data age, storage in use, alert coverage, outbox and rejected counts, the last sync results and the token state; "Export" produces a text file with no token and no personal target coordinates; the expiry banner appears 30 days out.

### W-63 Old builds keep working (S)
- **Needs:** W-30, W-10.
- **Change:** each release stores its contract fixtures: the artifact fields and `/d/*` responses that build requires. A test under `tests/` (not `generator/`) and one in `worker/test/` check current generator output and Worker responses against the fixtures of every build still in use: every build released to orbit or to a tester, until every enrolled device has reported a newer build. The app sends its build number on `/d/*` requests and the owner's device list shows it.
- **Done when:** removing a required field from a fixture's source makes CI fail with the build and the field named; the app shows "update needed" when SyncEngine refuses a plan.

### W-70 Signed build and TestFlight for the ground tester (M)
- **Needs:** W-03 (the release job), G2.
- **Change:** the release job from W-03, limited to `main` and to the `ios-release` environment with the owner as required reviewer; signing with the App Store Connect API key; upload; build numbers from the workflow run; while ground testing continues, a scheduled job that cuts a refresh build when the newest one is 45 days old.
- **Done when:** a build appears in TestFlight from a workflow run with no manual step other than the owner's approval; the secrets appear in no log.

### W-71 App Store submission, the route to orbit (M)
- **Needs:** G2. Preparation can start in Wave 1.
- **Change:** the privacy manifest; the export-compliance flag; a demo mode on the fixture plan with no sign-in, for App Review and for screenshots; the listing text and the privacy answers drafted for the owner; the review notes; the request for unlisted distribution prepared for the owner to submit. The approval packet for the device managers (gate G7), short enough to read in five minutes: what the app does, every server it contacts (taken from `routes.json` and `tile-layers.json`, not from memory), what it stores on the device, the one permission it asks for, and that it has no tracking and no third-party analytics. Prepare the packet early, in Wave 1: approval may take longer than the code.
- **Done when:** the owner has everything needed to submit, in one folder; the demo mode passes G2's lines on fixtures; the review notes say what the app does that a website cannot: works with no network, stores plans, sets alerts, draws the map offline.
- **Traps:** App Review guideline 4.2 (minimum functionality) rejects apps that only wrap a website. Demo mode is the signed-out baseline and must show the offline map, device-computed passes and an alert without a sign-in. Guideline 4.8 needs Sign in with Apple beside Google, and guideline 5.1.1(v) needs account deletion in the app; both come from W-20 and W-60. Enable the Sign in with Apple capability on the app's identifier. Builds installed from the App Store show no expiry date; the app tells them from TestFlight builds by the build's receipt environment.

### W-72 Acceptance scripts (S)
- **Done when:** G2 runs on the workflow, including the update step: install the previous build, create an installed plan and unsent log entries, install the new build over it, and check the credential, plan, outbox, kept tiles and settings, then that the queued entries upload once. `docs/ios/ACCEPTANCE.md` holds a ground checklist with the same update step and a ten-minute orbit checklist, each step with its expected result and a place to write what happened.

### W-73 Crew rollout (S)
- **Needs:** G5.
- **Done when:** crewmates have the App Store link and NASA's approval for their devices; a one-page enrollment guide for crew exists; the device list and the revoke steps are in the runbook.

### W-74 Delivery without TestFlight (M)
- **Needs:** G0, W-01.
- **Change:** a release job that signs an ad hoc build for the devices registered in the developer account; an install page with the over-the-air manifest, served over HTTPS behind the map's existing sign-in; and the simplest way for the owner to hand over the iPad's device identifier with no Mac and no cable, written as owner steps.
- **Done when:** a ground device installs the build by tapping the link in Safari, and the page names the build and its signing expiry date. An ad hoc build shows that date in the app with the same banner and alert as a TestFlight build; the app detects it by its embedded provisioning profile.
- **Traps:** no certificate, profile or private key in the repository or in a log. A device identifier is personal data: it goes into the developer account, not into git.

### Later, not scheduled
W-80 Lock Screen countdown and a widget. W-81 Shoot and Skip buttons on the alert. W-82 Swift orbit math, if W-80 or long closed-app alert coverage needs it, with the same reference vectors as W-12. W-83 a native Queue screen. W-84 a native map once MapLibre Native ships a globe. W-85 device-to-device plan sharing. W-86 a longer plan from the generator, if the device extension proves too thin. W-87 batch photo labelling.

## Where each second-opinion finding went

| Finding | Severity | Handled in |
| --- | --- | --- |
| F1 custom scheme is a compatibility gate | High | W-02 items 1, 2, 6 |
| F2 web view keeps WebGL and memory failure modes | High | W-02 items 9, 10; W-61 |
| F3 browser storage carries operational state | High | Storage tiers; W-30, W-31, W-11; the update step in G2, G3 and W-72 |
| F4 the auth change was incomplete | Critical | W-20, W-21, W-60 |
| F5 bundled tiles need a rights decision | High | W-40; open question 5 in the design doc |
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
| The installed build nears expiry | `STATUS.md` shows under 30 days | Cut a refresh build. Tell the owner to install it. |
| Device memory on older iPads | Web process terminations at G3 | Lower the raster cache and the concurrent renderers; record the device floor. |
| Device approval is slow or refused | G7 still open when G2 passes | Ask what the device managers need; offer the custom-app route through Apple Business Manager. The website stays the tool meanwhile. |
| App Review rejects the app | W-71 rejected under guideline 4.2 or for sign-in | Fix the named reason; make demo mode show more offline value. Meanwhile prepare W-74. |
| No app installs on the iPad in orbit | The App Store refused TestFlight on 2026-11-16; the App Store listing and W-74 also fail | Stop. Tell the owner. The fallback is website hardening. |
| The download is too big for the link | The owner's timing from the assignment | Shrink the baseline to zoom 0 to 4 and fetch the rest on first online launch. |
| The live service is disturbed | Any change under `generator/` or in the main checkout | Reject the pull request. |

## Status

The organizer keeps `docs/ios/STATUS.md` current: what shipped, what is in flight, what waits on the owner, the gate reached, and the days until the installed build expires. Plain language, short enough to read on a phone.
