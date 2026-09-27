# Top bar

The top bar shows where the station is and the current Kp index. The sun thumbnail appears only when the NASA image loads.

## Sub-features

- `iss-now` fills `#iss-now` from the track fixture.
- `kp-badge` shows Kp 3 from the fixture `/api/kp` response.
- `sun-badge` stays hidden when the NASA sun image does not load.

## How to get to it (user POV)

- Open the app. The readout sits in the header on every tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Read the header.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive topbar`. `#iss-now` has text and `#kp-widget` is visible.
- **Proof.** The command writes `evidence/topbar.png`. Stdout reports whether the sun badge stayed hidden.

## Gotchas

- Kp is the fixture value 3, not a live SWPC fetch.
- A hidden sun badge is an egress miss, not a failed drive, as long as stdout says `sun hidden=true` or the badge is actually visible.
