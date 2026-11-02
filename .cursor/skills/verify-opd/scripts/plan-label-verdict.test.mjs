import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDITED_RASTER_LEVELS, auditRasterLevels, countryStyleVerdict, countrySweepZooms,
  loadCountryRasterLevels, loadCountrySymbolLayers, oneNameSource, planLabelReaders, planLabelVerdict, rasterPainted,
} from './plan-label-verdict.mjs';

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
  const australia = shifted.find((layer) => layer.filter?.[2]?.[1]?.includes('Australia'));
  australia.paint['text-opacity'] = ['step', ['zoom'], 1, 0, 0];
  assert.equal(countryStyleVerdict(shifted).ok, false);
  for (const bad of [[0, 1, 2, 3, 4, 5, 6], [1, 2, 4, 5, 6], [1, 2, 3, 4, 6]]) {
    const levels = structuredClone(AUDITED_RASTER_LEVELS);
    levels.countries.Australia = bad;
    assert.equal(auditRasterLevels(levels).ok, false);
    assert.equal(countryStyleVerdict(baseline, levels).ok, false);
  }
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

test('the plan-inset docs name the level-6 clamp at zoom 5.5', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const iss = readFileSync(resolve(root, '.cursor/skills/verify-opd/features/iss.md'), 'utf8');
  const skill = readFileSync(resolve(root, '.cursor/skills/verify-opd/SKILL.md'), 'utf8');
  assert.equal(iss.includes('vector name layer below zoom 3'), false);
  assert.equal(skill.includes('From zoom 3 the reference raster is the only place-name layer'), false);
  assert.equal(iss.includes(', The fitted orbit'), false);
  assert.match(iss, /view zoom 5\.5/);
  assert.match(skill, /view zoom 5\.5/);
  assert.match(iss, /tile level 6/);
  assert.match(skill, /tile level 6/);
});
