# Log

Log lists shoot and skip records for the signed-in profile. It is empty until Queue records a Shoot or a Skip.

## Sub-features

- `log-shoot` shows the Verify Reef shoot recorded by this proxy.

## How to get to it (user POV)

- Choose Shoot on a queue card, then choose the Log tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- `drive queue` has already clicked Shoot on this proxy. `drive all` does that before `drive log`. A lone `drive log` before any Shoot finds an empty log and fails.

- **Open Log.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive log` only as part of `drive all`, or after `drive queue` on the same `up`. The shoot is stored by the proxy, so a new Chrome still sees it.
- **Proof.** `evidence/log.png` shows a row titled Verify Reef with a `shoot` tag. A row that only contains the id, or a skip row, does not pass.

## Gotchas

- `drive log` before any Shoot in this proxy lifetime finds an empty list and fails. `down` then `up` clears those rows. Use `drive all` for the paired proof.
- The proxy stores `target_id`, `pass_time`, `action`, `score_at_time`, and `rating`, and fills `target_name` from its own id map. The client does not send a name. The Worker does not add one, so a production row can show the raw id.
