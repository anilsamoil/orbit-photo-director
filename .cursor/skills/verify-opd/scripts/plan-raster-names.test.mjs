import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planRasterSymbolActive } from './drive.mjs';

const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8');

test('zoom range alone does not make a silent country layer an active name layer', () => {
  const australia = {
    id: 'inset-countries-hide-n0-5',
    type: 'symbol',
    filter: ['in', ['get', 'name'], ['literal', ['Australia']]],
    paint: { 'text-opacity': ['step', ['zoom'], 1, -0.5, 0] },
  };
  const viewport = {
    id: 'inset-countries-viewport',
    type: 'symbol',
    filter: ['in', ['get', 'name'], ['literal', []]],
    paint: { 'text-color': '#f7f4ea' },
  };
  const ended = {
    id: 'inset-countries',
    type: 'symbol',
    maxzoom: 3,
    filter: ['in', ['get', 'name'], ['literal', ['France']]],
    paint: { 'text-opacity': 1 },
  };
  const painting = {
    id: 'inset-countries',
    type: 'symbol',
    filter: ['in', ['get', 'name'], ['literal', ['France']]],
    paint: { 'text-opacity': 1 },
  };
  assert.equal(planRasterSymbolActive(australia, 3.1), false);
  assert.equal(planRasterSymbolActive(australia, 8), false);
  assert.equal(planRasterSymbolActive(viewport, 3.1), false);
  assert.equal(planRasterSymbolActive(viewport, 8), false);
  assert.equal(planRasterSymbolActive(ended, 3.1), false);
  assert.equal(planRasterSymbolActive(ended, 8), false);
  assert.equal(planRasterSymbolActive(painting, 3.1), true);
  assert.equal(planRasterSymbolActive(painting, 8), true);
  assert.match(source, /planRasterSymbolActive\(layer, zoom\)/);
  assert.match(source, /stacked\.length \|\| active\.length/);
});
