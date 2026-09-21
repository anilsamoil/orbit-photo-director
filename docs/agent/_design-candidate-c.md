# Design candidate C. Frozen catalog, late features

Skeptic candidate. Grounded in `docs/agent/ARCHITECTURE_NOW.md`, `docs/agent/FOLLOWUPS.md`, and line counts measured from this branch.

Counts used below were regenerated with:

```bash
wc -l frontend/src/map.ts frontend/src/main.ts
grep -cE '^let ' frontend/src/map.ts
grep -c 'addLayer(' frontend/src/map.ts
grep -cE '\bmap\.on\(' frontend/src/map.ts
grep -cE 'function bind' frontend/src/map.ts
grep -l "from '../src/map'" frontend/test/*.ts | wc -l
ls frontend/src/*.ts | grep -v vite-env | wc -l
```

`map.ts` is 4604 lines. `main.ts` is 1690. `map.ts` holds 55 of the 95 module-level `let`s, 16 `addLayer` sites, 25 `map.on` registrations, 13 `bind*` functions, 69 exports, 26 `maplibregl` mentions, and 137 quoted layer or source id sites. 23 test files import `../src/map`. `map-ir.test.ts` and three cases in `map-night-lights.test.ts` read `frontend/src/map.ts` as text. `frontend/scripts/verify-map-pins.mjs` mutates that same file.

## 1. Shape name and thesis

**Frozen catalog, late features.** The 17-layer paint order is a frozen catalog owned by map-core, and a feature is only a late overlay or tool that installs above that catalog through one entrypoint. Agents copy one feature folder. They do not open the bring-up that `map-render-contract.test.ts` pins. Clouds, IR, terminator, night lights, the ISS track, targets, and launch stay in map-core because they already share `basemapVisibility`, `beforeId: 'iss-track-layer'`, and the 1 Hz timer. Splitting those into feature folders would copy that coupling into seven directories and put the 17-layer pin at risk. The cheap win is a typed catalog, a small `MapRuntime` facade, an adapter that is the only MapLibre importer, and two late feature folders taken from code that already sits after the pinned stack: pin-drop and satellites.

### Cheaper shapes, measured

The premise of a full reshape is that agent pain equals file size, so every user-facing overlay must become a feature folder. That premise is wrong. The failures an agent actually hits are bare string ids (137 sites), paint order as `renderMap` call order (`map.ts:1079-1684`, 606 lines), grep tests that pin a file path, and no import rule. Four cheaper shapes were scored against a full reshape. Churn is lines moved out of `map.ts`, files created, files that must change, and pins that go red if the move is clumsy.

**Lint rule alone.** Add `frontend/scripts/check-map-architecture.ts` and call it from `.github/workflows/test.yml`. Zero lines of `map.ts` move. Two files change. Zero pins at risk. An agent who imports `maplibre-gl` from a new file fails CI. An agent who adds `aurora-layer` as a free string still typechecks. There is still no folder to copy. Win is about 15%.

**Typed layer ids alone.** A 40-line `LayerId` union and 137 replacements in `map.ts`. Two files change. String values stay identical, so `map-render-contract.test.ts` stays green. A typo such as `'targets-layr'` stops compiling. Paint order is still the sequence of 12 `addLayer` calls inside `renderMap`. Win is about 25%.

**Layer catalog module, leave the rest.** One new `map-core/catalog.ts` with `PAINT_ORDER`, default visibility, and `beforeId`. About 120 new lines. `map.ts` plus three contract tests change. The 17-layer pin stays a literal array in the test. A second assertion checks that `PAINT_ORDER` equals that literal. Adding a layer still means editing `buildStyle` or `renderMap`, a `bind*Toggle`, `index.html`, and maybe `setLookahead`. Win is about 45%. This is the typed list every other option still needs.

**Seam split of `map.ts`, no registry.** Move the measured blocks into sibling files: `buildStyle` 184 lines, track geo 302, `renderMap` 606, refresh and launch 378, time scrub 433, follow and toggles 655, popups 297, pin-drop 424, satellites 386. About 4000 lines move. About 12 files created. About 27 test files change import paths. `map-ir.test.ts`, `map-night-lights.test.ts`, and `verify-map-pins.mjs` go red by construction because they name `src/map.ts`. The 17-layer pin survives only if one function still walks a single order list. Without that list, this is the same implicit order in more files. Win is about 60% for readers, about 30% for agents, who still have no one folder to copy.

**Full feature-folder reshape of all overlays.** All 4604 lines redistributed. About 25 new files. About 40 files touched. Every map pin is in play: the 17-layer array, the handler list at `map-render-contract.test.ts:156-180`, the lookup-pin cases in `map-interaction-contract.test.ts`, 23 static importers, two grep suites, and the mutation script. Clouds cannot ship without `basemapVisibility` (`map.ts:2675`, 16 combinations pinned by `map-basemap.test.ts`). VIIRS, terminator fill, and the global dim cannot ship without `beforeTrack` (`map.ts:1395`, pinned as three `beforeId: 'iss-track-layer'` insertions). Launch cannot ship without writing `targets-layer` in `applyMapLaunchVisibility` (`map.ts:1880-1894`). Those are not features. They are one overlay policy. Folders around them are pass-throughs. Claimed win is 90%. Real win is closer to 40% after the coupling leaks back into map-core.

