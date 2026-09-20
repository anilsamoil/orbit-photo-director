# Upcoming

Upcoming lists forecast-scored passes for the next ~36 hours so the crew can plan beyond the immediate Queue window.

## Sub-features

- `upcoming-open` opens the Upcoming tab.
- `upcoming-cards` renders longer-horizon pass cards from `top_24h`.
- `upcoming-sort` toggles Time vs Score.
- `upcoming-filter` toggles All vs Mine.

## How to get to it (user POV)

- Choose the `Upcoming` button in the topbar tabs.

## Driving it with control-snap

Preconditions:

- Doctor healthy; VERIFY fixtures include `top_24h` with `Verify Alaska Range` / `Verify Patagonia`.

- **Open Upcoming.** Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id tab-upcoming`. `#view` is `view-upcoming`.
- **See forecast cards.** `#upcoming-cards` has children; text includes a VERIFY target beyond the 90-minute set (e.g. `Verify Alaska` or `Verify Patagonia`).
- **Sort / filter.** Click `#sort-score-upcoming` then `#filter-all-upcoming`; confirm `active` classes.
- **Proof.** Snapshot/screenshot under `.cursor/skills/verify-snap/artifacts/upcoming/` showing Upcoming active and at least one forecast card name.

## Gotchas

- Empty Upcoming with live data can be valid (no forecast passes); fixtures always seed cards — prefer fixtures for deterministic proof.
- Do not confuse Queue `#cards` with Upcoming `#upcoming-cards`.
