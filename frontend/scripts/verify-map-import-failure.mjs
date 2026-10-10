/** Production-build recovery checks. Every case uses a fresh browser context.
 * Run after `bun run build`: node scripts/verify-map-import-failure.mjs [--sizes]
 * OPD_VERIFY_PORT selects an explicitly preflighted port (default 42710).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { chromium, webkit, devices } = require('playwright');
const dist = join(root, 'dist');
const outDir = process.argv.includes('--out')
  ? resolve(process.argv[process.argv.indexOf('--out') + 1])
  : join(root, 'dist-map-import-evidence');
const port = Number(process.env.OPD_VERIFY_PORT ?? 42710);
if (!Number.isInteger(port) || port < 42700 || port > 42719) throw new Error('OPD_VERIFY_PORT must be in 42700–42719');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.geojson': 'application/geo+json', '.png': 'image/png' };
const shotKey = 'opd_shotlist_v1:anil';
const retryKey = 'opd-map-import-retry';
const urlKey = 'opd-map-import-url';
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** The build's standard source maps identify the composition root, not private minified Vite syntax. */
function buildAssets() {
  const assets = readdirSync(join(dist, 'assets'));
  const entries = assets.filter((name) => name.endsWith('.js.map')).filter((name) => {
    const sourceMap = JSON.parse(readFileSync(join(dist, 'assets', name), 'utf8'));
    return sourceMap.sources.some((source) => /(?:^|\/)src\/map\/index\.ts$/.test(source));
  });
  if (entries.length !== 1) throw new Error(`Expected one map composition-root source map; found ${entries.length}`);
  const shell = readFileSync(join(dist, 'index.html'), 'utf8').match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1];
  const vendor = assets.find((name) => /^maplibre-vendor-.*\.js$/.test(name));
  const css = assets.find((name) => /^maplibre-gl-.*\.css$/.test(name)) ?? assets.find((name) => /^maplibre-vendor-.*\.css$/.test(name));
  if (!shell || !vendor || !css) throw new Error('Missing shell, MapLibre vendor, or stylesheet build asset');
  return { entry: `/assets/${entries[0].slice(0, -4)}`, shell, vendor: `/assets/${vendor}`, css: `/assets/${css}` };
}

function snapshotFixture(auth = false) {
  const now = new Date().toISOString();
  const track = {
    iss_polynomial: { start: now, duration_seconds: 7200, lat_coeffs: [0, 0, 0, 0, 0.01, 0], lon_coeffs: [0, 0, 0, 0, 0.04, 0], polynomial_order: 5 },
    tle_epoch: now, tle_age_hours: 1, tle_freshness_factor: 1,
  };
  const bodies = { passes: '[]', top5: '[]', top_24h: '[]', targets: '[]', track: JSON.stringify(track), status: '{}' };
  const manifest = {
    version: '20261007T120000Z', generated_at: auth ? new Date(Date.now() - 200 * 60000).toISOString() : now,
    tle_epoch: now, cloud_composite_hour: now, target_data_version: 'v1', build_version: '2.0.0.0',
    freshness: { tle_hours: 1, cloud_hours: 0, ok: true },
    artifacts: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, {
      path: `v/X/${name}.json`, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body),
    }])),
  };
  return { manifest, bodies, saved: JSON.stringify({ manifest, top5: [], top_24h: [], track, status: null, savedAt: Date.now() - 30 * 60000 }) };
}

function preflightPort() {
  try {
    const output = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (output.trim()) throw new Error(`Port ${port} is already listening`);
  } catch (error) {
    if (error.status !== 1) throw error;
  }
}

