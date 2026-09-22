# Target architecture

The shape the map should have. `ARCHITECTURE_NOW.md` describes what existed at the start; this describes what replaces it and in what order. Slices 0 to 11 have shipped; each slice's record under "Phase 3 slices" says what it actually did.

## The shape in one paragraph

**Catalog-ordered features.** One ordered tuple of layer ids is the paint order, and it lives in `map-core/catalog.ts`. A feature is one directory that declares its sources, its layers, its control and its reactions, and it never says where its layers paint, because the catalog already decided. When a feature adds a layer, `map-core` computes the `beforeId` by walking the catalog for the nearest successor already on the map, so the stacking is the same whatever order features mount in. Everything the map shows is one immutable `View` record. The only thing a feature may call is a typed facade with no MapLibre type in any signature. `map-core` never imports a feature; the composition root hands it the list.

That last sentence is the whole design. Today paint order is a side effect of the call sequence inside a 606-line `renderMap`, and the comment above the labels layer claims it "remains TOPMOST above all later overlays" while the lookup pin, the dropped pin and every satellite track land above it. Making order a value a test reads, rather than a sequence a test observes, is what lets code move at all.

## Nouns

Use these words and no synonyms.

`feature` is one user-facing map capability, one directory. `entrypoint` is the single `MapFeature` object that directory exports. `map-core` owns the map instance lifecycle, the camera, the style, the clocks, the persistence table and the source and layer runtime. `overlay` is non-basemap drawing: markers, popups, rings, pins, heatmaps. `tool` is an interaction mode, and this app has exactly one today, launch mode. `adapter` is the boundary to MapLibre, and the only place a MapLibre type appears.

## Target layout

Only `map.ts`, `map-launch-mode.ts` and `viirs-alpha-protocol.ts` move. The other 54 flat modules in `frontend/src` are pure domain and the other four tabs; this design does not touch them. Features import leaf math such as `terminator.ts`, `iss.ts` and `satellites.ts` directly, because that is domain, not feature.

```
frontend/src/map/
  index.ts                  composition root. the one `let core`. main.ts dynamic-imports this
  map-core/
    catalog.ts              LAYER_ORDER, the id unions, positionOf, beforeIdFor
    view.ts                 View, ViewTime, Overlays, BearingMode, changed()
    feature.ts              MapFeature, RenderContext
    core.ts                 MapCore, createMapCore over a VendorMap and a Clock
    vendor-map.ts           the VendorMap interface, in domain types only
    geometry.ts             LngLat, Point, BBox
    layer-spec.ts           LayerSpec, SourceSpec, StyleSpec
    camera.ts               initialZoomForViewport, initialCamera
    prefs.ts                the one localStorage key table
    clock.ts                ViewTime, now, every, throttle
  adapters/maplibre/
    index.ts                createVendorMap, markers and popups. the only importer of maplibre-gl
    events.ts               MapLibre payloads to Hit, Tap, LngLat
    viirs-alpha.ts          moved from src/viirs-alpha-protocol.ts
  features/
    index.ts                FEATURES, the one registration list
    basemap/                clouds, IR, Esri, Carto. one decision over four layers
    labels/
    night-lights/
    terminator/
    ground-track/
    iss-marker/
    targets/
    launch-corridor/
    pin-drop/
    satellites/
    time-scrub/
    follow-iss/
```

Each feature directory holds `index.ts` (the entrypoint), `layers.ts`, `state.ts` where it has any of its own, and its own `*.test.ts`.

## The domain model

The catalog is the source of truth for both identity and order.

```ts
export const LAYER_ORDER = [
  'esri-imagery-layer',
  'carto-dark-layer',
  'gibs-clouds-layer',
  'geo-ir-layer',
  'fcst-clouds-layer',
  'ne-coastline-layer',
  'night-lights-global-dim-layer',
  'terminator-night-fill-layer',
  'viirs-night-lights-layer',
  'iss-track-layer',
  'my-targets-casing',
  'my-targets-layer',
  'targets-layer',
  'terminator-line-layer',
  'subsolar-point-layer',
  'ascent-trajectory-layer',
  'ascent-pad-layer',
  'esri-labels-reference-layer',
  SAT_TRACK_SLOT,
  'lookup-pin-layer',
  'dropped-pin-layer',
] as const;

export type LayerId = (typeof LAYER_ORDER)[number] | SatTrackLayerId;
```

Strip `fcst-clouds-layer` and the last three entries and what remains is exactly the seventeen-string array `map-render-contract.test.ts` already asserts. The four extras are the on-demand layers. `fcst-clouds-layer` sits where its `beforeId: 'ne-coastline-layer'` puts it today. The other three append with no `beforeId`, so their relative order is whichever capability the operator reaches first, and the catalog is what makes it deterministic.