**This design.** Move the late blocks that the 17-layer pin does not name: `dropLookupPin` (65 lines at `map.ts:3535`), pin-drop (424 lines at `map.ts:3794-4217`), satellites (386 lines at `map.ts:4219-4604`). Relocate the existing leaves `pin-drop.ts` (269 lines) and `satellites.ts` (286 lines) into those folders. Add catalog, domain types, facade, adapter, clock, and a bun CI script. About 875 lines leave `map.ts`. About 200 new lines of types and checks. About 15 files change, including the grep rewrite any move requires. The 17-layer pin is untouched if `install.ts` walks `RUNTIME_ADD_ORDER` and applies `BEFORE_ID`. Inferred, not measured: win for new map work is about 80%, and churn is about 30% of a full reshape.

A full reshape is not warranted. The cheaper catalog is warranted and is not enough by itself. The two late features are the copy-paste pattern. The frozen 17 stay in map-core on purpose.

## 2. Target directory layout

The 57 flat modules stay flat. Profile, queue, worker, and generator are out of scope. Only the map changes.

```
frontend/src/
  map.ts                         composition root. the only file main.ts lazy-imports
  map-core/
    catalog.ts                   PAINT_ORDER, STYLE_ORDER, RUNTIME_ADD_ORDER, BEFORE_ID, lateLayer()
    domain.ts                    LngLat, BBox, Camera, FeatureId, OverlayId
    view-state.ts                MapViewState, Clock, parseOverlayPrefs
    facade.ts                    MapRuntime
    clock.ts                     viewTimeMs, setLookahead, 1 Hz, 30 s, 60 s, IR tick
    style.ts                     buildStyle, reads catalog
    camera.ts                    mapCameraOptions, initialZoomForViewport
    install.ts                   the only addLayer caller. walks RUNTIME_ADD_ORDER
    basemap.ts                   basemapVisibility and the cloud, IR, label toggles
    geo.ts                       buildLineFeatures, splitTrackByOrbit, splitByIllumination
    distance.ts                  filterPassesByDistance. main.ts imports this, not map.ts
    boot.ts                      createRuntime, renderMap, start clock, call entrypoints
  adapter/
    maplibre.ts                  Map, Marker, Popup, NavigationControl, LngLatBounds
    viirs-alpha.ts               moved from viirs-alpha-protocol.ts
  features/
    pin-drop/
      entrypoint.ts              the only export the composition root imports
      overlay.ts                 lookup-pin and dropped-pin GeoJSON
      tool.ts                    contextmenu and long-press
      popup.ts                   buildPinDropPopup, buildPinAddFooter
      passes.ts                  today's pin-drop.ts (greatCircleKm, findUpcomingPasses)
    satellites/
      entrypoint.ts
      overlay.ts                 sat-track-${key} GeoJSON and markers
      tool.ts                    picker DOM
      tle.ts                     today's satellites.ts (CURATED_SATELLITES, fetchSatelliteTLE)
  terminator.ts                  stays. math, not a feature
  map-launch-mode.ts             stays. 16-line launch tool flag, used by main.ts
  tile-precache.ts               stays
  ...other existing modules unchanged...
```

Two real feature folders, both already independently shippable, both added after `esri-labels-reference-layer` today.

**`features/pin-drop`.** Inverse of photo lookup. Right-click or long-press drops a pin, SGP4-scans 36 h, and opens a popup. `dropLookupPin` from `main.ts:1300` lives here too. Both are pin overlays. Neither is in the 17-layer array. `map-interaction-contract.test.ts` already pins lookup-pin add-once and the zoom-4 `easeTo`.

**`features/satellites`.** Curated picker, TLE fetch, templated `sat-track-layer-${key}`, HTML markers, 60 s refresh, topbar readouts. Already a leaf module plus 386 lines of map glue. Not in the 17-layer array.

Launch stays in map-core. `ascent-trajectory-layer` and `ascent-pad-layer` are rows 15 and 16 of the pinned stack, and `applyMapLaunchVisibility` also writes `targets-layer`, `my-targets-layer`, and `my-targets-casing`.

## 3. The typed domain model

Vendor types stop at `adapter/`. map-core and every feature use these.

