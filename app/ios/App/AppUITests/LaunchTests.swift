import XCTest

final class LaunchTests: XCTestCase {
    @MainActor
    func testBundledPlaceholderLaunch() {
        continueAfterFailure = true
        let app = XCUIApplication()
        let screenshotName = "SNAP-launch"

        app.launch()
        guard app.wait(for: .runningForeground, timeout: 30) else {
            return failWithScreenshot("SNAP did not reach the foreground", named: screenshotName)
        }
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            return failWithScreenshot("SNAP did not show a WebView", named: screenshotName)
        }
        let placeholder = webView.staticTexts["SNAP placeholder ready"]
        guard placeholder.waitForExistence(timeout: 30) else {
            return failWithScreenshot("The WebView did not show the bundled placeholder", named: screenshotName)
        }
        guard placeholder.wait(for: \.isHittable, toEqual: true, timeout: 30) else {
            return failWithScreenshot("SNAP placeholder ready was not hittable", named: screenshotName)
        }
        guard app.state == .runningForeground else {
            return failWithScreenshot("SNAP left the foreground before screenshot capture", named: screenshotName)
        }
        attachRenderedScreenshot(named: screenshotName, requiresPlaceholder: true)
    }
}
