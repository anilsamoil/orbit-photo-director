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
2. Under **Users and Access → Integrations → App Store Connect API**, check whether API access is approved. If access has never been requested, the Account Holder selects **Request Access**, agrees to the terms and submits the request. If approval is pending, wait for Apple’s approval before creating a key. [App Store Connect API setup](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)
3. Once access is approved, create a team key under **Team Keys** with the permissions needed for automatic provisioning, cloud-managed Apple Distribution signing and upload. Download the key file. Apple shows it once. [Cloud-managed signing permissions](https://developer.apple.com/help/account/certificates/cloud-managed-certificates)

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
- **Ad hoc (W-74).** Before W-03 and G1, privately collect the identifiers of both physical ground devices, including the second device reserved for the W-33 restore. Register both with Apple Developer and include them in the ad hoc provisioning profile. Pair each with a Mac and enable Developer Mode under **Settings → Privacy & Security** before its first W-74 install. Confirm the restart and on-device prompt. Record readiness for both devices without sharing identifiers. If HTTPS installation is unavailable, install the same signed W-74 `.ipa` from a Mac using Device Hub or Apple Configurator. [Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device) · [Registered-device distribution](https://developer.apple.com/documentation/xcode/distributing-apps-to-your-development-devices)

### W-33 development signing and debugger

Approve an owner-controlled Mac on Earth for the W-33 run. This is the Mac that pairs with the physical ground device and attaches Xcode's debugger. As the individual Apple Developer Program Account Holder, sign in to Xcode on that Mac yourself. Select your paid team and enable automatic signing for the SNAP development build. Pair the ground device, enable Developer Mode, and let Xcode register it and create its development provisioning profile. Use Apple Development signing on that Mac. Keep the signing key in its Keychain and record no account or device identifiers. The internal TestFlight invitation gives the tester App Store Connect access only. [Apple account roles](https://developer.apple.com/help/app-store-connect/manage-your-team/overview-of-accounts-and-roles) [Xcode device signing and debugging](https://developer.apple.com/documentation/Xcode/running-your-app-on-simulated-or-physical-devices)

Before G3, launch the candidate's exact source revision on that device from Xcode. Confirm the debugger hits a breakpoint in the refresh submission code and can resume. Record the designated ground Mac's role, the source revision, Apple Development signing, device model and OS, and the redacted attachment result. If this is also the G3 candidate device, finish the development proof before installing and seeding the signed distribution predecessor.

Reserve two compatible physical ground devices that can be erased for the W-33 encrypted-backup restores. Use one to make the backup, then restore it onto both. Arrange access to the matching TestFlight candidate or register both distribution test devices for W-74. Use two disposable test accounts and synthetic data for the backup.

## 4a. Approval for the managed devices

Ask NASA early about packet requirements and timing. After G3 and G6 pass, send W-71's approval packet and the live App Store listing to NASA. Ask NASA to approve and install SNAP on the iPad and iPhone in orbit (G7). The packet covers app behavior, every outbound origin, on-device storage, notification permission and the absence of tracking or third-party analytics.

Review the [draft NASA approval packet](W-71-NASA-APPROVAL-PACKET.md).

Step 8 explains how to publish the App Store listing used for G7.

**Why:** no build reaches orbit without this approval. It may take longer than any code.
**Send back:** anything NASA needs in the packet, and their expected approval time.

## 5. Xcode on the main Mac (optional)

Decide whether Xcode goes on the main generator Mac for simulator work. It needs your Apple ID sign-in once and roughly 20 to 25 GB with a simulator. The agents can finish the setup after that. Install Xcode on the designated W-33 ground Mac for development signing and debugger attachment as described in step 4.

**Why:** with it the agents can run the app in a simulator while they work, which is faster. Without it every app build runs on GitHub's Macs, which works and is slower.
**Send back:** yes or no.

## 6. Approve device access (after the security review of W-20)

When the organizer reports that the device-access design passed its review:

1. Configure the server-only Sign in with Apple credential for enrollment and deletion. Use a private key enabled for Sign in with Apple, its key ID, your Apple Developer Team ID, and the app's client ID (bundle ID). Place the private key in the Worker's secret store yourself. The Worker uses this key to sign the client-secret JWT for Apple's token exchange and revocation endpoints. This is a separate key from the App Store Connect upload key. Send no credential values back to the agents.
2. Approve a Cloudflare Access bypass application for the path `/d/*` on both map hosts and a separate Google enrollment application that admits Google accounts without the website allowlist.
3. Configure the Sign in with Apple server notification endpoint and confirm the audience with W-20. Enable App Attest and confirm production attestation for the signed ground builds and live Worker.
4. Before enabling opt-in Apple recovery email in Settings, configure the delivery path reviewed in W-20. Keep its credentials in the Worker's secret store and send no values back. Apple enrollment and key-based deletion work without this delivery path.
5. Approve the Worker deploy, with first native binding for Apple and Google limited to disposable fixtures until W-60 opens the First binding gate.

For signed enrollment and restore testing, arrange the holder-controlled software credential and a supported physical FIDO2 key to test each offered option. For the first native binding of a migrated website generation or any other existing website generation with private data or grants, have the operator check the holder in person against the migration record or other independent prior evidence of ownership. Approve only that holder's attested enrollment attempt. If the check is unavailable, leave the account on the website. See [the enrollment and recovery contract](ARCHITECTURE.md#signed-out-apple-deletion-recovery).

Device access lets the app sync without the website session cookie. The W-20 security review and owner approval are required before deploy.

## 7. Decisions to send back when convenient

- Choose the alert lead time, the scope (All, Yours, or Launches), and a sleep window. Launch alerts use verified capture windows from the [selected launch feed](ARCHITECTURE.md#alerts).
- If offline Esri layers are needed, confirm permission for the exact sources, prefetch method, and retention. Use the licensed baseline until permission is recorded. See [D-7 and the Esri rights question](../designs/ios-app.md#esri-rights).
- When to start the crew rollout. G5 requires fourteen days of orbit use with no lockout or lost log.

## 7a. Log retention policy

Before W-20 finalizes deletion cleanup and before W-71 publishes the privacy policy, record the deletion scope. Include the deleted profile and the account’s contributions on other profiles. Include both target objects, monthly shot logs, dedupe reservations, their indexes, and recoverable details in upload parts and write records. Use historical provenance where verified. Disclose the treatment of ambiguous legacy records on profiles the account could write to.

Erase associated records by default. For any legally required retention, record the basis, affected records, start event, and exact deadline. Keep retained data outside product reads and erase its keys and values at expiry. Include legacy monthly records and encoded logical destinations.

Before enabling deletion, confirm the inventory of original personal-target imports and derivatives, including bootstrap JSON, spreadsheets, repo copies and operator backups. Record attribution, which copies SNAP controls, and the verified disposition of each. Use only controlled inputs for continued imports. For identifiable roster data, confirm the private inventory records direct collection or explicit consent, permission for the proposed use and a verified contact for withdrawal. Exclude unverified rows and derivatives from imports. Verify the public privacy policy offers a withdrawal contact that people can reach without a SNAP account before admitting identifiable rows. Disclose any historical public copies outside SNAP's erasure control and block them as import or recovery sources. See the [source-copy inventory](ARCHITECTURE.md#personal-target-import-sources).

Send the decision to the organizer to record in `DECISIONS.md`. W-20 implements and verifies the rule. W-71 publishes it.

## 8. App Store listing and releases

### Every candidate

1. Approve the release job when the organizer supplies the candidate. The ground tester installs through TestFlight or W-74 and runs G3.
2. After authenticated W-72 (G2), G3 and W-71's submission checks pass for that candidate, select it in App Store Connect. Choose manual release. Set the Privacy Policy field to the public URL tested in W-71 and verify it matches the in-app link. Provide W-71's reviewer access in Review Notes.

### First listing

1. Choose public distribution. In Review Notes, state that the app is intended for unlisted distribution, then submit to App Review. See Apple's [distribution methods](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods/).
2. Send Apple's unlisted distribution request after submission. After App Review approval and the unlisted decision, release the version. Use the unlisted link if approved or the public listing if declined. [Apple's unlisted distribution instructions](https://developer.apple.com/support/unlisted-app-distribution/) · [Manual release](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option)

### Later versions

Submit the new version to App Review and release after approval. Keep the existing listing and its approved distribution method. Apple carries the approved unlisted method forward to later versions. [Apple's unlisted distribution instructions](https://developer.apple.com/support/unlisted-app-distribution/)

### After each release

Confirm the version is live. The tester installs from the listing over the ground build already on their device, without uninstalling, and checks state and expiry for G6. After G3 and G6 pass, ask NASA to install or update from that listing as in step 4a.

**Why:** NASA installs from the App Store; that is the one route to the orbit devices. App Store builds do not expire. The website stays as the fallback either way.