```ts
export type LngLat = { readonly lng: number; readonly lat: number };
export type BBox = { readonly west: number; readonly south: number; readonly east: number; readonly north: number };
export type ScreenPoint = { readonly x: number; readonly y: number };

export type FeatureId = string & { readonly __brand: 'FeatureId' };
export function featureId(id: string): FeatureId {
	return id as FeatureId;
}
export type SatelliteKey = string & { readonly __brand: 'SatelliteKey' };

export const PAINT_ORDER = [
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
] as const;

export const STYLE_ORDER = [
	'esri-imagery-layer',
	'carto-dark-layer',
	'gibs-clouds-layer',
	'geo-ir-layer',
	'ne-coastline-layer',
] as const;

export const RUNTIME_ADD_ORDER = [
	'iss-track-layer',
	'my-targets-casing',
	'my-targets-layer',
	'targets-layer',
	'night-lights-global-dim-layer',
	'terminator-night-fill-layer',
	'viirs-night-lights-layer',
	'terminator-line-layer',
	'subsolar-point-layer',
	'ascent-trajectory-layer',
	'ascent-pad-layer',
	'esri-labels-reference-layer',
] as const;

export type Visibility = 'visible' | 'none';
export type PaintLayerId = (typeof PAINT_ORDER)[number];
export type LateLayerId = string & { readonly __late: true };
export type LayerId = PaintLayerId | LateLayerId;
export type NotPaint<Id extends string> = Id extends PaintLayerId ? never : Id;

export function lateLayer<Id extends string>(
	spec: {
		readonly id: NotPaint<Id>;
		readonly source: string;
		readonly type: 'circle' | 'line' | 'fill' | 'raster';
		readonly paint: Readonly<Record<string, unknown>>;
		readonly layout?: { readonly visibility: Visibility };
	},
): LateLayerSpec {
	return { ...spec, id: spec.id as LateLayerId };
}

export type LateLayerSpec = {
	readonly id: LateLayerId;
	readonly source: string;
	readonly type: 'circle' | 'line' | 'fill' | 'raster';
	readonly paint: Readonly<Record<string, unknown>>;
	readonly layout?: { readonly visibility: Visibility };
};

export const SOURCE_IDS = [
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
	'fcst-clouds',
] as const;

export type FrozenSourceId = (typeof SOURCE_IDS)[number];
export type LateSourceId = string & { readonly __lateSource: true };
export type SourceId = FrozenSourceId | LateSourceId | `sat-track-${SatelliteKey}`;

export const BEFORE_ID = {
	'night-lights-global-dim-layer': 'iss-track-layer',
	'terminator-night-fill-layer': 'iss-track-layer',
	'viirs-night-lights-layer': 'iss-track-layer',
	'fcst-clouds-layer': 'ne-coastline-layer',
} as const satisfies Record<string, PaintLayerId>;

export type OverlayId = 'clouds' | 'ir' | 'nightLights' | 'terminator' | 'labels' | 'multiOrbit';
export type BearingMode = 'north' | 'iss-up';

export type Camera = {
	readonly bearingMode: BearingMode;
	readonly follow: boolean;
};

export type Clock =
	| { readonly kind: 'live' }
	| { readonly kind: 'scrubbed'; readonly atMs: number };

export type Selection =
	| { readonly kind: 'none' }
	| { readonly kind: 'target'; readonly id: FeatureId }
	| { readonly kind: 'pin'; readonly at: LngLat; readonly origin: 'dropped' | 'lookup' }
	| { readonly kind: 'launch'; readonly eventId: FeatureId };

export type MapViewState = {
	readonly clock: Clock;
	readonly camera: Camera;
	readonly overlays: Record<OverlayId, boolean>;
	readonly launchMode: boolean;
	readonly selectedSatellites: readonly SatelliteKey[];
	readonly selection: Selection;
};

export type Overlay = {
	readonly sources: readonly string[];
	readonly layers: readonly LateLayerSpec[];
	readonly tapPriority?: boolean;
};

export type ClockTick = 'hz1' | 's30' | 's60' | 'scrub';

export type FeatureEntrypoint = {
	readonly id: FeatureId;
	readonly overlay?: Overlay;
	install(runtime: MapRuntime): void;
	onClock?(runtime: MapRuntime, tick: ClockTick): void;
};
```

`FeatureEntrypoint` lives in `facade.ts` next to `MapRuntime`. `catalog.ts` holds `PAINT_ORDER`, `SOURCE_IDS`, `BEFORE_ID`, and `lateLayer`. `fcst-clouds-layer` stays on `PAINT_ORDER`'s optional side via `BEFORE_ID`, not as a feature. The one `as LateLayerId` sits inside `lateLayer`, after `NotPaint` proves the id is not in `PAINT_ORDER`. Features do not cast.

`Camera` does not hold center, zoom, pitch, or projection. Nothing in the app reads those back. Follow and scrub write them through the facade. Adding `pitch` to `Camera` would invite a call production never makes.

`Clock` is a union. Live versus scrubbed is the one decision `viewTimeMs: number | null` currently hides. Popup countdowns and the pin-drop pass scan keep taking `nowMs: number` and calling `Date.now()` themselves. That split is intended behavior today (`map.ts:1345`, `map.ts:3913`). The type does not forbid it.

Launch is the only exclusive tool. It is the boolean already in `map-launch-mode.ts`. Pin-drop is a gesture on pan, still bound while launch mode is on. Do not add an exclusive `activeTool` union. That would disable pin-drop during launch and change behavior.

Clouds versus IR stays a function, `basemapVisibility` in `map-core/basemap.ts`. Encoding its 16 combinations as a union would duplicate `map-basemap.test.ts`.

### Code that must not compile

```ts
runtime.setVisibility('targets-layr', 'visible');

lateLayer({
	id: 'iss-track-layer',
	source: 'iss-track',
	type: 'line',
	paint: {},
});

runtime.ensureLateLayer('iss-track-layer');

const clock: Clock = { kind: 'live', atMs: Date.now() };

const overlays: MapViewState['overlays'] = {
	clouds: true,
	ir: false,
	nightLights: false,
	terminator: true,
	labels: true,
	multiOrbit: false,
	aurora: true,
};

const order: typeof PAINT_ORDER = [
	'esri-imagery-layer',
	'carto-dark-layer',
	'gibs-clouds-layer',
	'geo-ir-layer',
	'ne-coastline-layer',
	'iss-track-layer',
	'night-lights-global-dim-layer',
	'terminator-night-fill-layer',
	'viirs-night-lights-layer',
	'my-targets-casing',
	'my-targets-layer',
	'targets-layer',
	'terminator-line-layer',
	'subsolar-point-layer',
	'ascent-trajectory-layer',
	'ascent-pad-layer',
	'esri-labels-reference-layer',
];

export const aurora: FeatureEntrypoint = {
	id: 'aurora' as FeatureId,
	overlay: { sources: ['aurora'], layers: ['iss-track-layer'] },
	install() {},
};
```

