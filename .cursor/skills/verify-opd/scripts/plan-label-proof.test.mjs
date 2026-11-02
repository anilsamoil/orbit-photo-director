import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { PLAN_TILE_HELPERS } from './drive.mjs';

function loadHelpers() {
  const context = {
    performance,
    setTimeout,
    clearTimeout,
    document: { querySelectorAll: () => [] },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  vm.createContext(context);
  vm.runInContext(`${PLAN_TILE_HELPERS}\nthis.planWaitTiles = planWaitTiles;\nthis.planSymbolNames = planSymbolNames;`, context);
  return context;
}

function loadedManager(zoom) {
  const z = Math.max(0, Math.round(zoom + 1));
  const n = 2 ** z;
  const lng = 2;
  const lat = 46;
  const x = Math.max(0, Math.min(n - 1, Math.floor(((lng + 180) / 360) * n)));
  const rad = lat * Math.PI / 180;
  const yRaw = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
  const y = Math.max(0, Math.min(n - 1, yRaw));
  const coord = { canonical: { z, x, y } };
  return {
    getVisibleCoordinates: () => [coord],
    getTile: () => ({ state: 'loaded' }),
  };
}

function waitingMap({ idle, unloadAfterRepaint }) {
  let loaded = true;
  const zoom = 2;
  const manager = loadedManager(zoom);
  return {
    getZoom: () => zoom,
    getCenter: () => ({ lng: 2, lat: 46 }),
    areTilesLoaded: () => loaded,
    getCanvas: () => ({ clientWidth: 400, clientHeight: 300, getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }) }),
    getStyle: () => ({ sources: {}, layers: [] }),
    project: () => ({ x: 10, y: 10 }),
    style: { tileManagers: { 'inset-labels': manager, 'inset-basemap': manager } },
    once(event, callback) {
      if (event === 'idle' && idle) {
        queueMicrotask(() => {
          if (unloadAfterRepaint) loaded = false;
          callback();
        });
      }
    },
    triggerRepaint() {},
  };
}

test('a 400ms repaint timeout is a tile failure', async () => {
  const { planWaitTiles } = loadHelpers();
  const timedOut = await planWaitTiles(waitingMap({ idle: false }));
  assert.equal(timedOut.tilesOk, false);
});

test('tiles are read again after the repaint idle', async () => {
  const { planWaitTiles } = loadHelpers();
  const dropped = await planWaitTiles(waitingMap({ idle: true, unloadAfterRepaint: true }));
  assert.equal(dropped.tilesOk, false);
  const held = await planWaitTiles(waitingMap({ idle: true, unloadAfterRepaint: false }));
  assert.equal(held.tilesOk, true);
});

test('plan symbol names ignore a transparent or mismatched label', () => {
  const { planSymbolNames } = loadHelpers();
  const france = (layer) => ({
    properties: { name: 'France' },
    geometry: { type: 'Point', coordinates: [2, 46] },
    layer,
  });
  const painted = {
    type: 'symbol',
    source: 'inset-countries',
    paint: { 'text-opacity': 1, 'text-color': '#f7f4ea' },
    layout: { 'text-field': ['get', 'name'] },
  };
  const map = {
    getZoom: () => 2,
    getCanvas: () => ({ clientWidth: 400, clientHeight: 300 }),
    getStyle: () => ({ layers: [{ id: 'inset-countries', type: 'symbol', source: 'inset-countries', paint: painted.paint }] }),
    project: () => ({ x: 20, y: 20 }),
    queryRenderedFeatures: () => [
      france(painted),
      france({ ...painted, paint: { 'text-opacity': 0, 'text-color': '#f7f4ea' }, layout: { 'text-field': ['get', 'name'] } }),
      france({ ...painted, paint: { 'text-opacity': 1, 'text-color': 'transparent' }, layout: { 'text-field': ['get', 'name'] } }),
      france({ ...painted, layout: { 'text-field': 'X' } }),
    ],
  };
  assert.deepEqual([...planSymbolNames(map)], ['France']);
});

test('MapLibre color and formatted text stay visible, hidden text stays out, and two Frances both count', () => {
  const { planSymbolNames } = loadHelpers();
  const color = { r: 0.97, g: 0.96, b: 0.92, a: 1 };
  const clear = { r: 0, g: 0, b: 0, a: 0 };
  const formatted = { sections: [{ text: 'France' }] };
  const france = (layer) => ({
    properties: { name: 'France' },
    geometry: { type: 'Point', coordinates: [2, 46] },
    layer,
  });
  const visible = {
    type: 'symbol',
    source: 'inset-countries',
    paint: { 'text-opacity': 1, 'text-color': color },
    layout: { 'text-field': formatted, visibility: 'visible' },
  };
  const map = {
    getZoom: () => 1.49,
    getCanvas: () => ({ clientWidth: 400, clientHeight: 300 }),
    getStyle: () => ({ layers: [{ id: 'inset-countries', type: 'symbol', source: 'inset-countries', paint: { 'text-opacity': 1, 'text-color': '#f7f4ea' } }] }),
    project: () => ({ x: 20, y: 20 }),
    queryRenderedFeatures: () => [
      france(visible),
      france(visible),
      france({ ...visible, layout: { ...visible.layout, visibility: 'none' } }),
      france({ ...visible, paint: { 'text-opacity': 1, 'text-color': clear } }),
    ],
  };
  const names = [...planSymbolNames(map)];
  assert.deepEqual(names, ['France', 'France']);
});
