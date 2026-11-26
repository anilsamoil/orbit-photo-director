# W-71 NASA approval packet (DRAFT)

**DRAFT for owner review. This packet has not been sent.** The owner requests installation at G7 after the ground-device and App Store upgrade checks at G3 and G6 pass.

## What SNAP does

SNAP is an offline-first Earth viewer for photography from the ISS on the NASA-managed iPad and iPhone in orbit. Release 1 puts the existing SNAP screens in a native shell. Installed imagery and orbit data keep the flat map, ISS track, targets, and passes usable for hours to days without the station's Ku-band link. SNAP starts with public data before sign-in and computes passes on the device. Signed-in users can log shots offline for upload on reconnect. [Release design](../designs/ios-app.md#product-goal)

The bundle identifier is `dev.astroanil.snap`. **TODO** Confirm the App Store name. "SNAP Orbit Photo Director" is a candidate.

## What stays on the device

| Storage | Contents planned for release 1 |
| --- | --- |
| Durable native storage | Current and two previous plans per account, account binding, alert schedules, and shot logs awaiting upload acknowledgment. Credentials use device-only Keychain storage. |
| Recoverable web storage | Mirrored preferences, target copies, and caches for the active account. Signed-out public data has its own storage. |
| Imagery | Bundled baseline, Earth pack kept across updates, and optional detail packs with a 20 GB default budget. The separate downloaded tile cache is capped at 512 MiB. |
| Diagnostics | Capped local event log and snapshot. Exports exclude credentials and personal target coordinates by design. |