`'targets-layr'` is a plain string, not a `LayerId`. `lateLayer({ id: 'iss-track-layer', ... })` sets `id` to `never` because that string is a `PaintLayerId`. `ensureLateLayer('iss-track-layer')` fails the same way. `{ kind: 'live', atMs }` is not `Clock`. `aurora` is not an `OverlayId`. Assigning a swapped tuple to `typeof PAINT_ORDER` fails because the 17 positions are literal. Put those cases in `frontend/test/map-core/catalog.test-d.ts` with `@ts-expect-error`. If a forbidden line becomes legal, `tsc` fails unused.

## 4. The map-core facade

Features talk to `MapRuntime`. They never see `maplibregl.Map`. The object is small because each method hides a policy, not a single vendor call.

```ts
export type MapRuntime = {
	readonly view: MapViewState;
	readonly clockMs: number;

	upsertGeoJson(id: SourceId, data: GeoJSON.FeatureCollection): void;
	setVisibility(id: LayerId, visibility: Visibility): void;
	ensureLateLayer(id: LateLayerId): void;
	removeLate(id: LateLayerId, source: SourceId): void;

	setOverlay(id: OverlayId, visible: boolean): void;
	setLaunchMode(enabled: boolean): void;
	setClock(clock: Clock, opts: { recenter: boolean }): void;

	followTo(at: LngLat): void;
	easeTo(opts: { center?: LngLat; zoom?: number; minZoom?: number; bearing?: number; durationMs: number }): void;
	flyTo(opts: { center: LngLat; durationMs: number }): void;
	fitBounds(bounds: BBox, opts: { padding: number; maxZoom: number }): void;
	setBearing(deg: number): void;
	resize(): void;

	project(at: LngLat): ScreenPoint;
	query(at: ScreenPoint, layers: readonly LayerId[]): readonly QueryHit[];

	on(event: MapEvent, handler: (payload: MapEventPayload) => void): void;
	onLayer(event: LayerEvent, layer: LayerId, handler: (payload: LayerEventPayload) => void): void;

	addMarker(id: FeatureId, el: HTMLElement, at: LngLat): void;
	moveMarker(id: FeatureId, at: LngLat): void;
	removeMarker(id: FeatureId): void;

	openPopup(opts: { at: LngLat; content: HTMLElement; maxWidth?: string; kind?: 'target' | 'launch' | 'pin' }): void;
	closePopup(kind?: 'target' | 'launch' | 'pin'): void;
	setCursor(cursor: 'pointer' | ''): void;
	setRasterTiles(id: SourceId, tiles: readonly string[]): void;
};

export type QueryHit = {
	readonly layer: LayerId;
	readonly lngLat: LngLat;
	readonly properties: Record<string, unknown>;
};
```

**`upsertGeoJson`.** Hides `getSource` plus the `setData` versus `addSource` branch at `map.ts:3215-3225`. Features never ask whether the source exists.

**`setVisibility`.** Hides `getLayer`, `getLayoutProperty`, `setLayoutProperty`, and the `try` that swallows a missing layer (`map.ts:1883-1893`). Callers pass a `LayerId`.

**`ensureLateLayer`.** Hides the `if (!map.getLayer(id))` latch used at every runtime `addLayer`. Looks up paint, layout, and type from the feature's `lateLayer` spec. Rejects a `PaintLayerId` at compile time. Forwards to `install.ts`, which is the only file that calls adapter `addLayer`.

**`removeLate`.** Hides `removeLayer` and `removeSource` for a deselected satellite.

**`setOverlay`, `setLaunchMode`, `setClock`.** The only writers of `MapViewState`. Hides the seven `localStorage` keys and the clouds-IR mutual exclusion currently inlined in `bindCloudToggle` and `bindIrToggle`.

**`followTo`.** Hides the load-bearing rule that live follow must call `setCenter`, not `easeTo`, because `easeTo` queues animations (`map.ts:3063`).

**`easeTo`, `flyTo`, `fitBounds`, `setBearing`.** Four camera policies that already exist as separate call sites (`map.ts:139`, `1970`, `1974`, `2148`, `3127`, `3593`). One method would hide less than it revealed.

**`resize`.** Hides `map.resize()` after the Map tab becomes visible (`main.ts:1394`).

**`project`, `query`.** Hide `PointLike` bboxes and `queryRenderedFeatures`. The target tap at `map.ts:1306` stays in map-core and uses `query`. Features use the same methods for their own layers.

**`on`, `onLayer`.** Hide `map.on` and the bind-once latches (`sliderBound`, `pinDropBound`, and the rest). The runtime records registrations so a second `renderMap` does not double-bind. That is the other half of today's `if (!map.getLayer)` story.

**`addMarker`, `moveMarker`, `removeMarker`.** Hide `maplibregl.Marker`. ISS and satellite dots are HTML markers, not layers (`map.ts:1572`, `map.ts:4326`).

**`openPopup`, `closePopup`.** Hide `maplibregl.Popup`, `setDOMContent` (not `setHTML`), and `trackMapModePopup` (`map.ts:1914`).

**`setCursor`.** Hides `getCanvas().style.cursor` on mouseenter.

**`setRasterTiles`.** Hides the `RasterTileSource` cast used by IR and the VIIRS fallback (`map.ts:2825`, `map.ts:2861`).

**`view` and `clockMs`.** Read-only. `clockMs` is `viewTimeMs ?? Date.now()`, today's `currentViewMs`. Features do not read the vendor map to learn the time.

