# iOS app

SNAP on iPhone and iPad is the unsigned Capacitor shell in `app/`. #381 (`26746c9e51b523c0dca4efb25ad7cf5c71429ee2`) is W-01: a skeleton whose WebView shows the bundled placeholder. The app id is `dev.astroanil.snap`. The UI-test id is `dev.astroanil.snap.uitests`. `TARGETED_DEVICE_FAMILY` is `"1,2"`. The deployment target is iOS and iPadOS 26.0. Linux has no Xcode, so this check reads the hosted run for that commit and the tree. `drive all` does not include it.

## Sub-features

- `ios-ci` is the `iOS unsigned` workflow (`.github/workflows/ios.yml`) for the commit. The jobs are `OPDKit Swift Testing`, `SNAP simulator launch (iPhone 17 Pro)`, `SNAP simulator launch (iPad Pro 11-inch (M5))`, `SNAP host proof (iPad Pro 11-inch (M5))`, and `SNAP host proof (iPhone 17 Pro)`.
- `ios-screenshot` is the `SNAP-launch` PNG for `LaunchTests/testBundledPlaceholderLaunch()` on each device. `validate_screenshot(..., launch=True)` rejects a near-blank frame.
- `ios-host-proof` is G1. Hosted CI runs checks 1, 6 and 8 on iPad and checks 1, 6, 7 and 8 on iPhone. Checks 2, 3, 4, 5, 9 and 10, and check 7 on iPad, stay an open on-device gate.
- `ios-security` is `contents: read`, no `pull_request_target`, no `secrets.` expression, 40-character action SHAs, the unsigned `xcodebuild` flags, and no `DEVELOPMENT_TEAM`.
- `ios-privacy` is a tree scan for a team id, a `.p8`, `.p12`, or `.mobileprovision` file, a `/Users/` path, and a personal name.
- `ios-pins` are Capacitor exact `8.6.2`, deployment target `26.0`, and the `macos-26` runner with Xcode 26.6 build `17F113`.
- `ios-test-workflow` keeps the `test` workflow job names. The `paths` lists in `ios.yml` apply only to that workflow.
- `ios-prepare` runs `python3 app/scripts/prepare-ios.py` on Linux, then removes the three generated copies.

## How to get to it (user POV)

- There is no installed build on this machine. On a Mac with Xcode 26.6 the app is the SNAP icon in the iPhone 17 Pro simulator or the iPad Pro 11-inch (M5) simulator, both on iOS 26.5. The first screen is a dark page. The heading is `SNAP placeholder ready`. The line under it is `Orbit Photo Director for iPhone and iPad.`
- From Linux, that screen is the PNG in the hosted run. When the placeholder is in the file, the iPhone heading wraps onto two lines and the iPad heading stays one line. The status bar is the simulator clock, not part of the placeholder. A white PNG is a failed read of this screen.

## Driving it with opd-verify

Preconditions:

- `gh` can read `anilsamoil/orbit-photo-director`. `python3` is on `PATH`.
- The commit under review is the SHA that contains the iOS change. Read the run that already exists for that SHA. Leave the run alone.
- Keep downloads outside the repo. A green `git status --porcelain` follows the prepare step.

