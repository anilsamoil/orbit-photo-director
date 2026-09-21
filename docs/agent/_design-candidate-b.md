# Candidate B: Compiled scene catalog

## 1. Shape name and thesis

The shape is **Compiled scene catalog**. Each feature has one `entrypoint.ts` that declares its state transition, persistence, control, source, overlay, and domain inputs as data. A build step compiles every entrypoint into one typed scene catalog and one registry. The catalog, not registration call order, owns paint order. `map-core` owns one `ViewState`, the shared clocks, input routing, persistence, and scene reconciliation. The MapLibre adapter owns every MapLibre type and call. This is not the usual `index.ts`, `state.ts`, `layers.ts`, and `interactions.ts` feature layout. The organizing axis is the compiled paint sequence. Feature folders supply rows to that sequence and pure transitions over the shared model.

This shape targets the actual failure points in `frontend/src/map.ts`. `buildStyle` declares seven sources and five layers. `renderMap` then adds twelve startup layers in call order, computes `beforeTrack`, starts the 1 Hz and 30 second clocks, and invokes the twelve `bind*` functions. `setLookahead` reaches into ground track, targets, terminator, forecast imagery, satellite markers, and camera movement. A feature-owned installer would move those calls without removing the ordering and lifecycle coupling. The compiled scene catalog removes that coupling.

## 2. Target directory layout

```text
frontend/src/
  main.ts
  map/
    domain/
      feature-entrypoint.ts
      geo.ts
      map-data.ts
      map-event.ts
      overlay.ts
      paint-pass.ts
      view-state.ts
    generated/
      feature-ids.ts
      feature-registry.ts
      scene-catalog.ts
      scene-ids.ts
    map-core/
      clock.ts
      create-map-core.ts
      facade.ts
      input-router.ts
      persistence.ts
      scene-reconciler.ts
    adapter/
      maplibre/
        map-app.ts
        maplibre-adapter.ts
        maplibre-events.ts
        maplibre-style.ts
        viirs-alpha.ts
    features/
      basemap-clouds/
        entrypoint.ts
        tile-cache.ts
        visibility.ts
        basemap-clouds.test.ts
      ir-overlay/
        entrypoint.ts
        satellite-coverage.ts
        ir-overlay.test.ts
      terminator/
        entrypoint.ts
        solar-geometry.ts
        terminator.test.ts
      ground-track/
        entrypoint.ts
        track-geometry.ts
        ground-track.test.ts
      targets-pins/
        entrypoint.ts
        popup.ts
        targets-pins.test.ts
      my-targets-rings/
        entrypoint.ts
        my-targets-rings.test.ts
      night-lights/
        entrypoint.ts
        night-lights.test.ts
      labels/
        entrypoint.ts
        labels.test.ts
      launch-corridor/
        entrypoint.ts
        corridor-geometry.ts
        popup.ts
        launch-corridor.test.ts
      pin-drop/
        entrypoint.ts
        pass-search.ts
        popup.ts
        pin-drop.test.ts
      lookup-pin/
        entrypoint.ts
        popup.ts
        lookup-pin.test.ts
      satellite-picker/
        entrypoint.ts
        tle.ts
        satellite-picker.test.ts
      time-scrub/
        entrypoint.ts
        time-range.ts
        time-scrub.test.ts
      follow-iss/
        entrypoint.ts
        follow-iss.test.ts
      bearing-iss-up/
        entrypoint.ts
        bearing.ts
        bearing-iss-up.test.ts
    testing/
      feature-test-app.ts
      recording-map-adapter.ts
frontend/scripts/
  generate-map-catalog.ts
  check-map-architecture.ts
```

`frontend/src/map/features/basemap-clouds/` is the home for the current `basemapVisibility`, `applyCloudsVisibility`, cloud preference, Carto and Esri sources, GIBS source, coastline, and tile precache behavior. `frontend/src/map/features/terminator/` is the home for the current `terminatorFeatures`, `terminatorNightPolygonFeatures`, `subsolarFeature`, visibility control, three sources, and three overlays. Shared longitude wrapping, antimeridian splitting, and bearings move to `frontend/src/map/domain/geo.ts`. Ground track does not import terminator internals. Shared illumination math moves to `frontend/src/map/domain/solar-geometry.ts` if both features need it.

`frontend/src/map/generated/` is generated and committed. An agent does not edit it. The checked output gives reviewers one place to inspect all feature ids, source ids, layer ids, and paint order. `frontend/src/map/adapter/maplibre/map-app.ts` is the composition root. It receives the generated registry and catalog, creates the MapLibre adapter, and passes both into `map-core`. No file in `domain`, `map-core`, or `features` imports the adapter.

