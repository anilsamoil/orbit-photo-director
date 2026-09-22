#!/usr/bin/env node
// Mutation check for the map behavior pins. Each entry below breaks one
// contract in a source file and names the pin that must go red. A mutation
// that leaves the suite green means the pin does not hold that contract.
//
// Usage: node scripts/verify-map-pins.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MAP = 'src/map.ts';
const BASEMAP_VISIBILITY = 'src/map/features/basemap/visibility.ts';
const CORE = 'src/map/map-core/core.ts';
const CATALOG = 'src/map/map-core/catalog.ts';
const CAMERA = 'src/map/map-core/camera.ts';
const PIN_DROP = 'src/map/features/pin-drop/index.ts';
const SATELLITES = 'src/map/features/satellites/index.ts';
const LABELS = 'src/map/features/labels/index.ts';
const NIGHT_LIGHTS = 'src/map/features/night-lights/layers.ts';
const GLOBAL_DIM = 'src/map/overlays/global-dim.ts';
const GROUND_TRACK = 'src/map/features/ground-track/layers.ts';

const PIN_FILES = [
  'test/map-render-contract.test.ts',
  'test/map-interaction-contract.test.ts',
  'test/map-style-contract.test.ts',
  'test/map-camera-contract.test.ts',
  'test/map-basemap.test.ts',
  'test/map-overlay-prefs.test.ts',
  'test/map-catalog.test.ts',
  'test/map-ir.test.ts',
  'test/map-night-lights.test.ts',
  'test/map-pin-drop-contract.test.ts',
  'test/map-satellites-contract.test.ts',
  'test/map-ground-track-contract.test.ts',
];

const MUTATIONS = [
  {
    contract: 'night overlays stay below the ISS ground track',
    file: CATALOG,
    find: "  'viirs-night-lights-layer',\n  'iss-track-layer',",
    replace: "  'iss-track-layer',\n  'viirs-night-lights-layer',",
  },
  {
    contract: 'a layer added later still paints at its catalog position',
    file: CORE,
    find: '      vendor.addLayer(spec, beforeIdFor(spec.id, vendor.paintedLayers()));',
    replace: '      vendor.addLayer(spec);',
  },
  {
    contract: 'hiding clouds swaps the dark basemap for Esri imagery',
    file: BASEMAP_VISIBILITY,
    find: "    'carto-dark-layer': useEsri ? 'none' : 'visible',",
    replace: "    'carto-dark-layer': 'visible',",
  },
  {
    contract: 'the map opens at lon 0, lat 0',
    file: CAMERA,
    find: '  return { center: [0, 0], zoom: initialZoomForViewport(viewportWidthPx) };',
    replace: '  return { center: [10, 0], zoom: initialZoomForViewport(viewportWidthPx) };',
  },
  {
    contract: 'the cloud raster paints at 55% opacity',
    file: MAP,
    find: "        id: 'gibs-clouds-layer',\n        type: 'raster',\n        source: 'gibs-clouds',\n        paint: { 'raster-opacity': 0.55 },",
    replace: "        id: 'gibs-clouds-layer',\n        type: 'raster',\n        source: 'gibs-clouds',\n        paint: { 'raster-opacity': 0.7 },",
  },
  {
    contract: 'labels default on when the operator has never chosen',
    file: LABELS,
    find: "    const stored = localStorage.getItem(PREF_KEYS.labelsVisible);\n    return stored === null ? true : stored === '1';",
    replace: "    const stored = localStorage.getItem(PREF_KEYS.labelsVisible);\n    return stored === '1';",
  },
  {
    contract: 'the night lights raster paints at 95% opacity',
    file: NIGHT_LIGHTS,
    find: "  source: 'viirs-night-lights',\n  layout: { visibility: 'none' },\n  paint: { 'raster-opacity': 0.95 },",
    replace: "  source: 'viirs-night-lights',\n  layout: { visibility: 'none' },\n  paint: { 'raster-opacity': 0.55 },",
  },
  {
    contract: 'the global dim shows only with lights on and the terminator off',
    file: GLOBAL_DIM,
    find: '  const dimVisible = flags.nightLights && !flags.terminator;',
    replace: '  const dimVisible = flags.nightLights;',
  },
  {
    contract: 'the current orbit paints at 85% opacity',
    file: GROUND_TRACK,
    find: '      0, 0.85,\n      1, 0.55,',
    replace: '      0, 0.5,\n      1, 0.55,',
  },
  {
    contract: 'the IR raster ships hidden so no tile is fetched until the operator asks',
    file: MAP,
    find: "        source: 'geo-ir',\n        layout: { visibility: 'none' },\n        paint: { 'raster-opacity': 0.82 },",
    replace: "        source: 'geo-ir',\n        layout: { visibility: 'visible' },\n        paint: { 'raster-opacity': 0.82 },",
  },
  {
    contract: 'the catalog order is the order renderMap paints',
    file: CATALOG,
    find: "  'iss-track-layer',\n  'my-targets-casing',",
    replace: "  'my-targets-casing',\n  'iss-track-layer',",
  },
  {
    contract: 'the dropped pin lists passes from the wall clock, not the scrubbed view',
    file: PIN_DROP,
    find: '      const nowMs = core.clock.now();',
    replace: '      const nowMs = core.clock.viewMs();',
  },
  {
    contract: 'a finger that drifts more than 8 px is a pan, not a long press',
    file: PIN_DROP,
    find: '    if (Math.hypot(finger.x - press.start.x, finger.y - press.start.y) > LONG_PRESS_MOVE_THRESHOLD_PX) release();',
    replace: '    if (Math.hypot(finger.x - press.start.x, finger.y - press.start.y) > 1000) release();',
  },
  {
    contract: 'a satellite track window starts at the view instant, not the wall clock',
    file: SATELLITES,
    find: '      const fromMs = core.clock.viewMs();',
    replace: '      const fromMs = core.clock.now();',
  },
  {
    contract: 'a satellite marker sits at its sub-point for the view instant',
    file: SATELLITES,
    find: '      const atMs = core.clock.viewMs();',
    replace: '      const atMs = core.clock.now();',
  },
  {
    contract: 'unchecking a satellite forgets it for the next visit',
    file: SATELLITES,
    find: '      tracked.delete(key);\n      publish();\n      persistSelectedKeys(tracked.keys());',
    replace: '      tracked.delete(key);\n      publish();',
  },
];

const root = new URL('..', import.meta.url);
const pathOf = (file) => new URL(file, root);

function runPins() {
  try {
    execFileSync('npx', ['vitest', 'run', ...PIN_FILES], { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const originals = new Map([...new Set(MUTATIONS.map((m) => m.file))].map((file) => [file, readFileSync(pathOf(file), 'utf8')]));
let failures = 0;

if (!runPins()) {
  console.error('baseline is red; fix the suite before running the mutation check');
  process.exit(1);
}
console.log('baseline green');

for (const mutation of MUTATIONS) {
  const original = originals.get(mutation.file);
  if (!original.includes(mutation.find)) {
    console.error(`STALE  ${mutation.contract} (anchor no longer in ${mutation.file})`);
    failures += 1;
    continue;
  }
  writeFileSync(pathOf(mutation.file), original.replace(mutation.find, mutation.replace));
  const stillGreen = runPins();
  writeFileSync(pathOf(mutation.file), original);
  if (stillGreen) {
    console.error(`UNPINNED  ${mutation.contract}`);
    failures += 1;
  } else {
    console.log(`pinned    ${mutation.contract}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
