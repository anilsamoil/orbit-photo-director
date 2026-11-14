#!/usr/bin/env node
// Mutation check for the map behavior pins. Each entry below breaks one
// contract in a source file and names the pin that must go red. A mutation
// that leaves the suite green means the pin does not hold that contract.
//
// Usage: node scripts/verify-map-pins.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MAP = 'src/map/index.ts';
const BASEMAP_VISIBILITY = 'src/map/features/basemap/visibility.ts';
const CORE = 'src/map/map-core/core.ts';
const CATALOG = 'src/map/map-core/catalog.ts';
const CAMERA = 'src/map/map-core/camera.ts';
const PIN_DROP = 'src/map/features/pin-drop/index.ts';
const SATELLITES = 'src/map/features/satellites/index.ts';
const SATELLITE_LAYERS = 'src/map/features/satellites/layers.ts';
const ORBIT_LOOKUP = 'src/satellites.ts';
const TARGETS = 'src/map/features/targets/index.ts';
const LABELS = 'src/map/features/labels/index.ts';
const NIGHT_LIGHTS = 'src/map/features/night-lights/layers.ts';
const GLOBAL_DIM = 'src/map/overlays/global-dim.ts';
const GROUND_TRACK = 'src/map/features/ground-track/layers.ts';
const LAUNCH_CORRIDOR = 'src/map/features/launch-corridor/geometry.ts';

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
  'src/map/features/satellites/satellites.test.ts',
  'test/satellites.test.ts',
  'test/tracked.test.ts',
  'test/orbit-sight.test.ts',
  'src/map/features/lightning/lightning.test.ts',
  'src/map/features/targets/targets.test.ts',
  'src/map/features/launch-corridor/launch-corridor.test.ts',
  'test/launch-map-schedule.test.ts',
];