`frontend/src/main.ts` dynamically imports only `map/adapter/maplibre/map-app.ts`. It no longer knows `applyFollowISS`, `tickSatelliteMarkers`, `dropLookupPin`, or `focusLaunchOnMap`. It mounts the map, replaces the typed data snapshot, dispatches typed external events, and requests a resize.

## 3. Typed domain model

`generate-map-catalog.ts` emits the following unions from the feature entrypoints. The dormant forecast-cloud code is deleted in the first migration slice, so `fcst-clouds` and `fcst-clouds-layer` do not enter the target catalog.

```ts
export const featureIds = [
  'basemap-clouds',
  'ir-overlay',
  'night-lights',
  'labels',
  'terminator',
  'ground-track',
  'targets-pins',
  'my-targets-rings',
  'launch-corridor',
  'pin-drop',
  'lookup-pin',
  'satellite-picker',
  'time-scrub',
  'follow-iss',
  'bearing-iss-up',
] as const;

export type FeatureId = (typeof featureIds)[number];

export const layerIds = [
  'esri-imagery-layer',
  'carto-dark-layer',
  'gibs-clouds-layer',
  'geo-ir-layer',
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
  'lookup-pin-layer',
  'dropped-pin-layer',
] as const;

export const sourceIds = [
  'carto-dark',
  'gibs-clouds',
  'esri-imagery',
  'ne-coastline',
  'viirs-night-lights',
  'geo-ir',
  'esri-labels-reference',
  'iss-track',
  'terminator-line',
  'subsolar-point',
  'terminator-night-fill',
  'targets',
  'my-targets',
  'ascent-trajectory',
  'ascent-pad',
  'lookup-pin',
  'dropped-pin',
] as const;

declare const satelliteKeyBrand: unique symbol;

export type SatelliteKey = string & {
  readonly [satelliteKeyBrand]: 'SatelliteKey';
};

export type StaticLayerId = (typeof layerIds)[number];
export type StaticSourceId = (typeof sourceIds)[number];
export type LayerId = StaticLayerId | `sat-track-layer-${SatelliteKey}`;
export type SourceId = StaticSourceId | `sat-track-${SatelliteKey}`;
```

The adapter constructs `SatelliteKey` only after it validates a CelesTrak catalog number or a normalized name key. No other string assertion is allowed.

The view state replaces the current 55 module-level `let` declarations in `map.ts`. Map data such as `Manifest`, `PassEntry[]`, and `Track` lives in a separate immutable `MapData` value. Adapter resources such as the MapLibre instance, timer handles, and popup handles are lifecycle resources, not view state.

```ts
declare const epochMsBrand: unique symbol;
declare const targetIdBrand: unique symbol;
declare const launchIdBrand: unique symbol;

export type EpochMs = number & {
  readonly [epochMsBrand]: 'EpochMs';
};

export type TargetId = string & {
  readonly [targetIdBrand]: 'TargetId';
};

export type LaunchId = string & {
  readonly [launchIdBrand]: 'LaunchId';
};

export type LngLat = Readonly<{
  lng: number;
  lat: number;
}>;

export type BBox = Readonly<{
  west: number;
  south: number;
  east: number;
  north: number;
}>;

export type Camera = Readonly<{
  center: LngLat;
  zoom: number;
  bearing: number;
  pitch: number;
}>;

export type ViewTime =
  | Readonly<{ kind: 'live' }>
  | Readonly<{ kind: 'scrubbed'; at: EpochMs }>;

export type IrView =
  | Readonly<{ coverage: 'none' }>
  | Readonly<{
      coverage: 'covered';
      satellite: 'goes-east' | 'goes-west' | 'himawari' | 'meteosat-11';
      feed: 'loading' | 'ready' | 'failed';
    }>;

export type ImageryView =
  | Readonly<{ kind: 'clouds'; esri: 'available' | 'failed' }>
  | Readonly<{ kind: 'clear'; esri: 'available' | 'failed' }>
  | Readonly<{ kind: 'ir'; esri: 'available' | 'failed'; ir: IrView }>;

export type Tool =
  | Readonly<{ kind: 'pan' }>
  | Readonly<{ kind: 'pin-drop' }>
  | Readonly<{ kind: 'select'; target: TargetId | null }>;

export type MapContent =
  | Readonly<{ kind: 'targets'; filter: 'all' | 'mine' }>
  | Readonly<{ kind: 'launch'; focused: LaunchId | null }>;

export type Selection =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'target'; id: TargetId }>
  | Readonly<{ kind: 'launch'; id: LaunchId }>
  | Readonly<{ kind: 'lookup-pin'; at: LngLat }>
  | Readonly<{ kind: 'dropped-pin'; at: LngLat }>;

export type ViewState = Readonly<{
  camera: Camera;
  cameraControl: 'free' | 'follow-iss';
  time: ViewTime;
  imagery: ImageryView;
  visibleFeatures: ReadonlySet<FeatureId>;
  orbitCount: 1 | 4;
  content: MapContent;
  tool: Tool;
  selection: Selection;
  satellites: readonly SatelliteKey[];
}>;
```

