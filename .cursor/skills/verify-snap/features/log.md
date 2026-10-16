# Log

Log shows calibration Shoot/Skip history used to improve scoring; empty until the crew logs from Queue cards.

## Sub-features

- `log-open` opens the Log tab.
- `log-empty` shows the empty state when no entries exist (`#log-empty`).
- `log-notice` shows the missing/auth/offline notice (`#log-notice`).
- `log-list` renders merged log rows when `/api/log` returns data.
- `log-pending` surfaces the pending-sync badge when offline queue has entries.

## How to get to it (user POV)

- Choose the `Log` button in the topbar tabs.
- Entries are created from Queue card Shoot/Skip actions (separate feature path).

## Driving it with control-snap

Preconditions:

- Doctor healthy.
- Fixture Vite stubs `/api/log` → `{entries:[]}`, so local proof is typically `#log-empty`. `#log-notice` is the missing/auth/offline path.

- **Open Log.** Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id tab-log`. `#view` becomes the log view class; `#tab-log` is `active`.
- **Empty or notice.** Expect `#log-empty` **or** `#log-notice` — both are acceptable local outcomes. Live proof saw `#log-empty`. Capture the visible status text.
- **Proof.** Snapshot/screenshot under `.cursor/skills/verify-snap/artifacts/log/` showing Log active and the empty/notice message. Do not claim Shoot→Log round-trip verified without a Worker.

## Gotchas

- Proving Shoot → Log requires POST `/api/log` with calibration auth on the real Worker.
- Pending sync badge (`#pending-sync-badge`) only appears when offline queue has items — not in a clean fixture session.
- Never invent log rows in fixtures unless you also mock `/api/log` in the verify Vite middleware (out of scope for the seeded skill).
