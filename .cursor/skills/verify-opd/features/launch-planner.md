# Launch planner

#368 (`174d761`) gives every launch an ISS view check. An ISS destination that sits on the station plane keeps the ISS-plane azimuth. Every other launch gets a modeled direction, or grade D site sectors when the orbit is unknown. The map card, the first shot, the Cupola brief, and the corridor all read that same selected branch.

## Sub-features

- `planner-card` is the map launch card for a modeled launch. The direction line starts `Modeled, grade B.` or `Modeled, grade C.` The envelope title ends `Estimate.` and names `Modeled azimuth N.N°`. The source sentence is required: the line includes `Source:` and the ascent source, and schema 3 rejects a missing or blank `ascent.source` or `direction.source`. A modeled direction is never tier Shot. A modeled `shot` becomes Likely, and a modeled `none` becomes Watch.
- `planner-tied` is `fixture-iss-cape` in `frontend/test/fixtures/launch-planner-tied-catalog.json`. Both ascents score 60. The builder keeps the northbound branch because the sort is score, then slant range, then liftoff: 833 km before 991 km, even though the southbound best time (`22:09:30Z`) is earlier than `22:11:25Z`. The card direction is `northbound branch, selected scenario, azimuth 42.8°`. The first shot, the Cupola brief (`Cupola W1` … `833 km away`), and the corridor are that same branch. The frontend does not re-sort modeled items. Non-modeled items still sort by score, then best time, then subject.
- `planner-fans` draws every fan of the selected launch: the centreline (`role` `model`) and both edges. An unknown orbit draws every assumed site sector and names no azimuth. Baikonur keeps `(25, 70)` and `(340, 355)`. Starbase is grade D, `85–105`. A known Starbase inclination doglegs to the sector edge and says `DOGLEG assumed`.
- `planner-corridor` draws the selected ascent track only, and only when that track has at least two points. A selected track with fewer than two points draws no corridor and does not borrow the other branch. On the tied card the painted corridor is the shorter northbound track (it reaches about 37.4°N and stays north of the pad). The 991 km southbound track is a fan, not the corridor.
- `planner-iss-plane` leaves an ISS-plane launch alone. The CRS-35 item is byte-identical to `tests/fixtures/lp1-crs35-baseline.json`: Likely, azimuth 44.7° (`44.6851`), source `iss_tle_plane`. The card reads `Estimate. The ISS orbital plane, derived from the ISS TLE.`
- `planner-vulcan` is the Amazon Leo example in the tied catalog (`Vulcan VC6L | Amazon Leo (LV-01)`). It is Watch, grade C, azimuth 42.4° (`42.4225`). That azimuth is the rotation-corrected heading. `sin(Az) = cos(i) / cos(lat)` at inclination 51.9° and latitude 28.5834° is the inertial angle, about 44.6°, and `_fixed_azimuth` turns it into 42.4°.
- `planner-andoya` sits on the 60° dogleg boundary. Inclination 120° at Andøya (69.1°N, 15.6°E) is modeled, azimuth 330, with `DOGLEG_ASSUMED`. Inclination 110.899999° southbound is just past 60° from the sector edge and is no direction, with no azimuth.
- `planner-toggle` is #370 (`d9516ca`). The first tap or click on `Show site and modeled ascent` closes the brief and any open launch popup, keeps that launch's line and caption, and focuses the brief summary `Next launch · Watch`. Reopened, the same button reads `Hide modeled ascent` with `aria-pressed=true`. Hide clears that launch's features and caption and returns to `Show site and modeled ascent` with `aria-pressed=false`. Across show, hide, and show, the source ids and layer ids stay the same list and the ascent feature ids and keys match the first show. Showing another launch replaces the drawing and resets the first button to Show with `aria-pressed=false`. Grade D uses `Show site and assumed sector` and `Hide assumed sector`. Show-only, with no `aria-pressed`: a published corridor (`Show site and corridor`), a site with no ascent (`Show launch site`), and hazard-only (`Show published hazard areas`). While another modeled launch is selected, `eligiblePins` in `frontend/src/map/features/launch-corridor/index.ts` returns only that pin, the hazard notes clear, and that hazard-only button reads `Show launch site`. The published CRS corridor (`direction.kind` `iss_plane`) stays drawn for that non-modeled launch, so it is not a leftover of the toggle.

