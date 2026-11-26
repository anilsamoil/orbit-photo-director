import UIKit
import XCTest

final class HostProofTests: XCTestCase {
    private typealias ProofJSON = [String: Any]

    @MainActor
    func testOfflineHostProof() throws {
        continueAfterFailure = true
        let app = XCUIApplication()
        app.launchArguments = ["--g1-ui-test"]
        let duration = ProcessInfo.processInfo.environment["G1_STRESS_MS"] ?? "600000"
        let durationMs = Int(duration) ?? 0
        app.launchEnvironment = ["G1_STRESS_MS": String(durationMs)]
        app.launch()

        let status = app.staticTexts["g1-status"]
        if app.webViews.firstMatch.staticTexts["SNAP placeholder ready"].waitForExistence(timeout: 3) {
            throw XCTSkip("The W-01 placeholder assets are bundled")
        }

        var results = (1...10).map { row($0, "not-run", "The proof driver did not reach this check") }
        var metadata: ProofJSON = [
            "runtime": UIDevice.current.systemVersion,
            "device": ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? UIDevice.current.model,
            "stressDurationMs": durationMs
        ]
        defer { attachResults(results, metadata: metadata) }

        guard app.wait(for: .runningForeground, timeout: 30),
              app.webViews.firstMatch.waitForExistence(timeout: 30),
              wait(for: "initial-ready", on: status, timeout: 465),
              let initial = read(status)
        else {
            results[0] = row(1, "fail", "The bundled proof did not produce an initial WebView result")
            return XCTFail("The bundled proof did not produce an initial WebView result")
        }

        if let web = initial["web"] as? ProofJSON {
            merge(web["results"], into: &results, allowed: 1...7)
            metadata["web"] = web.filter { $0.key != "results" }
        } else {
            results[0] = row(1, "fail", initial["error"] as? String ?? "Missing initial WebView results")
        }
        capture("map", in: app)
        capture("iss", in: app)

        guard let before = initial["before"] as? ProofJSON,
              let launchID = initial["launchID"] as? String,
              let appPID = initial["appPID"] as? Int else {
            results[7] = row(8, "fail", initial["error"] as? String ?? "Missing persistent storage witness")
            return XCTFail("Missing stored token or first launch identity")
        }

        app.terminate()
        guard app.wait(for: .notRunning, timeout: 30) else {
            results[7] = row(8, "fail", "XCUITest did not observe app termination")
            return XCTFail("XCUITest did not observe app termination")
        }

        let witness = try JSONSerialization.data(withJSONObject: [
            "before": before,
            "launchID": launchID,
            "appPID": appPID,
            "appQuitObserved": true
        ])
        app.launchEnvironment["G1_RELAUNCH_WITNESS"] = witness.base64EncodedString()
        app.launch()

        let lifecycleStatus = app.staticTexts["g1-lifecycle-status"]
        guard app.wait(for: .runningForeground, timeout: 30),
              wait(for: "lifecycle-ready", on: lifecycleStatus, timeout: 225),
              let lifecycle = read(lifecycleStatus)
        else {
            results[7] = row(8, "fail", "The relaunched proof did not produce a lifecycle result")
            return XCTFail("The relaunched proof did not produce a lifecycle result")
        }
        merge(lifecycle["results"], into: &results, allowed: 8...9)
        metadata["native"] = lifecycle.filter { $0.key != "results" }

        let stressTimeout = 120 + Double(min(max(durationMs, 0), 600_000)) / 1_000
        guard wait(for: "complete", on: status, timeout: stressTimeout), let final = read(status) else {
            results[9] = row(10, "fail", "The WebView did not produce a completed stress result")
            return XCTFail("The WebView did not produce a completed stress result")
        }
        merge(final["results"], into: &results, allowed: 10...10)

        for (index, result) in results.enumerated() {
            let id = index + 1
            let status = result["status"] as? String
            XCTAssertEqual(status, "pass", "G1 check \(id): \(result)")
        }
    }

    @MainActor
    private func capture(_ tab: String, in app: XCUIApplication) {
        let screenshotName = "G1-\(tab)"
        let button = app.buttons["g1-\(tab)"]
        guard button.waitForExistence(timeout: 10) else {
            return failWithScreenshot("Missing \(tab) screenshot control", named: screenshotName)
        }
        button.tap()
        guard wait(for: tab, on: app.staticTexts["g1-screenshot-status"], timeout: 35) else {
            return failWithScreenshot("The \(tab) screenshot view did not report readiness", named: screenshotName)
        }
        attachRenderedScreenshot(named: screenshotName)
    }

    @MainActor
    private func wait(for text: String, on element: XCUIElement, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label == %@", text)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    @MainActor
    private func read(_ element: XCUIElement) -> ProofJSON? {
        guard let payload = element.value as? String,
              let object = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? ProofJSON
        else { return nil }
        return object
    }

    private func merge(_ value: Any?, into results: inout [ProofJSON], allowed: ClosedRange<Int>) {
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
