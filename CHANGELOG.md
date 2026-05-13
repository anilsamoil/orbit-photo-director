# Changelog

All notable changes to Orbit Photo Director.

## [1.2.3.0] - 2026-05-13

### V4-P2 aurora indicator: Kp index in the topbar with click-through to SWPC.

Chris visits NOAA SWPC's experimental aurora dashboard daily to check the Kp index (geomagnetic activity, 0-9 quasi-log scale; Kp 5+ = storm worth knowing about). This release surfaces Kp on map.astroanil.dev so he doesn't have to open a tab. Topbar widget shows "Kp 4.2" color-coded by storm level — green/yellow/orange/red — and clicks through to SWPC for the full oval map when the number is interesting.

### Architecture (locked down via /plan-eng-review + Codex outside voice)

The original plan included consuming the full OVATION oval (899KB) + computing "is aurora visible from ISS right now?" via look-angle geometry to 150km altitude. Codex's review flagged the visibility math as wrong — naive ISS-subpoint lookup ignores limb visibility (ISS sees auroras hundreds of km off-nadir) and daylight/twilight. Honest visibility math is a 6h project with a real test burden; the headline Kp number alone solves 80% of Chris's "save me a tab" need. v1 ships Kp-only. The oval + visibility prediction is deferred to v1.1 with Codex's findings baked in as known requirements (see TODOS.md V4-P2 entry).

### Added

- New `worker/src/aurora.ts` — `/api/kp` route handler. Proxies SWPC's `planetary_k_index_1m.json`, parses the latest valid row, edge-caches the response 5 minutes. ~80-byte JSON body (`{kp, timestamp, age_min}`).
- New `frontend/src/aurora.ts` — `fetchKpData()` + `kpToColorClass()` + `renderKpWidget()` + `initKpWidget()`. Pure module, fully unit-testable.
- New `worker/test/aurora.test.ts` (13 tests): parseKp schema-drift tolerance, edge-cache hit/miss, SWPC outage/parse/empty-array failure modes.
- New `frontend/test/aurora.test.ts` (21 tests): fetch failure modes, all 4 color-class boundaries, render null-state, tooltip age formatting (minute / hour-minute), click + keyboard activation, a11y attributes.

### How it's wired

- Worker route `/api/kp` registers next to the existing `/api/log` + `/api/health` handlers. CORS open (`access-control-allow-origin: *`) since Kp is public data.
- Edge cache TTL 300s for `200-299`; `400-599` capped at 60s so SWPC blips don't lock the edge for 5 minutes.
- Frontend fetches `/api/kp` from inside `refresh()`'s `if (isNewer)` block — same gate as tile-precache. Kp is a 3-hour smoothed value so hourly cadence is well over-spec on freshness. Worker's edge cache is the real freshness budget.
- Widget hides itself when `/api/kp` returns null (network error, SWPC outage past TTL, malformed JSON, parse failure). It's optional UI — never load-bearing, never throws a banner.
- Click and keyboard (Enter / Space) open `https://www.swpc.noaa.gov/communities/aurora-dashboard-experimental` in a new tab. `role="button"` + `tabindex="0"` for screen readers.
- Color thresholds match NOAA G-scale: 0-3 quiet (green), 3-5 active (yellow), 5-7 storm (orange), 7+ severe (red).

### Architectural decisions (recorded in design doc)

- **Data fetch path:** Cloudflare Worker proxy (not generator hourly cron, not frontend-direct). Decouples aurora's natural cadence from the existing hourly manifest tick.
- **Response shape:** Server-computed summary only (~80 bytes/refresh) — not the 10KB compact grid or 899KB raw OVATION. v1.1 will need the grid for live LOS-tolerant visibility lookups; v1 doesn't.
- **Failure mode:** Hide widget. Static SWPC link in HTML is the fallback. No banner, no toast.
- **ISS link budget:** ~80 bytes per hourly refresh ≈ 2KB/day. Negligible on Chris's Ku-band uplink.

## [1.2.2.1] - 2026-05-13

### Empty-Queue disambiguator: "why empty?" hint when the manifest is stale.

An empty Queue can mean two very different things to the operator: there genuinely are no qualifying passes in the next 90 minutes (orbital geometry), OR the manifest is so stale that every pick it once contained has aged past the Queue's 90-min window (generator lag). Before this release both showed the same "No passes in the next 90 minutes." copy, leaving Chris guessing whether to wait or check if the page is broken.

Now, when the manifest is 90+ minutes old AND the Queue is empty, the empty-state copy switches to: "Manifest is 1h 42m stale — generator has been slow. Next update due in 18m." Age + next-tick projection both surface, so the operator knows exactly what's happening and when to retry.

### Added

- New `src/empty-hint.ts` module with pure `emptyQueueHint(manifest, nowMs)` function. Returns the hint string when staleness is the unambiguous cause, else null.
- 8 unit tests covering threshold edges, hour-boundary formatting (`2h` not `2h 0m`), multi-hour ages, NaN-tolerance on `generated_at`, and clock-skew (future-dated manifest) cases.

### How it's wired

- 90-min threshold is intentionally higher than the existing `isStaleManifest` banner (60 min). The banner says "data may be slightly stale"; this hint says "Queue emptiness is BECAUSE of staleness, not geometry." Picks have a max 90-min Queue lifetime, so 90+ min old manifests have by definition outlived every pick they could serve.
- Next-tick projection assumes hourly generator cadence (`GENERATOR_TICK_INTERVAL_MIN = 60`). Computes `60 - (ageMin % 60)` so the figure is meaningful even at 2h+ ages — wraps to the next expected boundary instead of going negative.
- `renderQueue()` sets `empty.textContent` on every render, so the message updates live as the manifest ages or refreshes.

## [1.2.2.0] - 2026-05-13

### Tile pre-cache: the map works during LOS over Queue targets.

Chris (operator, 2026-05-05) reported the dropout: "the map doesn't work when you are LOS but you still get the upcoming targets." Loss-of-signal blacks out networking on the ISS side for stretches between passes, and the existing service-worker tile cache only held tiles the operator had already panned to. So a fresh target the operator hadn't looked at yet = blank map exactly when it matters.

