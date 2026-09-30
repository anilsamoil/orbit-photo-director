# ISS view

The tab immediately after Map opens a modeled view from the station. Horizon is the camera on first open. Straight down is the other camera. The choice stays for this browser session. The pane shows UTC, a compact ISS perspective card, and a Details disclosure. Leaving the tab disposes the scene. Map, Queue, Upcoming, Profile, and Log stay where they were.

## Sub-features

- `iss-tab` is `#tab-iss`, labeled `ISS view`, directly after `#tab-map`.
- `iss-horizon` presses `[data-iss-preset="horizon"]` and the card says `Horizon locked`.
- `iss-nadir` presses `[data-iss-preset="nadir"]`, labeled `Straight down`, and the card says `Nadir locked`.
- `iss-card` shows `14 mm`, the cloud-free Blue Marble and Black Marble 2016 line, and a UTC clock.
- `iss-leave` returns to Map and Queue with no `[data-iss-scene]` left mounted. Opening ISS view again keeps Straight down for the session.

## How to get to it (user POV)

- Open the app on Map. Tap `ISS view` in the top bar.
- The Earth limb is the first picture. Tap `Straight down` for the ground under the station.
- Tap `Map` or `Queue` to leave. Tap `ISS view` again to come back.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Horizon.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive iss`. The view class is `view-iss`. Horizon is pressed. The card contains `Horizon locked` and `14 mm`. `evidence/iss-horizon.png` is that frame.
- **Straight down.** The drive taps Straight down. The card contains `Nadir locked`. `evidence/iss-nadir.png` is that frame.
- **Leave and return.** Map opens with the scene gone. Queue opens. ISS view opens again with Straight down still pressed. `evidence/iss-return.png` is that return.
- **Proof.** Stdout starts with `iss:`.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- The picture is a spherical model with static Blue Marble and Black Marble 2016. It is not a live photo and not the Cupola window.
- The scene needs WebGL2. A browser without it shows `WebGL2 is unavailable` and this drive fails on the Horizon wait.
- The preset is remembered only in the page session. A new browser starts on Horizon again.
- G1 is not closed by this drive. Emulated WebKit is not a physical iPad Safari or iPhone Safari pass.