async function openCase(surface, options = {}) {
  const fixture = snapshotFixture(options.auth);
  const control = { fault: options.fault ?? '404', target: options.target ?? assets.entry, graph: 'ok', css: 'ok', auth: Boolean(options.auth), probeDelay: options.probeDelay ?? 0, discoveryDelay: 0 };
  const hits = { documents: [], requests: [], scripts: [], responses: [] };
  const sockets = new Set();
  const pendingTimers = new Set();
  const later = (callback, ms) => {
    const timer = setTimeout(() => { pendingTimers.delete(timer); callback(); }, ms);
    pendingTimers.add(timer);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const isScript = req.headers['sec-fetch-dest'] === 'script';
    hits.requests.push({ path, search: url.search, destination: req.headers['sec-fetch-dest'], at: Date.now() });
    const reply = (status, body, type = 'text/plain') => {
      if (res.destroyed) return;
      hits.responses.push({ path, search: url.search, destination: req.headers['sec-fetch-dest'], status, at: Date.now() });
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const staticReply = () => {
      try {
        const file = path === '/' ? '/index.html' : path;
        reply(200, readFileSync(join(dist, file)), types[extname(file)] ?? 'application/octet-stream');
      } catch { reply(404, 'missing'); }
    };
    if (path === '/api/browser/session') return reply(200, JSON.stringify({ ok: true, profile: { name: 'anil', displayName: 'Anil' } }), 'application/json');
    if (path === '/api/browser/profiles/anil/targets') return reply(200, '{"targets":[],"removedCuratedIds":[]}', 'application/json');
    if (path === '/manifest.json') return reply(200, JSON.stringify(fixture.manifest), 'application/json');
    if (path === '/api/app' && control.auth) return later(() => {
      res.writeHead(302, { location: '/auth' }); res.end();
    }, 600);
    if (path === '/auth') return reply(200, '<!doctype html><title>Sign in</title>', 'text/html');
    if (path === '/api/log') return reply(200, '{"entries":[]}', 'application/json');
    if (path === '/api/kp') return reply(200, '[]', 'application/json');
    if (path === '/launch/latest.json') return reply(200, 'null', 'application/json');
    if (path.startsWith('/v/X/')) {
      const name = path.split('/').at(-1).replace('.json', '');
      if (fixture.bodies[name]) return reply(200, fixture.bodies[name], 'application/json');
    }
    if (path === '/registerSW.js' || path === '/sw.js') return reply(200, '/* isolated network-fault verifier */', 'text/javascript');
    if ((path === assets.shell || path.endsWith('/map-import-manifest.json')) && !isScript) {
      if (control.graph === 'timeout') return;
      if (control.graph !== 'ok') return reply(Number(control.graph), 'graph unavailable');
      if (control.discoveryDelay) return later(staticReply, control.discoveryDelay);
    }
    if (/\/maplibre[^/]*\.css$/.test(path)) {
      if (control.css === 'timeout') return;
      if (control.css === 'delay') return later(staticReply, 1000);
      if (control.css !== 'ok') return reply(Number(control.css), 'stylesheet unavailable');
    }
    if (path === control.target && control.fault !== 'ok') {
      const respond = () => {
        if (control.fault === 'abort') return req.socket.destroy();
        reply(control.fault === '500' ? 500 : 404, 'missing');
      };
      if (url.searchParams.has('map-probe') && control.probeDelay) return later(respond, control.probeDelay);
      if (control.fault === 'delayed404' && !url.searchParams.has('map-probe')) return later(respond, 1200);
      if (control.fault === 'probe-timeout' && url.searchParams.has('map-probe')) return;
      if (control.fault === 'probe-timeout') return req.socket.destroy();
      return respond();
    }
    staticReply();
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  preflightPort();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  let context;
  const close = async () => {
    if (context) await context.close();
    pendingTimers.forEach(clearTimeout);
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
  };
  try {
    context = await surface.browser.newContext({ ...surface.options, serviceWorkers: 'block' });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === port) return route.continue();
      if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
      if (route.request().resourceType() === 'image' || /\/(?:tile|tiles)\//.test(url.pathname) || /\.(?:png|jpg|jpeg)$/.test(url.pathname)) {
        return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await context.addInitScript(({ saved, seedShot, disableClear }) => {
      if (!localStorage.getItem('verify-map-seeded')) {
        localStorage.setItem('opd-snapshot', saved);
        localStorage.setItem('verify-map-seeded', '1');
        if (seedShot) {
          const at = new Date(Date.now() + 3600000).toISOString();
          localStorage.setItem('opd_shotlist_v1:anil', JSON.stringify([{ key: `verify|${at}`, target_id: 'verify', target_name: 'Verifier selected pass', closest_approach: at }]));
        }
      }
      window.__verifyUnhandled = [];
      window.__verifyCleanup = [];
      addEventListener('unhandledrejection', (event) => window.__verifyUnhandled.push(String(event.reason)));
      const remove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        if (this === sessionStorage && ['opd-map-import-retry', 'opd-map-import-url'].includes(key)) {
          const map = window.__opdMap;
          window.__verifyCleanup.push({ key, canvas: document.querySelectorAll('#map canvas').length, api: Boolean(map && typeof map.getLayer === 'function'), marker: Boolean(document.querySelector('#map .iss-marker')) });
        }
        return remove.call(this, key);
      };
      if (disableClear) addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = 'body.shotlist-bar-visible .shotlist-clear { pointer-events: none !important; }';
        document.head.appendChild(style);
      });
    }, { saved: fixture.saved, seedShot: options.seedShot ?? true, disableClear: process.argv.includes('--mutant-disable-real-clear') });
    const page = await context.newPage();
    const errors = [];
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error' && consoleErrors.length < 200) consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) hits.documents.push(request.url());
      if (request.resourceType() === 'script') hits.scripts.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${port}/?u=anil&e2e&review=keep`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return { page, context, close, control, hits, errors, consoleErrors };
  } catch (error) { await close(); throw error; }
}

async function state(page) {
  return page.evaluate(({ shotKey, retryKey, urlKey }) => {
    const map = window.__opdMap;
    const rectangle = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'bottom', 'left', 'right'].map((key) => [key, box[key]]));
    };
    const control = (selector) => {
      const element = document.querySelector(selector);
      const box = rectangle(element);
      const node = box && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { box, ownsCenter: Boolean(element && node && (node === element || element.contains(node))), text: element?.textContent.trim() ?? '', tabIndex: element?.tabIndex ?? -1 };
    };
    const marker = document.querySelector('#map .iss-marker');
    const mapBox = rectangle(document.getElementById('map'));
    const markerBox = rectangle(marker);
    const cssRules = [...document.styleSheets].filter((sheet) => /maplibre/.test(sheet.href ?? '')).reduce((total, sheet) => {
      try { return total + sheet.cssRules.length; } catch { return total; }
    }, 0);
    const bar = document.getElementById('shotlist-bar');
    return {
      href: location.href, view: document.getElementById('view')?.className ?? '',
      banner: document.getElementById('status-banner')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
      retry: control('#status-banner button'), add: control('#shotlist-bar .shotlist-add'), clear: control('#shotlist-bar .shotlist-clear'),
      storedUrl: sessionStorage.getItem(urlKey), retryFlag: sessionStorage.getItem(retryKey),
      shotlist: JSON.parse(localStorage.getItem(shotKey) ?? '[]'), barHidden: !bar || bar.hidden,
      canvas: document.querySelectorAll('#map canvas').length,
      api: Boolean(map && typeof map.getLayer === 'function' && typeof map.getSource === 'function'),
      track: Boolean(map?.getLayer?.('iss-track-layer') && map?.getSource?.('iss-track')),
      overlays: Boolean(map?.getLayer?.('terminator-line-layer') && map?.getLayer?.('targets-layer')),
      cssRules, markerBox, markerPosition: marker ? getComputedStyle(marker).position : '',
      markerInside: Boolean(mapBox && markerBox && markerBox.width > 0 && markerBox.x + markerBox.width / 2 >= mapBox.left && markerBox.x + markerBox.width / 2 <= mapBox.right && markerBox.y + markerBox.height / 2 >= mapBox.top && markerBox.y + markerBox.height / 2 <= mapBox.bottom),
      viewport: { width: innerWidth, height: innerHeight },
      cleanup: window.__verifyCleanup, unhandled: window.__verifyUnhandled,
      modulePreloads: [...document.querySelectorAll('link[rel="modulepreload"]')].map((link) => link.href),
      resourceTimings: performance.getEntriesByType('resource').filter((entry) => /\/assets\/.*\.js/.test(entry.name)).map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType, responseStatus: entry.responseStatus })),
    };
  }, { shotKey, retryKey, urlKey });
}

function healthy(value) {
  return value.canvas === 1 && value.api && value.track && value.overlays && value.cssRules === 124
    && value.markerInside && value.markerPosition === 'absolute'
    && !value.banner.includes("Map couldn't load") && value.retry.text !== 'Retry'
    && value.retryFlag === null && value.storedUrl === null
    && !/[?&]map-(?:chunk|retry)=/.test(value.href)
    && value.href.includes('u=anil') && value.href.includes('e2e') && value.href.includes('review=keep')
    && value.cleanup.every((item) => item.canvas > 0 && item.api && item.marker);
}

async function waitForError(page) {
  await page.waitForFunction(() => document.getElementById('status-banner')?.textContent.includes("Map couldn't load"), null, { timeout: 16000 });
}

async function waitForHealthy(page) {
  const until = Date.now() + 20000;
  let value;
  do {
    value = await state(page).catch(() => null);
    if (value && healthy(value)) return value;
    await wait(100);
  } while (Date.now() < until);
  return value;
}

async function clickCenter(page, selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`No visible center for ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function tabReachesRetry(page) {
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
  for (let i = 0; i < 40; i += 1) {
    if (await page.evaluate(() => document.activeElement?.textContent.trim() === 'Retry')) return true;
    await page.keyboard.press('Tab');
  }
  return false;
}

async function failureControls(opened) {
  const before = await state(opened.page);
  const tabbable = await tabReachesRetry(opened.page);
  const retryBox = before.retry.box;
  const centers = before.retry.ownsCenter && before.add.ownsCenter && before.clear.ownsCenter;
  // A future footer-slot owner may offer a shorter fixed rectangle than the action needs.
  const oldStyle = await opened.page.locator('#status-banner').getAttribute('style');
  await opened.page.locator('#status-banner').evaluate((banner) => {
    Object.assign(banner.style, { top: `${innerHeight - 24}px`, left: '20px', width: '160px', height: '16px' });
  });
  const constrained = await state(opened.page);
  const footerSlotOwnsCenters = constrained.retry.ownsCenter && constrained.add.ownsCenter && constrained.clear.ownsCenter;
  await opened.page.locator('#status-banner').evaluate((banner, old) => {
    if (old === null) banner.removeAttribute('style'); else banner.setAttribute('style', old);
  }, oldStyle);
  await opened.page.screenshot({ path: join(outDir, `controls-${before.viewport.width}x${before.viewport.height}.png`), fullPage: true });
  const onScreen = retryBox && retryBox.top >= 0 && retryBox.bottom <= before.viewport.height + 1;
  await clickCenter(opened.page, '#shotlist-bar .shotlist-clear');
  await wait(100);
  const cleared = await state(opened.page);
  const clearWorks = before.shotlist.length === 1 && cleared.shotlist.length === 0 && cleared.barHidden;
  return { before, centers, footerSlotOwnsCenters, constrained, onScreen, tappable: Boolean(retryBox && retryBox.width >= 44 && retryBox.height >= 44), tabbable, clearWorks };
}

async function capture(opened, label) {
  const shot = join(outDir, `${label}.png`);
  await opened.page.screenshot({ path: shot, fullPage: true });
  return { state: await state(opened.page), hits: opened.hits, errors: opened.errors, consoleErrors: opened.consoleErrors, shot };
}

async function runFailure(surface, fault = '404') {
  const opened = await openCase(surface, { fault });
  try {
    await waitForError(opened.page);
    const controls = await failureControls(opened);
    const documents = opened.hits.documents.length;
    await wait(10000);
    const afterHold = await state(opened.page);
    const held = opened.hits.documents.length === documents && afterHold.banner.includes("Map couldn't load") && !afterHold.banner.includes('Last updated');
    await opened.page.click('#tab-queue');
    const queue = await state(opened.page);
    await opened.page.click('#tab-iss');
    const iss = await state(opened.page);
    await opened.page.click('#tab-map');
    await waitForError(opened.page);
    const evidence = await capture(opened, `${surface.slug}-${fault}`);
    const productPass = controls.centers && controls.footerSlotOwnsCenters && controls.onScreen && controls.tappable && controls.clearWorks && held
      && documents === (fault === '404' ? 2 : 1)
      && (fault !== '404' || controls.before.retryFlag === '1')
      && controls.before.storedUrl?.includes(assets.entry)
      && !queue.banner.includes("Map couldn't load") && !iss.banner.includes("Map couldn't load");
    return { label: `${surface.slug}-${fault}`, pass: productPass && controls.tabbable, productPass, platformFailure: !controls.tabbable && surface.browser.browserType().name() === 'webkit' ? 'Mac WebKit Tab-chain (compare control)' : null, controls, held, afterHold, ...evidence };
  } finally { await opened.close(); }
}

async function runRecovery(surface, targetName, fault) {
  const target = assets[targetName];
  const opened = await openCase(surface, { target, fault, seedShot: false });
  try {
    await waitForError(opened.page);
    if (fault === '404' || fault === 'delayed404') {
      try {
        await opened.page.waitForURL(/[?&]map-chunk=1(?:&|$)/, { timeout: 12000 });
        await waitForError(opened.page);
      } catch (error) {
        return { label: `${surface.slug}-${targetName}-${fault}-retry`, pass: false, phase: 'initial-404-classification', error: String(error), ...await capture(opened, `${surface.slug}-${targetName}-${fault}-classification`) };
      }
    }
    const failed = await state(opened.page);
    const before = { documents: opened.hits.documents.length, targetRequests: opened.hits.requests.filter((hit) => hit.path === target).length };
    opened.control.fault = 'ok';
    await clickCenter(opened.page, '#status-banner button');
    const recovered = await waitForHealthy(opened.page);
    const targetRequests = opened.hits.requests.filter((hit) => hit.path === target);
    const freshDependency = targetRequests.length > before.targetRequests
      && targetRequests.slice(before.targetRequests).some((hit) => /map-retry=/.test(hit.search))
      && opened.hits.responses.some((hit) => hit.path === target && hit.status === 200 && /map-retry=/.test(hit.search));
    const evidence = await capture(opened, `${surface.slug}-${targetName}-${fault}-retry`);
    const pass = healthy(recovered) && freshDependency
      && before.documents === (fault === '404' || fault === 'delayed404' ? 2 : 1)
      && opened.hits.documents.length === before.documents + 1
      && failed.storedUrl?.includes(assets.entry) && !failed.storedUrl?.includes('maplibre-vendor');
    return { label: `${surface.slug}-${targetName}-${fault}-retry`, pass, failed, before, freshDependency, ...evidence };
  } finally { await opened.close(); }
}

async function runViewPreserve(surface, view) {
  const opened = await openCase(surface, { fault: 'delayed404', seedShot: false });
  try {
    await opened.page.click(`#tab-${view}`);
    await wait(3500);
    const evidence = await capture(opened, `${surface.slug}-delayed404-${view}`);
    const value = evidence.state;
    const terminalFailures = opened.hits.responses.filter((response) => response.path === assets.entry && response.status === 404);
    const diagnosticsSettled = terminalFailures.length > 0 && terminalFailures.every((response) => Date.now() - response.at >= 2000);
    const pass = diagnosticsSettled && value.view === `view-${view}` && opened.hits.documents.length === 1
      && value.retryFlag === null && value.storedUrl === null
      && !/[?&]map-(?:chunk|retry)=/.test(value.href) && !value.banner.includes("Map couldn't load");
    return { label: `${surface.slug}-delayed404-${view}`, pass, diagnosticsSettled, terminalFailures, ...evidence };
  } finally { await opened.close(); }
}

async function runAuthMid(surface) {
  const opened = await openCase(surface, { auth: true, probeDelay: 1700, seedShot: false });
  try {
    await opened.page.waitForFunction(() => document.getElementById('status-banner')?.textContent.includes('SIGN IN AGAIN'), null, { timeout: 10000 });
    const authSeen = Date.now();
    await wait(3500);
    const evidence = await capture(opened, `${surface.slug}-auth-mid`);
    const completedProbes = opened.hits.responses.filter((response) => response.path === assets.entry && response.search.includes('map-probe=') && response.status === 404);
    const authDuringProbe = completedProbes.some((response) => response.at >= authSeen);
    const pass = authDuringProbe && evidence.state.banner.includes('SIGN IN AGAIN') && opened.hits.documents.length === 1
      && evidence.state.retryFlag === null && !/[?&]map-(?:chunk|retry)=/.test(evidence.state.href);
    return { label: `${surface.slug}-auth-mid`, pass, authSeen, authDuringProbe, completedProbes, ...evidence };
  } finally { await opened.close(); }
}

async function runRetryRace(surface) {
  const opened = await openCase(surface, { fault: 'abort', seedShot: false });
  try {
    await waitForError(opened.page);
    opened.control.fault = 'ok';
    opened.control.discoveryDelay = 1400;
    const documents = opened.hits.documents.length;
    // Both real controls fire before the asynchronous discovery microtask resumes.
    await opened.page.evaluate(() => {
      document.querySelector('#status-banner button')?.click();
      document.getElementById('tab-queue')?.click();
    });
    await wait(3500);
    const evidence = await capture(opened, `${surface.slug}-retry-later-queue`);
    const pass = evidence.state.view === 'view-queue' && opened.hits.documents.length === documents
      && !/[?&]map-retry=/.test(evidence.state.href) && evidence.state.retryFlag === null;
    return { label: `${surface.slug}-retry-later-queue`, pass, ...evidence };
  } finally { await opened.close(); }
}

async function geometry(page) {
  const box = await page.locator('#map canvas').boundingBox();
  if (!box) throw new Error('No rendered map for geometry comparison');
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.55, { button: 'right' });
  await page.locator('.maplibregl-popup-content').waitFor({ timeout: 5000 });
  const measured = await page.evaluate(() => {
    const measure = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { width: box.width, height: box.height, position: style.position, fontSize: style.fontSize, padding: style.padding };
    };
    return { marker: measure('#map .iss-marker'), popup: measure('.maplibregl-popup-content') };
  });
  await page.locator('.maplibregl-popup-close-button').click();
  return measured;
}

