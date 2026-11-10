import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Page } from 'playwright';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { freezeDate } from './freeze-date';
import type { Manifest, Track } from '../src/types';

const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const root = resolve(__dirname, '..');
const base = `http://127.0.0.1:${process.env.OPD_CHROME_IDLE_PORT ?? 45121}`;
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve(root, 'public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const now = '2026-10-14T12:00:00Z';
const track: Track = {
  iss_polynomial: { start: now, duration_seconds: 7200, lat_coeffs: [0], lon_coeffs: [0], polynomial_order: 0 },
  track_points: [[0, 0, 0], [7200, 0, 30]],
  tle_epoch: now, tle_age_hours: 0, tle_freshness_factor: 1,
};
const artifacts = Object.fromEntries(Object.entries({ top5: [], top_24h: [], passes: [], track, targets: [] }).map(([name, value]) => [name, JSON.stringify(value)]));
const manifest: Manifest = {
  version: '20261014T120000Z', generated_at: now, tle_epoch: now, cloud_composite_hour: now,
  target_data_version: 'fixture', build_version: 'fixture', freshness: { tle_hours: 0, cloud_hours: 0, ok: true },
  artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, body]) => [name, {
    path: `v/idle/${name}.json`, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body),
  }])),
};
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const idleMs = Number(process.env.OPD_CHROME_IDLE_MS ?? 2100);
async function boot(page: Page, assets: Map<string, string | Uint8Array>, script: string): Promise<void> {
  await freezeDate(page, now);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html.replace('</head>', `<style>${vendor}\n${stylesheet}</style></head>`).replace('</body>', `<script src="/${script}"></script></body>`) });
    const asset = assets.get(url.pathname);
    if (url.origin === base && asset !== undefined) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: typeof asset === 'string' ? asset : Buffer.from(asset) });
    if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'idle-fixture', displayName: 'Idle fixture' } } });
    if (url.pathname === '/manifest.json') return route.fulfill({ json: manifest });
    if (url.pathname.startsWith('/v/idle/')) {
      const body = artifacts[url.pathname.split('/').pop()!.replace('.json', '')];
      return route.fulfill({ contentType: 'application/json', body: body ?? '[]' });
    }
    if (url.pathname.startsWith('/api/browser/profiles/')) return route.fulfill({ json: { ok: true, count: 0, targets: [] } });
    if (url.pathname === '/api/log') return route.fulfill({ json: { entries: [] } });
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/launch/')) return route.fulfill({ status: 404, json: {} });
    if (/\.(png|jpe?g)$/.test(url.pathname) || url.pathname.includes('/MapServer/tile/')) {
      return route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: raster });
    }
    return route.abort();
  });
  await page.goto(`${base}/?e2e`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as Window & { __opdMap?: { isStyleLoaded(): boolean } }).__opdMap?.isStyleLoaded(), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('.tab') : null;
      if (target) target.setAttribute('data-last-click-trusted', String(event.isTrusted));
    }, true);
  });
}

async function idleWrites(page: Page): Promise<{ class: number; style: number }> {
  return page.evaluate(async (duration) => {
    const writes = { class: 0, style: 0 };
    const observer = new MutationObserver((records) => {
      for (const record of records) writes[record.attributeName as 'class' | 'style'] += 1;
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    await new Promise((resolve) => setTimeout(resolve, duration));
    observer.disconnect();
    return writes;
  }, idleMs);
}

async function slots(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.body.classList].filter((name) => name.startsWith('map-slot-')).sort());
}

for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
]) describe.skipIf(!existsSync(engine.executablePath))(`map chrome tab lifecycle ${engine.name}`, () => {
  let assets: Map<string, string | Uint8Array>;
  let script: string;
  beforeAll(async () => {
    const output = await build({
      configFile: false, root, logLevel: 'silent',
      define: { __APP_VERSION__: JSON.stringify('idle-fixture') },
      build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'idle', formats: ['iife'] } },
    });
    const bundle = Array.isArray(output) ? output[0]! : output;
    if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
    assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
    script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
  }, 60_000);
  it.each(['queue', 'profile'].flatMap((tab) => [
    { tab, width: 1440, height: 900, shown: false },
    { tab, width: 719, height: 521, shown: true },
  ]))('stays idle after trusted Map → $tab → Map clicks at $width×$height', async ({ tab, width, height, shown }) => {
    const browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath });
    try {
      const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        await boot(page, assets, script);
        await page.locator('#tab-map').click();
        if (shown) await page.locator('#map-chrome-toggle').click();
        await page.waitForTimeout(500);
        const before = await slots(page);
        if (shown) expect(before).toContain('map-slot-time');
        await page.locator(`#tab-${tab}`).click();
        await page.waitForFunction((name) => document.querySelector('#view')?.className === `view-${name}`, tab);
        await page.waitForTimeout(500);
        expect(await page.locator(`#tab-${tab}`).getAttribute('data-last-click-trusted')).toBe('true');
        expect(await slots(page)).toEqual([]);
        const offMap = await idleWrites(page);
        await page.locator('#tab-map').click();
        await page.waitForFunction(() => document.querySelector('#view')?.className === 'view-map');
        await page.waitForTimeout(500);
        expect(await page.locator('#tab-map').getAttribute('data-last-click-trusted')).toBe('true');
        expect(await slots(page)).toEqual(before);
        const onMap = await idleWrites(page);
        console.log(JSON.stringify({ engine: engine.name, tab, width, height, idleMs, offMap, onMap, restoredSlots: before }));
        expect(offMap).toEqual({ class: 0, style: 0 });
        expect(onMap).toEqual({ class: 0, style: 0 });
      } finally { await context.close(); }
    } finally { await browser.close(); }
  }, 60_000);
});
