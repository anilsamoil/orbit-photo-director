# Feature map

Every user-facing map capability, where its code is, how to reach it as a user and as an agent, what to run, and what bites. Twelve capabilities are features, one directory each under `frontend/src/map/features/`. `frontend/src/map/index.ts` is the composition root: `renderMap`, `buildStyle`, the one `let core`, and the wiring between features.

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
| Control it in code | Nothing outside the directory adds or removes a satellite; the picker port in `index.ts` (`add`, `remove`) is the only path. Read what is tracked from `core.view().satellites`. `getSatelliteTopbarReadouts` formats those sub-points at `core.clock.now()` and the composition root re-exports it for `main.ts`. The persisted key is `PREF_KEYS.selectedSatellites`. |
| Files | `index.ts` tracking state, tickers, mount; `selection.ts` persisted keys to `SatelliteMeta`; `layers.ts` orbit, sub-point, track layer, marker element; `picker.ts` the panel DOM. TLE fetch and cache is `src/satellites.ts`; propagation is `src/iss-sgp4.ts`; the antimeridian split is `src/map/overlays/track-line.ts`. |
| Tests | `src/map/features/satellites/satellites.test.ts` mounts on the vendor double with `fetchSatelliteTLE` mocked. `test/map-satellites-contract.test.ts` drives it through `renderMap` and the MapLibre double with a stubbed CelesTrak. `test/satellites.test.ts` covers the fetch and cache. |
| Traps | Every add fetches CelesTrak through `fetchSatelliteTLE`; mock the `src/satellites` module in tests or the suite goes to the network. A persisted satellite whose fetch failed at mount is not retried (`FOLLOWUPS.md`). Opening the picker leaves launch mode (`setMapLaunchMode(false)`). The tickers skip while scrubbed and `clock.onViewTime` repaints instead, so a scrub test must advance the view time, not the timers. |

### basemap

| | |
| --- | --- |
| Directory | `src/map/features/basemap/` |
| Entrypoint | `basemap` in `index.ts`, id `'basemap'` |
| User reaches it | Dock `#toggle-clouds` and `#toggle-ir`. Clouds on shows the dark basemap plus the daily GIBS composite. Clouds off, and IR off, shows Esri imagery. IR replaces the daily clouds. The imagery badge sits in the map container. |
| What it draws | Visibility of `carto-dark-layer`, `esri-imagery-layer`, `gibs-clouds-layer`, `fcst-clouds-layer`, and `geo-ir-layer`. The decision is `basemapVisibility` in `visibility.ts`. The first paint, including those sources, is still `buildStyle` in `src/map/index.ts`. |
| Control it in code | `bindBasemapClock` shares the composition root's clock and refreshes the forecast layer and the badge on every view-time change. `attachBasemap` arms the Esri and forecast tile-error fallback when the core is created. `setBasemapManifest` publishes the manifest. `refreshBasemap` reapplies forecast, IR, and the badge. `setForecastSwapDeferred` holds forecast tile swaps during a slider drag. Keys are `PREF_KEYS.cloudsVisible` (default on) and `PREF_KEYS.irVisible` (default off, only `'1'`). |
| Files | `index.ts` toggles, IR repick, forecast refresh, badge, mount; `visibility.ts` the four-layer decision; `forecast.ts` `compactFrameKey` and `nearestForecastFrame`. Satellite pick and tile URLs are `src/tile-precache.ts`. |
| Tests | `src/map/features/basemap/basemap.test.ts` mounts on the vendor double. `test/map-basemap.test.ts` is the 16-row decision table. `test/map-ir.test.ts` drives IR through `renderMap`. `test/map-imagery-date.test.ts`, `test/forecast-frame.test.ts`, `test/time-slider.test.ts` (badge follows the scrub). `test/map-style-contract.test.ts` still pins `buildStyle`. `test/tile-precache.test.ts`, `test/tile-precache-ir.test.ts`. |
| Traps | `FORECAST_CLOUDS_UI` is false. Scrubbed views keep observed imagery and the "observed — not forecast" badge. `_setForecastCloudsUiForTest(true)` is how the forecast tests turn the machinery on. IR and clouds are mutually exclusive. The IR frame time is `geoIRTimeForNow()` (wall clock, inside `tile-precache.ts`), and under a scrub the badge says `LIVE now (not the scrubbed time)`. The badge listener is registered by `bindBasemapClock` at composition-root load, before `runScrubTier2`, so `setLookahead` refreshes it with no `renderMap`; putting that listener only in `mount` goes red. `pointerup`, `pointercancel`, and `blur` clear the defer flag, flush settle, then call `refreshForecastCloudLayer` again, because a same-instant release can skip `setViewTime`. `attachBasemap` runs before `whenLoaded`. `resetBasemapForTest` does not clear the in-memory IR flag or `esriTilesFailed`. The `carto-dark-layer` line in `visibility.ts` is what `verify-map-pins.mjs` mutates. |

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
| Traps | `bindTerminatorClock` runs at composition-root load, before `runScrubTier2`, so a scrub refreshes geometry with no `renderMap` once a core exists. The 30 s live tick starts in `mount`, not at import. `_resetMapStateForTest` does not reset terminator visibility or remove the key. `new Date(clock.viewMs())` is the allowed form; a bare `new Date()` fails the clock rule. Mounting without `bindTerminatorClock` throws. A scrub now rebuilds terminator geometry even when the track is null. |

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
| Traps | `bindGroundTrackClock` runs at composition-root load, before `runScrubTier2`, so the track refreshes on a scrub that never calls `renderMap` once a core exists. A scrubbed view whose instant is already in the past draws the current orbit, not a window around that instant. The scrubbed window is one orbit even when multi-orbit is on, and it is empty when the track has no usable TLE. `_resetMapStateForTest` does not reset the in-memory multi-orbit flag. The `0, 0.85` opacity step in `layers.ts` is what `verify-map-pins.mjs` mutates. |

