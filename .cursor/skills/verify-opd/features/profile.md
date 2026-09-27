# Profile

Profile holds the signed-in astronaut, the distance threshold, personal targets, and photo lookup.

## Sub-features

- `profile-identity` shows Anil from the session fixture.
- `profile-threshold` moves the viable distance display to 800 km.
- `profile-add` adds a target named Verify Harbor.
- `profile-lookup` resolves the fixture timestamp and drops a lookup pin on the map.

## How to get to it (user POV)

- Choose the Profile tab.
- Photo lookup is the section under the target form, not its own tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The track fixture includes a TLE. `up` always writes one.

- **Open Profile.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive profile`. The pane text contains Anil and the distance slider exists.
- **Threshold.** Set the slider to 800. The display reads `800 km`.
- **Add a target.** Enter Verify Harbor with the fixture latitude and longitude, then choose Add target. The profile list contains Verify Harbor.
- **Lookup.** Paste the timestamp from `fixtures/meta.json` field `lookupTimestamp`, choose Resolve, and then Pin on map. The result text contains `ISS at`. The map view shows `lookup-pin-layer`.
- **Proof.** `evidence/profile.png`, `evidence/profile-target.png`, `evidence/profile-lookup.png`, and `evidence/profile-lookup-map.png`.

## Gotchas

- Without `/api/browser/session` the app never reaches this pane. It stops on the sign-in footer.
- The signed-in pane does not show the local New profile field. That field is the signed-out profile picker.
- A fallback TLE from 2024 still resolves, with low confidence. A CelesTrak TLE resolves near now with higher confidence.
- `track.tle_epoch` must match the epoch inside the TLE lines within 2 seconds. Photo lookup refuses the calculation when they disagree, and the result chip says the TLE may be malformed.
- Add target posts to the fixture `/api/browser/profiles/anil/targets`. The name must remain after that response.
