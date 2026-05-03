# Changelog

All notable changes to Orbit Photo Director.

## [1.0.0.0] - 2026-05-03

### V1 ships — personal Earth-photography planner for the ISS, end to end.

A Mac on Earth runs a 60-min loop: pull the ISS TLE, propagate the next 90 minutes of passes against your target list, sample cloud cover from real satellites, score every pass, and atomically publish a manifest to Cloudflare R2. A glanceable web app at map.astroanil.dev tells you what's about to be under the station, what you can see right now, and whether it's worth raising the camera. Calibration writes flow back to a token-gated Cloudflare Worker so a second-pass scoring model can be tuned from the post-mission archive.

### Added
- **Shot queue** — top 5 passes in the next 90 minutes, scored on regime fit (day / night / terminator), nadir proximity, target priority, and probability of a clear shot. Each card shows countdown, observed cloud class, score, and a colored badge marking whether the pass is a WORF (nadir window, <30° off-nadir) or Cupola (≥30°, panoramic dome) shot. Shoot/Skip submits a calibration record to the Worker.
- **Map view** — MapLibre canvas with Carto dark basemap, NASA GIBS true-color overlay, ISS ground track polyline (antimeridian-aware), target markers colored by score, and a live ISS dot updated every 1s from a 120-min polynomial fit shipped in the manifest. A "+90 min" toggle scrubs the ISS marker forward to preview future passes.
- **Calibration log** — list of recent Shoot / Skip / Rate events grouped per pass. Each unrated Shoot exposes a Rate button that opens a modal with 1–5 stars and an obstruction-class dropdown (clear, cloudy, sun-glint, thin cirrus, haze). The token field is a one-line UI in the log header so you don't need DevTools to set it.
- **Three-tier cloud sampling** with honest no-observation fallback —
  - Tier 1: NASA GIBS MODIS Aqua/Terra Day/Night (direct cloud fraction, 0–100 from the published colormap)
  - Tier 2: GOES-East/GOES-West infrared Band 13 (brightness → cloud-fraction proxy, day + night)
  - Tier 3: NICT Himawari-9 true-color tiles (brightness heuristic, daytime Asia/Western-Pacific only — fills the gap GIBS Himawari leaves broken)
  - Fallback: if all three miss, the card shows a dashed "no cloud obs" tag so the user knows the score is a placeholder, not a measurement
- **106 curated targets** spanning aurora ovals, night-lit megacities, iconic-shape regions, big-terrain features, volcanoes, lightning hotspots, and dynamic events — plus a CSV importer (`scripts/import_personal_targets.py`) that merges your own personal targets (hometown, family, alumni, crew hometowns) without touching the curated list.
- **Atomic publish to Cloudflare R2** via rclone (`scripts/deploy.sh`) with manifest pointer flip last so readers never see a partial deploy. Deploys are versioned under `out/v/{tick_ts}/`; old versions prune on a 6h horizon. A wrangler-only fallback (`scripts/deploy_wrangler.sh`) handles the case where R2 API keys aren't available.
- **Cloudflare Worker** at the same origin: token-gated POST /api/log (8 KB body cap, R2 write with HEAD-then-PUT dedupe, sanitized keys), GET /api/log (paginated list of recent entries), GET /api/health (manifest freshness check), and an R2 static fallback that serves the published site with proper cache headers (`immutable` on hashed assets, short TTL on `index.html`).
- **launchd daemon** with stall watchdog (10-min cap per tick, SIGINT on hang), exponential backoff on consecutive failures (30s → 1h), and a Popen + thread-drain + killpg subprocess wrapper around the deploy script so a stuck child can't wedge the supervisor.
- **Mac hardening script** (`scripts/harden-mac.sh`, idempotent + `--verify` mode): persistent power management (sleep 0, autorestart 1, tcpkeepalive 1, womp 1), screen lock disabled, App Store auto-updates off. Plus credential-rotation runbook (`docs/RUNBOOK.md`) covering Earthdata password, Cloudflare R2 keys, and CALIB_TOKEN rotation procedures.
- **Test suite** — 265 tests across the three runtimes (135 pytest, 91 vitest frontend, 39 vitest worker) covering orbit propagation, polynomial fits, all three cloud samplers, scoring, manifest publish, daemon supervisor + watchdog + deploy_to_r2 (subprocess timeout / kill-on-hang / rclone-missing / wrangler-fallback), Worker /api/log POST + GET + dedupe + token gating + handleStatic R2 fallback (incl. `log/` defense-in-depth + outage 503 + immutable cache), card render with WORF/Cupola + no-obs badges, calibration token UI flow, and the openRateModal star-picker → fetch-mock submit flow.

### V1 boundaries (intentionally out of scope, tracked in TODOS.md)
- Cloud forecast (NOMADS GFS, V2)
- Africa/Europe coverage gap (Meteosat via EUMETSAT, V2)
- SatCORPS NetCDF fetcher (V2 — current GIBS + GOES + Himawari path covers the same use case)
- Calibration-driven model retuning loop (post-mission V2)
- Filterable WORF / Cupola queue view (V2)
- A handful of Worker-scale and adversarial-review polishings tracked at P1/P2/P3 in TODOS.md

### What this means
You can put a Mac on Earth, walk away for 8 months, and the queue at map.astroanil.dev will tell you when to raise the camera. The cold-start cycle has been verified end-to-end: kill the LaunchAgent, restart, watch the next tick fetch the TLE, sample three cloud sources, score 137 targets, publish to R2, and flip the manifest — all in ~8 seconds. The daemon survives a watchdog SIGINT (launchd restarts on non-zero exit), a corrupt CDN response (TLE cache only writes after parse succeeds), and a wedged deploy script (Popen + killpg, not subprocess.run).
