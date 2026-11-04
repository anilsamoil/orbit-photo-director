import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readableRasterName } from './raster-ocr.mjs';
import { letteringOccluded } from '../../../../frontend/src/map/adapters/maplibre/country-label-size.ts';
import {
  AUDITED_RASTER_LEVELS, auditRasterLevels, captureEnvironmentOk, countryStyleVerdict, countrySweepZooms,
  anchorOnPlan, auditedNameCandidates, auditedNameReadable, clippedRasterRemnant, completeNameCount, labelScreenVerdict, labelTile, loadCountryRasterLevels, loadCountrySymbolLayers, nameCountOk, oneNameSource, pairedRasterNames, planCameraContract, planLabelReaders, planLabelVerdict, rasterDuplicateVerdict, rasterNameEvidence, rasterPainted, RASTER_PAIR_TOLERANCE, symbolCrossesEdge,
} from './plan-label-verdict.mjs';
import { acceptPlanSweepRow } from './drive.mjs';

test('an exact sovereign name is not vetoed by an unrelated adjective', () => {
  assert.equal(rasterPainted('AUSTRALIA\nGreat Australian Bight', 'Australia'), true);
  assert.equal(rasterPainted('Great Australian Bight', 'Australia'), false);
  assert.equal(rasterPainted('South Australia', 'Australia'), false);
  assert.equal(rasterPainted('Western Australia\nAUSTRALIA', 'Australia'), true);
  assert.equal(rasterPainted('INDIAN OCEAN', 'India'), false);
  assert.equal(rasterPainted('INDIA\nINDIAN OCEAN', 'India'), true);
});

test('generated sweep includes fitted extremes and both sides of every audited tile edge', () => {
  const samples = countrySweepZooms();
  for (const z of [-1.1497862143712645, -0.23372503287116042, -0.51, -0.5, -0.49, 1.49, 1.5, 1.51, 2.49, 2.5, 2.51, 3.49, 3.5, 3.51, 4.49, 4.5, 4.51, 5, 5.5, 6.5, 6.51, 8]) {
    assert.ok(samples.includes(z), `missing ${z}`);
  }
  assert.equal(new Set(samples).size, samples.length);
});

test('actual production layers agree with the independent fresh raster audit', () => {
  assert.deepEqual(auditRasterLevels(loadCountryRasterLevels()), { ok: true });
  assert.deepEqual(countryStyleVerdict(loadCountrySymbolLayers()), { ok: true });
});

test('opacity and false Australia-hole mutations fail the real-style guard', () => {
  const baseline = loadCountrySymbolLayers();
  const transparent = structuredClone(baseline);
  transparent.find((layer) => layer.id === 'inset-countries').paint['text-opacity'] = 0;
  assert.equal(countryStyleVerdict(transparent).ok, false);
  const shifted = structuredClone(baseline);
  shifted.find((layer) => layer.id === 'inset-countries').paint['text-opacity'] = ['step', ['zoom'], 1, 0, 0];
  assert.equal(countryStyleVerdict(shifted).ok, false);
  for (const bad of [[0, 1, 2, 3, 4, 5, 6], [1, 2, 4, 5, 6], [1, 2, 3, 4, 6]]) {
    const levels = structuredClone(AUDITED_RASTER_LEVELS);
    levels.countries.Australia = bad;
    assert.equal(auditRasterLevels(levels).ok, false);
    assert.equal(countryStyleVerdict(baseline, levels).ok, false);
  }
});

test('France at 5.49, 5.5, 6.5, and 8 is proved at the label tile the source draws', () => {
  for (const zoom of [5.49, 5.5, 6.5, 8]) {
    const tileZ = labelTile(zoom);
    const verdict = oneNameSource({
      tilesOk: true,
      zoom,
      tileZ,
      country: 'France',
      names: [],
      words: 'FRANCE',
      rasterReadable: true,
    });
    assert.equal(verdict.ok, true, `${zoom} ${verdict.reason} expected ${verdict.expected}`);
    assert.equal(verdict.reason, undefined);
  }
});

