# Follow-ups

Real problems found during iOS work that were not fixed in the work package that found them. It serves the app the way `docs/agent/FOLLOWUPS.md` serves the map.

Each entry says what is wrong, where, how to reproduce it, and which work package found it.

## W-02 host proof

Astra round 3 raised these findings during W-02.

**Fixed in W-03.** The exporter validates the evidence for each passing check. Incomplete evidence, including `{"placeholder": true}`, fails the row in both `proof-results.json` and `checks.md`. A malformed duplicate ID such as `8.0` or `"8"` also invalidates the corresponding row.

**The process observer can select a WebContent process that belongs to another WebView.** `app/scripts/observe-host-proof.py` identifies the candidate by its shared `launchd_sim` parent. Exercise selection with a synthetic process table where another client owns the sole new WebContent process under that parent. The observer accepts it. Pausing and resuming the sampler during stress can also leave a long gap between successful samples without increasing the missing-sample count. Correlate the PID with SNAP's active `WKWebView` before termination and again after reload. Require the post-reload PID to stay the same throughout stress and reject excessive gaps between memory samples.

**Fixed in W-03.** HostProof uses a dedicated persistent `WKWebsiteDataStore` with a stable UUID. Runtime verification still needs a disposable simulator or device. Write a distinct `localStorage` value in each build and switch builds in place. Verify each build can read only its own value and that the proof value survives a proof relaunch.

**Automatic Screen Capture in the hosted test plan.** Review the implicit capture setting for the hosted `HostProof` XCTest run in `ios.yml`. W-03 leaves that setting for a later change.

## W-03 signed host proof

**Ground proof loses earlier evidence on exit or retry.** Exit SNAP during checks 1–7 and reopen it, or retry a blocked recovery or stress check. The ground controller loses the completed rows on exit and clears earlier evidence on retry. Persist each completed row and allow the tester to retry the blocked stage directly. [`HostProofGround.swift:132`](../../app/ios/App/App/HostProofGround.swift#L132)
