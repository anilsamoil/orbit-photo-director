# G1 host proof

W-02 exercises SNAP's real frontend in the default Capacitor 8.6.2 WKWebView at its bundled local origin, with a synthetic plan and external networking disabled. Capacitor is the proposed host. G1 includes these simulator runs and the W-03 signed ground-device checks.

## Simulator runs

The W-02 workflow selects Xcode 26.6 (17F113) on `macos-26`, with an iOS 26.0 deployment target. The matrix uses the same devices and runtime as the successful W-01 launch run 45870433702.

| Destination | Simulator runtime | Orbit device gap | First hosted run artifact |
| --- | --- | --- | --- |
| iPad Pro 11-inch (M5) | iOS 26.5 | iPad Pro 11-inch (M4), iPadOS 26.6.2 | Failed · [Proof artifact](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45885542841/artifacts/15150685412) |
| iPhone 17 Pro | iOS 26.5 | iPhone 17 Pro, iOS 26.6.1 | Failed · [Proof artifact](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45885542841/artifacts/15149826896) |

The first run reported startup errors for checks 1 and 8 on both legs. The driver did not reach the other checks, and both observers timed out during startup.

Hosted simulators cannot sustain WebGL/Metal for G1. On both devices in both runs, `com.apple.WebKit.GPU` repeatedly aborted after losing its XPC connection to `SimMetalHost` (namespace METAL, code 102, `XPC_ERROR_CONNECTION_INTERRUPTED`). WebGL lost context within about 40–60 seconds and WebContent terminated. [Run 45885542841](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45885542841) · [Run 45890306629](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45890306629)

In run 45890306629, checks 1, 6 and 8 passed on both devices. Check 7 passed on iPhone 17 Pro and failed on iPad with “Proof operation timed out”. Checks 2, 3, 4, 5, 9 and 10 failed on both. [Run 45890306629](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45890306629)

Scoped hosted run 45896800677 passed both host-proof legs for revision `b3a4adb` (pull request merge SHA `40aaf58`). Run 45894450939 (`ccdb20b`) also passed both host-proof legs. The exact-HEAD result of the final commit is recorded in the PR checks. The remaining checks are not waived and require on-device evidence. G1 remains OPEN. [Run 45896800677](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45896800677) · [Run 45894450939](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45894450939)

Offline evidence requires an egress precondition in check 1 and again in the recovered document when check 9 runs. The original WebKit fetch, XMLHttpRequest and WebSocket must each fail with an enforced `connect-src` violation. Calls through the CapacitorHttp alias and native plugin class must both return `G1_BRIDGE_DENIED`.

## Checks

Results are from scoped run 45896800677.

| # | Check | iPad result | iPhone result | Evidence to record |
| --- | --- | --- | --- | --- |
| 1 | Secure context and SHA-256 | Hosted pass | Hosted pass | Local origin, `isSecureContext`, input byte count, both WebCrypto and CryptoKit digests, and the egress-denial results. |
| 2 | Map chunk and MapLibre worker | Hosted not-run (on-device required) | Hosted not-run (on-device required) | Map tab renderer, bundled worker URL and a worker-processed GeoJSON feature query. |
| 3 | WebGL2 | Hosted not-run (on-device required) | Hosted not-run (on-device required) | Actual Map canvas context, GL version and drawing buffer dimensions. |
| 4 | Map local tile | Hosted not-run (on-device required) | Hosted not-run (on-device required) | Green tile pixel count, hidden-layer control, bundled route and `G1-map` screenshot. |
| 5 | ISS local tile and geometry | Hosted not-run (on-device required) | Hosted not-run (on-device required) | Bundled orange raster pixels and hidden-layer control, applied horizon and nadir poses and zooms, and the visible renderer's globe shader, full projection transition and active `vertical-perspective` projection at each pose and applied zoom 12. Reuse the existing ISS geometry assertions, with a visible-frame horizon limb error below 1°. Keep the `G1-iss` screenshot. |
| 6 | Request bridge | Hosted pass | Hosted pass | Native receipts for plan GET, target DELETE, log POST and target PUT. Compare method, paths, headers and exact body bytes. Native rejects body fields on the bodyless routes. |
| 7 | At least 50 tiles/s | Hosted not-run (on-device required) | Hosted pass (100 tiles in 206 ms, 485 tiles/s) | Count, elapsed time, bytes per tile, validated response bytes, native route observations and delivered tiles/s. |
| 8 | localStorage across app relaunch | Hosted pass | Hosted pass | Record app exit and a new launch. Compare storage token, native launch identities and WebView document identities. |
| 9 | WebContent termination and recovery | Hosted not-run (on-device required) | Hosted not-run (on-device required) | WebContent process observation, WebKit termination callback, Capacitor reload, new document identity, same active tab, repeated egress denial and fresh ISS raster pixels with a hidden-layer control. |
| 10 | Ten-minute pan and zoom, peak memory | Hosted not-run (on-device required) | Hosted not-run (on-device required) | Full proof requires 600000 ms, with at least 300000 ms per renderer. Every counted move must reach its requested pan and zoom and show bundled tile pixels in a fresh frame. Each renderer requires a verified move in the first and final 30 seconds of its five-minute half and no gap longer than 30 seconds between verified moves. Record actual duration, moves, verified frame timestamps, minimum tile pixel counts, RSS observation duration, peak WebContent resident bytes and termination count. |