`ImageryView` makes clouds and IR mutually exclusive. `ViewTime` removes the `null` convention from `viewTimeMs`. `MapContent` prevents launch mode and ordinary target mode from both being active. `Tool` gives interaction mode one owner.

The following code must not compile:

```ts
const misspelledLayer: LayerId = 'targets-layr';

const impossibleIr: ImageryView = {
  kind: 'ir',
  esri: 'available',
  ir: {
    coverage: 'none',
    feed: 'ready',
  },
};
```

The first assignment names a layer outside the generated catalog. The second assignment claims that an IR feed is ready when no satellite covers the view. `tsc --noEmit` rejects both.

Every feature exports the same entrypoint shape. The generic `Writes` parameter limits a reducer to named `ViewState` keys. The generator rejects two writers for one key unless `paint-pass.ts` marks that key as shared. `imagery` and `visibleFeatures` are deliberate shared keys.

```ts
import type { MapCoreFacade } from '../map-core/facade';
import type { MapData } from './map-data';
import type {
  ControlDefinition,
  InputBinding,
  LayerDefinition,
  PersistenceBinding,
  SourceDefinition,
} from './overlay';
import type { ViewState } from './view-state';

export type FeatureProjection = Readonly<{
  sourceData: readonly Readonly<{
    sourceId: SourceId;
    data: OverlayData;
  }>[];
  visibility: readonly Readonly<{
    layerId: LayerId;
    visible: boolean;
  }>[];
  markers: readonly MarkerView[];
  popup: PopupView | null;
  camera: CameraIntent | null;
}>;

export interface FeatureEntrypoint<
  Event,
  Writes extends keyof ViewState,
> {
  readonly id: FeatureId;
  readonly state: Readonly<{
    writes: readonly Writes[];
    initial?: Pick<ViewState, Writes>;
  }>;
  readonly defaultVisibility: 'visible' | 'hidden' | 'not-applicable';
  readonly sources: readonly SourceDefinition[];
  readonly layers: readonly LayerDefinition[];
  readonly controls: readonly ControlDefinition<Event>[];
  readonly inputs: readonly InputBinding<Event>[];
  readonly persistence: readonly PersistenceBinding<Writes>[];
  reduce(
    view: Readonly<ViewState>,
    event: Event,
  ): Pick<ViewState, Writes>;
  project(
    view: Readonly<ViewState>,
    data: Readonly<MapData>,
  ): FeatureProjection;
  effect?(
    event: Event,
    facade: MapCoreFacade<Event>,
  ): void | Promise<void>;
}
```

`OverlayData`, `MarkerView`, `PopupView`, and `CameraIntent` are domain types in `overlay.ts`. They contain `LngLat`, `BBox`, ids, text, colors, numeric paint values, and DOM action ids. They contain no MapLibre type, style expression, event, marker, popup, or source object.

## 4. The map-core facade

Feature code gets two methods. The application shell gets four lifecycle methods. Neither interface mirrors MapLibre.

```ts
export type MapModel = Readonly<{
  view: ViewState;
  data: MapData;
}>;

export interface MapCoreFacade<Event> {
  dispatch(event: Event): void;
  snapshot(): Readonly<MapModel>;
}

export interface MapApplication {
  mount(container: HTMLElement, data: MapData): Promise<void>;
  update(data: MapData): void;
  dispatch(event: MapExternalEvent): void;
  resize(): void;
}
```

Each method hides a specific coordination problem:

| Method | What it hides |
| --- | --- |
| `MapCoreFacade.dispatch` | Routes to one typed reducer, merges only declared state keys, writes declared persistence, runs the optional non-map effect, batches projections, and reconciles one scene frame. A feature does not call another feature. |
| `MapCoreFacade.snapshot` | Returns one frozen model. It hides the mutable store and prevents async work such as a TLE fetch from closing over stale module variables. |
| `MapApplication.mount` | Creates one map instance, compiles the five style layers, waits for style load, installs the adapter event bridge, starts the 1 Hz and 30 second clocks once, restores persistence, and renders all startup features. Repeated calls return the same mounted application. |
| `MapApplication.update` | Atomically replaces `Manifest`, passes, track, launch data, profile data, and shot counts. It runs projections without re-registering a source, layer, control, handler, or interval. |
| `MapApplication.dispatch` | Carries non-map input from `main.ts`, such as a lookup result or launch focus request, into the same reducer path as adapter input. The generated `MapExternalEvent` union prevents string event names. |
| `MapApplication.resize` | Defers adapter sizing until the map container is visible. It hides MapLibre's zero-sized hidden-container behavior. |

