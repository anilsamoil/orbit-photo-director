import Capacitor
import Darwin
import Network
import UIKit
import WebKit

private typealias ProofJSON = [String: Any]

final class HostProofViewController: CAPBridgeViewController {
    private static let stressDurationMs = 600_000
    // XCTest validates the input and forwards the canonical list of check IDs.
    private let selectedChecks = Set(ProcessInfo.processInfo.environment["G1_CHECKS"].map {
        $0.split(separator: ",").compactMap { Int($0) }
    } ?? Array(1...10))
    private let proofRouter = HostProofRouter()
    private let launchID = UUID().uuidString
    private let proofStatus = UILabel()
    private let screenshotStatus = UILabel()
    private let lifecycleStatus = UILabel()
    private var proofNavigation: HostProofNavigation?
    private var screenshotTask: Task<Void, Never>?

    override func router() -> Router { proofRouter }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        var offlineProxy = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: 1))
        offlineProxy.allowFailover = false
        configuration.websiteDataStore.proxyConfigurations = [offlineProxy]
        return configuration
    }

    override func capacitorDidLoad() {
        guard let bridge, let webView,
              let downstream = webView.navigationDelegate as? WebViewDelegationHandler else {
            preconditionFailure("The host proof requires Capacitor's WebKit delegate")
        }
        let localURL = bridge.config.localURL
        precondition(bridge.config.serverURL == localURL, "The host proof requires the bundled server")
        precondition(
            !bridge.config.getPluginConfig("CapacitorHttp").getBoolean("enabled", false),
            "The Capacitor HTTP asset interceptor must be disabled"
        )

        // Capacitor installs the unfiltered page handler during loadView, before the first navigation.
        let content = webView.configuration.userContentController
        content.removeAllScriptMessageHandlers()
        content.add(HostProofBridgeIngress(downstream: downstream, localURL: localURL), contentWorld: .page, name: "bridge")
        if selectedChecks.isDisjoint(with: [2, 3, 4, 5, 9, 10]) {
            content.addUserScript(WKUserScript(source: "globalThis.__opdG1RenderersDisabled = true;",
                                              injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        bridge.registerPluginInstance(HostProofPlugin(router: proofRouter))
        let navigation = HostProofNavigation(downstream: downstream, localURL: localURL)
        proofNavigation = navigation
        webView.navigationDelegate = navigation
        // Capacitor's default popup delegate can hand URLs off to UIApplication.
        webView.uiDelegate = nil

        if ProcessInfo.processInfo.arguments.contains("--g1-ui-test") {
            navigation.didFinish = { [weak self, weak navigation] in
                navigation?.didFinish = nil
                Task { await self?.runProof() }
            }
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if ProcessInfo.processInfo.arguments.contains("--g1-ui-test") {
            installTestControls()
        }
    }

    private func installTestControls() {
        proofStatus.isAccessibilityElement = true
        proofStatus.accessibilityIdentifier = "g1-status"
        proofStatus.text = "starting"
        screenshotStatus.isAccessibilityElement = true
        screenshotStatus.accessibilityIdentifier = "g1-screenshot-status"
        screenshotStatus.text = "picture"
        lifecycleStatus.isAccessibilityElement = true
        lifecycleStatus.accessibilityIdentifier = "g1-lifecycle-status"
        lifecycleStatus.text = " "

        var views: [UIView] = [proofStatus, lifecycleStatus]
        if selectedChecks.contains(4) || selectedChecks.contains(5) { views.append(screenshotStatus) }
        for (id, tab, title) in [(4, "map", "Proof Map"), (5, "iss", "Proof ISS")] where selectedChecks.contains(id) {
            let button = UIButton(type: .system, primaryAction: UIAction(title: title) { [weak self] _ in
                self?.showForScreenshot(tab)
            })
            button.accessibilityIdentifier = "g1-\(tab)"
            views.append(button)
        }
        let controls = UIStackView(arrangedSubviews: views)
        controls.axis = .horizontal
        controls.alignment = .center
        controls.distribution = .equalSpacing
        controls.spacing = 4
        controls.backgroundColor = .systemBackground
        controls.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            controls.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            controls.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            controls.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
    }

    private func showForScreenshot(_ tab: String) {
        screenshotTask?.cancel()
        screenshotStatus.text = "loading"
        screenshotStatus.accessibilityValue = nil
        screenshotTask = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await web("capture", arguments: [tab])
                guard !Task.isCancelled else { return }
                publish(tab, result, on: screenshotStatus)
            } catch {
                guard !Task.isCancelled else { return }
                publish("\(tab) failed", errorEvidence(error), on: screenshotStatus)
            }
        }
    }

    private func runProof() async {
        let environment = ProcessInfo.processInfo.environment
        if let encoded = environment["G1_RELAUNCH_WITNESS"] {
            let duration = environment["G1_STRESS_MS"] ?? String(Self.stressDurationMs)
            await runAfterRelaunch(encoded, durationMs: Int(duration) ?? 0)
        } else {
            var output: ProofJSON = ["launchID": launchID, "appPID": Int(getpid())]
            if selectedChecks.contains(8) {
                do {
                    output["before"] = try await web("prepareRelaunch")
                } catch {
                    output["storageError"] = errorEvidence(error)
                }
            }
            // Collect bridge and storage evidence before starting a GPU-dependent renderer.
            var results: [ProofJSON] = []
            for id in [1, 6, 7, 2, 3, 4, 5] where selectedChecks.contains(id) {
                results.append(await checked(id) { try await web("runCheck", arguments: [id]) })
            }
            var webOutput: ProofJSON
            do {
                webOutput = try await web("summary")
            } catch {
                webOutput = ["summaryError": errorEvidence(error)]
            }
            webOutput["results"] = results
            webOutput["webProcessTerminations"] = proofNavigation?.terminations ?? 0
            output["web"] = webOutput
            publish("initial-ready", output, on: proofStatus)
        }
    }

    private func runAfterRelaunch(_ encoded: String, durationMs: Int) async {
        var results: [ProofJSON] = []
        if selectedChecks.contains(8) {
            let relaunch = await checked(8) {
                guard let data = Data(base64Encoded: encoded),
                      let arguments = try JSONSerialization.jsonObject(with: data) as? ProofJSON,
                      let before = arguments["before"] as? ProofJSON,
                      let beforeLaunchID = arguments["launchID"] as? String,
                      let beforeAppPID = arguments["appPID"] as? Int, beforeAppPID != Int(getpid()),
                      arguments["appQuitObserved"] as? Bool == true
                else { throw HostProofError("Missing XCUITest quit witness") }
                let witness: ProofJSON = [
                    "beforeLaunchId": beforeLaunchID,
                    "afterLaunchId": launchID,
                    "beforeAppPID": beforeAppPID,
                    "afterAppPID": Int(getpid()),
                    "appQuitObserved": true
                ]
                return try await web("verifyRelaunch", arguments: [before, witness])
            }
            results.append(relaunch)
        }
        let observer = ProofObserver()
        if selectedChecks.contains(9) {
            results.append(await checked(9) { try await verifyRecovery(observer) })
        }
        publish("lifecycle-ready", [
            "results": results,
            "launchID": launchID,
            "appPID": Int(getpid()),
            "offline": [
                "httpProxy": "127.0.0.1:1",
                "proxyFailover": false,
                "nativeBridgeAllowlist": HostProofBridgeIngress.allowedCalls,
                "capacitorHttp": "bridge dispatch and asset interceptor denied",
                "blockedNavigations": proofNavigation?.blockedNavigations ?? 0,
                "localOrigin": bridge?.config.localURL.absoluteString ?? "unknown",
                "tileHandler": "Capacitor WebViewAssetHandler"
            ]
        ], on: lifecycleStatus)
        if selectedChecks.contains(10) {
            let stress = await checked(10) { try await verifyStress(observer, durationMs: durationMs) }
            publish("complete", ["results": [stress]], on: proofStatus)
        }
    }

    private func verifyRecovery(_ observer: ProofObserver) async throws -> ProofJSON {
        guard let proofNavigation else { throw HostProofError("Missing WebKit navigation observer") }
        let before = try await web("select", arguments: ["iss"])
        guard before["tab"] as? String == "tab-iss" else { throw HostProofError("ISS tab not active before termination") }
        let baselineTerminations = proofNavigation.terminations
        let baselineNavigations = proofNavigation.finishes
        let exit = try await observer.request("terminate")
        let deadline = ContinuousClock.now.advanced(by: .seconds(45))
        while proofNavigation.finishes <= baselineNavigations || proofNavigation.terminations <= baselineTerminations {
            guard ContinuousClock.now < deadline else {
                return failure(9, "The Capacitor shell did not observe both termination and reload", evidence: [
                    "process": exit,
                    "terminationCallbacks": proofNavigation.terminations - baselineTerminations,
                    "reloads": proofNavigation.finishes - baselineNavigations
                ])
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        let witness: ProofJSON = [
            "terminationCallbacks": proofNavigation.terminations - baselineTerminations,
            "reloads": proofNavigation.finishes - baselineNavigations,
            "process": exit
        ]
        var result = await checked(9) { try await web("verifyRecovery", arguments: [before, witness]) }
        var evidence = result["evidence"] as? ProofJSON ?? [:]
        evidence["native"] = witness
        result["evidence"] = evidence
        return result
    }

    private func verifyStress(_ observer: ProofObserver, durationMs: Int) async throws -> ProofJSON {
        guard durationMs == Self.stressDurationMs else {
            return failure(10, "Stress requires the full 600000 milliseconds", evidence: ["requestedDurationMs": durationMs])
        }
        guard let proofNavigation else { throw HostProofError("Missing WebKit navigation observer") }
        let baselineTerminations = proofNavigation.terminations
        _ = try await observer.request("memoryStart")
        var result: ProofJSON
        do {
            result = try await web("stress", arguments: [durationMs])
        } catch {
            result = failure(10, evidence: errorEvidence(error))
        }
        var evidence = result["evidence"] as? ProofJSON ?? [:]
        evidence["requestedDurationMs"] = durationMs
        let memory: ProofJSON
        do {
            memory = try await observer.request("memoryStop")
        } catch {
            evidence["memoryError"] = errorEvidence(error)
            return failure(10, evidence["error"] as? String ?? error.localizedDescription, evidence: evidence)
        }
        let terminations = proofNavigation.terminations - baselineTerminations
        evidence["memory"] = memory
        evidence["webProcessTerminations"] = terminations
        evidence["simulatorIsIndicative"] = true
        guard terminations == 0,
              let peak = memory["peakBytes"] as? Int, peak > 0,
              let samples = memory["samples"] as? Int, samples >= 2,
              memory["missingSamples"] as? Int == 0,
              let gap = memory["maxSampleGapMs"] as? Int,
              let allowedGap = memory["maxAllowedSampleGapMs"] as? Int, gap <= allowedGap
        else {
            evidence["memoryError"] = "WebContent ended or memory evidence was incomplete"
            return failure(10, evidence["error"] as? String ?? "WebContent ended or memory evidence was incomplete", evidence: evidence)
        }

        if result["status"] as? String == "pass",
           (evidence["actualDurationMs"] as? Double ?? 0) < Double(durationMs) {
            return failure(10, "WebView did not complete the full 600000 milliseconds", evidence: evidence)
        }
        if result["status"] as? String == "pass",
           (memory["observedDurationMs"] as? Int ?? 0) < durationMs {
            return failure(10, "WebContent RSS was not monitored for the full 600000 milliseconds", evidence: evidence)
        }
        result["evidence"] = evidence
        return result
    }

    private func web(_ operation: String, arguments: [Any] = []) async throws -> ProofJSON {
        guard let webView else { throw HostProofError("The Capacitor web view is missing") }
        if let proofNavigation, proofNavigation.isReloading {
            let deadline = ContinuousClock.now.advanced(by: .seconds(45))
            while proofNavigation.isReloading {
                guard ContinuousClock.now < deadline else { throw HostProofError("WebContent did not reload before \(operation)") }
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        let terminations = proofNavigation?.terminations ?? 0
        let source = """
            try {
                const deadline = performance.now() + 20000;
                while (!window.__opdG1 && performance.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                const proof = window.__opdG1;
                if (!proof) throw new Error('Timed out waiting for the bundled proof entry');
                const result = await proof[operation](...JSON.parse(input));
                if (!result || typeof result !== 'object' || Array.isArray(result)) {
                    throw new Error('Expected a proof result object');
                }
                return JSON.stringify({result, documentId: proof.documentId});
            } catch (error) {
                return JSON.stringify({failure: {
                    error: String(error?.message ?? error),
                    stack: typeof error?.stack === 'string' ? error.stack : undefined
                }});
            }
            """
        let input = try JSONSerialization.data(withJSONObject: arguments)
        let value: Any?
        do {
            value = try await webView.callAsyncJavaScript(source, arguments: [
                "operation": operation,
                "input": String(decoding: input, as: UTF8.self)
            ], in: nil, contentWorld: .page)
        } catch {
            throw WebProofError.webKit(
                error as NSError, operation: operation,
                terminations: (proofNavigation?.terminations ?? 0) - terminations
            )
        }
        guard let json = value as? String,
              let envelope = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? ProofJSON
        else { throw HostProofError("Malformed web proof response for \(operation)") }
        if let failure = envelope["failure"] as? ProofJSON, let message = failure["error"] as? String {
            throw WebProofError.script(message, stack: failure["stack"] as? String, operation: operation)
        }
        guard var result = envelope["result"] as? ProofJSON else {
            throw HostProofError("Missing web proof result for \(operation)")
        }
        if var evidence = result["evidence"] as? ProofJSON, let documentId = envelope["documentId"] as? String {
            evidence["documentId"] = documentId
            result["evidence"] = evidence
        }
        return result
    }

    private func checked(_ id: Int, _ operation: () async throws -> ProofJSON) async -> ProofJSON {
        do { return try await operation() }
        catch { return failure(id, evidence: errorEvidence(error)) }
    }

    private func errorEvidence(_ error: Error) -> ProofJSON {
        if let error = error as? WebProofError { return error.evidence }
        return ["error": error.localizedDescription]
    }

    private func failure(_ id: Int, _ error: String, evidence: ProofJSON = [:]) -> ProofJSON {
        var details = evidence
        details["error"] = error
        return failure(id, evidence: details)
    }

    private func failure(_ id: Int, evidence: ProofJSON) -> ProofJSON {
        ["id": id, "status": "fail", "evidence": evidence]
    }

    private func publish(_ stage: String, _ payload: ProofJSON, on label: UILabel) {
        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            label.accessibilityValue = String(decoding: data, as: UTF8.self)
            label.text = stage
        } catch {
            label.text = "malformed results"
        }
    }
}

private enum WebProofError: Error {
    case script(String, stack: String?, operation: String)
    case webKit(NSError, operation: String, terminations: Int)

    var evidence: ProofJSON {
        switch self {
        case let .script(message, stack, operation):
            var details: ProofJSON = ["error": message, "operation": operation]
            details["stack"] = stack
            return details
        case let .webKit(error, operation, terminations):
            var details: ProofJSON = [
                "error": error.localizedDescription, "operation": operation,
                "webProcessTerminationsDuringCall": terminations
            ]
            guard error.domain == WKErrorDomain else { return details }
            details["wkErrorCode"] = error.code
            let keys = ["WKJavaScriptExceptionMessage", "WKJavaScriptExceptionLineNumber",
                        "WKJavaScriptExceptionColumnNumber", "WKJavaScriptExceptionSourceURL"]
            for key in keys {
                switch error.userInfo[key] {
                case let url as URL: details[key] = url.absoluteString
                case let text as String: details[key] = text
                case let number as NSNumber: details[key] = number
                default: break
                }
            }
            return details
        }
    }
}

private struct HostProofError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private struct ProofObserver {
    func request(_ operation: String) async throws -> ProofJSON {
        let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let command = documents.appendingPathComponent("g1-observer-command.json")
        let response = documents.appendingPathComponent("g1-observer-response.json")
        let requestID = UUID().uuidString
        let data = try JSONSerialization.data(withJSONObject: [
            "id": requestID,
            "operation": operation,
            "appPID": Int(getpid())
        ])
        try data.write(to: command, options: .atomic)
        let deadline = ContinuousClock.now.advanced(by: .seconds(30))
        while ContinuousClock.now < deadline {
            if let data = try? Data(contentsOf: response),
               let object = try? JSONSerialization.jsonObject(with: data) as? ProofJSON,
               object["id"] as? String == requestID {
                if let result = object["result"] as? ProofJSON { return result }
                throw HostProofError(object["error"] as? String ?? "Invalid simulator observer response")
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw HostProofError("Simulator observer timed out on \(operation)")
    }
}