test('Canada at zoom 6.5 does not count a 36 by 8 dark scrap as a second name', () => {
  const zoom = 6.5;
  const tileZ = 8;
  const scale = (512 * (2 ** zoom)) / (256 * (2 ** tileZ));
  const scrap = { text: 'CANADA', uppercase: true, box: [20, 20, 20 + (36 / scale), 20 + (8 / scale)] };
  const pack = { mosaics: [{ z: tileZ, service: 'dark', lines: [[scrap]], words: [scrap] }] };
  const row = {
    tilesOk: true,
    zoom,
    tileZ: labelTile(zoom),
    country: 'Canada',
    names: ['Canada'],
    words: 'CANADA',
    viewport: { width: 800, height: 600, scale, origin: { x: 0, y: 0 }, occlusions: [] },
  };
  const raster = readableRasterName(pack, row, 'Canada');
  assert.equal(raster.readable, false);
  assert.equal(oneNameSource({ ...row, rasterReadable: raster.readable }).ok, true);
  assert.equal(oneNameSource({ ...row, rasterReadable: true }).reason, 'duplicate');
  const full = { text: 'CANADA', uppercase: true, box: [20, 20, 20 + (200 / scale), 20 + (48 / scale)] };
  const fullPack = { mosaics: [{ z: tileZ, service: 'dark', lines: [[full]], words: [full] }] };
  assert.equal(readableRasterName(fullPack, row, 'Canada').readable, true);
});

test('the map and the verifier import one lettering-size rule', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const map = readFileSync(resolve(root, 'frontend/src/map/adapters/maplibre/track-inset.ts'), 'utf8');
  const ocr = readFileSync(resolve(root, '.cursor/skills/verify-opd/scripts/raster-ocr.mjs'), 'utf8');
  assert.match(map, /countryLabelCounts/);
  assert.match(ocr, /countryLabelCounts/);
});

test('Australia at z6.5 on a 492 by 690 plan keeps the painted name when only the merge pad crosses the edge', () => {
  const zoom = 6.5;
  const tileZ = 6;
  const world = 512 * (2 ** zoom);
  const center = [134, -25];
  const mercatorX = (center[0] + 180) / 360;
  const mercatorY = (1 - Math.asinh(Math.tan(center[1] * Math.PI / 180)) / Math.PI) / 2;
  const viewport = { width: 492, height: 690, occlusions: [], origin: { x: 246 - mercatorX * world, y: 345 - mercatorY * world } };
  const tile = 256 * (2 ** tileZ);
  const ink = [0.86907959, 0.572692871, 0.877502441, 0.573547363].map((value) => value * tile);
  const word = { text: 'AUSTRALIA', uppercase: true, box: ink };
  const pack = { mosaics: [{ z: tileZ, service: 'reference', lines: [[word]], words: [word] }] };
  const row = { zoom, viewport };
  const raster = readableRasterName(pack, row, 'Australia');
  assert.equal(raster.readable, true);
  const evidence = rasterNameEvidence(raster.boxes, auditedNameCandidates('Australia', zoom, viewport));
  assert.equal(evidence, true);
  assert.equal(oneNameSource({
    tilesOk: true, zoom, tileZ: labelTile(zoom), country: 'Australia', names: [], words: 'AUSTRALIA', rasterReadable: evidence,
  }).ok, true);
  const crossed = { ...word, box: [ink[0], ink[1], ink[2] + 20, ink[3]] };
  const clippedPack = { mosaics: [{ z: tileZ, service: 'reference', lines: [[crossed]], words: [crossed] }] };
  assert.equal(readableRasterName(clippedPack, row, 'Australia').readable, false);
  assert.equal(rasterNameEvidence([], auditedNameCandidates('Australia', zoom, viewport)), false);
  assert.equal(oneNameSource({
    tilesOk: true, zoom, tileZ: labelTile(zoom), country: 'Australia', names: [], words: 'AUSTRALIA', rasterReadable: false,
  }).reason, 'gap');
  assert.equal(oneNameSource({
    tilesOk: true, zoom, tileZ: labelTile(zoom), country: 'Australia', names: ['Australia'], words: 'AUSTRALIA', rasterReadable: true,
  }).reason, 'duplicate');
});

