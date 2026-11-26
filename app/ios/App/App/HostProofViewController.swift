import Capacitor
import Darwin
import Network
import UIKit
import WebKit

private typealias ProofJSON = [String: Any]

final class HostProofViewController: CAPBridgeViewController {
    private static let stressDurationMs = 600_000
    private let proofRouter = HostProofRouter()
    private let launchID = UUID().uuidString
    private let proofStatus = UILabel()
    private let screenshotStatus = UILabel()
    private let lifecycleStatus = UILabel()
    private var proofNavigation: HostProofNavigation?

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

        let map = UIButton(type: .system, primaryAction: UIAction(title: "Proof Map") { [weak self] _ in
            self?.showForScreenshot("map")
        })
        map.accessibilityIdentifier = "g1-map"
        let iss = UIButton(type: .system, primaryAction: UIAction(title: "Proof ISS") { [weak self] _ in
            self?.showForScreenshot("iss")
        })
        iss.accessibilityIdentifier = "g1-iss"

        let controls = UIStackView(arrangedSubviews: [proofStatus, lifecycleStatus, screenshotStatus, map, iss])
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
        screenshotStatus.text = "loading"
        Task {
            do {
                _ = try await web("return await proof.capture(tab);", arguments: ["tab": tab])
                screenshotStatus.text = tab
            } catch {
                screenshotStatus.text = "picture failed"
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
            do {
                output["web"] = try await web("return await proof.run();")
                output["before"] = try await web("return proof.prepareRelaunch();")
            } catch {
                output["error"] = error.localizedDescription
            }
            publish("initial-ready", output, on: proofStatus)
        }
    }

    private func runAfterRelaunch(_ encoded: String, durationMs: Int) async {
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
            return try await web("return await proof.verifyRelaunch(before, witness);", arguments: [
                "before": before,
                "witness": witness
            ])
        }
        let observer = ProofObserver()
        let recovery = await checked(9) { try await verifyRecovery(observer) }
        publish("lifecycle-ready", [
            "results": [relaunch, recovery],
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
        let stress = await checked(10) { try await verifyStress(observer, durationMs: durationMs) }
        publish("complete", ["results": [stress]], on: proofStatus)
    }

    private func verifyRecovery(_ observer: ProofObserver) async throws -> ProofJSON {
        guard let proofNavigation else { throw HostProofError("Missing WebKit navigation observer") }
        let before = try await web("return await proof.select('iss');")
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
        var result = try await web("return await proof.verifyRecovery(before, witness);", arguments: [
            "before": before,
            "witness": witness
        ])
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
            result = try await web("return await proof.stress(durationMs);", arguments: ["durationMs": durationMs])
        } catch {
            result = failure(10, error.localizedDescription)
        }
        var evidence = result["evidence"] as? ProofJSON ?? [:]
        evidence["requestedDurationMs"] = durationMs
        let memory: ProofJSON
        do {
            memory = try await observer.request("memoryStop")
        } catch {
            return failure(10, error.localizedDescription, evidence: evidence)
        }
        let terminations = proofNavigation.terminations - baselineTerminations
        evidence["memory"] = memory
        evidence["webProcessTerminations"] = terminations
        evidence["simulatorIsIndicative"] = true
        guard terminations == 0,
              let peak = memory["peakBytes"] as? Int, peak > 0,
              let samples = memory["samples"] as? Int, samples >= 2,
              memory["missingSamples"] as? Int == 0
        else { return failure(10, "WebContent ended or memory evidence was incomplete", evidence: evidence) }

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

    private func web(_ body: String, arguments: ProofJSON = [:]) async throws -> ProofJSON {
        guard let webView else { throw HostProofError("The Capacitor web view is missing") }
        let source = """
            const proof = window.__opdG1;
            if (!proof) throw new Error('Bundled proof did not start');
            await proof.ready;
            \(body)
            """
        let value = try await webView.callAsyncJavaScript(source, arguments: arguments, in: nil, contentWorld: .page)
        guard let object = value as? ProofJSON else { throw HostProofError("Malformed web proof response") }
        return object
    }

    private func checked(_ id: Int, _ operation: () async throws -> ProofJSON) async -> ProofJSON {
        do { return try await operation() }
        catch { return failure(id, error.localizedDescription) }
    }

    private func failure(_ id: Int, _ error: String, evidence: ProofJSON = [:]) -> ProofJSON {
        var details = evidence
        details["error"] = error
        return ["id": id, "status": "fail", "evidence": details]
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
