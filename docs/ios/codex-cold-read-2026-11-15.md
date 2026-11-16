# Codex cold read, 2026-11-15

Second opinion on the iPhone and iPad app plan, from Codex (model gpt-6.1-sol, read-only sandbox). It read a structured summary and the repository, not the planning conversation. The text below is its reply word for word. One mechanical change: absolute paths to the checkout were shortened to repository-relative paths.

gstack recorded the run as `OUTSIDE_STATUS: unverified` because its checker could not parse the severity format used here. The findings were read in full and each has a disposition in [WORK_PLAN.md](WORK_PLAN.md).

---

**1. The coolest version: an autonomous photography copilot for the Cupola.**

Before losing signal, SNAP downloads a complete photography plan: several days of opportunities, target reference images, the Earth map, orbital elements, and scheduled alerts. In orbit, it answers one question immediately: **“What should I point the camera at next?”**

The existing ISS view becomes the viewfinder: target approaching, which Cupola window, when it enters the frame, countdown, and Shoot/Skip. Connectivity quietly improves the plan when available. Every prediction carries its provenance: orbital epoch, weather observation time, and planning horizon.

The overlooked architectural idea is the **downloadable plan as a complete, independently usable artifact**. Make that reliable first. The richer copilot is a later destination consistent with premise 1.

**2. What excites them most**

> “so it stays more robust and is less dependent on ... Internet coverage up here.”

They want confidence that the tool will be ready when the photograph happens. Native presentation is their proposed means of getting that confidence.

**3. The project that gets halfway there: Capacitor**

