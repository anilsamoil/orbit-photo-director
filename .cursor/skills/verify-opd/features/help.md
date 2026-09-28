# Help

The ? button opens a dialog that explains the five tabs and the map controls.

## Sub-features

- `help-open` opens the dialog named `Help — how to use SNAP`.
- `help-close` closes it from the close button.

## How to get to it (user POV)

- On Map the ? button sits just above the collapsed (i) credits button. On Queue, Upcoming, Profile, and Log it sits in the bottom-right corner, about 1rem from the edges. A browser that supports `env()` adds `env(safe-area-inset-bottom)` to that offset. While the footer has Sign in and Reload, the same button moves up to `calc(7.75rem + env(safe-area-inset-bottom))`, including on Map.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Open help.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive help`. The script returns to Map and collapses the credits if a previous step opened them. The bottom edge of the ? button is above the collapsed (i) button. The dialog with accessible name `Help — how to use SNAP` is visible.
- **Close help.** The close button removes that dialog. The script then opens Queue and checks that the ? button sits within 24px of the right and bottom edges.
- **Proof.** `evidence/help-placement.png` shows the ? above the collapsed (i). `evidence/help.png` shows the open dialog. `evidence/help-queue.png` shows the corner button on Queue.

Desktop Chrome runs first. WebKit iPhone 13 and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/` and `evidence/ipad-pro-11/`.

## Gotchas

- Escape also closes the dialog. The script uses the close button so the proof names a control.
- A non-empty shot list hides the ? button. `drive all` presses Remind on Queue first, so the script clears that list before it checks the button.
- The signed-in drive has no Sign in or Reload in the footer, so the Queue check stays within 24px of the corner. The denied WebKit pass does not measure the ? button.
- The ? button and the dialog share the accessible name `Help — how to use SNAP`. A wait on that name still matches the button after the dialog closes. The script clicks `.help-close`, then waits until `.help-modal` is gone.
