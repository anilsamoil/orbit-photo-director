import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { makeFixture, tilePNG } from './build.mjs';
import { BODY, BRIDGE_REQUESTS, CHECKS, TAB_STORAGE_KEY, TILE_COLORS, createProof, measureTiles, verifyEcho, verifyMove, verifyPixels, verifyRecovery, verifyRelaunch, verifyStress, withDeadline } from './probes.mjs';

test('fixture artifacts carry matching lengths and SHA-256 digests', () => {
  const { files } = makeFixture(['synthetic line 1', 'synthetic line 2']);
  const manifest = JSON.parse(files['/manifest.json']);
  assert.equal(Object.keys(manifest.artifacts).length, 6);
  for (const { path, bytes, sha256 } of Object.values(manifest.artifacts)) {
    assert.equal(Buffer.byteLength(files[`/${path}`]), bytes);
    assert.equal(createHash('sha256').update(files[`/${path}`]).digest('hex'), sha256);
  }
  assert.equal(JSON.parse(files['/v/g1/top5.json']).length, 1);
});

test('synthetic tile has PNG dimensions and green RGBA bytes', () => {
  const png = tilePNG();
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  const length = png.readUInt32BE(33);
  const rgba = inflateSync(png.subarray(41, 41 + length));
  assert.deepEqual([...rgba.subarray(1, 5)], [0, 255, 0, 255]);
});

test('native echoes require exact method, path and headers, absent GET and DELETE bodies and exact write bytes', () => {
  for (const request of BRIDGE_REQUESTS) {
    const { body } = request;
    assert.equal(verifyEcho(request, request).bytes, body?.length ?? 0);
    assert.throws(() => verifyEcho({ ...request, body: body ? body.slice(1) : [] }, request), /body changed/);
    assert.throws(() => verifyEcho({ ...request, body: null }, request), /body changed/);
    if (body) {
      const corrupt = body.slice();
      corrupt[Math.floor(corrupt.length / 2)] ^= 1;
      assert.throws(() => verifyEcho({ ...request, body: corrupt }, request), /body changed/);
    }
    assert.throws(() => verifyEcho({ ...request, method: 'PATCH' }, request), /method or path changed/);
    assert.throws(() => verifyEcho({ ...request, path: '/wrong' }, request), /method or path changed/);
    assert.throws(() => verifyEcho({ ...request, headers: { ...request.headers, unexpected: 'value' } }, request), /headers changed/);
  }
});

test('pixels distinguish the two fixture rasters and reject background-only frames', () => {
  const green = Uint8Array.from(Array(64).fill([...TILE_COLORS.map, 255]).flat());
  const orange = Uint8Array.from(Array(64).fill([...TILE_COLORS.iss, 255]).flat());
  const black = new Uint8Array(green.length);
  assert.equal(verifyPixels(green, black).positive, 64);
  assert.equal(verifyPixels(orange, black, 'iss').positive, 64);
  assert.throws(() => verifyPixels(black, black), /tile pixels/);
  assert.throws(() => verifyPixels(green, green), /tile pixels/);
  assert.throws(() => verifyPixels(green, black, 'iss'), /tile pixels/);
  assert.throws(() => verifyPixels(orange, black), /tile pixels/);
});

