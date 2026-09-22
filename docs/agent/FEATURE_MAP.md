# Feature map

Every user-facing map capability, where its code is, how to reach it as a user and as an agent, what to run, and what bites. Seven capabilities are features in the target sense, one directory each under `frontend/src/map/features/`. The rest still live in the legacy module `frontend/src/map.ts` and are listed by the symbols that own them, so a name search finds them; the slice plan in `ARCHITECTURE_TARGET.md` says which directory each one becomes.

Paths below are relative to `frontend/`. Tests run with `bun run test <path>` from `frontend/`.

## Features

### pin-drop

| | |
| --- | --- |
| Directory | `src/map/features/pin-drop/` |
| Entrypoint | `pinDrop` in `index.ts`, id `'pin-drop'` |
| User reaches it | Right-click anywhere on the map, or hold one finger still for 500 ms. Tap the pin to dismiss. A second drop replaces the first. |
| What it draws | One circle in `dropped-pin` (`dropped-pin-layer`), and a popup owned as `'pin'` listing upcoming ISS passes over the point, one section per tracked satellite from `core.view().satellites`, and a footer that adds the point to the operator's personal targets. |
| Control it in code | `core.setGeoJson('dropped-pin', NO_PIN)` clears the pin; `core.closePopup('pin')` closes the popup. Both happen in `dismiss`. The feature does nothing while `core.view().track` is null. |
| Files | `index.ts` gestures and mount, `layers.ts` the layer spec and `pinFeature`, `popup.ts` the add-to-targets footer. Pass math is `src/pin-drop.ts`; list rendering is `src/map/overlays/pass-list.ts`. |
| Tests | `src/map/features/pin-drop/pin-drop.test.ts` mounts the feature on `createMapCore` over the vendor double. `test/map-pin-drop-contract.test.ts` drives it through `renderMap` and the MapLibre double with a real TLE. `test/pin-drop.test.ts` (pass geometry), `test/pin-drop-popup.test.ts`, `test/pin-add.test.ts` (footer). |
| Traps | Pass times start from `core.clock.now()`, the wall clock, not the scrubbed instant; that is the pinned behavior and `verify-map-pins.mjs` mutates it. A finger that moves more than 8 px, or a second finger, cancels the hold. The footer's add controls render low-contrast (`FOLLOWUPS.md`). |

### satellites

| | |
| --- | --- |
| Directory | `src/map/features/satellites/` |
| Entrypoint | `satellites` in `index.ts`, id `'satellites'` |
| User reaches it | Dock button `#toggle-satellite-picker` opens `#satellite-picker-panel`. Check a curated satellite, or type a NORAD number or a name into `#satellite-picker-input` and Add. Uncheck to stop tracking. The selection survives reload. |
| What it draws | Per satellite, a dashed one-orbit track from the view instant in `sat-track-<key>` (`sat-track-layer-<key>`, above the labels) and a marker at the sub-point. Live, markers move at 1 Hz and the track window slides every 60 s; scrubbed, both sit at the view instant. It publishes `core.setSatellites(...)`, which pin-drop and the topbar readouts read. |
| Control it in code | Nothing outside the directory adds or removes a satellite; the picker port in `index.ts` (`add`, `remove`) is the only path. Read what is tracked from `core.view().satellites`. The persisted key is `PREF_KEYS.selectedSatellites`. |
| Files | `index.ts` tracking state, tickers, mount; `selection.ts` persisted keys to `SatelliteMeta`; `layers.ts` orbit, sub-point, track layer, marker element; `picker.ts` the panel DOM. TLE fetch and cache is `src/satellites.ts`; propagation is `src/iss-sgp4.ts`; the antimeridian split is `src/map/overlays/track-line.ts`. |
| Tests | `src/map/features/satellites/satellites.test.ts` mounts on the vendor double with `fetchSatelliteTLE` mocked. `test/map-satellites-contract.test.ts` drives it through `renderMap` and the MapLibre double with a stubbed CelesTrak. `test/satellites.test.ts` covers the fetch and cache. |
| Traps | Every add fetches CelesTrak through `fetchSatelliteTLE`; mock the `src/satellites` module in tests or the suite goes to the network. A persisted satellite whose fetch failed at mount is not retried (`FOLLOWUPS.md`). Opening the picker leaves launch mode (`setMapLaunchMode(false)`). The tickers skip while scrubbed and `clock.onViewTime` repaints instead, so a scrub test must advance the view time, not the timers. |

