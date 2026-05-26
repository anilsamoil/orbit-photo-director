# TODOS

Tracked work surfaced by reviews. Priority bands: P0 (ship-blocker), P1
(must fix before mission start), P2 (nice to have), P3+ (future).

## Operator-feedback tracker

### Pettit's 12-ask wishlist (2026-05-19) — 12/12 SHIPPED ✅

| # | Ask | Shipped |
|---|---|---|
| 1 | Multi-orbit display | v1.5.0.0 |
| 2 | Day-night terminator | v1.4.2.0 |
| 3 | Cloud overlay toggle | existing |
| 4 | Validated Kp aurora widget | v1.2.3.0 |
| 5 | Sun/sunspot widget | v1.4.x |
| 6 | Multi-satellite tracking | v1.6.0.0 |
| 7 | Country boundaries | v1.2.6.0 |
| 8 | Photo timestamp reverse lookup | v1.3.0.0 |
| 9 | Validated offline mode | Lane F SW |
| 10 | Pin-anywhere → best next pass | v1.5.6.0 |
| 11 | Map pan/scroll continuity | existing renderWorldCopies |
| 12 | Time scrubbing | v1.4.0.0 |

### Dominick's 3 asks (Crew-8, 2026-05-19) — 2/3 SHIPPED

| # | Ask | Status |
|---|---|---|
| 1 | 24h+ lookahead | ✅ existing 36h Upcoming tab |
| 2 | Lightning predictions/probability | ✅ v1.5.5.0 (Weather v1.3.2 — GLM + GFS-CAPE) |
| 3 | OPTIMIS timeline overlay | ❌ DEFERRED — Pettit explicitly refutes; 1-1 cross-astronaut tension; defer until a 3rd operator votes |

### Chris's asks (ISS operator) — all shipped

Map zoom (v1.2.1.1), ISS-up bearing (v1.2.1.0), aurora (v1.2.3.0), pre-cache tiles (v1.2.2.0), Queue/Upcoming explainer (v1.2.0.1), empty-hint (v1.2.2.1), iPhone topbar overlap (v1.2.4.1), Esri satellite basemap (v1.5.1.0), follow-ISS toggle (v1.5.2.0), illumination-aware track (v1.5.3.0), bug-fix patches (v1.5.3.1, v1.5.4.0).

### Jack (new astronaut, joined 2026-05-26) — per-astronaut profile layer IN PROGRESS

Design rev 2 doc: `~/.gstack/projects/anilsamoil-orbit-photo-director/astroanil-main-design-20260526-083510.md`. Architecture: daemon-side multi-tenant + Cloudflare Worker API + browser-Worker instant-buffer.

| Slot | Status | Ship version |
|---|---|---|
| 1 — profile.ts data model + URL routing | ✅ | v1.6.3.0 |
| 2 — Profile tab UI + picker + URL sync | ✅ | v1.6.5.0 |
| 3 — Worker `/api/profiles/<name>/targets` CRUD | ✅ | v1.6.4.0 |
| 4 — Daemon multiplexer (per-astronaut passes.json) | ✅ | v1.6.7.0 |
| 5 — Frontend dual-source manifest fetch (per-profile variant resolver) | ✅ | v1.6.8.0 |
| 5b — Browser-Worker SGP4 instant-buffer | ⏳ deferred | — |
| 6 — Profile tab add/remove with API sync | ✅ | v1.6.9.0 |
| 7 — Distance threshold slider | ✅ | v1.6.5.0 |
| 8 — `/api/log` gains `profile` field (backend) | ✅ | v1.6.4.0 |
| 8 — Log tab `?profile=` filter on read (frontend) | ✅ | vNEXT |
| 9 — CSV import → API push | ✅ | vNEXT |
| 10 — JSON export/import + schema migration | ⏳ pending | — |
| 11 — Event bus + cross-tab `storage` event sync | ✅ | v1.6.5.0 |
| — Photo lookup moved under Profile tab | ✅ | v1.6.6.0 |
| — Jack's 39 targets bootstrapped from xlsx | ✅ data, ⏳ upload | data committed v1.6.6.0; `scripts/bootstrap_profile.py jack` posts to live |

#### Jack feedback queue (intake 2026-05-26)

