import Capacitor
import WebKit

private func matchesOrigin(_ url: URL?, localURL: URL) -> Bool {
    guard let url else { return false }
    return url.scheme == localURL.scheme && url.host == localURL.host && url.port == localURL.port
}

@MainActor
final class HostProofBridgeIngress: NSObject, WKScriptMessageHandler {
    private static let methods: [String: Set<String>] = [
        "HostProof": ["digest", "request", "tileRequests"],
        "Console": ["log"]
    ]

    static var allowedCalls: [String] {
        methods.flatMap { plugin, names in names.map { "\(plugin).\($0)" } }.sorted()
    }

    private weak var downstream: WebViewDelegationHandler?
    private let localURL: URL

    init(downstream: WebViewDelegationHandler, localURL: URL) {
        self.downstream = downstream
        self.localURL = localURL
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        guard frame.isMainFrame, matchesOrigin(frame.request.url, localURL: localURL),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }

        if type == "js.error" {
            downstream?.userContentController(controller, didReceive: message)
            return
        }

        guard type == "message", let plugin = body["pluginId"] as? String,
              let method = body["methodName"] as? String, let callback = body["callbackId"] as? String,
              callback == "-1" || Self.isCallbackID(callback) else { return }

        if Self.methods[plugin]?.contains(method) == true {
            downstream?.userContentController(controller, didReceive: message)
        } else if callback != "-1" {
            let result: [String: Any] = [
                "callbackId": callback,
                "pluginId": plugin,
                "methodName": method,
                "success": false,
                "save": false,
                "error": ["code": "G1_BRIDGE_DENIED", "message": "Native call disabled for the host proof"]
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: result) else { return }
            let json = String(decoding: data, as: UTF8.self)
            message.webView?.evaluateJavaScript("window.Capacitor.fromNative(\(json));", completionHandler: nil)
        }
    }

    private static func isCallbackID(_ value: String) -> Bool {
        (1...16).contains(value.utf8.count) && value.utf8.allSatisfy { (48...57).contains($0) }
    }
}

@MainActor
final class HostProofNavigation: NSObject, WKNavigationDelegate {
    let downstream: WKNavigationDelegate
    let localURL: URL
    var didFinish: (() -> Void)?
    private(set) var finishes = 0
    private(set) var terminations = 0
    private(set) var blockedNavigations = 0

    init(downstream: WKNavigationDelegate, localURL: URL) {
        self.downstream = downstream
        self.localURL = localURL
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard matchesOrigin(action.request.url, localURL: localURL) else {
            blockedNavigations += 1
            decisionHandler(.cancel)
            return
        }
        if downstream.webView?(webView, decidePolicyFor: action, decisionHandler: decisionHandler) == nil {
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        downstream.webView?(webView, didStartProvisionalNavigation: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        downstream.webView?(webView, didFinish: navigation)
        finishes += 1
        didFinish?()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        downstream.webView?(webView, didFail: navigation, withError: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        downstream.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webView(
        _ webView: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if downstream.webView?(webView, didReceive: challenge, completionHandler: completionHandler) == nil {
            completionHandler(.rejectProtectionSpace, nil)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        terminations += 1
        downstream.webViewWebContentProcessDidTerminate?(webView)
    }
}