- **Hosted run.** `gh run list --commit <sha> --workflow ios.yml --json databaseId,headSha,conclusion,status,url,event`. Use the run whose `headSha` is that commit. `gh run view <run_id> --json conclusion,jobs` lists five jobs on `macos-26`: `OPDKit Swift Testing`, `SNAP simulator launch (iPhone 17 Pro)`, `SNAP simulator launch (iPad Pro 11-inch (M5))`, `SNAP host proof (iPad Pro 11-inch (M5))`, and `SNAP host proof (iPhone 17 Pro)`. A missing run or a failed job is not a pass. A job that is still running is not a pass. This skill does not rerun it and does not cancel it.
- **OPDKit log.** `gh run download <run_id> --name opdkit-results-<run_id>-<attempt>`. `opdkit-test.log` contains `✔ Test "OPDKit module and Swift Testing load" passed` and `Test run with 1 test`. The same log also prints an XCTest suite line `Executed 0 tests`. That line is the empty XCTest runner. The Swift Testing line is the pass. `ios-environment.txt` begins with `ImageOS=macos26`, then `ImageVersion`, then `Xcode 26.6` and `Build version 17F113`. The image version is recorded. The pin is the Xcode version and build.
- **Launch evidence.** Download `ios-launch-results-iphone-17-pro-<run_id>-<attempt>` and `ios-launch-results-ipad-pro-m5-<run_id>-<attempt>`. Each directory holds `SNAP-launch.xcresult`, `ios-build.log`, and `ios-environment.txt`. The environment file's `Destination` is `platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5` or `platform=iOS Simulator,name=iPad Pro 11-inch (M5),OS=26.5`. The build log ends with `** TEST SUCCEEDED **` and records `CODE_SIGNING_ALLOWED = NO`, `CODE_SIGNING_REQUIRED = NO`, and an empty `CODE_SIGN_IDENTITY`.
- **Screenshot.** Download `ios-launch-screenshots-iphone-17-pro-<run_id>-<attempt>` and `ios-launch-screenshots-ipad-pro-m5-<run_id>-<attempt>`. `manifest.json` names `LaunchTests/testBundledPlaceholderLaunch()`. The export step calls `validate_screenshot(png, launch=True)` from `app/scripts/check_ios_screenshot.py`. A pass needs luminance standard deviation at least 6, at least two color clusters, at least 75% dark background near `#101821`, and at least 0.1% light pixels in the center. Open the PNG. The heading is `SNAP placeholder ready`. The iPhone heading wraps. The iPad heading stays one line. #383 closes the white frame from run `45877212976`: that frame now fails the job. Delete the download after the read.
- **Blank-frame pin.** A solid PNG must fail. Write a white RGB PNG outside the repo and run `python3 app/scripts/check_ios_screenshot.py --launch <blank.png>`. Exit is 1. Stderr contains `uniform or near-blank frame (need luminance std-dev >= 6 and at least two color clusters)`. A 64 by 64 white PNG printed `luminance std-dev 0.00, color clusters 1` and raised that error. The mutant is the test in `validate_screenshot`: `if deviation < 6 or distinct < 2`. Removing that test, or changing it so a standard deviation of 0 is accepted, leaves the blank command green. That green command is a dead pin. Do not edit the script from this skill.
- **Host proof.** The `host-proof` matrix sets `g1_checks` to `1,6,8` for iPad Pro 11-inch (M5) and `1,6,7,8` for iPhone 17 Pro. The job env is `TEST_RUNNER_G1_CHECKS`. The export step sets `G1_CHECKS` to the same list. Check 1 is the secure context and SHA-256. Check 6 is the GET, DELETE, POST and PUT bridge. Check 7 is bundled tiles at 50 per second. Check 8 is `localStorage` after relaunch. The artifact is `ios-host-proof-<id>-<run>-<attempt>` with ids `ipad-pro-m5` and `iphone-17-pro`. `checks.md` marks the other rows `not-run (on-device required)`. `docs/ios/DECISIONS.md` line 41 keeps checks 2, 3, 4, 5, 9 and 10, and check 7 on iPad, as an open gate before W-03 can be called done or anything ships. Devices named there are iPhone 17 Pro, iPad M4, the 3rd-gen iPad, and Safari on iPad. A green hosted pair does not close that gate.
- **Host-proof tests.** From the repo root, on Linux:

```bash
node --test app/host-proof/proof.test.mjs
python3 -B app/scripts/test_export_host_proof.py
python3 -B app/scripts/test_observe_host_proof.py
```