const MUTATIONS = [
  {
    contract: 'lightning polling survives wall clock correction',
    file: 'src/map/features/lightning/index.ts',
    find: '        stopPoll = core.clock.every(120_000, () => void poll());',
    replace: '        stopPoll = () => {};',
  },
  {
    contract: 'future lightning does not schedule an overflowing expiry',
    file: 'src/map/features/lightning/index.ts',
    find: 'if (feed && !future && feed.end + STALE_MS > now)',
    replace: 'if (feed && feed.end + STALE_MS > now)',
  },
  {
    contract: 'late lightning success cannot replace a newer request',
    file: 'src/map/features/lightning/index.ts',
    find: '        if (request !== controller) return;',
    replace: '',
  },
  {
    contract: 'recent lightning disappears on a scrub',
    file: 'src/map/features/lightning/index.ts',
    find: 'feed && !future && !scrubbed && now - feed.end < STALE_MS',
    replace: 'feed && !future && now - feed.end < STALE_MS',
  },
  {
    contract: 'cached lightning stays hidden when the wall clock moves before its observation end',
    file: 'src/map/features/lightning/index.ts',
    find: 'feed && !future && !scrubbed && now - feed.end < STALE_MS',
    replace: 'feed && !scrubbed && now - feed.end < STALE_MS',
  },
  {
    contract: 'lightning expires between periodic repaint ticks',
    file: 'src/map/features/lightning/index.ts',
    find: 'expiry = setTimeout(paint, feed.end + STALE_MS - now);',
    replace: 'expiry = null;',
  },
  {
    contract: 'camera movement leaves unchanged lightning data alone',
    file: 'src/map/features/lightning/index.ts',
    find: 'if (feed && visible && (rendered?.feed !== feed || rendered.ageBucket !== ageBucket))',
    replace: 'if (feed && visible)',
  },
  {
    contract: 'night overlays stay below the ISS ground track',
    file: CATALOG,
    find: "  'viirs-night-lights-layer',\n  'lightning-layer',\n  'iss-track-layer',",
    replace: "  'iss-track-layer',\n  'lightning-layer',\n  'viirs-night-lights-layer',",
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
    contract: 'night lights preserve overview intensity and restrain high-zoom glare',
    file: NIGHT_LIGHTS,
    find: "  source: 'viirs-night-lights',\n  layout: { visibility: 'none' },\n  paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.95, 4, 0.95, 6, 0.85, 8, 0.74] },",
    replace: "  source: 'viirs-night-lights',\n  layout: { visibility: 'none' },\n  paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.95, 4, 0.95, 6, 0.85, 8, 1] },",
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
    contract: 'an orbit is sampled over that satellite\'s own period, not the ISS period',
    file: SATELLITE_LAYERS,
    find: '  for (let t = 0; t <= period; t += SAMPLE_SECONDS) {',
    replace: '  for (let t = 0; t <= 5568; t += SAMPLE_SECONDS) {',
  },
  {
    contract: 'a published vehicle is drawn on the render that carries it in tracked.json',
    file: MAP,
    find: '  applyPublishedOrbits(trackedRecords);',
    replace: '',
  },
  {
    contract: 'a CelesTrak request that fails is a failed lookup, not a miss',
    file: ORBIT_LOOKUP,
    find: "  return cached ? fromCache(cached, true) : { state: 'failed', cause: reply.cause };",
    replace: "  return cached ? fromCache(cached, true) : { state: 'not_found' };",
  },
  {
    contract: 'one failed feed among empty ones is a failed lookup for a published vehicle',
    file: ORBIT_LOOKUP,
    find: "  if (cause === null) return { state: 'not_found' };\n  return publisherSays.state === 'failed' ? { state: 'failed', cause } : publisherSays;",
    replace: "  return publisherSays.state === 'failed' ? { state: 'not_found' } : publisherSays;",
  },
  {
    contract: 'a timeout is told apart from an unreachable host',
    file: ORBIT_LOOKUP,
    find: "    return { kind: 'error', cause: controller.signal.aborted ? 'timeout' : 'network' };",
    replace: "    return { kind: 'error', cause: 'network' };",
  },
  {
    contract: 'Starship is looked up in Supplemental GP as well as GP',
    file: ORBIT_LOOKUP,
    find: "    out.push(query('supgp', param, value), query('gp', param, value));",
    replace: "    out.push(query('gp', param, value));",
  },
  {
    contract: 'only an element set whose name, number or designator matches is taken for the vehicle',
    file: ORBIT_LOOKUP,
    find: '      ? reply.sets.filter((tle) => matchesLookup(lookup, tle)).map((tle) => ({ tle, feed: reply.feed }))',
    replace: '      ? reply.sets.map((tle) => ({ tle, feed: reply.feed }))',
  },
  {
    contract: 'an element set older than the publisher limit is never drawn',
    file: ORBIT_LOOKUP,
    find: '  const usable = candidates.filter(({ tle }) => ageHours(tle, nowMs) <= lookup.max_age_hours);',
    replace: '  const usable = candidates;',
  },
  {
    contract: 'the last good element set is dropped once it passes the publisher limit',
    file: ORBIT_LOOKUP,
    find: '  const lastGood = cached && lookup && ageHours(cached.tle, nowMs) <= lookup.max_age_hours ? cached : null;',
    replace: '  const lastGood = cached && lookup ? cached : null;',
  },
  {
    contract: 'the map never asks CelesTrak for a published vehicle on its own',
    file: ORBIT_LOOKUP,
    find: "  if (mode === 'published' || !lookup) return lastGood ? fromCache(lastGood, true) : publisherSays;",
    replace: '  if (!lookup) return lastGood ? fromCache(lastGood, true) : publisherSays;',
  },
  {
    contract: 'the newest element set wins',
    file: ORBIT_LOOKUP,
    find: '      if (eb !== ea) return eb > ea ? b : a;',
    replace: '      if (eb !== ea) return a;',
  },
  {
    contract: 'an unread tracked.json is a failed lookup, never a confirmed absence',
    file: 'src/tracked.ts',
    find: "    reason: 'lookup_failed',\n    lookup: {",
    replace: "    reason: 'no_public_orbit',\n    lookup: {",
  },
  {
    contract: 'a publisher element set past its age limit is not drawn',
    file: ORBIT_LOOKUP,
    find: '    if (ageHours(tle, nowMs) <= row.lookup.max_age_hours) {',
    replace: '    if (row.lookup.max_age_hours > 0) {',
  },
  {
    contract: 'a background lookup does not override a tap that is still asking CelesTrak',
    file: SATELLITES,
    find: "      if (mode === 'published' && sat.asking) return null;\n",
    replace: '',
  },
  {
    contract: 'a published orbit is age-checked every minute in an open map',
    file: SATELLITES,
    find: '      recheckPublished();\n',
    replace: '',
  },
  {
    contract: 'an answer to an earlier lookup never replaces a later one',
    file: SATELLITES,
    find: '      if (wanted.get(key) !== sat || sat.asked !== turn) return null;',
    replace: '      if (wanted.get(key) !== sat) return null;',
  },
  {
    contract: 'a wanted satellite with no element set draws nothing',
    file: SATELLITES,
    find: '      for (const [key, sat] of wanted) if (!elementsOf(sat)) erase(key, sat);',
    replace: '',
  },
  {
    contract: 'an unchecked published vehicle stays off through later publisher runs',
    file: SATELLITES,
    find: '      if (isPublished(sat.meta)) setPublishedHidden(key, true);',
    replace: '',
  },
  {
    contract: 'a typed satellite that cannot be looked up is not kept',
    file: SATELLITES,
    find: '      if (!result.ok && !known) remove(key);',
    replace: '',
  },
  {
    contract: 'a checked row keeps its place in the list',
    file: 'src/map/features/satellites/picker.ts',
    find: '  return [...curated, ...port.metas().filter((meta) => !curatedKeys.has(metaKey(meta)))];',
    replace: '  return [...curated, ...port.metas()];',
  },
  {
    contract: 'the picker says why a wanted satellite has no orbit',
    file: 'src/map/features/satellites/picker.ts',
    find: '    if (note) notes.appendChild(note);',
    replace: '',
  },
  {
    contract: 'line of sight ends where the Earth is in the way',
    file: 'src/orbit-sight.ts',
    find: '  return nearest >= EARTH_RADIUS_KM ? Math.sqrt(dd) : null;',
    replace: '  return nearest >= 0 ? Math.sqrt(dd) : null;',
  },
  {
    contract: 'unchecking a satellite forgets it for the next visit',
    file: SATELLITES,
    find: '      publish();\n      persist();\n    };\n\n    const addTyped',
    replace: '      publish();\n    };\n\n    const addTyped',
  },
  {
    contract: 'a crew roster site popup has no Edit button',
    file: TARGETS,
    find: '    const onEdit = props.is_personal && props.target_id && !isRosterProfile(parseProfileFromURL(window.location.href))',
    replace: '    const onEdit = props.is_personal && props.target_id',
  },
  {
    contract: 'a scheduled Watch launch remains a map pin without a photography chance',
    file: LAUNCH_CORRIDOR,
    find: '  const pins = tiers.mapPins;',
    replace: '  const pins = tiers.pins;',
  },
  {
    contract: 'a tier pin with no corridor draws no line',
    file: LAUNCH_CORRIDOR,
    find: '    if (pin.corridor) lines.push(...antimeridianSegments(pin.corridor.points, properties));',
    replace: '    lines.push(...antimeridianSegments(pin.corridor ? pin.corridor.points : [pin.site, pin.site], properties));',
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
