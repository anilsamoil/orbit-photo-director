# Architecture now

This document describes the SNAP frontend as it exists on this branch, before any structural change. It is a ground-truth brief for a coding agent about to work in `frontend/src`. It records what the code does, where each concern lives, and which patterns make the repo expensive for an agent to change. It proposes no target architecture. Every count in the last section has the command that regenerates it. Defects and stale docs found along the way are listed in `docs/agent/FOLLOWUPS.md` instead of being fixed here.

## Overview

SNAP is a single-page progressive web app that tells an astronaut when and where to point a camera out of the Cupola. A Python generator computes passes, scores, and ground tracks offline and writes versioned JSON artifacts. A Cloudflare Worker serves those artifacts from R2 and hosts a small API for the shot log, personal targets, weather, and aurora. The frontend fetches a `manifest.json`, renders a shot queue and a world map, and keeps working when the station loses signal.

The map is one of five tabs, and it is the largest thing in the repo. `frontend/src/map.ts` is 4604 lines and holds the MapLibre instance, the style, every source and layer, every click handler, the time scrub, the satellite picker, the pin drop, the launch corridor, and the popup DOM. `frontend/src/main.ts` is 1690 lines and holds the boot sequence, the refresh loop, the queue and upcoming renderers, and the tab switch. Those two files are 31% of the frontend source, and both are excluded from the coverage report.

There is no framework, no store library, and no module directory structure. All 57 TypeScript modules sit in one flat folder. State lives in 95 module-level `let` declarations, 24 `localStorage` keys, and the DOM. A capability is not a folder. A capability is a set of function names spread across `main.ts`, `map.ts`, and two or three leaf modules.

## Inventory