`proof.test.mjs` is 17 tests. `test_export_host_proof.py` is 17 tests. `test_observe_host_proof.py` is 6 tests. This pass exited 0 on all three. They do not boot a simulator.
- **Security.** `.github/workflows/ios.yml` sets `permissions` to `contents: read`. `on` is `pull_request` and `push` to `main`. The file has no `pull_request_target` and no `secrets.` expression. Every `uses` is a 40-character SHA: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`, `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9`, and `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6` at bun `1.4.3`. The launch `xcodebuild test` passes `CODE_SIGNING_ALLOWED=NO`, `CODE_SIGNING_REQUIRED=NO`, and `CODE_SIGN_IDENTITY=''`. The host-proof `xcodebuild test` passes `CODE_SIGNING_ALLOWED=NO` and `CODE_SIGNING_REQUIRED=NO`. `app/` and `ios.yml` contain no `DEVELOPMENT_TEAM`.
- **Privacy.** Search `app/` and `ios.yml` for `DEVELOPMENT_TEAM`, a `/Users/` path, and a personal name. Find no `.p8`, `.p12`, or `.mobileprovision` file. #381 had none. A hit stops the pass. Leave the hit out of this skill. The hosted package log names the runner work directory. That path is the Actions runner. It is not a path in the tree.
- **Pins.** `app/ios/App/CapApp-SPM/Package.swift` sets `platforms: [.iOS("26.0")]` and `.package(..., exact: "8.6.2")` for `capacitor-swift-pm`. `app/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` pins identity `capacitor-swift-pm` at version `8.6.2`, revision `b945758eaf3f034cea377e3138a60611cb40a88b`. Every `IPHONEOS_DEPLOYMENT_TARGET` in `project.pbxproj` is `26.0`. Every `TARGETED_DEVICE_FAMILY` is `"1,2"`. The app `PRODUCT_BUNDLE_IDENTIFIER` is `dev.astroanil.snap`. The test target is `dev.astroanil.snap.uitests`. The workflow `runs-on` is `macos-26`, and the selected developer directory is `/Applications/Xcode_26.6.app/Contents/Developer`. The version test is `Xcode 26.6` and `Build version 17F113`.
- **test workflow.** `.github/workflows/test.yml` has no `paths` filter. Its job names stay `Python (generator)`, `Cloudflare Worker`, `Frontend shard ${{ matrix.shard }}` (rendered `Frontend shard 1` and `Frontend shard 2`), and `Frontend`. A push or pull request that only changes `app/` still starts `test`. The `paths` lists in `ios.yml` also name `frontend/src/**`, `frontend/index.html`, `frontend/bun.lock`, `frontend/package.json`, the font, glyph, and coastline assets, `tests/fixtures/iss-2026-11-10.txt`, and `VERSION`. Those lists skip `iOS unsigned` only. They do not skip `test`. On `26746c9e51b523c0dca4efb25ad7cf5c71429ee2` the push started both `iOS unsigned` run `45877212976` and `test` run `45877213080`.
- **Prepare.** From the repo root, `python3 app/scripts/prepare-ios.py` prints `Prepared public and Capacitor configuration`. `app/ios/App/App/public/index.html` matches `app/www/index.html`. `app/ios/App/App/capacitor.config.json` is the bundled config (`appId` `dev.astroanil.snap`, `appName` `SNAP`, `webDir` `www`). `app/ios/App/App/config.xml` is the widget with that app id. Those three paths are gitignored. Remove them in the same turn:

```bash
python3 app/scripts/prepare-ios.py
rm -rf app/ios/App/App/public app/ios/App/App/capacitor.config.json app/ios/App/App/config.xml
```

`git status --porcelain` is empty after the removal. On this pass the copy was byte-identical, the widget id was `dev.astroanil.snap`, and the removal left a clean tree.

## Gotchas

- `swift test` and `xcodebuild` need the macOS runner. A missing Xcode on Linux is the reason this recipe reads CI. It is not a product failure.
- `prepare-ios.py` exits before writing when `app/capacitor.config.json` is anything other than the bundled placeholder. A `server` url or a plugin entry is that failure. `--host-proof` copies `app/host-proof/dist` to `app/ios/App/App/public-proof` and writes `HostProof-Info.plist`. Those paths are gitignored. The standard command still writes `public`, `capacitor.config.json`, and `config.xml`. Remove whichever copies the command wrote.
- The launch export step reads pixels. A white frame fails `validate_screenshot` before the job can pass. The W-01 white iPad PNG is resolved in `follow-ups.md`.
- `bun install --frozen-lockfile` on the host-proof job can fail while resolving the lockfile because DNS does not answer. That failure is infra. Rerun only the failed job, and only with Anil's OK. A DNS miss is not a failed G1 check. This skill does not rerun the workflow.
- `validate_passing_evidence` in `app/scripts/export-host-proof.py` checks evidence content for checks 1, 9, 10, 4 and 5. A passing check 6 or 8 with a nonempty dict is kept. That gap is the W-03 P2 in `follow-ups.md`.
- `docs/designs/ios-app.md` line 91 still describes G1 as a simulator proof followed by the same proof on a ground device. The open gate is `docs/ios/DECISIONS.md` line 41. That stale sentence is the W-03 P3 in `follow-ups.md`. This skill does not edit the design doc.
- The orbit iPad is M4 on iPadOS 26.6.2 and the orbit iPhone is on iOS 26.6.1. The hosted simulators are iPad Pro 11-inch (M5) and iPhone 17 Pro on iOS 26.5. The deployment target stays 26.0. This check does not call that gap a failed launch.
- OPDKit's package log prints `Executed 0 tests` from XCTest and then the Swift Testing pass. Require the Swift Testing line.
- Keep artifact downloads out of the worktree. This skill does not rerun the workflow and does not cancel it.
