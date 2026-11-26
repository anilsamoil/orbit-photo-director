# Status

Kept by the organizer. Short enough to read on a phone.

Last updated: 2026-11-26

- **Gate reached:** none. G0 requires active Apple Developer Program membership, the app record, and the release credentials. G1 (host proof) is open. After G3 and G6 pass, the owner requests installation from the live App Store listing. G7 passes when NASA approves SNAP and installs it on both orbit devices.
- **Shipped:** nothing.
- **In flight:** W-01, unsigned skeleton and hosted workflow. Hosted verification is pending. [W-01 verification](W-01-VERIFICATION.md)
- **Release workflow (W-03, not built yet):** a separate protected job with an Admin-role team key (owner decision 2026-11-26) in the GitHub Actions environment `ios-release`, owner as required reviewer, reading environment secrets `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY`. Those secrets are not installed yet. W-01's workflow uses no secrets.
- **Plan:** W-00 landed (#373). Release 1 opens on the offline flat map with the bundled baseline, W-43 Earth pack and W-45 detail packs. Both packs are in Wave 2, with W-43 ahead of W-45. G2 requires the offline zoom 8 and zoom 12 checks. W-44 is scheduled after G2 as the first update after release 1 and opens Map on the globe.
- **Owner steps:**
  - Orbit devices. NASA must approve and install the App Store build on the 11-inch iPad Pro with M4 and the iPhone 17 Pro. See [owner step 4a](OWNER_STEPS.md#4a-approval-for-the-managed-devices).
  - Signing. Confirm active membership and complete the app record and release credential setup for G0.
  - Ground delivery. Prepare the internal TestFlight route or the W-74 registered-device route before W-03.
- **Ground build expiry:** no ground build yet.
