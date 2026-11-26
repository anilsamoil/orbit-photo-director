import XCTest

final class LaunchTests: XCTestCase {
    @MainActor
    func testBundledPlaceholderLaunch() {
        continueAfterFailure = true
        let app = XCUIApplication()
        defer {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "SNAP-launch"
            attachment.lifetime = .keepAlways
            add(attachment)
        }

        app.launch()
        guard app.wait(for: .runningForeground, timeout: 30) else {
            return XCTFail("SNAP did not reach the foreground")
        }
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            return XCTFail("SNAP did not show a WebView")
        }
        let placeholder = webView.staticTexts["SNAP placeholder ready"]
        guard placeholder.waitForExistence(timeout: 30) else {
            return XCTFail("The WebView did not show the bundled placeholder")
        }
        XCTAssertTrue(placeholder.isHittable)
        XCTAssertEqual(app.state, .runningForeground)
    }
}
