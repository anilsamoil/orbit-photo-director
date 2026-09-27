# Map

The Map tab is the globe, the ISS track and marker, target pins, a dropped pin, the legend, the imagery date, attribution, the time controls, and the right-hand tool rail.

## Sub-features

- `map-globe` shows the MapLibre canvas, the ISS marker, and the ground track.
- `map-legend` shows launch, day, twilight, and eclipse.
- `map-imagery` shows the imagery or clouds date badge.
- `map-attribution` shows the compact credits control with OpenStreetMap, CARTO, or NASA.
- `map-time` moves the readout off Now with T+45, then returns with Now.
- `map-tools` toggles IR, night lights, labels, multi-orbit, ISS-up, and follow.
- `map-satellites` opens the picker and lists Tiangong and Hubble.
- `map-target-popup` opens the Verify Reef popup.
- `map-pin-drop` right-clicks the map and opens a pass popup.
- `map-launch` turns on Launches and opens the Verify Ascent dialog.

## How to get to it (user POV)

- Choose the Map tab. The page also lands here on first load.
- Use the time buttons under the map, the dock on the right, the legend, and the credits control on the map.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The launch fixture `valid_until` is still in the future.

- **Open the map.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive map`. The URL includes `?e2e`. The ISS marker, legend, imagery badge, and `iss-track-layer` are present.
- **Credits.** The script opens the compact attribution control. Its text matches OpenStreetMap, CARTO, or NASA.
- **Time.** T+45 changes `#time-slider-readout`. Now returns toward the live instant.
- **Tool rail.** IR becomes active, night lights become active, labels become inactive, multi-orbit becomes active, ISS-up becomes active, and follow reports `aria-pressed` false.
- **Satellites.** The picker lists Tiangong and Hubble. The script closes it without adding a NORAD id.
- **Target popup.** The script frames Verify Reef and clicks that point. A popup contains Verify Reef.
- **Dropped pin.** A right-click away from that pin opens a popup.
- **Launch.** Launches reports `aria-pressed` true. A click on Verify Pad opens a dialog whose text contains Verify Ascent.
- **Proof.** `evidence/map-globe.png`, `evidence/map-legend.png`, `evidence/map-imagery-date.png`, `evidence/map-attribution.png`, `evidence/map-time.png`, `evidence/map-tool-rail.png`, `evidence/map-satellites.png`, `evidence/map-target-popup.png`, `evidence/map-pin-drop.png`, and `evidence/map-launch.png`.

## Gotchas

- Follow starts on and recenters on the ISS. The script turns follow off before it frames a pin. A click that misses should be retried after `easeTo` zoom 4, which is what the script does.
- IR replaces the daily clouds layer. Do not expect both buttons to stay active.
- Launch mode hides target pins. Drive the target popup before Launches.
- The launch pointer is valid for 14 minutes from `up`. After that, `doctor` fails and the dialog will not open.
- Adding a satellite from the picker fetches CelesTrak. This drive only opens the list.
