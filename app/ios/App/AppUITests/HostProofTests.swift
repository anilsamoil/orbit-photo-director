import UIKit
import XCTest

final class HostProofTests: XCTestCase {
    private typealias ProofJSON = [String: Any]

    @MainActor
    func testOfflineHostProof() throws {
        continueAfterFailure = true
        let allChecks = 1...10
        let environment = ProcessInfo.processInfo.environment
        let selected: Set<Int>
        if let input = environment["G1_CHECKS"] {
            let values = input.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            let checks = allChecks.filter { values.contains(String($0)) }
            guard Set(values) == Set(checks.map { String($0) }) else {
                return XCTFail("G1_CHECKS must contain comma-separated check IDs from 1 through 10")
            }
            selected = Set(checks)
        } else {
            selected = Set(allChecks)
        }
        let app = XCUIApplication()
        app.launchArguments = ["--g1-ui-test"]
        let duration = environment["G1_STRESS_MS"] ?? "600000"
        let durationMs = selected.contains(10) ? (Int(duration) ?? 0) : 0
        app.launchEnvironment = [
            "G1_STRESS_MS": String(durationMs),
            "G1_CHECKS": selected.sorted().map { String($0) }.joined(separator: ",")
        ]
        app.launch()

        var results: [ProofJSON] = allChecks.map { id in
            if selected.contains(id) { return row(id, "not-run", "The proof driver did not reach this check") }
            return ["id": id, "status": "not-run", "evidence": [
                "reason": "Requires on-device proof before W-03 can be called done",
                "gate": "G1-device"
            ]]
        }
        var metadata: ProofJSON = [
            "runtime": UIDevice.current.systemVersion,
            "device": environment["SIMULATOR_DEVICE_NAME"] ?? UIDevice.current.model,
            "stressDurationMs": durationMs
        ]
        defer {
            attachResults(results, metadata: metadata)
            for id in selected.sorted() {
                let result = results[id - 1]
                XCTAssertEqual(result["status"] as? String, "pass", "G1 check \(id): \(result)")
            }
        }

        if app.webViews.firstMatch.staticTexts["SNAP placeholder ready"].waitForExistence(timeout: 3) {
            let error = "The W-01 placeholder assets are bundled"
            for id in selected {
                results[id - 1] = row(id, "fail", error)
            }
            return XCTFail(error)
        }

        let status = app.staticTexts["g1-status"]
        let initialChecks = selected.intersection(1...7)
        guard app.wait(for: .runningForeground, timeout: 30),
              app.webViews.firstMatch.waitForExistence(timeout: 30),
              wait(for: "initial-ready", on: status, timeout: 465),
              let initial = read(status)
        else {
            if let id = initialChecks.min() {
                results[id - 1] = row(id, "fail", "The bundled proof did not produce an initial WebView result")
            }
            return XCTFail("The bundled proof did not produce an initial WebView result")
        }

        if let web = initial["web"] as? ProofJSON {
            merge(web["results"], into: &results, allowed: initialChecks)
            metadata["web"] = web.filter { $0.key != "results" }
        } else if let id = initialChecks.min() {
            results[id - 1] = row(id, "fail", "Missing initial WebView results")
        }
        var screenshots: ProofJSON = [:]
        if selected.contains(4) { screenshots["map"] = capture("map", in: app) }
        if selected.contains(5) { screenshots["iss"] = capture("iss", in: app) }
        if !screenshots.isEmpty { metadata["screenshots"] = screenshots }

        guard let firstRelaunchCheck = selected.intersection(8...10).min() else { return }
        var witness: ProofJSON = [:]
        if selected.contains(8) {
            guard let before = initial["before"] as? ProofJSON,
                  let launchID = initial["launchID"] as? String,
                  let appPID = initial["appPID"] as? Int else {
                results[7] = failedRow(8, initial["storageError"], fallback: "Missing persistent storage witness")
                return XCTFail("Missing stored token or first launch identity")
            }
            witness = ["before": before, "launchID": launchID, "appPID": appPID]
        }
        app.terminate()
        guard app.wait(for: .notRunning, timeout: 30) else {
            results[firstRelaunchCheck - 1] = row(firstRelaunchCheck, "fail", "XCUITest did not observe app termination")
            return XCTFail("XCUITest did not observe app termination")
        }

        witness["appQuitObserved"] = true
        let witnessData = try JSONSerialization.data(withJSONObject: witness)
        app.launchEnvironment["G1_RELAUNCH_WITNESS"] = witnessData.base64EncodedString()
        app.launch()

        let lifecycleStatus = app.staticTexts["g1-lifecycle-status"]
        guard app.wait(for: .runningForeground, timeout: 30),
              wait(for: "lifecycle-ready", on: lifecycleStatus, timeout: 225),
              let lifecycle = read(lifecycleStatus)
        else {
            results[firstRelaunchCheck - 1] = row(firstRelaunchCheck, "fail", "The relaunched proof did not produce a lifecycle result")
            return XCTFail("The relaunched proof did not produce a lifecycle result")
        }
        merge(lifecycle["results"], into: &results, allowed: selected.intersection(8...9))
        metadata["native"] = lifecycle.filter { $0.key != "results" }

        guard selected.contains(10) else { return }
        let stressTimeout = 120 + Double(min(max(durationMs, 0), 600_000)) / 1_000
        guard wait(for: "complete", on: status, timeout: stressTimeout), let final = read(status) else {
            results[9] = row(10, "fail", "The WebView did not produce a completed stress result")
            return XCTFail("The WebView did not produce a completed stress result")
        }
        merge(final["results"], into: &results, allowed: [10])
    }

