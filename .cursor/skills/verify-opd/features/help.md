# Help

The ? button opens a dialog that explains the six tabs, Aiming the ISS view, the map legend (closed until Legend, immediately left of Hide in the bottom-right corner, is tapped; on a narrow screen the open list sits above the time row when that band can hold it, and otherwise scrolls above the footer clear of the zoom column, the time row, and the Legend button; launch, day, twilight, and eclipse; the imagery date shows only while it is open; a live IR warning adds a mark on Legend while the list is closed; the ISS marker, Anil's targets, Starship, and your white rings are not rows; Starship is not a legend row), Cupola keepsake windows, personal targets, the top-bar ISS readout, and Sign in and Reload in the footer. The dialog does not say `Starship: no public orbit yet`, `Starship: public orbit expired`, or `Starship: orbit lookup failed`. The dialog body scrolls. Where the browser supports `env(safe-area-inset-*)`, that inset is added on every side of `.modal-backdrop`. Otherwise the backdrop padding is `1rem`. The close button stays on screen. On the Map tab that button is not shown. Queue, Upcoming, ISS view, Profile, and Log keep it.

## Sub-features

- `help-open` opens the dialog named `Help — how to use SNAP`.
- `help-aim` is the section `Aiming the ISS view`. It names Horizon with `keep a pinched field`, Straight down with `n / N`, pan with `W, A, S, and D` and Shift, `#iss=` for a saved aim, a Launch line (`The Launch menu sits beside Telemetry`, `Chances for the next seven days come first`, `All launches`, `14 days`, `That list is not limited to chances.`, `Map and Upcoming list chances only`, and `None clears it.`), a pad name beside Telemetry, a tap of about 18°, a gold pin, an arrow on the edge, and a gold path only when that launch includes a trajectory. The dialog text has no `Reset`, no `double-tap`, and no `Horizon opens first`.
- `help-close` closes it from the close button.

## How to get to it (user POV)

- On the Map tab the ? button stays hidden, with the chrome shown or hidden. On Queue, Upcoming, ISS view, Profile, and Log it sits in the bottom-right corner, about 1rem from the edges. A browser that supports `env()` adds `env(safe-area-inset-bottom)` to that offset. While the footer has Sign in and Reload, the same button moves up to `calc(7.75rem + env(safe-area-inset-bottom))` on those tabs.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Open help.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive help`. The script opens Map and checks the ? button and the (i) credit button are not shown. It then opens Queue. The ? button sits within 24px of the right and bottom edges and opens the dialog with accessible name `Help — how to use SNAP`. Its body includes `Aiming the ISS view` through the phrases above, including the Launch line (`Chances for the next seven days come first`, `All launches`, the 14-day list, `That list is not limited to chances.`, and chances only on Map and Upcoming). The Map legend section names `launch, day, twilight, and eclipse`, says the ISS marker, Anil's targets, Starship, and your white rings are not rows, says Starship is not a legend row, and says the legend starts closed until `Legend`, immediately left of Hide, is tapped. On a narrow screen the open list sits above the time row when that band can hold it, and otherwise scrolls above the footer clear of the zoom column, the time row, and the Legend button. The imagery date shows only while that legend is open. A live IR warning adds a mark on Legend while the list is closed. The dialog does not include `Reset`, `double-tap`, `Horizon opens first`, `Starship: no public orbit yet`, `Starship: public orbit expired`, or `Starship: orbit lookup failed`.
- **Close help.** The close button removes that dialog. The Queue ? button is still within 24px of the right and bottom edges.
- **Proof.** `evidence/help-placement.png` shows the map without the ? button and the (i) button. `evidence/help.png` shows the open dialog. `evidence/help-queue.png` shows the corner button on Queue.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- Escape also closes the dialog. The script uses the close button so the proof names a control.
- A non-empty shot list hides the ? button. `drive all` presses Remind on Queue first, so the script clears that list before it checks the button.
- The signed-in drive has no Sign in or Reload in the footer, so the Queue check stays within 24px of the corner. The denied WebKit pass does not measure the ? button.
- The ? button and the dialog share the accessible name `Help — how to use SNAP`. A wait on that name still matches the button after the dialog closes. The script clicks `.help-close`, then waits until `.help-modal` is gone.
