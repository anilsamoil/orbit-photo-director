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
| G0 Accounts | Owner | The developer membership is active, the app record exists, the API key is in the `ios-release` environment, a ground tester is named | Unsigned work continues. Nothing ships. |
| G1 Host proof | W-02 | Every check in W-02 passes on a simulator, and the host choice is recorded | Try the other host. If neither can draw Map and ISS view from a local origin, stop and tell the owner: the fallback is hardening the website. |
| G2 Offline acceptance | W-72, on the hosted workflow | Cold-launch offline; Earth draws; the ISS prediction moves; a target remains usable; an alert appears while locked; a recorded shot survives restart and uploads once | Fix before any signed build |
| G3 Ground device | Ground tester, checklist from W-72 | The same line, on a real iPhone or iPad on Earth, from a TestFlight install | Fix before the build goes to orbit |
| G4 Orbit | Owner, ten-minute checklist from W-72 | Install, enroll, one LOS period, one alert, one logged shot | The website remains the tool. Fix and resend. |
| G5 Crew | Owner | Fourteen days of the owner's use with no lockout and no lost log | Hold the crew group |
| G6 No-expiry route | W-71 | The unlisted App Store listing is approved and installed | Keep the 45-day refresh schedule |

### Testing without the iPad in orbit

On 2026-11-16 the owner could not get TestFlight onto the iPad in orbit. Testing does not depend on that iPad:

- **Every day: simulators.** The hosted workflow runs the app in the iOS Simulator on GitHub's Macs from W-01 on, with no Apple account. G2 runs there. Once Xcode is on the Mac on Earth (owner step 5), Claude and Codex can also drive the simulator from their own sessions and take screenshots.
- **Before orbit: one real device on Earth.** G3 needs a person on the ground with an iPhone or iPad (owner step 4). A simulator cannot show real memory limits, real background refresh or real alert delivery.
- **Orbit: a route that works on that iPad.** Until the cause of the TestFlight failure is known, W-74 prepares a route that needs neither TestFlight nor the App Store.

### Delivery routes to the iPad in orbit, in order of preference

1. TestFlight, if the cause of the 2026-11-16 failure is fixed.
2. The unlisted App Store listing (W-71), if the App Store itself works on that iPad.
3. Ad hoc install over the air (W-74). The iPad's device identifier is registered in the developer account, the build is signed for the registered devices, and the iPad installs it by tapping a link in Safari. It needs neither TestFlight nor the App Store. The signing lasts up to a year, so it also avoids the 90-day lapse. It does not work if device management on that iPad forbids installing apps.
4. If no app can be installed on that iPad: the plan's fallback, hardening the website.

## Order of work

Wave 0 needs no Apple account and starts now. The packages inside a wave can run in parallel unless "Needs" says otherwise.

```
Wave 0   W-00 ─┬─ W-01 ── W-02 (G1)
               ├─ W-10
               ├─ W-20 (design note, review, code; no deploy)
               ├─ W-30 ── W-31
               └─ W-40
Wave 1   W-11 (needs W-10, G1)   W-12 (needs W-10)   W-32 (needs W-30, W-31, G1)   W-41 (needs W-40, W-11)
         W-21 (needs W-20, owner)   W-60 (needs W-21, W-32)
Wave 2   W-33   W-42   W-50   W-61   W-62          then W-72 (G2)
Wave 3   W-70 (needs G0, G2)   W-74 (needs G0, W-01)   G3   G4   W-71   W-73 (G5)
Later    W-80 and up, each with a measured reason
```

Target, not a promise: G2 about two weeks after Wave 0 starts; the first build in orbit about a week after G0 and G2 are both true.

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
- **Traps:** a simulator proves items 1 to 9. Item 10 is only indicative on a simulator; repeat it at G3 on a real device. A custom scheme handler may not receive request bodies; that is why item 6 exists.

### W-10 Web host seam, browser side (M)
- **Change:** add `frontend/src/host/` with the interface in ARCHITECTURE.md and `browser.ts`. Move every same-origin `fetch` to `host.request` (21 non-test files call `fetch`; classify each call as same-origin or other-origin first). Move the snapshot and the calibration queue storage behind `host.snapshot` and `host.outbox`. Add `routes.json` and `tile-layers.json`, and build the map sources through `host.tileUrl`.
- **Tests first:** a contract test that records every same-origin request (URL, method, headers, cache mode, body) for manifest, artifacts, log post and read, session, target routes, kp, aurora, wx, cloud, launch pointer and catalog, hazards, lightning and the probe. It is green on the old code and committed before anything moves. This is the rule in `AGENTS.md` for moving a capability.
- **Done when:** that contract test is still green; the new boundary tests fail on a planted violation (bare same-origin `fetch`, unclassified path, tile template outside the catalogue, `host.kind` read outside the seam); the three frontend checks are green; `drive all` in verify-opd is green.
- **Traps:** `main.ts` and `map/index.ts` are outside coverage, so the contract test is their only guard. `src/map/` allows no comments and no module-level `let`.

