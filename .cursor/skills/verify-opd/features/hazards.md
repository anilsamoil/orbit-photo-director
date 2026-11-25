# Published hazard areas

#372 (`2190864`) publishes one schema 2 bundle, `frontend/test/fixtures/hazards-v2-2026-11-13.json`, and the map reads it at `/hazards/v2/launches.json` (`HAZARD_PATH` in `frontend/src/launch-hazards.ts`). It is not a catalog field and it is not a flight path. There is no `frontend/public/hazards/` file. The schema 1 Starship file stays a migration fixture at `frontend/test/fixtures/hazards-v1-starship-flight15.json`. The notices behind the Starship polygons are `frontend/test/fixtures/notices/navarea-iv-1080-26.txt` (NAVAREA IV 1080/26), `frontend/test/fixtures/notices/uscg-lnm-45-2026-starship-flight15.txt` (USCG LNM 45/2026), and `frontend/test/fixtures/notices/faa-tfr-6-7129.xml` (FAA TFR 6/7129).

## Sub-features

- `hazard-polygons` paints `launch-hazard-fill-layer` and `launch-hazard-outline-layer` from `/hazards/v2/launches.json` while Launches is on, an eligible map pin's attempt overlaps a notice window, and `now` is inside that window and inside `checked_at` plus 48 hours. With nothing selected, every eligible launch paints. Selecting a launch hides the others. Every feature is a Polygon. A LineString is rejected and is not drawn. One malformed launch refuses the whole file. Starship area A is 30 vertices, area B is 16, and TFR 6/7129 is 6. The notice check is a closed ring against those three texts. Vertex mismatches are 0. The pad stays Watch, status `TBC`, and the shot list stays empty. `LAUNCH / WATCH` is the pin label. The catalog ascent is grade D, so the card button reads `Show site and assumed sector` (`launch.ascent?.grade === 'D'` in `frontend/src/launch-tier-card.ts`), not `Show launch site`.
- `hazard-windows` opens the TFR at 22:30Z and areas A and B at 22:45Z. The map pin and the polygons clear together at `2026-11-14T00:00:00Z` (`shows both at 23:59:59Z and neither at 00:00:00Z`). The notice text runs those maritime windows on to 00:40Z, and the same 22:45Z–00:40Z window repeats daily through 2026-11-19. Painting also stops at the review cutoff: `now >= checked_at + 48h` (`REVIEW_MAX_MS` in `frontend/src/launch-hazards.ts`). The Nov 13 review is `2026-11-13T10:02:00Z`, so that cutoff is closed and the Nov 19 window does not paint.
- `hazard-caption` is `#launch-hazard-caption`. The text is `Published hazard areas — not a flight path or navigation guidance` with U+2014. At 874 by 402 it wraps to two lines. It stays clear of `#map-legend-toggle` and `#map-launch-coverage` at all eight sizes below.
- `hazard-card` puts the notice facts on the launch card (`[data-hazard-note]`) and in the polygon popup. The card scrolls (`overflow-y: auto` on `#map-launch-coverage`), so a fact below the fold is reachable by scrolling. On iPad landscape the TFR polygon keeps a clear sample off that card.
- `hazard-popup` keys an open popup by launch, notice, and area (`event_id`, U+0000, `notice_id`, U+0000, `area_id`) in `hazardNoticeKey`. Two area-A notices stay distinct. A direct `reloadLaunchHazards` rewrites the open popup in place when those keys are still painted. A page `refresh()` that still serves those notices leaves the popup open. A catalog refresh that withdraws the file (`404` on `/hazards/v2/launches.json`) closes it.
- `hazard-focus` fits the pad and the polygons once, and keeps the current bearing. A wheel or an arrow while the fit is still deferred leaves center, zoom, and bearing where that gesture put them. A pan, a user zoom, leaving Launches, or another launch cancels the fit.

## How to get to it (user POV)

