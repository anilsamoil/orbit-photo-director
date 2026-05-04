# Changelog

All notable changes to Orbit Photo Director.

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