function sameGeometry(actual, expected) {
  return ['marker', 'popup'].every((key) => actual?.[key] && expected?.[key]
    && Math.abs(actual[key].width - expected[key].width) <= 1
    && Math.abs(actual[key].height - expected[key].height) <= 1
    && actual[key].position === expected[key].position
    && actual[key].fontSize === expected[key].fontSize
    && actual[key].padding === expected[key].padding);
}

async function runHealthy(surface) {
  const opened = await openCase(surface, { fault: 'ok', seedShot: false });
  try {
    const value = await waitForHealthy(opened.page);
    if (!value || !healthy(value)) return { label: `${surface.slug}-healthy-control`, pass: false, geometry: null, ...await capture(opened, `${surface.slug}-healthy-control`) };
    const measured = await geometry(opened.page);
    healthyGeometry.set(surface.slug, measured);
    return { label: `${surface.slug}-healthy-control`, pass: healthy(value) && opened.hits.documents.length === 1, geometry: measured, ...await capture(opened, `${surface.slug}-healthy-control`) };
  } finally { await opened.close(); }
}

async function runGraphFailure(surface, fault, kind = 'graph') {
  const opened = await openCase(surface, { seedShot: false });
  try {
    await waitForError(opened.page);
    opened.control.fault = 'ok';
    opened.control[kind] = fault;
    const faultStarted = Date.now();
    await clickCenter(opened.page, '#status-banner button');
    await wait(5000);
    const during = await state(opened.page);
    const reliableIdentitySuccess = healthy(during);
    const failedClosed = during.banner.includes("Map couldn't load") && during.retry.ownsCenter
      && during.retryFlag === '1' && Boolean(during.storedUrl);
    const graphFaultHits = opened.hits.requests.filter((hit) => hit.at >= faultStarted && hit.path === assets.shell && hit.destination !== 'script');
    const truthful = failedClosed || (kind === 'graph' && graphFaultHits.length === 0 && reliableIdentitySuccess);
    opened.control[kind] = 'ok';
    if (!reliableIdentitySuccess) await clickCenter(opened.page, '#status-banner button');
    const recovered = await waitForHealthy(opened.page);
    const measured = recovered && healthy(recovered) ? await geometry(opened.page) : null;
    const geometryMatchesControl = sameGeometry(measured, healthyGeometry.get(surface.slug));
    const evidence = await capture(opened, `${surface.slug}-${kind}-${fault}`);
    const shellScriptOk = opened.hits.responses.some((hit) => hit.path === assets.shell && hit.destination === 'script' && hit.status === 200);
    const pass = shellScriptOk && truthful && healthy(recovered) && geometryMatchesControl;
    return { label: `${surface.slug}-${kind}-${fault}`, pass, during, failedClosed, reliableIdentitySuccess, graphFaultHits, shellScriptOk, geometryMatchesControl, geometry: measured, ...evidence };
  } finally { await opened.close(); }
}