`View` is one immutable record of everything the map shows: the time (live or scrubbed, with `atMs` required when scrubbed so a half-set scrub cannot be constructed), the overlay flags, follow, bearing mode, launch mode, the current data, the active profile and the selected satellites. Features read it, and only the facade writes it.

```ts
export interface MapFeature {
  readonly id: FeatureId;
  readonly style?: StyleContribution;
  mount(core: MapCore): void;
  render?(ctx: RenderContext): void;
  frame?(ctx: RenderContext): void;
}
```

`mount` runs once after `load` and is the only place a feature adds layers, markers, handlers and controls. `render` runs after every `View` change and receives the previous `View`, so a feature skips work with `changed(ctx, 'time', 'data')`. `frame` runs per animation frame during a slider drag and only two features implement it. That maps onto today's two scrub tiers at `map.ts:2234` and `map.ts:2350` without inventing a third.

These must not compile, and each is a bug the current code can express:

```ts
core.ensureLayer({ id: 'aurora-oval-layer', type: 'fill', source: 'aurora-oval', paint: {} });
core.setVisibility('targets-layr', false);
core.setGeoJson('gibs-clouds', []);
const time: ViewTime = { kind: 'scrubbed' };
```

A layer id that is not in `LAYER_ORDER` is not assignable, so a layer cannot exist without a paint position. A typo is not a `LayerId`. `gibs-clouds` is a raster source and `setGeoJson` takes GeoJSON sources. A scrubbed time with no instant is missing a required property.

## The facade

`MapCore` is what a feature is allowed to call. It groups into state writers (`setViewTime`, `setOverlay`, `setBearingMode`, `setFollow`, `setLaunchMode`, `setSatellites`), the layer and source runtime (`ensureLayer`, `setVisibility`, `setGeoJson`, `setRasterTiles`), overlays (`addMarker`, `openPopup`, `closePopups`), input (`onTap`, `onLayerTap`, `queryAt`, `onLongPress`, `onSourceError`), camera (`camera`, `setCenter`, `setBearing`, `easeTo`, `flyTo`, `fitBounds`) and time (`every`, `now`).

What each group hides is the test of whether it earns its place. `ensureLayer` hides the `beforeId` computation, the `getLayer` existence guards (slice 1 already collapsed 12 of the 16 `if (!map.getLayer(` add-guards into it, leaving 4 that double as bind-once latches plus 11 `if (map.getLayer(` visibility guards, 19 `getLayer` calls in all), and the style-not-loaded `try` blocks. `setGeoJson` hides today's `upsertGeoJson` add-or-`setData` branch. `openPopup` hides the popup tracking that `trackMapModePopup` does and the `setDOMContent`-not-`setHTML` rule that keeps a user-supplied target name from executing. `every` hides the interval latches (`liveTimer`, `timeLabelTimer`, `irTickerStarted`, `_satTrackTickerStarted`) and makes the tick take `nowMs` so a feature cannot reach for `Date.now()` and silently ignore the scrub. `queryAt` hides the seven-pixel tap box and the layer-priority order.

There is deliberately no `setStyle`, no `getLayer`, no `addLayer(spec, beforeId)` and no `removeLayer` for anything but satellite tracks, which are the only layers the app ever removes.

## How layer order is guaranteed

This is the hardest part and it is where the three design candidates differed most.

Order is not "features mount in the right sequence". It is computed:

```ts
export function beforeIdFor(id: LayerId, present: (id: LayerId) => boolean): LayerId | undefined {
  for (const slot of LAYER_ORDER.slice(positionOf(id) + 1)) {
    if (present(slot)) return slot;
  }
  return undefined;
}
```

`ensureLayer(spec)` returns if the layer is already there, and otherwise adds it below the nearest catalog successor that is currently on the map. A layer therefore lands in its catalog position whatever order features mount in and whenever they add.

Three things hold it:

The **build** rejects an unplaced layer, because `LayerSpec['id']` is derived from `LAYER_ORDER` and the only way to make a new id assignable is to insert it into the tuple at a position.

The **test** rejects a placement regression twice over. `map-render-contract.test.ts` keeps asserting the same seventeen string literals it asserts today, unedited. A new `map-core/core.test.ts` mounts `FEATURES` and `[...FEATURES].reverse()` against the same `RecordingMap` and asserts both produce that array. That second test is the one that fails the day order stops being catalog-derived, and it is not expressible against today's code.