- **v2 — Rating mechanism for "shot but needs rephoto" vs "shot well"** (Jack's existing xlsx already encodes this as Rough/Great + notes; 39 entries preserved in `data/profiles/jack/bootstrap.json` `_v2_rating` + `_v2_notes` fields). Three options for v2 UX:
  - **A) 3-state enum** `unshot | rough | great` — matches Jack's existing mental model exactly. Simple radio-style UI per target row. RECOMMENDED.
  - **B) 1-5 stars** (classic) — finer-grained but requires interpretation per-star.
  - **C) Two booleans** `got_it` (already shipped via /api/log) + `good_enough` — composable, easy to filter ("show me my rough shots") but requires two clicks per target.
  Open question: does Jack want a free-text `notes` field per target alongside the rating? His xlsx has them (e.g. "Need a worf shot", "At the edge of the frame"). Probably yes — premise 12 of design rev 2 doc covers schema versioning so adding a `notes` field is a v2 migration.

- **v2 — CEO target sheets feature** (Jack 2026-05-26): CEO target sheets update daily on ISS and the operator can't look into the past, so the integration must happen day-of. Format per Jack: "a set of zoomed-in pictures, with ISS track up, that help you pick out the actual site. The CEO people sometimes notate big lakes or ground features that are easy to identify to help find harder-to-identify places." Jack notes this might be challenging for AI. Waiting on a screenshot of an actual CEO target sheet for spec; revisit when received. Likely needs:
  - Image upload from iPad
  - OCR + landmark identification (vision model — Claude or GPT-4o)
  - Match to known targets in `targets.json` or `profiles/<name>/targets.json`
  - Surface as a "CEO target alert" in the queue with a "find it on the map" CTA

- **v2 — Spreadsheet column improvements per Jack 2026-05-26 (first paragraph of his email)**:
  - Add an optional `priority` column (sortable)
  - More flexible "coordinates" column: accept lat/long OR city/state/country OR google-search-term for famous places (the bootstrap script already does this via Nominatim — formalize it as the import contract for slot 9)
  - Add a `name` column (hometown, "Ben's house") separate from the location field

## V4 — Forecast cloud overlay on map (operator question 2026-05-20)

### V4-P2 — Forecast cloud overlay synced to the orbit time-scrub

