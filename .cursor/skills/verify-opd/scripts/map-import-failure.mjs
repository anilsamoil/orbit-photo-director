import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RASTER_TILE_PNG } from '../../../../frontend/scripts/raster-tile-fixture.mjs';
import { IPAD_3, WEBKIT_DEVICES, deviceDescriptor, launchChrome, launchWebkit } from './webkit-devices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const dist = resolve(repoRoot, 'frontend/dist');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.geojson': 'application/geo+json',
  '.png': 'image/png',
};

export const MAP_IMPORT_HELP = 'drive map-import is one process per surface and does not use up. Set OPD_VERIFY_SURFACE and OPD_VERIFY_VIEWPORT to desktop 1440x900, iphone-17-pro 402x874, iphone-17-pro 874x402, ipad-pro-11 834x1210, ipad-pro-11 1210x834, or ipad-3 768x1024. The context is created at that size. drive map and drive all leave it out. Do not run a second WebKit process beside it.';

export const MAP_IMPORT_SURFACES = [
  { id: 'desktop-1440x900', surface: 'desktop', width: 1440, height: 900, browser: 'chromium' },
  { id: 'webkit-iphone-17-pro-402x874', surface: 'iphone-17-pro', width: 402, height: 874, browser: 'webkit', scale: 3, standalone: true },
  { id: 'webkit-iphone-17-pro-874x402', surface: 'iphone-17-pro', width: 874, height: 402, browser: 'webkit', scale: 3, standalone: true },
  { id: 'webkit-ipad-m4-834x1210', surface: 'ipad-pro-11', width: 834, height: 1210, browser: 'webkit', scale: 2, standalone: false },
  { id: 'webkit-ipad-m4-1210x834', surface: 'ipad-pro-11', width: 1210, height: 834, browser: 'webkit', scale: 2, standalone: false },
  { id: 'webkit-ipad-3-768x1024', surface: 'ipad-3', width: 768, height: 1024, browser: 'webkit', scale: 2, standalone: false },
];

const HOLD_MS = 10000;

export function mapImportPlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(MAP_IMPORT_HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = MAP_IMPORT_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(MAP_IMPORT_HELP);
  return plan;
}