The **mutation lever** rejects a silent catalog edit. `scripts/verify-map-pins.mjs` swaps two entries in `LAYER_ORDER` and asserts the suite goes red, and separately drops the `beforeIdFor` argument from `ensureLayer` to prove the pins catch an append. Those two replaced the mutation that string-edited `beforeTrack` inside `map.ts`, which slice 1 deleted.

## How a feature registers

Copy a feature directory. Rename it. Edit three lines outside it: one entry in `LAYER_ORDER`, one entry in `FEATURES`, and one button in `index.html` if it needs a control. That is the only registration path, and `architecture-boundaries.test.ts` fails a directory whose `index.ts` does not export a `MapFeature` whose `id` matches the directory name, an id missing from `FEATURES`, an id in `FEATURES` with no directory, and a directory with no `<name>.test.ts` beside it. The step-by-step recipe is in the repository's `AGENTS.md`.

## What fails the build

One Vitest file, `frontend/test/architecture-boundaries.test.ts`, run by `bun run test`, which CI already runs. Vitest's `include` is `test/**/*.test.ts`, so a check under `src/` would need a config change to run at all; it lives beside the other 93 test files instead. It parses `frontend/src/**/*.ts` with the `typescript` package that is already a dependency, so there is no new tool, no new CI step and no new config file. It carries a self-test that feeds one violating snippet per rule to the rule function, the same way `verify-map-pins.mjs` proves the pins.

Every rule below is live as of slice 6. Each landed with the slice that gave it something to guard: the vendor and eager-import rules before any code moved, the adapter rule with slice 2, the map-core and module-state rules with slice 3, and the rest with slice 6.

It rejects: `maplibre-gl` imported outside `adapters/` (and `map.ts` until it is gone); `map-core/` importing `features/`, `adapters/`, the vendor or the legacy module; a feature importing another feature's files, the registry, the composition root, the legacy module or `main.ts`; an overlay importing a feature; an adapter imported anywhere but the composition root; any static import of the map entry, which is what keeps the 800 KB MapLibre chunk out of the app shell; a feature directory that is not in `FEATURES`, an id with no directory, an id listed twice, an `index.ts` that does not export the object `FEATURES` holds, or a directory with no `<name>.test.ts`; a top-level `let` or `var` anywhere under `src/map/` except the composition root; `Date.now()`, a bare `new Date()` or `performance.now()` anywhere under `src/map/` but `clock.ts`, which is the two-clock gotcha; an `opd-` key literal or a `localStorage` call whose key is not a `PREF_KEYS` entry anywhere under `src/map/` but `prefs.ts`, plus a `PREF_KEYS` entry nothing reads; `as any`, `@ts-ignore`, `TODO` or `FIXME` under `src/map/`; and any comment under `src/map/` that is not a `/** */` doc comment. The design said "any comment"; the shipped rule keeps the doc comment because it is the one form that states a contract on the declaration below it and shows on hover, and it is the form every module under `src/map/` already used. Line comments and plain block comments, the forms that narrate code, fail.

`tsconfig.json` also gains `noUnusedLocals` and `noUnusedParameters`. Running `bunx tsc --noEmit --noUnusedLocals --noUnusedParameters` on this branch today produces exactly 12 errors: three in `map.ts` (`fetchTLEByCATNR`, `fetchTLEByName`, `formatUtc`), one in `terminator.ts`, one in `main.ts` and seven in tests. Slice 0 fixes all 12.

## What becomes a feature, and in what order

The candidates disagreed about scope, and the disagreement is worth recording because it is the main risk in this plan.

The case against full feature folders is that the overlays are not independent. `basemapVisibility` decides four layer visibilities from one state, so clouds and IR are one decision, not two features. Three night layers are inserted with `beforeId: 'iss-track-layer'`, so they know about the ground track. `applyMapLaunchVisibility` writes `targets-layer` and `my-targets-layer`, so launch knows about targets. Folders around coupled code are pass-throughs, and the churn is real: all 4550 lines redistributed, roughly 40 files touched, and every map pin in play.

Two of those three couplings dissolve under this design rather than moving. `beforeIdFor` means no feature ever writes `beforeId: 'iss-track-layer'`; the catalog does. Launch mode becomes a `tool` flag on `View`, and each feature derives its own visibility from `view.launchMode` instead of one function reaching across three layers. The one that does not dissolve is `basemapVisibility`, and the answer there is that it is one feature, `features/basemap`, owning all four layers, not four features sharing a helper.