async function runConcurrentCss(surface) {
  const opened = await openCase(surface, { seedShot: false });
  try {
    await waitForError(opened.page);
    opened.control.fault = 'ok';
    opened.control.css = 'delay';
    const documents = opened.hits.documents.length;
    await clickCenter(opened.page, '#status-banner button');
    await opened.page.waitForFunction(() => location.search.includes('map-retry') && [...document.querySelectorAll('link[rel="stylesheet"]')].some((link) => /maplibre/.test(link.href) && !link.sheet), null, { timeout: 15000 });
    const pending = await state(opened.page);
    await opened.page.click('#tab-map');
    await waitForHealthy(opened.page);
    await wait(2600);
    const evidence = await capture(opened, `${surface.slug}-concurrent-stylesheet`);
    const pass = healthy(evidence.state) && opened.hits.documents.length === documents + 1
      && evidence.state.unhandled.length === 0 && evidence.errors.length === 0;
    return { label: `${surface.slug}-concurrent-stylesheet`, pass, pending, ...evidence };
  } finally { await opened.close(); }
}

async function runProbeHang(surface) {
  const opened = await openCase(surface, { fault: 'probe-timeout', seedShot: false });
  try {
    await waitForError(opened.page);
    const evidence = await capture(opened, `${surface.slug}-probe-timeout`);
    return { label: `${surface.slug}-probe-timeout`, pass: evidence.state.retry.ownsCenter && opened.hits.documents.length === 1 && evidence.state.retryFlag === null, ...evidence };
  } finally { await opened.close(); }
}

