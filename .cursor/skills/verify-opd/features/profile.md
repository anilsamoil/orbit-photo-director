# Profile

Profile holds the signed-in astronaut, the distance threshold, personal targets, hidden curated targets, and photo lookup.

## Sub-features

- `profile-identity` shows Anil from the session fixture.
- `profile-threshold` moves the viable distance display to 800 km.
- `profile-add` adds a target named Verify Harbor.
- `profile-hidden` shows Hidden curated targets. Restore removes `verify-mesa` from that list.
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
- **Hidden curated targets.** A `.profile-crud-subhead` in `#profile-body` has text `Hidden curated targets`. The stylesheet uppercases subheads, so `innerText` reads `HIDDEN CURATED TARGETS`. `Your targets` is an earlier subhead of the same class. If `verify-mesa` is not already listed, the script opens Or paste an exact id, enters `verify-mesa`, and chooses Hide. Restore on that chip removes it.
- **Lookup.** Paste the timestamp from `fixtures/meta.json` field `lookupTimestamp` and choose Resolve. The result text contains `ISS at` and the view switches to the map with `lookup-pin-layer`. Pin on map repeats that drop.
- **Proof.** `evidence/profile.png`, `evidence/profile-target.png`, `evidence/profile-hidden.png`, `evidence/profile-lookup.png`, and `evidence/profile-lookup-map.png`.

## Gotchas

- Without `/api/browser/session` the app never reaches this pane. It stops on the sign-in footer.
- The signed-in pane does not show the local New profile field. That field is the signed-out profile picker.
- The October 2024 fallback TLE does not resolve at the current date. Photo lookup then shows `Calculation failed — TLE may be missing or malformed.` `up` has to reach CelesTrak for this drive to finish. A CelesTrak TLE resolves near now.
- `track.tle_epoch` must match the epoch inside the TLE lines within 2 seconds. Photo lookup refuses the calculation when they disagree, and the result chip says the TLE may be malformed.
- Add target posts to the fixture `/api/browser/profiles/anil/targets`. The name must remain after that response.
- `drive profile` by itself starts with an empty hidden list and hides `verify-mesa` from the paste box. `drive all` reaches this pane after Upcoming has already hidden that id, so the chip is already there and Restore is the step that changes it.
