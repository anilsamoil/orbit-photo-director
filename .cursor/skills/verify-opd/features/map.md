# Map

The Map tab is the globe, the ISS track and marker, target pins, a dropped pin, the legend, the imagery date, the time controls, and the right-hand tool rail.

## Sub-features

- `map-globe` shows the MapLibre canvas, the ISS marker, and the ground track.
- `map-legend` shows launch, day, twilight, eclipse, Anil's targets, and the Starship status. The Anil swatch is `#8b93ff`. The Starship swatch is `#ff5c5c`.
- `map-imagery` shows the imagery or clouds date badge.
- `map-controls` has no map ? button and no (i) credit button. The right tool rail uses that space. `#map-chrome-toggle` stays in the same screen place when it reads `Controls` and when it reads `Hide`. It is 88px wide and 44px tall, and `right` is `12px`.
- `map-time` is the Time strip (`.map-command`) laid on the map. The canvas meets `#map-pane` with a 0px gap. The strip's computed background is `rgba(16, 22, 28, 0.55)`, and the ground shows through it. It is not in the top Show toolbar. T+45 moves the readout off Now, then Now returns it.
- `map-tools` toggles IR, night lights, labels, multi-orbit, and follow, and confirms ISS up is the selected bearing.
- `map-satellites` opens the picker and lists Tiangong and Hubble.
- `map-target-popup` opens the Verify Reef popup.
- `map-pin-drop` right-clicks the map and opens a pass popup.
- `map-hide-pin` hides Verify Reef from Queue and the targets source drops `verify-reef`.
- `map-launch` turns on Launches and opens the Verify Ascent dialog.

## How to get to it (user POV)

- Choose the Map tab. The page also lands here on first load.
- The map opens clear. One `Controls` button sits at the bottom right. The legend, the Time strip on the map, the Show toolbar, the tool dock, the imagery date, the zoom buttons, the launch panel, and the satellite picker are hidden. The map ? button and the (i) credit button stay off. The top bar and the status footer stay, including Sign in and Reload when the session is dead. Help on the other tabs stays.
- Tap `Controls`. The chrome comes back and the button reads `Hide`. Tap `Hide` and the map is clear again. The choice is stored on this device as `opd-map-chrome` (`shown` or `hidden`). A missing key stays hidden.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The launch fixture `valid_until` is still in the future.