export function stylesheetIdentity(html, cssPath) {
  const tags = html.match(/<meta\b[^>]*>/g) ?? [];
  const hits = [];
  for (const tag of tags) {
    const name = tag.match(/\bname="([^"]*)"/);
    if (name?.[1] !== 'opd-map-stylesheet') continue;
    const content = tag.match(/\bcontent="([^"]*)"/);
    hits.push(content?.[1] ?? '');
  }
  if (hits.length !== 1) return `opd-map-stylesheet count ${hits.length}`;
  if (!/\/assets\/maplibre-vendor-[^"]+\.css$/.test(hits[0])) return `stylesheet ${hits[0]}`;
  if (cssPath && hits[0] !== cssPath) return `stylesheet ${hits[0]} wanted ${cssPath}`;
  return null;
}

export function mapImportFailures(sample) {
  const failures = [];
  if (sample.openedWidth !== sample.width || sample.openedHeight !== sample.height) {
    failures.push(`opened ${sample.openedWidth}x${sample.openedHeight} wanted ${sample.width}x${sample.height}`);
  }
  if (!String(sample.banner || '').includes("Map couldn't load")) failures.push("banner missing Map couldn't load");
  if (!(sample.retryWidth >= 44) || !(sample.retryHeight >= 44)) failures.push(`retry ${sample.retryWidth}x${sample.retryHeight}`);
  if (sample.retryTop < 0 || sample.retryBottom > sample.openedHeight + 1) failures.push('retry off screen');
  if (sample.tabIndex < 0) failures.push(`tabindex ${sample.tabIndex}`);
  const tabPlatform = sample.platform === 'darwin' && sample.browser === 'webkit' && sample.tabbable === false;
  if (!sample.tabbable && !tabPlatform) failures.push('tab missed Retry');
  if (sample.documentsAfterHold !== sample.documentsAtError) failures.push('document changed during the 10s hold');
  if (!String(sample.heldBanner || '').includes("Map couldn't load")) failures.push('hold lost the error');
  if (String(sample.heldBanner || '').includes('Last updated')) failures.push('hold became Last updated');
  if (sample.retryFlag !== '1') failures.push(`retry flag ${sample.retryFlag}`);
  if (!sample.storedUrlIncludesEntry) failures.push('stored url is not the map chunk');
  if (!sample.mapChunk) failures.push('missing map-chunk=1');
  if (sample.recoveredCanvas !== 1) failures.push(`canvas ${sample.recoveredCanvas}`);
  if (!sample.markerInside) failures.push('marker outside map');
  if (!sample.track) failures.push('missing iss-track-layer');
  if (sample.recoveredError) failures.push('error remained after retry');
  if (!sample.stylesheet) failures.push('maplibre stylesheet missing');
  if (!sample.flagsCleared) failures.push('import flags remained');
  if (sample.recoveredWidth !== sample.width || sample.recoveredHeight !== sample.height) {
    failures.push(`recovered viewport ${sample.recoveredWidth}x${sample.recoveredHeight}`);
  }
  return failures;
}

function homeDir(env) {
  return env.OPD_VERIFY_HOME || '/tmp/opd-verify/map-import';
}

function importPort(env) {
  const port = Number(env.OPD_VERIFY_MAP_IMPORT_PORT ?? 41871);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('OPD_VERIFY_MAP_IMPORT_PORT must be an integer from 1024 to 65535');
  return port;
}

function buildAssets() {
  if (!existsSync(join(dist, 'index.html'))) throw new Error('frontend/dist is missing. From frontend run bun run build.');
  const assets = readdirSync(join(dist, 'assets'));
  const entries = assets.filter((name) => name.endsWith('.js.map')).filter((name) => {
    const sourceMap = JSON.parse(readFileSync(join(dist, 'assets', name), 'utf8'));
    return sourceMap.sources.some((source) => /(?:^|\/)src\/map\/index\.ts$/.test(source));
  });
  if (entries.length !== 1) throw new Error(`Expected one map composition-root source map; found ${entries.length}`);
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const cssName = assets.find((name) => /^maplibre-vendor-.*\.css$/.test(name));
  if (!cssName) throw new Error('Missing MapLibre vendor stylesheet');
  const cssPath = `/assets/${cssName}`;
  const identity = stylesheetIdentity(html, cssPath);
  if (identity) throw new Error(identity);
  return { entry: `/assets/${entries[0].slice(0, -4)}`, cssPath, html };
}

function snapshotFixture() {
  const now = new Date().toISOString();
  const track = {
    iss_polynomial: { start: now, duration_seconds: 7200, lat_coeffs: [0, 0, 0, 0, 0.01, 0], lon_coeffs: [0, 0, 0, 0, 0.04, 0], polynomial_order: 5 },
    tle_epoch: now,
    tle_age_hours: 1,
    tle_freshness_factor: 1,
  };
  const bodies = { passes: '[]', top5: '[]', top_24h: '[]', targets: '[]', track: JSON.stringify(track), status: '{}' };
  const manifest = {
    version: '20261007T120000Z',
    generated_at: now,
    tle_epoch: now,
    cloud_composite_hour: now,
    target_data_version: 'v1',
    build_version: '2.0.0.0',
    freshness: { tle_hours: 1, cloud_hours: 0, ok: true },
    artifacts: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, {
      path: `v/X/${name}.json`,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: Buffer.byteLength(body),
    }])),
  };
  return {
    manifest,
    bodies,
    saved: JSON.stringify({ manifest, top5: [], top_24h: [], track, status: null, savedAt: Date.now() - 30 * 60000 }),
  };
}

function contextOptions(plan) {
  if (plan.browser === 'chromium') {
    return {
      viewport: { width: plan.width, height: plan.height },
      screen: { width: plan.width, height: plan.height },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      serviceWorkers: 'block',
    };
  }
  const catalog = plan.surface === 'ipad-3' ? IPAD_3 : WEBKIT_DEVICES.find((device) => device.slug === plan.surface);
  const descriptor = deviceDescriptor({
    ...catalog,
    viewport: { width: plan.width, height: plan.height },
    deviceScaleFactor: plan.scale,
  });
  return {
    ...descriptor,
    viewport: { width: plan.width, height: plan.height },
    screen: { width: plan.width, height: plan.height },
    serviceWorkers: 'block',
  };
}

async function listen(server, port) {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
}