### basemap

| | |
| --- | --- |
| Directory | `src/map/features/basemap/` |
| Entrypoint | `basemap` in `index.ts`, id `'basemap'` |
| User reaches it | Dock `#toggle-clouds` and `#toggle-ir`. Clouds on shows the dark basemap plus the daily GIBS composite. Clouds off, and IR off, shows Esri imagery. IR replaces the daily clouds. The imagery badge sits in the map container. |
| What it draws | Visibility of `carto-dark-layer`, `esri-imagery-layer`, `gibs-clouds-layer`, `fcst-clouds-layer`, and `geo-ir-layer`. The decision is `basemapVisibility` in `visibility.ts`. The first paint, including those sources, is still `buildStyle` in `map.ts`. |
| Control it in code | `bindBasemapClock` shares the composition root's clock and refreshes the forecast layer and the badge on every view-time change. `attachBasemap` arms the Esri and forecast tile-error fallback when the core is created. `setBasemapManifest` publishes the manifest. `refreshBasemap` reapplies forecast, IR, and the badge. `setForecastSwapDeferred` holds forecast tile swaps during a slider drag. Keys are `PREF_KEYS.cloudsVisible` (default on) and `PREF_KEYS.irVisible` (default off, only `'1'`). |
| Files | `index.ts` toggles, IR repick, forecast refresh, badge, mount; `visibility.ts` the four-layer decision; `forecast.ts` `compactFrameKey` and `nearestForecastFrame`. Satellite pick and tile URLs are `src/tile-precache.ts`. |
| Tests | `src/map/features/basemap/basemap.test.ts` mounts on the vendor double. `test/map-basemap.test.ts` is the 16-row decision table. `test/map-ir.test.ts` drives IR through `renderMap`. `test/map-imagery-date.test.ts`, `test/forecast-frame.test.ts`, `test/time-slider.test.ts` (badge follows the scrub). `test/map-style-contract.test.ts` still pins `buildStyle`. `test/tile-precache.test.ts`, `test/tile-precache-ir.test.ts`. |
| Traps | `FORECAST_CLOUDS_UI` is false. Scrubbed views keep observed imagery and the "observed — not forecast" badge. `_setForecastCloudsUiForTest(true)` is how the forecast tests turn the machinery on. IR and clouds are mutually exclusive. The IR frame time is `geoIRTimeForNow()` (wall clock, inside `tile-precache.ts`), and under a scrub the badge says `LIVE now (not the scrubbed time)`. The badge listener is registered by `bindBasemapClock` at `map.ts` load, before `runScrubTier2`, so `setLookahead` refreshes it with no `renderMap`; putting that listener only in `mount` goes red. `pointerup`, `pointercancel`, and `blur` clear the defer flag, flush settle, then call `refreshForecastCloudLayer` again, because a same-instant release can skip `setViewTime`. `attachBasemap` runs before `whenLoaded`. `resetBasemapForTest` does not clear the in-memory IR flag or `esriTilesFailed`. The `carto-dark-layer` line in `visibility.ts` is what `verify-map-pins.mjs` mutates. |

### labels

