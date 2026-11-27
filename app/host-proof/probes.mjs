export const CHECKS = Object.freeze([
  'secure context and native digest', 'MapLibre worker and map chunk', 'WebGL2', 'Map local tile pixels',
  'ISS vertical-perspective local tile pixels and geometry', 'bridge request bodies', 'native tile throughput',
  'storage after app relaunch', 'web process recovery on same tab', 'pan and zoom stress and peak memory',
]);
export const BODY = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);
export const TILE_COUNT = 100;
export const FULL_STRESS_MS = 600_000;
export const TAB_STORAGE_KEY = 'opd-g1-tab';
const MAX_VERIFIED_MOVE_GAP_MS = 30_000;
export const TILE_COLORS = Object.freeze({ map: [0, 255, 0], iss: [196, 90, 40] });
const TILE_LAYERS = {
  map: { layer: 'carto-dark-layer', source: 'carto-dark' },
  iss: { layer: 'iss-lit', source: 'iss-lit' },
};
const storageKey = 'opd-g1-storage';
const bodySHA256 = 'c8f5d0341d54d951a71b136e6e2afcb14d11ed8489a7ae126a8fee0df6ecf193';
const requireValue = (condition, reason) => { if (!condition) throw new Error(reason); };
const bytesEqual = (actual, expected) => actual?.length === expected.length && expected.every((byte, index) => actual[index] === byte);
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const BRIDGE_REQUESTS = Object.freeze([
  { method: 'GET', path: '/manifest.json' },
  { method: 'DELETE', path: '/api/browser/profiles/g1-fixture/targets/g1-synthetic' },
  { method: 'POST', path: '/api/log', json: '{"target_id":"g1-synthetic","notes":"Limb—合","action":"shoot"}\n' },
  { method: 'PUT', path: '/api/browser/profiles/g1-fixture/targets', json: '{"targets":[{"id":"g1-synthetic","name":"Earth – 北","geom":{"type":"point","lat":28,"lon":-97}}]}\n' },
].map(({ method, path, json }) => ({
  method, path, headers: { accept: 'application/json', 'x-g1-fixture': 'g1', ...(json ? { 'content-type': 'application/json' } : {}) },
  ...(json ? { body: [...new TextEncoder().encode(json)] } : {}),
})));

export async function withDeadline(operation, milliseconds = 60_000, label = 'Proof operation') {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function waitFor(read, label, milliseconds = 20_000) {
  const start = performance.now();
  while (performance.now() - start < milliseconds) {
    const value = read();
    if (value) return value;
    await sleep(50);
  }
  throw new Error('Timed out waiting for ' + label);
}

export function verifyEcho(actual, expected) {
  const { method, path, headers, body } = expected;
  requireValue(actual?.method === method && actual.path === path, method + ' native method or path changed');
  requireValue(Object.keys(actual.headers ?? {}).length === Object.keys(headers).length
    && Object.entries(headers).every(([name, value]) => actual.headers[name] === value), method + ' native headers changed');
  const bodyAbsent = !Object.hasOwn(actual, 'body');
  requireValue(body ? bytesEqual(actual.body, body) : bodyAbsent, method + ' native body changed');
  return { method, path, headers, bodyAbsent, bytes: body?.length ?? 0,
    ...(body ? { receivedBodyHex: hex(actual.body) } : {}) };
}

export function isTilePixel(bytes, offset, tab) {
  return bytes[offset + 3] > 240
    && TILE_COLORS[tab].every((value, channel) => Math.abs(bytes[offset + channel] - value) <= 32);
}

function countTilePixels(bytes, tab) {
  let count = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    if (isTilePixel(bytes, offset, tab)) count++;
  }
  return count;
}

export function verifyPixels(tilePixels, backgroundPixels, tab = 'map') {
  const positive = countTilePixels(tilePixels, tab);
  const negative = countTilePixels(backgroundPixels, tab);
  requireValue(positive >= 8 && negative === 0, tab + ' tile pixels must be present and absent in the background control');
  return { positive, negative, pixelsSampled: tilePixels.length / 4 };
}