There is intentionally no facade method named `addLayer`, `addSource`, `setData`, `setLayoutProperty`, `on`, `easeTo`, `flyTo`, or `fitBounds`. Such methods would make every feature repeat MapLibre's lifecycle rules. A feature returns a complete projection. `scene-reconciler.ts` decides whether a source needs creation or data replacement, where an overlay belongs, whether a popup replaces another popup, and which camera operation preserves the current behavior.

The adapter installs the imperative effects. It registers one native handler per needed MapLibre event type and emits domain input through `input-router.ts`. `clock.ts` owns the 1 Hz and 30 second intervals. Feature entrypoints declare which domain inputs they consume. They cannot call `map.on`, `addEventListener`, `setInterval`, or `setTimeout`. The architecture check enforces that rule.

The current camera distinctions remain policy in `CameraIntent`. Recurring follow uses the intent that the adapter translates to `setCenter`. Entering follow uses the intent translated to `flyTo` with 800 ms and `essential: true`. Time scrub recenter uses the intent translated to `easeTo` with 600 ms. Launch corridor focus uses either a center intent or a bounds intent. Features do not choose MapLibre method names.

## 5. Layer order is a compiled contract

Each layer declaration carries an `install` phase and a paint address:

```ts
export const paintPasses = [
  'basemap',
  'cloud-overlay',
  'night-overlay',
  'track-overlay',
  'target-overlay',
  'map-overlay',
  'label-overlay',
  'late-overlay',
] as const;

export type PaintPass = (typeof paintPasses)[number];

export type PaintAddress = Readonly<{
  pass: PaintPass;
  order: number | 'activation';
}>;
```

The generator sorts by `paintPasses`, then by numeric `order`. It rejects duplicate numeric addresses. The checked generated catalog contains this exact startup sequence:

| Paint order | Layer id | Feature | Install | Paint address |
| ---: | --- | --- | --- | --- |
| 1 | `esri-imagery-layer` | `basemap-clouds` | `style` | `basemap/10` |
| 2 | `carto-dark-layer` | `basemap-clouds` | `style` | `basemap/20` |
| 3 | `gibs-clouds-layer` | `basemap-clouds` | `style` | `cloud-overlay/10` |
| 4 | `geo-ir-layer` | `ir-overlay` | `style` | `cloud-overlay/20` |
| 5 | `ne-coastline-layer` | `basemap-clouds` | `style` | `cloud-overlay/30` |
| 6 | `night-lights-global-dim-layer` | `night-lights` | `load` | `night-overlay/10` |
| 7 | `terminator-night-fill-layer` | `terminator` | `load` | `night-overlay/20` |
| 8 | `viirs-night-lights-layer` | `night-lights` | `load` | `night-overlay/30` |
| 9 | `iss-track-layer` | `ground-track` | `load` | `track-overlay/10` |
| 10 | `my-targets-casing` | `my-targets-rings` | `load` | `target-overlay/10` |
| 11 | `my-targets-layer` | `my-targets-rings` | `load` | `target-overlay/20` |
| 12 | `targets-layer` | `targets-pins` | `load` | `target-overlay/30` |
| 13 | `terminator-line-layer` | `terminator` | `load` | `map-overlay/10` |
| 14 | `subsolar-point-layer` | `terminator` | `load` | `map-overlay/20` |
| 15 | `ascent-trajectory-layer` | `launch-corridor` | `load` | `map-overlay/30` |
| 16 | `ascent-pad-layer` | `launch-corridor` | `load` | `map-overlay/40` |
| 17 | `esri-labels-reference-layer` | `labels` | `load` | `label-overlay/10` |

The first five rows compile into the initial style. The remaining twelve reconcile after style load. The reconciler ignores entrypoint registration order. It inserts each active layer before the nearest active layer with a higher paint address. The three night overlays therefore produce the existing `beforeId: 'iss-track-layer'` calls even if their entrypoints register last. Labels remain last.

