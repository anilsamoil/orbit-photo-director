# Follow-ups

Real problems found during iOS work that were not fixed in the work package that found them. It serves the app the way `docs/agent/FOLLOWUPS.md` serves the map.

Each entry says what is wrong, where, how to reproduce it, and which work package found it.

## W-02 host proof

Astra round 3 raised these three findings. All are below P1 and remained open at the three-round review cap.

**The exporter accepts incomplete evidence for passing checks.** `app/scripts/export-host-proof.py` accepts any nonempty evidence object for most checks. In a copy of a successful XCTest attachment, replace check 2's evidence with `{"placeholder": true}` and keep its `pass` status. The exporter still marks the row `pass` in `proof-results.json` and `checks.md`. Validate the required evidence for each passing row, including the digest, worker response, bridge receipts and rendered stress timeline. Mark incomplete rows `fail` in both artifacts. XCTest currently asserts the probes, so a false green would require XCTest to pass without the required evidence.

**The process observer can select a WebContent process that belongs to another WebView.** `app/scripts/observe-host-proof.py` identifies the candidate by its shared `launchd_sim` parent. Exercise selection with a synthetic process table where another client owns the sole new WebContent process under that parent. The observer accepts it. Pausing and resuming the sampler during stress can also leave a long gap between successful samples without increasing the missing-sample count. Correlate the PID with SNAP's active `WKWebView` before termination and again after reload. Require the post-reload PID to stay the same throughout stress and reject excessive gaps between memory samples.

**HostProof shares the standard app's persistent WebKit data store.** `HostProofViewController.swift` uses the default persistent `WKWebsiteDataStore` under the same bundle ID and origin as the standard app. Before W-03 distributes the proof, give HostProof a dedicated persistent store using `WKWebsiteDataStore(forIdentifier:)` with a stable UUID. On a disposable simulator, write a distinct `localStorage` key and value in each build and switch builds in place without uninstalling. Verify the proof value survives a proof relaunch and each build can read only its own value.