test('tile throughput consumes bytes and rejects corruption, cache aliases, and slow routes', async () => {
  const tileURL = (index) => `capacitor://localhost/__g1/tiles/${index}.png`;
  const delivered = [];
  const options = { expected: BODY, tileURL, tileRequests: async () => [...delivered], localURL: 'capacitor://localhost/', fetchTile: async (url) => { delivered.push(new URL(url).pathname); return new Response(BODY); }, now: (() => { let call = 0; return () => call++ * 1000; })() };
  assert.equal((await measureTiles(options)).tilesPerSecond, 100);
  await assert.rejects(measureTiles({ ...options, fetchTile: async () => new Response(null, { status: 404 }) }), /route failed/);
  await assert.rejects(measureTiles({ ...options, fetchTile: async () => new Response([1]) }), /bytes changed/);
  await assert.rejects(measureTiles({ ...options, tileURL: (index) => `capacitor://localhost/__g1/tiles/0.png?request=${index}` }), /unique/);
  await assert.rejects(measureTiles({ ...options, tileURL: (index) => `data:image/png;base64,${index}` }), /local native/);
  await assert.rejects(measureTiles({ ...options, tileRequests: async () => [] }), /witness every/);
  await assert.rejects(measureTiles({ ...options, tileRequests: async () => Array.from({ length: 100 }, (_, index) => new URL(tileURL(index)).pathname) }), /witness every/);
  await assert.rejects(measureTiles({ ...options, now: (() => { let call = 0; return () => call++ * 3000; })() }), /delivered/);
});

test('a stalled native operation produces a timeout instead of hanging the proof', async () => {
  await assert.rejects(withDeadline(() => new Promise(() => {}), 5, 'Proof frontend startup'), /Proof frontend startup timed out/);
});