The residual risk is sequencing, not shape, so the plan is staged. Wave one moves the two capabilities that the seventeen-layer pin does not name, `pin-drop` and `satellites`, roughly 875 lines. They prove the recipe with the strongest pin untouched. Wave two moves `basemap`, `labels`, `night-lights` and `terminator`, which is where `beforeIdFor` gets its real test. Wave three moves `ground-track`, `iss-marker`, `targets`, `launch-corridor`, `time-scrub` and `follow-iss`, and deletes `map.ts`.

If wave two shows that `beforeIdFor` does not in fact hold the order, the honest outcome is to stop with wave one shipped and the rest as `map-core` modules. That is candidate C's design, reached by evidence instead of by guess.

## Phase 3 slices

Each slice is one commit that ends with `bun run typecheck`, `bun run test` and `node scripts/verify-map-pins.mjs` green. No compatibility shims, no old-and-new path: callers move and the old symbol dies in the same slice.

**Slice 0, subtract.** Shipped as four commits. Deleted the unused `fetchTLEByCATNR` and `fetchTLEByName` imports, the unused `formatUtc`, the write-only `pollScheduler` binding in `main.ts`, the dead `wrapBackToWorld` closure in `terminator.ts`, the `_resetViirsFallbackForTest` no-op, and the stale eleven-line `map.ts` header. Turned on `noUnusedLocals` and `noUnusedParameters` and fixed the 12. Collapsed the four longitude wraps into `geo.ts`, which imports nothing; `iss.ts` was the wrong home because it pulls `satellite.js` behind it. Moved `filterPassesByDistance` and the 1500 km default to a pure `pass-filter.ts` and deleted the `applyDistanceFilter` clone in `main.ts` with the comment that falsely claimed it delegated. Rewrote the source-text assertions in `map-ir.test.ts` and `map-night-lights.test.ts` as runtime assertions, so no test reads `map.ts` as a string.

Two of this slice's planned deletions were wrong and did not happen. `refreshMapForManifest` has a live caller at `main.ts:311` and its `if (!map) return` guard is the whole point: `main.ts` cannot see the module-level `map`, so the guard is what stops a background manifest poll from constructing the map on a tab that never opened it. `reflectCloudsButtonState` is called from the IR toggle path, because the clouds button's own reflect is a closure the IR handler cannot reach. Both earn their place. The Earth radius unification named in the brief's gotchas also did not happen: the six definitions carry two different values, 6371 and 6378.137, so collapsing them would move numbers, and this is a structural change.

**Slice 1, the catalog.** Shipped as three commits. Added `map-core/catalog.ts` with `LAYER_ORDER`, `SOURCE_IDS`, the id unions and `beforeIdFor`, and `map-catalog.test.ts`, which first proved `beforeIdFor` reproduced every `beforeId` `renderMap` hand-wrote. Then replaced all 16 `map.addLayer` sites in `map.ts` with a private `ensureLayer(spec)` whose `spec.id` is a `LayerId` and `spec.source` a `SourceId`, so a misspelled id fails `tsc`, and which places the layer by catalog position. That deleted the `beforeTrack` anchor, the forecast raster's fail-closed `ne-coastline-layer` check, 12 of the 16 `if (!map.getLayer(` guards, and six comments that explained stacking by call order. The four guards left double as bind-once latches for click handlers and go with the facade's `onLayerTap`. The satellite track ids come from `satTrackLayerId` and `satTrackSourceId`. One behavior changed, and it is the permitted kind: the on-demand pin and satellite layers now stack in catalog order whichever the operator makes first, pinned in `map-catalog.test.ts`. `view.ts` waits for slice 3, where `MapCore` is its first consumer; a type with no reader is dead code.

**Slice 2, the adapter directory.** Shipped as one commit. Moved `viirs-alpha-protocol.ts` to `adapters/maplibre/viirs-alpha.ts`, where it imports `maplibre-gl` itself instead of taking the module as a parameter, and dropped its `registered` latch: `map.ts` registers once at module load, and under `vi.resetModules()` both modules reset together, so the latch never had a second call to stop. `_keyAlphaForTest` became `keyAlpha`, because `keyTileBytes` calls it and it was never test-only. The vendor rule now allows the adapter directory plus the legacy module, and a containment rule fails any import of `adapters/` from outside the composition root. The `Map`, `Marker`, `Popup`, `NavigationControl` and `LngLatBounds` constructions stay in `map.ts` until slice 3, because moving them means giving them domain signatures, and a `VendorMap` with no `MapCore` calling it would be dead code in the meantime. `vi.mock('maplibre-gl')` in the contract tests keeps working; the double's `addProtocol` recorder already took the call.