export function verifyRelaunch(before, after, native) {
  requireValue(native?.appQuitObserved === true && native.beforeLaunchId && native.afterLaunchId && native.beforeLaunchId !== native.afterLaunchId, 'Missing actual app quit and distinct launch identifiers');
  return { ...verifyStorage(before, after), ...native };
}

function verifyStorage(before, after) {
  requireValue(before.token === after.token && before.token && before.documentId && after.documentId && before.documentId !== after.documentId, 'Storage did not survive relaunch');
  return { before, after };
}

export function verifyRecovery(before, after, native) {
  requireValue(native?.terminationCallbacks === 1 && native.reloads >= 1, 'Missing native web process termination and reload');
  requireValue(before.tab === 'tab-iss' && before.tab === after.tab && before.documentId && after.documentId && before.documentId !== after.documentId, 'Recovery changed tab or retained document');
  return { before, after, ...native };
}

export function verifyStress(sessions, durationMs) {
  requireValue(durationMs === FULL_STRESS_MS, 'Stress requires exactly 600000 milliseconds');
  const halfMs = durationMs / 2;
  requireValue(sessions.length === 2 && ['map', 'iss'].every((tab) => sessions.some((item) =>
    item.tab === tab && Number.isFinite(item.elapsedMs) && item.elapsedMs >= halfMs
    && Number.isInteger(item.moves) && item.moves >= 2 && item.tileFrames === item.moves && item.minimumTilePixels >= 8)),
  'Stress needs rendered pan and zoom with bundled tiles on every move for the requested duration');
  for (const { tab, elapsedMs, tileFrames, verifiedMoveTimesMs } of sessions) {
    requireValue(Array.isArray(verifiedMoveTimesMs) && verifiedMoveTimesMs.length === tileFrames,
      tab + ' stress is missing verified frame timestamps');
    for (const [index, time] of verifiedMoveTimesMs.entries()) {
      const previous = verifiedMoveTimesMs[index - 1] ?? 0;
      requireValue(Number.isFinite(time) && time >= 0 && time <= elapsedMs && (index === 0 || time > previous),
        tab + ' stress has an invalid verified frame timestamp');
      requireValue(time - previous <= MAX_VERIFIED_MOVE_GAP_MS,
        tab + ' stress exceeded the verified move gap of ' + MAX_VERIFIED_MOVE_GAP_MS + ' ms');
    }
    requireValue(verifiedMoveTimesMs.some((time) => time >= halfMs - MAX_VERIFIED_MOVE_GAP_MS && time <= halfMs),
      tab + ' stress has no verified move in the final ' + MAX_VERIFIED_MOVE_GAP_MS + ' ms');
  }
  const actualDurationMs = sessions.reduce((sum, { elapsedMs }) => sum + elapsedMs, 0);
  return { sessions, requestedDurationMs: durationMs, actualDurationMs, maxVerifiedMoveGapMs: MAX_VERIFIED_MOVE_GAP_MS };
}

const longitudeError = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
export function appliedCamera(map) {
  const { lng, lat } = map.getCenter();
  return {
    lng, lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
    roll: map.getRoll(), verticalFovDeg: map.getVerticalFieldOfView(),
  };
}

function matchesMove(camera, center, zoom) {
  return longitudeError(camera.lng, center[0]) < 0.01 && Math.abs(camera.lat - center[1]) < 0.01
    && Math.abs(camera.zoom - zoom) < 0.001;
}

export function verifyMove(before, after, center, zoom) {
  if (matchesMove(after, center, zoom)
    && (longitudeError(before.lng, after.lng) > 0.001 || Math.abs(before.lat - after.lat) > 0.001)
    && Math.abs(before.zoom - after.zoom) > 0.001) return;
  throw Object.assign(new Error('Scripted pan and zoom did not reach the requested camera'), {
    evidence: { before, actual: after, requested: { center, zoom } },
  });
}