| | |
| --- | --- |
| Directory | `src/map/features/labels/` |
| Entrypoint | `labels` in `index.ts`, id `'labels'` |
| User reaches it | Dock `#toggle-labels`. On by default. Click hides country and city names; click again shows them. The choice survives reload. |
| What it draws | `esri-labels-reference-layer`, a transparent Esri reference raster at 85% opacity, painted above the other overlays and below satellite tracks and pins. The source `esri-labels-reference` stays in `buildStyle`. |
| Control it in code | `refreshLabels(core)` adds the layer if it is missing and applies the preference. `renderMap` calls it on every render, before `FEATURES` mount, so a manifest refresh does not drop the layer. The persisted key is `PREF_KEYS.labelsVisible` (default on; only `'0'` hides). |
| Files | `index.ts` is the whole feature: the layer spec, the reader, the toggle, and `refreshLabels`. |
| Tests | `src/map/features/labels/labels.test.ts` mounts on the vendor double. `test/map-overlay-prefs.test.ts` pins the default. `test/map-interaction-contract.test.ts` clicks the dock through `renderMap`. `test/map-render-contract.test.ts` and `test/map-style-contract.test.ts` pin paint order and that the source, not the layer, is in `buildStyle`. |
| Traps | The layer is not in `buildStyle`. Adding it there changes the first paint and fails the style contract. `resetLabelsForTest` sets the in-memory flag back to shown and removes the key; it does not unbind the button. The default-on branch in `readLabelsVisible` is what `verify-map-pins.mjs` mutates. |

### night-lights

| | |
| --- | --- |
| Directory | `src/map/features/night-lights/` |
| Entrypoint | `nightLights` in `index.ts`, id `'night-lights'` |
| User reaches it | Dock `#toggle-night-lights`. Off by default. Click shows the 2016 VIIRS Black Marble composite; click again hides it. A tile error hides it and remembers off. The choice survives reload. |
| What it draws | `viirs-night-lights-layer`, a raster at 95% opacity, and `night-lights-global-dim-layer`, a 30% black background. The dim is shared with the terminator: it paints only when lights are on and the terminator is off. The source `viirs-night-lights` stays in `buildStyle`. |
| Control it in code | `refreshNightLights(core)` adds both layers if they are missing and applies the preference. `renderMap` still `ensureLayer`s the dim, fill, VIIRS, line and subsolar specs at the historical site so the add sequence does not move, then calls `refreshNightLights` on every render. The persisted key is `PREF_KEYS.nightLightsVisible` (default off; only `'1'` shows). |
| Files | `index.ts` toggle, error handler, mount; `layers.ts` the two specs and `CANONICAL_VIIRS_DATE`. The whole-map dim formula is `src/map/overlays/global-dim.ts`, because a feature cannot import another feature. Tile URLs are `src/tile-precache.ts`; the `viirs-alpha://` protocol is the adapter. |
| Tests | `src/map/features/night-lights/night-lights.test.ts` mounts on the vendor double. `test/map-night-lights.test.ts` drives opacity, dim interplay and the error path through `renderMap`. `test/map-overlay-prefs.test.ts` pins the default. `test/viirs-alpha.test.ts`. `test/map-mount-order.test.ts` mounts terminator, night lights and labels in reverse and asserts catalog order. |
| Traps | Night-lights cannot import the adapter; a retry after a tile error sets `viirs-alpha://${gibsBlackMarbleUrl(CANONICAL_VIIRS_DATE)}`. The error handler logs one `console.warn` and stops. `resetNightLightsForTest` turns the in-memory flag off and removes the key; it does not clear `errorLogged` or unbind the button. The 95% opacity line in `layers.ts` and the `flags.nightLights && !flags.terminator` line in `global-dim.ts` are what `verify-map-pins.mjs` mutates. |

### terminator