[Capacitor](https://capacitorjs.com/docs/ios) provides the existing-web-app-to-iOS path, native Swift integration, and a plugin ecosystem. Its normal iOS configuration already uses a local custom scheme. It avoids inventing the entire hosting and bridge layer. [Configuration documentation](https://capacitorjs.com/docs/config).

That is roughly half the **application plumbing**, not half the reliability work.

The remaining half is SNAP-specific:

- A complete offline plan with atomic installation, integrity checks, and rollback.
- A licensed, bundled Earth map and native tile storage.
- Device identity mapped to the correct crew profile.
- Durable shot logging with acknowledged, idempotent delivery.
- Notification scheduling with an explicit coverage horizon.
- Recovery from web-process termination.
- Automated signing, delivery, and physical-device acceptance.

Capacitor does not make MapLibre faster merely by putting it inside an app. That requires measurement.

**4. My weekend build**

I would build one complete path through the existing product, with failure recovery as the demonstration.

1. **Friday: establish delivery.** Build the existing frontend inside a Capacitor iOS target on a hosted macOS runner. Produce an installable TestFlight build once signing is provisioned. Test both an actual iPhone and iPad on Earth.
2. **Saturday morning: prove rendering.** Bundle a small, permitted Earth basemap and representative SNAP artifacts. Open Map and ISS view without network access. Exercise the actual MapLibre worker, artifact hashing, gestures, and vertical-perspective rendering.
3. **Saturday afternoon: prove persistence.** Install artifacts into native storage transactionally. Add one native-backed shot-log operation and a local alert scheduled two minutes ahead.
4. **Sunday: try to break it.** Disable networking, terminate and reopen the app, reboot the device, interrupt a data update, and reconnect after a log upload whose response was lost.

The acceptance demonstration is specific: **cold-launch offline; Earth draws; the ISS prediction moves; a target remains usable; an alert appears while locked; a recorded shot survives restart and uploads once.**

The weekend prototype should use fixtures where necessary and label them. A fixture-backed demonstration does not establish several days of operationally useful predictions.

**5. My implementation choice: C, with A as the first release**

Keep the current TypeScript UI and orbital calculations initially. Add native ownership of durable data, network transport, credentials, notifications, and lifecycle recovery.

I would change C’s proposed sequencing: **do not automatically build a Swift orbital core next.** First have the generator publish notification-ready opportunities and schedule them during successful syncs. Introduce native propagation only when a measured requirement needs recalculation while the web UI is unavailable. Widgets and Lock Screen features can wait.

B spends too much of a four-month mission rebuilding working behavior, particularly the ISS view.

**What breaks first:** I would test custom-origin artifact hashing and MapLibre worker loading first because either can stop the prototype. The first integration failure already supported by repository evidence is authentication: the proposed service token does not satisfy the current Worker’s human identity and write-origin requirements.

**The premise I reject literally is 2(c): “an alert fires before each target even with the app closed.”** Scheduling known alerts is supported; unlimited replenishment and guaranteed audible presentation are not. Apple does not guarantee background-task execution at the requested time. Notifications also depend on authorization and presentation settings. [Background scheduling](https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate), [local notifications](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app).

Evidence proving the concern: load more opportunities than the pending-notification budget, leave the app unopened without background execution, and compare delivered alerts with the intended schedule. Separately test Focus, denied permissions, reboot, and expired orbital data.

Premise 3 is feasible, but **TestFlight installation is not mission-length availability**: builds expire after 90 days, shorter than the remaining mission. [Apple’s TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).

**6. Technical findings**

**F1 — High: A custom URL scheme is a compatibility gate.**

Artifact loading currently calls `crypto.subtle.digest` in [manifest.ts](frontend/src/manifest.ts:154). The map also explicitly loads a bundled worker module through [worker-url.ts](frontend/src/map/adapters/maplibre/worker-url.ts:1). Serving HTML successfully proves neither capability.

A custom scheme handler does not itself establish full HTTPS-equivalent behavior. Apple also prevents registering handlers for schemes WKWebView already handles, so simply naming it `https` is not a solution. [Capacitor configuration](https://capacitorjs.com/docs/config).

Recommendation: **Gate the hosting choice on physical-device checks of `isSecureContext`, SHA-256, module workers and their imports, dynamic imports, fetch, and both map renderers because these are existing application dependencies.** If hashing needs a native implementation, preserve integrity verification. Use native offline storage rather than depending on service-worker support at the custom origin.

**F2 — High: WKWebView preserves WebGL and memory failure modes.**

Bundling removes download dependency; it does not remove GPU pressure, decoded-image memory, thermal throttling, or web-process termination. There is no useful universal WKWebView memory budget to assume. Apple exposes a termination callback explicitly. [Web-content termination API](https://developer.apple.com/documentation/webkit/wknavigationdelegate/webviewwebcontentprocessdidterminate%28_%3A%29).

Recommendation: **Measure sustained Map and ISS-view use on the actual device classes, bound raster memory and concurrent renderers, and restore automatically after WebGL context loss or web-process termination because an offline app must recover without ground intervention.**

**F3 — High: Browser storage is currently carrying operational state.**

The boot snapshot lives in localStorage in [snapshot.ts](frontend/src/snapshot.ts:29); cached account identity uses sessionStorage in [profile-session.ts](frontend/src/profile-session.ts:77). Neither should be the sole foundation of native offline availability.

Recommendation: **Keep installed plans, profile association, and unsent logs in native Application Support storage or SQLite, using atomic commits and a previous-good version, because web-storage failure or origin changes must not erase the app’s useful state.** Use a persistent WKWebsiteDataStore for remaining browser preferences and test upgrade migrations.

**F4 — Critical: The proposed authentication change is incomplete.**

Cloudflare service tokens authenticate a service at the Access boundary. They do not automatically establish SNAP’s user identity. [Cloudflare service-token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

The Worker requires `sub` and `email` for normal authenticated APIs in [calibration-auth.ts](worker/src/calibration-auth.ts:128), requires a human Access principal for [browser sessions](worker/src/browser-identity.ts:83), and rejects writes without the website’s origin in [the write guard](worker/src/calibration-auth.ts:94). Native URLSession requests and custom-origin web requests do not satisfy that contract automatically.

Recommendation: **Add an explicit device-authentication path with server-controlled profile ownership and per-device revocation because passing Access is only the first authorization gate.** For this small deployment, individually provisioned service tokens can be workable if each maps to permitted operations and profiles. Keep credentials in Keychain and native networking; never embed a shared secret in the public repository or JavaScript bundle.

For interactive enrollment, use a system authentication session and a validated enrollment exchange. Google prohibits embedded-user-agent OAuth. Do not assume system-browser cookies automatically become WKWebView cookies. [Google OAuth policy](https://developers.google.com/identity/protocols/oauth2/policies).

Offline reading and logging must continue when online credentials expire.

**F5 — High: Bundled tiles require a separate rights decision.**

Current styles use Esri imagery, basemaps, and labels in [map/index.ts](frontend/src/map/index.ts:202). Existing browser caching is not evidence of permission to redistribute those layers in an application.

- **Esri:** offline rights depend on the content, license, and supported export mechanism. [Esri terms](https://www.arcgis.com/home/termsofuse.html).
- **NASA GIBS:** verify each selected product’s credits and third-party restrictions. NASA hosting does not erase third-party copyright. GIBS also publishes bulk-download coordination guidance. [NASA media policy](https://www.nasa.gov/nasa-brand-center/images-and-media/), [GIBS download guidance](https://nasa-gibs.github.io/gibs-api-docs/map-library-usage/).
- **OSM-derived:** distinguish database licensing from tile-provider terms. The standard OSM tile service prohibits bulk downloading and prefetch features. Self-generated or explicitly licensed tiles are a different route. [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/).

Recommendation: **Choose and document a redistributable baseline before implementing the pack because storage engineering cannot resolve content rights.** Preserve required attribution offline, including fonts, glyphs, sprites, and labels.

**F6 — High: A whole-Earth pack needs a defined resolution and fallback.**

“Whole Earth” is an extent, not a size estimate. Increasing maximum zoom rapidly multiplies storage, and near-target cached detail cannot cover an arbitrary pan.

Recommendation: **Bundle a modest global baseline, overzoom it when detail is missing, and download selected detailed regions separately because the map must draw immediately even when every optional download fails.** Serve local bytes before attempting network access; waiting for a network timeout undermines the main benefit.

**F7 — High: Current published artifacts cannot sustain a useful queue for days.**

The default calculation window is 36 hours in [config.py](generator/config.py:22). Publication further trims the opportunities: `passes.json` receives the ranked top 25 and `top_24h.json` receives a limited upcoming list in [main.py](generator/main.py:1515). Those selections can expire long before the underlying horizon.

Recommendation: **Publish a bounded but complete multi-day opportunity artifact, or regenerate opportunities locally from targets and orbital elements, because retaining today’s selected cards cannot reveal omitted future passes.** Keep aging weather confidence separate from geometric opportunity.

**F8 — High: A moving ISS dot can remain plausible after becoming inaccurate.**

SGP4 propagation continuing successfully does not establish positional accuracy after stale elements or an unmodeled maneuver. The app knows a prediction, not an independent onboard position fix.

Recommendation: **Expose orbital epoch and prediction age, define acceptable timing error, and validate against subsequent fresh elements and maneuver cases because photography alerts depend on arrival accuracy.** Keep the map usable while clearly degrading confidence.

**F9 — High: Background refresh cannot maintain an unlimited alert schedule.**

Apple controls when background tasks run. Design conservatively around a pending-notification budget of 64, documented by Apple for the legacy local-notification API, and verify behavior with modern UserNotifications on the target OS. [Scheduling limits](https://developer.apple.com/documentation/UIKit/UILocalNotification).

Recommendation: **Schedule selected opportunities ahead during foreground use and successful sync, reconcile identifiers after plan changes, and display “alerts scheduled through [time]” because silent exhaustion is worse than an explicit coverage boundary.** Background refresh should extend coverage opportunistically. A notification firing does not automatically grant execution time to schedule its successor.

**F10 — High: The existing outbox intentionally discards old entries.**

The current queue caps each account at 200 entries and removes older ones in [calib.ts](frontend/src/calib.ts:210). The Worker already supports idempotent log writes, which should be retained.

Recommendation: **Make the native outbox authoritative, durably commit before reporting success, preserve stable deduplication keys and account ownership, and delete only after an acknowledged receipt because interrupted links create ambiguous delivery outcomes.** Surface capacity problems instead of silently dropping shots.

**F11 — Medium: One repository can still produce two drifting products.**

The website will advance while installed app bundles remain old. Adding a Swift orbital core also creates another implementation of coordinate frames, timing, and pass geometry.

Recommendation: **Use one frontend source tree with a small host interface, versioned bridge capabilities, backward-compatible data contracts, and shared reference vectors because installed native clients cannot track weekly web releases automatically.** Initially bundle the UI and update data independently; introduce another code-update channel only with a concrete reliability case.

**F12 — High: Shipping automation must be established before substantial native work.**

The supplied machine inventory permits portable Swift work, but does not prove iOS compilation, simulator execution, signing, or installation. Hosted macOS CI can supply the build environment; signing still requires provisioned credentials. [GitHub’s Xcode signing workflow](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).

Recommendation: **Create a pinned, reproducible hosted build and signing pipeline first, with secrets restricted to trusted release jobs, because unattended delivery is part of the product’s recovery path.** Keep builds away from the live generator checkout. Prove an install on Earth before asking the orbital device to accept it.

**F13 — Critical: TestFlight adds a predictable availability deadline.**

A fully cached, otherwise healthy app can become unavailable when its beta build expires after 90 days. A replacement upload alone does not update the installed device. [Apple’s expiration rule](https://testflight.apple.com/).

Recommendation: **Track the installed build’s expiration, deliver replacements well in advance, and assess a reviewed distribution route for continued use because the remaining mission exceeds one TestFlight build’s lifetime.** Keep downloads small and verify installation on both orbital devices.

**F14 — Medium: Remote diagnosis needs to survive offline operation.**

A browser screenshot cannot explain a failed pack installation, rejected credential, web-process crash, or exhausted notification schedule.

Recommendation: **Include a compact, exportable diagnostic record containing build, plan version, orbital epoch, storage status, notification coverage, and outbox acknowledgments because the operator cannot attach a debugging cable.** Exclude credentials and sensitive payloads.

This was a read-only repository and documentation review. No files changed; physical-device behavior remains unverified.

VERDICT: FINDINGS