**Origin:** Operator question 2026-05-20 after v1.4.0.0 (orbit time-scrub) shipped: when scrubbing forward on the map, the colored pin scores ARE future predictions (they already use GFS forecast cloud at each pass's `closest_approach`), but the visual cloud raster underneath is yesterday's MODIS composite. Mismatch between pin-color truth and visual-layer truth.

**Goal:** when the operator scrubs to T+N hours, the cloud raster shifts to show **predicted** cloud cover for T+N. Closes the loop — the visual layer agrees with the pin scoring.

**Design space (capture before scoping):**

| Approach | Effort | Notes |
|---|---|---|
| GFS forecast → on-the-fly tile rendering via Cloudflare Worker | ~2-3 days CC | Most accurate. Worker proxies GFS GRIB2 from NOMADS / AWS, renders to PNG tiles per hour, caches. New `gfs-forecast-clouds` MapLibre raster source that subs out for `gibs-clouds` when lookahead > 0. |
| ✅ Per-pin tooltip with predicted cloud-fraction number (SHIPPED v1.4.1.0) | ~2h CC | `buildTargetPopupContent` in `frontend/src/map.ts:971` renders "Cloud: 18% (GFS forecast)" on every pin click. |
| Look for an existing forecast-tile provider | research first | EUMETSAT / OpenMeteo / DWD all publish forecast clouds but not always as tiles. Verify before committing to building our own pipeline. |

**Recommended sequencing:**
- Ship the per-pin tooltip first (~2h CC). Low risk; gives the operator the forecast-cloud-at-pass-time number on demand.
- Run `/plan-eng-review` on the full Worker-rendered tile overlay after. Material new feature (forecast tile pipeline, scrub-aware layer switching, cache strategy).

**Not blocking:** v1.4.0.0 time-scrub still gives correct pin-color predictions. This is a "make the visual layer agree" polish, not a correctness fix.

## V4 — Photo lookup v1 (Pettit Tier B #1)

### V4-P2 — Photo-timestamp reverse lookup v1 (plan locked 2026-05-19)

**Design doc:** `~/.gstack/projects/anilsamoil-orbit-photo-director/anilsamoilenko-photo-lookup-v1-eng-review-2026-05-19.md`

**Origin:** Don Pettit's literal workflow: "I have trained Claude on my desk computer so I type in a photo time stamp and get a .kml pin straight to Google Earth." Strongest possible validation — he built a private version. Memory: `project_pettit_feedback_2026_05_19.md`.

**Architecture (D1-D6):**
- D1: New "Lookup" tab (5th tab next to Queue/Upcoming/Map/Log)
- D2: Both paste-ISO 8601 AND drag/drop photo with EXIF auto-extract (`exifr/lite`, ~8KB gz)
- D3: Walking-window — TLE from `track.json` (~3-4 days accuracy); confidence chip degrades with TLE age. Full Space-Track archive deferred to v1.1 (V4-P3 below).
- D4: All three outputs — pin on Map tab + .kml download + Google Earth Web deep-link
- D5: Single lookup per session (no batch)
- D6: Stateless — .kml file is the persistence

**Implementation:** Single sequential slice, ~6h CC. New module `photo-lookup.ts` + minimal wiring in `main.ts`, `map.ts`, `index.html`, `style.css` + 29 new tests. No feature flag (no soak risk; stateless feature).

**Reuses:** existing `iss-sgp4.ts` (V2 Lane B), `track.tle` (V2 Lane A), MapLibre pin/popup primitives, tab nav from `main.ts`.

### V4-P3 — Photo lookup v1.1 (historical TLE archive)

**Deferred from v1.** Add Space-Track or CelesTrak historical TLE retrieval so photos older than ~3-4 days resolve to high-accuracy pins. Requires:
- Space-Track auth flow + secret manage
- Cloudflare Worker proxy for archive fetches
- R2 / KV cache layer keyed by timestamp
- Lookup index (timestamp → nearest archived TLE within ±12h)

~1-2 days CC. Revisit if v1 soak shows operators routinely want lookups past the 3-4 day window. The .kml file generated during the 3-day window is durable per-photo, so this is a power-user "I'm doing archival research" use case more than the "I shot this Monday, reviewing Tuesday" base case.

## V4 — Weather v1.3 (lightning + hurricane on cards)

### V4-P0 — Weather v1.3 implementation — SHIPPED (v1.3.1 framework + NHC, v1.3.2 GLM + GFS-CAPE, 2026-05-21)

**v1.3.1 shipped (framework + placeholder + NHC):**
- `generator/lightning.py` — `LightningSample` + `LightningSampler` Protocol, `PlaceholderLightningSampler`, `lightning_bonus()` scoring, `HurricaneNearby` + `NHCHurricaneTracker` (NHC CurrentStorms.json polling).
- Every pass carries `lightning_potential`, `flash_rate_per_min`, `lightning_source`, `lightning_bonus` fields.

**v1.3.2 shipped (real samplers, v1.5.5.0 2026-05-21):**
- `GLMSampler` — NOAA GLM L2 LCFA via AWS S3 (direct HTTPS + netCDF4 in-memory, no new deps). 60-min window, 5°×5° spatial bucket index. Skip targets outside GOES coverage (lat outside [-60,60] or lon outside [-180,-25]).
- `GFSCAPELightningSampler` — wraps the existing `GFSForecastSampler` with `include_cape=True` Open-Meteo extension. CAPE J/kg → potential, saturates at 2500 J/kg.
- `CombinedLightningSampler` — fuses observed + forecast via `max(observed, forecast × 0.7)`. Observed-zero is real data (not "missing source").
- `make glm-smoke` + `scripts/glm_smoke.py` for live-S3 verification.
- Live smoke test 2026-05-21: 22,297 flashes ingested from GOES-East+West in last 60 min.

**v1.3.3 (Blitzortung) — DEFERRED:**
- Blitzortung WebSocket sampler doesn't fit hourly-tick batch architecture (needs persistent listener process). Defer until GLM-coverage gap (Europe/Africa/Asia) is reported as a real problem.

### V4-P0 — Weather v1.3 implementation (original plan — kept below for history)

**Design doc:** `~/.gstack/projects/anilsamoil-orbit-photo-director/anilsamoilenko-weather-v1.3-eng-review-2026-05-19.md`

**Origin:** NASA astronaut Matthew Dominick (Crew-8) emailed 2026-05-19, bullet 2: "Lightning predictions/probability." Loral O'Hara CC'd as "earth obs photo machine." Memory: `feedback/project_dominick_feedback_2026_05_19.md`.

**Locked architecture (D1-D6):**
- D1: Full lake — observed lightning + forecast + named-hurricane in one release
- D2: GLM (NOAA S3) + Blitzortung (WebSocket) — MTG-LI deferred
- D3: Additive +30 score bonus (not multiplicative); preserves existing score_components convention
- D4: NHC active storms (named-storm tag, Atlantic + East Pacific) — JTWC deferred
- D5: Flex-wrap stack; all weather tags visible; existing layout primitive
- D6: `OPD_ENABLE_WEATHER` feature flag, 1-week Anil soak (matches V3-P2 ASCENT pattern)

**Implementation:** 3 parallelizable slices, ~10h CC sequential / ~7h with worktree parallel:
- Slice 1: `generator/lightning.py` (4 samplers + Combined) + tests (~5h)
- Slice 2: NHC hurricane tracker + tests (~2h)
- Slice 3: integration into `main.py:score_pass_for_target` + `types.ts` + `card.ts` + `style.css` + tests (~3h)

**Start after:** V3-P2 ASCENT soak concludes (~May 24-25, when current `OPD_ENABLE_ASCENT=1` soak has 1 week of data).

**Codex outside-voice review:** deferred to post-implementation (per D7 — code + design together yields higher signal).

### V4-P3 — Deferred from weather v1.3 scope

- **MTG-LI integration** (EUMETSAT Meteosat lightning imager for Europe/Africa). Skipped in D2 due to auth complexity. Revisit if soak shows the GLM coverage gap matters in practice.
- **JTWC integration** (W.Pacific / Indian Ocean tropical systems). Skipped in D4 — text-bulletin parsing is fragile. Revisit if Pacific typhoons are visibly missed during a typhoon season.
- **Vaisala GLD360** (commercial lightning network) — declined permanently; paid product.
- **Volcano / wildfire / aurora row integration** — different data domains; aurora already has its own widget (v1.2.3.0).
- **OPTIMIS timeline overlay** (Dominick 2026-05-19 bullet 3) — Pettit explicitly refutes 2026-05-19: *"I leave it up to me to figure out targets and how to work these into my work schedule... I find you can take a break to photo a target when needed. Just tell ground you need a bio-break. I keep an egg timer on my kneeboard and set reminder alarms."* Cross-astronaut tension: Dominick (mid-mission Crew-8) wants it; Pettit (4 missions, longest cumulative ISS time among Americans pre-2024) does not. If built, must be **opt-in** with sensible default-off. Defer eng-review until a third operator either votes for or against; current 1-1 split is no signal.

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

**Partial overlap (2026-05-05 /plan-eng-review):** the V2-P0 SW upgrade
verification (`scripts/verify-sw-upgrade.sh` + `docs/SW_UPGRADE_VERIFY.md`,
shipping with V3.0) covers the SW upgrade lifecycle (~6 of the 15 items).
Remaining: kill-switch recovery (blocks on Lane G), tile-cache budget,
banner escalation, snapshot corruption.

### V3-P2 — V3.1 ASCENT geometry (rocket climbing through atmosphere) — SHIPPED (Slices 1+2+3, soaking 2026-05-21)

All three slices are shipped:
- Slice 1: `generator/ascent_profiles.py` (285 lines) — 11 rocket family profiles (Falcon 9, Falcon Heavy, Atlas V, Vulcan, Soyuz-2, CZ-5, CZ-7, SLS, New Glenn, Ariane 6, Starship). `AscentSample` + `AscentProfile` dataclasses, `ALL_PROFILES` constant, `match_rocket()` LL2 lookup.
- Slice 2: `generator/ascent.py` (619 lines) — `predict_ascent_pass()` with sun-illumination + tangent-clearance + apparent-plume-angle geometry. `rocket_position_at()`, `slant_range_km()`, `rocket_sun_state()`, `apparent_plume_angle_mrad()`, `plume_angle_score()`.
- Slice 3: wired into `generator/main.py:822` behind `settings.enable_ascent` (`OPD_ENABLE_ASCENT=1` flag). Produces `launch.kind="ascent"` PassEntry rows alongside OVERHEAD rows.
- Tests: `tests/test_ascent_profiles.py` + `tests/test_ascent.py` exist.

**Soak status 2026-05-21:** flag is ON; daemon healthy at PID 36988. `launches_count_pass_opportunities: 0` in status.json because the single upcoming LL2 launch in the next 36h doesn't have ISS-photographable geometry — that's data, not a bug. The pipeline will produce ASCENT entries when an eligible rocket flies through the viewing cone. No further work needed unless soak surfaces a defect.

### V3-P2 — V3.1 ASCENT geometry (original plan — kept below for history)
**Plan locked 2026-05-13** via /plan-eng-review. Design doc:
`~/.gstack/projects/anilsamoil-orbit-photo-director/anilsamoilenko-v3p2-ascent-eng-review-2026-05-13.md`

The 4-week OVERHEAD prereq is **DROPPED** (D1): Chris likely won't
provide rated-outcome feedback from ISS, so Anil self-validates from
Earth on a 1-week soak window behind a feature flag. See
`feedback_chris_no_feedback.md` in user memory.

7 locked requirements (carried from prior /autoplan):
1. Per-rocket ascent profile tables for top 10 rocket families (Falcon 9,
   Falcon Heavy, Atlas V, Vulcan, Soyuz, Long March 5/7, SLS, New Glenn,
   Ariane 6, Starship)
2. Terminator geometry gate — only surface ASCENT when rocket is
   sun-illuminated AND ISS is in Earth shadow or twilight
3. Slant-range cap at ~1500 km (rocket subtends useful angular size)
4. Ascent azimuth modeling — polar vs equatorial launches differ
5. Confidence stays hidden (folded into star count); **`launch.kind`
   itself is visible** as an "ASCENT plume" / "OVERHEAD pass" tag in
   the card meta row (D5 reversed twice: original /autoplan said
   visible, plan-eng-review D5 hid it, then Codex review 2026-05-13
   said hiding it is operationally bad because Chris needs to know
   the photographic setup — different lens / exposure / look angle)
6. `|lat|>52°` filter relaxed for ASCENT (ISS has a horizon, can see
   beyond subpoint latitude)
7. Multi-point cloud sampling along ISS→rocket sight line

Architecture (D2-D7, see design doc):
- `generator/ascent_profiles.py` — Python module, top-10 rocket dataclass constants
- `generator/ascent.py` — new module for geometry math
- Same `passes.json`; add `launch.kind` field (`"overhead"` / `"ascent"`)
- Same launch → show both ASCENT + OVERHEAD as separate cards (D7)
- `OPD_ENABLE_ASCENT` feature flag, default off; 1-week Anil soak then flip

Implementation: 3 parallelizable slices, ~10.5h CC sequential / ~7h
with two worktrees (Slice 2 grew from 4h→6h after Codex physics
revisions). Slice 1 (profiles + data) and Slice 2 (geometry) are
independent; Slice 3 (main.py integration + plist + card tag) depends
on both.

Codex outside-voice review **DONE 2026-05-13**, transcript at
`/tmp/codex-ascent-review.log`. Five findings, four physics fixes
adopted into design doc:
- Cloud sampling split into obstruction (low-alt corridor) + background
- Sun illumination uses ECI Sun-vector ray-Earth intersection
  (sunlit/penumbra/umbra), NOT surface elevation
- 1500km hard cap dropped → apparent-plume-angle score
- Real launch azimuth from inclination + pad lat (not guessed mode)
- High-lat |lat|>52° hack dropped → real tangent-clearance geometry
- Profile interpolated at 15s cadence (was sparse 30s+ gaps)

**Next:** Start Slice 1 (research top-10 rocket families + write
`generator/ascent_profiles.py` + tests).

### V3-P3 — `make ll2-diff` for LL2 schema-drift diagnosis (SHIPPED v1.4.5.0, 2026-05-21)
Makefile target fetches live LL2 (`?limit=1`), extracts the jq-path set
of the first result, and diffs against `tests/fixtures/ll2-response-2026-05.json`.
Prints removed/renamed paths with `-` prefix and added paths with `+`.
Saves the full live response to `/tmp/ll2-live.json` for deeper inspection.

## V4 — Operator feedback (Chris Williams, ISS, 2026-05-05)

Chris set the calibration token, tried the live site at v1.1.0.1, called
it "incredible" + sent four observations via WhatsApp. None block V3.0;
they reshape what "polish" looks like once V3.0 is in flight. Source:
WhatsApp screenshot 2026-05-05 17:00 (archive in `docs/MISSION_LOG.md`).

### V4-P2 — Map zoom-in for terrain detail (SHIPPED v1.2.1.1, 2026-05-11)
Chris uses Google Maps as a secondary reference in WORF to pick out
mountains / shoreline shapes / man-made features that orient him to the
target. The current map view caps at a relatively shallow zoom; Chris
wants tighter zoom to "zero in on the target." Likely a one-line
`maxZoom` bump in the MapLibre style + verifying carto basemap supports
the deeper tiles (it does up to z19, possibly z22 with retina). GIBS
true-color caps lower (~z9) so deeper zooms drop GIBS overlay
gracefully. ~15 min CC.

### V4-P2 — Rotate map to ISS track ("ISS-up" toggle) (SHIPPED v1.2.1.0, 2026-05-11)
Chris's mental model in WORF: "I'm looking down, this is what's coming
next." Rotating the map so ISS direction-of-travel points up matches
that model exactly (currently north-up). Implementation: derive ISS
heading from the polynomial fit (dlat/dlon over a 30s lookahead window),
call `map.setBearing(heading)` on each tick. Toggle between north-up and
ISS-up via a small button in the map controls. ~45 min CC. Cheap, high
operator-impact change.

### V4-P2 — Aurora forecast / current-level indicator (v1 SHIPPED v1.2.3.0, 2026-05-13)
Chris visits NOAA SWPC daily (`https://www.swpc.noaa.gov/communities/aurora-dashboard-experimental`).

**v1 shipped (v1.2.3.0):** Topbar Kp badge color-coded by NOAA G-scale,
click-through to SWPC dashboard. Cloudflare Worker route `/api/kp` proxies
SWPC's `planetary_k_index_1m.json` with 5-min edge cache. No visibility
math, no oval overlay, no card integration — intentionally minimal v1
gated on operator feedback before spending the bigger budget on v1.1.

**v1.1 — "Is the aurora visible from ISS right now?" (DEFERRED)**

Wait for Chris's feedback on v1 before starting. If he asks for more than
the headline number, the design doc at
`~/.gstack/projects/anilsamoil-orbit-photo-director/anilsamoilenko-aurora-v1-design-2026-05-13.md`
covers the architecture decisions. Codex's outside-voice review surfaced
real correctness requirements that must be in v1.1:

- **Honest visibility math** (not naive ISS-subpoint lookup). ISS sees
  toward the limb hundreds of km, not just nadir. Real visibility test
  needs: ISS terminator state (night side or twilight), look-angle ray
  cast from ISS toward 150km aurora altitude across the visible
  hemisphere, sample OVATION probability at intersection points,
  threshold the max.
- **Day/night gating.** Aurora is invisible in daylight regardless of
  oval position. Sun-elevation check at ISS subpoint must gate "visible"
  copy.
- **Trust-calibrated copy.** A false "visible" is worse than honest
  "aurora nearby." Match copy precision to math precision.
- **OVATION consumption.** Worker downsamples 899KB raw → ~10KB compact
  grid (5° quantized 0-100 probability) for LOS resilience. FE runs
  visibility lookups against cached grid + live ISS pos when worker is
  unreachable.
- **Durable last-good storage.** Cloudflare KV-backed fallback for cold
  colo + SWPC outage scenario (edge cache alone can evict).
- **Source-age display, not response-age.** UI must show how old the
  SWPC reading is, not which cache layer answered. Stack: SW cache +
  CF edge cache + worker fallback cache + SWPC sample timestamp.
- **Schema-drift tolerance for OVATION** (SWPC product is experimental).
- **Observability:** log source age, payload size, parse failures,
  fallback usage, response status.
- **Pre-flight check:** verify SWPC OVATION reachable from Cloudflare
  before implementation (different rate limits / redirects than other
  SWPC endpoints).
- **Polling cadence:** fetch on page-open + visibility-change, not
  continuous 5-min poll. Saves ~$0 but is the right shape.

Estimate revision: 4-6h CC for honest v1.1 (not 2h as originally
scoped). Reserved innovation token: yes (geometric math). Do this only
after Chris confirms the Kp-only widget isn't enough.

### V4-P2 — Pre-cache tiles for upcoming-queue targets (SHIPPED v1.2.2.0, 2026-05-13)
Chris reported (2026-05-05): "the map doesn't work when you are LOS but
you still get the upcoming targets." Expected: Lane F SW caches tiles
the user has previously panned over; new regions during LOS get blank
tiles. Improvement: when online, pre-fetch the carto + GIBS tiles for
each upcoming target's lat/lon at z6-z10. Adds ~50-100 KB per target to
the SW cache (negligible vs the 100/200 LRU caps). Limit to top-N
upcoming. ~30 min CC.

Shipped: top-3 targets × {z6, z8, z10} × {carto, GIBS} = 18 tiles
fire-and-forget per manifest version change. Lives in
`src/tile-precache.ts`. Subdomain-matched to MapLibre's `(x+y) % 4` so
SW Cache API doesn't miss on subdomain rotation. CORS mode (not no-cors)
so the SW route's `cacheableResponse.statuses: [200]` filter actually
excludes 429/5xx instead of caching them as "valid" tiles for 7 days.

### V4-P2 — Queue vs Upcoming + scoring explainer (SHIPPED v1.2.0.1, 2026-05-11)
Chris reported (2026-05-10): "I think I don't fully understand the queue
vs upcoming and the scoring, but it generally makes sense!" The two-tab
distinction (Queue = next 90 min observed-cloud passes; Upcoming = next
24h forecast-cloud passes) is implicit in tab labels but not explained.
Same for the score components (p_unobstructed × regime_fit × nadir_proximity
× priority_weight × tle_freshness). Two cheap remedies:

1. Subtitle copy under each tab heading. Queue: "Next 90 min — what to
   shoot now. Cloud: observed (MODIS / GOES-IR)." Upcoming: "Next 24h —
   what to plan for. Cloud: forecast (GFS)."
2. Click-to-expand score breakdown on each card. Tapping the score
   number opens a tooltip / accordion: "47 = priority 100% × regime 100%
   × nadir 75% × p(unobstructed) 99% × TLE freshness 100%." Maps directly
   to `score_components` already in PassEntry.

~45 min CC for both. Highest leverage operator-clarity win after queue-filter.

### V4-P3 — "Why empty?" hint when Queue is empty (SHIPPED v1.2.2.1, 2026-05-13)
Once v1.1.0.2 hides past cards, an empty Queue could be either "no passes
in the next 90 min" (orbital geometry) or "manifest is so stale every pick
elapsed" (generator lag). Today both show the same "No passes in the next
90 minutes." message. Add a hint when manifest is >90min old AND queue is
empty: "Showing a 1h 42m old manifest — generator has been slow. Next
update in N min." Avoids confusion about whether to wait or whether
nothing's happening. ~15 min CC.

Shipped: `src/empty-hint.ts` exports `emptyQueueHint(manifest, nowMs)`.
90-min threshold (vs banner's 60). Hourly tick projection via modulo.
8 unit tests. Wired into `renderQueue()` empty-state branch.

### V2-P2 — sha256 verification of artifact fetches (SHIPPED v1.4.5.0, 2026-05-21)
Generator ships sha256 for every artifact; `fetchArtifact` now hashes
the response bytes via `crypto.subtle.digest('SHA-256')` and throws on
mismatch. Existing transactional refresh treats the exception as
"stay on previous snapshot," so a poisoned fetch degrades to last-good
instead of feeding wrong data into the UI. Three new tests:
match success, mismatch throws, missing-hash entry skipped defensively.

### V2-P2 — Tighten polynomial fit (or drop it for SGP4-only) (SHIPPED v1.4.6.0, 2026-05-21)
Path 2 taken. `liveIssNow` now tries SGP4 first; polynomial is the
legacy fallback for pre-V2 snapshots without a TLE. satellite.js's
`propagate` is sub-ms per call once the satrec is cached (which it
already was by TLE-string equality), so 1Hz SGP4 in the browser is
free — the "SGP4 is expensive" framing only applied to the Python
generator daemon. Live ISS dot now agrees with the SGP4-driven
ground-track and pin geometry to ~km accuracy.

### V2-P3 — Forecast-horizon obs-age tag (SHIPPED v1.2.3.3, 2026-05-13)
`formatObsAge` silently hides the tag for forecast (future-dated) cloud
samples — the user can't tell a 1h-ahead forecast from a 23h-ahead one.
Detect `cloud_source === 'gfs-forecast'` in card.ts and render
"forecast +Nh" instead of suppressing.

Shipped: new `formatForecastHorizon()` helper in card.ts renders "+Nm /
+Nh / +Nd" alongside the existing "forecast" tag. Upcoming cards now
show "forecast +6h" / "forecast +18h" instead of just "forecast" so
the operator can weight near-term vs far-out predictions.

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

### Auto-restart launchd daemon when generator code changes (SHIPPED v1.2.5.2, 2026-05-17)
**Priority:** P1 — caught us silently 2026-05-04 → 2026-05-17

Validation discovered 2026-05-17: the launchd daemon
`com.astroanil.orbit-photo-director` is a long-lived Python process
that imports `generator.daemon` + transitively all generator modules
ONCE on startup, then loops forever calling `supervisor_loop()`.
Updates to generator/*.py on disk are NOT picked up until the process
restarts.

This silently broke production for 13 days:
- Daemon started 2026-05-04
- V3.0 launches integration committed 2026-05-10 (PR #5)
- v1.2.5.1 scoring fixes committed 2026-05-17 (PR #20)
- None of it was running until manual `launchctl kickstart` on 2026-05-17

Symptoms when it bites:
- New code lands on main, frontend redeploys via `./scripts/upload_frontend.sh`
- Generator-side features (new artifact fields, scoring fixes, new
  data sources) are invisible to operator
- Hard to diagnose because status.json `build_version` matches
  `__version__` in __init__.py, but the loaded modules are stale

Fix candidates (pick one):
1. Add `launchctl kickstart` step to a `make deploy-generator` Makefile
   target. Document in CLAUDE.md as part of the release procedure.
2. Add a Makefile target `make restart-daemon` and have the
   `./scripts/upload_frontend.sh` script also call it (or a sibling
   `./scripts/restart_daemon.sh`).
3. Add a file-mtime check inside `supervisor_loop`: poll `generator/`
   mtimes between ticks; if any newer than process start, exit cleanly
   so launchd's KeepAlive auto-restarts with fresh modules.
4. Switch launchd plist to `ThrottleInterval` short + add a
   `Watchpaths` key on the generator/ directory so any file change
   triggers restart.

Option 3 or 4 is the cleanest — zero discipline required. Option 1 is
the simplest if discipline is acceptable. Either way needs to land
before V3-P2 ASCENT or any other generator-side feature so we don't
lose another 2 weeks of validation. ~30-60 min CC.

### iPhone topbar overlap on Safari + Chrome (SHIPPED v1.2.4.1, 2026-05-17)
**Priority:** P2 — directly visible to operator on iPhone today

Reported by anilsamoilenko while testing on iPhone in-flight 2026-05-17:
the Queue/Upcoming/Map/Log tab nav bar overlays text content. Sits
on top of and to the right of some text. Reproduces on both mobile
Safari and mobile Chrome on iPhone. Almost certainly a viewport /
flex-shrink / position issue in the `.topbar` styling — likely the
ISS-now indicator or the new Kp badge (v1.2.3.0+) is pushing the
tabs into the title area at iPhone widths.

Reproduce: open https://map.astroanil.dev on iPhone. The tabs visually
collide with the brand title or the iss-now indicator string.

Fix candidates (try in order):
1. `flex-wrap: wrap` on `.topbar` so tabs drop to a second row on narrow viewports
2. Container queries on the topbar so tabs/brand/iss-now/kp re-stack below ~430px wide
3. Hide the brand text (keep brand-mark emoji only) below ~500px wide

Quick win: test in Chrome DevTools responsive mode at iPhone 14 / 12 / SE widths and
fix the smallest viewport first. Should be 30-45 min CC including responsive QA.

### Per-second full re-render of all cards (SHIPPED v1.2.5.1, 2026-05-17)
**Priority:** P3

`frontend/src/main.ts:rerenderCountdowns` runs every 1s and calls
renderCards on both Queue and Upcoming (~15 cards). Full
replaceChildren + DOM rebuild. Layout thrash on a tab the user
leaves open for 8 months. Either diff or update only the countdown
text node in place. V3 work — not breaking anything today, just
more wattage than necessary on the unattended Mac.

### SVG pulse animation runs 24/7 (SHIPPED v1.2.3.3, 2026-05-13)
**Priority:** P3

iss-pulse keyframes infinite-loop while the marker is alive,
including when the Map tab is hidden. Browsers usually pause
hidden-tab animations but MapLibre keeps the marker DOM live.
Pause on tab change, OR use IntersectionObserver to suspend.
V3 polish.

Shipped: CSS rule pauses `.iss-pulse animation: none` when `#view`
class is view-queue / view-upcoming / view-log. The map-pane DOM
stays alive (MapLibre's choice) but the animation no longer ticks.

### Cloud sampler re-fetches every tick (no inter-tick cache)
**Priority:** P3

GIBSCloudSampler / GeostationaryIRSampler / MeteosatEUMETSATSampler /
HimawariNICTSampler all instantiate fresh in select_cloud_sampler
every tick. Each fetches its full set of PNGs upstream. ~28 MB/day
egress from third-party WMS / CDN over the mission. Fine today,
worth caching to disk between ticks if upstream rate-limits become
a real problem.

### Reboost detection skipped when prior cache parse fails (SHIPPED v1.2.5.1, 2026-05-17)
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

### sun_glint heuristic flags Hawaii as water (SHIPPED v1.2.5.1, 2026-05-17)
**Priority:** P3

`cloud.py:151` — Pacific band catches lat 21, lon -157 (Hawaii). Real
mid-Pacific water targets get appropriate glint flags, but island
targets in the band get over-flagged. Documented as V2 (real GSHHG
mask).

### sun_glint heuristic flags coastal launch sites as water (SHIPPED v1.2.5.1, 2026-05-17)
**Priority:** P3

V3.0 review (2026-05-10) caught: `cloud.py:138-162` `is_water` heuristic
classifies Vandenberg SLC-4E (-120.6°W) as water → triggers
sun_glint_risk evaluation that depresses the launch's score relative to
inland sites like Baikonur. KSC LC-39A is in the "land" band so it's
unaffected. Asymmetric scoring across launch sites. The reserved-slot
logic (ARCH-4) masks the symptom by guaranteeing surfacing, but the
displayed `obstruction_class` on the card is wrong for Vandenberg.

Fix path: launch sites bypass `is_water` (they're pad coordinates, not
surface targets — water/land is irrelevant for the launch geometry
itself). One-line override in `_synthesize_launch_target` to pass a
"skip water heuristic" flag, OR just give launch sites a known-correct
land/water classification. Same root cause as the Hawaii flag.

### sun_subpoint missing Equation of Time (SHIPPED v1.2.5.1, 2026-05-17)
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