| | |
| --- | --- |
| Directory | `src/map/features/terminator/` |
| Entrypoint | `terminator` in `index.ts`, id `'terminator'` |
| User reaches it | Dock `#toggle-terminator`. On by default. Click hides the line, the night fill and the subsolar point; click again shows them. The choice survives reload. |
| What it draws | `terminator-night-fill-layer` (30% black fill), `terminator-line-layer` (gold dashed blur), `subsolar-point-layer` (gold circle). Geometry is rebuilt at `core.clock.viewMs()`. |
| Control it in code | `bindTerminatorClock` shares the composition root's clock and rebuilds on every view-time change. `refreshTerminatorGeometry(core)` writes the GeoJSON only; `renderMap` then adds the five night overlay layers in the documented sequence. `refreshTerminator(core)` writes geometry, ensures the three layers and applies the preference. The persisted key is `PREF_KEYS.terminatorVisible` (default on; only `'0'` hides). |
| Files | `index.ts` clock bind, toggle, mount; `layers.ts` the three specs. Domain math is `src/terminator.ts`. The dim flag is `src/map/overlays/global-dim.ts`. |
| Tests | `src/map/features/terminator/terminator.test.ts` mounts on the vendor double. `test/terminator.test.ts` is the domain math. `test/map-night-lights.test.ts` (dim interplay). `test/map-overlay-prefs.test.ts`. `test/map-render-contract.test.ts`. `test/map-mount-order.test.ts`. |
| Traps | `bindTerminatorClock` runs at `map.ts` load, before `runScrubTier2`, so a scrub refreshes geometry with no `renderMap` once a core exists. The 30 s live tick starts in `mount`, not at import. `_resetMapStateForTest` does not reset terminator visibility or remove the key. `new Date(clock.viewMs())` is the allowed form; a bare `new Date()` fails the clock rule. Mounting without `bindTerminatorClock` throws. A scrub now rebuilds terminator geometry even when `currentTrack` is null. |

### ground-track

| | |
| --- | --- |
| Directory | `src/map/features/ground-track/` |
| Entrypoint | `groundTrack` in `index.ts`, id `'ground-track'` |
| User reaches it | Always on. Dock `#toggle-multi-orbit` is off by default. Click shows the later orbits in the manifest samples; click again returns to the current orbit. The choice survives reload. A scrub replaces the line with one orbit around the pinned instant. |
| What it draws | `iss-track-layer`, a dashed line. Illumination picks the hue (cyan day, magenta twilight, grey-blue eclipse) and `orbit_index` picks the shade and the opacity (0.85, 0.55, 0.35, 0.2, then 0.12). The source `iss-track` is created on the first write. |
| Control it in code | `bindGroundTrackClock` shares the composition root's clock and rebuilds on every view-time change. `refreshGroundTrack(core)` writes the GeoJSON from `core.view().track`, adds the layer, and binds the toggle, retrying the button when it was missing. `renderMap` calls it where the layer used to be added, so it stays the first runtime layer. The persisted key is `PREF_KEYS.multiOrbitVisible` (default off; only `'1'`). |
| Files | `index.ts` clock bind, toggle, mount; `layers.ts` the paint; `geometry.ts` orbit buckets, illumination splits, and the polynomial fallback. Domain math is `src/iss.ts`, `src/iss-sgp4.ts`, and `src/terminator.ts`. Antimeridian copies are `src/map/overlays/track-line.ts`. |
| Tests | `src/map/features/ground-track/ground-track.test.ts` mounts on the vendor double. `test/map-ground-track-contract.test.ts` drives paint, the toggle, the polynomial fallback, and the scrubbed window through `renderMap`. `test/map-orbit-split.test.ts` is the bucket and illumination math. `test/map-overlay-prefs.test.ts`. `test/map-render-contract.test.ts`. |
| Traps | `bindGroundTrackClock` runs at `map.ts` load, before `runScrubTier2`, so the track refreshes on a scrub that never calls `renderMap` once a core exists. A scrubbed view whose instant is already in the past draws the current orbit, not a window around that instant. The scrubbed window is one orbit even when multi-orbit is on, and it is empty when the track has no usable TLE. `_resetMapStateForTest` does not reset the in-memory multi-orbit flag. The `0, 0.85` opacity step in `layers.ts` is what `verify-map-pins.mjs` mutates. |

## Capabilities still in `src/map.ts`

Each row names the symbols in `map.ts` that own the capability today, the domain modules it leans on, and the directory it becomes. `renderMap` is the composition root until the last row moves. Layer ids are in `src/map/map-core/catalog.ts`; each capability's layers paint at their `LAYER_ORDER` position whatever order they are added.

