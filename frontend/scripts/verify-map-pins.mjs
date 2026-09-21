#!/usr/bin/env node
// Mutation check for the map behavior pins. Each entry below breaks one
// contract in src/map.ts and names the pin that must go red. A mutation that
// leaves the suite green means the pin does not hold that contract.
//
// Usage: node scripts/verify-map-pins.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = new URL('../src/map.ts', import.meta.url);

const PIN_FILES = [
  'test/map-render-contract.test.ts',
  'test/map-interaction-contract.test.ts',
  'test/map-style-contract.test.ts',
  'test/map-camera-contract.test.ts',
  'test/map-basemap.test.ts',
  'test/map-overlay-prefs.test.ts',
];

const MUTATIONS = [
  {
    contract: 'night overlays stay below the ISS ground track',
    find: '    }, beforeTrack);\n  }\n  if (!map.getLayer(\'terminator-night-fill-layer\')) {',
    replace: '    });\n  }\n  if (!map.getLayer(\'terminator-night-fill-layer\')) {',
  },
  {
    contract: 'hiding clouds swaps the dark basemap for Esri imagery',
    find: "    'carto-dark-layer': useEsri ? 'none' : 'visible',",
    replace: "    'carto-dark-layer': 'visible',",
  },
  {
    contract: 'the map opens at lon 0, lat 0',
    find: '    center: [0, 0],\n    zoom: initialZoomForViewport(viewportWidthPx),',
    replace: '    center: [10, 0],\n    zoom: initialZoomForViewport(viewportWidthPx),',
  },
  {
    contract: 'the cloud raster paints at 55% opacity',
    find: "        id: 'gibs-clouds-layer',\n        type: 'raster',\n        source: 'gibs-clouds',\n        paint: { 'raster-opacity': 0.55 },",
    replace: "        id: 'gibs-clouds-layer',\n        type: 'raster',\n        source: 'gibs-clouds',\n        paint: { 'raster-opacity': 0.7 },",
  },
  {
    contract: 'labels default on when the operator has never chosen',
    find: '    const v = localStorage.getItem(LABELS_PREF_KEY);\n    return v === null ? true : v === \'1\';',
    replace: '    const v = localStorage.getItem(LABELS_PREF_KEY);\n    return v === \'1\';',
  },
];

function runPins() {
  try {
    execFileSync('npx', ['vitest', 'run', ...PIN_FILES], {
      cwd: new URL('..', import.meta.url),
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

const original = readFileSync(SOURCE, 'utf8');
let failures = 0;

if (!runPins()) {
  console.error('baseline is red; fix the suite before running the mutation check');
  process.exit(1);
}
console.log('baseline green');

for (const mutation of MUTATIONS) {
  if (!original.includes(mutation.find)) {
    console.error(`STALE  ${mutation.contract} (anchor no longer in src/map.ts)`);
    failures += 1;
    continue;
  }
  writeFileSync(SOURCE, original.replace(mutation.find, mutation.replace));
  const stillGreen = runPins();
  writeFileSync(SOURCE, original);
  if (stillGreen) {
    console.error(`UNPINNED  ${mutation.contract}`);
    failures += 1;
  } else {
    console.log(`pinned    ${mutation.contract}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
