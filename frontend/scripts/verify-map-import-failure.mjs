/**
 * Prove a failed dynamic import of the map chunk on a production build.
 *
 * Serves frontend/dist. A 404 may reload the document once. An abort or a
 * 500 must not. Retry reloads the document, and with the chunk served the
 * map paints.
 *
 *   node frontend/scripts/verify-map-import-failure.mjs
 *   node frontend/scripts/verify-map-import-failure.mjs --sizes --out /opt/cursor/artifacts
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'));
const { chromium } = require('playwright');
const { deviceDescriptor, launchWebkit } = await import('../../.cursor/skills/verify-opd/scripts/webkit-devices.mjs');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const outDir = process.argv.includes('--out')
  ? resolve(process.argv[process.argv.indexOf('--out') + 1])
  : join(root, 'dist-map-import-evidence');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.geojson': 'application/geo+json',
  '.png': 'image/png',
};

function mapChunkPath() {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const entry = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
  if (!entry) throw new Error('dist/index.html has no entry module');
  const source = readFileSync(join(dist, entry[1].slice(1)), 'utf8');
  const deps = source.match(/m\.f\|\|\(m\.f=\[([^\]]+)\]\)/);
  const calls = [...source.matchAll(/__vite__mapDeps\(\[([0-9,]+)\]\)/g)]
    .map((match) => match[1].split(',').map(Number))
    .filter((nums) => nums.length > 4);
  const mapCall = calls.sort((a, b) => b[0] - a[0])[0];
  if (!deps || !mapCall) throw new Error('could not find the map chunk in the entry module');
  const files = [...deps[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const file = files[mapCall[0]];
  if (!file) throw new Error(`map chunk index ${mapCall[0]} is missing`);
  return `/${file}`;
}

function snapshotFixture() {
  const now = new Date().toISOString();
  const passesBody = '[]';
  const track = {
    iss_polynomial: {
      start: now,
      duration_seconds: 7200,
      lat_coeffs: [0, 0, 0, 0, 0.01, 0],
      lon_coeffs: [0, 0, 0, 0, 0.04, 0],
      polynomial_order: 5,
    },
    tle_epoch: '2026-10-07T00:00:00Z',
    tle_age_hours: 1,
    tle_freshness_factor: 1,
  };
  const trackBody = JSON.stringify(track);
  const sha = (body) => createHash('sha256').update(body).digest('hex');
  const saved = JSON.stringify({
    manifest: {
      version: '20261007T120000Z',
      generated_at: now,
      tle_epoch: '2026-10-07T00:00:00Z',
      cloud_composite_hour: '2026-10-07T11:00:00Z',
      target_data_version: 'v1',
      build_version: '2.0.0.0',
      freshness: { tle_hours: 1, cloud_hours: 0, ok: true },
      artifacts: {
        passes: { path: 'v/X/passes.json', sha256: sha(passesBody), bytes: Buffer.byteLength(passesBody) },
        track: { path: 'v/X/track.json', sha256: sha(trackBody), bytes: Buffer.byteLength(trackBody) },
      },
    },
    top5: [],
    top_24h: [],
    track,
    status: null,
    savedAt: Date.now() - 30 * 60_000,
  });
  return {
    saved,
    files: {
      '/v/X/passes.json': passesBody,
      '/v/X/track.json': trackBody,
    },
  };
}

function startServer(mapChunk) {
  const fixture = snapshotFixture();
  const control = { chunk: '404' };
  const hits = { map: 0, documents: 0, script: 0, fetch: 0, docUrls: [], scriptUrls: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (path === '/api/browser/session') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, profile: { name: 'anil', displayName: 'Anil' } }));
      return;
    }
    const artifact = fixture.files[path];
    if (artifact) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(artifact);
      return;
    }
    if (path === mapChunk && control.chunk !== 'ok') {
      const status = control.chunk === '500' ? 500 : 404;
      res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('missing');
      return;
    }
    if (path === '/registerSW.js' || path === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      res.end('/* service worker withheld so the hashed chunk stays a network 404 */');
      return;
    }
    if (path === '/' || path === '/index.html') {
      hits.documents += 1;
      hits.docUrls.push(url.pathname + url.search);
    }
    const file = path === '/' ? '/index.html' : path;
    try {
      const body = readFileSync(join(dist, file));
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('missing');
    }
  });
  const ready = new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      done(port);
    });
  });
  return { server, ready, hits, control, snapshot: fixture.saved };
}