[Storage and native components](ARCHITECTURE.md#storage-in-two-tiers)

## Permission and tracking

SNAP asks for one permission, notifications, to give local photography reminders while offline or locked. The design uses local scheduling.

Release 1 is designed without tracking or third-party analytics. The SDK manifests inspected for the unsigned skeleton declare no tracking. **TODO** Check the signed candidate's SDK inventory and archive, and verify the claim with installed-candidate traffic capture. [SDK inventory](../../app/README.md#sdk-inventory) · [Alert design](ARCHITECTURE.md#alerts)

## Provisional app outbound origins

This inventory uses the release design and current website source. **TODO** Reconcile it with candidate captures and W-10's `routes.json` and `tile-layers.json`, both absent at the source revision.

| Origin or service | What the device uses it for |
| --- | --- |
| SNAP Worker. Current hosts are `https://map.astroanil.dev` and `https://map.expedition75.com`. | The frontend reads local manifests, artifacts, and assets. Native requests to one configured SNAP origin cover plan sync, launch and hazard feeds, live lightning, forecast cloud frames, the Earth pack, weather, account and target operations, log uploads, recovery, and connectivity checks. Device routes report the app build version except for the public ISS read. **TODO** Record the candidate host and routes. |
| SNAP public ISS element read | Native sync reads `/d/public/iss-elements.json` from SNAP without credentials, cookies, identifiers, or a build report. |
| NASA GIBS, `https://gibs.earthdata.nasa.gov` | Daily true-colour and geostationary infrared imagery. The baseline and Earth packs provide Blue Marble and Black Marble, which the website also sources from GIBS. NASA HLS through GIBS is the first detail-pack candidate. **TODO** Record the enabled sources, origins, and rights. |
| Esri, `https://server.arcgisonline.com` | Imagery, dark grey basemap, and reference labels on demand where permitted. The default iOS design disables Esri prefetch and disk storage. **TODO** Record the actual enabled sources and any rights outcome for offline use. |
| RealEarth, `https://realearth.ssec.wisc.edu` | The website has enhanced Meteosat infrared imagery. iOS keeps the layer off unless W-41 records display and cache rights for `Met11-SEVIRI-FD-BAND09-enh` and both required credits. |
| Apple system services | Native Sign in with Apple, Apple credential-state checks, and App Attest enrollment, including fresh attestation for recovery after restore. App Attest assertions are generated on the device. **TODO** Capture the Apple destinations for these flows. |
| Cloudflare Access and Google | The system sign-in sheet opens SNAP's `/api/device/enroll` through a separate Access application and Google. Native enrollment completes at SNAP. **TODO** Record the Access and Google origins and redirects on the candidate. |
| Public privacy policy | **TODO** Add the public URL and origin after the owner records the step 7a decision and the policy is published. |

The current website loads a Sun image from `https://sdo.gsfc.nasa.gov`. **TODO** Record how the iOS build handles that request and capture the result. External links open in Safari by design. [Route design](ARCHITECTURE.md#request-routes-on-the-ios-host) · [Tile design](ARCHITECTURE.md#tiles) · [Sun widget source](../../frontend/src/sun.ts)

The iOS design omits external place search. Saved personal target names and coordinates go to SNAP during authenticated sync. Only verified public targets may trigger live weather or target-derived tile requests. Personal target views use imagery already installed or acquired independently of the target.

## Traffic outside the app

- **Worker to providers.** Cloudflare Access verification keys, Open-Meteo (`api.open-meteo.com`) cloud data, AviationWeather.gov station reports, and NOAA space weather (`services.swpc.noaa.gov`). The design adds Apple public verification keys, token exchange, validation, and revocation at `appleid.apple.com`. **TODO** Record the website-only search provider. Public Nominatim is a conditional option.
- **Apple to the Worker.** Apple sends signed consent-withdrawal and account-deletion notices to a dedicated HTTPS endpoint outside website Access. **TODO** Record the configured endpoint.
- **Recovery email.** The Worker sends a one-use deletion code to an independently verified mailbox when the holder opts in. **TODO** Record the delivery provider and origin.
- **Generator and publisher on Earth.** Source code lists CelesTrak, ARISS, and Where The ISS At for orbits. It lists Open-Meteo GFS (`https://api.open-meteo.com/v1/gfs`) for cloud and CAPE, NASA GIBS, EUMETSAT, NICT Himawari, NOAA hurricane and lightning data, NASA FIRMS, Launch Library 2, and FAA, Coast Guard, and NGA hazard feeds. The publisher sends artifacts to Cloudflare. **TODO** Confirm enabled sources, the production forecast endpoint, and public inputs in W-21.

## Account deletion recovery

At first native enrollment, the design binds one deletion-only WebAuthn credential for use after erase or replacement. Recovery needs a connection to SNAP and works without signing in to the provider. The holder chooses an independently bound software credential, such as a synced passkey in a holder-controlled store the shared device does not use, or a holder-kept FIDO2 security key over USB-C or NFC with its own PIN. The holder saves the primary deletion key and spare code separately outside SNAP. Apple accounts can opt in to mailbox recovery with the spare code.

**TODO** Record W-60's signed restore and shared-iPad evidence for both options and both sign-in providers. Confirm that NASA's managed-device policy permits the option and transport planned for orbit before requesting installation. [Recovery design](ARCHITECTURE.md#signed-out-apple-deletion-recovery)

## Open items before requesting installation

- **TODO** Ask NASA early. Who receives the request? What is the intake process, is there a required form or template, and how long should approval take?
- **TODO** Add the live App Store listing URL and the approved distribution method, unlisted or public.
- **TODO** Add the recorded step 7a retention and deletion scope. Include shared-profile contributions, ambiguous legacy records, and controlled copies. Record the basis, start event, and deadline for any legally required retention. [Owner step 7a](OWNER_STEPS.md#7a-log-retention-policy)
- **TODO W-21** Attach service-side target privacy and cleanup evidence for both website hosts, including legacy search, weather, and tile copies. Verify no private inputs reach Open-Meteo for cloud or CAPE in scheduled or manual generator runs.
- **TODO W-32** With launcher CelesTrak acquisition stopped and the stop persisted, cold-launch Map online with saved satellite selections and a cold device cache, signed out and signed in. Capture app and serving-path traffic through reconnect and an attempt at the old lookup route. Verify zero CelesTrak traffic and continued ISS tracking.
- **TODO W-41** Capture tile requests and cache writes. Verify that private targets do not trigger either and that Esri's default prefetch and disk storage are off. If RealEarth is enabled, verify its cache limit and the SSEC RealEarth and EUMETSAT Meteosat credits. If rights remain unresolved, verify no requests, cache writes, layer, or credit.
- **TODO installed candidate** Capture signed-out and signed-in traffic and sign-in redirects. Test coordinate and map-pin entry, verify the search control is absent, and verify the old geocoder route is blocked. Open a synthetic personal target and its pass details, and exercise top-three prefetch. Capture app and Worker-to-provider traffic and read back caches and R2 to verify no private weather or tile requests or fills. Compare with a verified public control. Check the signed-out privacy link.