- **Open the map.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive map`. The URL includes `?e2e`. The ISS marker, legend, imagery badge, and `iss-track-layer` are present. On a fresh profile the legend is in the page and `display: none`. The Show toolbar and the Time strip (`.map-command`) are `display: none` with it. `#map-chrome-toggle` reads `Controls`, is 88px wide and 44px tall with `right` `12px`, and `aria-expanded` is `false`. The status footer and the Map tab stay visible. `evidence/map-chrome-hidden.png` is that clear map. The script taps `Controls`. The button reads `Hide`, the Time strip is visible on the map, `opd-map-chrome` is `shown`, and a reload keeps that chrome. The script taps `Hide`, the key is `hidden`, and a reload keeps the clear map. It taps `Controls` again, and the rest of this drive uses that chrome.
- **Controls.** The map ? button and the (i) credit button are not shown. Hiding the chrome and showing it again leaves `#map-chrome-toggle` in the same place, still 88 by 44 and 12px from the right of `#map-pane`. `evidence/map-controls.png` is that rail.
- **Time.** With the chrome shown, the MapLibre canvas bottom meets `#map-pane` (a 0px gap) and `.map-command` overlaps that canvas. The strip's computed `background-color` is `rgba(16, 22, 28, 0.55)`. The time controls inside it are transparent, so the ground shows through the strip. T+45 changes `#time-slider-readout`. Now sets that readout back to `Now`.
- **Tool rail.** IR becomes active, night lights become active, labels become inactive, multi-orbit becomes active, ISS up is already the default and stays active, and its title is `ISS up (default). Rotate so the direction of travel points up`. Follow reports `aria-pressed` false.
- **Satellites.** The picker lists Tiangong and Hubble. The script closes it without adding a NORAD id.
- **Target popup.** The script frames Verify Reef and clicks that point. A popup contains Verify Reef.
- **Dropped pin.** A right-click away from that pin opens a popup whose text contains `Closest`. The Verify Reef popup is still open, so the map has reserved the inspector. On a wide layout that inspector is a 320px column. At 899px and below it is a bottom sheet, and the map keeps a hit band so the projected point lands on the canvas. The (i) credit control is not shown. The script checks `elementFromPoint` at that point is the MapLibre canvas, then right-clicks. It closes the popups before Launches, so the pad click is not covered on a phone.
- **Show.** Before that press, the Show group label is `Show` and `#filter-launches-map` reads `Launches`. The word stays inside the button: `white-space` is `nowrap`, `flex-shrink` is `0`, and the text box sits inside the button box. `evidence/map-show-launches.png` is that button.
- **Launch.** Launches reports `aria-pressed` true. Turning it on opens the map brief. The script clicks the launch name in that brief. The dialog text contains Verify Ascent. The script turns Launches off again.
- **Legend category.** The legend text contains `Anil's targets`. The `.map-legend-anil` swatch is `rgb(139, 147, 255)`. The `targets-layer` circle color expression names `anils-targets` and `#8b93ff`.
- **Hidden pin.** After the launch dialog closes, the targets source still contains `verify-reef`. Hide on the Verify Reef queue card removes that id from the source. The script waits until `GET /api/browser/profiles/anil/targets` contains `verify-reef`. The new-browser check for a hidden card is `drive upcoming`.
- **Profile menu.** From Queue, the script opens `#profile-menu`. The rows are Anil (`data-profile-home`, `aria-current`), Jessica Watkins (Watty), Josh Kutryk, and Luke Delaney. Choosing Watkins sets `u=watkins` and restores Queue. Profile then reads `Crew roster · Jessica Watkins (Watty)`, with 12 site names including `Lafayette, Colorado hometown`, and no profile select, New profile, Delete this profile, Add target, or Edit. Opening the menu on that tab marks Watkins `aria-current`. Escape closes the menu and leaves Profile and `u=watkins` in place. The map legend reads `Jessica Watkins (Watty)'s targets`. The `my-targets` source has those same 12 names. The menu then marks Watkins `aria-current` and leaves Anil unmarked. Choosing the Anil row deletes the crew `u` and reloads. The app then writes `u=anil` for the signed-in profile. Map is restored, the badge reads Anil, the legend reads `Anil's targets`, and Lafayette is gone. On iPhone 17 Pro the same round trip runs again in landscape. `evidence/profile-menu-anil.png`, `evidence/profile-crew-watkins.png`, `evidence/profile-menu-on-profile.png`, `evidence/profile-legend-watkins.png`, `evidence/profile-menu-watkins.png`, and `evidence/profile-legend-anil.png` are those states. Landscape copies add `-land`.
- **Proof.** `evidence/map-chrome-hidden.png`, `evidence/map-globe.png`, `evidence/map-legend.png`, `evidence/map-imagery-date.png`, `evidence/map-controls.png`, `evidence/map-time.png`, `evidence/map-tool-rail.png`, `evidence/map-satellites.png`, `evidence/map-target-popup.png`, `evidence/map-pin-drop.png`, `evidence/map-show-launches.png`, `evidence/map-launch.png`, `evidence/map-pin-hidden.png`, `evidence/profile-menu-anil.png`, `evidence/profile-crew-watkins.png`, `evidence/profile-menu-on-profile.png`, `evidence/profile-legend-watkins.png`, `evidence/profile-menu-watkins.png`, and `evidence/profile-legend-anil.png`.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- Follow starts on and recenters on the ISS. The script turns follow off, frames the pin at zoom 4, and clicks once. Clicks unwrap longitude toward that center before `project`. A fixture point across ±180 would otherwise land a world away, and `elementFromPoint` would miss the canvas.
- The map ? button and the (i) credit button are not on this tab. Queue, Upcoming, ISS view, Profile, and Log still have the corner ? button. The ISS view keeps its own credit control.
- IR replaces the daily clouds layer. Do not expect both buttons to stay active.
- Launch mode hides target pins. Drive the target popup before Launches.
- The launch pointer is valid for about 13 minutes. Each surface slides that clock forward before the page loads. Target coordinates stay the ones from `up`.
- Adding a satellite from the picker fetches CelesTrak. This drive only opens the list.
- Repo-root `targets.json` has eight `anils-targets` places, painted the same indigo on the map, on card chips, and in the target popup. The verify fixture categories are `coast` and `terrain`, so this drive checks the legend and the layer paint. It does not look for those eight names.
- A long press drops the same kind of pin as the right-click. The popup stays open through the click that follows the finger lift. `drive phone` is the touch proof. This drive right-clicks.
