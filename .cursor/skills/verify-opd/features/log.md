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
- **Proof.** `evidence/log.png` shows a row titled Verify Reef with a `shoot` tag. A row that only contains the id, or a skip row, does not pass. The script also reads `GET /api/log` and requires the stored shoot `target_name` to be Verify Reef.

## Gotchas

- `drive log` before any Shoot in this proxy lifetime finds an empty list and fails. `down` then `up` clears those rows. Use `drive all` for the paired proof.
- The client sends `target_name` on Shoot, Skip, and Rate. The Worker accepts that field, rejects an empty name or one longer than 200 characters, and still stores a record that omits it. The Log row uses the stored name, then a name from the loaded targets, then the id. This proxy stores the client name and does not fill one in. A production row shows the raw id only when the record has no stored name and the id is not in the loaded targets.