### iss-marker

| | |
| --- | --- |
| Directory | `src/map/features/iss-marker/` |
| Entrypoint | `issMarker` in `index.ts`, id `'iss-marker'` |
| User reaches it | Always on. The silhouette sits on the sub-point. |
| What it draws | One HTML marker, class `iss-marker`, anchored center. SGP4 when the track has a TLE, otherwise the polynomial clamped to its window. |
| Control it in code | `syncIssMarker(core)` creates it, or moves it when a manifest arrives while the view is scrubbed. `tickIssMarker(nowMs)` is the live 1 Hz move and does nothing while scrubbed. `moveIssMarkerToView()` moves it on every `setLookahead`, including a coalesced drag. `renderMap` calls `syncIssMarker` before `FEATURES` mount, and mount calls it again; the second call only `setLngLat`. |
| Files | `index.ts` is the element, the position, and the marker handle. Propagation is `src/iss.ts`. |
| Tests | `src/map/features/iss-marker/iss-marker.test.ts` mounts on the vendor double. `test/iss-marker.test.ts` and `test/map-render-contract.test.ts` drive it through `renderMap`. |
| Traps | The 1 Hz tick stays in the composition root. `maybeSnapToLive` returns before `tickIssMarker` and before `applyBearing`, so a snap does not also move the marker or rotate the map in that second. A drag moves the marker on the `setLookahead` call itself; `clock.onViewTime` is coalesced and is not the marker path. The early `setLookahead` returns ease the camera and do not call `moveIssMarkerToView`. |

### targets

| | |
| --- | --- |
| Directory | `src/map/features/targets/` |
| Entrypoint | `targets` in `index.ts`, id `'targets'` |
| User reaches it | Always on. Tap a score pin or a personal-target ring. A photo lookup resolves and `main.ts` calls `dropLookupPin`. The Profile distance slider calls `applyDistanceThreshold`. |
| What it draws | `my-targets-casing`, `my-targets-layer` (white rings), `targets-layer` (score colors, full opacity inside ±45 min of the view instant, dimmed outside), and `lookup-pin-layer` (magenta) on the first lookup. |
| Control it in code | `setTargetPasses` then `refreshTargetsSource` and `refreshMyTargetsSource`. `renderMap` still `ensureLayer`s the three target specs and calls `bindTargetInteractions` inside the `targets-layer` latch, so the click and hover handlers stay where the render contract recorded them. Launch mode hides these layers through `applyTargetLaunchVisibility`, which the launch feature calls via a callback the root installed. The edit deep-link is `EDIT_TARGET_EVENT` from `src/profile-events.ts`. |
| Files | `index.ts` refresh, tap, lookup pin, distance filter; `layers.ts` the three specs; `popup.ts` the popup body. Pass filtering is `src/pass-filter.ts`. |
| Tests | `src/map/features/targets/targets.test.ts`. `test/map-tap.test.ts`, `test/map-popup.test.ts`, `test/map-interaction-contract.test.ts`, `test/map-distance-filter.test.ts`, `test/photo-lookup.test.ts`, `test/personal-target-passes.test.ts`. |
| Traps | The popup's next-pass scan reads `bindTargetsClock`'s clock at click time, not the `nowMs` the popup was built with. `dropLookupPin` creates its handlers on first drop, so they are absent from the initial handler list. `_resetMapStateForTest` does not clear the profile-changed subscription. |

### launch-corridor

