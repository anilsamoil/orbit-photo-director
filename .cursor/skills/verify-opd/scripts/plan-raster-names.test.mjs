import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planRasterNameSamples, planRasterSymbolActive } from './drive.mjs';

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

test('the viewport filter is read again after each camera settles', async () => {
  const filters = [['Canada'], [], ['France']];
  let jumps = 0;
  const orbit = {
    stop() {},
    jumpTo() { jumps += 1; },
    getZoom() { return jumps === 1 ? 3.1 : 8; },
    once(event, callback) {
      if (event === 'idle') queueMicrotask(callback);
    },
    getStyle() {
      const names = filters[Math.min(jumps, filters.length - 1)];
      return {
        layers: [{
          id: 'inset-countries-viewport',
          type: 'symbol',
          filter: ['in', ['get', 'name'], ['literal', names]],
          paint: { 'text-opacity': 1 },
        }],
      };
    },
    queryRenderedFeatures() { return []; },
  };
  const result = await planRasterNameSamples(orbit);
  assert.equal(result.samples[0].active.includes('inset-countries-viewport'), false);
  assert.equal(result.samples[1].active.includes('inset-countries-viewport'), true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'vector');
  assert.match(source, /stacked\.length \|\| active\.length/);
});

function viewportOrbit({ delayMs, idle }) {
  const filters = [['Canada'], [], ['France']];
  let jumps = 0;
  let settled = 0;
  return {
    stop() {},
    jumpTo() { jumps += 1; },
    getZoom() { return jumps === 1 ? 3.1 : 8; },
    once(event, callback) {
      if (event !== 'idle' || !idle) return;
      setTimeout(() => {
        settled = jumps;
        callback();
      }, delayMs);
    },
    getStyle() {
      const names = filters[Math.min(settled, filters.length - 1)];
      return {
        layers: [{
          id: 'inset-countries-viewport',
          type: 'symbol',
          filter: ['in', ['get', 'name'], ['literal', names]],
          paint: { 'text-opacity': 1 },
        }],
      };
    },
    queryRenderedFeatures() { return []; },
  };
}

test('a filter that updates 1.8s after the move is not read as the stale Canada list', async () => {
  const result = await planRasterNameSamples(viewportOrbit({ delayMs: 1800, idle: true }));
  assert.equal(result.reason, 'vector');
  assert.equal(result.samples[0].active.includes('inset-countries-viewport'), false);
  assert.equal(result.samples[1].active.includes('inset-countries-viewport'), true);
  assert.match(source, /stacked\.length \|\| active\.length/);
});

test('no idle event is a timeout and does not read the stale filter', async () => {
  let reads = 0;
  const orbit = viewportOrbit({ delayMs: 0, idle: false });
  const read = orbit.getStyle;
  orbit.getStyle = () => {
    reads += 1;
    return read();
  };
  const result = await planRasterNameSamples(orbit);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(reads, 0);
  assert.match(source, /stacked\.length \|\| active\.length/);
});

test('a timeout removes the idle listener', async () => {
  const listeners = new Set();
  const orbit = {
    stop() {},
    jumpTo() {},
    getZoom() { return 3.1; },
    once(event, callback) {
      if (event === 'idle') listeners.add(callback);
    },
    off(event, callback) {
      if (event === 'idle') listeners.delete(callback);
    },
    getStyle() {
      throw new Error('style read after timeout');
    },
    queryRenderedFeatures() { return []; },
  };
  const result = await planRasterNameSamples(orbit);
  assert.equal(result.reason, 'timeout');
  assert.equal(listeners.size, 0);
  assert.match(source, /stacked\.length \|\| active\.length/);
});
