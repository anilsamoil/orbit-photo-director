# Map

The Map tab is the globe, the ISS track and marker, target pins, a dropped pin, the legend, the imagery date, attribution, the time controls, and the right-hand tool rail.

## Sub-features

- `map-globe` shows the MapLibre canvas, the ISS marker, and the ground track.
- `map-legend` shows launch, day, twilight, eclipse, Anil's targets, and the Starship status. The Anil swatch is `#8b93ff`. The Starship swatch is `#ff5c5c`.
- `map-imagery` shows the imagery or clouds date badge.
- `map-attribution` starts as a 44x44 (i) button. A tap expands the credit line (OpenStreetMap, CARTO, or NASA). The legend, the imagery date, and the ? button sit above that button and move up when the line opens.
- `map-time` moves the readout off Now with T+45, then returns it to Now.
- `map-tools` toggles IR, night lights, labels, multi-orbit, and follow, and confirms ISS up is the selected bearing.
- `map-satellites` opens the picker and lists Tiangong and Hubble.
- `map-target-popup` opens the Verify Reef popup.
- `map-pin-drop` right-clicks the map and opens a pass popup.
- `map-hide-pin` hides Verify Reef from Queue and the targets source drops `verify-reef`.
- `map-launch` turns on Launches and opens the Verify Ascent dialog.

## How to get to it (user POV)

- Choose the Map tab. The page also lands here on first load.
- Use the time buttons in the top-left toolbar, the dock on the right, the legend at the bottom-left, and the (i) credits button at the bottom-right.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The launch fixture `valid_until` is still in the future.

- **Open the map.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive map`. The URL includes `?e2e`. The ISS marker, legend, imagery badge, and `iss-track-layer` are present.
- **Credits.** On load the control has no `maplibregl-compact-show` class and the (i) button is 44x44. The script then opens it. The credit text matches OpenStreetMap, CARTO, or NASA, and the legend moves up.
- **Time.** T+45 changes `#time-slider-readout`. Now sets that readout back to `Now`.
- **Tool rail.** IR becomes active, night lights become active, labels become inactive, multi-orbit becomes active, ISS up is already the default and stays active, and its title is `ISS up (default). Rotate so the direction of travel points up`. Follow reports `aria-pressed` false.
- **Satellites.** The picker lists Tiangong and Hubble. The script closes it without adding a NORAD id.
- **Target popup.** The script frames Verify Reef and clicks that point. A popup contains Verify Reef.
- **Dropped pin.** A right-click away from that pin opens a popup whose text contains `Closest`.
- **Launch.** Launches reports `aria-pressed` true. A click on Verify Pad opens a dialog whose text contains Verify Ascent. The script turns Launches off again.
- **Legend category.** The legend text contains `Anil's targets`. The `.map-legend-anil` swatch is `rgb(139, 147, 255)`. The `targets-layer` circle color expression names `anils-targets` and `#8b93ff`.
- **Hidden pin.** After the launch dialog closes, the targets source still contains `verify-reef`. Hide on the Verify Reef queue card removes that id from the source. The script waits until `GET /api/browser/profiles/anil/targets` contains `verify-reef`. The new-browser check for a hidden card is `drive upcoming`.
- **Proof.** `evidence/map-globe.png`, `evidence/map-legend.png`, `evidence/map-imagery-date.png`, `evidence/map-attribution-collapsed.png`, `evidence/map-attribution.png`, `evidence/map-time.png`, `evidence/map-tool-rail.png`, `evidence/map-satellites.png`, `evidence/map-target-popup.png`, `evidence/map-pin-drop.png`, `evidence/map-launch.png`, and `evidence/map-pin-hidden.png`.

## Gotchas

- Follow starts on and recenters on the ISS. The script turns follow off, frames the pin at zoom 4, and clicks once.
- A pan collapses the credit line again. The script opens the credits and takes `map-attribution.png` before it moves the map.
- IR replaces the daily clouds layer. Do not expect both buttons to stay active.
- Launch mode hides target pins. Drive the target popup before Launches.
- The launch pointer is valid for about 13 minutes from `up`. The fixture stamps `generated_at` one minute before `up` and `valid_until` 14 minutes after that stamp. After `valid_until`, `doctor` fails and `drive` stops before Chrome starts. Run `down`, then `up`.
- Adding a satellite from the picker fetches CelesTrak. This drive only opens the list.
- Repo-root `targets.json` has eight `anils-targets` places, painted the same indigo on the map, on card chips, and in the target popup. The verify fixture categories are `coast` and `terrain`, so this drive checks the legend and the layer paint. It does not look for those eight names.
- A long press drops the same kind of pin as the right-click. The popup stays open through the click that follows the finger lift. `drive phone` is the touch proof. This drive right-clicks.