- Open Map on iPhone or iPad, or on the desktop window. Show the chrome. Tap Launches.
- Inside a published window the gold pad is Starship Flight 15, status `TBC · Tentative`, with no corridor line. The polygons sit around the Gulf, and the caption sits above the time strip.
- Open the launch card and scroll it. The card names NAVAREA IV 1080/26, area A, the maritime window, the high-risk lead, and `SFC-UNL` for the TFR. Tap a polygon for the same facts. The card button is `Show site and assumed sector` because this catalog ascent is grade D. Tap it to frame the pad and the polygons.
- Outside the window, at `00:00:00Z`, the pin and the polygons are gone. After the 48 hour review they stay gone even when a later maritime day is on the notice.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`. The proxy is the local origin. Do not fetch `https://map.astroanil.dev` or `https://map.expedition75.com`.
- Tile requests use `isolateSnapRequests` (`scripts/context-state-fixture.mjs`): an image or a WMTS URL gets a 1 pixel PNG, and every other host outside the local origin is aborted. Do not point NASA hosts at `127.0.0.1`. A connection-refused GIBS answer leaves `isStyleLoaded` false until the 30s timeout. This drive does not fetch NASA tiles.
- One process is one viewport. Do not run `drive all`. Do not run a second WebKit process beside it.
- The clock is frozen at `2026-11-13T22:50:00Z` before the document loads, and the catalog `generated_at` is stamped once from that instant (one minute earlier). Do not move `Date.now` on that page. A later clock change rebuilds `generated_at` on the next catalog read, the store keeps the newer stamp, and later reads on that page are contaminated. Use a fresh context per clock.

`drive map` uses the verify fixture clock. It does not paint these polygons. The script stubs `/hazards/v2/launches.json` with the schema 2 fixture. It waits until that source has features and the map is not moving, then two frames, before the layout, popup, and camera assertions. The eight WebKit contexts, each created at that size, are:

```bash
OPD_VERIFY_VIEWPORT=402x874 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=874x402 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=834x1210 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=1210x834 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=1180x820 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=768x1024 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=1024x768 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=1440x900 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
```

iPhone is 402 by 874 and 874 by 402. iPad is 834 by 1210, 1210 by 834, 1180 by 820, 768 by 1024, and 1024 by 768. Desktop WebKit is 1440 by 900. `1180x820` and `1210x834` are not allowed `drive map` viewports. This script accepts them on its own list. Physical iPad Safari is unverified. The camera probe clicks `Show site and assumed sector`.

Stdout is `hazard layout <WxH> lines <n> hits 0 polygons 3 linestrings 0 vertices 30/16/6 tbc 1 note reachable tfr <n>`. At 874 by 402, `lines` is 2. Shots are `evidence/hazard-layout-<WxH>.png`.

`frontend/scripts/hazard-layout-check.mjs` is the intersection tool. It measures the caption client rects against `#map-launch-coverage`, the toolbar, the dock, the time strip, `#map-legend-toggle`, the legend panel, Hide, and the zoom group. Its built-in sizes are 1024 by 768, 1180 by 820, 834 by 1210, 874 by 402, and 402 by 874, WebKit then Chromium, one browser at a time. `HAZARD_ORIGIN` defaults to `http://127.0.0.1:5199`. Point it at the local proxy if that is the server. Block NASA hosts first. Do not edit that script from this skill.

The popup and the deferred camera are separate processes, still one viewport, still a fresh context per clock:

```bash
OPD_HAZARD_PROBE=popup OPD_VERIFY_VIEWPORT=1440x900 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_HAZARD_PROBE=camera OPD_VERIFY_VIEWPORT=1440x900 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
```

Popup stdout is `hazard popup <WxH> direct rewrite catalog kept open withdrawn closed`. Camera stdout is `hazard camera <WxH> wheel unchanged arrow unchanged`.

The notice text and the closed 48 hour cutoff stay on the unit files. They do not open a browser:

```bash
cd frontend && bun run test test/launch-hazards.test.ts src/map/features/launch-corridor/launch-corridor.test.ts
pytest tests/test_starship_flight15_hazards.py
```

## Publisher facts a verifier needs

