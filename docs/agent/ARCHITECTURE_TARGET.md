# Target architecture

The shape the map should have. `ARCHITECTURE_NOW.md` describes what exists; this describes what replaces it and in what order. No code has moved yet.

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
  boundaries.test.ts        the import and state rules (see "What fails the build")
  map-core/
    catalog.ts              LAYER_ORDER, the id unions, positionOf, beforeIdFor
    view.ts                 View, ViewTime, Overlays, BearingMode, changed()
    feature.ts              MapFeature, RenderContext
    core.ts                 createMapCore over a VendorMap
    vendor-map.ts           the VendorMap interface, in domain types only
    camera.ts               Camera, LngLat, BBox, initialZoomForViewport, mapCameraOptions
    prefs.ts                the one localStorage key table
    clock.ts                the 1 Hz tick, the 30 s label tick, the scrub tiers
  adapters/maplibre/
    index.ts                createVendorMap. the only importer of maplibre-gl
    events.ts               MapLibre payloads to Hit, Tap, LngLat
    overlays.ts             Marker and Popup wrappers to MarkerHandle, PopupHandle
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

What each group hides is the test of whether it earns its place. `ensureLayer` hides the `beforeId` computation, the 27 `getLayer` existence guards in `map.ts` (16 `if (!map.getLayer(` plus 11 `if (map.getLayer(`, out of 31 `getLayer` calls total), and the style-not-loaded `try` blocks. `setGeoJson` hides today's `upsertGeoJson` add-or-`setData` branch. `openPopup` hides the popup tracking that `trackMapModePopup` does and the `setDOMContent`-not-`setHTML` rule that keeps a user-supplied target name from executing. `every` hides the interval latches (`liveTimer`, `timeLabelTimer`, `irTickerStarted`, `_satTrackTickerStarted`) and makes the tick take `nowMs` so a feature cannot reach for `Date.now()` and silently ignore the scrub. `queryAt` hides the seven-pixel tap box and the layer-priority order.

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

The **mutation lever** rejects a silent catalog edit. `scripts/verify-map-pins.mjs` gains a mutation that swaps two entries in `LAYER_ORDER` and asserts the suite goes red, replacing today's mutation that string-edits `beforeTrack` inside `map.ts`.

## How a feature registers

Copy a feature directory. Rename it. Edit three lines outside it: one entry in `LAYER_ORDER`, one entry in `FEATURES`, and one button in `index.html` if it needs a control. That is the only registration path, and `boundaries.test.ts` fails a directory whose `index.ts` does not export a `MapFeature` whose `id` matches the directory name, an id missing from `FEATURES`, and an id in `FEATURES` with no directory.

## What fails the build

One Vitest file, `frontend/src/map/boundaries.test.ts`, run by `bun run test`, which CI already runs. It parses `frontend/src/**/*.ts` with the `typescript` package that is already a dependency, so there is no new tool, no new CI step and no new config file. It carries a self-test that feeds one violating snippet per rule to the rule function, the same way `verify-map-pins.mjs` proves the pins.

It rejects: `maplibre-gl` imported outside `adapters/`; `map-core/` importing `features/` or `adapters/`; a feature importing another feature, an adapter, or the composition root; an adapter imported anywhere but the composition root; any static import of `src/map/**` from outside it, which is what keeps the 800 KB MapLibre chunk out of the app shell and is only a convention today; a feature directory that is not registered, or registered twice; a top-level `let` or `var` anywhere under `src/map/` except the one `let core`; `Date.now(` inside `features/`, which is the two-clock gotcha; an `opd-map-` key literal outside `prefs.ts`; and any comment under `src/map/`.

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

**Slice 1, the catalog and the types.** Add `catalog.ts` and `view.ts`. Replace the bare layer and source id literals in `map.ts` with the typed constants. String values do not change, so every pin stays green.

**Slice 2, the adapter.** Move every `maplibregl` construction into `adapters/maplibre/`. Move `viirs-alpha-protocol.ts` under it. Add the vendor-import and adapter-containment rules. `vi.mock('maplibre-gl')` in the contract tests keeps working because the adapter is then the only importer of that module id.

**Slice 3, the facade and the clock.** Add `MapCore` and `clock.ts`. Move the view time, the scrub tiers and the interval latches out of `renderMap`.

**Slices 4 and 5, wave one.** `features/pin-drop`, then `features/satellites`.

**Slice 6, the recipe.** With two features in place, write `docs/agent/FEATURE_MAP.md` and `AGENTS.md`, and add `boundaries.test.ts` with the registry-completeness, module-state, one-clock and key-table rules.

**Slices 7 to 10, wave two.** `basemap`, `labels`, `night-lights`, `terminator`. Add the reverse-mount order test.

**Slices 11 to 16, wave three.** `ground-track`, `iss-marker`, `targets`, `launch-corridor`, `time-scrub`, `follow-iss`. Delete `map.ts`.

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
