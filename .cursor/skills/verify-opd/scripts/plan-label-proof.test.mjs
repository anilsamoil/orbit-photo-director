import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { PLAN_TILE_HELPERS } from './drive.mjs';

function loadHelpers() {
  const context = {
    performance,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    document: { querySelectorAll: () => [] },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  vm.createContext(context);
  vm.runInContext(`${PLAN_TILE_HELPERS}\nthis.planWaitTiles = planWaitTiles;\nthis.planSymbolNames = planSymbolNames;\nthis.planViewport = planViewport;\nthis.planLockRasterCamera = planLockRasterCamera;\nthis.planReleaseRasterCamera = planReleaseRasterCamera;\nthis.planCameraMatches = planCameraMatches;`, context);
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

function waitingMap({ idle, unloadAfterRepaint, idleAfterMs = 0, center = { lng: 2, lat: 46 } }) {
  let loaded = true;
  const zoom = center.lng === 37 ? 6.5 : 2;
  const z = Math.max(0, Math.round(zoom + 1));
  const n = 2 ** z;
  const x = Math.max(0, Math.min(n - 1, Math.floor(((center.lng + 180) / 360) * n)));
  const rad = center.lat * Math.PI / 180;
  const yRaw = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
  const y = Math.max(0, Math.min(n - 1, yRaw));
  const coord = { canonical: { z, x, y } };
  const manager = { getVisibleCoordinates: () => [coord], getTile: () => ({ state: loaded ? 'loaded' : 'loading' }) };
  let pending = null;
  let listeners = 0;
  return {
    getZoom: () => zoom,
    getCenter: () => center,
    areTilesLoaded: () => loaded,
    getCanvas: () => ({ clientWidth: 400, clientHeight: 300, getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }) }),
    getStyle: () => ({ sources: {}, layers: [] }),
    project: () => ({ x: 10, y: 10 }),
    style: { tileManagers: { 'inset-labels': manager, 'inset-basemap': manager } },
    listeners() { return listeners; },
    on(event, callback) {
      if (event !== 'idle') return;
      listeners += 1;
      if (!idle) return;
      pending = setTimeout(() => {
        pending = null;
        if (unloadAfterRepaint) loaded = false;
        callback();
      }, idleAfterMs);
    },
    off() {
      listeners = Math.max(0, listeners - 1);
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
    },
    triggerRepaint() {},
  };
}

function centerTile(z) {
  const n = 2 ** z;
  const lng = 2;
  const lat = 46;
  const x = Math.max(0, Math.min(n - 1, Math.floor(((lng + 180) / 360) * n)));
  const rad = lat * Math.PI / 180;
  const yRaw = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
  const y = Math.max(0, Math.min(n - 1, yRaw));
  return { canonical: { z, x, y } };
}

function cappedFranceMap(zoom) {
  const labelZ = Math.min(6, Math.max(0, Math.round(zoom + 1)));
  const baseZ = Math.min(20, Math.max(0, Math.round(zoom + 1)));
  const manager = (z) => ({
    getVisibleCoordinates: () => [centerTile(z)],
    getTile: () => ({ state: 'loaded' }),
  });
  return {
    getZoom: () => zoom,
    getCenter: () => ({ lng: 2, lat: 46 }),
    areTilesLoaded: () => true,
    getCanvas: () => ({
      clientWidth: 800,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    }),
    getStyle: () => ({
      sources: {
        'inset-labels': { tiles: ['https://tiles.example/labels/{z}/{y}/{x}'], tileSize: 256, maxzoom: 6 },
        'inset-basemap': { tiles: ['https://tiles.example/dark/{z}/{y}/{x}'], tileSize: 256, maxzoom: 20 },
      },
      layers: [],
    }),
    project: () => ({ x: 10, y: 10 }),
    getRenderWorldCopies: () => false,
    style: {
      tileManagers: {
        'inset-labels': manager(labelZ),
        'inset-basemap': manager(baseZ),
      },
    },
    on(event, callback) {
      if (event === 'idle') queueMicrotask(callback);
    },
    off() {},
    triggerRepaint() {},
  };
}

test('France at 5.49, 5.5, 6.5, and 8 counts each source at the tile it draws', async () => {
  const { planWaitTiles, planViewport } = loadHelpers();
  for (const zoom of [5.49, 5.5, 6.5, 8]) {
    const map = cappedFranceMap(zoom);
    const waited = await planWaitTiles(map);
    const labelZ = Math.min(6, Math.max(0, Math.round(zoom + 1)));
    const baseZ = Math.min(20, Math.max(0, Math.round(zoom + 1)));
    assert.equal(waited.tilesOk, true, `${zoom} ${JSON.stringify(waited.detail)}`);
    assert.equal(waited.tileZ, labelZ);
    assert.ok(waited.urls.some((url) => url.includes(`/labels/${labelZ}/`)), waited.urls.join(' '));
    assert.ok(waited.urls.some((url) => url.includes(`/dark/${baseZ}/`)), waited.urls.join(' '));
    assert.equal(waited.urls.some((url) => url.includes(`/labels/${Math.round(zoom + 1)}/`)), zoom <= 5.49);
    const scale = planViewport(map).scale;
    const drawn = (512 * (2 ** zoom)) / (256 * (2 ** labelZ));
    assert.ok(Math.abs(scale - drawn) < 1e-9, `${zoom} scale ${scale} expected ${drawn}`);
  }
});

test('a repaint that never goes idle is still a tile failure, and the listener is removed', async () => {
  const { planWaitTiles } = loadHelpers();
  const map = waitingMap({ idle: false });
  const timedOut = await planWaitTiles(map);
  assert.equal(timedOut.tilesOk, false);
  assert.equal(map.listeners(), 0);
  assert.match(PLAN_TILE_HELPERS, /PLAN_REPAINT_IDLE_MS = 1500/);
});

