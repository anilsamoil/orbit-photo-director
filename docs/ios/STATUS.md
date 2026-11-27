# Status

Kept by the organizer. Short enough to read on a phone.

Last updated: 2026-11-27

- **G0 device registration unverified.** The developer membership is active, the app record exists, and the three signing secrets were verified in `ios-release` at 17:20 UTC on 2026-11-26. Confirm at least one ground device is registered before dispatch. [Owner steps](OWNER_STEPS.md#4-a-ground-tester)
- **G1 on-device gate OPEN.** Checks 2–5, 9 and 10 and iPad check 7 still need on-device proof before W-03 is complete. [Required device and Safari runs](G1-HOST-PROOF.md#on-device-proof-required)
- **Done:** W-01 merged as #381 (`26746c9`). iOS run 45870433702 passed OPDKit and both iOS 26.5 launches on iPad Pro 11-inch (M5) and iPhone 17 Pro. Both xcresults show Success and both SNAP-launch screenshots were checked. [W-01 verification](W-01-VERIFICATION.md)
- **W-02 merged** as #383 (`cb0bbd2`). Scoped hosted run 45896800677 passed checks 1, 6 and 8 on both simulators and check 7 on iPhone. Each leg marked its remaining checks “not-run (on-device required)”. [Run 45896800677](https://github.com/anilsamoil/orbit-photo-director/actions/runs/45896800677) · [G1 checks](G1-HOST-PROOF.md#checks)
- **W-03 release workflow implemented.** Dispatch, signing, upload and Apple processing are pending. The owner dispatches from `main`, approves signing and assigns the processed build to the internal group. [Release and test steps](G1-HOST-PROOF.md#w-03-ground-device-proof)
- **Plan:** W-00 landed (#373). Release 1 opens on the offline flat map with the bundled baseline, W-43 Earth pack and W-45 detail packs. Both packs are in Wave 2, with W-43 ahead of W-45. G2 requires the offline zoom 8 and zoom 12 checks. W-44 is scheduled after G2 as the first update after release 1 and opens Map on the globe.
- **Owner steps:**
  - Orbit devices. NASA must approve and install the App Store build on the 11-inch iPad Pro with M4 and the iPhone 17 Pro. See [owner step 4a](OWNER_STEPS.md#4a-approval-for-the-managed-devices).
  - Ground delivery. Confirm TestFlight access and run the device matrix after build assignment. [Ground checklist](W-03-GROUND-CHECKLIST.md)
- **Ground build expiry:** no ground build yet.
