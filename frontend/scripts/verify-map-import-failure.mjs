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
  const hits = { map: 0, documents: 0, script: 0, fetch: 0 };
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
    if (path === '/' || path === '/index.html') hits.documents += 1;
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
    if (kind === 'script') hits.script += 1;
    else hits.fetch += 1;
  });
}

async function readState(page) {
  return page.evaluate(() => {
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
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
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
    await page.route(`**${mapChunk}`, (route) => route.abort('aborted'));
  }
  await page.addInitScript((saved) => {
    localStorage.setItem('opd-snapshot', saved);
  }, started.snapshot);
  await page.goto(`http://127.0.0.1:${port}/?e2e`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  return { ...started, port, context, page, consoleErrors, ownsContext: !options.context };
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
    const state = await readState(opened.page);
    const shot = join(outDir, options.shot ?? 'map-import-red.png');
    await opened.page.screenshot({ path: shot, fullPage: true });
    return { hits: opened.hits, state, consoleErrors: opened.consoleErrors, shot, tabbable, held };
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
  const pass = showed && result.held && retry && tap && onScreen && result.tabbable
    && result.state.retryTabIndex >= 0
    && result.hits.documents === expected.documents
    && reloaded === expected.reload
    && !result.state.href.includes('map-retry=')
    && result.hits.map >= 1;
  return {
    label: expected.label,
    pass,
    showed,
    held: result.held,
    retry,
    tap,
    onScreen,
    tabbable: result.tabbable,
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
      await opened.page.waitForFunction(() => {
        const map = window.__opdMap;
        return location.href.includes('map-retry=')
          && document.querySelectorAll('#map canvas').length > 0
          && Boolean(map && typeof map.getLayer === 'function' && map.getLayer('iss-track-layer'));
      }, null, { timeout: 30000 });
    } catch {
      /* screenshot the page that did not paint */
    }
    const state = await readState(opened.page);
    const shot = join(outDir, `map-import-retry-${label}.png`);
    await opened.page.screenshot({ path: shot, fullPage: true });
    const pass = held && tabbable && stillFocused
      && state.canvas > 0
      && state.track
      && state.href.includes('map-retry=')
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
