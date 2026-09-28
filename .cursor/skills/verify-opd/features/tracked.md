# Tracked vehicles

Starship is always on the map. The legend names the state. When the published artifact has element lines, a diamond marker and a dotted ground track are drawn next to the ISS. When it does not, the legend says there is no public orbit and nothing is drawn at a guessed position.

## Sub-features

- `tracked-no-orbit` shows `Starship: no public orbit yet` and leaves the ISS marker and `iss-track-layer` in place.
- `tracked-elements` draws `.tracked-marker` labeled Starship and `sat-track-layer-starship` from a published element set.

## How to get to it (user POV)

- Choose the Map tab.
- Read the legend row with the red diamond. That sentence is the status.
- When elements exist, the diamond marker sits on the sub-point and the dotted line is one orbit.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The default fixture publishes the no-orbit row.
- `OPD_VERIFY_TRACKED=elements` on `up` publishes the first live Starlink from the CelesTrak SupGP starlink file as the Starship row. The lines are that Starlink. The label is Starship.

- **No orbit.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive tracked`. The legend text is `Starship: no public orbit yet`. There is no `.tracked-marker`. The ISS marker and `iss-track-layer` are present.
- **Elements.** Bring the instance down, set `OPD_VERIFY_TRACKED=elements`, and run `up` again, then `drive tracked`. The marker label is `Starship`. The legend names the stand-in catalog name. `sat-track-layer-starship` exists. The script frames that track and saves desktop, iPad, and iPhone screenshots.

## Gotchas

- `up` reuses fixtures. A mode change needs `down`, then `up`, or a different `OPD_VERIFY_HOME`.
- The stand-in fetch reads only the first element set from the SupGP starlink file. If that fetch fails, `up` fails. The drive does not substitute a made-up orbit.
- Queue, Upcoming, and the ISS track do not read `tracked.json`.
