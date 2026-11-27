# Run the W-03 ground proof

Repeat the signed app run on iPhone 17 Pro, iPad M4 (11-inch), and the 3rd-gen iPad. Record the exact model, OS version, TestFlight build number, and delivery channel. Confirm the 3rd-gen iPad's exact model and iPadOS 26 compatibility.

Before the release dispatch, confirm that at least one ground device is registered in the Apple Developer account for G0. Xcode's automatic archive signing can create a development profile before the Apple Distribution export. [Owner steps](OWNER_STEPS.md#4-a-ground-tester)

1. Install the internal TestFlight build. Open SNAP and tap **Run Proof**. Keep SNAP visible while checks 1–7 run.
2. When SNAP asks you to reopen it, swipe its card away in the app switcher. Open SNAP from its icon. Check 8 compares the saved storage token and the old and new app and WebView identities.
3. Connect the device to a trusted Mac with Xcode. Use Instruments on that device or `xcrun devicectl device info processes` to identify SNAP's WebContent process. If the tethered tools can terminate that specific process, tap **Check Recovery**, then **Arm Recovery**. Wait for **Armed for two minutes**. Trigger termination while SNAP stays open. Record the process observation and keep the app's callback and reload evidence. If process attribution or termination is unavailable, tap **Trigger Unavailable**. Check 9 stays blocked. A page reload alone cannot exercise this check.
4. Start a device trace in Instruments before tapping **Start 10-Minute Run**. Use a system-wide process instrument that exposes resident memory for the connected device. Correlate the WebContent process to SNAP. Keep the app visible and the trace running through both five-minute phases. Save the trace, peak resident bytes, observation duration, and any process exits. If Instruments cannot identify or measure that process, leave check 10 open and report the limitation. SNAP exports renderer and termination evidence. The trace supplies peak memory.
5. Open **Results**, then **Screenshots**. Choose **Map** and take a device screenshot once SNAP says the frame is ready. Repeat for **ISS**. Save them as `G1-map.png` and `G1-iss.png`. Tap **Share** in **Results** to save `proof-results.json`.

## Run Safari on iPad

Serve the signed build's bundled `public` directory or its matching `app/host-proof/dist` at the root of a dedicated, trusted HTTPS fixture origin. Open it in Safari on the iPad. Enable Safari Web Inspector and connect it to Safari on the tethered Mac. Record the iPad model, iPadOS version, and Safari version.

- In the Web Inspector console, use `await window.__opdG1.safari.runCheck(id)` for IDs 1–5. Save each result. Use `await window.__opdG1.capture('map')` and `await window.__opdG1.capture('iss')` before taking the corresponding device screenshots.
- Save the object from `window.__opdG1.prepareRelaunch()`. Reload the tab and call `await window.__opdG1.safari.verifyStorage(before)` with that object. Quit Safari from the app switcher, reopen the same fixture URL, and repeat the comparison. Save both results.
- Start the tethered memory trace for this tab's WebContent process. Call `await window.__opdG1.stress(600000)` and save the result and trace. Keep Safari visible for the full run. Record any page or process termination. If the memory measurement is unavailable, leave check 10 open. Checks 6, 7, and 9 are native-only.

Send the device and build details, results, screenshots, and redacted process and memory evidence. Include missing or blocked checks. Keep personal data out of the evidence. [Required evidence matrix](G1-HOST-PROOF.md#on-device-proof-required)
