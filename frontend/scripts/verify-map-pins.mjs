#!/usr/bin/env node
// Mutation check for the map behavior pins. Each entry below breaks one
// contract in a source file and names the pin that must go red. A mutation
// that leaves the suite green means the pin does not hold that contract.
//
// Usage: node scripts/verify-map-pins.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MAP = 'src/map.ts';
const CATALOG = 'src/map/map-core/catalog.ts';

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
];

const MUTATIONS = [
  {
    contract: 'night overlays stay below the ISS ground track',
    file: MAP,
    find: '    }, beforeTrack);\n  }\n  if (!map.getLayer(\'terminator-night-fill-layer\')) {',
    replace: '    });\n  }\n  if (!map.getLayer(\'terminator-night-fill-layer\')) {',
  },
  {
    contract: 'hiding clouds swaps the dark basemap for Esri imagery',
    file: MAP,
    find: "    'carto-dark-layer': useEsri ? 'none' : 'visible',",
    replace: "    'carto-dark-layer': 'visible',",
  },
  {
    contract: 'the map opens at lon 0, lat 0',
    file: MAP,
    find: '    center: [0, 0],\n    zoom: initialZoomForViewport(viewportWidthPx),',
    replace: '    center: [10, 0],\n    zoom: initialZoomForViewport(viewportWidthPx),',
  },
  {
    contract: 'the cloud raster paints at 55% opacity',
    file: MAP,
    find: "        id: 'gibs-clouds-layer',\n        type: 'raster',\n        source: 'gibs-clouds',\n        paint: { 'raster-opacity': 0.55 },",
    replace: "        id: 'gibs-clouds-layer',\n        type: 'raster',\n        source: 'gibs-clouds',\n        paint: { 'raster-opacity': 0.7 },",
  },
  {
    contract: 'labels default on when the operator has never chosen',
    file: MAP,
    find: '    const v = localStorage.getItem(LABELS_PREF_KEY);\n    return v === null ? true : v === \'1\';',
    replace: '    const v = localStorage.getItem(LABELS_PREF_KEY);\n    return v === \'1\';',
  },
  {
    contract: 'the night lights raster paints at 95% opacity',
    file: MAP,
    find: "      source: 'viirs-night-lights',\n      layout: { visibility: 'none' },\n      paint: { 'raster-opacity': 0.95 },",
    replace: "      source: 'viirs-night-lights',\n      layout: { visibility: 'none' },\n      paint: { 'raster-opacity': 0.55 },",
  },
  {
    contract: 'the global dim shows only with lights on and the terminator off',
    file: MAP,
    find: '  const dimVisible = nightLightsVisible && !terminatorVisible;',
    replace: '  const dimVisible = nightLightsVisible;',
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