**Slice 3, the facade and the clock.** Shipped as five commits, in two halves. The first half gave the vendor a domain-typed interface: `map-core/vendor-map.ts` (`VendorMap`, with `Hit`, `Tap`, `LayerTap`, `MarkerHandle`, `PopupHandle` and the event maps), `map-core/geometry.ts` (`LngLat`, `Point`, `BBox`), `map-core/layer-spec.ts` (the raster, line, fill, circle and background specs and `StyleSpec`), `map-core/camera.ts` (`initialCamera`), and `adapters/maplibre/index.ts` + `events.ts`, which are the only modules that know MapLibre. Then `map.ts` moved onto it in one wave: every `maplibregl` reference went, `new Map`, `Marker`, `Popup`, `NavigationControl` and `LngLatBounds` constructions became `createVendorMap`, `addMarker`, `openPopup`, and `fitBounds(BBox)`, and `HitFeature` died in favor of `Hit`. `GeoJsonSource.data` widened to `FeatureCollection | string` because `ne-coastline` is a URL.

The second half made the catalog say which sources are raster and which are GeoJSON, so a raster layer over a GeoJSON source and `setGeoJson('gibs-clouds', ...)` no longer typecheck; nothing in `buildStyle` had to change to satisfy it. Then it added the two modules this slice is named for. `map-core/clock.ts` is the one answer to what instant the map renders: a `ViewTime` that is `live` or `scrubbed` with a required `atMs`, `viewMs()`, `now()`, `every()` for a ticker started once and handed the wall clock, and `throttle()`, the leading-plus-trailing gate the slider drag uses. `map-core/core.ts` is `MapCore`, built over a `VendorMap` and a `Clock`: `ensureLayer` places by the catalog, `setVisibility` drops a write to an absent layer, `setGeoJson` creates the source on first write, `removeLayer` and `removeSource` accept only satellite-track ids, and `openPopup` with an `owner` closes the last popup of that owner and forgets it on close. Both are pinned in `map-clock.test.ts` and `map-core.test.ts` against `test/vendor-map-double.ts`, an in-memory `VendorMap` that the feature tests of waves one to three will share.

`map.ts` then moved onto both. It holds one `core` and one `clock` where it held a `vendor` and its own time: `viewTimeMs` and `currentViewMs` became a `ViewTime` and `clock.viewMs`; every `Date.now()` became `clock.now()`, so the two clocks a line could reach for sit on one object; the 1 Hz, 30 s, 60 s and 120 s tickers start once through `clock.every`, which deleted `liveTimer`, `timeLabelTimer`, `_satTrackTickerStarted` and `irTickerStarted` (the last was redundant with `irToggleBound`); the tier-2 throttle became `clock.throttle`, deleting three state variables and two functions; the private `ensureLayer`, `upsertGeoJson`, `trackMapModePopup` and `dismissMapModePopup` went, and eight `if (hasLayer) setVisibility` guards collapsed into the facade. `map.ts` is 4265 lines and 48 module-level `let`s, from 4518 and 55 when the slice began. The scrub tiers themselves (`runScrubTier2` and the drag fast path in `setLookahead`) stay in `map.ts` until the `time-scrub` feature, because they are the list of surfaces to refresh, and that list is what wave three distributes. One delta, not a contract: the 1 Hz and 30 s tickers no longer re-phase when a manifest refresh re-runs `renderMap`. Proven on the built artifact in a real browser: a view scrubbed one minute ahead snapped back to `Now` on its own after 60 s, and a second target tap replaced the first popup instead of stacking.

**Slice 4, the first feature.** Shipped as four commits: pin, shape, move, lever. The pin came first, `map-pin-drop-contract.test.ts`, which drives `renderMap` through the MapLibre double with a real ISS TLE so the popup lists actual passes, and holds right-click, the 500 ms hold, the 8 px drift that cancels it, the two-finger start that never arms it, replace-on-second-drop, click-to-dismiss and the no-track no-op. The shape is three small things: `map-core/view.ts`, the immutable `View` record (`track`, `satellites`) that `MapCore` now carries behind `view()`, `setTrack()` and `setSatellites()`; `map-core/feature.ts`, the `MapFeature` contract (`id`, `mount(core)`); and `features/index.ts`, the `FEATURES` tuple that `renderMap` walks once on first init. `'pin'` joined the popup owners. Then the move: `features/pin-drop/` holds the layer spec, the popup footer, the entry point and a co-located test that mounts the feature on `createMapCore` over the vendor double, with no `renderMap` and no MapLibre. The pass-list body became `overlays/pass-list.ts` because the target popup builds the same list; `formatUtcHm` went to `countdown.ts`, where its callers already were. `map.ts` publishes the track after the first load and the selected satellites on every change, and lost 412 lines and four `let`s (3853 and 44 now). The feature imports `pin-drop.ts` for pass math and `profile.ts` for the profile name; those are domain modules, not map internals, and the boundaries rule of slice 6 will say so. The lever gained two mutations against `features/pin-drop/index.ts`: reading passes from `clock.viewMs()` instead of `clock.now()`, and raising the drift threshold to 1000 px; both turn the contract test red. Proven on the built artifact: the same Playwright script ran against the build before this slice and the build after, and the two logs are byte-identical except for the count of external tile timeouts. One harness note for whoever runs it next: Chrome's emulated touch synthesizes a click at the finger on lift, which lands on the fresh pin and fires its own dismiss, so the long-press assertion samples state while the finger is still down. Both builds do this. A styling defect the walkthrough made visible is recorded in `FOLLOWUPS.md`, not fixed here.

