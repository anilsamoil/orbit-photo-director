# Help

The ? button opens a dialog that explains the five tabs and the map controls.

## Sub-features

- `help-open` opens the dialog named `Help — how to use SNAP`.
- `help-close` closes it from the close button.

## How to get to it (user POV)

- On Map the ? button sits just above the collapsed (i) credits button. On Queue, Upcoming, Profile, and Log it sits in the bottom-right corner.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Open help.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive help`. On Map the bottom edge of the ? button is above the (i) button. The dialog with accessible name `Help — how to use SNAP` is visible.
- **Close help.** The close button removes that dialog.
- **Proof.** `evidence/help-placement.png` shows the ? above the (i). `evidence/help.png` shows the open dialog.

## Gotchas

- Escape also closes the dialog. The script uses the close button so the proof names a control.
- A non-empty shot list hides the ? button. `drive all` presses Remind on Queue first, so the script clears that list before it checks the button.
- The ? button and the dialog share the accessible name `Help — how to use SNAP`. A wait on that name still matches the button after the dialog closes. The script clicks `.help-close`, then waits until `.help-modal` is gone.