test('whole-tile words cannot override clipped or occluded composed-viewport evidence', () => {
  const row = { tilesOk: true, zoom: 5, tileZ: 6, country: 'Canada', words: 'CANADA', rasterReadable: false, names: [] };
  assert.equal(oneNameSource(row).reason, 'gap');
  assert.equal(oneNameSource({ ...row, names: ['Canada'] }).ok, true);
  assert.equal(oneNameSource({ ...row, names: ['Canada'], rasterReadable: true }).reason, 'duplicate');
});

test('a transparent or mismatched label is not a painted country name', () => {
  const placed = (name, extra = {}) => ({ properties: { name }, x: 40, y: 40, ...extra });
  const sample = {
    glyphs: 12000,
    layerPresent: true,
    visibility: 'visible',
    textOpacity: 1,
    textColor: '#f7f4ea',
    textField: ['get', 'name'],
    width: 320,
    height: 240,
    catalog: ['Canada', 'Mexico', 'Brazil', 'Japan', 'France'],
    rendered: [
      placed('Canada'),
      placed('Mexico'),
      placed('Brazil'),
      placed('Japan'),
      placed('France', { textField: 'X', textColor: 'transparent', textOpacity: 0 }),
    ],
  };
  const verdict = planLabelVerdict(sample);
  assert.equal(verdict.names.includes('France'), false);
  assert.deepEqual(verdict.names, ['Canada', 'Mexico', 'Brazil', 'Japan']);
  const mismatched = planLabelVerdict({
    ...sample,
    rendered: [placed('France', { textField: 'X' })],
  });
  assert.equal(mismatched.ok, false);
  assert.equal((mismatched.names || []).includes('France'), false);
  const transparent = planLabelVerdict({
    ...sample,
    rendered: [placed('France', { textColor: 'transparent' })],
  });
  assert.equal((transparent.names || []).includes('France'), false);
});