**Slice 5, the second feature.** Shipped as six commits: clock, pin, isolation, move, lever, record. The clock came first because the satellites were the second surface that refreshes on a scrub, and the first one lived inside `runScrubTier2`'s private throttle. `Clock` gained `onViewTime(listener)`, a `cadence` on `setViewTime` (`'now'` notifies at once, `'coalesced'` runs the listeners through `clock.settle`, a 150 ms throttle), and `settle` itself for the slider's pointer-up flush. `runScrubTier2` became the first listener, `setLookahead` lost its two-branch drag/discrete split, and the module-level `scrubTier2` throttle went. Listeners are isolated from one another: a throw in one does not stop the next or the scrub, which is the posture the old `safely` wrapper and the 60 s ticker's `try` gave the satellite refreshers. Then the pin, `map-satellites-contract.test.ts`: 17 tests through `renderMap` and the MapLibre double with a stubbed CelesTrak, holding the picker, the curated list, the dashed track spec and its position above the labels, the one-orbit 30 s sampling with world copies, the marker, the topbar readout, NORAD and name lookups, the stale and multi-match badges, removal, persistence, and the two tickers live and scrubbed. The move: `features/satellites/` holds `selection.ts` (the localStorage key and the three `SatelliteMeta` shapes a persisted key can take), `layers.ts` (`orbitOf`, `subPointAt`, `orbitTrackFeatures`, `trackLayer`, `markerElement`), `picker.ts` (the panel, behind a four-method `PickerPort`), the entry point and a co-located test over the vendor double. The feature owns its `tracked` map, publishes `View.satellites` (which gained `label` for the topbar) on every change, and drives its own 60 s and 1 Hz tickers from `core.clock.every` plus one `onViewTime` listener, so `main.ts` no longer calls `tickSatelliteMarkers` from the countdown tick. `buildLineFeatures` became `overlays/track-line.ts` because the ISS ground track and the satellite tracks share it; `ISS_ORBIT_PERIOD_SECONDS` went to `iss.ts`. `getSatelliteTopbarReadouts` stays in `map.ts` for now and reads `core.view().satellites`; it belongs to the topbar, and the topbar is `main.ts`. `satellite-scrub.test.ts` was deleted: its scrub pins are held by the contract test, and its two pure-function pins moved to the co-located test against `orbitTrackFeatures`. `map.ts` lost 498 lines and two `let`s plus the `selectedSatellites` map (3355 and 42 now). The lever gained `map-satellites-contract.test.ts` and three mutations against `features/satellites/index.ts`: the track window from `clock.now()`, the marker from `clock.now()`, and dropping the persist on removal; all three turn the contract red, 15 of 15 pinned. Proven on the built artifact: one Playwright script, the wall clock fixed with `page.clock.setFixedTime` and CelesTrak routed to two saved TLEs, ran against the build before the slice and the build after; the two logs are byte-identical across checking Tiangong, typing a NORAD number, a 30 s wall-clock advance moving the markers and readouts while the windows hold, a +90 scrub moving windows and markers while the readouts stay live, Now, a dropped pin listing both satellites, unchecking, and a reload restoring the persisted one. One behavior the move dropped and one pre-existing race the walkthrough surfaced are in `FOLLOWUPS.md`.