This release pre-caches basemap and cloud tiles for the top-3 Queue targets at z6/z8/z10 (continent → region → metro) on every manifest version change. Eighteen tiles per refresh, fire-and-forget. When the operator next opens Map during LOS over one of those targets, the wider-context tiles are already in the service-worker cache.

### Added

- New `src/tile-precache.ts` module owning the precache logic + the GIBS/yesterday URL helpers (moved out of `map.ts` so `main.ts` doesn't drag the MapLibre vendor chunk into the main bundle).
- 23 unit tests covering slippy-map projection, top-N capping, GIBS zoom clamp, subdomain match, NaN guards, offline-skip, and in-flight dedup.

### How it's wired

- Pre-cache fires inside `refresh()`'s `if (isNewer)` branch — same gate that protects `saveSnapshot`. Manifests republish hourly, but the poll runs every 60s, so without the gate the precache would fire 60× more than budgeted. Now it fires once per version change, ~hourly.
- Carto subdomain matches MapLibre's deterministic `(x+y) % 4` pick. The service-worker Cache API keys by full URL including hostname, so a tile pre-cached as `a.basemaps...` would be a miss when MapLibre rotates to `b/c/d`. Now they agree, ~100% hit rate instead of ~25%.
- CORS mode (not `no-cors`) so the service worker sees real HTTP status codes. With opaque responses, status is always 0 — a 429 rate-limit from carto would have been cached as a "valid" tile for 7 days, blanking the map. The Lane F service-worker route's `cacheableResponse.statuses` is also tightened to `[200]` only.
- In-flight Set dedupes concurrent refresh ticks (visibility-resume can stack with the poll interval). Response bodies are explicitly cancelled to release ~450 KB of buffer per refresh instead of waiting on GC.
- `Number.isFinite` guard on lat/lon skips targets with bad coords. Tests in `main-integration.test.ts` mock the precache module so they don't fire real cross-origin fetches during CI.

The behavior change is invisible to the operator until they hit LOS over an imminent target — then the map renders instead of staying black. The risk surfaces caught by the multi-specialist /review (subdomain mismatch, 60× polling, opaque-cache failures) would all have defeated the feature within day one of deployment.

## [1.2.1.1] - 2026-05-11

### Map zoom-in for terrain detail (no more blank tiles past z20).

Chris (operator, 2026-05-05) asked: "can you allow it to zoom in a bit more for detail (and maybe even orient the map relative to ISS track)? The use case is to help you zero in on the target — I will sometimes have Google Maps up when I'm in WORF to try to pick out mountains or features that can lead me to my desired shot."

Root cause: the carto basemap source had no explicit `maxzoom`. MapLibre defaults to fetching tiles at every zoom up to the map's max (22). Carto's `dark_all` retina raster only serves up to z20; above that the requests 404 and MapLibre rendered blank squares. From the operator's POV: try to zoom in past a certain point, the map goes black.

### Fixed

- `carto-dark` source: `maxzoom: 20`. MapLibre now overzooms the z20 tile beyond that (slightly pixelated, but always shows terrain rather than blanks). Operator can zoom freely without hitting black tiles.
- `gibs-clouds` source: `maxzoom: 9`. GIBS true-color VIIRS at GoogleMapsCompatible_Level9 caps at z9. Same overzoom logic — cloud overlay stays visible (pixelated) above z9 instead of going blank.

Two-line config change. Pairs with v1.2.1.0's ISS-up toggle as the V4-P2 map polish round informed by Chris's WhatsApp feedback.

## [1.2.1.0] - 2026-05-11

### ISS-up toggle on the map: rotate so direction-of-travel points up.

Chris (operator, 2026-05-05) described his mental model in WORF as "I'm looking down, this is what's coming next." North-up is the geographic convention but it's the wrong frame for an operator scanning for a target as the ISS approaches it. This release adds a toggle next to the existing Now / +90 min controls.

Tap **ISS↑** and the map rotates so the ISS's current direction-of-travel is at the top of the screen. The bearing updates every second so the rotation stays accurate as ISS arcs around the planet (heading drifts ~1°/min). Tap **N↑** to return to the standard north-up view.

The preference persists to localStorage, so once Chris flips it on it stays on across reloads. Default is N↑ — operators new to the page see the conventional view first.

### How it's wired

- `greatCircleBearingDeg(lat1, lon1, lat2, lon2)` — standard spherical formula. Sample the polynomial fit at `now` and `now + 30s`, compute the great-circle bearing between the two positions. ISS travels great circles, so the right formula avoids antimeridian + polar weirdness that flat-Earth `atan2(Δlat, Δlon)` would introduce.
- The 1Hz live-marker tick now also calls `applyBearing(false)` when ISS-up is on. No animation on the per-tick update — the per-second rotation is sub-degree and would jitter visibly.
- User-initiated toggle uses `map.easeTo({ bearing })` for a smooth 600ms rotation so the operator sees it as intentional, not a glitch.

### Verified

- 7 new tests on `greatCircleBearingDeg`: cardinal directions, range invariants (0..360, finite), antimeridian + near-pole, realistic ISS-pair sample.
- 227/227 frontend tests pass.

### Added

- `ISS↑` / `N↑` toggle in the map controls (top-right, below the existing time toggle).
- `greatCircleBearingDeg` exported helper in `map.ts`.
- `BEARING_PREF_KEY` localStorage entry to persist operator preference.

### Changed

- The map's 1Hz live tick now calls `applyBearing` when ISS-up is on so the rotation tracks the live ISS heading.

## [1.2.0.2] - 2026-05-11

### Score breakdown panel now stays open across the 1Hz tick.

Caught immediately after v1.2.0.1 went live: tapping the score breakdown opened the panel for ~1 second, then the next `rerenderCountdowns` tick rebuilt all the cards from scratch and silently closed it. The user would have seen the breakdown flash open and disappear — a worse UX than not having the feature at all.

### Fixed

- `card.ts` now tracks open-breakdown state in a module-level `OPEN_BREAKDOWNS` Set keyed by `(target_id, closest_approach)`. Each card render (including the 1Hz tick) checks the Set and re-applies the open state. Toggle handler updates the Set on click.
- 3 new tests cover the persistence behavior: open survives re-render, close removes the persistent state, open state is per-card (different target_ids keep their own panel state).

220/220 tests pass. Same root cause as TODOS:111 ("Per-second full re-render of all cards") but solved locally for this feature without rewriting the render loop.

## [1.2.0.1] - 2026-05-11

### Queue and Upcoming now explain themselves; tap any score for the breakdown.

Chris (operator, 2026-05-10): "I think I don't fully understand the queue vs upcoming and the scoring, but it generally makes sense!" This release answers both questions inline so he doesn't have to remember.

Each tab now has a header explaining what it shows and how scoring works:
- **Queue** — "Next 90 min — what to shoot now. Cloud: observed (MODIS / GOES-IR / Meteosat / Himawari)."
- **Upcoming** — "Next 24 hours — what to plan for. Cloud: forecast (GFS, hourly). Less certain by design."

Each card's score line is now a button. Tap it and a breakdown panel expands underneath with all 5 components: p(unobstructed), regime fit, nadir proximity, priority weight, TLE freshness. Each component shows the value (0-100) plus a one-line plain-English context — "ISS 234 km off target," "target priority 5/5," "track confidence; 1.0 = fresh, 0.5 = days old," etc. The composite score is shown as the table footer so the math arrives at the score line above.

No new data fetched. Everything in the breakdown was already on `PassEntry.score_components` from the generator; we're just exposing it.

### Verified

- 217/217 frontend tests pass (was 210 + 7 new breakdown tests).
- Local headless preview confirms the new pane headers render on both Queue and Upcoming.
- Backward compat: older PassEntries with `score_components` (every version since V1) work unchanged.

### Added

- Pane header on the Queue tab (matching the Upcoming pane header introduced in V2).
- Click-to-expand score breakdown table on every card. Button-style score line, chevron rotates 180° when open, breakdown panel renders inline below.
- 7 new tests in `frontend/test/card.test.ts`: button shape, default-hidden, click-to-open, double-click-toggle, 5-component table + composite footer, dynamic nadir-km contextualization, regime='any' wording.

### Changed

- Upcoming pane header copy: now matches the Queue pane structure ("Next 24 hours — what to plan for" + cloud-source clarification + tap-for-breakdown hint).
- `.card-score` is now a `<button>` with focus styles + cursor pointer + faint hover background. Same visual rhythm as before, plus discoverable interactivity.

## [1.2.0.0] - 2026-05-11

### **V3.0 ships rocket-launch photography. The ISS planner now surfaces overhead launches in the Queue.**

When a Falcon 9, Soyuz, or any other rocket launches AND the ISS happens to be passing within ~800 km of the launch site at T-0 ±5 min, you'll see a 🚀 LAUNCH card in the Queue (or Upcoming for launches more than 90 min out). The card shows the rocket name, the NET-window confidence (`T-0 exact` or `Window: ±15 min`), and the same nadir-distance + WORF/Cupola tags every other pass card carries. Launches go through the same pass-finding + cloud-scoring pipeline as ground targets, so an overhead launch with clear skies scores the same way an overhead Tokyo pass does.

The product reason: launch shots are visually iconic and inherently rare (3-10 per year geometrically qualify for ISS). They were the obvious next thing to surface after V2's offline-resilience work landed. Chris (operator) and the rest of the crew can plan a launch shot the same way they plan any other.

### What changed for the user

- **🚀 LAUNCH cards in Queue + Upcoming.** Orange tag, leftmost in the meta row. Adjacent chips show the rocket family and NET-window confidence.
- **Reserved-slot guarantee** in both Queue (next 90 min) and Upcoming (next 24 h). If a launch qualifies geometrically and falls in the time window, it appears even when 5 priority-5 ground targets outscore it. The product would lose its purpose otherwise: a once-a-year overhead Falcon 9 buried under 5 Tokyo passes is the worst-case product failure.
- **Stale-launches banner overlay.** When the LL2 (Launch Library 2) feed has been unreachable for >24 h, the topbar gets a `🚀 launches stale Nh` suffix on top of whatever banner is showing (LOS, TLE drift, etc.). Operator knows the launches feature is degraded without having to inspect anything.
- **Banner copy: `Offline · X ago` → `LOS · X ago`.** Chris asked: LOS (Loss of Signal) is the operational term on ISS, reads more clearly at a glance during a real LOS window than the generic `Offline`.

### How it's wired

Each upcoming launch from LL2 gets treated as a synthetic target: launch site coords + priority=5 + the existing `find_passes` window of ±5 min around T-0. If pass geometry qualifies, the pass goes through the same `score_pass_for_target` pipeline as ground targets and gets tagged with a `launch` field on the resulting `PassEntry`. The frontend renders the 🚀 LAUNCH chip when `launch` is present; older v1.0/v1.1 snapshots without the field render normally.

LL2 health (last_successful_fetch + count_upcoming + schema_hash) folds into the existing `status.json` artifact rather than a separate `launches-health.json`. One source of truth for "did the last tick succeed at fetching X." The schema_hash is a depth-2 sorted-keys fingerprint that catches added or removed top-level / per-result fields without false-positiving on value-only changes.

### The numbers that matter

Verified by running the full 480-test suite (270 generator + 210 frontend) on merged HEAD, and `scripts/verify-sw-upgrade.sh` against the live deploy.

| Metric | v1.1.0.2 | v1.2.0.0 | Δ |
|---|---|---|---|
| Generator tests | 197 | 270 | +73 (V3 + LL2 hardening) |
| Frontend tests | 190 | 210 | +20 (launch-card + banner overlay + queue-filter) |
| Total tests | 387 | 480 | +93 |
| New generator module | — | `launch_data.py` | +281 lines |
| Status.json fields | 12 | 16 | +4 (launches_*) |
| Frontend bundle (gzip, app chunk) | 18.70 kB | ~18.9 kB | +0.2 kB (1%) |
| New banner overlay tier | — | `bannerWithLaunchesOverlay` | matches `bannerWithTleOverlay` precedent |

The bundle growth is the launch-tag rendering + Status type extension + banner overlay factory. 1% gzip cost for a new feature with full backward compat for older snapshots is honest.

### Adversarial review caught + fixed (in same PR)

The /review pipeline ran four specialists (testing, maintainability, security, adversarial). Two MULTI-SPECIALIST-CONFIRMED findings + 5 high-confidence single-source findings auto-fixed before ship:

- **NaN/Inf coordinate parsing.** `float("NaN")` parses cleanly but breaks `json.dumps` AND silently drops launches from filtering (NaN < N is always False). Fixed: `math.isfinite` + bounds check on lat/lon in `_parse_one_result`.
- **NET window vs PASS window mismatch.** Original 1800s NET cap allowed launches with ±30 min uncertainty into the pipeline, but `find_passes` searches only ±5 min around T-0. A 30-min-uncertain launch's real T-0 could fall outside the searched window. Tightened `NET_WINDOW_MAX_SECONDS = PASS_WINDOW_SECONDS` so the cap can never exceed search reach.
- **Past-t0 rejection.** LL2 occasionally surfaces completed launches in the upcoming feed; cache-fallback after weeks of LL2 downtime would re-publish them. Added past-t0 filter at parse time.
- **Cache-fallback re-filter.** _from_cache now uses `now=n` to drop past-t0 rows on every cache read.
- **bannerWithLaunchesOverlay loading-state guard.** Cold start with stale launches signal would have upgraded `Loading…` → orange and surfaced the overlay before any data fetched. Now passes loading state through unchanged.
- **ARCH-4 extension to Queue.** Original eng-review locked reserved-slot to Upcoming; adversarial caught that imminent launches (the highest-stakes case) would still get buried by score in Queue. Added `_reserve_launch_slot_in_queue` + 5 tests.

### V2-P0 SW upgrade verification piggybacks on this deploy

The V3 deploy is the natural "v2 deploy" for the V2-P0 SW upgrade test recipe in TODOS. New artifacts ship with this PR:

- `scripts/verify-sw-upgrade.sh` — 6-section / 15-check headless verifier. Validates against the live URL post-deploy: SW shape (skipWaiting yes, clientsClaim no), runtime cache strategies + names, PWA manifest reachability, registerSW.js auto-injection. Already validated against current live (15/15 PASS pre-V3 deploy).
- `docs/SW_UPGRADE_VERIFY.md` — 6-section eyes-on-glass checklist for the things headless can't see (multi-tab controller race, snapshot survival across upgrade, tile cache survival, PWA install drift).

### Verified

- 270/270 generator tests pass on merged HEAD.
- 210/210 frontend tests pass.
- `bun run build` clean: dist/sw.js still has `skipWaiting()` ×1, zero `clientsClaim()`.
- Live `map.astroanil.dev` (currently v1.1.0.2): `/qa` smoke against all 4 tabs, 0 console errors, queue-filter hotfix working as designed.
- `scripts/verify-sw-upgrade.sh` against live: 15/15 PASS.

### Known follow-ups (NOT in this PR)

- V3.1 ASCENT geometry (rocket climbing through atmosphere): per-rocket profiles, terminator gate, slant-range cap, multi-point cloud sampling. Filed as V3-P2 in TODOS. Revisit after V3.0 has run for ~4 weeks against real launches.
- V3-P3 `make ll2-diff` for schema-drift diagnosis when the alert fires.
- V4 operator wishlist from Chris (filed as V4-P2): map zoom-in for terrain detail, rotate-to-ISS-track toggle, NOAA SWPC aurora indicator, pre-cache tiles for upcoming targets.
- V4-P2 explainer copy + click-to-expand score breakdown ("I think I don't fully understand the queue vs upcoming and the scoring" — Chris).
- V4-P3 stale-manifest hint when Queue is empty.
- V2-P3 launch-site water heuristic override (Vandenberg-as-water artifact in `cloud.py:138`).

### Itemized changes

#### Added

- `generator/launch_data.py`: LL2 fetcher + `Launch` dataclass + filters + `compute_schema_hash` + cache-fallback discipline matching `fetch_tle`. NaN/Inf coordinate guards. Past-t0 rejection.
- `generator/main.py`: launch pipeline integration in `run_tick`. `_synthesize_launch_target` + `_reserve_launch_slot` + `_reserve_launch_slot_in_queue` + `_insert_soonest_if_missing` shared helper.
- `tests/fixtures/ll2-response-2026-05.json`: pinned LL2 schema fixture (4 launches, exercises filter rules).
- `tests/test_launch_data.py`: 30 tests covering parse, filter, schema-hash drift detection, cache-fallback, NaN/Inf rejection, past-t0 rejection, NET window invariant.
- `tests/test_main.py`: 12 new integration tests covering the launch pipeline + status.json fields + reserved-slot logic for both Queue and Upcoming.
- `frontend/src/types.ts`: `PassEntry.launch?` + 4 optional `Status` launches_* fields. Backward-compatible with v1.0/v1.1 snapshots.
- `frontend/src/card.ts`: 🚀 LAUNCH + rocket name + window confidence chips. New `formatLaunchWindow` helper.
- `frontend/src/banner.ts`: `bannerWithLaunchesOverlay` matching the `bannerWithTleOverlay` precedent. Pass-through on loading state.
- `frontend/src/style.css`: `.tag.launch-overhead`, `.tag.launch-rocket`, `.tag.launch-window` (orange-on-dark to match the rocket-flame mental model).
- `frontend/test/launch-card.test.ts`: 12 new tests (formatLaunchWindow + render + backward compat).
- `frontend/test/banner.test.ts`: +7 launches-overlay tests including loading-state guard + three-way composition (offline + TLE + launches).
- `scripts/verify-sw-upgrade.sh` + `docs/SW_UPGRADE_VERIFY.md`: V2-P0 SW upgrade verification artifacts.

#### Changed

- Banner copy: `"Offline · X ago"` → `"LOS · X ago"` across 4 messages. Red-state copy `"data may be very stale"` → `"data may be very old"` to avoid the redundant "stale" reading.
- Banner state machine: `bannerOffline`'s 4 levels (green / yellow / orange / red) now use LOS terminology throughout including doc-comments.
- `frontend/src/main.ts:refresh()`: now fetches `status` alongside the other artifacts (Promise.all with .catch fallthrough so older manifests without status.json don't break the path). Threads `launchesStaleHours(status, now)` through all 4 `setBanner` sites.
- `frontend/src/snapshot.ts`: status field now populated (was always null pre-V3).
- `generator/main.py:run_tick`: `status_data` gains `launches_last_successful_fetch`, `launches_count_upcoming`, `launches_count_pass_opportunities`, `launches_schema_hash`.

#### Fixed

- `frontend/src/main.ts`: `renderQueue` and `renderUpcoming` filter past `closest_approach` entries at render time. Was shipped as v1.1.0.2 hotfix; included here for completeness of the v1.1 → v1.2 release notes.
- `frontend/src/manifest.ts:fetchManifest`: dropped `?cb=${Date.now()}` query buster (silently defeated SW NetworkFirst manifest cache via Workbox's exact URL match). Was shipped as v1.1.0.1.
- TODOS.md: 3 V3-related (ASCENT V3.1, ll2-diff, Lane H V2-P0 overlap note) + 5 V4-P2/P3 (Chris's WhatsApp feedback) + 1 V2-P3 (Vandenberg-as-water).

#### For contributors

- New `compute_schema_hash` module pattern: depth-2 sorted-keys fingerprint of an external API response. Reusable for any feed where you want to catch shape drift without false-positiving on value changes.
- New `_insert_soonest_if_missing` shared helper: parameterizes the reserved-slot pattern across Queue and Upcoming filters. If V3.1 ASCENT lands, the same helper handles "reserve a slot for the next ASCENT" without needing a third specialized function.
- `scripts/verify-sw-upgrade.sh` is repeatable for V4/V5 deploys — V2-P0 becomes "just a thing we always run" rather than a one-off recipe.

## [1.1.0.2] - 2026-05-10

### Hide already-happened passes from Queue + Upcoming

Chris (operator) reported via WhatsApp 2026-05-10: "Occasionally, all of the queue items will be in the past — not sure why." Screenshot showed 4 cards in the Queue tab, every one tagged "Past." Confirmed expected behavior of the existing code: the generator publishes top5 as the next-90-min slice from when the manifest tick ran. By the time the user looks 30-60 min later, the highest-scored picks have happened. The cards rendered with a "Past" countdown text but stayed visible — the user (correctly) wondered what they were supposed to do with cards they could no longer shoot.

### Fixed

- `renderQueue` and `renderUpcoming` now filter out passes whose `closest_approach` is in the past before rendering. The 1Hz `rerenderCountdowns` tick re-evaluates the filter, so the moment a pass transitions to past it disappears from the list (no flicker of "Past" text first).
- When the entire Queue is past-filtered to empty, the existing "No passes in the next 90 minutes." empty state shows — accurate now since they really have all happened.
- Upcoming gets the same filter as defense-in-depth for very stale manifests (>90 min old, where Upcoming entries can also leak into the past).

3 new tests in `frontend/test/main-integration.test.ts` (past-only Queue → empty state; mixed Queue → only future renders; Upcoming filter symmetry). 190/190 tests pass.

Note: the `Offline → LOS` banner rename Chris also asked for is bundled into the V3.0 ship (`feat/v3-rocket-launches`), not this hotfix.

## [1.1.0.1] - 2026-05-05

### Workbox service worker — the V2 offline story now works on first visit too.

V2 made the page survive LOS by booting from a localStorage snapshot. That works for any user who's loaded the page once. This release adds a Workbox-generated service worker so the precached app shell, the live manifest.json, the versioned artifacts, and the basemap tiles all stay reachable when the network is dead — including on a fresh tab where there is no snapshot yet.

### What changed for the user

- **First-visit-then-LOS recovery.** With the SW installed, opening a fresh tab during LOS now serves the cached app shell + manifest + last-known artifacts instead of a blank page. The snapshot path still wins on returning visits (single-digit-ms render); the SW path fills the gap on the first one.
- **Tile cache survives LOS.** Carto basemap tiles cached for 7 days, GIBS true-color tiles for 24 h. The map keeps rendering tiles you've panned over even with the network off.
- **Multi-tab safety.** `skipWaiting: true` + `clientsClaim: false` means new SWs activate on install but only take over a tab on its next navigation. Two tabs open across a deploy: the new one gets the new code, the old one keeps the code it loaded with. No "new SW + old JS in same tab" race.

### How it's wired

- `vite-plugin-pwa` in `generateSW` mode. Routing rules: manifest NetworkFirst (2 s timeout), versioned artifacts CacheFirst, Carto/GIBS tiles CacheFirst LRU-bounded, `POST /api/log` NetworkOnly (so the existing offline-queue in calib.ts keeps owning the queue path).
- Adversarial review caught two issues that were fixed in the same PR: `fetchManifest()` was sending `?cb=${Date.now()}`, which silently defeated the SW NetworkFirst rule via Workbox's exact-URL match — fixed by relying on the existing `cache: 'no-cache'` header. `workbox-window` was a declared runtime dep but never imported — dropped to transitive only.

### Numbers

| Metric | v1.1.0.0 | v1.1.0.1 |
|---|---|---|
| Generated SW | none | dist/sw.js (2.4 KB) + workbox-*.js (23 KB) |
| Precached app-shell entries | 0 | 8 (~909 KB) |
| Runtime cache rules | 0 | 5 (manifest, versioned artifacts, Carto, GIBS, /api/log opt-out) |
| Frontend test count | 187 | 187 (manifest test updated for the no-cb contract) |
| Bundle (gzip, app chunk) | 18.71 kB | 18.70 kB (unchanged) |

### Verified

- 187/187 vitest tests pass on merged HEAD.
- Real-Chrome SW lifecycle: registers + activates, caches populate (workbox-precache=8, opd-manifest=1, opd-versioned-artifacts=3), offline reload renders 15 cards from SW + snapshot, upgrade lifecycle keeps existing tabs on their old SW until navigation.
- Static SW analysis: `dist/sw.js` contains `skipWaiting()` (1×), zero `clientsClaim()` calls.

### Added

- `vite-plugin-pwa` with Workbox-generated service worker (`frontend/vite.config.ts`).
- PWA manifest (`dist/manifest.webmanifest`) with inline-SVG icon (real PNG icons remain V2-P3 polish).
- Runtime caches: `opd-manifest`, `opd-versioned-artifacts`, `opd-tiles-carto`, `opd-tiles-gibs`.

### Fixed

- `fetchManifest()` no longer appends `?cb=${Date.now()}` — defeated the SW NetworkFirst manifest cache because Workbox does exact URL matching by default.
- Removed `workbox-window` from declared dependencies (was never imported; vite-plugin-pwa pulls it in transitively for the build pipeline).

### Known follow-ups (NOT in this PR)

- V2-P3 polish: real PNG icons (192×192, 512×512, maskable) for full PWA installability across Chrome / iOS Safari validators.
- Lane G: kill-switch DNS (needs DNS write access).
- Lane H: pre-launch e2e checklist (manual; blocked by F + G complete).

## [1.1.0.0] - 2026-05-04

### **V2 ships — the page works when the network doesn't.**
### Open the tab on the ISS during a 30-minute LOS window and the queue still renders.

The frontend now boots from a localStorage snapshot before manifest.json comes back. If the fetch fails, the snapshot keeps showing. If the fetch only half-succeeds (manifest loads but a track artifact 404s mid-deploy), the previous snapshot stays intact — no torn writes. The live ISS dot keeps moving past the 120-min polynomial window via client-side SGP4 propagation. The banner color escalates with snapshot age (green<1h → yellow<3h → orange<12h → red beyond) so the user always knows how trustworthy what they're looking at actually is.

The shipped V1 had a single failure mode: tab refresh during LOS = blank page. V2 makes that an "Offline · 23 min ago" badge with the full last-known-good queue rendered from disk. For an 8-month unattended mission with routine 30-60 min LOS windows, that's the difference between "the page is dead for hours" and "the page is honest about being a few minutes stale."

### The numbers that matter

Measured from the locked V2 plan (`~/Desktop/orbit-photo-director-offline-v2-plan.md`) and verified by `/qa` against `localhost:5173` (vite dev) and `localhost:4173` (vite preview, production build).

| Metric | V1 | V2 | Δ |
|---|---|---|---|
| Page after LOS refresh | Blank "Loading..." | Snapshot UI in <50ms | ∞ |
| Live ISS dot past 120 min | Frozen ("track expired") | SGP4 propagation, no horizon | unbounded |
| Manifest poll while tab hidden | Every 60s wasted | Paused; resumes immediately on visible | -100% bandwidth on hidden tabs |
| Snapshot writes per 60-min tick | Every 60s = 60 writes | 1 (skip-if-version-unchanged) | -98% localStorage churn |
| Frontend test count | 113 | 187 | +65% |
| Bundle (gzip) | 17.92 kB | 18.71 kB | +0.79 kB (4%) |
| Bundle (raw, satellite.js v6) | 42.79 kB | 43.83 kB | +1.04 kB |

The bundle growth is satellite.js v6 (~30 kB raw, ~6 kB gzip) plus the V2 modules (snapshot, network-status, banner state machine, the boot orchestration). 4% gzip cost for a fully-offline-resilient frontend is a good trade.

### Real bugs caught + fixed during the ship cycle

`/review` and `/qa` together caught and fixed:
- A hostile/torn-write snapshot would have permanently bricked the page across reloads (boot threw inside `bootFromSnapshot`, `pollScheduler` never started, reload re-read same poison). Recovery: try/catch + `clearSnapshot`.
- Snapshot version monotonicity: a CDN edge serving a stale manifest could overwrite a newer snapshot with older data. Fix: only save when manifest.version > on-disk version.
- SGP4 NaN propagation would render "NaN°N, NaN°W over Pacific Ocean" in the topbar from a degenerate propagation. Fix: NaN guards + roughRegion fallback.
- TLE epoch verification: an attacker-swapped TLE for a different object that parsed cleanly would produce confidently-wrong ISS positions. Fix: cross-check satrec epoch against manifest's tle_epoch within 2s.
- `obs Nm ago` tag was functionally dead — generator was shipping the future pass time as `sample_time`, so frontend's age formatter silently hid the tag. Fix in generator: ship the imagery composite hour for observed sources.
- Pending-sync badge rendered as a "_" / "•" artifact next to the Log tab (CSS `display: inline-block` overrode `hidden`). Fix: explicit `[hidden] { display: none }`.
- satellite.js v7 added a top-level-await WASM path that broke `vite build`. Pinned to v6 (same JS API, no WASM).

### What this means for the 8-month mission

The realistic worst case used to be: ISS in LOS, user refreshes the tab, page goes blank, user has no idea what's about to be photographable. After V2: page renders the previous snapshot in <50ms with a banner saying "Offline · 23 min ago — last sync recent" (green). The user keeps planning. When network comes back, the snapshot transparently updates. If the Mac on Earth dies entirely, the snapshot keeps the queue alive for hours; SGP4 keeps the live ISS dot moving even days past the polynomial window, with a TLE>48h overlay banner warning of drift.

V2-P1 (still deferred): Workbox service worker (Lane F), kill-switch DNS at reset.astroanil.dev (Lane G), pre-launch e2e checklist (Lane H). See TODOS.md.

### Itemized changes

#### Added

- **Boot from localStorage snapshot** — synchronous queue + map render before manifest.json comes back. First paint shows the previous-known-good UI within milliseconds instead of "Loading..." until the network resolves (or never resolves during LOS).
- **SGP4 client-side fall-through** — when the polynomial window expires (120 min past manifest), the live ISS dot keeps moving via satellite.js SGP4 propagation against the source TLE shipped in `track.json`. Coordinate frame matches the Python generator (geocentric spherical from ECEF) so the handoff is seamless.
- **Visibility-aware poll scheduler** — `createPollScheduler` pauses manifest fetches when the tab is hidden, fires immediately on visible-again. Saves ISS bandwidth on tabs nobody is watching.
- **Offline-confidence banner** — color escalates with snapshot age: green (<1h, "Offline · Nm ago — last sync recent"), yellow (1–3h), orange (3–12h, "values may be drifting"), red (>12h, "data may be very stale"). TLE>48h adds an orange overlay ("TLE 72h old — live track may drift").
- **`obs Nm ago` cloud-age tag on cards** — shows how recent the cloud reading is so the user can weight day-old MODIS vs 10-min GOES-IR appropriately. Hidden silently when the cloud_source is a no-observation placeholder (the existing "no cloud obs" tag handles that case).
- **Pending-sync badge in Log tab** — "Log [3]" when calibration writes are queued offline. Updates immediately on every Shoot/Skip click and after `drainQueue`.
- **Map imagery-date badge** — "Imagery: 2026-05-03" overlay in the bottom-right of the map so a GIBS tile cached past midnight doesn't read as today's clouds.

#### Changed

- **Generator ships source TLE in `track.json`** — alongside the polynomial fit, so the frontend can SGP4-propagate client-side without a separate fetch.
- **Generator ships per-pass `sample_time`** — the actual imagery composite hour (not the pass time) for observed sources, so the frontend's `obs Nm ago` tag works. Forecast samples keep the forecast valid-time.
- **Transactional refresh** — `refresh()` in main.ts mutates `currentManifest`/`Top5`/`Track` only AFTER all artifacts resolve (`Promise.all`). A partial fetch failure leaves the previous snapshot untouched. Idempotent saveSnapshot: skips writes when manifest.version is unchanged (~98% fewer localStorage writes per 60-min tick).
- **`refresh()` short-circuits when `navigator.onLine` is false** — saves the doomed fetch + the error-banner flash on every poll while LOS.
- **Polynomial accuracy documented** — the existing order-11 fit has up to 1.1° lat error vs SGP4 truth (Runge wobble near window edges). SGP4 fall-through is provably the more accurate path. Documented inline in `frontend/test/iss-sgp4.test.ts`; tracked as V2-P2 ("tighten polynomial OR drop for SGP4-only") in TODOS.md.

#### Fixed

- **Hostile/torn-write snapshot brick recovery** — `init()` now wraps `bootFromSnapshot` in try/catch + `clearSnapshot` on failure. A malformed snapshot (Chrome crash mid-setItem, browser extension, schema drift) used to permanently brick the page across reloads.
- **Snapshot version monotonicity** — only writes when `manifest.version > existing snapshot version`. A CDN edge serving stale data couldn't overwrite a newer snapshot before this.
- **SGP4 NaN guards + TLE epoch verification + whitespace tolerance** — NaN-typed positions from degenerate propagations no longer render "NaN°N, NaN°W"; satrec epoch is cross-checked against manifest's `tle_epoch` (defends against attacker-swapped TLEs); TLE lines are trimmed before parsing (defends against `\r` from Windows-edited cache files).
- **Safe card lookup** — `onCardAction` uses dataset comparison instead of CSS-selector interpolation; a target_id with `"` would have crashed `querySelector` and silently swallowed the toast.
- **Clock-rollback clamp on snapshot age** — backward NTP correction during long offline period no longer renders "Offline · -50 min ago" misleading text.
- **`obs Nm ago` tag now actually renders** — generator shipped pass time (always future) as sample_time; tag was silently hidden for every observed source. See "Changed" above.
- **Pending-sync badge "_" artifact** — CSS `display: inline-block` overrode `hidden`. Explicit `.pending-badge[hidden] { display: none }` rule fixes it.

#### For contributors

- **187 frontend tests** (was 113) — `iss-sgp4.test.ts` (10), `snapshot.test.ts` (15), `network-status.test.ts` (10), `main-integration.test.ts` (11) for boot/refresh/banner/badge integration. `iss.test.ts` extended with `liveIssNow` combined-path tests. `card.test.ts` extended with `formatObsAge` boundary tests + `obs-age` tag rendering tests. `banner.test.ts` extended with offline + TLE overlay tests. `calib.test.ts` extended with `queuedCalibCount` tests. `map-imagery-date.test.ts` for the new badge.
- **228 python tests** (was 162) — `test_main.py::test_run_tick_track_includes_tle` for the new generator field, `test_score_pass_for_target_uses_composite_hour_for_observed_sample_time` regression test for the obs-age fix, plus expanded coverage in `tests/test_main.py`.
- **satellite.js pinned to v6.0.2** — v7 added a WASM-pthreads runtime with top-level-await that broke `vite build` (iife output doesn't support TLA). The v6 JS API is identical for the four functions we use.
- **`frontend/src/vite-env.d.ts` added** — so TypeScript knows about `import.meta.env.MODE` for the test-mode auto-init guard in `main.ts`.
- **TODOS.md restructured** — V3 → V2 naming aligned with what shipped. Lanes F/G/H captured as V2-P1; sha256 verification + polynomial tightening as V2-P2; forecast-horizon UI tag + periodic satrec re-parse as V2-P3.
- **`frontend/public/` and `uv.lock` gitignored** — public/ is a dev-only artifact mirror used by /qa; uv.lock is the Python lockfile that was supposed to be ignored per V1 checkpoint intent.

## [1.0.0.0] - 2026-05-03

### V1 ships — Earth-photography planner for the ISS, end to end.

A Mac on Earth runs a 60-min loop: pull the ISS TLE, propagate every pass over your target list for the next 24 hours, sample observed cloud cover from four satellite sources, score every pass against the GFS forecast for far passes, and atomically publish a manifest to Cloudflare R2. A glanceable web app at map.astroanil.dev tells you what's about to be under the station, what you can plan for tonight + tomorrow, and whether it's worth raising the camera. Calibration writes flow back to a token-gated Cloudflare Worker so a second-pass scoring model can be tuned from the post-mission archive.

### Added

- **Shot queue** — top 5 imminent passes (next 90 min), scored on regime fit (day / night / terminator), nadir proximity, target priority, and probability of a clear shot. Each card shows countdown, observed cloud class, score, and a colored badge marking whether the pass is a WORF shot (nadir window, <30° off-nadir, purple) or Cupola shot (≥30°, panoramic dome, orange). Shoot/Skip emits a calibration record; toast confirmation tells you whether it synced or queued offline.
- **Upcoming tab** — top 10 passes spanning the next 24 hours, scored against the GFS cloud forecast at each pass time. Forecast cards have a soft yellow countdown and a "forecast" tag so you can tell observed-now from forecast-later at a glance. Lets you set an alarm for the 4am pass over the Himalayas tomorrow.
- **Map view** — MapLibre canvas with Carto dark basemap, NASA GIBS true-color overlay, 2-orbit ISS ground track polyline (200 min, raw SGP4 samples — no fit drift past the polynomial window), target markers colored by score, and a stylized ISS-silhouette marker (central white truss + cyan solar arrays + pulsing halo) updated every 1s from a 120-min polynomial fit. A "Now / +90 min" toggle scrubs the ISS marker forward to preview future passes.
- **Calibration log** — list of recent Shoot / Skip / Rate events grouped per pass. Each unrated Shoot exposes a Rate button that opens a modal with 1–5 stars and an obstruction-class dropdown (clear, cloudy, sun-glint, thin cirrus, haze). The calibration-token field uses an in-page password-input modal (no shoulder-surfing, no autofill capture, value wiped on close).
- **Live ISS sub-point in topbar** — every-1s "ISS 35.6°N, 140.2°E · over Asia" updates from the polynomial fit. Solves "is the queue empty because of geography or because it's stale?" without making you open the Map tab.
- **Globally complete day+night cloud sampling** with honest no-observation fallback —
  - Tier 1: NASA GIBS MODIS Aqua/Terra Day/Night (direct cloud fraction, 0–100 from the published colormap)
  - Tier 2: GOES-East/GOES-West infrared Band 13 (brightness → cloud-fraction proxy, day + night, Americas + adjacent oceans)
  - Tier 3: EUMETSAT Meteosat IR108 via WMS (day + night, Africa/Europe)
  - Tier 4: NICT Himawari-9 true-color tiles (daytime Asia/Western-Pacific, replaces the broken GIBS Himawari layer)
  - Tier 5 (forecast): NOAA GFS via Open-Meteo for any pass >90 min ahead — same data underneath the more-authoritative NOMADS GRIB2 path, but pure HTTP+JSON so no eccodes binary deps to break in the field
  - Fallback: if all four observed tiers miss, the card shows a dashed "no cloud obs" tag so you know the score is a placeholder, not a measurement.
- **137 targets** — 106 curated (aurora ovals, night-lit megacities, iconic-shape regions, big-terrain features, volcanoes, lightning hotspots, dynamic events) plus 32 personal targets (hometown, SpaceX/Blue Origin/NASA launch sites, university alumni, current crew hometowns). A CSV importer (`scripts/import_personal_targets.py`) merges personal targets into the curated list without conflicts.
- **Atomic publish to Cloudflare R2** via rclone (`scripts/deploy.sh`) with manifest pointer flip last so readers never see a partial deploy. Deploys are versioned under `out/v/{tick_ts}/`; old versions prune on a 6h horizon. A wrangler-only fallback (`scripts/deploy_wrangler.sh`) handles the case where R2 API keys aren't available. `upload_frontend.sh` surfaces wrangler errors with `✓`/`✗` per file and exits non-zero on partial failure.
- **Cloudflare Worker** at the same origin: token-gated POST /api/log (8 KB body cap, atomic R2 dedupe via `onlyIf: { etagDoesNotMatch: '*' }`, strict ISO-8601 pass_time regex, sanitized keys, 200/day rate limit per token via R2 counter — and only first-time writes count, so dedupe-replays don't burn the budget). GET /api/log (paginated list, capped at 50 to stay under Workers Free subrequest budget). GET /api/health (manifest freshness). R2 static fallback that serves the published site with proper cache headers (`immutable` on hashed assets, short TTL on `index.html`). 503 instead of 500 if `CALIB_TOKEN` is ever undefined.
- **launchd daemon** with stall watchdog (10-min cap per tick), exponential backoff on consecutive failures (30s → 1h), Popen + thread-drain + killpg subprocess wrapper around the deploy script so a stuck child can't wedge the supervisor, flock around `run_tick` so two concurrent ticks fail fast with a clear error, and supervisor exits non-zero on KeyboardInterrupt so launchd's `KeepAlive: Crashed=true` actually restarts the daemon.
- **Mac hardening script** (`scripts/harden-mac.sh`, idempotent + `--verify` mode): persistent power management (sleep 0, autorestart 1, tcpkeepalive 1, womp 1), screen lock disabled, App Store auto-updates off. Plus credential-rotation runbook (`docs/RUNBOOK.md`) covering Earthdata password, Cloudflare R2 keys, and CALIB_TOKEN rotation procedures, plus a documented daemon cold-start smoke test.
- **325 tests** across the three runtimes — 162 pytest + 113 vitest frontend + 50 vitest worker — covering orbit propagation, polynomial fits, all four observed cloud samplers + GFS forecast sampler, scoring, manifest publish, daemon supervisor + watchdog + deploy_to_r2 (subprocess timeout / kill-on-hang / rclone-missing / wrangler-fallback), tick lock contention, Worker /api/log POST + GET + atomic dedupe + token gating + rate limit (incl. dedupe-no-op-doesn't-burn-budget) + handleStatic R2 fallback, card render with all badges, in-page token modal flow, openRateModal star-picker, ISS-silhouette SVG marker, and the openRateModal fetch-mock submit flow.

### V1 boundaries (intentionally deferred, tracked in TODOS.md)

- **V3 — offline-resilient frontend** (full /plan-eng-review'd plan persisted): service worker via vite-plugin-pwa, localStorage snapshot, satellite.js client-side SGP4 for the live dot past the polynomial window, kill-switch on a different origin, atomic-set artifact handling. Targets full offline operation through 30-60 min ISS LOS windows.
- SatCORPS NetCDF fetcher (V2 — current GIBS + GOES + Meteosat + Himawari path covers the same use case)
- Calibration-driven model retuning loop (post-mission V2)
- Filterable WORF / Cupola queue view (V2)
- A handful of P3 polish items: per-second card re-render diffing, SVG pulse pause when tab hidden, sampler inter-tick caching, Hawaii false-positive in the sun-glint heuristic, sun-subpoint Equation of Time correction.

### What this means

You can put a Mac on Earth, walk away for 8 months, and the queue at map.astroanil.dev will tell you when to raise the camera — for the next 90 minutes (observed cloud, 4 satellite sources) and for the next 24 hours (GFS forecast). The cold-start cycle has been verified end-to-end: kill the LaunchAgent, restart, watch the next tick fetch the TLE, sample four cloud sources, fetch GFS forecasts for 137 targets, score 297 passes, publish to R2 — all in ~10 seconds. The daemon survives a watchdog SIGINT (launchd restarts on non-zero exit), a corrupt CDN response (TLE cache only writes after parse succeeds), a wedged deploy script (Popen + killpg, not subprocess.run), a stale CALIB_TOKEN (clean 503), a leaked CALIB_TOKEN (rate-limited at 200/day, dedupe-replays free), an XSS attempt via personal-targets.csv (popup uses textContent, not setHTML), and 30-60 min stretches with stale satellite imagery (banner shows imagery age explicitly).