`lookup-pin-layer`, `dropped-pin-layer`, and `sat-track-layer-${key}` use `late-overlay/activation`. That address preserves today's first-materialization order, which can depend on whether a lookup, pin drop, or satellite selection happens first. The generator has an allowlist for those three existing ids. A new feature cannot request activation order. Before changing that policy, add a separate behavior decision and update the interaction contract.

Four checks protect order:

1. `generate-map-catalog.ts --check` fails on a duplicate id, a missing source, a duplicate numeric paint address, an owner mismatch, or generated output drift.
2. `tsc --noEmit` fails when a projection names a `LayerId` or `SourceId` outside the generated union.
3. `map-render-contract.test.ts` mounts the real application against the recording adapter and keeps the current literal seventeen-row expectation. A second test shuffles registry order and expects the same rows and the same three `beforeId` values.
4. `verify-map-pins.mjs` mutates one paint address at a time. A mutation that leaves the contract test green fails the script.

An out-of-order registration cannot cause out-of-order paint because registration order is not an ordering input. An incorrect paint address changes the generated catalog and fails the literal render contract. A direct MapLibre insertion outside the reconciler fails the architecture check before tests run.

## 6. A feature registers through one entrypoint

An ordinary on or off overlay copies `features/labels/`. The agent writes these two files. The generated files change only when `bun run map:generate` runs.

`frontend/src/map/features/labels/entrypoint.ts`:

```ts
import {
  defineFeature,
  rasterOverlay,
  rasterSource,
} from '../../domain/feature-entrypoint';
import {
  setFeatureVisible,
  toggleFeature,
} from '../../domain/view-state';

const id = 'labels' as const;

type LabelsEvent = Readonly<{
  type: 'toggle';
}>;

const source = rasterSource({
  id: 'esri-labels-reference',
  install: 'style',
  tiles: [
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  ],
  tileSize: 256,
  maxZoom: 19,
  attribution:
    'Labels © <a href="https://www.esri.com">Esri</a> &mdash; Source: Esri, HERE, Garmin, FAO, NOAA, USGS, OpenStreetMap contributors',
});

const overlay = rasterOverlay({
  id: 'esri-labels-reference-layer',
  sourceId: source.id,
  install: 'load',
  paint: {
    pass: 'label-overlay',
    order: 10,
  },
  opacity: 0.85,
});

export const entrypoint = defineFeature<LabelsEvent, 'visibleFeatures'>({
  id,
  state: {
    writes: ['visibleFeatures'],
  },
  defaultVisibility: 'visible',
  sources: [source],
  layers: [overlay],
  controls: [
    {
      id: 'toggle-labels',
      order: 50,
      className: 'time-btn',
      text: '🏷️',
      pressed: (view) => view.visibleFeatures.has(id),
      title: (view) =>
        view.visibleFeatures.has(id)
          ? 'Country/city labels shown \u2014 click to hide'
          : 'Country/city labels hidden \u2014 click to show',
      event: {
        type: 'toggle',
      },
    },
  ],
  inputs: [],
  persistence: [
    {
      key: 'opd-map-labels-visible',
      hydrate: (value, view) => ({
        visibleFeatures: setFeatureVisible(
          view.visibleFeatures,
          id,
          value === null || value === '1',
        ),
      }),
      serialize: (view) =>
        view.visibleFeatures.has(id) ? '1' : '0',
    },
  ],
  reduce: (view, event) => {
    switch (event.type) {
      case 'toggle':
        return {
          visibleFeatures: toggleFeature(view.visibleFeatures, id),
        };
    }
  },
  project: (view) => ({
    sourceData: [],
    visibility: [
      {
        layerId: overlay.id,
        visible: view.visibleFeatures.has(id),
      },
    ],
    markers: [],
    popup: null,
    camera: null,
  }),
});
```

`frontend/src/map/features/labels/labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { featureTestApp } from '../../testing/feature-test-app';
import { entrypoint } from './entrypoint';

describe('labels feature', () => {
  it('opens visible, toggles hidden, and persists the choice', () => {
    const app = featureTestApp(entrypoint);

    expect(app.frame().visibility).toEqual([
      {
        layerId: 'esri-labels-reference-layer',
        visible: true,
      },
    ]);

    app.clickControl('toggle-labels');

    expect(app.frame().visibility).toEqual([
      {
        layerId: 'esri-labels-reference-layer',
        visible: false,
      },
    ]);
    expect(app.stored('opd-map-labels-visible')).toBe('0');
  });
});
```

The copy recipe is:

1. Copy `frontend/src/map/features/labels/` to a kebab-case feature directory.
2. Change the `id`, event, source, overlay, control, projection, persistence, and literal behavior test in that directory.
3. Run `bun run map:generate`. The generator discovers only `features/*/entrypoint.ts`.
4. Run the architecture check, typecheck, feature test, render contract, full suite, and build.

