# Follow-up queue

Product gaps found while maintaining this skill. A maintain run does not change product code. Each entry names the proof that is missing.

## Test gap: bindTabs once

`init` in `frontend/src/main.ts` calls `bindTabs(!sessionFailed)` once. Re-adding the duplicate second `bindTabs()` call in `main.ts` leaves `frontend/test/map-import-failure.test.ts` green. A second call registers another click listener on each tab, so one click runs the handler twice. A product test should assert that `bindTabs` binds once (no double handlers).

Recorded after #269 (`a9df092f486cda4a05c4328d1a5b430047e7bdb9`).