| Capability | User reaches it | Owned by | Domain modules | Tests | Becomes |
| --- | --- | --- | --- | --- | --- |
| ISS marker | Always on | `createIssMarkerElement`, `markerPositionFor`, `markerPositionAt` | `src/iss.ts`, `src/iss-sgp4.ts` | `test/iss-marker.test.ts` | `features/iss-marker/` |
| Targets: shot-queue pins, personal targets, tap popups, photo-lookup pin, distance filter | Always on; tap a pin; a photo lookup resolves and `main.ts` calls `dropLookupPin` | `refreshTargetsSource`, `refreshMyTargetsSource`, `pickTargetAtTap`, `buildTargetPopupContent`, `patchPopupWeather`, `dropLookupPin`, `applyDistanceThreshold` | `src/pass-filter.ts`, `src/profile*.ts`, `src/photo-lookup.ts` | `test/map-tap.test.ts`, `test/map-popup.test.ts`, `test/map-interaction-contract.test.ts`, `test/map-distance-filter.test.ts`, `test/photo-lookup.test.ts` | `features/targets/` |
| Launch corridor: ascent trajectory and pad, the launch-mode tool | A launch card's map action; `main.ts` calls `focusLaunchOnMap(eventId)` when the map pane is showing | `buildAscentFeatures`, `buildLaunchMapFeatures`, `refreshAscentTrajectorySource`, `applyMapLaunchVisibility`, `syncMapLaunchMode`, `focusLaunchOnMap` | `src/map-launch-mode.ts`, `src/launch-map-brief.ts`, `src/launch-store.ts` | `test/ascent-features.test.ts`, `test/launch-map-brief.test.ts`, `test/map-launch-mode-layer.test.ts` | `features/launch-corridor/` |
| Time scrub: slider, orbit steppers, readout, snap back to live | `#time-slider`, `#time-back-90`, `#time-back-45`, `#time-now`, `#time-fwd-45`, `#time-fwd-90` | `setLookahead`, `clampLookahead`, `bindTimeSlider`, `bindTimeToggle`, `syncTimeSliderControls`, `runScrubTier2`, `maybeSnapToLive`, `formatViewTimeReadout` | `src/map/map-core/clock.ts` (`setViewTime`, `onViewTime`, `settle`) | `test/time-slider.test.ts`, `test/time-scrub.test.ts`, `test/map-clock.test.ts` | `features/time-scrub/` |
| Follow ISS and bearing mode | Dock `#toggle-follow-iss`, `#bearing-north`, `#bearing-iss` | `applyFollowISS`, `exitFollowISS`, `bindFollowToggle`, `applyBearing`, `computeIssHeading`, `bindBearingToggle`, `readBearingMode` | | `test/map-follow.test.ts`, `test/map-bearing.test.ts` | `features/follow-iss/` |

Traps that hold for every row: preferences are read by the `read*Visible` functions and written next to their toggles with `opd-map-*` keys, which move into `PREF_KEYS` when the row does. Tickers already run through `core.clock.every`, and the time each row renders is `core.clock.viewMs()`; do not add a `Date.now()`. `map.ts` still holds module-level state (`let`), which is why the contract tests reset modules between cases.

## Cross-cutting

| Concern | Where | Tests |
| --- | --- | --- |
| Layer identity and paint order | `src/map/map-core/catalog.ts`: `LAYER_ORDER`, the id unions, `beforeIdFor` | `test/map-catalog.test.ts`, `test/map-render-contract.test.ts` |
| The facade features call | `src/map/map-core/core.ts`: `MapCore`, `createMapCore` | `test/map-core.test.ts` |
| The one clock | `src/map/map-core/clock.ts` | `test/map-clock.test.ts` |
| Shared state features read | `src/map/map-core/view.ts`: `View`, `SelectedSatellite` | `test/map-core.test.ts` |
| Storage keys | `src/map/map-core/prefs.ts`: `PREF_KEYS` | `test/architecture-boundaries.test.ts` |
| The vendor boundary | `src/map/adapters/maplibre/` | `test/maplibre-adapter.test.ts` |
| Initial camera | `src/map/map-core/camera.ts` | `test/map-camera-contract.test.ts`, `test/map-zoom.test.ts` |
| Import and state rules | `test/architecture-boundaries.test.ts` | itself, with a self-test per rule |
| Behavior pins under mutation | `scripts/verify-map-pins.mjs` | `node scripts/verify-map-pins.mjs` |