test('the raster lock covers one jump and the next jump reaches the requested camera', () => {
  const { planLockRasterCamera, planReleaseRasterCamera, planCameraMatches } = loadHelpers();
  let zoom = 1;
  let center = { lng: 0, lat: 0 };
  const map = {
    getZoom: () => zoom,
    getCenter: () => ({ ...center }),
    jumpTo(camera) {
      zoom = camera.zoom;
      center = { lng: camera.center[0], lat: camera.center[1] };
    },
  };
  planLockRasterCamera(map, { center: [-100, 50], zoom: 8 });
  map.jumpTo({ center: [2, 46], zoom: 1.2 });
  assert.equal(planCameraMatches(map, { center: [2, 46], zoom: 1.2 }).ok, false);
  assert.equal(map.getZoom(), 8);
  planReleaseRasterCamera(map);
  map.jumpTo({ center: [2, 46], zoom: 1.2 });
  assert.equal(planCameraMatches(map, { center: [2, 46], zoom: 1.2 }).ok, true);
  assert.equal(map.getZoom(), 1.2);
});

test('Kenya west settles inside the repaint idle limit and drops the listener', async () => {
  const { planWaitTiles } = loadHelpers();
  const map = waitingMap({ idle: true, idleAfterMs: 1000, center: { lng: 37, lat: 1 } });
  const started = Date.now();
  const waited = await planWaitTiles(map);
  const elapsed = Date.now() - started;
  assert.equal(waited.tilesOk, true, JSON.stringify(waited.detail));
  assert.ok(elapsed >= 900 && elapsed < 1500, elapsed);
  assert.equal(map.listeners(), 0);
  assert.ok(waited.repaintMs >= 900 && waited.repaintMs < 1500, waited.repaintMs);
});

test('a render settles the gate when raster tiles are loaded and another source never goes idle', async () => {
  const { planWaitTiles } = loadHelpers();
  const map = waitingMap({ idle: false });
  map.loaded = () => false;
  map.areTilesLoaded = () => false;
  map.isMoving = () => false;
  const renderListeners = [];
  const baseOn = map.on;
  map.on = (event, callback) => {
    if (event === 'render') {
      renderListeners.push(callback);
      return;
    }
    baseOn(event, callback);
  };
  map.triggerRepaint = () => {
    for (const callback of renderListeners.slice()) callback();
  };
  const started = Date.now();
  const waited = await planWaitTiles(map);
  assert.equal(waited.tilesOk, true, JSON.stringify(waited.detail));
  assert.ok(Date.now() - started < 800, Date.now() - started);
  assert.equal(map.listeners(), 0);
});

test('loaded() without a render or an idle is still a tile failure', async () => {
  const { planWaitTiles } = loadHelpers();
  const map = waitingMap({ idle: false });
  map.loaded = () => true;
  map.areTilesLoaded = () => true;
  map.isMoving = () => false;
  const waited = await planWaitTiles(map);
  assert.equal(waited.tilesOk, false);
  assert.equal(waited.detail.idle, false);
  assert.equal(map.listeners(), 0);
});

test('a map that is not loaded and never goes idle is still a tile failure', async () => {
  const { planWaitTiles } = loadHelpers();
  const map = waitingMap({ idle: false });
  map.loaded = () => false;
  map.isMoving = () => false;
  const waited = await planWaitTiles(map);
  assert.equal(waited.tilesOk, false);
  assert.equal(waited.detail.idle, false);
  assert.equal(map.listeners(), 0);
});

test('a loaded parent tile still in view holds the gate until it leaves', async () => {
  const { planWaitTiles } = loadHelpers();
  const map = waitingMap({ idle: true });
  const visible = map.style.tileManagers['inset-labels'].getVisibleCoordinates()[0];
  let present = true;
  const parent = {
    tileID: { canonical: { z: Math.max(0, visible.canonical.z - 1), x: 0, y: 0 }, key: 'parent' },
    state: 'loaded',
  };
  const center = { tileID: { canonical: visible.canonical, key: 'center' }, state: 'loaded' };
  for (const id of ['inset-labels', 'inset-basemap']) {
    map.style.tileManagers[id]._inViewTiles = {
      getAllTiles: () => (present ? [parent, center] : [center]),
    };
  }
  setTimeout(() => {
    present = false;
  }, 250);
  const started = Date.now();
  const waited = await planWaitTiles(map);
  assert.equal(waited.tilesOk, true, JSON.stringify(waited.detail));
  assert.ok(Date.now() - started >= 200, Date.now() - started);
  assert.equal(map.listeners(), 0);
});

test('a loading in-view raster tile omitted from the renderable list holds the gate', async () => {
  const { planWaitTiles } = loadHelpers();
  const map = waitingMap({ idle: true });
  const visible = map.style.tileManagers['inset-labels'].getVisibleCoordinates()[0];
  const hidden = {
    tileID: { canonical: { z: visible.canonical.z, x: visible.canonical.x + 1, y: visible.canonical.y }, key: 'hidden' },
    state: 'loading',
  };
  for (const id of ['inset-labels', 'inset-basemap']) {
    map.style.tileManagers[id]._inViewTiles = {
      getAllTiles: () => [
        hidden,
        { tileID: { canonical: visible.canonical, key: 'center' }, state: 'loaded' },
      ],
    };
  }
  setTimeout(() => {
    hidden.state = 'loaded';
  }, 250);
  const started = Date.now();
  const waited = await planWaitTiles(map);
  assert.equal(waited.tilesOk, true, JSON.stringify(waited.detail));
  assert.ok(Date.now() - started >= 200, Date.now() - started);
  assert.equal(map.listeners(), 0);
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
