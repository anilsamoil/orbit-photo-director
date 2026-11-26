# G1 host proof

W-02 exercises SNAP's real frontend in the default Capacitor 8.6.2 WKWebView at its bundled local origin, with a synthetic plan and external networking disabled. Capacitor is the proposed host. G1 includes these simulator runs and the W-03 signed ground-device checks.

## Simulator runs

The W-02 workflow selects Xcode 26.6 (17F113) on `macos-26`, with an iOS 26.0 deployment target. The configured matrix uses the same devices and runtime as the successful W-01 launch run 45870433702. Both legs failed in the first hosted W-02 run. G1 remains open. [Hosted run 45885542841](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45885542841)

| Destination | Simulator runtime | Orbit device gap | W-02 run |
| --- | --- | --- | --- |
| iPad Pro 11-inch (M5) | iOS 26.5 | iPad Pro 11-inch (M4), iPadOS 26.6.2 | Failed · [Proof artifact](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45885542841/artifacts/15150685412) |
| iPhone 17 Pro | iOS 26.5 | iPhone 17 Pro, iOS 26.6.1 | Failed · [Proof artifact](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45885542841/artifacts/15149826896) |

On both legs, the driver called JavaScript before `window.__opdG1` existed. The iPad export records a JavaScript exception for checks 1 and 8. The iPhone export records “JavaScript execution returned a result of an unsupported type” for those checks, likely a consequence of the WebContent teardown that preceded the error in its app log. The driver did not reach the other checks on either leg. Both observers failed to start when `/bin/ps` timed out after five seconds.

The hosted simulator logs for both legs show WebGL context loss and `SimMetalHost` XPC disconnects with `OS_REASON_METAL`. The role of those events in the proof failures remains unconfirmed.

The hosted macOS runner is a virtual machine. If it lacks a usable GPU, it may be unable to run WebGL2 checks 3–5. Use the next hosted run's context-event evidence to test that hypothesis. If the GPU limitation is confirmed, those checks would need a physical device in W-03, and the simulator half of G1 may be unprovable on hosted runners. [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories)

Offline evidence requires an egress precondition in check 1 and again in the recovered document in check 9. The original WebKit fetch, XMLHttpRequest and WebSocket must each fail with an enforced `connect-src` violation. Calls through the CapacitorHttp alias and native plugin class must both return `G1_BRIDGE_DENIED`.

## Checks

| # | Check | iPad result | iPhone result | Evidence to record from CI |
| --- | --- | --- | --- | --- |
| 1 | Secure context and SHA-256 | not passed | not passed | Local origin, `isSecureContext`, input byte count, both WebCrypto and CryptoKit digests, and the egress-denial results. |
| 2 | Map chunk and MapLibre worker | not passed | not passed | Map tab renderer, bundled worker URL and a worker-processed GeoJSON feature query. |
| 3 | WebGL2 | not passed | not passed | Actual Map canvas context, GL version and drawing buffer dimensions. |
| 4 | Map local tile | not passed | not passed | Green tile pixel count, hidden-layer control, bundled route and `G1-map` screenshot. |
| 5 | ISS local tile and geometry | not passed | not passed | Bundled orange raster pixels and hidden-layer control, applied horizon and nadir poses and zooms, and the visible renderer's globe shader, full projection transition and active `vertical-perspective` projection at each pose and applied zoom 12. Reuse the existing ISS geometry assertions, with a visible-frame horizon limb error below 1°. Keep the `G1-iss` screenshot. |
| 6 | Request bridge | not passed | not passed | Native receipts for plan GET, target DELETE, log POST and target PUT. Compare method, paths, headers and exact body bytes. Native rejects body fields on the bodyless routes. |
| 7 | At least 50 tiles/s | not passed | not passed | Count, elapsed time, bytes per tile, validated response bytes, native route observations and delivered tiles/s. |
| 8 | localStorage across app relaunch | not passed | not passed | XCUITest sees app exit and a new launch. Compare storage token, native launch identities and WebView document identities. |
| 9 | WebContent termination and recovery | not passed | not passed | Simulator process observation, WebKit termination callback, Capacitor reload, new document identity, same active tab, repeated egress denial and fresh ISS raster pixels with a hidden-layer control. |
| 10 | Ten-minute pan and zoom, peak memory | not passed | not passed | Each simulator requires 600000 ms, with at least 300000 ms per renderer. Every counted move must reach its requested pan and zoom and show bundled tile pixels in a fresh frame. Each renderer requires a verified move in the first and final 30 seconds of its five-minute half and no gap longer than 30 seconds between verified moves. Record actual duration, moves, verified frame timestamps, minimum tile pixel counts, RSS observation duration, peak WebContent resident bytes and termination count. |

## Proof setup and evidence

The isolated Vite build starts the real frontend with a fixed clock, fixture plan and synthetic imagery. The website bootstrap sees an available fixture transport so it can load the plan. Its proof-only build excludes private crew-roster inputs and the service worker. It reuses the existing ISS G1 geometry probe with local imagery. The bundle records its fixture, tile and asset hashes in `__g1/build.json`. [ISS geometry probe](../../frontend/src/map/adapters/maplibre/iss-g1-page.ts) · [Build instructions](../../app/README.md#w-02-offline-host-proof)

`prepare-ios.py --host-proof` stages the proof separately in `public-proof`. The `HostProof` scheme copies that input into the app bundle and selects the proof controller. The standard app build guards its resource input and bundle against the proof marker. The proof's Content Security Policy, fail-closed WebKit proxy and native navigation policy deny external traffic. The native bridge allows only bundled main-frame calls to the proof plugin and Capacitor console and bootstrap diagnostics. The ingress filter rejects HTTP plugin dispatch before native class lookup.

Capacitor's default asset handler serves static files. The throughput check fetches 100 distinct bundled tile paths through that handler, validates each response and matches each path to a native router observation. The result measures that static route. The tile gateway and offline packs are later work packages.

The hosted observer scopes WebContent identification to the test simulator and uses host process APIs to terminate the renderer identified for this app. It samples WebContent resident set size throughout the scripted pan and zoom. The W-02 simulator proof covers checks 1–9 and provides indicative evidence for check 10.

XCTest and artifact export each check for the tab's raster color in the central canvas region of the screenshot, green for Map and orange for ISS. Whenever the corresponding probe passes, the exported row requires that screenshot even if XCTest fails overall. A missing or invalid screenshot fails the row. The placeholder launch test retains its dark-background and light-text check.

Each `ios-host-proof-<device>-<run>-<attempt>` artifact retains `proof-results.json`, `checks.md`, build hashes, runner and observer logs, the `.xcresult` and exported attachments when available. The test and report name missing evidence explicitly. Record subsequent hosted runs and their check results here. If a check fails with the default host, record its evidence before trying a custom WKWebView host under the same checks.

## W-03 ground-device proof

Before distributing the signed ground proof through TestFlight or W-74, W-03 must provide an in-app launch trigger so the ground tester can start the proof without XCTest launch arguments. W-03 must also provide an evidence procedure that verifies app exit and relaunch with the storage token intact, WebContent termination and recovery, and peak WebContent memory and termination count during the full ten-minute run, all without the Mac-side `simctl` observer.

The ground tester runs all ten checks on the installed signed build and records the build, delivery channel, device model, OS version and results here. [W-03 work package](WORK_PLAN.md#w-03-signed-host-proof-on-a-ground-device-s)
