# Status

Kept by the organizer. Short enough to read on a phone.

Last updated: 2026-11-26

- **Gate reached:** none. G0 requires active Apple Developer Program membership, the app record, and the release credentials. G1 (host proof) is open. After G3 and G6 pass, the owner requests installation from the live App Store listing. G7 passes when NASA approves SNAP and installs it on both orbit devices.
- **Done:** W-01 merged as #381 (`26746c9`). iOS run 45870433702 passed OPDKit and both iOS 26.5 launches on iPad Pro 11-inch (M5) and iPhone 17 Pro. Both xcresults show Success and both SNAP-launch screenshots were checked. [W-01 verification](W-01-VERIFICATION.md)
- **In flight:** W-02 offline host proof. PR and hosted evidence pending. [G1 checks](G1-HOST-PROOF.md)
- **Release workflow (W-03, not built yet):** a separate protected job with an Admin-role team key (owner decision 2026-11-26) in the GitHub Actions environment `ios-release`, owner as required reviewer, reading environment secrets `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY`. Those secrets are not installed yet. W-01's workflow uses no secrets.
- **W-03 next steps.** Before any ground proof distribution, add an in-app launch trigger that runs without XCTest launch arguments and an evidence procedure for relaunch, WebContent termination and memory without the Mac-side `simctl` observer. Then run all ten checks on the signed installed build. W-02 covers checks 1–9 in the simulator and provides indicative evidence for check 10. [Ground-device proof](G1-HOST-PROOF.md#w-03-ground-device-proof)
- **Plan:** W-00 landed (#373). Release 1 opens on the offline flat map with the bundled baseline, W-43 Earth pack and W-45 detail packs. Both packs are in Wave 2, with W-43 ahead of W-45. G2 requires the offline zoom 8 and zoom 12 checks. W-44 is scheduled after G2 as the first update after release 1 and opens Map on the globe.
- **Owner steps:**
  - Orbit devices. NASA must approve and install the App Store build on the 11-inch iPad Pro with M4 and the iPhone 17 Pro. See [owner step 4a](OWNER_STEPS.md#4a-approval-for-the-managed-devices).
  - Signing. Confirm active membership and complete the app record and release credential setup for G0.
  - Ground delivery. Prepare the internal TestFlight route or the W-74 registered-device route before W-03.
- **Ground build expiry:** no ground build yet.
