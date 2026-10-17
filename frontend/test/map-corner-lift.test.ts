import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, devices, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Manifest, Track } from '../src/types';

const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!existsSync(webkit.executablePath())) throw new Error(`WebKit is required at ${webkit.executablePath()}`);
const root = resolve(__dirname, '..');
const origin = 'http://127.0.0.1:45141';
const iphone17 = devices['iPhone 17 Pro']?.viewport
  ? devices['iPhone 17 Pro']
  : {
    ...devices['iPhone 13'],
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: 'webkit' as const,
  };
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
    path: `v/lift/${name}.json`, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body),
  }])),
};
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const tallBanner = 'Orbit ready<br>Second status line<br>Third status line';

type HideBox = {
  lift: string;
  label: string;
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

async function boot(page: Page, assets: Map<string, string | Uint8Array>, script: string): Promise<void> {
  await page.clock.setFixedTime(new Date(now));
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
    if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'lift-fixture', displayName: 'Lift fixture' } } });
    if (url.pathname === '/manifest.json') return route.fulfill({ json: manifest });
    if (url.pathname.startsWith('/v/lift/')) {
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
  await page.goto(`${origin}/?e2e`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const map = (window as Window & { __opdMap?: { isStyleLoaded(): boolean }; __opdSyncMapChrome?: () => void }).__opdMap;
    return !!map?.isStyleLoaded() && !!(window as Window & { __opdSyncMapChrome?: () => void }).__opdSyncMapChrome;
  }, undefined, { timeout: 20_000 });
  await page.locator('#tab-map').click();
  await page.evaluate(() => document.fonts.ready);
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)))));
}

async function hideBox(page: Page): Promise<HideBox> {
  return page.evaluate(() => {
    const el = document.getElementById('map-chrome-toggle')!;
    const r = el.getBoundingClientRect();
    return {
      lift: document.body.style.getPropertyValue('--map-corner-lift'),
      label: el.textContent ?? '',
      top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height,
    };
  });
}

async function showChrome(page: Page): Promise<void> {
  const toggle = page.locator('#map-chrome-toggle');
  if ((await toggle.textContent()) === 'Controls') await toggle.click();
  await frames(page);
  expect(await toggle.textContent()).toBe('Hide');
}

async function cycle(page: Page, times: number, expected: HideBox): Promise<void> {
  const toggle = page.locator('#map-chrome-toggle');
  for (let i = 0; i < times; i++) {
    await toggle.click();
    await frames(page);
    expect(await toggle.textContent()).toBe('Controls');
    await toggle.click();
    await frames(page);
    expect(await hideBox(page)).toEqual(expected);
  }
}

async function holdTallBanner(page: Page): Promise<void> {
  await page.evaluate((content) => {
    const element = document.getElementById('status-banner')!;
    const apply = () => {
      if (element.innerHTML !== content) element.innerHTML = content;
      if (element.querySelector('.banner-actions')) element.querySelector('.banner-actions')!.remove();
    };
    apply();
    new MutationObserver(apply).observe(element, { childList: true, subtree: true, characterData: true });
  }, tallBanner);
  await page.evaluate(() => (window as Window & { __opdSyncMapChrome?: () => void }).__opdSyncMapChrome?.());
  await frames(page);
}

let assets: Map<string, string | Uint8Array>;
let script: string;

beforeAll(async () => {
  const output = await build({
    configFile: false, root, logLevel: 'silent',
    define: { __APP_VERSION__: JSON.stringify('lift-fixture') },
    build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'lift', formats: ['iife'] } },
  });
  const bundle = Array.isArray(output) ? output[0]! : output;
  if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
  assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
}, 60_000);