### W-11 Web host seam, iOS side (M)
- **Needs:** W-10, G1.
- **Change:** `ios.ts` over the bridge. A Vite mode `ios` that builds to `frontend/dist-ios` with no service worker, no PWA manifest and no `registerSW.js`. The tier 2 storage mirror. The `/api/app` recovery link and the install hints are hidden when `identity.v1` is present.
- **Done when:** unit tests drive `ios.ts` against a fake bridge for every route class; the `ios` build runs in the W-01 app on the fixture plan; switching profile from the profile menu reloads the shell inside the app; the browser build's behaviour is unchanged (W-10's contract test).

### W-12 Extended queue on the device (M)
- **Needs:** W-10.
- **Change:** `frontend/src/plan-extend/`, a pure module that runs in a Web Worker: passes for the published and personal targets from the end of the published horizon to seven days out, with geometry, lighting regime and the three-factor score. Entries carry `provenance: 'device'`. Queue and Upcoming show them after published passes under their own heading, tagged "geometry only", with no cloud number. A script writes reference vectors from the Python pass finder for a fixed orbit and target set.
- **Done when:** the TypeScript results match the reference vectors inside the generator's sampling step; 300 targets over seven days compute in under one second in the test; the feature is on for the `ios` host and off for the `browser` host behind one flag; with the flag off the website renders exactly as before.
- **Traps:** pass times start from the wall clock, not the scrubbed map time. Do not import from `src/map/`.

### W-20 Device access in the Worker (L, security-sensitive)
- **Change, in three steps, each reviewed:**
  1. `docs/ios/DEVICE-ACCESS.md`: the threat model, the enrollment sequence, token storage, revocation, rate limits, and why the same-origin write rule does not apply to bearer-token requests. Compare it with the service-token fallback in ARCHITECTURE.md and pick one.
  2. A security review of that note before any code.
  3. `worker/src/device-auth.ts` and its routing: `/api/device/enroll` (behind Access), `/d/enroll`, `/d/*` for the plan, published data and the API, and an owner-only list and revoke route behind Access.
- **Tests, in the style of `worker/test/access-gate.test.ts`:** a code is single use; a code expires at five minutes; a wrong verifier fails; an unknown or revoked token is 401 with no detail; a token cannot read or write a profile its account is not granted; `/d/session` returns the same shape as `/api/browser/session`; `/d/*` cannot reach a human-only route; the daily rate limit holds; the existing Worker suite stays green.
- **Done when:** the review signs off and the tests are green. Nothing is deployed in this package.

### W-21 Deploy device access (S, owner approves)
- **Needs:** W-20.
- **Change:** an Access bypass application for `/d/*` on both map hosts; the Worker deploy by the runbook.
- **Done when:** a test device enrolled under a profile made for testing reads the manifest and writes one log entry that appears once. No rating is fabricated in a real profile.

### W-30 OPDKit: PlanStore and SyncEngine (M)
- **Change:** the two parts as described in ARCHITECTURE.md, with injected clock, file root and transport.
- **Done when:** `swift test` is green on the Mac and on the workflow; the fault tests stop an install between every pair of steps and `current` always resolves to a complete verified plan; an older version never replaces a newer one.

### W-31 OPDKit: Outbox (S)
- **Needs:** W-30 for the package.
- **Done when:** an entry survives a process stop at any point after `enqueue` returns; a lost response plus a retry yields one server record in the fake transport; a rejected entry moves to a kept "rejected" folder and is counted in diagnostics; nothing is dropped for space.

### W-32 Native transport and bridge (M)
- **Needs:** W-30, W-31, G1.
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
- **Done when:** the lookup order is baseline, tile store, network; a unit test proves the network is not touched when local bytes exist; the baseline is never evicted; the size budget holds under a fill test; the per-plan prefetch matches today's budget of one tile per zoom for the top three targets.

### W-42 The map with no network (S)
- **Needs:** W-41.
- **Done when:** with the network off, pixel probes find Earth, not black, on Map at world view and at zoom 3, 5 and 7, with clouds on and off, and on ISS view; the labels toggle shows Natural Earth labels; the website's style contract tests are unchanged for the `browser` host.

### W-50 Alerts (M)
- **Needs:** W-32, W-12.
- **Change:** the alert plan builder on the web side; `AlertPlanner` in `OPDKit`; the notification adapter in `OPDHost`; settings for lead time, targets and a sleep window; the "Alerts set through ..." line; the two reserved slots. On the `ios` host the Remind button sets an alert instead of exporting a calendar file.
- **Done when:** the planner never schedules more than the limit; alerts that left the plan are removed; the coverage end equals the last scheduled alert; the sleep window holds across midnight UTC; a simulator test sees the pending requests after a plan is set; permission denied is shown as a state, not an error.