**Slice 6, the recipe.** Shipped as six commits: key table, sideways imports, registry, clock, comments, docs. Each rule went into `architecture-boundaries.test.ts` as a pure function over one file's text with a self-test that feeds it a violation, and each was also proven live by breaking a real file and watching the suite name it. `map-core/prefs.ts` is `PREF_KEYS`, the one table of storage keys the map owns; the satellites selection reads its key from it, and any `opd-` literal or off-table `localStorage` call under `src/map/` fails, as does a table entry nothing reads. The feature rule resolves each relative specifier to its path under `src/`, so it reads paths and not spellings: a feature may import map-core, overlays, its own files and domain leaves, and nothing else under `src/map/`; an overlay may import no feature. The registry rule reads the directories under `features/` and the real `FEATURES`, requires them to be the same set under directory names, requires each `index.ts` to export the very object `FEATURES` holds, and requires a `<name>.test.ts` beside it. The clock rule flags `Date.now()`, a bare `new Date()` and `performance.now()` everywhere under `src/map/` but `clock.ts`. The comment rule reads every token's trivia through the parser and fails anything that is not a doc comment; `viirs-alpha.ts` lost fourteen narrating lines and gained `rec601Luma`, the function named for what two of them explained, and two empty catches lost the block comments that said why they were empty, which their tests say instead. Then the docs: `docs/agent/FEATURE_MAP.md` lists every capability, the two features in full and the nine still in `map.ts` by the symbols that own them, with user path, tests and traps per row; the repository's `AGENTS.md` is the index, with the nouns, the enforced rules, the eight-step recipe and the three verify commands. Typecheck clean, 1860 tests green, lever 15 of 15.

**Slice 7, the basemap.** Shipped as two commits. `features/basemap/` owns the four-layer decision (`visibility.ts`), forecast frame pick (`forecast.ts`), and the runtime: clouds and IR toggles, the IR repick, the forecast raster, the imagery badge, and the Esri and forecast tile-error fallback. `PREF_KEYS` gained `cloudsVisible` and `irVisible`. Mutable state is one const object, so the module-level `let` rule still holds. `buildStyle` stays in `map.ts`; the first paint is the same style object. `map.ts` calls `bindBasemapClock` at load, before `runScrubTier2`, because `setLookahead` refreshes the badge in tests that never call `renderMap`. `attachBasemap` registers the tile-error handler when the core is created, before `whenLoaded`. `setForecastSwapDeferred` tracks the slider drag, and the pointer release still calls `refreshForecastCloudLayer` after `settle.flush`, because a same-instant release can skip `setViewTime`. `FORECAST_CLOUDS_UI` stays false. The lever's Esri mutation now points at `visibility.ts`. The render-contract handler list moved the IR listeners to feature-mount time, after follow's drag and zoom listeners; the same handlers are still bound. `map.ts` is 2739 lines and 27 module-level `let`s, from 3355 and 42. Typecheck clean, 1865 tests green, lever 15 of 15.

**Slice 8, labels.** Shipped as two commits. `features/labels/` owns the Esri reference raster and the dock toggle. The source stays in `buildStyle`; `refreshLabels` adds the layer on every `renderMap`, at the same point it was added before, so the runtime add sequence does not move. `PREF_KEYS` gained `labelsVisible` (default on). The lever's default-on mutation now points at `features/labels/index.ts`. `map.ts` is 2684 lines and 25 module-level `let`s, from 2739 and 27. Typecheck clean, 1868 tests green, lever 15 of 15.

**Slices 9 to 10, night lights and terminator.** Shipped as two commits. `features/night-lights/` owns the VIIRS raster, its dock toggle, and the tile-error hide-and-retry. `features/terminator/` owns the night fill, the gold line, the subsolar point, the dock toggle, and the 30 s live rebuild. The dim they share is `overlays/global-dim.ts`: one const flags object, `dimVisible = flags.nightLights && !flags.terminator`, because a feature cannot import another feature. `PREF_KEYS` gained `nightLightsVisible` (default off) and `terminatorVisible` (default on). `buildStyle` still owns the VIIRS source. `map.ts` calls `bindTerminatorClock` at load, before `runScrubTier2`, and still `ensureLayer`s the five night overlay specs at the historical site so `addLayerCalls` stay dim, fill, VIIRS, line, subsolar. Feature `ensureLayer` is idempotent after that. The 30 s tick starts in terminator `mount`, not at import, so loading `map.ts` does not arm an interval. `test/map-mount-order.test.ts` mounts terminator, night lights and labels in reverse on the vendor double and asserts painted ids match `LAYER_ORDER`; that is the wave-two proof that `beforeIdFor` holds. The render-contract handler list moved the night-lights `error:*` from after `styledata` to after pin-drop, which is feature-mount time; the same handler is still bound. One delta, not a contract: terminator geometry now refreshes on a scrub even when `currentTrack` is null. The lever's 95% opacity mutation now points at `features/night-lights/layers.ts`, and the dim mutation at `overlays/global-dim.ts`. `map.ts` is 2415 lines and 20 module-level `let`s, from 2684 and 25. Typecheck clean, 1876 tests green, lever 15 of 15.