    @MainActor
    private func capture(_ tab: String, in app: XCUIApplication) -> ProofJSON {
        let screenshotName = "G1-\(tab)"
        let button = app.buttons["g1-\(tab)"]
        let status = app.staticTexts["g1-screenshot-status"]
        guard button.waitForExistence(timeout: 10) else {
            let error = "Missing \(tab) screenshot control"
            failWithScreenshot(error, named: screenshotName)
            return ["error": error]
        }
        button.tap()
        // Match the response to this capture, including failures from the WebView.
        let predicate = NSPredicate(format: "label == %@ OR label == %@", tab, "\(tab) failed")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: status)
        _ = XCTWaiter.wait(for: [expectation], timeout: 115)
        guard status.exists, status.label == tab else {
            let evidence = read(status) ?? ["error": "The \(tab) screenshot view did not report readiness"]
            failWithScreenshot("The \(tab) screenshot failed: \(evidence)", named: screenshotName)
            return evidence
        }
        attachRenderedScreenshot(named: screenshotName)
        return read(status) ?? [:]
    }

    @MainActor
    private func wait(for text: String, on element: XCUIElement, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label == %@", text)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    @MainActor
    private func read(_ element: XCUIElement) -> ProofJSON? {
        guard element.exists, let payload = element.value as? String,
              let object = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? ProofJSON
        else { return nil }
        return object
    }

    private func merge(_ value: Any?, into results: inout [ProofJSON], allowed: Set<Int>) {
        var seen = Set<Int>()
        guard let rows = value as? [ProofJSON] else {
            return XCTFail("Missing G1 checks \(allowed)")
        }
        for row in rows {
            guard let id = row["id"] as? Int, allowed.contains(id), seen.insert(id).inserted,
                  row["status"] is String, row["evidence"] is ProofJSON else {
                XCTFail("Unexpected G1 result \(row)")
                continue
            }
            results[id - 1] = row
        }
    }

    private func row(_ id: Int, _ status: String, _ message: String) -> ProofJSON {
        ["id": id, "status": status, "evidence": ["error": message]]
    }

    private func failedRow(_ id: Int, _ evidence: Any?, fallback: String) -> ProofJSON {
        ["id": id, "status": "fail", "evidence": evidence as? ProofJSON ?? ["error": fallback]]
    }

    private func attachResults(_ results: [ProofJSON], metadata: ProofJSON) {
        do {
            let bytes = try JSONSerialization.data(withJSONObject: [
                "results": results,
                "metadata": metadata
            ], options: [.prettyPrinted, .sortedKeys])
            let attachment = XCTAttachment(data: bytes, uniformTypeIdentifier: "public.json")
            attachment.name = "G1-proof-results"
            attachment.lifetime = .keepAlways
            add(attachment)
        } catch {
            XCTFail("Could not encode the G1 result attachment: \(error)")
        }
    }
}
