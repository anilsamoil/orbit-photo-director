import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { webkit, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freezeDate } from './freeze-date';
import fixture from './fixtures/joint-panels.json';

if (!existsSync(webkit.executablePath())) throw new Error(`WebKit is required at ${webkit.executablePath()}`);

const root = resolve(__dirname, '..');
const origin = 'http://127.0.0.1:45123';
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve(root, 'public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const meta = JSON.parse(fixture['meta.json']) as { now: number; pad: { lat: number; lon: number } };
const bodies = legacyBodies();
type HitEvent = { type: string; trusted: boolean; target: string };
type TestWindow = Window & { __opdMap: import('maplibre-gl').Map; __legacyHits: HitEvent[] };
let assets: Map<string, string | Uint8Array>;
let script: string;
let browser: Browser;

function legacyBodies(): Record<string, string> {
  const passes = JSON.parse(fixture['passes.json']) as Array<Record<string, unknown>>;
  passes.push({
    ...passes[0],
    target_id: 'launch:verify-legacy',
    target_name: 'Verify Legacy Launch',
    target_lat: meta.pad.lat,
    target_lon: meta.pad.lon,
    launch: {
      name: 'Verify Legacy Launch',
      rocket_type: 'Fixture Rocket',
      site_name: 'Fixture Pad',
      geometry: 'ascent',
      kind: 'ascent',
      net_window_seconds: 0,
      t0: new Date(meta.now + 2 * 3_600_000).toISOString(),
      pad_lat: meta.pad.lat,
      pad_lon: meta.pad.lon,
    },
  });
  const passesBody = JSON.stringify(passes);
  const manifest = JSON.parse(fixture['manifest.json']) as { artifacts: { passes: { sha256: string; bytes: number } } };
  manifest.artifacts.passes.sha256 = createHash('sha256').update(passesBody).digest('hex');
  manifest.artifacts.passes.bytes = Buffer.byteLength(passesBody);
  return { ...fixture, 'passes.json': passesBody, 'manifest.json': JSON.stringify(manifest) };
}

beforeAll(async () => {
  const output = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    define: { __APP_VERSION__: JSON.stringify('legacy-launch-card-test') },
    build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'legacyLaunchCard', formats: ['iife'] } },
  });
  const bundle = Array.isArray(output) ? output[0]! : output;
  if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
  assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
  browser = await webkit.launch({ headless: true, executablePath: webkit.executablePath() });
}, 90_000);

afterAll(async () => {
  await browser?.close();
});

