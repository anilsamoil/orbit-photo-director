# ISS view

The tab immediately after Map opens a modeled view from the station. Horizon is the camera on first open. Straight down is the other camera. The choice stays for this browser session. The pane shows UTC, a compact ISS perspective card, and a Details disclosure. Leaving the tab disposes the scene. Map, Queue, Upcoming, Profile, and Log stay where they were.

## Sub-features

- `iss-tab` is `#tab-iss`, labeled `ISS view`, directly after `#tab-map`.
- `iss-horizon` presses `[data-iss-preset="horizon"]` and the card says `Horizon locked`.
- `iss-nadir` presses `[data-iss-preset="nadir"]`, labeled `Straight down`, and the card says `Nadir locked`.
- `iss-card` starts collapsed. The toggle is `Telemetry`, `aria-expanded` is `false`, and the body is hidden. Opening it keeps the card off the Earth frame. The card shows `14 mm`, the cloud-free Blue Marble and Black Marble 2016 line, and a UTC clock.
- `iss-credits` is one `.maplibregl-ctrl-attrib-button` inside the scene, without `maplibregl-compact-show`.
- `iss-labels` sets `data-iss-place-layers` to `country city water` on the frame. The names are markers on the globe.
- `iss-sides` puts `Starboard` on the left of the frame and `Port` on the right. The Earth camera is rolled 180°, so ground-track forward is at the bottom and port stays on the station's port side.
- `iss-cupola` is `[data-iss-cupola]`. Window 7 is `Window 7 · Nadir` and selects Straight down. Windows 1 through 6 aim the limb. Window 1 is port, 2 forward port, 3 forward starboard, 4 starboard, 5 aft starboard, 6 aft port. Forward bisects 2 and 3. Choosing one clears pan and sets the optical field back to the 14 mm lens, 81.2° vertical. `[data-iss-window]` then reads `W1` through `W7` with the plate name on its label. Horizon and Straight down hide that chip. Reset leaves it on the window that was already selected.
- `iss-pan` is a drag on `[data-iss-frame]`. It shifts the boresight in the rolled view. Altitude stays on the ephemeris. The optical field of view stays where pinch or wheel left it. A later orbit tick does not snap the aim back to the preset boresight. Horizon and Straight down clear the offset and leave the pinched field. A Cupola window clears the offset and restores the lens field. The offset eases toward a limit instead of hitting a wall. From straight down, a wider field allows less turn, because that frame reaches the limb sooner. Past a horizon aim, a narrower field allows less extra turn into space. A drag back off that limit moves the Earth immediately.
- `iss-reset` is `[data-iss-reset]`, labeled `Reset`, beside the aim controls. Its title and accessible name say a double-tap does the same. `[data-iss-aim-hint]` reads `Double-tap the view to reset`. Reset clears pan and restores that same 81.2° lens field for the active preset. A double-click or double-tap on `[data-iss-frame]` does the same. Horizon and Straight down do not.
- `iss-leave` returns to Map and Queue with no `[data-iss-scene]` left mounted. Opening ISS view again keeps Straight down and any pan offset for the session. The narrowed field of view starts over.

## How to get to it (user POV)

