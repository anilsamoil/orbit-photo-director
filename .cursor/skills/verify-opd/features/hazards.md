# Published hazard areas

#363 (`18a38bd`) draws the published Starship Flight 15 hazard polygons on the map. The file is `frontend/public/hazards/v1/0f867f0c-5422-4d44-93b8-d7faaae7019b.json`. It is not a catalog field and it is not a flight path. The notices are `frontend/test/fixtures/notices/navarea-iv-1080-26.txt` (NAVAREA IV 1080/26), `frontend/test/fixtures/notices/uscg-lnm-45-2026-starship-flight15.txt` (USCG LNM 45/2026), and `frontend/test/fixtures/notices/faa-tfr-6-7129.xml` (FAA TFR 6/7129).

## Sub-features

- `hazard-polygons` paints `launch-hazard-fill-layer` and `launch-hazard-outline-layer` from `/hazards/v1/` while Launches is on, the Starship pin is eligible, and the attempt overlaps a notice window. Every feature is a Polygon. A LineString is rejected and is not drawn. Area A is 30 vertices, area B is 16, and TFR 6/7129 is 6. The notice check is a closed ring against those three texts. Vertex mismatches are 0. The pad stays Watch, status `TBC`, direction none, and the shot list stays empty. `LAUNCH / WATCH` is the pin label.
- `hazard-windows` opens the TFR at 22:30Z and areas A and B at 22:45Z. The map pin and the polygons clear together at `2026-11-14T00:00:00Z` (`shows both at 23:59:59Z and neither at 00:00:00Z`). The notice text runs those maritime windows on to 00:40Z, and the same 22:45Z–00:40Z window repeats daily through 2026-11-19. Painting also stops at the review cutoff: `now >= checked_at + 48h` (`REVIEW_MAX_MS` in `frontend/src/launch-hazards.ts`). The Nov 13 review is `2026-11-13T10:02:00Z`, so that cutoff is closed and the Nov 19 window does not paint.
- `hazard-caption` is `#launch-hazard-caption`. The text is `Published hazard areas — not a flight path or navigation guidance` with U+2014. At 874 by 402 it wraps to two lines. It stays clear of `#map-legend-toggle` and `#map-launch-coverage` at all seven sizes below.
- `hazard-card` puts the notice facts on the launch card (`[data-hazard-note]`) and in the polygon popup. The card scrolls (`overflow-y: auto` on `#map-launch-coverage`), so a fact below the fold is reachable by scrolling. On iPad landscape the TFR polygon keeps a clear sample off that card.
- `hazard-popup` keys an open popup by notice identity plus `area_id` (`notice_id`, U+0000, `area_id`). Two area-A notices stay distinct. A direct `reloadLaunchHazards` rewrites the open popup in place when those keys are still painted. A page `refresh()` that still serves those notices leaves the popup open. A catalog refresh that withdraws the file (`404`) closes it.
- `hazard-focus` fits the pad and the polygons once, and keeps the current bearing. A wheel or an arrow while the fit is still deferred leaves center, zoom, and bearing where that gesture put them. A pan, a user zoom, leaving Launches, or another launch cancels the fit.

## How to get to it (user POV)

- Open Map on iPhone or iPad, or on the desktop window. Show the chrome. Tap Launches.
- Inside a published window the gold pad is Starship Flight 15, status `TBC · Tentative`, with no corridor line. The polygons sit around the Gulf, and the caption sits above the time strip.
- Open the launch card and scroll it. The card names NAVAREA IV 1080/26, area A, the maritime window, the high-risk lead, and `SFC-UNL` for the TFR. Tap a polygon for the same facts. Tap `Show published hazard areas` to frame them.
- Outside the window, at `00:00:00Z`, the pin and the polygons are gone. After the 48 hour review they stay gone even when a later maritime day is on the notice.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`. The proxy is the local origin. Do not fetch `https://map.astroanil.dev` or `https://map.expedition75.com`.
- Abort any host ending in `nasa.gov`. This drive does not fetch NASA tiles.
- One process is one viewport. Do not run `drive all`. Do not run a second WebKit process beside it.
- The clock is frozen at `2026-11-13T22:50:00Z` before the document loads, and the catalog `generated_at` is stamped once from that instant (one minute earlier). Do not move `Date.now` on that page. A later clock change rebuilds `generated_at` on the next catalog read, the store keeps the newer stamp, and later reads on that page are contaminated. Use a fresh context per clock.

`drive map` uses the verify fixture clock. It does not paint these polygons. The seven WebKit contexts, each created at that size, are:

```bash
OPD_VERIFY_VIEWPORT=402x874 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=874x402 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=1024x768 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=1180x820 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=768x1024 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=834x1210 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
OPD_VERIFY_VIEWPORT=1440x900 node .cursor/skills/verify-opd/scripts/hazard-overlay.mjs
```

iPhone is 402 by 874 and 874 by 402. iPad is 1024 by 768, 1180 by 820, 768 by 1024, and 834 by 1210. Desktop WebKit is 1440 by 900. `1180x820` is not an allowed `drive map` viewport. This script accepts it on its own list. Physical iPad Safari is unverified.

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

## Gotchas

- A frozen clock and a catalog route that stamps `generated_at` from `Date.now()` do not share a page. Moving the clock bumps that stamp. The catalog store drops an older `generated_at` and holds the newer one, so a later read is not the clock you think it is. Open a new context.
- `drive map` and `drive all` leave this probe out. There is no `drive all` form of it.
- The hazard file is `globIgnores` `**/hazards/**` and a NetworkOnly runtime route. A 404 is not precached. `sw` does not fetch it.
- iPhone and iPad use a context created at the size above. Do not call `setViewportSize`. WebKit has no `Emulation.setSafeAreaInsetsOverride`, so the insets read 0.
- The TFR fit on iPad landscape is the clear sample count for area `6/7129` at 1024 by 768 and at 1180 by 820. A count of 0 means the polygon is under the card or off the canvas.