| Concern | Choice | Evidence |
| --- | --- | --- |
| Language | TypeScript 5.5, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` | `frontend/tsconfig.json` |
| Bundler | Vite 5.4, `vite-plugin-pwa` 1.2 with Workbox | `frontend/vite.config.ts` |
| Package manager and test runner host | Bun | `frontend/bun.lock`, `.github/workflows/test.yml` |
| Map library | `maplibre-gl` ^4.7.0, imperative API, no React wrapper | `frontend/package.json` |
| UI framework | None. Hand-written DOM, 331 `document.createElement` calls | `grep -h createElement frontend/src/*.ts \| wc -l` |
| Markup | One `index.html` with five panes and the map overlay dock | `frontend/index.html` |
| State | Module-level `let`, `localStorage`, DOM. One pub/sub class, one CustomEvent bus | `launch-store.ts`, `profile-events.ts` |
| Styling | One stylesheet, `frontend/src/style.css` | |
| Frontend tests | Vitest 1.6 on `happy-dom`, 93 files, 19793 lines | `frontend/vite.config.ts` lines 324 to 334 |
| Worker tests | Vitest, 8 files, hand-rolled `fetch` calls, no miniflare | `worker/test/` |
| Generator tests | pytest, 24 files, CI gate `--cov-fail-under=85` | `.github/workflows/test.yml` |
| Lint | `ruff` on `generator/` and `tests/` only. No ESLint, Biome, Prettier, dependency-cruiser, or knip anywhere | `.github/workflows/test.yml`, `Makefile` |
| CI | One workflow, three jobs: Python, Worker, Frontend | `.github/workflows/test.yml` |
| Backend | Python generator writes artifacts, Cloudflare Worker serves them from R2 | `generator/`, `worker/src/index.ts` |

The frontend CI job runs `bun run typecheck`, `bun run test`, and `bun run build`. It does not run coverage, so the thresholds in `vite.config.ts` never execute. No CI job enforces any rule about imports, file placement, or comments.

## Key concepts

**Map instance.** One module-level `let map: maplibregl.Map | null` at `map.ts:56`. `renderMap(manifest)` at `map.ts:1080` constructs it on first call and reuses it forever after. Nothing else in the app holds a reference. There is no destroy path: no `map.remove()` exists, and `map = null` happens only in the test-only setter `_setFollowEnvForTest` at `map.ts:3155`.

**Camera.** Not modeled. The camera is whatever MapLibre currently holds, and nine call sites move it. `center: [0, 0]` and a viewport-derived zoom come from `mapCameraOptions` at `map.ts:1056`, which `renderMap` spreads into the constructor. `projection` and `pitch` are never set, so Mercator and pitch 0 are inherited defaults. Bearing is not a camera field in any type. It is a persisted string mode, `'north'` or `'iss-up'`, read by `readBearingMode` at `map.ts:497` and applied by `applyBearing` at `map.ts:2143`.

**View state.** Two separate clocks, neither one a type. `viewTimeMs` at `map.ts:84` is `null` when the map shows live time and an absolute UTC instant when the operator has scrubbed the time slider. Wall-clock `Date.now()` is used independently by the topbar ISS readout, the satellite readouts, the target popup countdown, and the pin drop pass scan at `map.ts:3913`. A scrubbed map and a live popup can disagree, and that is intended behavior today.

**Style.** One style object built by `buildStyle()` at `map.ts:567`. It declares 7 sources and 5 layers. `setStyle` is never called. A basemap change is a visibility change on layers that all coexist inside the one style. `basemapVisibility` at `map.ts:2676` decides which of the four basemap and cloud layers show, and `applyCloudsVisibility` at `map.ts:2690` applies that decision to the map. This is load-bearing: every runtime source, layer, and event handler assumes the style object survives for the life of the page.

**Sources.** 7 are declared in `buildStyle`: `carto-dark`, `gibs-clouds`, `esri-imagery`, `ne-coastline`, `viirs-night-lights`, `geo-ir`, `esri-labels-reference`. 10 GeoJSON sources are added at runtime through `upsertGeoJson` at `map.ts:3216`, which calls `setData` if the source exists and `addSource` if it does not: `iss-track`, `terminator-line`, `subsolar-point`, `terminator-night-fill`, `targets`, `my-targets`, `ascent-trajectory`, `ascent-pad`, `lookup-pin`, and `dropped-pin`. The raster `fcst-clouds` is added directly at `map.ts:2595`, and one templated `sat-track-${key}` exists per selected satellite. Every id is a bare string literal at its use site.

**Layers.** 21 layers exist, 20 with literal ids and one built from a template. Five come from the style, and 16 are added by the 16 `addLayer` call sites. Insertion order is visual order, so the order of those calls is behavior. See the table below.

**Overlays.** The word does not appear in the code as a concept. What a user calls an overlay is a mix of three unrelated mechanisms. Raster overlays (clouds, IR, night lights, labels) are style layers toggled by `setLayoutProperty`. Vector overlays (terminator, targets, ground track, launch corridor, pins) are GeoJSON sources refreshed by `setData`. The ISS itself and each extra satellite are HTML `maplibregl.Marker` elements outside the canvas, created by `createIssMarkerElement` at `map.ts:3602`.

**Interaction.** No tool or mode concept. There are 25 `map.on(...)` registrations across 14 event types, all inside `renderMap`, several guarded by `if (!map.getLayer(...))` so that re-entering `renderMap` does not double-bind them. Launch mode is the closest thing to a mode, and it is a boolean with listeners in `map-launch-mode.ts`, 16 lines total.

**Geocoding.** Nominatim, in `profile-geocode.ts`, with an LRU cache under `opd-geocode-cache-v1`. It is a Profile pane feature and never touches the map. The map's own place search does not exist.

**Routing.** No router. The active tab is a CSS class on `#view` set by `setActive` at `main.ts:1198`, and reload always lands on the Map tab because `index.html` ships `class="view-map"`. The only URL state is `?u=<profile>`, which `init` rewrites to the verified session name at `main.ts:1517`. Map camera, active tab, and scrub time are not in the URL and not restored.

**Persistence.** Three tiers. `localStorage` holds 24 keys covering the profile, overlay toggles, bearing mode, selected satellites, the offline snapshot, the calibration queue, the shot list, and the launch artifact. `sessionStorage` holds one key for offline session resume. Workbox caches the app shell, versioned artifacts, and map tiles. The camera is in none of them.

## How a user action becomes pixels

### Boot to first paint

```mermaid
flowchart TD
    A[index.html paints Map chrome and Loading banner] --> B[init at main.ts:1512]
    B --> C[await resolveAccountProfile, /api/browser/session]
    C --> D[loadMapPane, not awaited]
    D --> E{currentManifest?}
    E -->|null| F[set mapPaneWaitingForManifest, return]
    F --> G[bootFromSnapshot reads opd-snapshot, renderQueue only]
    G --> H[await refresh: fetchManifest then top5, top_24h, track, status]
    H --> I[renderPendingMapPane, dynamic import of map.ts]
    I --> J[renderMap: fetch passes and track, new maplibregl.Map at 0,0]
    J --> K[await map load, add 12 layers, bind handlers, start timers]
    K --> L[1 Hz applyFollowISS from main.ts setCenter to live ISS]
```

Two things in that path surprise a reader. The offline snapshot restores the queue but never paints the map, so on a slow uplink the cards are ready while the Map tab, which is the default tab, stays blank until the first network round trip returns. And the first camera move to the ISS does not happen in `renderMap`. The map is built at `[0, 0]` and waits for the next 1 Hz `applyFollowISS` tick in `main.ts:1089` to recenter, because follow mode defaults on at `map.ts:2573` without being persisted.

### Toggling the clouds overlay

A tap on `#toggle-clouds` runs the handler bound by `bindCloudToggle` at `map.ts:2718`. It flips the module `let cloudsVisible`, writes `opd-map-clouds-visible`, and calls `applyCloudsVisibility` at `map.ts:2690`. That function reads whether a forecast frame is live, asks `basemapVisibility` for the resulting visibility of the four layers, and issues `setLayoutProperty(id, 'visibility', ...)` for each one that exists. Esri imagery shows only when `!cloudsVisible && !irVisible && !esriTilesFailed`. Nothing is added or removed, and the next MapLibre frame is the paint. The toggle state for the overlay and the identity of the basemap are the same decision, which is why turning clouds off also changes the basemap to satellite imagery.

### Dragging the time slider

`bindTimeSlider` at `map.ts:2422` handles `input` through a `requestAnimationFrame` coalescer and splits the work into two tiers to keep the drag smooth. Tier one runs every frame and moves only the ISS marker and the time labels. Tier two runs at most every 150 ms and refreshes the ground track, the terminator sources, the target `in_window` flags, and the satellite tracks. `setLookahead` at `map.ts:2310` is the single entry point: it sets `viewTimeMs`, then calls `refreshGroundTrackSource`, `refreshTargetsSource`, `refreshTerminatorSources`, and the satellite refresh, each of which builds GeoJSON and calls `setData`. On `change`, meaning pointer release, it also eases the camera. The IR raster deliberately stays at live time while everything else moves, and the imagery badge says so.

## Where things live today

| Concern | Files |
| --- | --- |
| Boot, refresh loop, tab switch, toast | `main.ts` |
| Shot queue and upcoming lists | `main.ts` (`renderQueue` 439, `renderUpcoming` 609), `card.ts`, `countdown.ts`, `score-stars.ts`, `empty-hint.ts`, `sort-pref.ts`, `target-filter-pref.ts`, `pass-thumbnail.ts` |
| Map instance, style, camera, all layers, all handlers | `map.ts` |
| Basemap switch and cloud overlay | `map.ts` (`buildStyle` 567, `basemapVisibility` 2676, `applyCloudsVisibility` 2690, `bindCloudToggle` 2718), `tile-precache.ts` |
| IR imagery | `map.ts` (`repickGeoIRForView` 2845, `applyIrVisibility` 2873, `bindIrToggle` 2932), `tile-precache.ts` (`pickGeoIRSat` 115) |
| VIIRS night lights | `map.ts` (`applyNightLightsVisibility` 2756, `bindNightLightsToggle` 2812, `applyGlobalDimVisibility` 2005), `viirs-alpha-protocol.ts` |
| Terminator | `terminator.ts` (math and GeoJSON), `map.ts` (`refreshTerminatorSources` 1761, `bindTerminatorToggle` 3027) |
| ISS marker and ground track | `map.ts` (`groundTrackFeatures` 916, `splitTrackByOrbit` 819, `createIssMarkerElement` 3602), `iss.ts`, `iss-sgp4.ts`, `track-offset.ts` |
| Time scrub | `map.ts` (`viewTimeMs` 84, `setLookahead` 2310, `bindTimeSlider` 2422) |
| Extra satellites | `satellites.ts` (TLE fetch and cache), `map.ts` 4210 to 4390 (picker, tracks, markers) |
| Pin drop | `pin-drop.ts` (geometry), `map.ts` (`buildPinDropPopup` 3966, `buildPinAddFooter` 4066) |
| Launch data and selection | `launch-schema.ts`, `launch-store.ts`, `launch-selectors.ts`, `launch-card.ts`, `launch-map-brief.ts`, `map-launch-mode.ts` |
| Launch geometry on the map | `map.ts` (`buildLaunchMapFeatures` 1832, `applyMapLaunchVisibility` 1881, `focusLaunchOnMap` 1953) |
| Personal targets and profile | `profile.ts`, `profile-ui.ts`, `profile-crud.ts`, `profile-api.ts`, `profile-session.ts`, `profile-events.ts`, `profile-target-sync.ts`, `profile-geocode.ts`, `profile-json-io.ts`, `csv-parse.ts` |
| Shot log | `calib.ts`, `log.ts`, `shot-counts.ts` |
| Shot list and calendar export | `shotlist.ts`, `ics.ts`, `calendar-share.ts` |
| Photo lookup and KML | `photo-lookup.ts`, `kml.ts` |
| Data fetching and artifact verification | `manifest.ts` |
| Offline behavior | `snapshot.ts`, `network-status.ts`, `network-probe.ts`, `sw-navigation.ts`, `tile-precache.ts`, `banner.ts`, Workbox config in `vite.config.ts` |
| Almanac math | `moon.ts`, `sun.ts`, `beta-angle.ts`, `aurora.ts`, `photo-conditions.ts` |
| Weather | `wx.ts`, `cloud.ts` |
| Types | `types.ts`, imported by 22 modules |
| Help content | `help.ts` |

### Layers and their order

Insertion order is the paint order, so this table is behavior. Nothing asserts it today.

| Order | Layer id | Source | Added at | Default visibility |
| --- | --- | --- | --- | --- |
| 1 | `esri-imagery-layer` | `esri-imagery` | `map.ts:701` (style) | `none` |
| 2 | `carto-dark-layer` | `carto-dark` | `map.ts:708` (style) | visible |
| 3 | `gibs-clouds-layer` | `gibs-clouds` | `map.ts:714` (style) | visible |
| 4 | `geo-ir-layer` | `geo-ir` | `map.ts:725` (style) | `none` |
| 5 | `ne-coastline-layer` | `ne-coastline` | `map.ts:736` (style) | visible |
| 6 | `iss-track-layer` | `iss-track` | `map.ts:1152` | visible |
| 7 | `my-targets-casing` | `my-targets` | `map.ts:1228` | visible |
| 8 | `my-targets-layer` | `my-targets` | `map.ts:1243` | visible |
| 9 | `targets-layer` | `targets` | `map.ts:1262` | visible |
| 10 | `night-lights-global-dim-layer` | none, background | `map.ts:1404`, `beforeTrack` | conditional |
| 11 | `terminator-night-fill-layer` | `terminator-night-fill` | `map.ts:1415`, `beforeTrack` | visible |
| 12 | `viirs-night-lights-layer` | `viirs-night-lights` | `map.ts:1460`, `beforeTrack` | `none` |
| 13 | `terminator-line-layer` | `terminator-line` | `map.ts:1469` | visible |
| 14 | `subsolar-point-layer` | `subsolar-point` | `map.ts:1488` | visible |
| 15 | `ascent-trajectory-layer` | `ascent-trajectory` | `map.ts:1507` | `none` |
| 16 | `ascent-pad-layer` | `ascent-pad` | `map.ts:1520` | `none` |
| 17 | `esri-labels-reference-layer` | `esri-labels-reference` | `map.ts:1626` | visible |
| later | `fcst-clouds-layer` | `fcst-clouds` | `map.ts:2611`, before `ne-coastline-layer` | `none` |
| later | `lookup-pin-layer` | `lookup-pin` | `map.ts:3553` | visible |
| later | `dropped-pin-layer` | `dropped-pin` | `map.ts:3876` | visible |
| later | `sat-track-layer-${key}` | `sat-track-${key}` | `map.ts:4298` | visible |

Three of those inserts pass `beforeTrack`, computed once at `map.ts:1396`. The reason is recorded at `map.ts:1390`: in v1.6.18 the VIIRS raster stacked above the ground track and hid it. The comment at `map.ts:1626` calls the labels layer topmost, and four layers are added above it afterwards.

### Camera call sites

| Call | Site | Trigger |
| --- | --- | --- |
| `easeTo` center, 600 ms | `map.ts:139` | Snap back to live while follow is on |
| `easeTo` center and zoom 4 | `map.ts:1970` | `focusLaunchOnMap`, pad with no corridor |
| `fitBounds`, padding 50, maxZoom 5 | `map.ts:1974` | `focusLaunchOnMap` with a corridor |
| `easeTo` bearing | `map.ts:2148`, `map.ts:2158` | Bearing toggle, and once on first init |
| `setBearing` | `map.ts:2149`, `map.ts:2159` | 1 Hz iss-up tracking, skipped under 0.5 degrees |
| `easeTo` center | `map.ts:2321`, `2336`, `2393` | `setLookahead` with recenter |
| `setCenter` | `map.ts:3063` | 1 Hz follow. Must not be `easeTo`, which queues animations |
| `flyTo`, 800 ms, `essential` | `map.ts:3127` | Follow button turned on |
| `easeTo` center, zoom at least 4 | `map.ts:3593` | Photo lookup pin |

`jumpTo` is never used, and no code reads the camera back into app state.

## Gotchas

**The map is a hidden singleton with no teardown.** `map`, `issMarker`, `liveTimer`, `timeLabelTimer`, `viewTimeMs`, `followISS`, and `selectedSatellites` are module state in `map.ts`. 55 of the 95 module-level `let` declarations in the frontend are in that one file. Two interval tickers, guarded by `_satTrackTickerStarted` at `map.ts:1653` and `irTickerStarted` at `map.ts:2940`, start once and are never cleared.

**`renderMap` is the constructor, the refresher, and the binder.** It runs on the first Map tab open and again on every manifest version change. Correctness depends on a set of `if (!map.getLayer(...))` and boolean latch guards to avoid duplicate layers and duplicate handlers. An agent adding a layer must know which half of the function is idempotent.

**Basemap swap is a visibility swap, not `setStyle`.** The comment at `map.ts:2706` rejects style rebuilds explicitly. Any refactor that reintroduces `setStyle` silently drops all 11 runtime sources, the `viirs-alpha` protocol layer, and every bound handler.

**Two clocks, no type separating them.** `currentViewMs()` drives the map surface. `Date.now()` drives the topbar, the satellite readouts, the target popup countdown, and the pin-drop pass scan at `map.ts:3913`. A reader cannot tell which clock a function uses from its signature.

**Layer and source ids are bare strings at every use site.** 21 layers and 19 sources, each id written as a literal wherever it is needed, up to 7 times for `ascent-pad-layer`. A typo compiles and fails silently, because MapLibre throws on a missing layer and the calls sit inside `try` blocks.

**Duplicated geo math, with two different Earth radii.** `wrapLon` is exported from `iss.ts:14` and reimplemented privately in `terminator.ts:55`, which also inlines the same two `while` loops at `terminator.ts:49`. The antimeridian split, meaning break the line where `|Δlon| > 180` and duplicate the segment at lon ±360 for world copies, is written three times: `buildLineFeatures` at `map.ts:770`, `terminatorFeatures` at `terminator.ts:130`, and `terminatorNightPolygonFeatures` at `terminator.ts:205`. `EARTH_RADIUS_KM` is 6378.137 in `iss-sgp4.ts`, `pin-drop.ts`, and `terminator.ts`, and 6371 in `moon.ts`, `photo-conditions.ts`, and `beta-angle.ts`. Do not collapse those two constants without checking generator parity. Sun elevation is `90 - greatCircleAngleDeg(point, subsolar)` in three places, and `aurora.ts:251` inlines the formula that `aurora.ts:264` already exports as `sunElevationDeg`.

**A wrong comment guards a real code clone.** The comment above `applyDistanceFilter` at `main.ts:427` says the function delegates to `filterPassesByDistance` and is tested through that helper. The function does not import it. The two filters are line-for-line identical and can drift apart without any test failing. `map.ts:305` reads the distance threshold from `parseProfileFromURL` only, while `main.ts` reads it from the resolved session profile, so map pin filtering and queue filtering can disagree for a signed-in crew member.

**Three import cycles.** `iss.ts` and `iss-sgp4.ts` import each other. `calib.ts:7` imports `getCurrentProfile` from `main.ts`, which imports `calib.ts`, and `log.ts` closes a triangle. `map.ts:25` imports `handleAdd` from `profile-crud.ts`, which imports `getCurrentManifest` from `main.ts` at `profile-crud.ts:53`, and `main.ts` dynamically imports `map.ts`. Two of the three carry a comment describing the cycle as acceptable if called lazily.

**HTML defaults disagree with JavaScript defaults.** `index.html:122` marks the north-up button active, while `readBearingMode` defaults to `iss-up`. The follow button ships inactive, while `followISS` starts true. The test-only reset `_resetMapStateForTest` at `map.ts:517` forces `bearingMode = 'north'`, the opposite of production.

**GIBS imagery date is frozen at first style build.** `yesterdayIso()` is baked into the tile URL at `map.ts:568` and never updated with `setTiles`. A tab left open across UTC midnight keeps showing the previous composite. The imagery badge is the only thing that tells the operator.

**Comments are used as architecture.** `map.ts` is 28% comment lines and `main.ts` is 31%. They are not line narration. They are decision logs, operator-feedback records, and inline changelogs, such as the opacity history at `map.ts:1436` and the reason IR ships off at `map.ts:375`. Some of this is the only record of why a default exists. Some of it is stale: the file header at `map.ts:3` describes a five-layer stack that predates Esri, IR, the terminator, and the labels layer. An agent cannot tell which comments are load-bearing.

**Coverage excludes the two files that need it.** `vite.config.ts:331` excludes `src/main.ts` and `src/map.ts`. The frontend CI job never passes `--coverage`, so the thresholds are inert regardless.

## Agent-hostile patterns

Grouped by the failure they cause for an agent making a change.

**Feature logic has no home.** Adding a map overlay today means editing `buildStyle` for the source, `renderMap` for the layer, a new `bind*Toggle` function for the control, `index.html` for the button, `refresh*Source` for updates, `applyCloudsVisibility` if it interacts with the basemap, `setLookahead` if it is time-aware, and `tile-precache.ts` if it has tiles. All but one of those edits land in the same 4604-line file, at six different line ranges. There is no example to copy that keeps the change in one place, because no such example exists.

**`map.ts` is the god module and `main.ts` is the god orchestrator.** `main.ts` imports 35 local modules statically and 5 more dynamically. `map.ts` imports 21, and `profile-crud.ts` imports 12. `map.ts` reaches into the profile store, the launch store, the target filter preference, the shot counts, the banner, and the live weather API. An agent reading `map.ts` to change a layer must load the profile model, the launch model, and the preference model to understand it.

**Illegal states are representable everywhere.** A layer id is a `string`, so `setLayoutProperty('targets-layr', ...)` typechecks and is swallowed by a `try` block. A source can be absent while its layer is visible, and the code handles that with defensive `getLayer` checks rather than by construction. `viewTimeMs` being `null` versus a number encodes live versus scrubbed, and nothing forces a caller to handle both. Camera state and selection state are unrelated variables. No type prevents a scrubbed map from showing a live countdown, which is why that behavior exists as a documented quirk instead of a decision.

**Layer boundaries do not exist, so they cannot be violated or enforced.** `maplibregl` types appear directly in function signatures throughout `map.ts`, including in functions that are otherwise pure. There is no adapter. There is also no lint rule that could notice, because the repo has no JavaScript or TypeScript linter at all. The only protection against `map.ts` being imported eagerly is that `main.ts` uses `await import('./map')`, which is a convention, not a rule.

**Comments carry the architecture.** See the gotcha above. The stale header at `map.ts:3` is the clearest case: an agent that trusts it will insert a layer in the wrong place.

**There is no single way to do anything.** Three different mocking strategies appear across the map tests: an inline fake map with production logic copied into the test, a regular expression over the text of `map.ts`, and injection of a fake map through `_setFollowEnvForTest`. The first strategy has already failed twice. `time-scrub.test.ts:6` records a copy that stayed green while `map.ts` drifted, and the copy in `map-basemap.test.ts` had lost the IR gate that production has. There is no shared test helper module, so each of the 15 `map-*.test.ts` files invents its own fake. An agent copying the nearest test copies a strategy that cannot catch a regression.

## What the tests pin

The baseline any structural change has to keep green is 1707 frontend tests in 93 files, 196 worker tests in 8 files, and a clean `tsc --noEmit` in both. Measure it with `bun run test` and `bun run typecheck` in `frontend/` and `worker/`.

Three words describe the strength of a pin. "Literal" means a test calls production code and asserts a literal expected value. "Copy" means the test asserts a duplicate of the logic, so production can drift without failing anything. "Grep" means the test matches the text of `map.ts` with a regular expression, which breaks on a rename and says nothing about behavior.

| Behavior | Pinned | Evidence |
| --- | --- | --- |
| Default center `[0, 0]` | Literal | `map-camera-contract.test.ts`, `opens at lon 0, lat 0` |
| Default zoom | Literal | `map-camera-contract.test.ts` asserts the zoom in the options object. `map-zoom.test.ts` pins `initialZoomForViewport` across widths |
| Projection, bearing, pitch absent | Literal | `map-camera-contract.test.ts`, `sets no projection, bearing, or pitch` |
| World copies and gesture flags | Literal | `map-camera-contract.test.ts`, `states every gesture explicitly` |
| Style layer order | Literal | `map-style-contract.test.ts`, `paints five layers, bottom first` |
| Style layer to source wiring | Literal | Same test asserts the id, source, and visibility of all five rows |
| Style default visibility and opacity | Literal | `map-style-contract.test.ts`, `ships the two opt-in rasters hidden` and `keeps the basemap opaque` |
| Source tile URLs and zoom caps | Literal | `map-style-contract.test.ts`, `caps every raster source` and the two night-lights tests |
| Basemap swap, including the IR and forecast gates | Literal | `map-basemap.test.ts` calls `basemapVisibility` over all 16 input combinations |
| Overlay preference defaults and round-trips | Literal | `map-overlay-prefs.test.ts` drives all seven production readers |
| Runtime layer order and `beforeId` | Literal | `map-render-contract.test.ts` drives the real `renderMap` against a recording MapLibre double and asserts all 17 painted layers in order, plus the three `beforeId: 'iss-track-layer'` insertions |
| Runtime source to layer wiring | Literal | Same file asserts `layer.source` for every one of the 17 layers and that no layer points at a source the map never added |
| Runtime default visibility | Literal | Same file asserts the exact set of six layers that open hidden |
| Map construction arguments | Literal | Same file asserts the constructor received `buildStyle()` and `mapCameraOptions()` verbatim, so an inline literal cannot creep back in |
| Render idempotency | Literal | Same file renders twice and asserts no duplicate layer, source, marker, or map |
| Feature click and selection | Literal | `map-interaction-contract.test.ts` fires the real `map.on('click')` handler and asserts one popup, its anchor, its text, and the two-step layer priority query |
| Basemap swap end to end | Literal | `map-interaction-contract.test.ts` clicks the real dock buttons and asserts the four basemap layer visibilities, including that the layer array never changes |
| Overlay add and remove | Literal for the lookup pin | `map-interaction-contract.test.ts` asserts `dropLookupPin` adds its source and layer once and reuses them. Forecast frames and satellite tracks are still unasserted |
| `fitBounds` and `easeTo` | Literal | `focusLaunchOnMap` is literal against a fake in `launch-map-brief.test.ts`. `dropLookupPin`'s `easeTo` is literal in `map-interaction-contract.test.ts`. `applyFollowISS` `setCenter` is literal. The follow-toggle `flyTo` is still a copy |
| Esri tile failure falls back to Carto | Partial | The resulting visibility is literal in `map-basemap.test.ts`. The `map.on('error')` handler that sets the flag is unasserted |
| View state serialization | No for camera | No camera state is serialized anywhere. Overlay preferences are literal, in `map-overlay-prefs.test.ts` and again end to end in `map-interaction-contract.test.ts` |

`test/maplibre-double.ts` is what made the runtime rows literal. It replaces the six MapLibre symbols `map.ts` actually constructs (`Map`, `Marker`, `Popup`, `NavigationControl`, `LngLatBounds`, `addProtocol`) with recorders. `RecordingMap` seeds its layer array from the style and splices on `addLayer(spec, beforeId)`, so the order it reports is the paint order the operator sees. Each test gets a fresh module registry, because `map.ts` holds the map, the ISS marker, and every bind-once flag in module scope with no teardown, and a shared registry would let the first test decide what the rest observe.

`scripts/verify-map-pins.mjs` is the lever that proves the pins can fail. It breaks one contract in `map.ts` at a time and asserts the suite goes red for each. Run `node scripts/verify-map-pins.mjs` from `frontend/`; it restores the file after every mutation.

`scripts/launch_qa_server.ts` is the verification lever for anything a unit test cannot reach. It serves the built app from `frontend/dist` on `127.0.0.1:8769` with synthetic passes, tracks, targets, launch envelopes, and a fake signed-in session, and it never contacts production. Basemap tiles still come from the public CDNs. The loop is `cd frontend && bun run build`, then `bun scripts/launch_qa_server.ts`, then open the Map tab against that origin. Toggling clouds there is the end-to-end check on the basemap arbiter, because the swap from the dark Carto basemap to Esri imagery is unmistakable on screen.

## Counts and how to regenerate them

Run from the repository root.

| Claim | Command |
| --- | --- |
| 57 TypeScript modules in one flat directory | `ls frontend/src/*.ts \| grep -v vite-env \| wc -l` and `find frontend/src -type d` |
| 20432 lines of frontend source | `wc -l frontend/src/*.ts \| tail -1` |
| `map.ts` 4604 lines, `main.ts` 1690 | `wc -l frontend/src/map.ts frontend/src/main.ts` |
| 95 module-level `let`, 55 of them in `map.ts` | `grep -hE '^let ' frontend/src/*.ts \| wc -l` |
| 331 `createElement` calls | `grep -h createElement frontend/src/*.ts \| wc -l` |
| 28% and 31% comment lines | `grep -cE '^\s*(//\|/\*\|\*)' frontend/src/map.ts frontend/src/main.ts` |
| 16 `addLayer` call sites, 20 literal layer ids | `grep -c 'addLayer(' frontend/src/map.ts` and `grep -oE "id: '[a-z0-9-]+'" frontend/src/map.ts \| sort -u \| wc -l` |
| 25 `map.on` registrations | `grep -cE '\bmap\.on\(' frontend/src/map.ts` |
| 35 static and 5 dynamic local imports in `main.ts`, 21 in `map.ts` | `grep -hoE "from '\./[a-z0-9.-]+'" frontend/src/main.ts \| sort -u \| wc -l` |
| 24 `localStorage` key literals | `grep -rhoE "'opd[-_][a-z0-9_:.-]*'" frontend/src/*.ts \| sort -u \| wc -l` |
| 93 frontend test files, 17 map tests | `ls frontend/test/*.test.ts \| wc -l` and `ls frontend/test/map*.test.ts \| wc -l` |
| No JavaScript or TypeScript linter | `grep -rn eslint frontend/package.json worker/package.json` returns nothing |
| Coverage excludes `main.ts` and `map.ts` | `grep -n exclude frontend/vite.config.ts` |
