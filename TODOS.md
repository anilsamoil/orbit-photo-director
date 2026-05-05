# TODOS

Tracked work surfaced by reviews. Priority bands: P0 (ship-blocker), P1
(must fix before mission start), P2 (nice to have), P3+ (future).

## V2 — offline-resilient frontend (in progress)

Plan: `~/Desktop/orbit-photo-director-offline-v2-plan.md`

V2 ships in two parts. Lanes A-E shipped on `feat/v2-offline` (v1.1.0.0);
Lane F shipped on `feat/v2-lane-f-sw` (v1.1.0.1); G-H still deferred.

### Shipped on feat/v2-offline (Lanes A-E, v1.1.0.0)
- ✅ Generator ships source TLE in track.json (Lane A)
- ✅ satellite.js SGP4 fall-through past the 120-min polynomial window (Lane B)
- ✅ localStorage `opd-snapshot` for synchronous boot before network resolves (Lane C)
- ✅ Visibility-aware poll scheduler — pause hidden, fetch on resume (Lane D)
- ✅ Boot-from-snapshot + transactional refresh + offline-confidence banner
  (green<1h / yellow<3h / orange<12h / red beyond) + TLE>48h overlay +
  obs-age tag + map imagery-date badge + pending-sync badge (Lane E)

### Shipped on feat/v2-lane-f-sw (Lane F, v1.1.0.1)
- ✅ Workbox-generated service worker via vite-plugin-pwa (registerType:
  'prompt', generateSW). skipWaiting:true + clientsClaim:false for the
  multi-tab safety the V2 plan locked in.
- ✅ Runtime caching: manifest NetworkFirst (2s timeout), versioned
  artifacts CacheFirst, Carto/GIBS tiles CacheFirst LRU-bounded,
  POST /api/log NetworkOnly (calib.ts owns the offline queue path).
- ✅ Adversarial review caught + fixed: `fetchManifest()` ?cb= buster was
  defeating the SW NetworkFirst manifest rule (Workbox does exact URL
  matching by default); `workbox-window` was an unused declared dep.

### V2-P0 — Pre-launch SW upgrade test (blocks Lane F)
Single biggest 8-month risk is a buggy SW. Test recipe:

1. Deploy v1 with the Lane F SW. Boot, verify offline mode.
2. Deliberate change in vite-plugin-pwa runtime caching (e.g., bump GIBS
   LRU from 200 → 250) to force a cache-key change.
