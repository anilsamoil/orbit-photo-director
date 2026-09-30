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
- `iss-cupola` is `[data-iss-cupola]`. Window 7 is `Window 7 · Nadir` and selects Straight down. Windows 1 through 6 carry the plate names and stay disabled.
- `iss-leave` returns to Map and Queue with no `[data-iss-scene]` left mounted. Opening ISS view again keeps Straight down for the session.

## How to get to it (user POV)

- Open the app on Map. Tap `ISS view` in the top bar.
- The Earth limb is the first picture. Tap `Straight down` for the ground under the station.
- Tap `Map` or `Queue` to leave. Tap `ISS view` again to come back.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Horizon.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive iss`. The view class is `view-iss`. Horizon is pressed. The card contains `Horizon locked` and `14 mm`. Telemetry starts collapsed and does not cover the frame. The frame, the card, `Port`, and `Starboard` stay inside `#iss-host`, and the scene does not scroll. One info button is collapsed. The frame lists country, city, and water labels. Place names do not cover each other. `Starboard` sits left of the frame and `Port` sits right of it. `window.__opdIss.getRoll()` is 180. The Cupola select leaves windows 1 through 6 disabled, with Port on window 1 and Starboard on window 4. Window 7 reads `Window 7 · Nadir`. `evidence/iss-horizon.png` is that frame. The same containment holds after another second of render ticks, with at least one place name on screen. Opening telemetry still leaves the card, the frame, and both side labels inside the host. `evidence/iss-telemetry-open.png` is that open card, then the drive collapses it again.
- **Straight down.** The drive taps Straight down. The card contains `Nadir locked`. Roll stays 180, and a point ahead along the ground track projects below the frame center. `Starboard` stays left of the frame and `Port` stays right of it. `evidence/iss-nadir.png` is that frame.
- **Leave and return.** Map opens with the scene gone. Queue opens. ISS view opens again with Straight down still pressed. `evidence/iss-return.png` is that return.
- **Proof.** Stdout starts with `iss:`.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- The picture is a spherical model with static Blue Marble and Black Marble 2016. It is not a live photo and not the Cupola window.
- The scene needs WebGL2. A browser without it shows `WebGL2 is unavailable` and this drive fails on the Horizon wait.
- The preset is remembered only in the page session. A new browser starts on Horizon again.
- The fixture uses a live CelesTrak ISS element set when that fetch works. While that set is not over 48 hours old, the open card's first line is `ISS perspective`. If CelesTrak is unreachable, the fixture uses the 2026-09-27 set in `scripts/fixtures.mjs`, and that line is `Estimated view · orbit data old`. The drive still requires `Horizon locked` and `14 mm`.
- G1 is not closed by this drive. Emulated WebKit is not a physical iPad Safari or iPhone Safari pass.