for (const engine of [
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
]) describe.skipIf(engine.name === 'Chrome' && !existsSync(engine.executablePath))(`map corner lift ${engine.name}`, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath });
  }, 30_000);
  afterAll(async () => { await browser?.close(); });

  async function contextAt(width: number, height: number): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      ...iphone17,
      viewport: { width, height },
      serviceWorkers: 'block',
    });
    if (engine.name === 'WebKit') {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      });
    }
    const page = await context.newPage();
    await boot(page, assets, script);
    return { context, page };
  }

  it('keeps Hide in the same place across five show/hide cycles at 402x874', async () => {
    const { context, page } = await contextAt(402, 874);
    try {
      await showChrome(page);
      const plain = await hideBox(page);
      await cycle(page, 5, plain);

      await holdTallBanner(page);
      await showChrome(page);
      const raised = await hideBox(page);
      expect(raised.lift.endsWith('px')).toBe(true);
      expect(Number.parseFloat(raised.lift)).toBeGreaterThan(0);
      const banner = await page.locator('#status-banner').boundingBox();
      expect(banner!.height).toBeGreaterThan(30);
      await page.clock.fastForward(3000);
      await frames(page);
      expect(await hideBox(page)).toEqual(raised);
      await cycle(page, 5, raised);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('lifts Hide for the wrapped banner before the next read on return to 402x874', async () => {
    const { context, page } = await contextAt(402, 874);
    try {
      await showChrome(page);
      await page.evaluate(() => {
        document.getElementById('status-banner')!.textContent = 'Last updated 4 min ago · TLE 499h old — live track may drift';
      });
      await frames(page);
      await page.setViewportSize({ width: 932, height: 430 });
      await frames(page);
      await page.setViewportSize({ width: 402, height: 874 });
      const immediate = await hideBox(page);
      await frames(page);
      const settled = await hideBox(page);
      const place = ({ lift, top, bottom }: HideBox) => ({ lift, top, bottom });
      expect(Number.parseFloat(settled.lift)).toBeGreaterThan(0);
      expect(place(immediate)).toEqual(place(settled));
      await page.locator('#map-chrome-toggle').click();
      await frames(page);
      await page.locator('#map-chrome-toggle').click();
      await frames(page);
      expect(place(await hideBox(page))).toEqual(place(settled));
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps a fully scrolled Layers dock and a coordinate picker click through sync ticks at 1280x800', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await boot(page, assets, script);
      await showChrome(page);
      const scrolled = await page.evaluate(() => {
        const dock = document.querySelector('.map-control-dock');
        if (!(dock instanceof HTMLElement)) return null;
        dock.scrollTop = dock.scrollHeight;
        const button = document.getElementById('toggle-satellite-picker')!;
        const rect = button.getBoundingClientRect();
        return {
          scrollTop: dock.scrollTop,
          overflow: dock.scrollHeight - dock.clientHeight,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
      });
      expect(scrolled).not.toBeNull();
      expect(scrolled!.overflow).toBeGreaterThan(20);
      expect(scrolled!.scrollTop).toBeGreaterThan(20);
      await page.evaluate(() => {
        const writes: string[] = [];
        (window as unknown as { __styleWrites: string[] }).__styleWrites = writes;
        new MutationObserver((records) => {
          for (const record of records) writes.push(record.attributeName ?? '');
        }).observe(document.body, { attributes: true, attributeFilter: ['style'] });
      });
      await page.clock.fastForward(3000);
      await frames(page);
      const after = await page.evaluate(() => ({
        scrollTop: (document.querySelector('.map-control-dock') as HTMLElement).scrollTop,
        writes: (window as unknown as { __styleWrites: string[] }).__styleWrites.length,
      }));
      expect(after.scrollTop).toBe(scrolled!.scrollTop);
      expect(after.writes).toBe(0);
      await page.mouse.click(scrolled!.x, scrolled!.y);
      await frames(page);
      await expect(page.locator('#satellite-picker-panel')).toBeVisible();
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps T+90 inside the 390x520 viewport when the time strip is visible', async () => {
    const { context, page } = await contextAt(390, 520);
    try {
      await showChrome(page);
      const box = await page.evaluate(() => {
        const el = document.getElementById('time-fwd-90')!;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          top: r.top, bottom: r.bottom, height: r.height, display: style.display,
          innerHeight: window.innerHeight,
        };
      });
      expect(box.display).not.toBe('none');
      expect(box.height).toBeGreaterThan(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(box.innerHeight);
    } finally {
      await context.close();
    }
  }, 60_000);
});
