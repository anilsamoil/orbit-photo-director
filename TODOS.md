# TODOS

Tracked work surfaced by reviews. Priority bands: P0 (ship-blocker), P1
(must fix before mission start), P2 (nice to have), P3+ (future).

## Generator (Python)

### orbit.py / fit_iss_polynomial — numerical-stability cap
**Priority:** P2

Polynomial order ramps to 13 for >180 min windows. `np.polyfit` at degree
13 over a single-variable dataset is borderline numerically (Runge
oscillations possible). Production uses 120 min → order 11 with ~121
samples, also borderline.

Fix: cap order at ~9 in `_polynomial_order_for_window`, OR add a
residual-asserting test that pins max RMS lat error <0.05° across the
window. Currently dead code in production (we never call with
minutes>180), but the defensive default could fire.

### main.py / detect_reboost — uses |delta|, can fire on noise
**Priority:** P3

`detect_reboost` uses `abs(curr.no_kozai - prev.no_kozai) > 0.005` —
empirical threshold. A debris-avoidance burn (lowers orbit briefly)
or just TLE noise could trip it. Direction-aware threshold + minimum
delta-magnitude over 24h would be more robust. Cosmetic (only logs a
warning), not load-bearing.

### Lockfile around run_tick
**Priority:** P2

Two `python -m generator.daemon` instances co-running would both
`cleanup_old_versions` and both deploy. Launchd's KeepAlive prevents
two from being launched, but `make tick` from a shell can co-run with
the daemon. Add `flock` on `out/.lock`.

### Reboost detection skipped when prior cache parse fails
**Priority:** P3

`main.py:86-90` swallows ValueError/OSError parsing prior cache. If
cache is corrupted (partial write), prior is None and a real reboost
goes undetected for one tick. Low-frequency.

## Worker (Cloudflare)

### handleLogList — N round-trips per call, no concurrency limit
**Priority:** P2

`worker/src/index.ts:284-294` does 1 list + up to 200 sequential
`env.CALIB.get(obj.key)` calls. Worker subrequest quota is 50/req on
bundled plan; >50 entries silently truncates. At our calibration rate
(~50/month), a single month exceeds 50 only after several years —
not urgent.

Fix: store the JSONL inline in the list response (denormalize), OR cap
limit to 50, OR include `customMetadata` in the list call so the
per-key get isn't needed.

### handleLogList — lex-order pagination ≠ recency
**Priority:** P2

R2 `list()` returns keys in lex order. We sort by `received_at`
in-memory after the fact, so once a month accumulates >`limit`
entries (default 100), the page shows an arbitrary window, not the
latest 100. At 50 entries/month this is years away.

Fix: prefix keys with a sortable timestamp (e.g., `log/YYYYMM/<isoZ>-<dedupe>.json`)
so list() lex order matches recency.

### HEAD-then-PUT TOCTOU race in dedupe
**Priority:** P2

`worker/src/index.ts:164-174` — between `head()` returning null and
`put()` succeeding, a concurrent request with the same dedupe_key can
also pass HEAD and PUT, overwriting the first. Calibration log will
silently lose one of two near-simultaneous Rate events.

Fix: use R2's `onlyIf: { etagDoesNotMatch: '*' }` conditional put.

### No rate limit on /api/log POST
**Priority:** P1

A leaked token allows unbounded POST traffic (8 KB max body × N
requests × M months = effectively unbounded R2 growth). The
`MAX_BODY_BYTES` cap helps but doesn't bound aggregate.

Fix: Cloudflare rate-limit binding (per-IP or per-token), or
per-day counter in CALIB bucket.

### CALIB_TOKEN unset → unhandled exception
**Priority:** P1

If `env.CALIB_TOKEN` is undefined (secret deletion, deploy misconfig),
`constantTimeEqual(token, undefined)` throws. Worker returns 500.

Fix: guard `if (!env.CALIB_TOKEN) return 503`.

### isLogRequest pass_time loose validation
**Priority:** P3

Current check: ends with 'Z' and length >= 8. `"AAAAAAAAZ"` validates.
Logged record then has unparseable time, frontend shows "Invalid Date".

Fix: regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`.

## Frontend

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

### Token UI — window.prompt is shoulder-surfable
**Priority:** P2

`main.ts:149` — token visible to anyone watching the screen, persists
in browser autofill.

Fix: replace prompt() with an in-page password-type input field, or
add a "paste from clipboard" button.

### upload_frontend.sh swallows wrangler errors
**Priority:** P2

`scripts/upload_frontend.sh:48` redirects 2>&1 to /dev/null. A failed
upload shows nothing. If 1/30 files fails (network blip),
`index.html` may reference a 404'd asset.

Fix: drop the redirect, or check `$?` per file and abort on first
failure.

### Frontend cache-bust collisions on second-precision version slug
**Priority:** P3

`manifest.py:27` uses `%Y%m%dT%H%M%SZ`. Two ticks within 1 second
produce the same slug. Local writes overwrite; deploy uploads
overwrite; readers between get mixed-version. Launchd's tick interval
(60 min) makes collision impossible in normal operation; hand-running
a tick during a daemon tick is the only realistic trigger.

Fix: append microseconds or PID to the slug.

### `force-cache` fetchArtifact + corrupted version
**Priority:** P3

If a partial deploy leaves a corrupted artifact at a version path, the
browser caches the corrupted response forever for that version (under
`force-cache`). Pruning + re-publishing the same version slug → same
URL returns different content but cache keeps the bad copy.

Fix: include sha256 in artifact URL or query string. Mostly mitigated
once #19/atomic-publish is solved (manifest only references a version
once all artifacts settle).
