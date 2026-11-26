// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OPDKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "OPDKit", targets: ["OPDKit"])
    ],
    targets: [
        .target(name: "OPDKit"),
        .testTarget(name: "OPDKitTests", dependencies: ["OPDKit"])
    ]
)