| | |
| --- | --- |
| Directory | `src/map/features/launch-corridor/` |
| Entrypoint | `launchCorridor` in `index.ts`, id `'launch-corridor'` |
| User reaches it | A launch card's map action. `main.ts` calls `focusLaunchOnMap(eventId)` when the map pane is showing. |
| What it draws | `ascent-trajectory-layer` (gold line) and `ascent-pad-layer` (gold circle). Shown while launch mode is on; the target pins hide. |
| Control it in code | `setLaunchPasses` then `refreshAscentTrajectorySource`. `syncMapLaunchMode` is one mode subscription and one `styledata` listener; it refreshes targets through the callback from `bindLaunchTargets`. `focusLaunchOnMap` calls the follow feature's `exitFollow` through `bindExitFollow`, then fits the site or the corridor. `renderMap` adds the layers and the pad handlers at the historical site. |
| Files | `index.ts` refresh, visibility, focus; `layers.ts` the two specs; `geometry.ts` `buildAscentFeatures` and `buildLaunchMapFeatures`. Domain is `src/launch-store.ts`, `src/launch-selectors.ts`, `src/map-launch-mode.ts`. |
| Tests | `src/map/features/launch-corridor/launch-corridor.test.ts`. `test/ascent-features.test.ts`, `test/launch-map-brief.test.ts`, `test/map-launch-mode-layer.test.ts`. |
| Traps | Legacy rows produce a pad and no corridor. One `styledata` listener covers both layer groups; a second listener fails `toHaveBeenCalledOnce` in the launch-mode test. `resetLaunchForTest` drops the mode subscription and keeps the artifact subscription. `focusLaunchOnMap` does not move the view time. |

### time-scrub

| | |
| --- | --- |
| Directory | `src/map/features/time-scrub/` |
| Entrypoint | `timeScrub` in `index.ts`, id `'time-scrub'` |
| User reaches it | `#time-slider`, `#time-back-90`, `#time-back-45`, `#time-now`, `#time-fwd-45`, `#time-fwd-90`. |
| What it draws | No layer. It pins `core.clock` and rewrites the stepper chips, the slider, and the readout. |
| Control it in code | `bindTimeScrubClock` registers `runScrubTier2` after the basemap, terminator, and ground-track listeners. `setLookahead` is the one time change. `bindScrubServices` is how the root hands it the marker, the camera ease, the target refresh, and the forecast deferral without a feature import. `maybeSnapToLive` returns true when the wall clock reaches the pinned instant. |
| Files | `index.ts` is the whole feature. The clock is `src/map/map-core/clock.ts`. |
| Tests | `src/map/features/time-scrub/time-scrub.test.ts`. `test/time-slider.test.ts`, `test/time-scrub.test.ts`, `test/map-clock.test.ts`, `test/forecast-frame.test.ts`, `test/map-imagery-date.test.ts`. |
| Traps | A drag frame coalesces view-time listeners and still moves the marker immediately. The same-instant and already-live returns ease the camera when `recenter` is set and do not `setLngLat`. The 30 s label tick is `clock.every` in `renderMap`, not a second listener. Tier-2 still refreshes targets only when a track is published through `setScrubTrack`. |

### follow-iss

| | |
| --- | --- |
| Directory | `src/map/features/follow-iss/` |
| Entrypoint | `followIss` in `index.ts`, id `'follow-iss'` |
| User reaches it | Dock `#toggle-follow-iss`, `#bearing-north`, `#bearing-iss`. Follow starts on and is not persisted. Bearing starts iss-up and survives reload. |
| What it draws | No layer. Follow calls `setCenter` once a second from `main.ts`. Bearing calls `setBearing` or `easeTo`. |
| Control it in code | `applyFollowISS` no-ops while follow is off, the core is missing, or the view is scrubbed. `exitFollow` is what a drag, a user zoom, and `focusLaunchOnMap` call. `readBearingMode` reads `PREF_KEYS.bearingMode` (default iss-up; only `'north'` selects north). The 1 Hz bearing uses `currentBearingMode`, the in-memory value, which `_resetMapStateForTest` sets to north. `bindFollowToggle` and `bindBearingToggle` run in `renderMap` before `FEATURES` mount, so drag and zoom stay ahead of the pin-drop handlers. |
| Files | `index.ts` is the whole feature. Heading samples are `src/iss.ts`, `src/iss-sgp4.ts`, and `src/pin-drop.ts` (`greatCircleBearingDeg`). |
| Tests | `src/map/features/follow-iss/follow-iss.test.ts`. `test/map-follow.test.ts`, `test/map-bearing.test.ts`, `test/map-overlay-prefs.test.ts`, `test/launch-map-brief.test.ts`. |
| Traps | The follow click flies with `flyTo({ duration: 800 })` and does not pass `essential`. Recurring follow is `setCenter`, not `easeTo`. A scrubbed follow click flies to the marker on screen. `applyBearing` skips a write within 0.5°. |

## Composition root

`src/map/index.ts` builds the style, creates the core, and calls each feature at the site that used to own that work, so layer order and the handler list stay put. It re-exports the functions `main.ts` and the tests import from `../src/map`. The only module-level `let` is `core`.

| Concern | Where |
| --- | --- |
| First paint | `buildStyle` |
| Startup | `renderMap`, then `refreshMapForManifest` for a newer manifest |
| The 1 Hz tick | snap, then marker, then bearing, in that order |
| Cross-feature wiring | `bindScrubServices`, `bindLaunchTargets`, `bindExitFollow`, `bindFollowMarker`, installed at load |

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