async function verifyOfflineEgress(rawFetch, includeNative = true) {
  const fetchURL = 'https://g1-fetch.invalid/offline-proof';
  const xhrURL = 'https://g1-xhr.invalid/offline-proof';
  const webSocketURL = 'wss://g1-websocket.invalid/offline-proof';
  const expectedHosts = [fetchURL, xhrURL, webSocketURL].map((url) => new URL(url).hostname);
  const blockedHosts = new Set();
  const observe = (event) => {
    if (event.effectiveDirective !== 'connect-src' || event.disposition !== 'enforce') return;
    const url = URL.parse(event.blockedURI);
    if (url && expectedHosts.includes(url.hostname)) blockedHosts.add(url.hostname);
  };
  const denied = {};
  document.addEventListener('securitypolicyviolation', observe);
  try {
    await withDeadline(async () => {
      try {
        await rawFetch(fetchURL);
      } catch (error) {
        if (error instanceof TypeError) denied.fetch = 'rejected';
        else throw error;
      }
      requireValue(denied.fetch, 'External fetch was allowed');
      denied.xhr = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.onerror = () => resolve('network error');
        request.onload = () => reject(new Error('External XMLHttpRequest was allowed'));
        request.open('GET', xhrURL);
        request.send();
      });
      denied.webSocket = await new Promise((resolve, reject) => {
        try {
          const socket = new WebSocket(webSocketURL);
          socket.onerror = () => resolve('network error');
          socket.onopen = () => {
            socket.close();
            reject(new Error('External WebSocket was allowed'));
          };
        } catch (error) {
          if (error?.name === 'SecurityError') resolve('security error');
          else reject(error);
        }
      });
      await waitFor(() => expectedHosts.every((host) => blockedHosts.has(host)), 'enforced connect-src violations', 4_000);
      denied.connectSrcBlockedHosts = [...blockedHosts].sort();
    }, 10_000);
  } catch (error) {
    throw Object.assign(error, { evidence: { egress: { ...denied, connectSrcBlockedHosts: [...blockedHosts].sort() } } });
  } finally {
    document.removeEventListener('securitypolicyviolation', observe);
  }
  if (!includeNative) return denied;
  const capacitor = globalThis.Capacitor;
  for (const [name, call] of [
    ['capacitorHttp', () => capacitor.Plugins.CapacitorHttp.get({ url: fetchURL })],
    ['capacitorHttpNativeClass', () => capacitor.nativePromise('CAPHttpPlugin', 'get', { url: fetchURL })],
  ]) {
    denied[name] = await Promise.resolve().then(call).then(
      () => 'allowed',
      (error) => error?.code ?? 'missing native rejection',
    );
    if (denied[name] !== 'G1_BRIDGE_DENIED') {
      throw Object.assign(new Error(name + ' did not receive native ingress denial'), { evidence: { egress: denied } });
    }
  }
  return denied;
}

export async function measureTiles({ fetchTile, tileURL, tileRequests, localURL, expected, now = () => performance.now(), count = TILE_COUNT }) {
  const urls = Array.from({ length: count }, (_, index) => new URL(tileURL(index)));
  const paths = urls.map((url) => url.pathname);
  requireValue(new Set(paths).size === count, 'Tile benchmark needs unique native routes');
  const local = new URL(localURL);
  requireValue(urls.every((url) => url.protocol === local.protocol && url.host === local.host
    && /^\/__g1\/tiles\/\d+\.png$/.test(url.pathname) && !url.search && !url.hash), 'Tile benchmark needs the local native tile route');
  const previous = await withDeadline(tileRequests);
  requireValue(Array.isArray(previous), 'Native tile witness is unavailable');
  const start = now();
  const controller = new AbortController();
  try {
    await withDeadline(() => Promise.all(urls.map(async (url) => {
      const response = await fetchTile(url.href, { cache: 'no-store', signal: controller.signal });
      requireValue(response.ok, 'Native tile route failed');
      requireValue(bytesEqual(new Uint8Array(await response.arrayBuffer()), expected), 'Native tile bytes changed');
    })), 10_000);
  } finally { controller.abort(); }
  const elapsedMs = now() - start;
  requireValue(elapsedMs > 0 && Number.isFinite(elapsedMs), 'Invalid tile duration');
  const tilesPerSecond = count * 1000 / elapsedMs;
  const received = await withDeadline(tileRequests);
  requireValue(Array.isArray(received), 'Native tile witness is unavailable');
  const observedPaths = paths.filter((path) => received.filter((item) => item === path).length
    > previous.filter((item) => item === path).length);
  requireValue(observedPaths.length === count, 'Native handler did not witness every tile response');
  const evidence = { count, elapsedMs, tilesPerSecond, bytesPerTile: expected.length, witnessedPaths: observedPaths.length, observedPaths,
    route: '/__g1/tiles/<index>.png', cache: 'no-store' };
  if (tilesPerSecond < 50) throw Object.assign(new Error('Tile route delivered fewer than 50 tiles per second'), { evidence });
  return evidence;
}