## Proof setup and evidence

The isolated Vite build starts the real frontend with a fixed clock, fixture plan and synthetic imagery. The website bootstrap sees an available fixture transport so it can load the plan. Its proof-only build excludes private crew-roster inputs and the service worker. It reuses the existing ISS G1 geometry probe with local imagery. The bundle records its fixture, tile and asset hashes in `__g1/build.json`. [ISS geometry probe](../../frontend/src/map/adapters/maplibre/iss-g1-page.ts) · [Build instructions](../../app/README.md#w-02-offline-host-proof)

`prepare-ios.py --host-proof` stages the proof separately in `public-proof`. The `HostProof` scheme copies that input into the app bundle and selects the proof controller. The standard app build guards its resource input and bundle against the proof marker. The proof's Content Security Policy, fail-closed WebKit proxy and native navigation policy deny external traffic. The native bridge allows only bundled main-frame calls to the proof plugin and Capacitor console and bootstrap diagnostics. The ingress filter rejects HTTP plugin dispatch before native class lookup.

Capacitor's default asset handler serves static files. The throughput check fetches 100 distinct bundled tile paths through that handler, validates each response and matches each path to a native router observation. The result measures that static route. The tile gateway and offline packs are later work packages.

With `G1_CHECKS` unset, the proof runs all ten checks. In a full simulator run, the observer identifies and terminates the app's WebContent process and samples its resident set size throughout the scripted pan and zoom. The scoped hosted proof skips the renderer screenshots and the stress phase.

XCTest and artifact export each check for the tab's raster color in the central canvas region of the screenshot, green for Map and orange for ISS. Whenever the corresponding probe passes, the exported row requires that screenshot even if XCTest fails overall. A missing or invalid screenshot fails the row. The placeholder launch test retains its dark-background and light-text check.

Each `ios-host-proof-<device>-<run>-<attempt>` artifact retains `proof-results.json`, `checks.md`, build hashes, runner logs, the `.xcresult` and any observer logs and exported attachments. The JSON records the selection, and the report labels excluded checks “not-run (on-device required)”. If a check fails with the default host, record its evidence before trying a custom WKWebView host under the same checks.

## On-device proof (required)

This proposed matrix defines the evidence for each target. The [OPEN G1 gate](DECISIONS.md#g1-on-device-gate) still requires on-device proof, including Safari on iPad, before W-03 can be called done or ship anything.

| Target | Required proof | Device note |
| --- | --- | --- |
| iPhone 17 Pro | All ten checks in the signed app | |
| iPad M4 (11-inch) | All ten checks in the signed app | |
| 3rd-gen iPad | All ten checks in the signed app | 3rd-gen iPad: owner to confirm exact model, hardware identifier and iPadOS version (must run the iPadOS 26 build) |
| Safari on iPad | Web-only evidence below | Record the actual iPad model, iPadOS version and Safari version. |

All three signed app runs include the CryptoKit digest comparison (1), Capacitor bridge (6), native asset handler throughput (7), `localStorage` across app exit and relaunch (8), and WebContent termination and recovery via Capacitor reload (9).

| Check | Safari on iPad evidence |
| --- | --- |
| 1 | Confirm secure context and match the WebCrypto SHA-256 digest against the expected fixture digest. Record browser egress denial for the offline fixture. CryptoKit comparison and Capacitor HTTP denial are n/a (native only). |
| 2 | Load the Map chunk and MapLibre worker and verify the worker-processed fixture query. |
| 3 | Verify WebGL2 on the Map canvas. |
| 4 | Verify the Map fixture tile, hidden-layer control and screenshot. |
| 5 | Verify the ISS fixture tile, hidden-layer control, geometry assertions and screenshot. |
| 6 | n/a (native only) |
| 7 | n/a (native only) |
| 8 | Verify the same `localStorage` token across tab reload and Safari relaunch. Signed app exit and relaunch evidence is n/a (native only). |
| 9 | n/a (native only) |
| 10 | Run the full ten minutes of verified Map and ISS pan and zoom. Record peak observed browser memory and confirm the run finishes without a page or process termination. |

## W-03 ground-device proof

Before distributing the signed ground proof through TestFlight or W-74, W-03 must provide an in-app launch trigger that works without XCTest launch arguments. W-03 must also provide the evidence procedure for the required app and Safari runs. The app procedure must verify exit and relaunch with the storage token intact, WebContent termination and recovery, and peak WebContent memory and termination count during the full ten-minute run, all without the Mac-side `simctl` observer.

Run the full proof on the installed signed build on all three devices and collect the web-only evidence in Safari on iPad. Record the build, delivery channel or browser version, device model, OS version, each check result and its evidence here. [W-03 work package](WORK_PLAN.md#w-03-signed-host-proof-on-a-ground-device-s)