## How to get to it (user POV)

- Open Map on iPhone or iPad, or on the desktop window. Show the chrome. Tap Launches.
- The next-launch card for a modeled pass reads `Modeled, grade C.` (or B), then the fan sentence, then `Source:` and the source sentence. The envelope title says `Estimate.` The tier is Likely or Watch, never Shot.
- Tap `Show site and corridor` on the tied card. That launch has a corridor, so the button is not `Show site and modeled ascent`. The selected corridor and both fans draw. The caption under the map names the grade and the source. On iPad and desktop that caption can sit under the launch card. That overlap is follow-up 401. Read the card anyway. A modeled launch with no corridor says `Show site and modeled ascent`. Grade D says `Show site and assumed sector`.
- On the toggle catalog, tap or click `Show site and modeled ascent` on the next-launch card. The card closes. The summary reads `Next launch · Watch`. The fan and the caption stay. Open the summary again. The button reads `Hide modeled ascent`. Tap or click it and that fan and caption go away. `Other launches (5)` holds the second modeled launch, the grade D sector, the published CRS corridor, the site-only launch, and the hazard-only launch.
- An unknown orbit has no azimuth. The card says `Estimate, grade D` and names every assumed sector. Starbase is one sector, 85° to 105°. Baikonur is two.
- The ISS-plane card for CRS-35 still says Likely and 44.7° from the ISS TLE. It does not become a modeled azimuth.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`. The proxy is the local origin. Do not fetch `https://map.astroanil.dev` or `https://map.expedition75.com`.
- Tile requests use `isolateSnapRequests` (`scripts/context-state-fixture.mjs`): an image or a WMTS URL gets a 1 pixel PNG, and every other host outside the local origin is aborted. Do not point NASA hosts at `127.0.0.1`. Do not fetch NASA tiles.
- One process is one viewport. Do not run `drive all`. Do not run a second WebKit process beside it.
- The clock is frozen at `2026-11-14T23:40:00Z` before the document loads. That instant is inside the tied catalog's `generated_at` (`2026-11-14T23:33:00Z`) and `geometry_valid_until` (`2026-11-14T23:48:00Z`). Do not move `Date.now` on that page.

`drive map` and `drive all` leave this probe out. The seven WebKit contexts, each created at that size, are:

```bash
OPD_VERIFY_VIEWPORT=402x874 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_VERIFY_VIEWPORT=874x402 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_VERIFY_VIEWPORT=1024x768 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_VERIFY_VIEWPORT=1180x820 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_VERIFY_VIEWPORT=768x1024 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_VERIFY_VIEWPORT=834x1210 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_VERIFY_VIEWPORT=1440x900 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
```

iPhone is 402 by 874 and 874 by 402. iPad is 1024 by 768, 1180 by 820, 768 by 1024, and 834 by 1210. Desktop WebKit is 1440 by 900. `1180x820` is not an allowed `drive map` viewport. This script accepts it on its own list. Physical iPad Safari is unverified.

The script serves only `fixture-iss-cape` from the tied catalog, so the next-launch card is that tie. Stdout is `launch planner <WxH> card modeled grade C azimuth 42.8 km 833 fans 2 corridor northbound caption-under-card <0|1> overlap <w>x<h>`. `caption-under-card 1` is follow-up 401. The script records the overlap and still exits 0. Shots are `evidence/launch-planner-<WxH>.png`.