async function prepare(page: Page) {
  await freezeDate(page, meta.now);
  await page.addInitScript(() => {
    localStorage.setItem('opd-map-chrome', 'shown');
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    const state = window as unknown as TestWindow;
    state.__legacyHits = [];
    for (const type of ['click', 'pointerup'] as const) {
      document.addEventListener(type, (event) => {
        const target = event.target as Element;
        state.__legacyHits.push({
          type,
          trusted: event.isTrusted,
          target: target.id || (typeof target.className === 'string' ? target.className : target.tagName),
        });
      }, true);
    }
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: html.replace('</head>', `<style>${vendor}\n${stylesheet}</style></head>`).replace('</body>', `<script src="/${script}"></script></body>`),
      });
    }
    const asset = assets.get(url.pathname);
    if (url.origin === origin && asset !== undefined) {
      return route.fulfill({
        contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: typeof asset === 'string' ? asset : Buffer.from(asset),
      });
    }
    if (url.pathname.startsWith('/launch/')) return route.fulfill({ status: 404, body: 'No launch artifact' });
    const name = url.pathname === '/manifest.json' ? 'manifest.json' : url.pathname.startsWith('/v/verify/') ? url.pathname.split('/').pop()! : '';
    if (name && name in bodies) return route.fulfill({ contentType: 'application/json', body: bodies[name]! });
    if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'legacy-launch', displayName: 'Local fixture' } } });
    if (url.pathname.startsWith('/api/browser/profiles/')) return route.fulfill({ json: { ok: true, targets: [], count: 0 } });
    if (url.pathname === '/api/kp') return route.fulfill({ json: { kp: 3, timestamp: new Date(meta.now).toISOString(), age_min: 5 } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
    if (/\.(png|jpe?g)$/.test(url.pathname) || url.pathname.includes('/MapServer/tile/')) return route.fulfill({ contentType: 'image/png', body: raster });
    return route.abort();
  });
  await page.goto(`${origin}/?e2e&u=legacy-launch`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const map = (window as unknown as TestWindow).__opdMap;
    return map?.isStyleLoaded() && !!map.getSource('iss-track');
  });
  if (await page.locator('#toggle-follow-iss').getAttribute('aria-pressed') === 'true') await page.locator('#toggle-follow-iss').click();
  expect(await page.locator('#map-chrome-toggle').getAttribute('aria-expanded')).toBe('true');
  await page.locator('#filter-launches-map').click();
  await page.evaluate(({ lat, lon }) => {
    (window as unknown as TestWindow).__opdMap.jumpTo({ center: [lon, lat], zoom: 4 });
  }, meta.pad);
  await page.waitForFunction(() => {
    const map = (window as unknown as TestWindow).__opdMap;
    const panel = document.getElementById('map-launch-coverage');
    const box = panel?.getBoundingClientRect();
    return !panel?.hidden && !!box && box.width > 64 && box.height > 32
      && map.queryRenderedFeatures({ layers: ['ascent-pad-layer'] }).some((feature) => feature.properties?.target_id === 'launch:verify-legacy');
  });
}

async function padPoint(page: Page) {
  return page.evaluate(({ lat, lon }) => {
    const map = (window as unknown as TestWindow).__opdMap;
    const projected = map.project([lon, lat]);
    const box = map.getCanvas().getBoundingClientRect();
    const x = box.x + projected.x;
    const y = box.y + projected.y;
    const hit = document.elementFromPoint(x, y);
    return {
      x, y,
      hit: hit?.id || (typeof hit?.className === 'string' ? hit.className : hit?.tagName) || 'none',
    };
  }, meta.pad);
}

describe('legacy launch card', () => {
  it('opens from a trusted tap when controls are shown in landscape', async () => {
    const context = await browser.newContext({
      viewport: { width: 874, height: 402 },
      screen: { width: 874, height: 402 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      serviceWorkers: 'block',
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await prepare(page);
      const point = await padPoint(page);
      await page.touchscreen.tap(point.x, point.y);
      const opened = await page.locator('.launch-ascent-card[data-launch="legacy"]').waitFor({ timeout: 4_000 }).then(() => true, () => false);
      const hits = await page.evaluate(() => (window as unknown as TestWindow).__legacyHits);
      expect(hits.some((event) => event.type === 'click' && event.trusted), JSON.stringify({ point, hits })).toBe(true);
      expect(opened, `tap at ${point.x},${point.y} hit ${point.hit}`).toBe(true);
    } finally {
      await context.close();
    }
  }, 45_000);

  it('gives the portrait scrollport a usable width and a height above the 66.5px band', async () => {
    const context = await browser.newContext({
      viewport: { width: 402, height: 874 },
      screen: { width: 402, height: 874 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      serviceWorkers: 'block',
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await prepare(page);
      const point = await padPoint(page);
      await page.touchscreen.tap(point.x, point.y);
      await page.locator('.launch-ascent-card[data-launch="legacy"]').waitFor();
      const scroll = await page.locator('.maplibregl-popup-content').evaluate((element) => ({
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
      }));
      expect(scroll.clientWidth, JSON.stringify(scroll)).toBeGreaterThanOrEqual(200);
      expect(scroll.clientHeight, JSON.stringify(scroll)).toBeGreaterThanOrEqual(160);
    } finally {
      await context.close();
    }
  }, 45_000);
});
