import Capacitor
import CoreFoundation
import CryptoKit
import Foundation

final class HostProofRouter: Router {
    private var standard = CapacitorRouter()
    private let lock = NSLock()
    private var tilePaths: [String] = []

    var basePath: String {
        get { standard.basePath }
        set { standard.basePath = newValue }
    }

    func route(for path: String) -> String {
        if path.hasPrefix("/__g1/tiles/") {
            lock.withLock { tilePaths.append(path) }
        }
        return standard.route(for: path)
    }

    func tileRequests() -> [String] {
        lock.withLock { tilePaths }
    }
}

@objc(HostProofPlugin)
final class HostProofPlugin: CAPInstancePlugin, CAPBridgedPlugin {
    let identifier = "HostProofPlugin"
    let jsName = "HostProof"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "digest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tileRequests", returnType: CAPPluginReturnPromise)
    ]

    let proofRouter: HostProofRouter

    init(router: HostProofRouter) {
        proofRouter = router
        super.init()
    }

    @objc func digest(_ call: CAPPluginCall) {
        guard let bytes = bytes(call.options["bytes"]) else {
            return call.reject("Invalid digest byte array")
        }
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        call.resolve(["digest": digest])
    }

    @objc func request(_ call: CAPPluginCall) {
        let paths = [
            "GET": "/manifest.json",
            "POST": "/api/log",
            "PUT": "/api/browser/profiles/g1-fixture/targets",
            "DELETE": "/api/browser/profiles/g1-fixture/targets/g1-synthetic"
        ]
        guard let method = call.getString("method"),
              let path = call.getString("path"), paths[method] == path,
              let headers = call.options["headers"] as? [String: String] else {
            return call.reject("Invalid fixture route or headers")
        }

        var receipt: [String: Any] = ["method": method, "path": path, "headers": headers]
        if method == "GET" || method == "DELETE" {
            guard call.options["body"] == nil else {
                return call.reject("Bodyless fixture route received a body")
            }
        } else {
            guard let body = bytes(call.options["body"]), !body.isEmpty else {
                return call.reject("Invalid fixture body byte array")
            }
            receipt["body"] = body.map(Int.init)
        }
        call.resolve(receipt)
    }

    @objc func tileRequests(_ call: CAPPluginCall) {
        call.resolve(["paths": proofRouter.tileRequests()])
    }

    private func bytes(_ value: Any?) -> Data? {
        guard let values = value as? [NSNumber], values.count <= 65_536 else { return nil }
        var result = Data(capacity: values.count)
        for value in values {
            guard CFGetTypeID(value) != CFBooleanGetTypeID(),
                  let byte = UInt8(exactly: value.doubleValue) else { return nil }
            result.append(byte)
        }
        return result
    }
}