There is no registry edit. There is no `index.ts`. There is no feature-owned `map.on`. If the feature needs a new semantic `ViewState` variant or a new paint pass, the compiler requires one shared model edit. That is the expected minority of the diff. A routine overlay remains inside one feature directory apart from generated output.

## 7. CI makes every other path fail

Use two Bun scripts and the existing TypeScript dependency. Do not add ESLint for one architecture rule set.

`frontend/scripts/generate-map-catalog.ts` loads each `features/*/entrypoint.ts` with Bun, validates the declarations, sorts the paint addresses, and writes deterministic files under `src/map/generated/`. Its `--check` mode writes to memory and exits nonzero when committed output differs.

`frontend/scripts/check-map-architecture.ts` uses the TypeScript compiler API to inspect imports, calls, constructors, and comments. It enforces these rules:

- Only `src/map/features/<kebab-case>/entrypoint.ts` may call `defineFeature`.
- Every feature directory has exactly one exported `entrypoint`, and its id matches the directory name.
- Only `src/map/generated/feature-registry.ts` imports feature entrypoints.
- `map-core` cannot import `features` or `adapter`.
- A feature cannot import another feature directory or the adapter.
- Only `src/map/adapter/maplibre/` may import `maplibre-gl`, use a MapLibre type, construct a MapLibre object, or call `addLayer`, `addSource`, `removeLayer`, `removeSource`, `setLayoutProperty`, `setData`, `on`, `off`, or `once`.
- Feature code cannot call `localStorage`, `document`, `window`, `addEventListener`, `setInterval`, or `setTimeout`. Persistence, controls, adapter events, and clocks are declared through the entrypoint.
- Production files under `src/map/` cannot contain comments.
- The old flat paths `src/map.ts`, `src/terminator.ts`, `src/pin-drop.ts`, `src/satellites.ts`, `src/map-launch-mode.ts`, and `src/viirs-alpha-protocol.ts` cannot exist after the cutover.
- A hand-written import list beside the generated registry fails.

The package scripts become:

```json
{
  "scripts": {
    "map:generate": "bun scripts/generate-map-catalog.ts",
    "check:map-architecture": "bun scripts/check-map-architecture.ts && bun scripts/generate-map-catalog.ts --check",
    "typecheck": "bun run check:map-architecture && tsc --noEmit",
    "test": "bun run check:map-architecture && vitest run",
    "build": "bun run check:map-architecture && tsc --noEmit && vite build"
  }
}
```

The current frontend CI already runs `typecheck`, `test`, and `build`. The first command therefore rejects an off-pattern change before the 1707 tests start. This is cheaper than a new linter dependency and stronger than README instructions. An agent that adds a direct `map.addLayer` in `main.ts`, places a feature under `src/`, imports another feature's popup, or creates a second registration array gets a file and rule-specific error.

## 8. Migration sequence

Every slice ends with:

```sh
cd frontend
bun run typecheck
bun run test
bun run build
node scripts/verify-map-pins.mjs
```

No slice keeps a re-export at an old path. Callers move and the old symbol or file is deleted in the same slice.

### Slice 1. Delete code that production cannot reach

Delete the dormant forecast-cloud path guarded by `FORECAST_CLOUDS_UI = false`. This removes `nearestForecastFrame`, `compactFrameKey`, `activeForecastIndex`, `frameForIndex`, `forecastFrameForView`, `refreshForecastCloudLayer`, `_setForecastCloudsUiForTest`, `_setFcstTilesFailedForTest`, the `fcst*` module state, and the `fcst-clouds` source and layer branch. Replace dormant-path tests with behavior tests that assert a scrubbed view keeps observed imagery and says that it is not a forecast.

Delete the unused `fetchTLEByCATNR` and `fetchTLEByName` imports from `map.ts`. Keep the functions in `satellites.ts`, where the satellite tests and `fetchSatelliteTLE` still use them. Delete `_resetViirsFallbackForTest` and its call from `_resetMapStateForTest`. Delete the stale five-layer header in `map.ts`.

Production behavior remains unchanged because the deleted forecast path is disabled and the deleted imports and reset function do no production work.

### Slice 2. Delete duplicate domain logic

Add `map/domain/geo.ts` and `map/domain/pass-filter.ts`. Move one `wrapLon`, one antimeridian and world-copy splitter, one `greatCircleBearingDeg`, and one `filterPassesByDistance` into those files. Migrate `iss.ts`, `terminator.ts`, `pin-drop.ts`, `map.ts`, `main.ts`, and their tests in the same commit.

