# Agents

Orbit Photo Director plans Earth photography from the ISS. A Python generator (`generator/`) publishes a ranked shot queue; a Cloudflare Worker (`worker/`) serves it; a MapLibre frontend (`frontend/`) shows it at map.astroanil.dev. The product is the shot queue; the map is one tab of five. This file is the index for working on the map. Follow the links, do not expect the architecture here.

## Read first

1. `docs/agent/FEATURE_MAP.md`: every map capability, its directory or its `map.ts` symbols, how a user reaches it, what to run, what bites.
2. `frontend/src/map/features/satellites/`: the exemplar feature. `pin-drop/` is the smaller one.
3. `docs/agent/ARCHITECTURE_TARGET.md`: the shape, the slice plan, and what each shipped slice did. `ARCHITECTURE_NOW.md` is the snapshot before any of it; `FOLLOWUPS.md` is where real bugs found during structure work are recorded instead of fixed.

## Nouns

Use these words and no synonyms. A `feature` is one user-facing map capability in one directory under `frontend/src/map/features/`. Its `entrypoint` is the one `MapFeature` object its `index.ts` exports, `id` equal to the directory name. `map-core` (`frontend/src/map/map-core/`) owns the layer catalog, the facade, the clock, the view record, the storage keys and the camera; it never knows which features exist. An `overlay` (`frontend/src/map/overlays/`) is drawing that features share. A `tool` is an interaction mode; the app has one, launch mode. The `adapter` (`frontend/src/map/adapters/maplibre/`) is the only place a MapLibre type appears. `frontend/src/map.ts` is the legacy module and today's composition root: `renderMap` builds the core and mounts `FEATURES`, and it is being emptied one feature at a time.

## Rules the build enforces

`frontend/test/architecture-boundaries.test.ts` fails the suite on any of these, and each rule has a self-test that feeds it a violation. Read the message it prints; it names the file and the rule.

- `maplibre-gl` is imported only under `adapters/` (and `map.ts` until it is gone). Adapters are imported only by the composition root.
- `map-core` imports no feature, no adapter, not the legacy module.
- A feature imports map-core, overlays, its own files and domain leaves outside `src/map/`. Not another feature, not `features/index.ts`, not the composition root, not `main.ts`. An overlay imports no feature.
- Every directory under `features/` is in `FEATURES` once, under its directory name, exporting the object `FEATURES` holds, with a `<name>.test.ts` beside it.
- No module-level `let` or `var` under `src/map/`, except the one `let core` the composition root `map/index.ts` will hold.
- No `Date.now()`, bare `new Date()` or `performance.now()` under `src/map/` outside `map-core/clock.ts`. Ask `core.clock`.
- No storage key literal (`opd-...`) and no `localStorage` call with a key that is not a `PREF_KEYS` entry under `src/map/`.
- No `as any`, `@ts-ignore`, `TODO` or `FIXME` under `src/map/`.
- No comment under `src/map/` except a `/** */` doc comment on a declaration. Names, types and tests carry meaning.
- Nothing statically imports the map entry; `main.ts` reaches it with a dynamic import so the vendor chunk stays out of the app shell.

## How to add a map feature

1. Copy `frontend/src/map/features/pin-drop/` (a layer and a popup) or `satellites/` (a dock control, persistence, tickers) to `features/<name>/`. Rename the export; set `id: '<name>'`.
2. Add the feature's layer ids to `LAYER_ORDER` in `map-core/catalog.ts` at the position they paint, and its source ids to `RASTER_SOURCE_IDS` or `GEOJSON_SOURCE_IDS`. A layer id not in the catalog does not typecheck. Never pass a `beforeId`; the catalog places layers.
3. Add the entry to `FEATURES` in `features/index.ts`.
4. Talk to the map only through `MapCore` (`map-core/core.ts`): `ensureLayer`, `setGeoJson`, `setVisibility`, `on`, `onLayer`, `openPopup({ owner })`, `addMarker`, camera calls. Read shared state from `core.view()`. Read time from `core.clock.viewMs()`; schedule with `core.clock.every` and react to a scrub with `core.clock.onViewTime`.
5. A control is one button in the map dock in `frontend/index.html`. A persisted preference is one entry in `PREF_KEYS` (`map-core/prefs.ts`).
6. Write `features/<name>/<name>.test.ts`: mount the feature on `createMapCore(createVendorDouble(...), createClock())` from `frontend/test/vendor-map-double.ts` and assert on the double's `layers`, `sources`, `visibility`, `markers`, `popups`.
7. If the feature has a behavior the suite must keep, add a mutation to `frontend/scripts/verify-map-pins.mjs` and prove it goes red.
8. Add the row to `docs/agent/FEATURE_MAP.md`.

Moving a capability out of `map.ts` follows the same steps, with one more before the first: pin its behavior with a contract test through `renderMap` and the MapLibre double (`frontend/test/maplibre-double.ts`), green on the old code, committed before anything moves. Callers move and the old symbols die in the same commit; no compatibility path.

## How to verify

```
cd frontend
bun run typecheck
bun run test
node scripts/verify-map-pins.mjs
```

All three green is the bar. "It compiles" is not. For a change a test cannot see, `bun run dev` and open the map with `?e2e` in the URL, which exposes the MapLibre instance as `window.__opdMap` for a browser walkthrough; compare against `main` before and after.

## Constraints

Structure changes; behavior does not. A real bug found during structure work goes into `docs/agent/FOLLOWUPS.md` with its pin left in place, not into the structural commit. Prefer deleting code to adding indirection. Do not rewrite the map vendor. Do not add README essays or comments.

## The rest of the repository

Generator: `pip install -e ".[dev]"`, then `ruff check generator/ tests/` and `pytest tests/`. Worker: `cd worker && bun run typecheck && bun run test`. CI runs all three jobs in `.github/workflows/test.yml`.
