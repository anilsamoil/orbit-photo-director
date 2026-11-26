# Build the W-01 placeholder

Run the pure Swift package without Xcode.

```sh
swift test --package-path app/OPDKit
```

The package currently has no business API. Its single Swift Testing test proves that the module and test runner load. W-30 adds persistence and sync behavior.

This Mac's Swift 6.4 Command Line Tools can omit the installed Swift Testing macro plugin from a clean build. If the compiler reports `plugin for module 'TestingMacros' not found`, use its supported plugin search option:

```sh
swift test --package-path app/OPDKit \
  -Xswiftc -plugin-path \
  -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing
```

The fresh local build passed with that option. No package dependency or compiler setting is added to OPDKit. The hosted job uses plain `swift test` with full Xcode. [SwiftPM's macro search-path issue](https://github.com/swiftlang/swift-package-manager/issues/8362) describes this plugin directory.

On a Mac with Xcode 26.6 (build 17F113) and the iOS 26.5 Simulator runtime, prepare the static resources and run the launch test.

```sh
python3 app/scripts/prepare-ios.py
DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer \
xcodebuild test -project app/ios/App/App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  -onlyUsePackageVersionsFromResolvedFile \
  -parallel-testing-enabled NO -resultBundlePath /tmp/SNAP-launch.xcresult \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=''
```

Repeat with `platform=iOS Simulator,name=iPad Pro 11-inch (M5),OS=26.5` and a fresh result-bundle path. The preparation script replaces the generated `public/` folder with `www/`, copies `capacitor.config.json` into the app resources, and writes the Cordova `config.xml` with the app identifier. These generated copies are ignored. W-01 has no npm dependency, plugins, remote server URL, signing setup, or Apple account requirement.

The launch test requires the app in the foreground and the visible `SNAP placeholder ready` text inside a WebView. It retains the `SNAP-launch` screenshot as a test attachment. CI uploads the `.xcresult` bundle and the `xcresulttool export attachments` output, including its manifest. A successful run must export a nonempty PNG. A build or simulator failure before the test starts can leave no screenshot.

The hosted workflow runs on the rolling arm64 `macos-26` image, checks the exact Xcode version and build, and saves `ImageOS`, `ImageVersion`, Xcode, Swift and the available simulator runtimes in `ios-environment.txt`. iOS 26.5 is the closest runtime GitHub lists to the orbit devices on iPadOS 26.6.2 and iOS 26.6.1. The M5 iPad simulator is the closest listed model to the 11-inch M4 iPad. G1 and physical-device acceptance have their own proof steps. [GitHub runner image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)

## Template provenance

`ios/` starts from the default SPM template in Capacitor 8.6.2, commit `599fb14bd1ba128b1abc5b2629b9fb1a59bec1be`. `template-provenance.json` records the original paths and Git blob hashes. The bootstrap verified all 20 upstream blobs before decoding them. `CAPACITOR-LICENSE` preserves the upstream MIT license.

The bootstrap copied the pinned template directly. It did not run `cap add ios` or `cap sync ios`. W-01 sets the SNAP display name, `dev.astroanil.snap` app bundle ID, iOS 26.0 minimum and exact Capacitor SPM version 8.6.2. It adds the `dev.astroanil.snap.uitests` target and shared `App` scheme. The AppDelegate and SceneDelegate retain their default behavior.

Only the bundled placeholder is loaded. The existing frontend, Worker, and generator are independent of this skeleton.

## SDK inventory

The app links the local `CapApp-SPM` source package. Its only external dependency is [`capacitor-swift-pm` 8.6.2](https://raw.githubusercontent.com/ionic-team/capacitor-swift-pm/b945758eaf3f034cea377e3138a60611cb40a88b/Package.swift), locked at revision `b945758eaf3f034cea377e3138a60611cb40a88b` in [Package.resolved](ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved). That package declares two binary products and no further package dependencies. Capacitor links Cordova, and Cordova links Apple system libraries. OPDKit has no external dependencies.

| Package or SDK | Version and distribution | Privacy manifest | Vendor signature |
| --- | --- | --- | --- |
| `CapApp-SPM` | Unversioned local source from the 8.6.2 template | None in the source wrapper | Not applicable to the local source wrapper |
| Capacitor | 8.6.2, prebuilt `Capacitor.xcframework` | `PrivacyInfo.xcprivacy` present in device and simulator slices. Both passed plist lint. | Outer XCFramework passed local `codesign --verify --strict` with a Drifty Co. Developer ID signature. Xcode validation pending. |
| Cordova | 8.6.2 Ionic distribution, prebuilt `Cordova.xcframework` | `PrivacyInfo.xcprivacy` present in device and simulator slices. Both passed plist lint. | Outer XCFramework passed local `codesign --verify --strict` with a Drifty Co. Developer ID signature. Xcode validation pending. |

Both published ZIPs matched the SHA-256 checksums in the pinned Swift package manifest. All four inspected privacy manifests declared no tracking, collected data or accessed API types. This Mac has Command Line Tools only. Xcode SDK-origin validation and privacy manifest placement in the selected signed archive remain open for the W-03 check. [Ionic release assets](https://github.com/ionic-team/capacitor-swift-pm/releases/tag/8.6.2) · [Apple's SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/) · [W-03 archive check](../docs/ios/WORK_PLAN.md#sdk-privacy-check-before-upload)
