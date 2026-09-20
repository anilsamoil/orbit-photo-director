# SNAP verification map

This directory is the maintained source for verifying user-facing SNAP behavior (Orbit Photo Director / map.astroanil.dev). Read this index before driving, then use the matching feature file.

## Baseline preconditions

- Launch via `.cursor/skills/verify-snap/helpers/control-snap.mjs launch` (default `http://127.0.0.1:43147`).
- Fixtures version `VERIFY` must be served at `/manifest.json`, and `/api/browser/session` must return the verify stub profile (both handled by `vite.config.verify.mjs`).
- Run `control-snap.mjs doctor` and require `"ok": true`.
- Never drive an instance that was not started by this verification run.
- Production `map.astroanil.dev` is behind Cloudflare Access — local fixtures are the default verify path.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer element IDs (`#tab-queue`, `#time-slider`) and accessible names over CSS position.
- Treat every command as literal.
- Run browser actions through `control-snap.mjs browser`.
- Restore disposable UI state after mutations when possible; never delete proof artifacts in cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA/JSON snapshot and a screenshot with the SNAP brand visible.
- Mutation proof against `/api/*` needs a Worker; report `verified-unreachable` with the attempted path when fixtures omit that API.
- Record the feature ID and entry point with every artifact.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2s: `Sub-features`, `How to get to it (user POV)`, `Driving it with control-snap`, `Gotchas`.

## Features

- [Queue](./queue.md) — next-90-minute shot cards, sort/filter, Keepsake toggle.
- [Map](./map.md) — MapLibre map, time scrub, overlay toggles, follow ISS.
- [Upcoming](./upcoming.md) — next-36-hour forecast queue.
- [Profile](./profile.md) — crew profile pane and photo lookup.
- [Log](./log.md) — calibration log of Shoot/Skip entries.