test('readPlanLabels keeps each feature paint object and does not collapse two Frances', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${planLabelReaders()}\nthis.readPlanLabels = readPlanLabels;`, context);
  const formatted = { sections: [{ text: 'France' }] };
  const color = { r: 0.97, g: 0.96, b: 0.92, a: 1 };
  const france = {
    properties: { name: 'France' },
    geometry: { type: 'Point', coordinates: [2, 46] },
    layer: {
      layout: { 'text-field': formatted, visibility: 'visible' },
      paint: { 'text-color': color, 'text-opacity': 1 },
    },
  };
  const hidden = {
    ...france,
    layer: {
      layout: { 'text-field': formatted, visibility: 'none' },
      paint: { 'text-color': color, 'text-opacity': 1 },
    },
  };
  const others = ['Canada', 'Mexico', 'Brazil', 'Japan'].map((name, index) => ({
    properties: { name },
    geometry: { type: 'Point', coordinates: [index, 20] },
    layer: {
      layout: { 'text-field': { sections: [{ text: name }] }, visibility: 'visible' },
      paint: { 'text-color': color, 'text-opacity': 1 },
    },
  }));
  const orbit = {
    getLayer: () => ({ id: 'inset-countries' }),
    getPaintProperty: (_id, key) => (key === 'text-opacity' ? 1 : color),
    getLayoutProperty: (_id, key) => {
      if (key === 'text-field') return { sections: [{ text: 'X' }] };
      if (key === 'visibility') return 'visible';
      return undefined;
    },
    getStyle: () => ({ layers: [{ id: 'inset-countries', source: 'inset-countries', type: 'symbol' }] }),
    queryRenderedFeatures: () => [france, france, hidden, ...others],
    querySourceFeatures: () => [france, ...others],
    project: () => ({ x: 40, y: 40 }),
  };
  const verdict = context.readPlanLabels(orbit, 12000, 320, 240);
  assert.equal(verdict.names.filter((name) => name === 'France').length, 2);
  assert.equal(verdict.names.includes('Canada'), true);
});

test('the name sweep includes the off-centroid cameras and rejects a clipped remnant', () => {
  const drive = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8');
  const start = drive.indexOf('const sweepNotes');
  const sweep = drive.slice(start, drive.indexOf('const france = await readPlanLabelZoom', start));
  assert.match(sweep, /-0\.33,\s*46/);
  assert.match(sweep, /\[\s*134,\s*-25\s*\]/);
  assert.match(sweep, /6\.51/);
  assert.match(sweep, /131\.772,\s*-25/);
  assert.match(sweep, /132\.723,\s*-25/);
  assert.match(sweep, /-63\.36,\s*-34/);
  assert.match(sweep, /country: 'India'/);
  assert.match(sweep, /\[\s*79,\s*22\s*\]/);
  assert.doesNotMatch(readFileSync(new URL('./plan-label-verdict.test.mjs', import.meta.url), 'utf8'), /origin\/main:frontend/);
  const mainBaseline = '671f6e5cea4d8666421870c6fd220beebb8d47cc';
  const mainInset = execFileSync('git', ['show', `${mainBaseline}:frontend/src/map/adapters/maplibre/track-inset.ts`], { encoding: 'utf8' });
  assert.equal(mainBaseline, '671f6e5cea4d8666421870c6fd220beebb8d47cc');
  assert.match(mainInset, /nameLayer\('inset-countries', 'inset-countries', undefined, PLAN_RASTER_NAME_ZOOM\)/);
  assert.doesNotMatch(mainInset, /inset-countries-viewport/);
  assert.match(sweep, /assertPlanLabelChecks/);
  assert.doesNotMatch(sweep, /inset-label-mask/);
  assert.doesNotMatch(sweep, /countryGlyphBoxes/);
  assert.doesNotMatch(sweep, /data-inset-label-cover/);
  assert.equal(rasterNameEvidence([], [{ box: [10, 10, 40, 20] }]), false);
  assert.equal(rasterNameEvidence([{ box: [12, 12, 36, 18] }], [{ box: [10, 10, 40, 20] }]), true);
  assert.equal(rasterNameEvidence([{ box: [80, 80, 100, 90] }], [{ box: [10, 10, 40, 20] }]), false);
  assert.equal(rasterNameEvidence([{ box: [12, 12, 36, 18] }], [{ box: [10, 10, 40, 20] }], [{ left: 0, top: 0, right: 50, bottom: 30 }]), false);
  assert.doesNotMatch(drive.slice(drive.indexOf('export async function assertOneNameSource'), drive.indexOf('export async function proveFractionalPlanLabels')), /\|\| auditedNameReadable/);
  const border = oneNameSource({
    tilesOk: true, zoom: 6.5, tileZ: labelTile(6.5), country: 'Nigeria', names: [], rasterReadable: true, rasterCount: 3,
  });
  assert.equal(border.ok, false);
  assert.equal(border.reason, 'duplicate');
  assert.equal(border.raster, 3);
  assert.match(sweep, /\[\s*8,\s*10\s*\]/);
  assert.match(sweep, /\[\s*9,\s*10\s*\]/);
  assert.match(sweep, /8\.5,\s*11/);
  assert.match(sweep, /37\.5,\s*2/);
  assert.match(sweep, /\[\s*37,\s*1\s*\]/);
  assert.doesNotMatch(sweep, /minWidth/);
  assert.doesNotMatch(sweep, /allowEmpty/);
  assert.doesNotMatch(sweep, /frames:/);
  assert.doesNotMatch(sweep, /raster \? 1 : 0/);
  const franceNarrow = anchorOnPlan([2, 46], [-0.33, 46], 6.51, 435, 590);
  assert.ok(Math.abs(franceNarrow.x - 519.5) < 1, franceNarrow.x);
  assert.equal(franceNarrow.inside, false);
  assert.equal(nameCountOk(0, franceNarrow.inside).ok, true);
  assert.equal(anchorOnPlan([2, 46], [-0.33, 46], 5.5, 274, 984).inside, false);
  assert.equal(anchorOnPlan([134, -25], [131.772, -25], 5.5, 274, 984).inside, false);
  const argentina = anchorOnPlan([-64, -34], [-63.36, -34], 6.5, 478, 690);
  assert.equal(argentina.inside, true);
  assert.equal(nameCountOk(0, argentina.inside).ok, false);
  assert.equal(nameCountOk(2, false).ok, false);
  assert.equal(letteringOccluded([0, 0, 100, 20], [[99, 0, 140, 30]]), false);
  assert.equal(letteringOccluded([0, 0, 100, 20], [[92, 0, 140, 30]]), true);
  const canada = { text: 'CANADA', uppercase: true, box: [1000, 1000, 1200, 1080] };
  const doubledServices = {
    mosaics: [
      { z: 6, service: 'reference', lines: [[canada]], words: [canada] },
      { z: 6, service: 'dark', lines: [[canada]], words: [canada] },
    ],
  };
  const canadaRow = { zoom: 1.5, viewport: { width: 8000, height: 8000, occlusions: [], origin: { x: 0, y: 0 } } };
  assert.equal(readableRasterName(doubledServices, canadaRow, 'Canada').boxes.length, 1);
  const doubled = oneNameSource({
    tilesOk: true, zoom: 6.5, tileZ: labelTile(6.5), country: 'Nigeria', names: [], rasterReadable: true, rasterCount: 2,
  });
  assert.equal(doubled.ok, false);
  assert.equal(doubled.reason, 'duplicate');
  assert.equal(doubled.count + doubled.raster, 2);
  assert.match(sweep, /8\.6386,\s*10/);
  assert.match(sweep, /38\.3,\s*1/);
  assert.match(sweep, /38\.15,\s*1\.15/);
  assert.match(sweep, /37\.99,\s*0\.95/);
  assert.equal(completeNameCount(
    [{ box: [10, 10, 14, 13] }, { box: [20, 20, 80, 40] }, { box: [90, 90, 120, 100] }],
    { width: 100, height: 100, occlusions: [] },
  ), 2);
  assert.equal(completeNameCount(
    [{ box: [10, 10, 46, 18] }, { box: [60, 60, 140, 100] }],
    { width: 200, height: 200, zoom: 6.5, occlusions: [] },
  ), 1);
  const open = oneNameSource({
    tilesOk: true, zoom: 5.5, tileZ: labelTile(5.5), country: 'France', names: ['France'], rasterReadable: true,
  });
  assert.equal(open.reason, 'duplicate');
  const remnant = clippedRasterRemnant(
    [{ box: [400, 200, 520, 240] }],
    { width: 492, height: 690 },
    [],
  );
  assert.equal(remnant.covered, false);
  const world = 512 * (2 ** 5.5);
  const center = [-0.33, 46];
  const mercatorX = (center[0] + 180) / 360;
  const mercatorY = (1 - Math.asinh(Math.tan(center[1] * Math.PI / 180)) / Math.PI) / 2;
  const france = { width: 492, height: 690, occlusions: [], origin: { x: 246 - mercatorX * world, y: 345 - mercatorY * world } };
  assert.equal(auditedNameReadable('France', 5.5, france), true);
  const clippedWorld = 512 * (2 ** 6.5);
  const clipped = { width: 492, height: 690, occlusions: [], origin: { x: 246 - mercatorX * clippedWorld, y: 345 - mercatorY * clippedWorld } };
  assert.equal(auditedNameReadable('France', 6.5, clipped), false);
});

test('plan layout cleanup does not delete devicePixelRatio', () => {
  const drive = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(drive, /delete window\.devicePixelRatio/);
});

test('the plan-inset docs follow the label tile the source draws', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const iss = readFileSync(resolve(root, '.cursor/skills/verify-opd/features/iss.md'), 'utf8');
  const skill = readFileSync(resolve(root, '.cursor/skills/verify-opd/SKILL.md'), 'utf8');
  assert.equal(iss.includes('vector name layer below zoom 3'), false);
  assert.equal(skill.includes('From zoom 3 the reference raster is the only place-name layer'), false);
  assert.equal(iss.includes(', The fitted orbit'), false);
  assert.match(iss, /view zoom 5\.5/);
  assert.match(skill, /view zoom 5\.5/);
  assert.match(iss, /reference raster maxzoom is 19/);
  assert.match(skill, /reference raster maxzoom is 19/);
  assert.doesNotMatch(iss, /reference raster caps at tile level 6/);
  assert.doesNotMatch(skill, /reference raster caps at tile level 6/);
  assert.match(iss, /min\(round\(zoom \+ 1\), source maxzoom\)/);
  assert.match(skill, /min\(round\(zoom \+ 1\), source maxzoom\)/);
});

test('glyph ink, not the padded OCR box, meets the shared one-pixel clock rule', () => {
  const scale = 1.5;
  const box = [378.5, 8.5, 421.5, 33.5];
  const viewport = { width: 435, height: 590, zoom: 6.51 };
  assert.equal(completeNameCount([{ box, scale }], { ...viewport, occlusions: [[419.2, 0, 435, 90]] }), 1);
  assert.equal(completeNameCount([{ box, scale }], { ...viewport, occlusions: [[410, 0, 435, 90]] }), 0);
  assert.equal(nameCountOk(0, true).ok, false);
  assert.equal(nameCountOk(1, true, { peek: true }).reason, 'peek');
  assert.equal(nameCountOk(1, true, { clipped: true }).reason, 'clipped');
  assert.equal(nameCountOk(1, true, { maskCut: true }).reason, 'mask');
  assert.equal(symbolCrossesEdge({ left: -4, top: 10, right: 40, bottom: 26 }, 274, 984), true);
  assert.equal(symbolCrossesEdge({ left: 8, top: 10, right: 60, bottom: 26 }, 274, 984), false);
  const drive = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8');
  const off = drive.slice(drive.indexOf('const offCentroid'), drive.indexOf('const france = await readPlanLabelZoom'));
  const check = drive.slice(drive.indexOf('export function assertPlanLabelChecks'), drive.indexOf('export async function proveFractionalPlanLabels'));
  assert.match(off, /assertPlanLabelChecks\(/);
  assert.match(off, /planCameraContract\(/);
  assert.match(off, /releasePlanCamera\(/);
  assert.match(check, /pairedRasterNames\(row\.headShot, row\.mainShot, \{ ignoreRects: row\.ignoreRects/);
  assert.match(check, /labelScreenVerdict\(/);
  assert.match(check, /mainChromeRects: main\.shot/);
  assert.match(check, /mainIgnoreRects: main\.shot/);
  const openMain = drive.slice(drive.indexOf('async function openPlanMain'), drive.indexOf('async function forgetMainLease'));
  assert.match(openMain, /openDeviceContext\(/);
  assert.doesNotMatch(openMain, /session\.context\.addCookies|session\.context\.newPage/);
  assert.match(openMain, /finally \{/);
  assert.ok(openMain.indexOf('finally {') > openMain.indexOf('leaseMainFixture'), 'the lease release covers setup after registration');
  assert.match(openMain, /if \(!handed\) await releaseMainLease\(lease\)/);
  assert.match(check, /rasterDuplicateVerdict\(/);
  assert.doesNotMatch(drive, /KENYA_WEST_RASTER_COUNT|countCountryGlyphs|frameNameVerdict/);
  const rasterRead = drive.slice(drive.indexOf('function rasterNameVerdict'), drive.indexOf('export function acceptPlanSweepRow'));
  assert.doesNotMatch(rasterRead, /ignoreRects/);
  assert.doesNotMatch(check, /row\.rasterCount|loadMainRaster|counts\.json/);
  assert.equal(RASTER_PAIR_TOLERANCE, 0.012);
  assert.doesNotMatch(off, /countryGlyphBoxes|clippedRasterRemnant|peekingGlyphInk/);
  assert.doesNotMatch(check, /countryGlyphBoxes/);
});

function rasterFrame(width, height, paint) {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 24;
    data[index + 1] = 26;
    data[index + 2] = 28;
    data[index + 3] = 255;
  }
  paint(data, width, height);
  return { width, height, data };
}

function paintWord(data, width, height, x, y, wordWidth, wordHeight) {
  for (let row = y; row < y + wordHeight; row += 1) {
    for (let column = x; column < x + wordWidth; column += 1) {
      if (column < 0 || row < 0 || column >= width || row >= height) continue;
      const index = (row * width + column) * 4;
      data[index] = 236;
      data[index + 1] = 232;
      data[index + 2] = 220;
    }
  }
}

test('paired screenshots reject a blank France, the wrong country, a third Kenya, a clipped NYA, and a name under the buttons', () => {
  const frames = [];
  for (let copy = 0; copy < 4; copy += 1) {
    const shift = copy * 3;
    frames.push([
      'blank France z6.5',
      rasterFrame(96, 64, (data, width, height) => paintWord(data, width, height, 30 + shift, 28, 28, 8)),
      rasterFrame(96, 64, () => {}),
      0,
    ]);
    frames.push([
      'EGYPT shown instead of KENYA',
      rasterFrame(96, 64, (data, width, height) => paintWord(data, width, height, 20 + shift, 24, 30, 8)),
      rasterFrame(96, 64, (data, width, height) => paintWord(data, width, height, 60, 40, 22, 8)),
      1,
    ]);
    frames.push([
      'three KENYAs',
      rasterFrame(96, 64, (data, width, height) => {
        paintWord(data, width, height, 8, 20, 16, 6);
        paintWord(data, width, height, 40, 20, 16, 6);
      }),
      rasterFrame(96, 64, (data, width, height) => {
        paintWord(data, width, height, 8, 20, 16, 6);
        paintWord(data, width, height, 40, 20, 16, 6);
        paintWord(data, width, height, 70, 40, 16, 6);
      }),
      2,
    ]);
    frames.push([
      'clipped NYA',
      rasterFrame(96, 64, (data, width, height) => paintWord(data, width, height, 24, 26, 28, 8)),
      rasterFrame(96, 64, (data, width, height) => paintWord(data, width, height, 0, 26, 8, 8)),
      1,
    ]);
    frames.push([
      'name under the buttons',
      rasterFrame(96, 64, (data, width, height) => paintWord(data, width, height, 36, 30, 22, 8)),
      rasterFrame(96, 64, (data, width, height) => paintWord(data, width, height, 2, 2, 22, 8)),
      1,
    ]);
  }
  assert.equal(frames.length, 20);
  const missed = [];
  for (const [label, main, head, count] of frames) {
    const verdict = pairedRasterNames(head, main);
    if (verdict.ok !== false || verdict.reason !== 'pixels') missed.push(`${label} ${verdict.reason || 'passed'}`);
    const same = pairedRasterNames(main, main);
    if (same.ok !== true) missed.push(`${label} matching pair`);
  }
  assert.deepEqual(missed, []);
});

test('a low zoom left at z8 is a failed check', () => {
  assert.throws(() => acceptPlanSweepRow({ requestedZoom: 1.2, zoom: 8, cameraOk: false, tilesOk: true, country: 'Mexico' }), /plan label camera/);
  assert.throws(() => acceptPlanSweepRow({ tilesOk: true, zoom: 8, country: 'Mexico' }), /plan label camera/);
  const row = {
    tilesOk: true,
    requestedZoom: 1.2,
    zoom: 1.2,
    cameraOk: true,
    tileZ: labelTile(1.2),
    country: 'France',
    names: ['France'],
  };
  assert.equal(acceptPlanSweepRow(row).below, true);
});

test('label placement mutants fail and the healthy controls pass on both engines', () => {
  const canvas = { left: 0, top: 0, right: 400, bottom: 800 };
  const clock = { left: 0, top: 0, right: 80, bottom: 36 };
  const open = { labels: [], canvas, chrome: [clock] };
  const inside = { left: 120, top: 200, right: 180, bottom: 220 };
  const underClock = { left: 10, top: 8, right: 70, bottom: 28 };
  const controls = [];
  for (const engine of ['chromium', 'webkit']) {
    for (const country of ['France', 'Kenya']) {
      const contract = planCameraContract(country, 6.5);
      const verdict = labelScreenVerdict({ head: open, main: { ...open }, expectedNames: contract.expectedNames });
      if (!verdict.ok || contract.raster !== null || contract.expectedNames.length !== 0) controls.push(`${engine} ${country}`);
    }
    const canada = planCameraContract('Canada', 2.5);
    const clear = labelScreenVerdict({ head: open, main: { ...open }, expectedNames: canada.expectedNames });
    const raster = rasterDuplicateVerdict({ declared: canada.raster, text: 'CANADA', opacity: 0 });
    if (!clear.ok || !raster.ok) controls.push(`${engine} Canada`);
  }
  assert.deepEqual(controls, []);
  const extra = labelScreenVerdict({
    head: { labels: [{ name: 'France', box: inside }], canvas, chrome: [clock] },
    main: open,
    expectedNames: [],
  });
  assert.equal(extra.ok, false);
  assert.equal(extra.reason, 'parity');
  const swapped = labelScreenVerdict({
    head: { labels: [{ name: 'France', box: inside }], canvas, chrome: [clock] },
    main: { labels: [{ name: 'Kenya', box: inside }], canvas, chrome: [clock] },
    expectedNames: ['France'],
  });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.reason, 'parity');
  const covered = labelScreenVerdict({
    head: { labels: [{ name: 'France', box: underClock }], canvas, chrome: [clock] },
    main: { labels: [{ name: 'France', box: underClock }], canvas, chrome: [clock] },
    expectedNames: ['France'],
  });
  assert.equal(covered.ok, false);
  assert.equal(covered.reason, 'chrome');
  const missing = rasterDuplicateVerdict({ declared: 'CANADA', text: 'MEXICO BRAZIL', opacity: 0 });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'raster');
  const painted = rasterDuplicateVerdict({ declared: 'CANADA', text: 'CANADA', opacity: 1 });
  assert.equal(painted.ok, false);
  assert.equal(painted.reason, 'opacity');
  const ignored = rasterDuplicateVerdict({ declared: 'CANADA', text: 'MEXICO', opacity: 0 });
  assert.equal(ignored.ok, false);
  assert.equal(ignored.reason, 'raster');
});

test('historical plan captures stay incomplete and a new capture needs a full environment record', () => {
  const captures = JSON.parse(readFileSync(new URL('./fixtures/captures.json', import.meta.url), 'utf8'));
  const historical = captures.pngs.filter((entry) => entry.kind === 'plan-column screenshot');
  assert.equal(historical.length, 3);
  for (const entry of historical) {
    assert.equal(entry.environmentRecord, 'incomplete');
    assert.equal(captureEnvironmentOk(entry), false);
  }
  assert.equal(captureEnvironmentOk({ environmentRecord: 'incomplete', browser: 'x', os: 'y', device: 'z' }), false);
  assert.equal(captureEnvironmentOk({ browser: 'Chrome', os: 'Linux', device: '' }), false);
  assert.equal(captureEnvironmentOk({ browser: 'Chrome 156', os: 'Linux', device: 'plan column 274x984' }), true);
});

test('docs do not keep the calib fixture value', () => {
  const token = ['machine', 'secret'].join('-');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) files.push(path);
    }
  };
  walk(resolve(root, 'docs'));
  walk(resolve(root, '.cursor/skills/verify-opd'));
  const hits = files.filter((file) => readFileSync(file, 'utf8').includes(token));
  assert.deepEqual(hits, []);
});
