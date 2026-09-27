# Help

The ? button opens a dialog that explains the five tabs and the map controls.

## Sub-features

- `help-open` opens the dialog named `Help — how to use SNAP`.
- `help-close` closes it from the close button.

## How to get to it (user POV)

- Choose the ? button at the corner of the page. It is available on every tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Open help.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive help`. The dialog with accessible name `Help — how to use SNAP` is visible.
- **Close help.** The close button removes that dialog.
- **Proof.** `evidence/help.png` shows the open dialog.

## Gotchas

- Escape also closes the dialog. The script uses the close button so the proof names a control.
- The ? button and the dialog share the accessible name `Help — how to use SNAP`. A wait on that name still matches the button after the dialog closes. The script waits for `.help-modal` to appear and disappear, then clicks `.help-close`.
