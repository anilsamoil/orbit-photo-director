import Darwin
import UIKit

@MainActor
final class HostProofGround {
    private enum Stage { case loading, start, working, relaunch, recovery, stress, complete }

    private unowned let host: HostProofViewController
    private let status = UILabel()
    private let action = UIButton(type: .system)
    private let results = UIButton(type: .system)
    private let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    private var stage = Stage.loading
    private var rows: [ProofJSON] = []
    private var metadata: ProofJSON = [:]
    private var screenshots: ProofJSON = [:]
    private var pendingRelaunch: ProofJSON?

    init(host: HostProofViewController) {
        self.host = host
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.adjustsFontForContentSizeCategory = true
        action.addAction(UIAction { [weak self] _ in self?.advance() }, for: .touchUpInside)
        results.setTitle("Results", for: .normal)
        results.addAction(UIAction { [weak self] _ in self?.showResults() }, for: .touchUpInside)
        let buttons = UIStackView(arrangedSubviews: [action, results])
        buttons.distribution = .fillEqually
        let bar = UIStackView(arrangedSubviews: [status, buttons])
        bar.axis = .vertical
        bar.backgroundColor = .systemBackground
        bar.isLayoutMarginsRelativeArrangement = true
        bar.directionalLayoutMargins = .init(top: 8, leading: 12, bottom: 0, trailing: 12)
        bar.translatesAutoresizingMaskIntoConstraints = false
        host.view.addSubview(bar)
        let safeArea = host.view.safeAreaLayoutGuide
        let minimumButtonHeight = buttons.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        minimumButtonHeight.priority = .defaultHigh
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: safeArea.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: safeArea.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: safeArea.bottomAnchor),
            minimumButtonHeight
        ])
        show(.loading, "Loading the offline proof…")
    }

    func navigationReady() {
        if let folder = try? evidenceFolder(),
           let data = try? Data(contentsOf: folder.appendingPathComponent("proof-results.json")),
           let saved = (try? JSONSerialization.jsonObject(with: data)) as? ProofJSON,
           let savedMetadata = saved["metadata"] as? ProofJSON, savedMetadata["build"] as? String == build,
           let savedRows = saved["results"] as? [ProofJSON], savedRows.count == 10 {
            rows = savedRows
            metadata = savedMetadata
            screenshots = saved["screenshots"] as? ProofJSON ?? [:]
            if let checkpoint = saved["pendingRelaunch"] as? ProofJSON {
                pendingRelaunch = checkpoint
                if checkpoint["launchID"] as? String == host.launchID {
                    show(.relaunch, "Close SNAP from the app switcher, then open it again.")
                } else {
                    show(.working, "Checking storage after relaunch…")
                    Task { await finishRelaunch(checkpoint) }
                }
                return
            }
            if rows[7]["status"] as? String != "not-run" {
                if rows[8]["status"] as? String == "not-run" {
                    show(.recovery, "Prepare the tethered Mac for WebContent recovery.")
                } else if rows[9]["status"] as? String == "not-run" {
                    show(.stress, "Start the WebContent memory trace on the Mac before continuing.")
                } else {
                    show(.complete, "Build \(build). Review and share the proof results.")
                }
                return
            }
        }
        show(.start, "Build \(build). Run the offline host proof.")
    }

    private func show(_ next: Stage, _ message: String) {
        stage = next
        UIApplication.shared.isIdleTimerDisabled = next == .working
        status.text = message
        let title: String
        switch next {
        case .start, .complete: title = "Run Proof"
        case .recovery: title = "Check Recovery"
        case .stress: title = "Start 10-Minute Run"
        case .loading, .working, .relaunch: title = ""
        }
        action.setTitle(title, for: .normal)
        action.isHidden = title.isEmpty
        results.isEnabled = !rows.isEmpty && next != .working
        results.superview?.isHidden = title.isEmpty && !results.isEnabled
    }

    private func advance() {
        switch stage {
        case .start, .complete:
            show(.working, "Running checks 1–7…")
            Task { await runInitial() }
        case .recovery:
            let alert = UIAlertController(title: "WebContent recovery",
                message: "Wait for an actual WebContent process termination while SNAP stays open.",
                preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Arm Recovery", style: .default) { [weak self] _ in
                guard let self else { return }
                self.show(.working, "Preparing the ISS view…")
                Task { await self.runRecovery() }
            })
            alert.addAction(UIAlertAction(title: "Trigger Unavailable", style: .default) { [weak self] _ in
                guard let self else { return }
                self.finishRecovery(self.blocked(9, "A supported WebContent termination trigger was unavailable."))
            })
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            host.present(alert, animated: true)
        case .stress:
            show(.working, "Running Map and ISS for ten minutes. Keep SNAP visible.")
            Task { await runStress() }
        case .loading, .working, .relaunch:
            break
        }
    }

    private func runInitial() async {
        rows = (1...10).map { ["id": $0, "status": "not-run", "evidence": ["reason": "Check has not started"]] }
        metadata = ["build": build, "channel": "signed ground host proof", "osVersion": UIDevice.current.systemVersion,
                    "deviceFamily": UIDevice.current.model]
        screenshots = [:]
        pendingRelaunch = nil
        saveAndShow(.working, "Running checks 1–7…")
        for id in [1, 6, 7, 2, 3, 4, 5] {
            status.text = "Running check \(id)…"
            rows[id - 1] = await host.checked(id) { try await host.web("runCheck", arguments: [id]) }
        }
        metadata["web"] = try? await host.web("summary")
        do {
            let before = try await host.web("prepareRelaunch")
            pendingRelaunch = ["before": before, "launchID": host.launchID, "appPID": Int(getpid())]
            try persist()
            show(.relaunch, "Close SNAP from the app switcher, then open it again.")
        } catch {
            pendingRelaunch = nil
            rows[7] = host.failure(8, "Could not save the relaunch witness", evidence: host.errorEvidence(error))
            saveAndShow(.recovery, "Prepare the tethered Mac for WebContent recovery.")
        }
    }

    private func finishRelaunch(_ checkpoint: ProofJSON) async {
        rows[7] = await host.checked(8) {
            guard let before = checkpoint["before"] as? ProofJSON, let launch = checkpoint["launchID"] as? String,
                  let pid = checkpoint["appPID"] as? Int else { throw HostProofError("Missing relaunch checkpoint") }
            return try await host.verifyRelaunch(before: before, launch: launch, pid: pid,
                                                 observation: "Persisted checkpoint and distinct native process")
        }
        pendingRelaunch = nil
        saveAndShow(.recovery, "Prepare the tethered Mac for WebContent recovery.")
    }

    private func runRecovery() async {
        let result = await host.checked(9) {
            guard let navigation = host.proofNavigation else { throw HostProofError("Missing WebKit navigation observer") }
            let before = try await host.web("select", arguments: ["iss"])
            guard before["tab"] as? String == "tab-iss" else { throw HostProofError("ISS tab is not active") }
            let terminations = navigation.terminations
            let finishes = navigation.finishes
            status.text = "Armed for two minutes. Keep SNAP open while the Mac triggers WebContent termination."
            let deadline = ContinuousClock.now.advanced(by: .seconds(120))
            while navigation.terminations == terminations && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(100))
            }
            guard navigation.terminations > terminations else {
                return blocked(9, "WebKit reported no process termination during the two-minute window.")
            }
            let reloadDeadline = ContinuousClock.now.advanced(by: .seconds(45))
            while navigation.finishes == finishes && ContinuousClock.now < reloadDeadline {
                try await Task.sleep(for: .milliseconds(100))
            }
            let witness: ProofJSON = [
                "terminationCallbacks": navigation.terminations - terminations, "reloads": navigation.finishes - finishes,
                "process": ["observation": "WKNavigationDelegate", "appRequestedTermination": false]
            ]
            guard navigation.finishes > finishes else {
                return host.failure(9, "WebContent terminated but Capacitor did not reload the WebView", evidence: witness)
            }
            return await host.recoveryResult(before: before, witness: witness)
        }
        finishRecovery(result)
    }

    private func finishRecovery(_ row: ProofJSON) {
        rows[8] = row
        saveAndShow(.stress, "Start the WebContent memory trace on the Mac before continuing.")
    }

    private func runStress() async {
        let duration = HostProofViewController.stressDurationMs
        rows[9] = blocked(10, "The stress run did not complete.")
        saveAndShow(.working, "Running Map and ISS for ten minutes. Keep SNAP visible.")
        let baseline = host.proofNavigation?.terminations ?? 0
        let result = await host.checked(10) { try await host.web("stress", arguments: [duration]) }
        var evidence = result["evidence"] as? ProofJSON ?? [:]
        let terminations = (host.proofNavigation?.terminations ?? 0) - baseline
        evidence["webProcessTerminations"] = terminations
        evidence["simulatorIsIndicative"] = false
        if terminations != 0 || result["status"] as? String != "pass" {
            rows[9] = host.failure(10, evidence["error"] as? String ?? "WebContent terminated during stress", evidence: evidence)
        } else {
            evidence["renderingStatus"] = "pass"
            evidence["memory"] = ["status": "external evidence required", "source": "tethered Mac"]
            rows[9] = blocked(10, "Attach the full WebContent resident memory trace to complete check 10.", evidence: evidence)
        }
        saveAndShow(.complete, "Build \(build). Review and share the proof results.")
    }

    private func blocked(_ id: Int, _ reason: String, evidence: ProofJSON = [:]) -> ProofJSON {
        var details = evidence
        details["reason"] = reason
        return ["id": id, "status": "blocked", "evidence": details]
    }

    private func evidenceFolder() throws -> URL {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                   appropriateFor: nil, create: true)
        let folder = support.appendingPathComponent("HostProof", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    @discardableResult
    private func persist() throws -> URL {
        var payload: ProofJSON = ["metadata": metadata, "results": rows, "screenshots": screenshots]
        payload["pendingRelaunch"] = pendingRelaunch
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        let url = try evidenceFolder().appendingPathComponent("proof-results.json")
        try data.write(to: url, options: .atomic)
        return url
    }

    private func saveAndShow(_ next: Stage, _ message: String) {
        do {
            try persist()
            show(next, message)
        } catch {
            show(next, "Could not save proof results. \(message)")
        }
    }

    private func showScreenshotFrame(_ tab: String) async {
        show(.working, "Preparing the \(tab.uppercased()) frame…")
        do {
            screenshots[tab] = try await host.web("capture", arguments: [tab])
            saveAndShow(.complete, "Frame ready. Take a device screenshot for G1-\(tab).")
        } catch {
            screenshots[tab] = host.errorEvidence(error)
            saveAndShow(.complete, "Could not prepare the \(tab.uppercased()) frame.")
        }
    }

    private func showResults() {
        let controller = UIViewController()
        controller.title = "Proof Results"
        let text = UITextView()
        text.isEditable = false
        text.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        let summary = rows.map { "Check \($0["id"] ?? "?"): \($0["status"] ?? "unknown")" }.joined(separator: "\n")
        var items: [UIBarButtonItem] = []
        if let url = try? persist(), let data = try? Data(contentsOf: url) {
            text.text = summary + "\n\n" + String(decoding: data, as: UTF8.self)
            let shareButton = UIBarButtonItem(title: "Share", primaryAction: UIAction { [weak controller] _ in
                guard let controller else { return }
                let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                share.popoverPresentationController?.barButtonItem = controller.navigationItem.rightBarButtonItem
                controller.present(share, animated: true)
            })
            items.append(shareButton)
        } else {
            text.text = summary + "\n\nCould not write the export file."
        }
        if stage == .complete {
            let frames = [("Map", "map"), ("ISS", "iss")].map { (title, tab) in
                UIAction(title: title) { [weak self, weak controller] _ in
                    controller?.dismiss(animated: true) {
                        guard let self else { return }
                        Task { await self.showScreenshotFrame(tab) }
                    }
                }
            }
            items.append(UIBarButtonItem(title: "Screenshots", menu: UIMenu(children: frames)))
        }
        controller.navigationItem.rightBarButtonItems = items
        controller.view = text
        controller.navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Done", primaryAction: UIAction { [weak controller] _ in
            controller?.dismiss(animated: true)
        })
        host.present(UINavigationController(rootViewController: controller), animated: true)
    }
}