function startServer(port, assets) {
  const fixture = snapshotFixture();
  const control = { fault: '404' };
  const hits = { documents: [] };
  const sockets = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const reply = (status, body, type = 'text/plain') => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const staticReply = () => {
      try {
        const file = resolve(dist, `.${path === '/' ? '/index.html' : decodeURIComponent(path)}`);
        if (file !== dist && !file.startsWith(`${dist}${sep}`)) return reply(404, 'missing');
        reply(200, readFileSync(file), types[extname(file)] ?? 'application/octet-stream');
      } catch {
        reply(404, 'missing');
      }
    };
    if (path === '/api/browser/session') return reply(200, JSON.stringify({ ok: true, profile: { name: 'anil', displayName: 'Anil' } }), 'application/json');
    if (path === '/api/browser/profiles/anil/targets') return reply(200, '{"targets":[],"removedCuratedIds":[]}', 'application/json');
    if (path === '/manifest.json') return reply(200, JSON.stringify(fixture.manifest), 'application/json');
    if (path === '/api/log') return reply(200, '{"entries":[]}', 'application/json');
    if (path === '/api/kp') return reply(200, '[]', 'application/json');
    if (path === '/launch/latest.json') return reply(200, 'null', 'application/json');
    if (path.startsWith('/v/X/')) {
      const name = path.split('/').at(-1).replace('.json', '');
      if (fixture.bodies[name]) return reply(200, fixture.bodies[name], 'application/json');
    }
    if (path === '/registerSW.js' || path === '/sw.js') return reply(200, '/* isolated map-import drive */', 'text/javascript');
    if (path === assets.entry && control.fault !== 'ok') return reply(404, 'missing');
    staticReply();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    server,
    control,
    hits,
    fixture,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((done) => server.close(done));
    },
  };
}

async function openedSize(page, plan) {
  return page.evaluate(({ width, height }) => {
    const root = document.documentElement;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && (root.clientWidth !== width || root.clientHeight !== height)) {
      meta.setAttribute('content', `width=${width}, height=${height}, initial-scale=1, viewport-fit=cover`);
    }
    return { width: window.innerWidth, height: window.innerHeight };
  }, plan);
}