`OPD_LAUNCH_PLANNER_PROBE=toggle` is the #370 control. One process is one of the eight sizes `402x874`, `874x402`, `834x1210`, `1210x834`, `1180x820`, `768x1024`, `1024x768`, or `1440x900`, and the context is created at that size. Touch sizes use a WebKit tap. Desktop at 1440 by 900 uses a click, then Enter, then Space. The script stubs `/hazards/v2/launches.json` with the schema 2 fixture and waits until that source has features and the map is not moving, then two frames, before it reads the hazard button. Space must leave `window.scrollY`, the document scroller, and `#map-pane` where they were. The brief's own `scrollTop` can clamp when the card collapses (measured 308 to 0 at 1440 by 900). That clamp is not a page scroll. On WebKit at 402 by 874, `scrollIntoViewIfNeeded` can throw because the brief button detached. The script retries that scroll once. A second failure is a real failure.

```bash
OPD_LAUNCH_PLANNER_PROBE=toggle OPD_VERIFY_VIEWPORT=402x874 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_LAUNCH_PLANNER_PROBE=toggle OPD_VERIFY_VIEWPORT=874x402 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_LAUNCH_PLANNER_PROBE=toggle OPD_VERIFY_VIEWPORT=834x1210 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_LAUNCH_PLANNER_PROBE=toggle OPD_VERIFY_VIEWPORT=1210x834 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_LAUNCH_PLANNER_PROBE=toggle OPD_VERIFY_VIEWPORT=1180x820 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_LAUNCH_PLANNER_PROBE=toggle OPD_VERIFY_VIEWPORT=768x1024 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_LAUNCH_PLANNER_PROBE=toggle OPD_VERIFY_VIEWPORT=1024x768 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
OPD_LAUNCH_PLANNER_PROBE=toggle OPD_VERIFY_VIEWPORT=1440x900 node .cursor/skills/verify-opd/scripts/launch-planner.mjs
```

Stdout is `launch brief toggle <WxH> tap|click show hide show sources <n> layers <n> features identical focus-visible <0|1> hazard-popup <open|closed|none> space-scroll <0|n/a>`. A pass at these sizes was `sources 16 layers 19 features identical focus-visible 0`. Space on desktop was `space-scroll 0`. Shots are `evidence/launch-brief-toggle-<WxH>-shown.png`, `evidence/launch-brief-toggle-<WxH>-hide.png`, and `evidence/launch-brief-toggle-<WxH>-cleared.png`. The readout is `evidence/launch-brief-toggle-<WxH>.json`. `aria-pressed` is an attribute on the button. A caption painted onto a shot to show that attribute is a probe overlay. It is evidence, not product UI.

The grade, the tie, the empty corridor, the sectors, the dogleg, the Vulcan azimuth, and the CRS-35 bytes stay on the unit files. They do not open a browser:

```bash
cd frontend && bun run test test/launch-planner-selection.test.ts test/launch-tier-card.test.ts test/launch-shot-plan.test.ts test/launch-catalog.test.ts
python3 -m pytest tests/test_launch_direction.py tests/test_launch_planner_cases.py tests/test_launch_orbit.py -q
```

These go red if the named behavior is removed:

- Re-sorting modeled items in `orderedShots` (`frontend/src/launch-tiers.ts`) fails `keeps the selected branch in the primary shot, brief and corridor when ascent scores tie`. The other ascent is earlier at the same score, so score-then-time would put the 991 km branch first.
- A `!first`-only check in `corridorOf` (`if (!first) return null`, dropping `!second`) fails `keeps the corridor empty when the selected envelope has 1 track points`.
- Removing the Shot demotion in `generator/launch_catalog.py` (`if tier == "shot": tier = "likely"` on a `ModeledDirection`) fails `test_modeled_negative_cannot_reach_none_or_restore_a_prior_shot` and `test_positive_and_interior_liftoff_are_observable_but_never_shot_tier`.
- Dropping the source sentence from `directionFact` (`frontend/src/launch-shot-plan.ts`) fails `offers the modeled fan on the map and shows its grade and source`. A blank `ascent.source` also fails `parseLaunchArtifact`.
- Keeping only the first sector in `model_direction` fails `test_unknown_orbit_keeps_all_assumed_site_fans`. Baikonur's `(340, 355)` disappears.
- Routing an ISS destination into `model_direction` fails `test_existing_iss_plane_item_is_byte_identical_to_base`.