- Open the app on Map. Tap `ISS view` in the top bar.
- The Earth limb is the first picture. Pinch or scroll to narrow the field, then drag the Earth to aim it. A hard drag eases off while Earth stays in the frame. Tap `Straight down` for the ground under the station, or pick a Cupola window. The toolbar shows `W3` for window 3, and clears that mark for Horizon or Straight down. A window, Horizon, or Straight down clears the drag. A window also widens a pinched field back to the 14 mm lens. `Reset`, or a double-tap on the Earth, clears the drag and restores that lens. The line under the aim controls says `Double-tap the view to reset`.
- Tap `Map` or `Queue` to leave. Tap `ISS view` again to come back with the same camera and pan. The narrowed field starts over.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Horizon.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive iss`. The view class is `view-iss`. Horizon is pressed. The card contains `Horizon locked` and `14 mm`. Telemetry starts collapsed and does not cover the frame. The frame, the card, `Port`, and `Starboard` stay inside `#iss-host`, and the scene does not scroll. One info button is collapsed. The frame lists country, city, and water labels. Place names, including city names, do not cover each other. `Starboard` sits left of the frame and `Port` sits right of it. `window.__opdIss.getRoll()` is 180. The Cupola select enables windows 1 through 6, with Port on window 1 and Starboard on window 4, and none of them say `Coming soon`. Window 7 reads `Window 7 · Nadir`. `evidence/iss-horizon.png` is that frame. The same containment holds after another second of render ticks, with at least one place name on screen. Opening telemetry still leaves the card, the frame, and both side labels inside the host. `evidence/iss-telemetry-open.png` is that open card, then the drive collapses it again.
- **Optical field of view.** A wheel over the frame narrows `getVerticalFieldOfView()` and raises `getZoom()`. After another second of render ticks the narrowed field is still there, within half a degree, and roll is still 180. The orbit pose is not a native zoom. `evidence/iss-fov-before.png` is the lens field. `evidence/iss-fov-after.png` is the same aim after that tick.
- **Pan.** A left drag on the frame moves `getCenter()` by at least 0.4° while the narrowed field stays within half a degree and roll stays 180. After another second the center is still at least 0.3° from the pre-drag aim, and it has not jumped farther from that aim than the drag itself. `evidence/iss-pan.png` is the dragged frame.
- **Short landscape.** The drive sets an 874 by 402 pane while that narrowed field is still mounted. Collapsed, the frame is at least 80 by 72, and the frame, card, `Port`, and `Starboard` stay inside the host with no scene scroll. City, country, and water names still do not cover each other. Opening telemetry keeps that containment, including after another second of ticks. `evidence/iss-landscape-telemetry.png` is the open card. The drive collapses telemetry and restores the previous viewport. The narrowed field of view is unchanged.
- **Pan across leave.** The drive opens Map, then ISS view again, still on Horizon. The center stays at least 0.3° from the pre-drag aim and has not jumped farther from the dragged aim than that drag. `getVerticalFieldOfView()` is more than 4° wider than the narrowed field, because disposing the scene starts the lens over. Roll stays 180, with `Starboard` left of the frame and `Port` right of it. `evidence/iss-pan-return.png` is that return.
- **Cupola windows.** The drive selects windows 1 through 6. None are disabled and none say `Coming soon`. The card text is the plate label. Roll stays 180. `Starboard` stays left of the frame and `Port` stays right of it. Window 1 and window 4 centers differ by at least 1°. `evidence/iss-w1.png` through `evidence/iss-w6.png` are those frames. Window 7 remains `Window 7 · Nadir`.
- **Window field and reset.** The drive pinches the field at least 4° narrower, then selects window 1. The field returns to within half a degree of the lens and the center moves at least 0.5°. `evidence/iss-window-fov.png` is that window. A drag of at least 0.4° plus another pinch, then `Reset`, returns the center to within 0.35° of the pre-drag aim and the field to within half a degree of the lens. The Cupola select stays on window 1. `evidence/iss-reset.png` is that frame. The same drag and pinch, then a double-click on the frame, ends in that same aim and field. `evidence/iss-double-tap.png` is that frame.
- **Straight down.** The drive taps Straight down. The card contains `Nadir locked`. Roll stays 180, and a point ahead along the ground track projects below the frame center. `Starboard` stays left of the frame and `Port` stays right of it. `evidence/iss-nadir.png` is that frame.
- **Leave and return.** Map opens with the scene gone. Queue opens. ISS view opens again with Straight down still pressed. `evidence/iss-return.png` is that return.
- **Proof.** Stdout starts with `iss:` and includes `landscape telemetry held`, `pan held`, `pan kept`, `fov reset`, `windows 1-6 aimed`, `window field`, `aim reset`, `double tap`, and a held field-of-view degree.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- The picture is a spherical model with static Blue Marble and Black Marble 2016. It is not a live photo and not the Cupola window.
- The scene needs WebGL2. A browser without it shows `WebGL2 is unavailable` and this drive fails on the Horizon wait.
- The preset and a pan offset stay for this page session. A new browser starts on Horizon with no pan. Leaving ISS view and opening it again keeps that offset. Horizon, Straight down, and a Cupola window clear it. Pinch and wheel field of view belong to the mounted scene and start over when the scene is disposed. A Cupola window, `Reset`, and a double-tap on the frame also restore the 14 mm lens, 81.2° vertical. Horizon and Straight down leave a pinch in place.
- Pan shifts the boresight in the rolled view and leaves altitude on the ephemeris. The next orbit tick keeps that offset. It does not freeze the station.
- The fixture uses a live CelesTrak ISS element set when that fetch works. While that set is not over 48 hours old, the open card's first line is `ISS perspective`. If CelesTrak is unreachable, the fixture uses the 2026-09-27 set in `scripts/fixtures.mjs`, and that line is `Estimated view · orbit data old`. The drive still requires `Horizon locked` and `14 mm`.
- G1 is not closed by this drive. Emulated WebKit is not a physical iPad Safari or iPhone Safari pass.