### W-60 Enrollment and identity (M)
- **Needs:** W-21, W-32.
- **Done when:** a first launch shows one screen with one button; the system sign-in sheet completes enrollment; the profile name shows; relaunch needs no sign-in; "Forget this device" removes the token and revokes it; a rejected token shows a banner and reading continues.

### W-61 Lifecycle and recovery (S)
- **Done when:** web process termination reloads to the same tab; a lost WebGL context rebuilds the map; a memory warning reaches the web side; links to other sites open in Safari; the layouts hold at iPhone 17 Pro and iPad Pro 11 sizes in both orientations and at iPad split-view widths; the keep-awake setting works.

### W-62 Diagnostics and build lifetime (S)
- **Done when:** one page shows the build and its expiry date, the plan version and age, the orbit data age, storage in use, alert coverage, outbox and rejected counts, the last sync results and the token state; "Export" produces a text file with no token and no personal target coordinates; the expiry banner appears 30 days out.

### W-70 Signed build and TestFlight (M)
- **Needs:** G0, G2.
- **Change:** a release job limited to `main` and to the `ios-release` environment with the owner as required reviewer; signing with the App Store Connect API key; upload; build numbers from the workflow run; a scheduled job that cuts a refresh build when the newest one is 30 days old.
- **Done when:** a build appears in TestFlight from a workflow run with no manual step other than the owner's approval; the secrets appear in no log.

### W-71 App Store readiness (M)
- **Change:** the privacy manifest; the export-compliance flag; a demo mode on the fixture plan with no sign-in, for App Review and for screenshots; the listing text and the privacy answers drafted for the owner; the request for unlisted distribution prepared for the owner to submit.
- **Done when:** the owner has everything needed to submit, in one folder, and the demo mode passes G2's line on fixtures.

### W-72 Acceptance scripts (S)
- **Done when:** G2 runs on the workflow; `docs/ios/ACCEPTANCE.md` holds a ground checklist and a ten-minute orbit checklist, each step with its expected result and a place to write what happened.

### W-73 Crew rollout (S)
- **Needs:** G5.
- **Done when:** an external TestFlight group exists; a one-page enrollment guide for crew exists; the device list and the revoke steps are in the runbook.

### W-74 Delivery without TestFlight (M)
- **Needs:** G0, W-01.
- **Change:** a release job that signs an ad hoc build for the devices registered in the developer account; an install page with the over-the-air manifest, served over HTTPS behind the map's existing sign-in; and the simplest way for the owner to hand over the iPad's device identifier with no Mac and no cable, written as owner steps.
- **Done when:** a ground device installs the build by tapping the link in Safari, and the page names the build and its signing expiry date.
- **Traps:** no certificate, profile or private key in the repository or in a log. A device identifier is personal data: it goes into the developer account, not into git.

### Later, not scheduled
W-80 Lock Screen countdown and a widget. W-81 Shoot and Skip buttons on the alert. W-82 Swift orbit math, if W-80 or long closed-app alert coverage needs it, with the same reference vectors as W-12. W-83 a native Queue screen. W-84 a native map once MapLibre Native ships a globe. W-85 device-to-device plan sharing. W-86 a longer plan from the generator, if the device extension proves too thin. W-87 batch photo labelling.

## Where each second-opinion finding went

| Finding | Severity | Handled in |
| --- | --- | --- |
| F1 custom scheme is a compatibility gate | High | W-02 items 1, 2, 6 |
| F2 web view keeps WebGL and memory failure modes | High | W-02 items 9, 10; W-61 |
| F3 browser storage carries operational state | High | Storage tiers; W-30, W-31, W-11 |
| F4 the auth change was incomplete | Critical | W-20, W-21, W-60 |
| F5 bundled tiles need a rights decision | High | W-40; open question 5 in the design doc |
| F6 a whole-Earth pack needs a set resolution | High | W-40 (zoom 0 to 5), W-41, W-42 |
| F7 published artifacts cannot hold a queue for days | High | W-12 |
| F8 a moving dot can be wrong | High | Orbit data age in W-62 and in the readout; alert text carries the age |
| F9 background refresh cannot keep alerts topped up | High | W-50, W-33; corrected premise 2(c) |
| F10 the web outbox drops old entries | High | W-31 |
| F11 one repository, two drifting products | Medium | W-10 boundary tests, `routes.json`, W-12 reference vectors |
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
| No app installs on the iPad in orbit | TestFlight failed on 2026-11-16; W-74 also fails | Stop. Tell the owner. The fallback is website hardening. |
| The download is too big for the link | The owner's timing from the assignment | Shrink the baseline to zoom 0 to 4 and fetch the rest on first online launch. |
| The live service is disturbed | Any change under `generator/` or in the main checkout | Reject the pull request. |

## Status

The organizer keeps `docs/ios/STATUS.md` current: what shipped, what is in flight, what waits on the owner, the gate reached, and the days until the installed build expires. Plain language, short enough to read on a phone.
