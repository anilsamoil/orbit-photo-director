# Log

Log lists shoot and skip records for the signed-in profile. It is empty until Queue records a Shoot or a Skip.

## Sub-features

- `log-shoot` shows the Verify Reef shoot recorded by this proxy.

## How to get to it (user POV)

- Choose Shoot on a queue card, then choose the Log tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The shoot has to be on this drive's private fixture. `drive queue` stores it there, and that drive deletes the copy on exit. A later `drive log` reads a new copy and finds an empty log. `drive all` runs queue and log in one process, so the same copy still has the row.

- **Open Log.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive log` in the same process as `drive queue`. That is `drive all`. A separate `drive log` after `drive queue` has returned does not see the shoot: log entries are scoped to the private fixture copy, and the queue drive deletes that copy on exit. A new Chrome inside that same process does see it.
- **Proof.** `evidence/log.png` shows a row titled Verify Reef with a `shoot` tag. A row that only contains the id, or a skip row, does not pass. The script also reads `GET /api/log` and requires the stored shoot `target_name` to be Verify Reef.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- `drive log` before any Shoot on this private copy finds an empty list and fails. `down` then `up` clears the home rows. The paired proof is `drive all`, because a later process does not inherit the shoot.
- The client sends `target_name` on Shoot, Skip, and Rate. The Worker stores that field when it is a non-empty string of at most 200 characters. An empty name or a longer one rejects the whole POST. A POST that omits the field is stored without a name. The Log row uses the stored name, then a name from the loaded targets, then the id. This proxy keeps a valid client name, drops an empty or over-long name, and still stores the entry. A production row shows the raw id only when the record has no stored name and the id is not in the loaded targets.
