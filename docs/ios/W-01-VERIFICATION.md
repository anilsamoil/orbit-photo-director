# W-01 verification

The unsigned W-01 skeleton merged as #381 (`26746c9`). Hosted run 45870433702 passed OPDKit Swift Testing and both iOS 26.5 launches. Both xcresults reported Success and the SNAP-launch screenshots were checked. [Hosted iOS run](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45870433702)

## Worktree contents

- `app/ios/` carries forward the Capacitor 8.6.2 SPM template with `dev.astroanil.snap`, the iOS 26.0 deployment target, iPhone and iPad device families, and the shared `App` scheme and `dev.astroanil.snap.uitests` test target.
- `app/www/`, `app/capacitor.config.json` and `app/scripts/prepare-ios.py` supply the bundled placeholder and generate the ignored app resources. `app/OPDKit/` is a pure Swift package for iOS 26 and macOS 26 with one Swift Testing smoke test.
- `app/template-provenance.json`, `app/CAPACITOR-LICENSE` and [the app guide](../../app/README.md) record the template, app identity, license, build commands and [SDK inventory](../../app/README.md#sdk-inventory).
- `.github/workflows/ios.yml` adds the `OPDKit Swift Testing` job and two `SNAP simulator launch` matrix legs. It targets `main` push and pull request events for changes to the app or the workflow, with read-only contents permissions.
- `AGENTS.md` and the iOS README, decisions, status and work plan reflect the skeleton, runner choices, future W-03 release setup and the local CLT workaround.

## Local checks before the implementation commit

These results were recorded on 2026-11-26.

| Check | Result |
| --- | --- |
| `swift test` in `app/OPDKit` | Passed one Swift Testing test in a fresh build using Swift 6.4 CLT and the command below. Plain `swift test` hit the nested sandbox restriction. With temporary caches and nested sandboxing disabled, Swift still needed the installed `TestingMacros` search path. |
| `plutil -lint` and project references | Passed for `project.pbxproj`, `Info.plist` and `IDEWorkspaceChecks.plist`. Verified 51 PBX objects and 73 references, both scheme targets and all six deployment target and device family settings. The scheme is Xcode XML, so `plutil` reports an unknown `Scheme` tag. `xmllint --noout` passed for the scheme, storyboards and generated Cordova XML. |
| `swiftc -frontend -parse` | Passed on the native Swift sources and UI test. Compiling against the iOS SDK and exercising the WebView need the hosted runner. |
| `python3 app/scripts/prepare-ios.py` | Verified byte-for-byte copies, repeat stability, removal of stale resources and rejection of remote configuration before any resource mutation. `git check-ignore` confirmed the three resource copies are ignored and the SPM lock is eligible for tracking. |
| Workflow static checks | Python/PyYAML, `bash -n` and actionlint 1.7.12 passed. Verified main/path filtering, read-only permissions, signing disabled for both destinations, absence of `pull_request_target`, secret references and release environment, and always-attempted result uploads. Mocked tool runs exercised the Xcode version pin and attachment export checks. |
| Upstream pins | Verified the checkout and upload-artifact SHAs against v4.2.2 and v4.6.2 upstream tags. Verified the runner's Xcode path, build and both destinations against GitHub's arm64 image inventory, and checked all 20 provenance hashes against the pinned template's Git tree. |
| `swift package --force-resolved-versions resolve` | A fresh CLT copy of `CapApp-SPM` resolved 8.6.2 and fetched both binary artifacts using the original version 2 lock. The sandbox blocked the default credential provider, so the passing run used `--disable-keychain --disable-netrc` and temporary caches. The lock was byte-identical after resolution. |
| SDK inventory | The single remote package resolves to two binary SDKs, Capacitor and Cordova. Both release ZIP hashes matched the manifest, all four privacy manifests passed `plutil -lint`, and both outer XCFrameworks passed `codesign --verify --strict`. Xcode SDK-origin validation and archive inspection remain open for W-03. |
| Frontend | `bun run typecheck` passed on an isolated copy of the base tree. `node scripts/verify-map-pins.mjs` passed the baseline and all 61 mutations on a separate copy. `bun run test --maxWorkers=2 --minWorkers=1` reported 2,971 passed, 86 failed and 37 skipped. Browser launches failed in this sandbox, which also restricted process and localhost access. |
| Git hygiene | `git diff --check` passed on the pre-commit working tree. The W-01 diff from the base leaves `frontend/`, `worker/`, `generator/` and `.github/workflows/test.yml` unchanged. |

The fresh OPDKit run used temporary caches for the restricted local session.

```sh
cd app/OPDKit
opd_check_dir=$(mktemp -d /private/tmp/opd-w01-swift-testing.XXXXXX)
CLANG_MODULE_CACHE_PATH="$opd_check_dir/clang" \
SWIFTPM_MODULECACHE_OVERRIDE="$opd_check_dir/modules" \
swift test --scratch-path "$opd_check_dir/build" \
  --cache-path "$opd_check_dir/cache" \
  --config-path "$opd_check_dir/config" \
  --security-path "$opd_check_dir/security" --disable-sandbox \
  -Xswiftc -plugin-path \
  -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing
```

## Local checks after Astra round 1

- `git ls-remote` confirmed the release SHAs for checkout v7.0.1 and upload-artifact v7.0.2. The `action.yml` at each SHA declares Node 24.
- actionlint 1.7.12, PyYAML, `bash -n` and `git diff --check` passed. Mocked attachment exports accepted the launch test's named PNG, including Xcode's generated filename suffix, and rejected unrelated PNGs, missing or empty referenced files, and invalid manifests.

## Hosted verification

- Plain `swift test` passed with full Xcode on `macos-26`. The package log and runner metadata are in `opdkit-results-<run>-<attempt>`.
- The unsigned app built and launched on iPad Pro 11-inch (M5) and iPhone 17 Pro using the iOS 26.5 Simulator runtime. The orbit devices use iPadOS 26.6.2 and iOS 26.6.1. The orbit iPad has M4.
- The `ios-launch-results-<device-id>-<run>-<attempt>` artifacts contain both `SNAP-launch.xcresult` bundles and runner metadata. Each `ios-launch-screenshots-<device-id>-<run>-<attempt>` artifact has the `SNAP-launch` PNG named in the attachment manifest for `LaunchTests/testBundledPlaceholderLaunch()`. The device IDs are `ipad-pro-m5` and `iphone-17-pro`.

The SDK-origin check on a selected signed archive belongs to W-03. G1 host proof, offline acceptance and physical-device testing have their own gates.