const assets = buildAssets();
mkdirSync(outDir, { recursive: true });
const chrome = await chromium.launch({ executablePath: process.env.OPD_VERIFY_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let safari;
const results = [];
const healthyGeometry = new Map();
const caseFilter = process.env.OPD_VERIFY_CASE ?? '';
let interrupted = false;
process.once('SIGINT', () => { interrupted = true; });
process.once('SIGTERM', () => { interrupted = true; });
try {
  safari = await webkit.launch();
  const desktop = { slug: 'desktop-chrome', browser: chrome, options: { viewport: { width: 1400, height: 900 } } };
  const phone = { slug: 'iphone-13', browser: safari, options: { ...devices['iPhone 13'], viewport: { width: 390, height: 664 } } };
  const ipad = { slug: 'ipad-pro-11', browser: safari, options: { ...devices['iPad Pro 11'], viewport: { width: 834, height: 1194 } } };
  const surfaces = [desktop, phone, ipad];
  const sizes = [desktop, phone,
    { ...phone, slug: 'iphone-13-landscape', options: { ...phone.options, viewport: { width: 844, height: 390 } } },
    { ...phone, slug: 'iphone-17-pro', options: { ...phone.options, viewport: { width: 402, height: 874 } } },
    { ...phone, slug: 'iphone-17-pro-landscape', options: { ...phone.options, viewport: { width: 874, height: 402 } } }, ipad];
  const reportPath = join(outDir, process.argv.includes('--sizes') ? 'map-import-sizes-report.json' : 'map-import-red-report.json');
  const run = async (label, callback) => {
    if (interrupted) return;
    if (caseFilter && !label.includes(caseFilter) && !label.includes('healthy-control')) return;
    let result;
    try { result = await callback(); } catch (error) { result = { label, pass: false, error: String(error) }; }
    results.push(result);
    writeFileSync(reportPath, JSON.stringify({ assets, results }, null, 2));
    console.log(JSON.stringify({ label: result.label, pass: result.pass, productPass: result.productPass, platformFailure: result.platformFailure, error: result.error }));
  };
  if (process.argv.includes('--sizes')) {
    for (const surface of sizes) await run(`${surface.slug}-404`, () => runFailure(surface));
  } else {
    for (const surface of surfaces) {
      await run(`${surface.slug}-healthy-control`, () => runHealthy(surface));
      await run(`${surface.slug}-404`, () => runFailure(surface));
      for (const fault of ['404', 'abort', '500', 'delayed404']) await run(`${surface.slug}-vendor-${fault}`, () => runRecovery(surface, 'vendor', fault));
      for (const fault of ['404', 'abort']) await run(`${surface.slug}-entry-${fault}`, () => runRecovery(surface, 'entry', fault));
      for (const view of ['queue', 'iss']) await run(`${surface.slug}-delayed404-${view}`, () => runViewPreserve(surface, view));
      await run(`${surface.slug}-auth-mid`, () => runAuthMid(surface));
      await run(`${surface.slug}-retry-later-queue`, () => runRetryRace(surface));
      for (const fault of ['404', '500', 'timeout']) await run(`${surface.slug}-graph-${fault}`, () => runGraphFailure(surface, fault));
      for (const fault of ['404', 'timeout']) await run(`${surface.slug}-css-${fault}`, () => runGraphFailure(surface, fault, 'css'));
      await run(`${surface.slug}-concurrent-stylesheet`, () => runConcurrentCss(surface));
    }
    await run('desktop-chrome-probe-timeout', () => runProbeHang(desktop));
  }
  if (!results.length) throw new Error(`No verifier case matches ${caseFilter}`);
  const failed = results.filter((result) => !result.pass);
  console.log(`${results.length - failed.length}/${results.length} checks passed. Report: ${reportPath}`);
  if (failed.length) process.exitCode = 1;
} finally {
  await chrome.close();
  if (safari) await safari.close();
}