export function createProof({ rawFetch, tile, workers, localTiles, offline, fixture, renderersEnabled = true }) {
  const documentId = `${performance.timeOrigin}-${Math.random().toString(36).slice(2)}`;
  const rendererErrors = new WeakMap();
  const contextEventsByTab = { map: [], iss: [] };
  const recordContextEvent = (event) => {
    const canvas = event.target;
    const container = canvas?.closest?.('#map, #iss-host');
    if (!container) return;
    const tab = container.id === 'map' ? 'map' : 'iss';
    const { type, statusMessage = '' } = event;
    contextEventsByTab[tab].push({ documentId, tab, type, statusMessage, atMs: performance.now() });
    if (type === 'webglcontextrestored') {
      rendererErrors.delete(canvas);
    } else {
      const message = statusMessage ? `${type}: ${statusMessage}` : type;
      rendererErrors.set(canvas, message);
      console.error('[G1]', message);
    }
  };
  if (renderersEnabled) {
    for (const type of ['webglcontextcreationerror', 'webglcontextlost', 'webglcontextrestored']) {
      document.addEventListener(type, recordContextEvent, true);
    }
  }
  const check = async (id, operation, { timeoutMs, tabs = [] } = {}) => {
    try { return { id, status: 'pass', evidence: await withDeadline(operation, timeoutMs) }; }
    catch (error) {
      const stack = typeof error?.stack === 'string' ? error.stack : undefined;
      const evidence = { ...error?.evidence, error: String(error), ...(stack ? { stack } : {}) };
      const webglContextEvents = tabs.flatMap((tab) => contextEventsByTab[tab]).sort((a, b) => a.atMs - b.atMs);
      if (webglContextEvents.length) evidence.webglContextEvents = webglContextEvents;
      return { id, status: 'fail', evidence };
    }
  };
  const localOrigin = () => location.protocol + '//' + location.host;
  const state = () => ({
    documentId, tab: document.querySelector('.tabs .active')?.id ?? null, token: localStorage.getItem(storageKey),
    localOrigin: localOrigin(),
  });
  const selectRenderer = async (tab) => {
    requireValue(renderersEnabled, 'Renderers are disabled for this proof selection');
    await proof.fixtureReady;
    const button = document.getElementById('tab-' + tab);
    requireValue(button, 'Unknown proof tab ' + tab);
    if (!button.classList.contains('active')) button.click();
    return waitFor(() => {
      const renderer = tab === 'map' ? window.__opdMap : window.__opdIss;
      const canvas = renderer?.getCanvas();
      const rect = canvas?.getBoundingClientRect();
      if (state().tab !== button.id || !canvas) return null;
      const error = rendererErrors.get(canvas);
      if (error) throw new Error(tab + ' ' + error);
      return renderer.loaded() && rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight ? renderer : null;
    }, tab + ' renderer');
  };
  const webGL = (map) => {
    const canvas = map.getCanvas();
    const gl = canvas.getContext('webgl2');
    requireValue(gl instanceof WebGL2RenderingContext && !gl.isContextLost(),
      rendererErrors.get(canvas) ?? 'Actual map canvas has no active WebGL2 context');
    requireValue(gl.drawingBufferWidth >= 8 && gl.drawingBufferHeight >= 8, 'WebGL2 drawing buffer is smaller than the pixel sample');
    return gl;
  };
  const pixels = (map, wholeFrame = false, milliseconds = 10_000) => new Promise((resolve, reject) => {
    webGL(map);
    const cleanup = () => {
      clearTimeout(timeout);
      map.off('render', sample);
      map.off('webglcontextlost', lost);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Pixel probe render timeout'));
    }, milliseconds);
    const lost = () => {
      cleanup();
      reject(new Error(rendererErrors.get(map.getCanvas()) ?? 'WebGL context lost before the pixel sample'));
    };
    const sample = () => {
      cleanup();
      try {
        const gl = webGL(map);
        const width = wholeFrame ? gl.drawingBufferWidth : 8;
        const height = wholeFrame ? gl.drawingBufferHeight : 8;
        const x = Math.floor((gl.drawingBufferWidth - width) / 2);
        const y = Math.floor((gl.drawingBufferHeight - height) / 2);
        const bytes = new Uint8Array(width * height * 4);
        gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        const error = gl.getError();
        requireValue(error === gl.NO_ERROR, 'Pixel read failed with WebGL error ' + error);
        resolve({ bytes, width, height, camera: appliedCamera(map), capturedAtMs: performance.now() });
      } catch (error) { reject(error); }
    };
    map.on('render', sample);
    map.on('webglcontextlost', lost);
    try { map.triggerRepaint(); }
    catch (error) { cleanup(); reject(error); }
  });
  const preset = async (map, name) => {
    const button = document.querySelector(`[data-iss-preset="${name}"]`);
    requireValue(button, 'ISS aim control is absent');
    button.click();
    await waitFor(() => {
      const error = rendererErrors.get(map.getCanvas());
      if (error) throw new Error('ISS ' + error);
      return button.getAttribute('aria-pressed') === 'true' && map.getLayer('iss-lit') && map.isSourceLoaded('iss-lit');
    }, 'ISS ' + name + ' tiles');
  };
  const freshTileFrame = async (tab, map) => {
    const { source } = TILE_LAYERS[tab];
    const deadline = performance.now() + 20_000;
    let evidence = { source, sourceLoaded: false, localTileResponses: 0, tilePixels: 0 };
    while (performance.now() < deadline) {
      const frame = await pixels(map, false, Math.min(10_000, deadline - performance.now()));
      const sourceLoaded = Boolean(map.getSource(source)) && map.isSourceLoaded(source);
      const tilePixels = countTilePixels(frame.bytes, tab);
      evidence = { source, sourceLoaded, localTileResponses: localTiles[tab], tilePixels };
      if (sourceLoaded && evidence.localTileResponses > 0 && tilePixels >= 8) {
        return { ...frame, tilePixels };
      }
      await sleep(50);
    }
    throw Object.assign(new Error('Timed out waiting for ' + tab + ' bundled raster pixels'), { evidence });
  };
  const mapFixture = (map) => {
    const { layer, source } = TILE_LAYERS.map;
    const raster = map.getSource(source);
    requireValue(raster && map.getLayer(layer), 'Real Map raster layer is missing');
    if (!raster.tiles?.includes('/__g1/map.png')) {
      raster.setTiles(['/__g1/map.png']);
      map.setPaintProperty(layer, 'raster-fade-duration', 0);
    }
    const allLayers = map.getStyle().layers.map((item) => [item.id, map.getLayoutProperty(item.id, 'visibility')]);
    for (const [id] of allLayers) map.setLayoutProperty(id, 'visibility', id === layer ? 'visible' : 'none');
    return () => {
      for (const [id, visibility] of allLayers) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility ?? 'visible');
      }
    };
  };
  const tileProbe = async (tab, map) => {
    const { layer } = TILE_LAYERS[tab];
    const restore = tab === 'map' ? mapFixture(map) : () => {
      if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', 'visible');
    };
    try {
      const positive = await freshTileFrame(tab, map);
      map.setLayoutProperty(layer, 'visibility', 'none');
      const { bytes: negative } = await pixels(map);
      return { ...verifyPixels(positive.bytes, negative, tab), layer, localTileResponses: localTiles[tab] };
    } finally {
      restore();
    }
  };
  const proof = {
    fixtureSHA256: fixture?.fixtureSHA256, documentId, checks: CHECKS, heldCamera: null,
    guardMapCamera(vendor) {
      for (const method of ['setCenter', 'setBearing', 'easeTo']) {
        const write = vendor[method];
        vendor[method] = (value) => {
          if (proof.heldCamera !== 'map') write(value);
        };
      }
      return vendor;
    },
    prepareRelaunch() { localStorage.setItem(storageKey, hex(crypto.getRandomValues(new Uint8Array(24)))); return state(); },
    state,
    async select(tab) {
      await selectRenderer(tab);
      const selected = state();
      localStorage.setItem(TAB_STORAGE_KEY, selected.tab);
      return selected;
    },
    capture(tab) {
      return withDeadline(async () => {
        const map = await selectRenderer(tab);
        if (tab === 'map') mapFixture(map);
        else await preset(map, 'nadir');
        const frame = await freshTileFrame(tab, map);
        return { ...state(), tilePixels: frame.tilePixels };
      }, 45_000, tab + ' screenshot capture');
    },
    verifyRelaunch: (before, native) => check(8, () => verifyRelaunch(before, state(), native)),
    verifyRecovery: (before, native) => check(9, async () => {
      await proof.fixtureReady;
      const witness = verifyRecovery(before, state(), native);
      const map = await selectRenderer('iss');
      const egress = await verifyOfflineEgress(rawFetch);
      const tiles = await tileProbe('iss', map);
      return { ...witness, egress, tiles };
    }, { tabs: ['iss'] }),
    runCheck(id) {
      const definition = initialChecks[id];
      requireValue(Number.isInteger(id) && definition, 'Unknown initial proof check ' + id);
      return check(id, definition.run, definition);
    },
    summary() {
      return { fixtureSHA256: proof.fixtureSHA256, fixture: proof.fixtureEvidence ?? null, documentId, localOrigin: localOrigin(), offline: { ...offline } };
    },
    async stress(durationMs) {
      return check(10, async () => {
        requireValue(durationMs === FULL_STRESS_MS, 'Stress requires exactly 600000 milliseconds');
        const halfMs = durationMs / 2;
        const sessions = [];
        try {
          for (const tab of ['map', 'iss']) {
            const map = await selectRenderer(tab);
            if (tab === 'iss') await preset(map, 'nadir');
            const restore = tab === 'map' ? mapFixture(map) : undefined;
            const start = performance.now();
            const session = { tab, elapsedMs: 0, moves: 0, tileFrames: 0, minimumTilePixels: 64, verifiedMoveTimesMs: [] };
            sessions.push(session);
            proof.heldCamera = tab;
            try {
              map.jumpTo({ center: [0, 0], zoom: 2, pitch: 0 });
              while (performance.now() - start < halfMs) {
                const { moves } = session;
                const before = appliedCamera(map);
                const center = [Math.sin((moves + 1) / 23) * 150, Math.sin((moves + 1) / 31) * 45];
                const zoom = 3 + (moves % 20) / 10;
                map.jumpTo({ center, zoom, bearing: moves % 360 });
                const frame = await freshTileFrame(tab, map);
                verifyMove(before, frame.camera, center, zoom);
                session.verifiedMoveTimesMs.push(frame.capturedAtMs - start);
                session.minimumTilePixels = Math.min(session.minimumTilePixels, frame.tilePixels);
                session.moves++;
                session.tileFrames++;
                await sleep(200);
              }
            } finally {
              session.elapsedMs = performance.now() - start;
              proof.heldCamera = null;
              restore?.();
            }
          }
          return verifyStress(sessions, durationMs);
        } catch (error) {
          const actualDurationMs = sessions.reduce((sum, item) => sum + item.elapsedMs, 0);
          throw Object.assign(error, { evidence: { ...error.evidence, sessions, actualDurationMs } });
        }
      }, { timeoutMs: FULL_STRESS_MS + 60_000, tabs: ['map', 'iss'] });
    },
  };
  const native = () => {
    const plugin = globalThis.Capacitor?.Plugins?.HostProof;
    requireValue(plugin, 'Native HostProof plugin is unavailable');
    return plugin;
  };
  const webDigest = async () => {
    requireValue(isSecureContext && crypto.subtle, 'Local origin is not a secure context');
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', BODY)));
  };
  const initialChecks = {
    1: {
      timeoutMs: 15_000,
      async run() {
        const web = await webDigest();
        const { digest } = await native().digest({ bytes: [...BODY] });
        requireValue(web === digest, 'Native SHA-256 and WebCrypto differ');
        const egress = await verifyOfflineEgress(rawFetch);
        return { localOrigin: localOrigin(), isSecureContext, web, native: digest, bytes: BODY.length, egress };
      },
    },
    2: {
      tabs: ['map'],
      async run() {
        const id = 'g1-worker';
        let map;
        try {
          map = await selectRenderer('map');
          map.jumpTo({ center: [0, 0], zoom: 1 });
          map.addSource(id, { type: 'geojson', data: { type: 'Feature', properties: { proof: 'g1' }, geometry: { type: 'Point', coordinates: [0, 0] } } });
          map.addLayer({ id, type: 'circle', source: id });
          await waitFor(() => map.querySourceFeatures(id).some((item) => item.properties?.proof === 'g1'), 'MapLibre worker GeoJSON response');
          const local = new URL(location.href);
          requireValue(workers.some((item) => {
            const url = new URL(item.url, local);
            return item.type === 'module' && !item.error && url.protocol === local.protocol && url.host === local.host
              && /^\/assets\/maplibre-gl-worker-[^/]+\.js$/.test(url.pathname);
          }), 'Actual bundled MapLibre worker module did not start');
          return { workers: workers.map((worker) => ({ ...worker })), featureQuery: true, dynamicMapTabLoaded: true };
        } catch (error) {
          throw Object.assign(error, { evidence: { workers: workers.map((worker) => ({ ...worker })) } });
        } finally {
          if (map?.getLayer(id)) map.removeLayer(id);
          if (map?.getSource(id)) map.removeSource(id);
        }
      },
    },
    3: {
      tabs: ['map'],
      async run() {
        const gl = webGL(await selectRenderer('map'));
        const version = gl.getParameter(gl.VERSION);
        requireValue(typeof version === 'string' && version.length > 0, 'WebGL2 version is unavailable');
        return { version, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
      },
    },
    4: { tabs: ['map'], run: async () => tileProbe('map', await selectRenderer('map')) },
    5: {
      timeoutMs: 90_000,
      tabs: ['iss'],
      async run() {
        const map = await selectRenderer('iss');
        const { measureGeometry } = await import('./geometry.mjs');
        const track = JSON.parse(fixture.files['/v/g1/track.json']);
        const geometry = await measureGeometry({
          map, track, when: fixture.now, preset, pixels,
          tileFrame: () => freshTileFrame('iss', map),
          holdCamera: (hold) => { proof.heldCamera = hold ? 'iss' : null; },
        });
        return { ...await tileProbe('iss', map), geometry };
      },
    },
    6: {
      timeoutMs: 15_000,
      async run() {
        const plugin = native();
        const verbs = [];
        for (const request of BRIDGE_REQUESTS) {
          const echo = verifyEcho(await plugin.request(request), request);
          if (request.body === undefined) {
            const rejected = await plugin.request({ ...request, body: [0, 255] }).then(
              () => false, (error) => error?.message === 'Bodyless fixture route received a body',
            );
            requireValue(rejected, request.method + ' native receiver accepted a body');
            echo.unexpectedBodyRejected = true;
          }
          verbs.push(echo);
        }
        return { verbs };
      },
    },
    7: {
      timeoutMs: 20_000,
      run: () => measureTiles({
        fetchTile: rawFetch,
        tileURL: (index) => new URL(`/__g1/tiles/${index}.png`, location.href).href,
        tileRequests: async () => (await native().tileRequests()).paths,
        localURL: location.href, expected: tile,
      }),
    },
  };
  if (globalThis.location?.protocol === 'https:') {
    proof.safari = {
      runCheck(id) {
        if (id === 1) return check(1, async () => {
          const web = await webDigest();
          requireValue(web === bodySHA256, 'WebCrypto differs from the fixture SHA-256');
          const egress = await verifyOfflineEgress(rawFetch, false);
          return { localOrigin: localOrigin(), isSecureContext, web, expected: bodySHA256, bytes: BODY.length, egress };
        }, initialChecks[1]);
        requireValue([2, 3, 4, 5].includes(id), 'Safari fixture runs checks 1 through 5');
        return proof.runCheck(id);
      },
      verifyStorage: (before) => check(8, () => verifyStorage(before, state())),
    };
  }
  return proof;
}