function watchChunk(page, mapChunk, hits) {
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path !== mapChunk) return;
    hits.map += 1;
    const kind = request.resourceType();
    if (kind === 'script') {
      hits.script += 1;
      hits.scriptUrls.push(request.url());
    } else hits.fetch += 1;
  });
}

async function readState(page) {
  return page.evaluate(() => {
    const shotList = document.getElementById('shotlist-bar');
    if (document.body.classList.contains('shotlist-bar-visible') && shotList) shotList.hidden = false;
    const banner = document.getElementById('status-banner');
    const retry = document.querySelector('#status-banner button');
    const box = retry?.getBoundingClientRect();
    const map = window.__opdMap;
    return {
      href: location.href,
      bannerText: banner?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      bannerClass: banner?.className ?? '',
      retryText: retry?.textContent ?? '',
      retryWidth: box ? Math.round(box.width) : 0,
      retryHeight: box ? Math.round(box.height) : 0,
      retryTop: box ? Math.round(box.top) : 0,
      retryBottom: box ? Math.round(box.bottom) : 0,
      retryTabIndex: retry ? retry.tabIndex : -1,
      view: document.getElementById('view')?.className ?? '',
      mapChildren: document.getElementById('map')?.childElementCount ?? -1,
      canvas: document.querySelectorAll('#map canvas').length,
      track: Boolean(map && typeof map.getLayer === 'function' && map.getLayer('iss-track-layer')),
      css: Boolean(document.querySelector('link[rel="stylesheet"][href*="maplibre-vendor"]')),
      markerInside: markerInsideMap(),
      storedUrl: sessionStorage.getItem('opd-map-import-url') ?? '',
      hit: retryHit(),
      barHit: barHit(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
    function markerInsideMap() {
      const mapEl = document.getElementById('map');
      const marker = document.querySelector('#map .iss-marker');
      if (!mapEl || !marker) return false;
      const mapBox = mapEl.getBoundingClientRect();
      const box = marker.getBoundingClientRect();
      if (mapBox.width < 20 || mapBox.height < 20 || box.width < 1 || box.height < 1) return false;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      return cx >= mapBox.left && cx <= mapBox.right && cy >= mapBox.top && cy <= mapBox.bottom;
    }
    function retryHit() {
      const retry = document.querySelector('#status-banner button');
      if (!retry) return '';
      const box = retry.getBoundingClientRect();
      const node = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return node instanceof HTMLElement ? (node.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
    }
    function barHit() {
      const button = document.querySelector('#shotlist-bar button');
      if (!button) return false;
      const box = button.getBoundingClientRect();
      const node = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return node instanceof Node && (node === button || button.contains(node));
    }
  });
}

async function tabReachesRetry(page) {
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  for (let step = 0; step < 40; step += 1) {
    const text = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim());
    if (text === 'Retry') return true;
    await page.keyboard.press('Tab');
  }
  return false;
}

async function waitForMapError(page) {
  await page.waitForFunction(() => {
    return (document.getElementById('status-banner')?.textContent ?? '').includes("Map couldn't load");
  }, null, { timeout: 20000 });
}

async function openFailurePage(browser, mapChunk, options) {
  const started = startServer(mapChunk);
  if (options.chunk) started.control.chunk = options.chunk;
  const port = await started.ready;
  const context = options.context ?? await browser.newContext({
    viewport: { width: 1400, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  watchChunk(page, mapChunk, started.hits);
  if (options.abort) {
    await page.route(`**${mapChunk}*`, (route) => route.abort('aborted'));
  }
  if (options.prepare) await options.prepare(page);
  await page.addInitScript((saved) => {
    localStorage.setItem('opd-snapshot', saved);
  }, started.snapshot);
  await page.goto(`http://127.0.0.1:${port}/?e2e`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  return { ...started, port, context, page, consoleErrors, ownsContext: !options.context };
}

async function raiseShotList(page) {
  await page.evaluate(() => {
    document.body.classList.add('shotlist-bar-visible');
    let bar = document.getElementById('shotlist-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'shotlist-bar';
      const count = document.createElement('span');
      count.className = 'shotlist-count';
      count.textContent = '2 selected';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn shotlist-clear';
      clear.textContent = 'Clear';
      bar.append(count, clear);
      document.body.append(bar);
    }
    bar.hidden = false;
    const count = bar.querySelector('.shotlist-count');
    if (count && !count.textContent?.trim()) count.textContent = '2 selected';
  });
}

async function runFailure(browser, mapChunk, options = {}) {
  const opened = await openFailurePage(browser, mapChunk, options);
  try {
    await waitForMapError(opened.page);
    const tabbable = await tabReachesRetry(opened.page);
    const heldDocuments = opened.hits.documents;
    const heldHref = opened.page.url();
    await opened.page.waitForTimeout(10000);
    const held = opened.hits.documents === heldDocuments && opened.page.url() === heldHref;
    await raiseShotList(opened.page);
    const state = await readState(opened.page);
    const shot = join(outDir, options.shot ?? 'map-import-red.png');
    await opened.page.screenshot({ path: shot, fullPage: true });
    const views = await opened.page.evaluate(() => {
      const text = () => (document.getElementById('status-banner')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      document.getElementById('tab-queue')?.click();
      const queue = text();
      document.getElementById('tab-iss')?.click();
      const iss = text();
      return { queue, iss };
    });
    await opened.page.click('#tab-map');
    await waitForMapError(opened.page);
    return { hits: opened.hits, state, consoleErrors: opened.consoleErrors, shot, tabbable, held, views };
  } finally {
    if (opened.ownsContext) await opened.context.close();
    await new Promise((done) => opened.server.close(done));
  }
}

function judgeFailure(result, expected) {
  const text = result.state.bannerText;
  const showed = text.includes("Map couldn't load") && !text.includes('Last updated');
  const retry = result.state.retryText === 'Retry';
  const tap = result.state.retryHeight >= 44 && result.state.retryWidth >= 44;
  const onScreen = result.state.retryTop >= 0
    && result.state.retryBottom <= result.state.viewport.height + 1;
  const reloaded = result.state.href.includes('map-chunk=1');
  const hit = result.state.hit === 'Retry';
  const barHit = result.state.barHit === true;
  const keptOffMap = !result.views.queue.includes("Map couldn't load")
    && !result.views.iss.includes("Map couldn't load");
  const pass = showed && result.held && retry && tap && onScreen && result.tabbable
    && result.state.retryTabIndex >= 0
    && result.hits.documents === expected.documents
    && reloaded === expected.reload
    && !result.state.href.includes('map-retry=')
    && result.hits.map >= 1
    && hit
    && barHit
    && keptOffMap;
  return {
    label: expected.label,
    pass,
    showed,
    held: result.held,
    retry,
    tap,
    onScreen,
    tabbable: result.tabbable,
    hit,
    barHit,
    keptOffMap,
    queueBanner: result.views.queue,
    issBanner: result.views.iss,
    retryTabIndex: result.state.retryTabIndex,
    documents: result.hits.documents,
    reload: reloaded,
    mapRequests: result.hits.map,
    scriptRequests: result.hits.script,
    fetchRequests: result.hits.fetch,
    bannerText: text,
    bannerClass: result.state.bannerClass,
    retryBox: {
      width: result.state.retryWidth,
      height: result.state.retryHeight,
      top: result.state.retryTop,
      bottom: result.state.retryBottom,
    },
    viewport: result.state.viewport,
    canvas: result.state.canvas,
    track: result.state.track,
    href: result.state.href,
    consoleErrors: result.consoleErrors.slice(0, 8),
    shot: result.shot,
  };
}

async function runRetry(browser, mapChunk, label) {
  const opened = await openFailurePage(browser, mapChunk, {});
  try {
    await waitForMapError(opened.page);
    const tabbable = await tabReachesRetry(opened.page);
    const heldDocuments = opened.hits.documents;
    const heldHref = opened.page.url();
    await opened.page.waitForTimeout(10000);
    const stateDuringHold = await readState(opened.page);
    const held = opened.hits.documents === heldDocuments
      && opened.page.url() === heldHref
      && heldHref.includes('map-chunk=1')
      && stateDuringHold.bannerText.includes("Map couldn't load")
      && !stateDuringHold.bannerText.includes('Last updated');
    const documentsBefore = opened.hits.documents;
    const scriptsBefore = opened.hits.script;
    opened.control.chunk = 'ok';
    const stillFocused = await tabReachesRetry(opened.page);
    await opened.page.keyboard.press('Enter');
    try {
      await opened.page.waitForFunction((chunk) => {
        const map = window.__opdMap;
        const mapEl = document.getElementById('map');
        const marker = document.querySelector('#map .iss-marker');
        const css = Boolean(document.querySelector('link[rel="stylesheet"][href*="maplibre-vendor"]'));
        const flagsGone = !location.href.includes('map-chunk') && !location.href.includes('map-retry');
        if (!mapEl || !marker || !css || !flagsGone) return false;
        const mapBox = mapEl.getBoundingClientRect();
        const box = marker.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const inside = mapBox.width > 20 && cx >= mapBox.left && cx <= mapBox.right && cy >= mapBox.top && cy <= mapBox.bottom;
        return inside
          && document.querySelectorAll('#map canvas').length > 0
          && Boolean(map && typeof map.getLayer === 'function' && map.getLayer('iss-track-layer'))
          && chunk.length > 0;
      }, mapChunk, { timeout: 30000 });
    } catch {
      /* screenshot the page that did not paint */
    }
    const state = await readState(opened.page);
    const shot = join(outDir, `map-import-retry-${label}.png`);
    await opened.page.screenshot({ path: shot, fullPage: true });
    const retriedDoc = opened.hits.docUrls.some((href) => href.includes('map-retry='));
    const retryScripts = opened.hits.scriptUrls.filter((href) => href.includes('map-retry='));
    const retriedMap = retryScripts.some((href) => href.includes(mapChunk));
    const retriedVendor = retryScripts.some((href) => href.includes('maplibre-vendor') || href.includes('maplibre-gl-worker'));
    const flagsGone = !state.href.includes('map-chunk') && !state.href.includes('map-retry');
    const pass = held && tabbable && stillFocused
      && state.canvas > 0
      && state.track
      && state.css
      && state.markerInside
      && flagsGone
      && retriedDoc
      && retriedMap
      && !retriedVendor
      && opened.hits.documents === documentsBefore + 1
      && opened.hits.script > scriptsBefore
      && !state.bannerText.includes("Map couldn't load");
    return {
      label: `retry-${label}`,
      pass,
      held,
      tabbable,
      stillFocused,
      documents: opened.hits.documents,
      documentsBefore,
      scriptRequests: opened.hits.script,
      scriptsBefore,
      fetchRequests: opened.hits.fetch,
      mapRequests: opened.hits.map,
      canvas: state.canvas,
      track: state.track,
      css: state.css,
      markerInside: state.markerInside,
      flagsGone,
      retriedDoc,
      retriedMap,
      retriedVendor,
      bannerText: state.bannerText,
      href: state.href,
      viewport: state.viewport,
      shot,
    };
  } finally {
    await opened.context.close();
    await new Promise((done) => opened.server.close(done));
  }
}

async function runProbeHang(browser, mapChunk) {
  const opened = await openFailurePage(browser, mapChunk, {
    prepare: (page) => page.route(`**${mapChunk}*`, async (route) => {
      if (route.request().url().includes('map-probe=')) return;
      await route.abort('failed');
    }),
  });
  try {
    await waitForMapError(opened.page);
    await opened.page.waitForTimeout(3000);
    const state = await readState(opened.page);
    const shot = join(outDir, 'map-import-probe-hang.png');
    await opened.page.screenshot({ path: shot, fullPage: true });
    const pass = state.bannerText.includes("Map couldn't load")
      && !state.bannerText.includes('Last updated')
      && !state.href.includes('map-chunk')
      && opened.hits.documents === 1;
    return {
      label: 'probe-hang',
      pass,
      documents: opened.hits.documents,
      bannerText: state.bannerText,
      href: state.href,
      shot,
    };
  } finally {
    await opened.context.close();
    await new Promise((done) => opened.server.close(done));
  }
}

async function runViewPreserve(browser, mapChunk) {
  let release = () => {};
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const opened = await openFailurePage(browser, mapChunk, {
    prepare: (page) => page.route(`**${mapChunk}*`, async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.includes('map-probe=')) {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
        return;
      }
      await hold;
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
    }),
  });
  try {
    await opened.page.waitForRequest((request) => {
      return request.url().includes(mapChunk) && request.resourceType() === 'script';
    }, { timeout: 20000 });
    await opened.page.click('#tab-queue');
    release();
    await opened.page.waitForFunction(() => {
      return location.href.includes('map-chunk=1') && document.getElementById('view')?.className === 'view-queue';
    }, null, { timeout: 20000 });
    const state = await readState(opened.page);
    const shot = join(outDir, 'map-import-view-queue.png');
    await opened.page.screenshot({ path: shot, fullPage: true });
    const pass = state.view === 'view-queue'
      && state.href.includes('map-chunk=1')
      && opened.hits.documents === 2
      && !state.href.includes('map-retry');
    return { label: 'view-queue', pass, view: state.view, documents: opened.hits.documents, href: state.href, shot };
  } finally {
    release();
    await opened.context.close();
    await new Promise((done) => opened.server.close(done));
  }
}

async function runAbortRetry(browser, mapChunk, label) {
  const opened = await openFailurePage(browser, mapChunk, { abort: true });
  try {
    await waitForMapError(opened.page);
    const failed = await readState(opened.page);
    const storedMap = failed.storedUrl.includes(mapChunk) && !failed.storedUrl.includes('maplibre-vendor');
    await opened.page.unroute(`**${mapChunk}*`);
    opened.control.chunk = 'ok';
    const scriptsBefore = opened.hits.script;
    await opened.page.click('#status-banner button');
    try {
      await opened.page.waitForFunction(() => {
        const map = window.__opdMap;
        const mapEl = document.getElementById('map');
        const marker = document.querySelector('#map .iss-marker');
        const css = Boolean(document.querySelector('link[rel="stylesheet"][href*="maplibre-vendor"]'));
        if (!mapEl || !marker || !css) return false;
        if (location.href.includes('map-chunk') || location.href.includes('map-retry')) return false;
        const mapBox = mapEl.getBoundingClientRect();
        const box = marker.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        return mapBox.width > 20
          && cx >= mapBox.left && cx <= mapBox.right
          && cy >= mapBox.top && cy <= mapBox.bottom
          && document.querySelectorAll('#map canvas').length > 0
          && Boolean(map && typeof map.getLayer === 'function' && map.getLayer('iss-track-layer'));
      }, null, { timeout: 30000 });
    } catch {
      /* screenshot the page that did not paint */
    }
    const state = await readState(opened.page);
    const shot = join(outDir, `map-import-abort-retry-${label}.png`);
    await opened.page.screenshot({ path: shot, fullPage: true });
    const retryScripts = opened.hits.scriptUrls.filter((href) => href.includes('map-retry='));
    const pass = storedMap
      && failed.href.includes("e2e")
      && !failed.href.includes('map-chunk')
      && state.canvas > 0
      && state.track
      && state.css
      && state.markerInside
      && !state.href.includes('map-chunk')
      && !state.href.includes('map-retry')
      && retryScripts.some((href) => href.includes(mapChunk))
      && !retryScripts.some((href) => href.includes('maplibre-vendor') || href.includes('maplibre-gl-worker'))
      && opened.hits.script > scriptsBefore;
    return {
      label: `abort-retry-${label}`,
      pass,
      storedMap,
      storedUrl: failed.storedUrl,
      css: state.css,
      markerInside: state.markerInside,
      canvas: state.canvas,
      track: state.track,
      href: state.href,
      scriptUrls: retryScripts,
      shot,
    };
  } finally {
    await opened.context.close();
    await new Promise((done) => opened.server.close(done));
  }
}

const SIZES = [
  { slug: 'desktop-chrome', kind: 'chrome', viewport: { width: 1400, height: 900 } },
  { slug: 'iphone-13', kind: 'webkit', spec: { name: 'iPhone 13', slug: 'iphone-13', standalone: true } },
  {
    slug: 'iphone-17-pro',
    kind: 'webkit',
    spec: { name: 'iPhone 17 Pro', slug: 'iphone-17-pro', viewport: { width: 402, height: 874 }, deviceScaleFactor: 3 },
  },
  {
    slug: 'iphone-17-pro-874x402',
    kind: 'webkit',
    spec: { name: 'iPhone 17 Pro', slug: 'iphone-17-pro-874x402', viewport: { width: 874, height: 402 }, deviceScaleFactor: 3 },
  },
  { slug: 'ipad-pro-11', kind: 'webkit', spec: { name: 'iPad Pro 11', slug: 'ipad-pro-11', standalone: false } },
];

async function contextFor(size, chrome, webkit) {
  if (size.kind === 'chrome') {
    return chrome.newContext({ viewport: size.viewport, serviceWorkers: 'block' });
  }
  return webkit.newContext({ ...deviceDescriptor(size.spec), serviceWorkers: 'block' });
}

const mapChunk = mapChunkPath();
mkdirSync(outDir, { recursive: true });
const wantSizes = process.argv.includes('--sizes');
const chrome = await chromium.launch({
  executablePath: process.env.OPD_VERIFY_CHROME || '/opt/google/chrome/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const webkit = await launchWebkit();
try {
  const results = [];
  if (!wantSizes) {
    const cases = [
      { label: 'chrome-404', browser: chrome, documents: 2, reload: true, shot: 'map-import-chrome-404.png' },
      { label: 'chrome-abort', browser: chrome, documents: 1, reload: false, abort: true, shot: 'map-import-chrome-abort.png' },
      { label: 'webkit-abort', browser: webkit, documents: 1, reload: false, abort: true, shot: 'map-import-webkit-abort.png' },
      { label: 'webkit-500', browser: webkit, documents: 1, reload: false, chunk: '500', shot: 'map-import-webkit-500.png' },
    ];
    for (const item of cases) {
      const result = await runFailure(item.browser, mapChunk, item);
      results.push(judgeFailure(result, item));
    }
    results.push(await runRetry(chrome, mapChunk, 'chrome'));
    results.push(await runRetry(webkit, mapChunk, 'webkit'));
    results.push(await runAbortRetry(webkit, mapChunk, 'webkit'));
    results.push(await runProbeHang(chrome, mapChunk));
    results.push(await runViewPreserve(chrome, mapChunk));
  } else {
    for (const size of SIZES) {
      const browser = size.kind === 'webkit' ? webkit : chrome;
      const context = await contextFor(size, chrome, webkit);
      try {
        const result = await runFailure(browser, mapChunk, {
          context,
          shot: `map-import-${size.slug}.png`,
        });
        results.push({ ...judgeFailure(result, {
          label: size.slug,
          documents: 2,
          reload: true,
        }), size: size.slug });
      } finally {
        await context.close();
      }
    }
  }
  const report = { mapChunk, results };
  const reportName = wantSizes ? 'map-import-sizes-report.json' : 'map-import-red-report.json';
  writeFileSync(join(outDir, reportName), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (results.some((result) => !result.pass)) {
    console.error('map import failure check failed');
    process.exit(1);
  }
  console.log('map import failure check passed');
} finally {
  await chrome.close();
  await webkit.close();
}
