# TODOS

Tracked work surfaced by reviews. Priority bands: P0 (ship-blocker), P1
(must fix before mission start), P2 (nice to have), P3+ (future).

## V3 — offline-resilient frontend (deferred)

Plan: `~/.gstack/projects/astroanil/astroanil-feat-v1-scaffold-design-20260503-203926.md`

V3 ships service worker (vite-plugin-pwa/Workbox), localStorage snapshot,
client-side SGP4 via satellite.js, atomic-set artifact handling, and a
kill-switch on a different origin. Targets full offline operation through
ISS LOS windows. ~3 hours of CC implementation time, see the plan for the
sequencing.

### V3-P0 — Pre-launch SW upgrade test
Single biggest 8-month risk in the V3 plan is a buggy SW. Test recipe:

1. Deploy v1 with the V3 SW. Boot, verify offline mode.
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

### V3-P3 — Post-mission: drop polynomial, keep SGP4 only
After 8-month mission validates SGP4 client-side, the 60-min polynomial
becomes redundant. Defer until post-mission. Removing earlier risks
breaking the live dot if SGP4 has unknown edge cases.



## Open

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
