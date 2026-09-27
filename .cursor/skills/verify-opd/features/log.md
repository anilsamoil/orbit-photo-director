# Log

Log lists shoot and skip records for the signed-in profile. It is empty until Queue records a Shoot.

## Sub-features

- `log-shoot` shows the Verify Reef shoot recorded by this proxy.

## How to get to it (user POV)

- Choose Shoot on a queue card, then choose the Log tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- `drive queue` has already clicked Shoot in this browser session. `drive all` does that before `drive log`. A lone `drive log` on a fresh page finds an empty log and fails.

- **Open Log.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive log` only as part of `drive all`, or after `drive queue` on the same `up`. The shoot is stored by the proxy, so a new Chrome still sees it.
- **Proof.** `evidence/log.png` shows Verify Reef or the id `verify-reef`.

## Gotchas

- `drive log` before any Shoot in this proxy lifetime finds an empty list and fails. `down` then `up` clears those rows. Use `drive all` for the paired proof.
- The fixture stores the POST body and fills `target_name` from the known id when the client omits it.