The bundle is schema 2. The source cache `hazard-notices.json` is schema 5 (`STATE_SCHEMA_VERSION` in `generator/hazard_sources.py`). Schema 5 accepts a schema 4 snapshot for reconfirmation and discards schema 2 and 3 caches. `MAX_INSTRUCTIONS` is 4, in the generator and in `frontend/src/launch-hazards.ts`. An instruction or a listing longer than 400 characters fails closed. Strict confirmation raises `USCG_ROW`, `FAA_ROW`, or `NGA_ROW` for an unreadable relevant or uncertain row, including more than four instructions and an instruction over 400 characters. Non-strict parsing keeps `INSTRUCTIONS_OVERFLOW:<area_id>` and `INSTRUCTION_TOO_LONG:<area_id>`. Listing text over 400 characters raises `HAZARD_LISTED`. Any of those errors keeps the previous artifact and receipt and uploads nothing.

`_known_fields` is a typed whole-field allowlist. One key outside `_FAA_LIST_FIELDS`, `_USCG_FEATURE_FIELDS`, `_USCG_PROPERTY_FIELDS`, `_USCG_GEOMETRY_FIELDS`, or `_NGA_ROW_FIELDS` raises that source's row error and freezes the whole publication on last-good. The field is not dropped and the rest of the file is not published.

The offline replay of the saved corpus is 207 rows: 35 broadcast blocks, 64 FAA list rows, 23 USCG features, and 85 NGA rows in `frontend/test/fixtures/notices/`. Replayed through the strict parsers with no network, that corpus is 44 CONFIRM, 159 DROP, 4 ERROR, and 0 UNCERTAIN. CONFIRM includes a notice that parses with a diagnostic. DROP is `kind` `other` plus a non-space FAA list row. The four errors are strict `NGA_ROW` on NAVAREA IV 1099/26 and the three SPACE OPERATIONS list rows with no saved detail file, `6/7132`, `6/7114`, and `6/7113`.

A safe probe uses a fake `rclone` shim that refuses `sync` and any remote that starts with `r2:`. Do not pass `--publish`. Use a temporary `--cache-dir` and `--output`. At most one live read-only dry run is `python -m scripts.hazard_refresh --cache-dir <temp> --output <temp>` with no `--publish`. The default proof is the offline suite, not that fetch. Do not use real R2, real rclone, or Cloudflare. The Wallops and Vandenberg FAA fixtures, `tests/fixtures/hazards_r3/faa-wallops.xml` and `tests/fixtures/hazards_r3/faa-vandenberg.xml`, are synthetic with `origin="synthetic-regression"`.

```bash
python3 -m pytest tests/test_hazard_notices.py tests/test_hazard_r14_metadata.py tests/test_hazard_upload_safety.py tests/test_starship_flight15_hazards.py -q
```

## Gotchas

- A frozen clock and a catalog route that stamps `generated_at` from `Date.now()` do not share a page. Moving the clock bumps that stamp. The catalog store drops an older `generated_at` and holds the newer one, so a later read is not the clock you think it is. Open a new context.
- This script returns 404 for `/launch/latest.json` on purpose. That path is the schema 2 store. The schema 3 catalog is the pointer and the revision body. Painting stops at `checked_at + 48h` (`REVIEW_MAX_MS`). The Nov 13 review is `2026-11-13T10:02:00Z`, so that cutoff is closed and the Nov 19 window does not paint. The live drive freezes inside the Nov 13 window and does not move the clock.
- `drive map` and `drive all` leave this probe out. There is no `drive all` form of it.
- The hazard file is `globIgnores` `**/hazards/**` and a NetworkOnly runtime route. A 404 is not precached. `sw` does not fetch it.
- iPhone and iPad use a context created at the size above. Do not call `setViewportSize`. WebKit has no `Emulation.setSafeAreaInsetsOverride`, so the insets read 0.
- The TFR fit on iPad landscape is the clear sample count for area `6/7129` at 1024 by 768 and at 1180 by 820. A count of 0 means the polygon is under the card or off the canvas.
