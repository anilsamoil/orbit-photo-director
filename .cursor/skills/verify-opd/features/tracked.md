# Tracked vehicles

Starship is always on the map. The legend names the state. A published element set draws a red diamond and a dotted one-orbit ground track. The other states draw nothing at a guessed position. The ISS marker and `iss-track-layer` stay.

## Sub-features

- `tracked-elements` draws `.tracked-marker` labeled Starship and `sat-track-layer-starship` from a published element set. The legend is `Starship: ` plus the catalog name. A cached set adds ` (last good)`.
- `tracked-no-orbit` shows `Starship: no public orbit yet`.
- `tracked-missing` shows that same sentence when the manifest has no `tracked` entry. `loadTrackedRecords` in `frontend/src/tracked.ts` returns the no-orbit row.
- `tracked-aged-out` shows `Starship: public orbit expired` and removes the marker and the track. The generator drops an element set older than 12 hours. The page does not apply that cutoff. It prints this sentence when the artifact says `aged_out`.

## How to get to it (user POV)

- Choose the Map tab. The legend is hidden until `Controls`.
- Tap `Controls`. Read the legend row with the red swatch. That sentence is the status. The swatch is a circle painted `#ff5c5c`. The diamond is the map marker, and it appears only while the row has elements. The diamond and the dotted track are on the map before that tap when an element set is published.
- When elements exist, the diamond sits on the sub-point and the dotted line is one orbit.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The default fixture publishes the no-orbit row.
- `OPD_VERIFY_TRACKED=elements` on `up` publishes the first live Starlink from the CelesTrak SupGP starlink file as the Starship row. The lines are that Starlink. The label is Starship.
- `OPD_VERIFY_TRACKED=aged_out` on `up` publishes `reason: aged_out` and no element lines.
- `OPD_VERIFY_TRACKED=lookup_failed` on `up` publishes `reason: lookup_failed` and no element lines.
- `OPD_VERIFY_TRACKED=missing` on `up` omits `tracked` from the manifest.

- **No orbit.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive tracked`. The script taps `Controls` when the legend is hidden. The legend text is `Starship: no public orbit yet`. There is no `.tracked-marker` and no `sat-track-layer-starship`. The ISS marker and `iss-track-layer` are present.
- **Elements.** Bring the instance down, set `OPD_VERIFY_TRACKED=elements`, and run `up` again, then `drive tracked`. The marker label is `Starship`. The legend names the stand-in catalog name. `sat-track-layer-starship` exists. The script turns follow off, frames that track, and saves desktop, iPad, and iPhone screenshots.
- **Missing artifact.** Bring the instance down, set `OPD_VERIFY_TRACKED=missing`, and run `up` again, then `drive tracked`. The manifest has no `tracked` entry. The legend is `Starship: no public orbit yet`. Nothing is drawn for Starship.
- **Age-out.** Bring the instance down, set `OPD_VERIFY_TRACKED=aged_out`, and run `up` again, then `drive tracked`. The legend is `Starship: public orbit expired`. The marker and `sat-track-layer-starship` are absent. The ISS marker and track stay.
- **Lookup failed.** Bring the instance down, set `OPD_VERIFY_TRACKED=lookup_failed`, and run `up` again, then `drive tracked`. The legend is `Starship: orbit lookup failed`. The marker and the Starship track are absent. The ISS marker and track stay.
- **Devices.** Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- `up` reuses fixtures. A mode change needs `down`, then `up`. A second run needs its own `OPD_VERIFY_HOME` and `OPD_VERIFY_PORT`. The default ports stay taken while the first proxy is up.
- Any other value of `OPD_VERIFY_TRACKED`, including unset, publishes the no-orbit row.
- The stand-in fetch reads only the first element set from the SupGP starlink file. If that fetch fails, `up` fails. The drive does not substitute a made-up orbit.
- `lookup_failed` prints `Starship: orbit lookup failed`. Publish it with `OPD_VERIFY_TRACKED=lookup_failed` before `up`.
- The 12-hour cutoff lives in `generator/tracked.py`. This drive publishes the `aged_out` row the page already draws. It does not call the GP feed.
- Queue, Upcoming, and the ISS track do not read `tracked.json`.
- The unavailable shots leave follow on. The ISS marker on screen is the live propagation, not the sub-point saved at `up`.
