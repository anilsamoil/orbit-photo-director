# Status

Kept by the organizer. Short enough to read on a phone.

Last updated: 2026-11-26

- **Gate reached:** none. G0 awaits membership, the app record and release credentials. G1 is OPEN. Checks 2–5, 9 and 10 and iPad check 7 require on-device proof before W-03 completion or shipping.
- **Done:** W-01 merged as #381 (`26746c9`). iOS run 45870433702 passed OPDKit and both iOS 26.5 launches on iPad Pro 11-inch (M5) and iPhone 17 Pro. Both xcresults show Success and both SNAP-launch screenshots were checked. [W-01 verification](W-01-VERIFICATION.md)
- **In flight:** W-02 host proof (PR #383). Hosted scope is set to checks 1, 6 and 8 on both simulators and check 7 on iPhone 17 Pro. The scoped run result is pending. [G1 checks](G1-HOST-PROOF.md#checks)
- **Release workflow (W-03, not built yet):** a separate protected job with an Admin-role team key (owner decision 2026-11-26) in the GitHub Actions environment `ios-release`, owner as required reviewer, reading environment secrets `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY`. Those secrets are not installed yet. W-01's workflow uses no secrets.
- **W-03 next steps.** Add the in-app trigger and evidence procedure before ground distribution. Run all ten checks on the signed app on iPhone 17 Pro, iPad M4 (11-inch) and the 3rd-gen iPad, plus the web-applicable checks in Safari on iPad (proposed matrix). Record the evidence. [Required on-device proof](G1-HOST-PROOF.md#on-device-proof-required)
- **Plan:** W-00 landed (#373). Release 1 opens on the offline flat map with the bundled baseline, W-43 Earth pack and W-45 detail packs. Both packs are in Wave 2, with W-43 ahead of W-45. G2 requires the offline zoom 8 and zoom 12 checks. W-44 is scheduled after G2 as the first update after release 1 and opens Map on the globe.
- **Owner steps:**
  - Orbit devices. NASA must approve and install the App Store build on the 11-inch iPad Pro with M4 and the iPhone 17 Pro. See [owner step 4a](OWNER_STEPS.md#4a-approval-for-the-managed-devices).
  - Signing. Confirm active membership and complete the app record and release credential setup for G0.
  - Ground delivery. Prepare the internal TestFlight route or the W-74 registered-device route before W-03.
- **Ground build expiry:** no ground build yet.
