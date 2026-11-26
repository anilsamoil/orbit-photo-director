# iOS app

SNAP on iPhone and iPad is the unsigned Capacitor shell in `app/`. #381 (`26746c9e51b523c0dca4efb25ad7cf5c71429ee2`) is W-01: a skeleton whose WebView shows the bundled placeholder. The app id is `dev.astroanil.snap`. The UI-test id is `dev.astroanil.snap.uitests`. `TARGETED_DEVICE_FAMILY` is `"1,2"`. The deployment target is iOS and iPadOS 26.0. Linux has no Xcode, so this check reads the hosted run for that commit and the tree. `drive all` does not include it.

## Sub-features

- `ios-ci` is the `iOS unsigned` workflow (`.github/workflows/ios.yml`) for the commit. The jobs are `OPDKit Swift Testing`, `SNAP simulator launch (iPhone 17 Pro)`, and `SNAP simulator launch (iPad Pro 11-inch (M5))`.
- `ios-screenshot` is the nonempty `SNAP-launch` PNG for `LaunchTests/testBundledPlaceholderLaunch()` on each device. The heading is `SNAP placeholder ready`.
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

- **Hosted run.** `gh run list --commit <sha> --workflow ios.yml --json databaseId,headSha,conclusion,status,url,event`. Use the run whose `headSha` is that commit. `gh run view <run_id> --json conclusion,jobs` lists three successful jobs: `OPDKit Swift Testing`, `SNAP simulator launch (iPhone 17 Pro)`, and `SNAP simulator launch (iPad Pro 11-inch (M5))`. Each job's runner label is `macos-26`. A missing run, a failed job, or a job that is still running is not a pass.
- **OPDKit log.** `gh run download <run_id> --name opdkit-results-<run_id>-<attempt>`. `opdkit-test.log` contains `✔ Test "OPDKit module and Swift Testing load" passed` and `Test run with 1 test`. The same log also prints an XCTest suite line `Executed 0 tests`. That line is the empty XCTest runner. The Swift Testing line is the pass. `ios-environment.txt` begins with `ImageOS=macos26`, then `ImageVersion`, then `Xcode 26.6` and `Build version 17F113`. The image version is recorded. The pin is the Xcode version and build.
- **Launch evidence.** Download `ios-launch-results-iphone-17-pro-<run_id>-<attempt>` and `ios-launch-results-ipad-pro-m5-<run_id>-<attempt>`. Each directory holds `SNAP-launch.xcresult`, `ios-build.log`, and `ios-environment.txt`. The environment file's `Destination` is `platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5` or `platform=iOS Simulator,name=iPad Pro 11-inch (M5),OS=26.5`. The build log ends with `** TEST SUCCEEDED **` and records `CODE_SIGNING_ALLOWED = NO`, `CODE_SIGNING_REQUIRED = NO`, and an empty `CODE_SIGN_IDENTITY`.
- **Screenshot.** Download `ios-launch-screenshots-iphone-17-pro-<run_id>-<attempt>` and `ios-launch-screenshots-ipad-pro-m5-<run_id>-<attempt>`. `manifest.json` is a list. The entry's `testIdentifier` is `LaunchTests/testBundledPlaceholderLaunch()`. Its attachment `suggestedHumanReadableName` matches `SNAP-launch` plus Xcode's `_0_<UUID>.png` suffix. `exportedFileName` is a different UUID and ends in `.png`. The workflow's export step accepts any nonempty file. Open the PNG. A pass shows `SNAP placeholder ready` and `Orbit Photo Director for iPhone and iPad.` on the dark page (`#101821`). When that page is present, the iPhone heading wraps onto two lines and the iPad heading stays one line. A white frame is not a pass. On `26746c9e51b523c0dca4efb25ad7cf5c71429ee2` run `45877212976`, the iPhone PNG shows the heading and the iPad PNG is a 1668 by 2420 white frame. The job still succeeded. Delete the download after the read.
- **Security.** `.github/workflows/ios.yml` sets `permissions` to `contents: read`. `on` is `pull_request` and `push` to `main`, each limited to `app/**` and `.github/workflows/ios.yml`. The file has no `pull_request_target` and no `secrets.` expression. The two `uses` values are `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` and `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9`. Each SHA is 40 hex characters. The `xcodebuild test` step passes `CODE_SIGNING_ALLOWED=NO`, `CODE_SIGNING_REQUIRED=NO`, and `CODE_SIGN_IDENTITY=''`. `app/` and `ios.yml` contain no `DEVELOPMENT_TEAM`.
- **Privacy.** Search `app/` and `ios.yml` for `DEVELOPMENT_TEAM`, a `/Users/` path, and a personal name. Find no `.p8`, `.p12`, or `.mobileprovision` file. #381 had none. A hit stops the pass. Leave the hit out of this skill. The hosted package log names the runner work directory. That path is the Actions runner. It is not a path in the tree.
- **Pins.** `app/ios/App/CapApp-SPM/Package.swift` sets `platforms: [.iOS("26.0")]` and `.package(..., exact: "8.6.2")` for `capacitor-swift-pm`. `app/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` pins identity `capacitor-swift-pm` at version `8.6.2`, revision `b945758eaf3f034cea377e3138a60611cb40a88b`. Every `IPHONEOS_DEPLOYMENT_TARGET` in `project.pbxproj` is `26.0`. Every `TARGETED_DEVICE_FAMILY` is `"1,2"`. The app `PRODUCT_BUNDLE_IDENTIFIER` is `dev.astroanil.snap`. The test target is `dev.astroanil.snap.uitests`. The workflow `runs-on` is `macos-26`, and the selected developer directory is `/Applications/Xcode_26.6.app/Contents/Developer`. The version test is `Xcode 26.6` and `Build version 17F113`.
- **test workflow.** `.github/workflows/test.yml` has no `paths` filter. Its job names stay `Python (generator)`, `Cloudflare Worker`, `Frontend shard ${{ matrix.shard }}` (rendered `Frontend shard 1` and `Frontend shard 2`), and `Frontend`. A push or pull request that only changes `app/` still starts `test`. The `paths` lists in `ios.yml` skip `iOS unsigned` when neither `app/**` nor that workflow file changed. They do not skip `test`. On `26746c9e51b523c0dca4efb25ad7cf5c71429ee2` the push started both `iOS unsigned` run `45877212976` and `test` run `45877213080`.
- **Prepare.** From the repo root, `python3 app/scripts/prepare-ios.py` prints `Prepared bundled placeholder and Capacitor configuration`. `app/ios/App/App/public/index.html` matches `app/www/index.html`. `app/ios/App/App/capacitor.config.json` is the bundled config (`appId` `dev.astroanil.snap`, `appName` `SNAP`, `webDir` `www`). `app/ios/App/App/config.xml` is the widget with that app id. Those three paths are gitignored. Remove them in the same turn:

```bash
python3 app/scripts/prepare-ios.py
rm -rf app/ios/App/App/public app/ios/App/App/capacitor.config.json app/ios/App/App/config.xml
```

`git status --porcelain` is empty after the removal. On this pass the copy was byte-identical, the widget id was `dev.astroanil.snap`, and the removal left a clean tree.

## Gotchas

- `swift test` and `xcodebuild` need the macOS runner. A missing Xcode on Linux is the reason this recipe reads CI. It is not a product failure.
- `docs/ios/STATUS.md` line 9 and `docs/ios/W-01-VERIFICATION.md` line 3 still say hosted verification is pending. That wording is deferred to W-02. This skill does not edit those files. A green hosted run leaves the sentences in place. The queue entry is in `follow-ups.md`.
- `project.pbxproj` line 248 sets the template `CODE_SIGN_IDENTITY = "iPhone Developer"` on the Debug project configuration. The Release project configuration repeats that string. The hosted test overrides it with an empty identity and signing disabled. Clearing the template value is W-02. The string is not a team id.
- `prepare-ios.py` exits before writing when `app/capacitor.config.json` is anything other than the bundled placeholder. A `server` url or a plugin entry is that failure.
- The screenshot upload uses `if-no-files-found: warn`. The export step checks that the PNG exists and is nonempty. It does not read the pixels. A green `SNAP simulator launch` job can attach a white frame. On run `45877212976` the iPad PNG is that white frame, while the iPhone PNG shows the placeholder and the test log ends with `** TEST SUCCEEDED **`. The pull-request run `45870433702` attached an iPad PNG that shows the placeholder. Open both files. A white frame stays a failed screenshot check. This skill does not rerun the job. The note is in `follow-ups.md`.
- The orbit iPad is M4 on iPadOS 26.6.2 and the orbit iPhone is on iOS 26.6.1. The hosted simulators are iPad Pro 11-inch (M5) and iPhone 17 Pro on iOS 26.5. The deployment target stays 26.0. This check does not call that gap a failed launch.
- OPDKit's package log prints `Executed 0 tests` from XCTest and then the Swift Testing pass. Require the Swift Testing line.
- Keep artifact downloads out of the worktree. This skill does not rerun the workflow and does not cancel it.