Omitted on purpose: `getMap`, `addLayer` with a free spec, `setStyle`, `getStyle`, `addProtocol`, `jumpTo`. `setStyle` would drop every runtime source. `addProtocol` stays in the adapter. `jumpTo` is unused.

This is a deep module. The public list is shorter than the 25 `map.on` sites plus 16 `addLayer` sites plus 10 `setLayoutProperty` sites it replaces.

## 5. How layer order is guaranteed

Three mechanisms, strongest first.

**The tuple is the order.** `PAINT_ORDER` is a `readonly` 17-tuple whose values and positions are the exact array `map-render-contract.test.ts:40-58` already asserts. That array is the paint order the operator sees, after `beforeId` splices. `install.ts` does not walk `PAINT_ORDER`. It walks `RUNTIME_ADD_ORDER`, the 12 ids in `map-render-contract.test.ts:75-88`, and applies `BEFORE_ID` for the three night rows. The first five layers come from `STYLE_ORDER` inside `buildStyle`. Walking `PAINT_ORDER` as add order would move the night `addLayer` calls before `iss-track-layer` and go red on the `addLayerCalls` pin even if paint order stayed the same. Do not "simplify" the add sequence.

**Types reject a late overlay that tries to enter the frozen stack.** Features declare layers with `lateLayer({ id, ... })`. If `id` is in `PAINT_ORDER`, the parameter type is `never` and the call does not compile. `ensureLateLayer` takes that branded id. Frozen paint never goes through a feature. `fcst-clouds-layer` is a catalog optional with `BEFORE_ID` pointing at `ne-coastline-layer`. It is not a feature. `FORECAST_CLOUDS_UI` stays false until product decides (`FOLLOWUPS.md` dead-code note).

**The test stays a literal, and CI checks the catalog against that literal.** `map-render-contract.test.ts` keeps asserting

```ts
expect(renderedMap().layerOrder).toEqual([
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
]);
```

A second line, `expect([...PAINT_ORDER]).toEqual(renderedMap().layerOrder)`, ties catalog to runtime. A third, `expect([...RUNTIME_ADD_ORDER]).toEqual(renderedMap().addLayerCalls.map((c) => c.id))`, ties add sequence to the other literal in that file. If an agent edits only the catalog, the literal tests fail. If an agent edits only the tests, `check-map-architecture.ts` fails because both catalog tuples must match those literals. `scripts/verify-map-pins.mjs` mutates `BEFORE_ID` in `catalog.ts` (drop the night `beforeId`) and asserts the suite goes red. That replaces today's mutation, which string-replaces `beforeTrack` inside `map.ts`.

A unit test in `catalog.test.ts` splices `STYLE_ORDER` plus `RUNTIME_ADD_ORDER` with `BEFORE_ID` and asserts the result equals `PAINT_ORDER`. If those three tables drift, that test fails before `renderMap` runs.

Late order is feature-array order, then satellite keys in selection order. `FEATURES = [pinDrop, satellites]` matches today's lookup-pin then dropped-pin then `sat-track-layer-${key}`. `map-interaction-contract.test.ts` already asserts lookup-pin lands at `layerOrder.at(-1)` on first drop. Keep that literal. Add one literal for dropped-pin after lookup-pin. Satellite tracks stay unasserted, as they are today.

## 6. How a feature registers

There is one recipe. Copy `features/satellites` or `features/pin-drop`. Export one `entrypoint`. Add one import in `map.ts`. Do not add a layer in `install.ts`. Do not import `maplibre-gl`.

`map.ts` after the move is the composition root. `main.ts` still `await import('./map')`, so MapLibre stays lazy.

```ts
import { boot } from './map-core/boot';
import type { MapRuntime } from './map-core/facade';
import { pinDrop, showLookupPin } from './features/pin-drop/entrypoint';
import { satellites, getSatelliteTopbarReadouts, tickSatelliteMarkers } from './features/satellites/entrypoint';
import type { Manifest } from './types';

const FEATURES = [pinDrop, satellites] as const;
let runtime: MapRuntime;

export async function renderMap(manifest: Manifest): Promise<void> {
	runtime = await boot(manifest, FEATURES);
}

export function dropLookupPin(
	result: { lat: number; lon: number; alt_km: number; timestamp_utc: Date },
): void {
	showLookupPin(runtime, result);
}

export { getSatelliteTopbarReadouts, tickSatelliteMarkers };
export { applyFollowISS, resizeMap, focusLaunchOnMap, refreshMapForManifest } from './map-core/boot';
```

`dropLookupPin` and the satellite readouts stay on this module because `main.ts:1072`, `main.ts:1091`, and `main.ts:1300` call them after the lazy import. That is the lazy gate, not a second registration path. A new feature that `main.ts` does not call needs no wrap in `map.ts`.

### Files an agent writes

Copy `features/pin-drop/`. These are the files that folder contains after slice 4, using the paint values `dropLookupPin` and `bindPinDrop` ship today.

`frontend/src/features/pin-drop/overlay.ts`