The toggle stays on the unit files too. `frontend/src/map/features/launch-corridor/launch-corridor.test.ts` `reopens a pressed control, replaces the selected fan, then clears its fan and caption` fails if another launch does not reset the first button. `does not clear independently drawn sourced corridors` fails if a published corridor grows `aria-pressed`. `frontend/test/launch-tier-card.test.ts` `renders a native click toggle` fails if grade D loses `Hide assumed sector`. `frontend/test/main-integration.test.ts` `closes the modeled brief immediately, respects later reopening, and cancels pending focus when hidden` fails if the summary does not take focus. `frontend/scripts/verify-map-pins.mjs` goes red for `showing a launch collapses its expanded brief before refresh` and `hiding a selected ascent clears its geometry and caption`. Do not run that mutator from this skill.

## Gotchas

- On iPad and desktop the ascent caption (`#launch-ascent-caption`) sits under `#map-launch-coverage`. That is follow-up 401. Measure the overlap. Do not fail the drive for it. A pass at the seven sizes measured `caption-under-card 0` at 402 by 874, and an overlap on the other six: 304 by 114 at 874 by 402, 1024 by 768, 1180 by 820, 834 by 1210, and 1440 by 900, and 298 by 114 at 768 by 1024. iPhone landscape overlaps too. The portrait phone caption sits clear of the card.
- LP1 deferred work is follow-up 402. `TODOS.md` still owes a check of the inclination and site tables against primary documents, a calibrated early-ascent track, sampled heading uncertainty, and coast, insertion, and deployment. This planner adds conditional T+600 estimates and minute liftoff scans. It does not verify a flight trajectory. Do not treat those gaps as a failed drive.
- This script returns 404 for `/launch/latest.json` on purpose, and `hazard-overlay.mjs` does the same. That path is the schema 2 store. The schema 3 body is `/launch/catalog/latest.json` and the revision it names. A 200 schema 2 body there is a different launch, not a broken catalog.
- The Andøya dogleg includes a gap of exactly 60° and rejects the next inclination that sits just beyond it. Do not tighten the comparison to `>= 60`.
- After a pointer, focus is on the summary and `:focus-visible` is false, so no ring is painted. Measured false at 1024 by 768, 402 by 874, 874 by 402, and 1440 by 900. That is follow-up 405. Record it. Do not fail the drive for the missing ring.
- A clear-point tap on a published hazard polygon is not a pass/fail of this toggle. On this pass a click opened the popup at 1440 by 900 and a tap opened it at 874 by 402. A tap at 1024 by 768 left it closed. At 402 by 874 the framed polygons had no clear point (`hazard-popup none`). Follow-up 405. Do not fail the drive when the popup stays closed.
- Astra P3s are follow-up 404. This drive does not prove them.
- `frontend/scripts/verify-map-pins.mjs` has 61 anchors. The six `frontend/src/satellites.ts` finds match the current guards, and the two #370 contracts are `showing a launch collapses its expanded brief before refresh` and `hiding a selected ascent clears its geometry and caption`. A scan of those 51 find strings reports 0 missing. Do not run the mutator from this skill. It rewrites product source. The pin note is in [tracked.md](./tracked.md).
- A hosts-file blackhole of `gibs.earthdata.nasa.gov` to `127.0.0.1` is connection refused. Stub the tile with `isolateSnapRequests` instead.
- `drive map` and `drive all` do not open this probe. There is no `drive all` form of it.