3. Deploy v2.
4. Reload. Verify:
   - New SW installed, old SW still serving until nav (no clients.claim)
   - On next nav: new SW activates cleanly, no console errors
   - Map tile cache survives upgrade (LRU isn't blown away)
   - Snapshot localStorage survives
5. Open two tabs simultaneously, repeat step 3. Verify no breakage.

Must pass before launch.

### V2-P1 — Lane G: kill-switch DNS + Worker (deferred)
`reset.astroanil.dev/orbit-photo-director` on a different origin so a
broken SW can't intercept it. Tiny static page that unregisters all SWs
+ clears caches API + redirects back to map.astroanil.dev. Needs DNS
write access on astroanil.dev.

### V2-P1 — Lane H: pre-launch checklist (blocked by F+G)
15 manual e2e items in the V2 plan covering offline boot, SW upgrade flow,
multi-tab races, kill-switch recovery, tile-cache budget, mock-stale-TLE
banner escalation, snapshot corruption recovery.

### V2-P2 — sha256 verification of artifact fetches
Generator already ships sha256 for every artifact in manifest.json.
Frontend fetches and parses without checking. A partial R2 deploy
(manifest pointing at a not-yet-uploaded artifact) or CF compromise would
silently feed wrong data. Add SubtleCrypto.digest('SHA-256') in
`frontend/src/manifest.ts:fetchArtifact` and throw on mismatch — the
existing transactional refresh already shields against the resulting
exception. ~30 min CC.

### V2-P2 — Tighten polynomial fit (or drop it for SGP4-only)
/review discovered the order-11 polynomial fit has up to 1.1° lat error
vs SGP4 truth — about 120 km on the map. Live dot is visibly off-truth
even inside the 120-min window. Two paths: (1) split into two shorter
polynomial fits (<90 min each), or (2) drop the polynomial entirely and
use SGP4 client-side for the 1Hz live dot. Path 2 is simpler but blocks
on confirming SGP4 is cheap enough for sustained 1Hz on the unattended
Mac. Documented in `frontend/test/iss-sgp4.test.ts:96-101`.

### V2-P3 — Forecast-horizon obs-age tag
`formatObsAge` silently hides the tag for forecast (future-dated) cloud
samples — the user can't tell a 1h-ahead forecast from a 23h-ahead one.
Detect `cloud_source === 'gfs-forecast'` in card.ts and render
"forecast +Nh" instead of suppressing.

### V2-P3 — Periodic satrec re-parse
satellite.js mutates `satrec.error` per propagate call. Over an 8-month
unattended run with the same TLE (Mac dead), the cached satrec accumulates
mutating state. Re-parse on each new manifest version to get a fresh
satrec — cheap, safer.

### V2-P3 — Map tab tile fetch in headless browser (/qa limitation)
/qa run on 2026-05-04 caught that the Map tab renders blank under
`browse $B` headless — MapLibre initializes the canvas but never fetches
a single tile (zero requests to cartocdn / gibs.earthdata).
`renderMap`'s `await map.once('load')` hangs forever, so the
`ensureImageryDateBadge` call (and the ground track + targets layers)
never run. Reproduced on `https://map.astroanil.dev/` (V1 live deploy)
under the same browse — confirms env limitation, not a V2 code bug.
Real Chrome works (the user has been using the live site fine).
Investigate browse $B CDP-mode or a local tile mock so future /qa runs
can fully verify the map view.

### V2-P3 — Post-mission: drop polynomial, keep SGP4 only
After 8-month mission validates SGP4 client-side, the 60-min polynomial
becomes redundant. Defer until post-mission. Removing earlier risks
breaking the live dot if SGP4 has unknown edge cases.



## Open

### Per-second full re-render of all cards
**Priority:** P3

`frontend/src/main.ts:rerenderCountdowns` runs every 1s and calls
renderCards on both Queue and Upcoming (~15 cards). Full
replaceChildren + DOM rebuild. Layout thrash on a tab the user
leaves open for 8 months. Either diff or update only the countdown
text node in place. V3 work — not breaking anything today, just
more wattage than necessary on the unattended Mac.

### SVG pulse animation runs 24/7
**Priority:** P3

iss-pulse keyframes infinite-loop while the marker is alive,
including when the Map tab is hidden. Browsers usually pause
hidden-tab animations but MapLibre keeps the marker DOM live.
Pause on tab change, OR use IntersectionObserver to suspend.
V3 polish.

### Cloud sampler re-fetches every tick (no inter-tick cache)
**Priority:** P3

GIBSCloudSampler / GeostationaryIRSampler / MeteosatEUMETSATSampler /
HimawariNICTSampler all instantiate fresh in select_cloud_sampler
every tick. Each fetches its full set of PNGs upstream. ~28 MB/day
egress from third-party WMS / CDN over the mission. Fine today,
worth caching to disk between ticks if upstream rate-limits become
a real problem.

### Reboost detection skipped when prior cache parse fails
**Priority:** P3

`main.py:86-90` swallows ValueError/OSError parsing prior cache. If
cache is corrupted (partial write), prior is None and a real reboost
goes undetected for one tick. Low-frequency.

### handleLogList — lex-order pagination ≠ recency
**Priority:** P3 (was P2; lowered after the limit cap)

R2 `list()` returns keys in lex order. We sort by `received_at`
in-memory after the fact, so once a month accumulates >50 entries
(after the cap), the page shows an arbitrary window of 50, not the
latest 50. At ~5 entries/month for personal use, this is decades away.

Fix when needed: prefix keys with a sortable timestamp
(e.g., `log/YYYYMM/<isoZ>-<dedupe>.json`) so list() lex order matches
recency. Belongs with the V3 calibration-log denormalization work.

### sun_glint heuristic flags Hawaii as water
**Priority:** P3

`cloud.py:151` — Pacific band catches lat 21, lon -157 (Hawaii). Real
mid-Pacific water targets get appropriate glint flags, but island
targets in the band get over-flagged. Documented as V2 (real GSHHG
mask).

### sun_subpoint missing Equation of Time
**Priority:** P3

Up to ±16 min error → ±4° in sub_lon. With sun-glint proximity 5°,
can flip glint-risk on/off near boundary. Documented as approximate.

### `force-cache` fetchArtifact + corrupted version
**Priority:** P3

If a partial deploy leaves a corrupted artifact at a version path, the
browser caches the corrupted response forever for that version (under
`force-cache`). Pruning + re-publishing the same version slug → same
URL returns different content but cache keeps the bad copy.

Fix: include sha256 in artifact URL or query string. Mostly mitigated
once V3 atomic-publish is solved (manifest only references a version
once all artifacts settle).

## Done in this PR

- ✅ **P1** — CALIB_TOKEN unset guard returns 503 instead of crashing
- ✅ **P1** — Rate limit on /api/log POST: 200/day per token via R2 counter
- ✅ **P2** — handleLogList limit capped at 50 (Workers Free subrequest budget)
- ✅ **P2** — HEAD-then-PUT TOCTOU race fixed via R2 `onlyIf: etagDoesNotMatch: '*'`
- ✅ **P2** — flock around run_tick prevents concurrent ticks (and structurally eliminates the version slug collision risk)
- ✅ **P2** — polynomial order capped at 11 + residual-pinning regression test
- ✅ **P2** — token UI: in-page password-input modal replaces window.prompt
- ✅ **P2** — upload_frontend.sh surfaces wrangler errors and exits non-zero on partial failure
- ✅ **P3** — pass_time strict regex (`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`)
- ✅ **P3** — detect_reboost direction-aware (only fires on mean-motion decrease = orbit raise)