```ts
import { lateLayer, type Overlay } from '../../map-core/catalog';
import type { MapRuntime } from '../../map-core/facade';

export const lookupPin = lateLayer({
	id: 'lookup-pin-layer',
	source: 'lookup-pin',
	type: 'circle',
	paint: {
		'circle-radius': 10,
		'circle-color': '#ff5cbb',
		'circle-stroke-color': '#ffffff',
		'circle-stroke-width': 2.5,
		'circle-opacity': 0.9,
	},
});

export const droppedPin = lateLayer({
	id: 'dropped-pin-layer',
	source: 'dropped-pin',
	type: 'circle',
	paint: {
		'circle-radius': 11,
		'circle-color': '#5cd0ff',
		'circle-stroke-color': '#0b0d12',
		'circle-stroke-width': 3,
		'circle-opacity': 1.0,
	},
});

export const overlay: Overlay = {
	sources: ['lookup-pin', 'dropped-pin'],
	layers: [lookupPin, droppedPin],
	tapPriority: true,
};

export function showLookupPin(
	runtime: MapRuntime,
	result: { lat: number; lon: number; alt_km: number; timestamp_utc: Date },
): void {
	runtime.upsertGeoJson('lookup-pin', {
		type: 'FeatureCollection',
		features: [{
			type: 'Feature',
			properties: {
				timestamp_iso: result.timestamp_utc.toISOString(),
				alt_km: result.alt_km,
			},
			geometry: { type: 'Point', coordinates: [result.lon, result.lat] },
		}],
	});
	runtime.ensureLateLayer(lookupPin.id);
	runtime.easeTo({
		center: { lng: result.lon, lat: result.lat },
		minZoom: 4,
		durationMs: 800,
	});
}
```

`frontend/src/features/pin-drop/tool.ts`

```ts
import type { MapRuntime } from '../../map-core/facade';
import { droppedPin } from './overlay';
import { handlePinDrop } from './passes';

export function bind(runtime: MapRuntime): void {
	runtime.on('contextmenu', (payload) => {
		handlePinDrop(runtime, payload.at);
	});
	runtime.on('touchstart', (payload) => {
		armLongPress(runtime, payload);
	});
	runtime.onLayer('click', droppedPin.id, () => {
		runtime.closePopup('pin');
	});
}
```

`frontend/src/features/pin-drop/entrypoint.ts`

```ts
import type { FeatureEntrypoint } from '../../map-core/facade';
import { featureId } from '../../map-core/domain';
import { overlay, showLookupPin } from './overlay';
import { bind } from './tool';

export const pinDrop: FeatureEntrypoint = {
	id: featureId('pin-drop'),
	overlay,
	install(runtime) {
		bind(runtime);
	},
};

export { showLookupPin };
```

`passes.ts` is today's `pin-drop.ts`. `popup.ts` holds `buildPinDropPopup` and `buildPinAddFooter`. `tool.ts` keeps the 500 ms long-press timer at `map.ts:3797`. `minZoom: 4` is the `Math.max(map.getZoom(), 4)` rule at `map.ts:3591`. Dropped-pin paint is `{ radius: 11, color: '#5cd0ff' }` from `map.ts:3879`. Lookup-pin paint is `{ radius: 10, color: '#ff5cbb' }` from `map.ts:3556`.

To add a third feature, copy that folder, change the `lateLayer` id to a string that is not in `PAINT_ORDER`, export one `entrypoint`, and append it to `FEATURES` in `map.ts`. There is no catalog edit. `lateLayer({ id: 'iss-track-layer', ... })` does not compile. If the dock needs a button, add it in `index.html`. CI checks that every `getElementById('toggle-...')` in a feature names an id that exists in `index.html`.

### What `boot` does

1. Construct the map from `buildStyle()` and `mapCameraOptions()` as `map-render-contract.test.ts:133` already requires.
2. Walk `RUNTIME_ADD_ORDER` in `install.ts`. Apply `BEFORE_ID` on the three night rows.
3. Start the clock intervals in `clock.ts`. One 1 Hz, one 30 s, one 60 s, one IR tick. Features do not call `setInterval`.
4. Call each entrypoint `install`.
5. On each tick, call map-core refresh (track, terminator, targets, launch) then each feature `onClock`.

Idempotent `renderMap` stays. `ensureLateLayer` and `on` no-op when the id or event is already registered.

## 7. The CI and lint that make every other path fail

The repo has no ESLint, Biome, or dependency-cruiser. Do not add one. Add one bun script and one type test. Wire both into the frontend CI job that already runs `bun run typecheck` and `bun run test`.

**Tool.** `frontend/scripts/check-map-architecture.ts`, run as `bun frontend/scripts/check-map-architecture.ts`. Zero new dependencies. It is the same class of lever as `frontend/scripts/verify-map-pins.mjs`.

**Rules it rejects.**

1. `from 'maplibre-gl'` or `from "maplibre-gl"` outside `frontend/src/adapter/`. Today's importers are `map.ts` and `viirs-alpha-protocol.ts`. After the move, only `adapter/maplibre.ts` and `adapter/viirs-alpha.ts` pass.
2. `addLayer(` outside `frontend/src/map-core/install.ts` and `frontend/test/maplibre-double.ts`.
3. A quoted layer id matching `/-layer'` or `'my-targets-casing'` outside `frontend/src/map-core/catalog.ts`, `frontend/src/features/**`, `frontend/test/**`, and `frontend/index.html`. Frozen ids still belong only in `catalog.ts`. Feature files may quote only ids they pass to `lateLayer`.
4. `setInterval(` or `setTimeout(` in `frontend/src/features/**`. Clock ticks belong to `map-core/clock.ts`.
5. An import of `./features/` from any file except `frontend/src/map.ts`. map-core does not import features.
6. A file under `frontend/src/features/X/` that imports `frontend/src/features/Y/` for `X !== Y`.
7. An import of `adapter/` from any file outside `frontend/src/map-core/` and `frontend/src/adapter/`.
8. A new `frontend/src/map-*.ts` at the flat root. Map code goes in `map-core/` or `features/`. `map-launch-mode.ts` stays until a later change moves launch. Then delete it.
9. `PAINT_ORDER` and `RUNTIME_ADD_ORDER` in `catalog.ts` serialize to different JSON arrays than the two literals in `map-render-contract.test.ts`.
10. A `getElementById('toggle-...')` in `features/` whose id is missing from `index.html`.

