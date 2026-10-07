/**
 * Prove a failed dynamic import of the map chunk on a production build.
 *
 * Serves frontend/dist, signs the page in, restores a snapshot, then either
 * 404s the hashed map chunk or aborts that request. The check expects the
 * footer to say "Map couldn't load" and to offer Retry. A second document
 * load is the one allowed cache-bust. A third load fails the check.
 *
 *   node frontend/scripts/verify-map-import-failure.mjs
 *   node frontend/scripts/verify-map-import-failure.mjs --out /opt/cursor/artifacts
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'));
const { chromium } = require('playwright');

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
  const call = source.match(/__vite__mapDeps\(\[(\d+)[^\]]*\]\)\)\),await \w+\.renderMap/);
  if (!deps || !call) throw new Error('could not find the map chunk in the entry module');
  const files = [...deps[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const file = files[Number(call[1])];
  if (!file) throw new Error(`map chunk index ${call[1]} is missing`);
  return `/${file}`;
}

function snapshotBody() {
  const now = new Date().toISOString();
  return JSON.stringify({
    manifest: {
      version: '20261007T120000Z',
      generated_at: now,
      tle_epoch: '2026-10-07T00:00:00Z',
      cloud_composite_hour: '2026-10-07T11:00:00Z',
      target_data_version: 'v1',
      build_version: '2.0.0.0',
      freshness: { tle_hours: 1, cloud_hours: 0, ok: true },
      artifacts: {
        top5: { path: 'v/X/top5.json', sha256: 'a'.repeat(64), bytes: 2 },
        top_24h: { path: 'v/X/top_24h.json', sha256: 'b'.repeat(64), bytes: 2 },
        track: { path: 'v/X/track.json', sha256: 'c'.repeat(64), bytes: 2 },
      },
    },
    top5: [],
    top_24h: [],
    track: {
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
    },
    status: null,
    savedAt: Date.now() - 30 * 60_000,
  });
}

function startServer(mapChunk, mode) {
  const hits = { map: 0, documents: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (path === '/api/browser/session') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, profile: { name: 'anil', displayName: 'Anil' } }));
      return;
    }
    if (path === mapChunk && mode === '404') {
      hits.map += 1;
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
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
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      done({ server, port, hits });
    });
  });
}

async function readState(page) {
  return page.evaluate(() => {
    const banner = document.getElementById('status-banner');
    const retry = document.querySelector('#status-banner button');
    const box = retry?.getBoundingClientRect();
    return {
      href: location.href,
      bannerText: banner?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      bannerClass: banner?.className ?? '',
      retryText: retry?.textContent ?? '',
      retryWidth: box ? Math.round(box.width) : 0,
      retryHeight: box ? Math.round(box.height) : 0,
      retryTop: box ? Math.round(box.top) : 0,
      retryBottom: box ? Math.round(box.bottom) : 0,
      view: document.getElementById('view')?.className ?? '',
      mapChildren: document.getElementById('map')?.childElementCount ?? -1,
      canvas: document.querySelectorAll('#map canvas').length,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

async function runMode(browser, mapChunk, mode) {
  const { server, port, hits } = await startServer(mapChunk, mode);
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === mapChunk) hits.map += mode === '404' ? 0 : 1;
  });
  if (mode === 'abort') {
    await page.route(`**${mapChunk}`, (route) => route.abort('aborted'));
  }
  await page.addInitScript((saved) => {
    localStorage.setItem('opd-snapshot', saved);
  }, snapshotBody());
  const origin = `http://127.0.0.1:${port}/`;
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => {
      const text = document.getElementById('status-banner')?.textContent ?? '';
      return text.includes("Map couldn't load") || text.includes('LOS') || text.includes('Last updated') || text.includes('Sign in');
    }, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    if (page.url().includes('map-chunk') || hits.documents > 1) {
      await page.waitForFunction(() => {
        const text = document.getElementById('status-banner')?.textContent ?? '';
        return text.includes("Map couldn't load");
      }, null, { timeout: 8000 }).catch(() => {});
    }
    const state = await readState(page);
    const shot = join(outDir, `map-import-red-${mode}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    return { mode, port, hits, state, consoleErrors, shot };
  } finally {
    await context.close();
    await new Promise((done) => server.close(done));
  }
}

function judge(result) {
  const text = result.state.bannerText;
  const showed = text.includes("Map couldn't load");
  const retry = result.state.retryText === 'Retry';
  const tap = result.state.retryHeight >= 44 && result.state.retryWidth >= 44;
  const onScreen = result.state.retryTop >= 0
    && result.state.retryBottom <= result.state.viewport.height + 1;
  const documents = result.hits.documents;
  const loop = documents > 2;
  const stuckOnSnapshot = /LOS|Last updated/.test(text) && !showed;
  return {
    mode: result.mode,
    pass: showed && retry && tap && onScreen && !loop && result.hits.map >= 1,
    showed,
    retry,
    tap,
    onScreen,
    loop,
    documents,
    mapRequests: result.hits.map,
    stuckOnSnapshot,
    bannerText: text,
    bannerClass: result.state.bannerClass,
    mapChildren: result.state.mapChildren,
    canvas: result.state.canvas,
    view: result.state.view,
    href: result.state.href,
    consoleErrors: result.consoleErrors.slice(0, 8),
    shot: result.shot,
  };
}

const mapChunk = mapChunkPath();
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.OPD_VERIFY_CHROME || '/opt/google/chrome/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const results = [];
  for (const mode of ['404', 'abort']) {
    results.push(judge(await runMode(browser, mapChunk, mode)));
  }
  const report = { mapChunk, results };
  writeFileSync(join(outDir, 'map-import-red-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (results.some((result) => !result.pass)) {
    console.error('map import failure check failed');
    process.exit(1);
  }
  console.log('map import failure check passed');
} finally {
  await browser.close();
}