Delete the private `wrapLon` in `terminator.ts`, `buildLineFeatures` in `map.ts`, `greatCircleBearingDeg` in `pin-drop.ts`, `applyDistanceFilter` in `main.ts`, and `filterPassesByDistance` in `map.ts`. Do not merge the 6371 km and 6378.137 km Earth radii. They model different existing calculations and the architecture brief identifies that distinction as load-bearing.

### Slice 3. Replace source-text checks with behavior pins

Extend `test/maplibre-double.ts` to record tile replacement, source errors, data and idle events, popup replacement, and on-demand layer materialization. Rewrite the source-reading assertions in `map-ir.test.ts` and `map-night-lights.test.ts` through the real `renderMap` and the recording double. Add literal tests for IR mutual exclusion, feed failure, time-based tile replacement, global dim behavior, and every current ordering of lookup, dropped pin, and satellite overlays.

Delete the `fs.readFile` calls, regular expressions over `src/map.ts`, copied fake logic, and tests that only assert absence of old text. Keep `map-render-contract.test.ts` and `map-interaction-contract.test.ts` as the behavior pins.

### Slice 4. Move pure capability code into final feature directories

Move `terminator.ts` to `map/features/terminator/solar-geometry.ts`, `pin-drop.ts` to `map/features/pin-drop/pass-search.ts`, and `satellites.ts` to `map/features/satellite-picker/tle.ts`. Move the IR URL and coverage functions from `tile-precache.ts` to `map/features/ir-overlay/satellite-coverage.ts`. Move cloud and world tile caching to `map/features/basemap-clouds/tile-cache.ts`.

Update every caller and test to the new path. Delete the five old flat files and the moved sections of `tile-precache.ts`. Do not add re-export files.

### Slice 5. Extract pure projections and popup models

Move `basemapVisibility`, overlay preference decoding, track geometry, target projection, launch geometry, target hit selection, imagery badge projection, and each popup model into the owning feature directory. Convert popup builders from direct DOM construction to typed `PopupView` data. Keep a single DOM renderer in `map-core`.

Delete `buildTargetPopupContent`, `buildPinDropPopup`, `buildPinAddFooter`, `buildAscentFeatures`, `buildLaunchMapFeatures`, `pickTargetAtTap`, `groundTrackFeatures`, `futureOrbitGroundTrackFeatures`, `basemapVisibility`, and the preference readers from `map.ts`. Tests import the feature directly. `map.ts` temporarily calls those feature exports, so there is still one implementation of each behavior.

### Slice 6. Establish the typed model and feature entrypoints

Add `ViewState`, the discriminated unions, the entrypoint interface, the domain overlay grammar, paint passes, and the catalog generator. Create one entrypoint in every final feature directory. Make `map.ts` consume source and layer definitions from the generated catalog instead of carrying inline specifications. Make its remaining binders dispatch typed feature events and apply the returned projections.

Delete every inline source specification, layer specification, localStorage key, duplicated default, and feature-specific visibility branch from `map.ts`. Delete the individual map control buttons and time controls from `index.html` after the generated control renderer produces the same ids, classes, text, order, and initial states. Keep only the empty dock hosts in HTML.

The runtime is still the existing map for this slice, but each feature has one declaration and one reducer. There is no old declaration beside a new declaration.

### Slice 7. Build map-core and the adapter under the behavior contracts

Add the generic clocks, input router, persistence, scene reconciler, MapLibre adapter, and recording adapter. Drive all generated entrypoints through them in tests. Port `map-render-contract.test.ts`, `map-interaction-contract.test.ts`, `map-style-contract.test.ts`, `map-camera-contract.test.ts`, `map-basemap.test.ts`, and `map-overlay-prefs.test.ts` without changing their literal expected behavior.

Delete feature-specific setup from `maplibre-double.ts`. The recording adapter replaces it. Delete test-only production setters such as `_setFollowEnvForTest`, `_setCurrentTrackForTest`, `_setForecastCloudsUiForTest`, and `_resetMapStateForTest` as their tests move through the real facade.

No production caller uses map-core yet. This slice proves the complete replacement against the current pins without an old and new production path.

### Slice 8. Cut production over once

Change `main.ts` to load `map/adapter/maplibre/map-app.ts`, pass `MapData`, and dispatch generated external events. Remove the map calls from `updateIssNow`, `loadLookupPane`, `showLaunchOnMap`, and the manifest refresh branch. The map's own clock and event inputs now drive follow, satellite markers, lookup, and launch focus.