**Type test.** `frontend/test/map-core/catalog.test-d.ts` holds the `@ts-expect-error` cases in section 3. `tsc --noEmit` already typechecks `frontend/test/**` via `frontend/tsconfig.json`. If `'targets-layr'` becomes a `LayerId`, `@ts-expect-error` fails unused.

**CI.** In `.github/workflows/test.yml`, frontend job, after typecheck:

```yaml
- run: cd frontend && bun scripts/check-map-architecture.ts
- run: cd frontend && bun run test
```

`verify-map-pins.mjs` keeps running locally as the mutation lever. Its `SOURCE` becomes `catalog.ts` for order and `basemap.ts` for the clouds swap. Delete the `map.ts` string anchors.

Land the script empty in slice 0. Turn rules on as the slices create the directories they assume. Rules 1 and 7 land in slice 2. Rule 4 lands in slice 3. Rules 5, 6, and 10 land in slice 4. Rules 2 and 9 land in slice 7.

## 8. Migration sequence

Each slice ends with `bun run typecheck`, `bun run test`, and `bun scripts/check-map-architecture.ts` once that script exists. No old-plus-new API. Callers move. The old symbol is deleted in the same slice.

**Slice 0. Subtract.** Delete the unused `fetchTLEByCATNR` and `fetchTLEByName` imports at `map.ts:35-36`. Move `filterPassesByDistance` to `map-core/distance.ts`. Point `main.ts:427` `applyDistanceFilter` at it. Delete the clone and the comment that claims it delegates. Point `terminator.ts:55` `wrapLon` at `iss.ts:14`. Delete the private copy. Rewrite `map-ir.test.ts` and the three `map.ts` source-read cases in `map-night-lights.test.ts` as runtime assertions against `buildStyle`, `basemapVisibility`, `renderMap` on the double, and badge DOM text. Delete the `fs.readFile('../src/map.ts')` path. Retarget `verify-map-pins.mjs` mutations to functions, not file text, where the pin already exists (`basemapVisibility`, `mapCameraOptions`, labels default). DELETE: unused TLE imports, `applyDistanceFilter` in `main.ts`, private `wrapLon` in `terminator.ts`, grep-the-source tests.

**Slice 1. Catalog and types.** Add `map-core/catalog.ts` and `map-core/domain.ts` with the 17-tuple copied from the render contract. Replace 137 quoted id sites in `map.ts` with `LayerId` and `SourceId`. Add `catalog.test-d.ts`. Add the catalog-equals-runtime assertion. `PAINT_ORDER` values stay the current strings. DELETE: bare layer id literals at `getLayer`, `addLayer`, and `setLayoutProperty` sites in `map.ts`.

**Slice 2. Adapter.** Move `import maplibregl` and construction of `Map`, `Marker`, `Popup`, `NavigationControl`, `LngLatBounds` into `adapter/maplibre.ts`. Move `viirs-alpha-protocol.ts` to `adapter/viirs-alpha.ts`. `vi.mock('maplibre-gl')` in the contract tests keeps working because the adapter is the only importer of that module id. Add `check-map-architecture.ts` rules 1 and 7. DELETE: `frontend/src/viirs-alpha-protocol.ts`, `import maplibregl from 'maplibre-gl'` in `map.ts`.

**Slice 3. Facade and clock.** Add `MapRuntime` and `clock.ts`. Move `viewTimeMs`, `setLookahead`, `bindTimeSlider`, `bindTimeToggle`, `maybeSnapToLive`, and the 1 Hz / 30 s / IR interval latches out of `renderMap`. `renderMap` calls `clock.start`. Features do not exist yet, so `onClock` has no callees. DELETE: `liveTimer`, `timeLabelTimer`, `irTickerStarted`, `_satTrackTickerStarted`, `sliderBound` as ad hoc flags. The runtime records binds.

**Slice 4. Pin-drop feature.** Move `map.ts:3535-3599`, `map.ts:3794-4217`, and `pin-drop.ts` into `features/pin-drop/`. Export `pinDrop` and `showLookupPin`. Wrap `dropLookupPin` on `map.ts` so `main.ts:1300` does not change. `map.ts` adds the first `FEATURES` entry. Point `pin-add.test.ts`, `pin-drop-popup.test.ts`, and the lookup-pin cases at the new files. Keep the handler list in `map-render-contract.test.ts` green by binding `contextmenu` and `touch*` inside `install`. DELETE: `frontend/src/pin-drop.ts`, pin-drop functions from `map.ts`. Do not delete `_setFollowEnvForTest` here.

**Slice 5. Satellites feature.** Move `map.ts:4219-4604` and `satellites.ts` into `features/satellites/`. `onClock` handles `'s60'` and `'scrub'`. Point `satellite-scrub.test.ts` and `satellites.test.ts` at the new files. `main.ts` still reads `getSatelliteTopbarReadouts` and `tickSatelliteMarkers` from `./map`. DELETE: `frontend/src/satellites.ts`, satellite functions from `map.ts`, the 60 s interval inside `renderMap`.