**Slice 11, the ground track.** Shipped as three commits: pin, move, record. `test/map-ground-track-contract.test.ts` came first and held the paint, the multi-orbit toggle, the polynomial fallback, and the scrubbed one-orbit window through `renderMap`. `features/ground-track/` owns the geometry, the layer, the dock toggle, and the scrub rebuild. `PREF_KEYS` gained `multiOrbitVisible` (default off). `map.ts` calls `bindGroundTrackClock` at load, before `runScrubTier2`, and calls `refreshGroundTrack` where the layer used to be added, so `iss-track-layer` stays the first runtime add. The scrub no longer rebuilds the track inside `runScrubTier2`; the clock listener does, and it is registered before that tier, so the track still updates before the target pins. A scrubbed instant already in the past still draws the current orbit. The lever gained the 85% opacity mutation against `features/ground-track/layers.ts`. `map.ts` is 2078 lines and 18 module-level `let`s, from 2415 and 20. Typecheck clean, 1883 tests green, lever 16 of 16.

**Slices 12 to 16, wave three.** `iss-marker`, `targets`, `launch-corridor`, `time-scrub`, `follow-iss`. Delete `map.ts`.

## What this gives up

Teardown. There is still no `map.remove()`; the instance and the tickers live for the page. Adding `teardown` to `MapFeature` without a destroy path would be a fake method.

An exclusive tool state machine. Launch mode stays a boolean on `View` and pin-drop stays always armed, because that is today's behavior.

Camera as app state. Center and zoom stay inside MapLibre and nothing serializes them, so a reload still opens at `[0, 0]` until the follow tick, exactly as now.

A UI framework. Dock buttons stay in `index.html` and a new feature pays a one-line HTML edit, which the registry rule catches when it is forgotten.

The comment ban costs real history. `map.ts` carries 1293 comment lines, many of them decision records naming an operator and a date. Those become test names where a test can carry them, and entries in a decisions log where one cannot. Deleting them without that step would lose information the team paid for.

One deliberate non-deletion. Candidate A proposed deleting the whole forecast cloud path in slice 0, on the grounds that `FORECAST_CLOUDS_UI` is `false` and the generator flag is off. That removes 15 tests and halves the `basemapVisibility` truth table from 16 rows to 8, which is tempting. It is still a product call about a complete capability, not a structural one, and `FOLLOWUPS.md` already asks it. It stays until someone answers. The cost of keeping it is that the basemap arbiter carries the forecast branch through the whole migration.

## Reader-load delta

Today, "where does paint order come from" has two answers and one of them is wrong: the call sequence inside `renderMap`, and the comment above the labels layer that calls it topmost. A third, the five-layer header, is already deleted. After, there is one tuple, walked by one function, asserted as a literal by a test that exists today.

Today, "what can change the clouds" is nine names in one 4550-line file: `cloudsVisible`, `irVisible`, `forecastFrameActive`, `esriTilesFailed`, `bindCloudToggle`, `bindIrToggle`, the error handler, `refreshForecastCloudLayer` and `basemapVisibility`. After, it is `core.setOverlay('basemap', next)`, one writer into one `View`.

Today, "how do I add an overlay" has no answer, because no example keeps the change in one place. After, it is copy a directory, add one catalog row and one registry line.

The 55 module-level `let`s in `map.ts` go to zero. An agent no longer has to know that `renderMap` is both constructor and refresh path, which of the 24 `opd-` keys belong to the map, or which of `Date.now()` and `currentViewMs()` a given line should use.

## Synthesis decision

Three design packages were produced in parallel by different models against the same brief and the same pins, then synthesized here. One argued a full feature reshape, one a compiled scene catalog with a code generator, one a minimal split that freezes the seventeen layers in `map-core` and makes only late overlays into features.

Taken: the catalog-derived `beforeIdFor` and the reverse-mount test, which is the strongest idea in the three and the only proposal that makes order an invariant rather than a convention. The boundaries check as a Vitest file over the already-installed TypeScript compiler, because it adds no dependency and no CI step. The single immutable `View`, which all three converged on independently.

Rejected: the code generator and checked-in generated files. A repo with no linter and no generator should not require an agent to learn a build step before it can add a layer, and the generator solves an ordering problem that `beforeIdFor` solves without it.

Taken from the skeptic: the churn accounting, the staged waves, and the refusal to delete the forecast path. Its central claim, that the overlay coupling makes feature folders pass-throughs, is right about the cost and wrong about the cause: two of its three couplings are artifacts of order being implicit, and they disappear once it is not. The third, `basemapVisibility`, is answered by making the basemap one feature rather than four.
