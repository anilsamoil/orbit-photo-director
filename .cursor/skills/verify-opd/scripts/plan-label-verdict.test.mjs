import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDITED_RASTER_LEVELS, auditRasterLevels, countryStyleVerdict, countrySweepZooms,
  loadCountryRasterLevels, loadCountrySymbolLayers, oneNameSource, rasterPainted,
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
  for (const z of [-2, -1.1497862143712645, -0.23372503287116042, -0.51, -0.5, -0.49, 1.49, 1.5, 1.51, 2.49, 2.5, 2.51, 3.49, 3.5, 3.51, 4.49, 4.5, 4.51, 5]) {
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