function createProofHarness(t) {
  const fixture = makeFixture(['synthetic line 1', 'synthetic line 2']);
  const tile = Buffer.from(fixture.tile, 'base64');
  const location = new URL('capacitor://localhost/');
  const storage = new Map();
  let activeTab = 'map';
  let now = 0;
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 50 || delay === 200) {
      now += delay === 50 ? 50 : 10_000;
      queueMicrotask(callback);
      return;
    }
    return realSetTimeout(callback, delay, ...args);
  });
  function makeDocument() {
    const document = new EventTarget();
    document.querySelector = (selector) => selector.startsWith('[data-iss-preset=')
      ? { click() {}, getAttribute: () => 'true' } : { id: 'tab-' + activeTab };
    document.getElementById = (id) => ({
      id, classList: { contains: () => id === 'tab-' + activeTab }, click: () => { activeTab = id.slice(4); },
    });
    return document;
  }
  const contextEvent = (canvas, type, statusMessage = '') => {
    const event = Object.assign(new Event(type), { statusMessage });
    Object.defineProperty(event, 'target', { value: canvas });
    document.dispatchEvent(event);
  };

  class FakeWebGL2 {
    drawingBufferWidth = 8;
    drawingBufferHeight = 8;
    VERSION = 1;
    NO_ERROR = 0;
    isContextLost() { return false; }
    getError() { return this.NO_ERROR; }
    getParameter() { return 'Fake WebGL2'; }
  }
  function renderer(tab, layer, source) {
    let visible = true;
    let center = [0, 0];
    let zoom = 1;
    let blankNextFrame = false;
    let loseOnRepaint = false;
    const gl = new FakeWebGL2();
    const paint = new EventTarget();
    const sources = new Map([[source, { tiles: ['/__g1/' + tab + '.png'] }]]);
    const layers = new Set([layer]);
    gl.readPixels = (_x, _y, _w, _h, _format, _type, bytes) => {
      const pixel = visible && !blankNextFrame ? [...TILE_COLORS[tab], 255] : [0, 0, 0, 255];
      blankNextFrame = false;
      for (let offset = 0; offset < bytes.length; offset += 4) bytes.set(pixel, offset);
    };
    const canvas = {
      closest: (selectors) => selectors.includes(tab === 'map' ? '#map' : '#iss-host')
        ? { id: tab === 'map' ? 'map' : 'iss-host' } : null,
      getContext: () => gl,
      getBoundingClientRect: () => ({ width: 8, height: 8, right: 8, bottom: 8, left: 0, top: 0 }),
    };
    return {
      getCanvas: () => canvas,
      loaded: () => true, isSourceLoaded: () => true, getLayer: (id) => layers.has(id) ? { id } : undefined,
      getSource: (id) => sources.get(id), getStyle: () => ({ layers: [{ id: layer }] }),
      getLayoutProperty: () => visible ? 'visible' : 'none',
      setLayoutProperty: (_layer, _property, value) => { visible = value === 'visible'; },
      on: paint.addEventListener.bind(paint), off: paint.removeEventListener.bind(paint),
      blankNextFrame: () => { blankNextFrame = true; },
      loseOnRepaint: () => { loseOnRepaint = true; },
      triggerRepaint: () => {
        if (loseOnRepaint) {
          contextEvent(canvas, 'webglcontextlost', 'GPU disconnected');
          paint.dispatchEvent(new Event('webglcontextlost'));
        } else paint.dispatchEvent(new Event('render'));
      },
      jumpTo: (next) => { center = next.center; zoom = next.zoom; },
      getCenter: () => ({ lng: center[0], lat: center[1] }), getZoom: () => zoom,
      getBearing: () => 0, getPitch: () => 0, getRoll: () => 0, getVerticalFieldOfView: () => 36,
      addSource: (id, value) => sources.set(id, value), addLayer: ({ id }) => layers.add(id),
      removeLayer: (id) => layers.delete(id), removeSource: (id) => sources.delete(id),
      querySourceFeatures: (id) => [sources.get(id).data],
    };
  }
  const block = (blockedURI) => document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), {
    blockedURI, effectiveDirective: 'connect-src', disposition: 'enforce',
  }));
  const denied = async () => { throw Object.assign(new Error('Native ingress denied'), { code: 'G1_BRIDGE_DENIED' }); };
  const paths = [];
  const globals = {
    document: makeDocument(), location, innerWidth: 8, innerHeight: 8, isSecureContext: true, WebGL2RenderingContext: FakeWebGL2,
    window: { __opdMap: renderer('map', 'carto-dark-layer', 'carto-dark'), __opdIss: renderer('iss', 'iss-lit', 'iss-lit') },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    Capacitor: {
      nativePromise: denied,
      Plugins: {
        CapacitorHttp: { get: denied },
        HostProof: {
          digest: async ({ bytes }) => ({ digest: createHash('sha256').update(Buffer.from(bytes)).digest('hex') }),
          request: async (request) => {
            if (['GET', 'DELETE'].includes(request.method) && Object.hasOwn(request, 'body')) {
              throw new Error('Bodyless fixture route received a body');
            }
            return request;
          },
          tileRequests: async () => ({ paths: [...paths] }),
        },
      },
    },
    XMLHttpRequest: class {
      open(_method, url) { this.url = url; }
      send() { block(this.url); this.onerror(); }
    },
    WebSocket: class {
      constructor(url) { block(url); throw new DOMException('Blocked by CSP', 'SecurityError'); }
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  const geometryURL = new URL('./geometry.mjs', import.meta.url).href;
  const hook = registerHooks({
    load(url, context, nextLoad) {
      if (url !== geometryURL) return nextLoad(url, context);
      return { format: 'module', shortCircuit: true,
        source: 'export const measureGeometry = ({ track }) => ({ fixtureEpoch: track.tle_epoch });' };
    },
  });
  t.after(() => hook.deregister());

  const offline = {
    policy: "connect-src 'self'", serviceWorkerControlled: false,
    fixtureResponses: 6, deniedFetches: 0, blockedResources: 3,
  };
  const workers = [{ type: 'module', url: '/assets/maplibre-gl-worker-fixture.js' }];
  const makeProof = (renderersEnabled = true) => {
    globalThis.document = makeDocument();
    return createProof({
      fixture, offline, tile, workers, renderersEnabled,
      localTiles: { map: 1, iss: 1 },
      rawFetch: async (url) => {
        const request = new URL(url);
        if (request.protocol === 'https:') { block(url); throw new TypeError('Blocked by CSP'); }
        paths.push(request.pathname);
        now++;
        return new Response(tile);
      },
    });
  };
  return { fixture, offline, workers, makeProof, contextEvent };
}

test('GPU-free proof keeps native checks and relaunch available with no renderer', async (t) => {
  const { makeProof } = createProofHarness(t);
  const proof = makeProof(false);
  document.getElementById = () => assert.fail('A scoped proof attempted to open a renderer');
  for (const id of [1, 6, 7]) {
    const result = await proof.runCheck(id);
    assert.equal(result.status, 'pass', JSON.stringify(result.evidence));
  }
  const before = proof.prepareRelaunch();
  const relaunched = makeProof(false);
  const result = await relaunched.verifyRelaunch(before, {
    beforeLaunchId: 'first-launch', afterLaunchId: 'second-launch', appQuitObserved: true,
  });
  assert.equal(result.status, 'pass', JSON.stringify(result.evidence));
  assert.equal(result.evidence.after.token, before.token);
  for (const tab of ['map', 'iss']) {
    await assert.rejects(relaunched.capture(tab), /Renderers are disabled/);
  }
});

test('independent checks return the full report and the native-driven phases reach checks 8–10', async (t) => {
  const { fixture, offline, workers, makeProof } = createProofHarness(t);
  const proof = makeProof();
  const failedStartup = makeProof();
  failedStartup.fixtureReady = Promise.reject(new Error('Unable to import the frontend'));
  assert.match((await failedStartup.runCheck(2)).evidence.error, /Unable to import the frontend/);
  assert.equal((await failedStartup.runCheck(1)).status, 'pass');
  assert.equal((await failedStartup.runCheck(6)).status, 'pass');
  const manifest = JSON.parse(fixture.files['/manifest.json']);
  const fixtureEvidence = {
    version: manifest.version, generatedAt: manifest.generated_at,
    trackSHA256: manifest.artifacts.track.sha256, queueCard: 'Synthetic proof target',
  };
  proof.fixtureEvidence = fixtureEvidence;
  const initialResults = [];
  for (let id = 1; id <= 7; id++) {
    if (id === 4) window.__opdMap.blankNextFrame();
    initialResults.push(await proof.runCheck(id));
  }
  assert.deepEqual(proof.summary(), {
    fixtureSHA256: fixture.fixtureSHA256, fixture: fixtureEvidence,
    documentId: proof.documentId, localOrigin: 'capacitor://localhost', offline,
  });
  assert.deepEqual(initialResults.map(({ id }) => id), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(window.__opdMap.getSource('g1-worker'), undefined);
  assert.equal(window.__opdMap.getLayer('g1-worker'), undefined);
  workers[0].url = 'https://off-origin.invalid/assets/maplibre-gl-worker-fixture.js';
  assert.equal((await proof.runCheck(2)).status, 'fail');
  workers[0].url = '/assets/maplibre-gl-worker-fixture.js';
  workers[0].error = 'Worker script failed';
  const failedWorker = await proof.runCheck(2);
  assert.equal(failedWorker.status, 'fail');
  assert.match(failedWorker.evidence.stack, /Actual bundled MapLibre worker module did not start/);
  assert.equal(failedWorker.evidence.workers[0].error, 'Worker script failed');
  delete workers[0].error;

  // XCTest collects checks 8–10 separately after the first launch has returned.
  const beforeRelaunch = proof.prepareRelaunch();
  const relaunched = makeProof();
  const relaunch = await relaunched.verifyRelaunch(beforeRelaunch, {
    beforeLaunchId: 'first-launch', afterLaunchId: 'second-launch', appQuitObserved: true,
  });
  const beforeRecovery = await relaunched.select('iss');
  assert.equal(localStorage.getItem(TAB_STORAGE_KEY), 'tab-iss');
  const recovered = makeProof();
  const recovery = await recovered.verifyRecovery(beforeRecovery, { terminationCallbacks: 1, reloads: 1 });
  const stress = await recovered.stress(600_000);
  const results = [...initialResults, relaunch, recovery, stress];
  assert.deepEqual(results.map(({ id }) => id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const result of results) {
    assert.deepEqual(Object.keys(result).sort(), ['evidence', 'id', 'status']);
    assert.equal(result.status, 'pass', 'Check ' + result.id + ': ' + JSON.stringify(result.evidence));
    assert.ok(Object.keys(result.evidence).length > 0);
  }
  assert.equal(initialResults[4].evidence.geometry.fixtureEpoch, '2026-11-10T00:00:00Z');
  assert.equal(initialResults[6].evidence.witnessedPaths, 100);
  assert.deepEqual(stress.evidence.sessions.map(({ verifiedMoveTimesMs }) => verifiedMoveTimesMs),
    Array.from({ length: 2 }, () => Array.from({ length: 30 }, (_, i) => i * 10_000)));

  const lostProof = makeProof();
  window.__opdMap.loseOnRepaint();
  const lostFrame = await lostProof.runCheck(4);
  assert.equal(lostFrame.status, 'fail');
  assert.match(lostFrame.evidence.error, /webglcontextlost: GPU disconnected/);
  const lostRenderer = await lostProof.runCheck(3);
  assert.equal(lostRenderer.status, 'fail');
  assert.match(lostRenderer.evidence.error, /webglcontextlost: GPU disconnected/);
});

test('failed renderer checks retain creation events by canvas tab and document without published renderers', async (t) => {
  const { makeProof, contextEvent } = createProofHarness(t);
  const proof = makeProof();
  await proof.select('iss');
  const mapCanvas = window.__opdMap.getCanvas();
  const issCanvas = window.__opdIss.getCanvas();
  delete window.__opdMap;
  delete window.__opdIss;
  contextEvent(mapCanvas, 'webglcontextcreationerror', 'Map GPU unavailable');
  contextEvent(issCanvas, 'webglcontextcreationerror', 'ISS GPU unavailable');

  for (const [id, tab, statusMessage] of [
    [2, 'map', 'Map GPU unavailable'], [3, 'map', 'Map GPU unavailable'],
    [4, 'map', 'Map GPU unavailable'], [5, 'iss', 'ISS GPU unavailable'],
  ]) {
    const result = await proof.runCheck(id);
    assert.equal(result.status, 'fail');
    assert.match(result.evidence.error, new RegExp('Timed out waiting for ' + tab + ' renderer'));
    assert.deepEqual(result.evidence.webglContextEvents, [
      { documentId: proof.documentId, tab, type: 'webglcontextcreationerror', statusMessage, atMs: 0 },
    ]);
  }

  const reloaded = makeProof();
  assert.notEqual(reloaded.documentId, proof.documentId);
  const noContextEvent = await reloaded.runCheck(3);
  assert.equal(noContextEvent.status, 'fail');
  assert.equal(noContextEvent.evidence.webglContextEvents, undefined);
});

test('a generic worker query TypeError preserves context events and worker evidence after restoration', async (t) => {
  const { makeProof, workers, contextEvent } = createProofHarness(t);
  const proof = makeProof();
  const map = window.__opdMap;
  let firstQuery = true;
  map.querySourceFeatures = () => {
    if (firstQuery) {
      contextEvent(map.getCanvas(), 'webglcontextlost', 'GPU disconnected');
      firstQuery = false;
    }
    throw new TypeError('Cannot read properties of null');
  };
  const loss = { documentId: proof.documentId, tab: 'map', type: 'webglcontextlost', statusMessage: 'GPU disconnected', atMs: 0 };
  const failedQuery = await proof.runCheck(2);
  assert.equal(failedQuery.status, 'fail');
  assert.equal(failedQuery.evidence.error, 'TypeError: Cannot read properties of null');
  assert.deepEqual(failedQuery.evidence.workers, workers);
  assert.deepEqual(failedQuery.evidence.webglContextEvents, [loss]);

  contextEvent(map.getCanvas(), 'webglcontextrestored');
  assert.equal((await proof.runCheck(3)).status, 'pass');
  const afterRestore = await proof.runCheck(2);
  assert.equal(afterRestore.status, 'fail');
  assert.deepEqual(afterRestore.evidence.webglContextEvents, [loss, { ...loss, type: 'webglcontextrestored', statusMessage: '' }]);
  assert.deepEqual(failedQuery.evidence.webglContextEvents, [loss]);
});

test('stress reports a renderer failure', async () => {
  const original = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), { getElementById() { throw new Error('renderer failed'); } });
  try {
    const proof = createProof({});
    const result = await proof.stress(600_000);
    assert.equal(result.status, 'fail');
    assert.match(result.evidence.error, /renderer failed/);
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});

test('stress rejects a shortened or increased duration', async (t) => {
  const { makeProof } = createProofHarness(t);
  const proof = makeProof();
  for (const duration of [60_000, 599_999, 600_001]) {
    const result = await proof.stress(duration);
    assert.equal(result.status, 'fail');
    assert.match(result.evidence.error, /exactly 600000/);
  }
});

test('a page reload cannot stand in for app quit or native process termination', () => {
  const before = { documentId: 'before', tab: 'tab-iss', token: 'sentinel' };
  const after = { ...before, documentId: 'after' };
  assert.throws(() => verifyRelaunch(before, after, {}), /actual app quit/);
  assert.throws(() => verifyRecovery(before, after, {}), /native web process/);
  assert.throws(() => verifyRecovery(before, { ...after, tab: 'tab-map' }, { terminationCallbacks: 1, reloads: 1 }), /changed tab/);
  assert.equal(verifyRelaunch(before, after, { appQuitObserved: true, beforeLaunchId: 'a', afterLaunchId: 'b' }).after.token, 'sentinel');
});

test('rendered stress frames must match the requested pan and zoom', () => {
  const before = { lng: 0, lat: 0, zoom: 3 };
  const after = { lng: 12, lat: 15, zoom: 4 };
  assert.doesNotThrow(() => verifyMove(before, after, [12, 15], 4));
  assert.throws(() => verifyMove(before, before, [12, 15], 4), /requested camera/);
  assert.throws(() => verifyMove(before, { ...after, zoom: 3 }, [12, 15], 3), /requested camera/);
  assert.throws(() => verifyMove(before, { ...after, lng: 0, lat: 0 }, [0, 0], 4), /requested camera/);
  assert.equal(CHECKS.length, 10);
});

function stressSessions() {
  return ['map', 'iss'].map((tab) => ({
    tab, elapsedMs: 300_005, moves: 10, tileFrames: 10, minimumTilePixels: 60,
    verifiedMoveTimesMs: Array.from({ length: 10 }, (_, i) => (i + 1) * 30_000),
  }));
}

test('full stress accepts both five-minute timelines with regular verified tile moves', () => {
  const sessions = stressSessions();
  assert.equal(verifyStress(sessions, 600_000).actualDurationMs, 600_010);
  assert.throws(() => verifyStress([{ ...sessions[0], elapsedMs: 299_995 }, sessions[1]], 600_000), /requested duration/);
  assert.throws(() => verifyStress([{ ...sessions[0], tileFrames: 999 }, sessions[1]], 600_000), /bundled tiles/);
  assert.throws(() => verifyStress([sessions[0], { ...sessions[1], minimumTilePixels: 0 }], 600_000), /bundled tiles/);
});

test('stress rejects a long gap between verified moves on either renderer', () => {
  for (const index of [0, 1]) {
    const sessions = stressSessions();
    const stalled = sessions[index];
    stalled.verifiedMoveTimesMs[4] = 175_000;
    assert.throws(() => verifyStress(sessions, 600_000), new RegExp(stalled.tab + '.*gap'));

    const lateStart = stressSessions();
    lateStart[index].verifiedMoveTimesMs[0] = 35_000;
    assert.throws(() => verifyStress(lateStart, 600_000), new RegExp(stalled.tab + '.*gap'));
  }
});

test('stress rejects a renderer without a move in its final 30 seconds', () => {
  for (const index of [0, 1]) {
    const sessions = stressSessions();
    const stopped = sessions[index];
    stopped.verifiedMoveTimesMs = Array.from({ length: 10 }, (_, i) => i * 29_000);
    assert.throws(() => verifyStress(sessions, 600_000), new RegExp(stopped.tab + '.*final'));
  }
});