**Slice 6. View state.** Replace the overlay `let`s (`cloudsVisible`, `irVisible`, `nightLightsVisible`, `terminatorVisible`, `labelsVisible`, `multiOrbitVisible`, `bearingMode`, `followISS`, `viewTimeMs`) with one `MapViewState` object. `_resetMapStateForTest` becomes `resetViewState()`. Keep production defaults: bearing `iss-up`, follow `true`. Do not "fix" the HTML mismatch (`FOLLOWUPS.md`). DELETE: the per-flag `let`s, the field-by-field reset, `_getViewTimeMsForTest` if tests read `runtime.view.clock` instead.

**Slice 7. Install walk.** Move the 12 runtime `addLayer` blocks inside `renderMap` into `install.ts`. Walk `RUNTIME_ADD_ORDER`, not `PAINT_ORDER`. `buildStyle` moves to `style.ts` and emits `STYLE_ORDER`. `basemapVisibility` moves to `basemap.ts`. `renderMap` shrinks to fetch, boot, install, bind map-core toggles, `FEATURES.install`. DELETE: the inline `addLayer` specs in `map.ts`, leftover bind-once booleans, `map.ts` as a god module. `map.ts` remains the composition root of section 6.

Do not extract terminator, night lights, clouds, IR, ISS track, targets, or launch as feature folders in this program. A later change that has to edit one of those may peel a file under `map-core/`. It still is not a feature.

## 9. What this design gives up

Feature colocation for the frozen 17. An agent who changes VIIRS opacity still edits map-core, not a folder named night-lights. That is intentional. VIIRS opacity is a 17-layer concern, already grep-pinned once and now a catalog row.

A world where terminator can be disabled by omitting it from `FEATURES`. Terminator default-on is behavior. Registration is not a feature flag.

Teardown. There is still no `map.remove()`. The singleton and the interval tickers live for the page life. Tests keep `vi.resetModules()`. Adding `teardown` to `FeatureEntrypoint` without a destroy path is a fake method.

An exclusive tool state machine. Launch mode stays a boolean. Pin-drop stays always armed.

Center and zoom as app state. They stay in MapLibre. Reloading the tab still opens at `[0, 0]` until the 1 Hz follow tick, as today.

A UI framework. Dock buttons stay in `index.html`. A feature that needs chrome pays a one-line HTML edit. The CI rule catches a missing id.

Moving `terminator.ts`, `tile-precache.ts`, and `map-launch-mode.ts` into map-core. Extra churn, same behavior.

Unifying the two Earth radii (6378.137 versus 6371). Architecture brief forbids that without generator parity.

Fixing the HTML default mismatch, the GIBS midnight freeze, the offline-banner overwrite, or `FORECAST_CLOUDS_UI = false`. Those are `FOLLOWUPS.md`. A refactor that "fixes" them cannot be reviewed.

Replacing MapLibre. The adapter is a boundary, not a second engine.

The remaining map-core file is still large. After slices 4 and 5, about 3700 lines of today's `map.ts` still live in `boot.ts`, `install.ts`, `basemap.ts`, `clock.ts`, and friends. Readers of the basemap arbiter still read a few hundred lines in one place. That is better than seven folders that all must know `useEsri = !clouds && !ir && !esriTilesFailed`.

Two registration sites in a narrow sense. Frozen layers are catalog rows in map-core. Late layers are feature folders. New work cannot join the frozen 17 without editing `PAINT_ORDER` and the literal test. Keep that friction. CI makes the third path, `addLayer` in a random file, fail.

## 10. Reader-load delta

**Before.** "Where does paint order come from?" Answer: `renderMap` at `map.ts:1079-1684`, plus a stale header at `map.ts:3` that still says five layers, plus comments at `map.ts:1387` and `map.ts:1620` that disagree about what is topmost. Three places, one of them wrong. "What can change clouds?" Answer: `cloudsVisible`, `irVisible`, `forecastFrameActive`, `esriTilesFailed`, `bindCloudToggle`, `bindIrToggle`, the `error` handler, `refreshForecastCloudLayer`, and `basemapVisibility`. Nine names in one 4604-line file. "How do I add a pin-like overlay?" Answer: copy `dropLookupPin` at line 3535 and `bindPinDrop` at line 3802, both of which call `upsertGeoJson`, `addLayer`, and `map.on`, and hope the 17-layer test still passes. 55 module `let`s. 1322 comment lines. 23 test files import the same module.

**After.** "Where does paint order come from?" Answer: `PAINT_ORDER` in `catalog.ts`, walked by `install.ts`, asserted as a literal in `map-render-contract.test.ts`. Three files, one tuple, no comment required. "What can change clouds?" Answer: `runtime.setOverlay('clouds', next)`, which writes `MapViewState.overlays.clouds` and runs `basemapVisibility`. One writer. "How do I add a pin-like overlay?" Answer: copy `features/pin-drop/`. About 80% of the diff stays in that folder. The rest is one `FEATURES` line and maybe one `index.html` button. Layers to trace for a new overlay: feature folder, composition root. That is 2. Catalog is untouched unless the layer belongs in the frozen 17. State to hold for the map: one `MapViewState`, plus the vendor instance behind the adapter. The 55 `let`s collapse. Frozen-stack work still opens map-core. That path is rarer than adding a late overlay, and it should stay rare.

Net for the consumer, the operator on station: no visual or default change. Net for the next agent: a folder to copy, a tuple that fails the build when it is wrong, and a script that rejects `import maplibre-gl` from anywhere else.
