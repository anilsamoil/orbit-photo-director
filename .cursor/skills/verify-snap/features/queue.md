# Queue

Queue shows the next ~90 minutes of ranked Earth photo opportunities as cards so the crew can decide what to shoot now.

## Sub-features

- `queue-open` opens the Queue tab from the topbar.
- `queue-cards` renders fixture (or live) pass cards with target names and scores; may include up to 2 launch cards prepended into `#cards`.
- `queue-sort` toggles Time vs Score ordering (prefs shared with Upcoming).
- `queue-filter` toggles All vs Mine target filter (prefs shared with Upcoming and Map All/Mine).
- `queue-keepsake` expands the Cupola keepsake pane.

## How to get to it (user POV)

- Choose the `Queue` button in the topbar tabs.
- Deep-link is not required; default production tab may be Map — always click `Queue` for this feature.

## Driving it with control-snap

Preconditions:

- `control-snap.mjs doctor` reports `"ok": true` at the verify URL (default `http://127.0.0.1:43147`, or `SNAP_VERIFY_PORT` if remapped).
- Fixture manifest version is `VERIFY` (includes target `Verify Tokyo`).
- VERIFY fixtures must be fresh enough for `upcomingPasses` (wall-clock); stale VERIFY empties Queue even when doctor is green.

- **Open Queue.** Choose `Queue`. Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id tab-queue`. `#view` class becomes `view-queue` and `#tab-queue` has class `active`.
- **See cards.** After refresh, `#cards` contains at least one child and text includes `Verify Tokyo`. Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser prove-queue --path .cursor/skills/verify-snap/artifacts/queue`.
- **Sort by score.** Choose `Score`. Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id sort-score-queue`. `#sort-score-queue` is `active`.
- **Filter Mine.** Choose `Mine`. Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id filter-mine-queue`. `#filter-mine-queue` is `active` (fixture cards without personal ownership may empty — observe empty state, do not invent cards).
- **Keepsake.** Choose `Keepsake`. Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id cupola-toggle`. `#cupola-pane` is no longer `hidden` (may still have zero windows without `cupola_windows` artifact).
- **Proof.** Snapshot and screenshot under `.cursor/skills/verify-snap/artifacts/queue/`. Artifacts must show SNAP brand, `view-queue`, and `Verify Tokyo`.

## Gotchas

- Map is often the default active tab; failing to click Queue verifies Map instead.
- Live `map.astroanil.dev` needs Cloudflare Access — use local fixtures unless Access cookies are available.
- Shoot/Skip buttons POST `/api/log` and need Worker auth; card presence alone is the local proof for `queue-cards`.
- Sort/filter prefs persist in localStorage across reloads within the same browser profile (shared with Upcoming; All/Mine filter also shared with Map).
- Up to 2 launch cards may be prepended into `#cards` ahead of pass cards when launch data is present.