async function readFailure(page) {
  return page.evaluate(() => {
    const banner = document.getElementById('status-banner');
    const button = banner?.querySelector('button');
    const box = button?.getBoundingClientRect();
    return {
      banner: banner?.textContent.replace(/\s+/g, ' ').trim() ?? '',
      retryWidth: box?.width ?? 0,
      retryHeight: box?.height ?? 0,
      retryTop: box?.top ?? -1,
      retryBottom: box?.bottom ?? -1,
      tabIndex: button?.tabIndex ?? -1,
      retryFlag: sessionStorage.getItem('opd-map-import-retry'),
      storedUrl: sessionStorage.getItem('opd-map-import-url'),
      mapChunk: /[?&]map-chunk=1(?:&|$)/.test(location.search),
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
}

async function tabReachesRetry(page) {
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  for (let i = 0; i < 40; i += 1) {
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Retry');
    if (focused) return true;
    await page.keyboard.press('Tab');
  }
  return false;
}

async function readRecovered(page, cssPath) {
  return page.evaluate((stylesheet) => {
    const banner = document.getElementById('status-banner')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
    const map = window.__opdMap;
    const marker = document.querySelector('#map .iss-marker');
    const mapBox = document.getElementById('map')?.getBoundingClientRect();
    const markerBox = marker?.getBoundingClientRect();
    const markerInside = Boolean(mapBox && markerBox && markerBox.width > 0
      && markerBox.x + markerBox.width / 2 >= mapBox.left
      && markerBox.x + markerBox.width / 2 <= mapBox.right
      && markerBox.y + markerBox.height / 2 >= mapBox.top
      && markerBox.y + markerBox.height / 2 <= mapBox.bottom);
    const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find((item) => item.href.includes(stylesheet));
    return {
      banner,
      canvas: document.querySelectorAll('#map canvas').length,
      markerInside,
      track: Boolean(map?.getLayer?.('iss-track-layer')),
      stylesheet: Boolean(link?.sheet),
      flagsCleared: sessionStorage.getItem('opd-map-import-retry') === null
        && sessionStorage.getItem('opd-map-import-url') === null
        && !/[?&]map-(?:chunk|retry)=/.test(location.search),
      width: window.innerWidth,
      height: window.innerHeight,
      href: location.href,
    };
  }, cssPath);
}

function routeExternal(context) {
  return context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
    if (url.hostname === '127.0.0.1') return route.continue();
    const glyph = /\.pbf$/.test(url.pathname);
    const image = route.request().resourceType() === 'image' || /\/(?:tile|tiles)\//.test(url.pathname) || /\.(?:png|jpg|jpeg)$/.test(url.pathname);
    if (glyph || image) {
      return route.fulfill({
        status: 200,
        contentType: glyph ? 'application/x-protobuf' : 'image/png',
        body: glyph ? Buffer.alloc(0) : RASTER_TILE_PNG,
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

export async function driveMapImport(env = process.env) {
  const plan = mapImportPlan(env.OPD_VERIFY_SURFACE, env.OPD_VERIFY_VIEWPORT);
  const port = importPort(env);
  const assets = buildAssets();
  const evidenceDir = resolve(homeDir(env), 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const hosted = startServer(port, assets);
  let browser;
  let context;
  let page;
  try {
    await listen(hosted.server, port);
    browser = plan.browser === 'chromium' ? await launchChrome() : await launchWebkit();
    context = await browser.newContext(contextOptions(plan));
    if (plan.standalone) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      });
    }
    await context.addInitScript((saved) => {
      if (!localStorage.getItem('verify-map-seeded')) {
        localStorage.setItem('opd-snapshot', saved);
        localStorage.setItem('verify-map-seeded', '1');
      }
    }, hosted.fixture.saved);
    await routeExternal(context);
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) hosted.hits.documents.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${port}/?u=anil&e2e`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const opened = await openedSize(page, plan);
    console.log(`viewport map-import surface ${plan.id} opened ${plan.width}x${plan.height} now ${opened.width}x${opened.height} created-at-size`);
    await page.waitForFunction(() => {
      const banner = document.getElementById('status-banner')?.textContent || '';
      return banner.includes("Map couldn't load") && /[?&]map-chunk=1(?:&|$)/.test(location.search);
    }, null, { timeout: 25000 });
    const failed = await readFailure(page);
    const tabbable = await tabReachesRetry(page);
    const documentsAtError = hosted.hits.documents.length;
    await new Promise((done) => setTimeout(done, HOLD_MS));
    const documentsAfterHold = hosted.hits.documents.length;
    const held = await readFailure(page);
    await page.screenshot({ path: join(evidenceDir, `map-import-${plan.id}-error.png`) });
    hosted.control.fault = 'ok';
    const box = await page.locator('#status-banner button').boundingBox();
    if (!box) throw new Error('Retry has no box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction((stylesheet) => {
      const banner = document.getElementById('status-banner')?.textContent || '';
      const map = window.__opdMap;
      const marker = document.querySelector('#map .iss-marker');
      const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find((item) => item.href.includes(stylesheet));
      return document.querySelectorAll('#map canvas').length === 1
        && Boolean(map?.getLayer?.('iss-track-layer'))
        && Boolean(marker)
        && !banner.includes("Map couldn't load")
        && Boolean(link?.sheet)
        && !/[?&]map-(?:chunk|retry)=/.test(location.search);
    }, assets.cssPath, { timeout: 45000 });
    const recovered = await readRecovered(page, assets.cssPath);
    await page.screenshot({ path: join(evidenceDir, `map-import-${plan.id}-recovered.png`) });
    const sample = {
      width: plan.width,
      height: plan.height,
      openedWidth: opened.width,
      openedHeight: opened.height,
      banner: failed.banner,
      retryWidth: failed.retryWidth,
      retryHeight: failed.retryHeight,
      retryTop: failed.retryTop,
      retryBottom: failed.retryBottom,
      tabIndex: failed.tabIndex,
      tabbable,
      platform: process.platform,
      browser: plan.browser,
      documentsAtError,
      documentsAfterHold,
      heldBanner: held.banner,
      retryFlag: failed.retryFlag,
      storedUrlIncludesEntry: Boolean(failed.storedUrl?.includes(assets.entry)),
      mapChunk: failed.mapChunk,
      recoveredCanvas: recovered.canvas,
      markerInside: recovered.markerInside,
      track: recovered.track,
      recoveredError: recovered.banner.includes("Map couldn't load"),
      stylesheet: recovered.stylesheet,
      flagsCleared: recovered.flagsCleared,
      recoveredWidth: recovered.width,
      recoveredHeight: recovered.height,
    };
    const failures = mapImportFailures(sample);
    const tabNote = sample.platform === 'darwin' && sample.browser === 'webkit' && !sample.tabbable ? 'tab platform' : 'tab retry';
    const note = `map import ${plan.id} created-at-size ${plan.width}x${plan.height} retry ${Math.round(sample.retryWidth)}x${Math.round(sample.retryHeight)} hold 10s ${tabNote} recovered canvas ${sample.recoveredCanvas}`;
    writeFileSync(join(evidenceDir, `map-import-${plan.id}.txt`), `${note}\n`);
    if (failures.length) throw new Error(`${failures.join('; ')}\n${note}\nhref ${recovered.href}`);
    return note;
  } catch (error) {
    if (page) await page.screenshot({ path: join(evidenceDir, `map-import-${plan.id}-failed.png`) }).catch(() => {});
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await hosted.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  driveMapImport().then((note) => {
    console.log(note);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
