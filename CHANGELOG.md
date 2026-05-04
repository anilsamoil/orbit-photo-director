# Changelog

All notable changes to Orbit Photo Director.

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
