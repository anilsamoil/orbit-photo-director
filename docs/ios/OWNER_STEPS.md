# SNAP for iPhone and iPad: owner steps

Start steps 1 to 4 in parallel with the unsigned work. Steps 2 and 3 complete the signing prerequisites for G0. Step 4 prepares the chosen ground route for W-03.

Agents never create, read or move Apple credentials. Where a step produces a key, the owner places it and no one else sees it.

## 1. The orbit devices

The iPad is an 11-inch iPad Pro with M4 on iPadOS 26.6.2. The iPhone is an iPhone 17 Pro on iOS 26.6.1. Both are managed by NASA: every app needs NASA's approval, NASA installs it, and TestFlight will not be approved. Storage and download size are not constraints; large downloads run overnight. Nothing is installed on these devices by the owner directly.

## 2. Apple Developer Program

Check whether the membership is active at developer.apple.com/account. If not, enroll as an individual. It needs an Apple ID with two-factor sign-in and costs 99 US dollars a year. Enrollment can also be done in the Apple Developer app on an iPhone or iPad.

Confirm to the organizer that the membership is active and the required agreements are current.

## 3. The app record and the key

Register the app identifier in Apple Developer and enable Sign in with Apple. In App Store Connect:

1. Create the app record with that identifier. "SNAP Orbit Photo Director" is a candidate name.
2. Under Users and Access, Integrations, App Store Connect API, create a team key with the permissions needed for automatic provisioning, cloud-managed Apple Distribution signing and upload. Download the key file. Apple shows it once. See [cloud-managed signing permissions](https://developer.apple.com/help/account/certificates/cloud-managed-certificates).

Then on GitHub, in the repository's Settings, Environments: create an environment named `ios-release` and set yourself as its required reviewer. Add these three secrets. W-03 and W-70 read these names:

| Secret | Format, without a value |
| --- | --- |
| `APP_STORE_CONNECT_KEY_ID` | The key ID string |
| `APP_STORE_CONNECT_ISSUER_ID` | The issuer ID UUID |
| `APP_STORE_CONNECT_PRIVATE_KEY` | The full contents of the downloaded `.p8` file, including its header, footer and line breaks |

The key authenticates Xcode on the hosted runner. Xcode provisions the build and signs the export with Apple Distribution. The protected environment requires your approval for release jobs. Share the bundle identifier and app name with the organizer. Keep the key private.

## 4. A ground tester

Arrange a tester on Earth with an iPad on iPadOS 26 if available. An iPhone on iOS 26 can serve as the ground fallback with the simulator checks in G3. The tester runs W-03, G3 and the App Store upgrade at G6. Share only the ground device model, OS version and test outcome in the public records.

- **TestFlight.** Add the tester as an App Store Connect user and include them in an internal tester group. Internal testing can start without Beta App Review.
- **Ad hoc (W-74).** If the tester cannot use TestFlight, privately collect their device identifier, register the device in Apple Developer, and make it available to the ad hoc provisioning profile. Confirm registration to the organizer without sharing the identifier. The tester installs and replaces builds through the W-74 delivery path.

Before G3, arrange a ground device that can run the same-revision development-signed build for W-33. Register it for development provisioning, pair it with Xcode, and enable Developer Mode. If it is also the G3 candidate device, run the development proof before installing and seeding the signed distribution predecessor.

Reserve a second compatible physical ground device that can be erased for the W-33 encrypted-backup restore. Arrange access to the matching TestFlight candidate or register both distribution test devices for W-74. Use only a disposable test account and synthetic data for the backup.

## 4a. Approval for the managed devices

Ask NASA early about packet requirements and timing. After G3 and G6 pass, send W-71's approval packet and the live App Store listing to NASA. Ask NASA to approve and install SNAP on the iPad and iPhone in orbit (G7). The packet covers app behavior, every outbound origin, on-device storage, notification permission and the absence of tracking or third-party analytics.

Step 8 explains how to publish the App Store listing used for G7.

**Why:** no build reaches orbit without this approval. It may take longer than any code.
**Send back:** anything NASA needs in the packet, and their expected approval time.

## 5. Xcode on the Mac (optional)

Decide whether Xcode goes on the Mac on Earth. It needs your Apple ID sign-in once and roughly 20 to 25 GB with a simulator. The agents can finish the setup after that.

**Why:** with it the agents can run the app in a simulator while they work, which is faster. Without it every app build runs on GitHub's Macs, which works and is slower.
**Send back:** yes or no.

## 6. Approve device access (after the security review of W-20)

When the organizer reports that the device-access design passed its review:

1. Configure the server-only Sign in with Apple credential for enrollment and deletion. Use a private key enabled for Sign in with Apple, its key ID, your Apple Developer Team ID, and the app's client ID (bundle ID). Place the private key in the Worker's secret store yourself. The Worker uses this key to sign the client-secret JWT for Apple's token exchange and revocation endpoints. This is a separate key from the App Store Connect upload key. Send no credential values back to the agents.
2. Approve a Cloudflare Access bypass application for the path `/d/*` on both map hosts and a separate Google enrollment application that admits Google accounts without the website allowlist.
3. Approve the Worker deploy.

Device access lets the app sync without the website session cookie. The W-20 security review and owner approval are required before deploy.

## 7. Decisions to send back when convenient

- Alert defaults: how many minutes before a target, which targets (all, yours, launches), and a sleep window with no alerts.
- If offline Esri layers are needed, confirm permission for the exact sources, prefetch method, and retention. Use the licensed baseline until permission is recorded. See [D-7 and the Esri rights question](../designs/ios-app.md#esri-rights).
- When to start the crew rollout. G5 requires fourteen days of orbit use with no lockout or lost log.

## 7a. Log retention policy

Before W-20 finalizes deletion cleanup and before W-71 publishes the privacy policy, decide what happens to a deleted profile's monthly shot logs and canonical dedupe payloads. State what is removed at deletion, what can be retained, and the start event and deadline for any retention period. Include legacy monthly records.

Send the decision to the organizer to record in `DECISIONS.md`. W-20 implements and tests that rule. W-71 publishes the same rule.

## 8. App Store listing and releases

### Every candidate

1. Approve the release job when the organizer supplies the candidate. The ground tester installs through TestFlight or W-74 and runs G3.
2. After authenticated W-72 (G2) and G3 pass for that candidate, select it in App Store Connect. Choose manual release. Set the Privacy Policy field to the public URL tested in W-71 and verify it matches the in-app link. Provide W-71's reviewer access in Review Notes.

### First listing

1. Choose public distribution. In Review Notes, state that the app is intended for unlisted distribution, then submit to App Review. See Apple's [distribution methods](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods/).
2. Send Apple's unlisted distribution request after submission. After App Review approval and the unlisted decision, release the version. Use the unlisted link if approved or the public listing if declined. [Apple's unlisted distribution instructions](https://developer.apple.com/support/unlisted-app-distribution/) · [Manual release](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option)

### Later versions

Submit the new version to App Review and release after approval. Keep the existing listing and its approved distribution method. Apple carries the approved unlisted method forward to later versions. [Apple's unlisted distribution instructions](https://developer.apple.com/support/unlisted-app-distribution/)

### After each release

Confirm the version is live. The tester installs from the listing over the ground build already on their device, without uninstalling, and checks state and expiry for G6. After G3 and G6 pass, ask NASA to install or update from that listing as in step 4a.

**Why:** NASA installs from the App Store; that is the one route to the orbit devices. App Store builds do not expire. The website stays as the fallback either way.