Delete `map.ts` in the same commit. Delete `buildStyle`, `renderMap`, `refreshMapForManifest`, `upsertGeoJson`, all twelve `bind*` functions, all bind-once flags, all 55 map module variables, all direct camera calls, and all 25 `map.on` registrations with that file. Move `viirs-alpha-protocol.ts` into the adapter and delete the old path. Remove the `map.ts` and `main.ts` coverage exclusions.

Add `check-map-architecture.ts` and run it before typecheck, test, and build in this same slice. There is never a committed compatibility wrapper at `src/map.ts`, and there is never a second registration route.

### Slice 9. Prove the target rejects drift

Extend `verify-map-pins.mjs` to mutate a paint address, a source-to-layer link, a default visibility, a camera intent, and a feature directory name. Add architecture-check fixtures that attempt a cross-feature import, a MapLibre import in a feature, a raw `addLayer`, an unregistered layer id, a comment, and a second registry.

Delete the mutation anchors that reference old `map.ts` text and delete any temporary migration-only fixture. Run the full frontend commands once more from a clean checkout.

## 9. What this design gives up

- It adds a generator and checked generated files. A stale catalog fails before typecheck. Editors need `bun run map:generate` after a new entrypoint appears.
- A feature with a genuinely new paint position needs one edit to `paint-pass.ts`. A feature with a genuinely new cross-feature state needs one edit to `view-state.ts`. The one-directory goal is about the normal case and about keeping at least 80 percent of the diff local. It is not a claim that global invariants never change.
- The domain overlay grammar supports the current raster, line, circle, fill, background, marker, and popup needs. MapLibre terrain, 3D extrusion, a custom WebGL layer, or a vendor control needs an adapter extension and a domain decision before a feature can use it.
- Dynamic satellite layer ids need one declared id family. A second dynamic family requires generator work. Arbitrary runtime strings are intentionally unsupported.
- The three current late overlays retain activation order to avoid a visual behavior change. That policy is less deterministic than the seventeen startup rows. New features cannot copy it.
- Central `ViewState` makes cross-feature rules visible, but an imagery change can require both the IR feature and the basemap-clouds feature to update tests. The design favors one legal model over complete feature independence.
- Banning comments under `src/map/` removes inline design history. Literal tests, discriminated unions, names, and the generated catalog must carry the rule. Complex astronomy derivations belong in tests or external technical documentation, not production comments.
- The entrypoint record is dense. A feature with one layer still declares state, persistence, control, source, overlay, and projection in one file. This is deliberate. Splitting those fields into lifecycle-named files would make an agent trace more files without hiding more behavior.

Three alternatives lose against these constraints:

- A feature-owned installer with `install(map)` is smaller at first, but it spreads `map.on`, timers, source existence checks, and `beforeId` knowledge into every feature. It is the current architecture in smaller files.
- Render-pass directories make the seventeen-row order obvious, but terminator, launch corridor, and targets would each span several directories. That violates feature colocation.
- An event log with replay gives excellent history, but SNAP has one in-memory view and no replay requirement. It adds serialization and migration work without removing a current failure mode.

## 10. Reader-load delta

An agent adding a feature no longer needs to know:

- that `buildStyle` creates five layers while `renderMap` creates twelve more;
- that `night-lights-global-dim-layer`, `terminator-night-fill-layer`, and `viirs-night-lights-layer` need `beforeId: 'iss-track-layer'`;
- that `renderMap` is both constructor and refresh path, with `getLayer` checks and bind-once flags making it idempotent;
- which of the 55 `map.ts` variables mirror localStorage, adapter resources, current data, or view state;
- which of `Date.now()` and `currentViewMs()` a capability must use;
- how `setLookahead` refreshes ground track, target opacity, terminator, satellite tracks, imagery text, marker position, and camera;
- where the twelve binders live or which HTML button an agent must add;
- how to construct a MapLibre source, style expression, marker, popup, bounds object, or event payload;
- that `setStyle` would destroy runtime sources and handlers;
- which of the map tests uses a copy, a regular expression, or a real recording double;
- that `main.ts` calls back into four feature-specific exports on the 1 Hz tick, lookup flow, launch flow, and manifest refresh.

The agent needs four facts:

1. A feature lives in `frontend/src/map/features/<feature>/`.
2. `entrypoint.ts` is the only registration route.
3. The paint address comes from the nearest existing feature with the intended visual relationship.
4. The feature test drives the entrypoint through `feature-test-app`, while the global render contract protects the seventeen-row scene.

That is the intended copy pattern for Cursor and Grok Bot. The generated catalog and CI check reject every other path instead of asking an agent to remember the architecture.
