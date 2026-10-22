import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, devices, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Manifest, Track } from '../src/types';
import { freezeDate } from './freeze-date';
import { closeBrowser, launchTracked, type TrackedBrowser } from './close-browser.mjs';

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

type Insets = { top: number; right: number; bottom: number; left: number };

function cssForInsets(insets: Insets | undefined, engineName: string): string {
  if (!insets || engineName !== 'WebKit') return stylesheet;
  return stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof Insets) => `${insets[side]}px`);
}

function insetHook(insets: Insets): string {
  return `<script>(function () {
    var values = ${JSON.stringify(insets)};
    var styleDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style');
    if (!styleDesc || !styleDesc.get) return;
    var replace = function (value) {
      return String(value).replace(/env\\(safe-area-inset-(top|right|bottom|left)(?:\\s*,[^)]*)?\\)/g, function (_, side) { return values[side] + 'px'; });
    };
    Object.defineProperty(HTMLElement.prototype, 'style', {
      configurable: true,
      enumerable: styleDesc.enumerable,
      get: function () {
        var style = styleDesc.get.call(this);
        return new Proxy(style, {
          get: function (target, prop) {
            var value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
          set: function (target, prop, value) {
            target[prop] = typeof value === 'string' ? replace(value) : value;
            return true;
          },
        });
      },
    });
  })();</script>`;
}

async function boot(page: Page, assets: Map<string, string | Uint8Array>, script: string, lateFooter = false, css = stylesheet, hook = '', e2e = true): Promise<void> {
  await freezeDate(page, now);
  const documentHtml = lateFooter ? html.replace(/<footer id="status-banner"[\s\S]*?<\/footer>\s*/, '') : html;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: documentHtml.replace('</head>', `${hook}<style>${vendor}\n${css}</style></head>`).replace('</body>', `<script src="/${script}"></script></body>`),
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
  await page.goto(e2e ? `${origin}/?e2e` : `${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const view = window as Window & { __opdMap?: { isStyleLoaded(): boolean }; __opdSyncMapChrome?: () => void };
    if (!view.__opdSyncMapChrome) return false;
    if (!new URLSearchParams(location.search).has('e2e')) return true;
    return !!view.__opdMap?.isStyleLoaded();
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
    mode: 'production',
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
  let session: TrackedBrowser | undefined;

  beforeAll(async () => {
    session = await launchTracked(engine.type, { headless: true, executablePath: engine.executablePath });
    browser = session.browser;
  }, 30_000);
  afterAll(async () => { await closeBrowser(session, `corner-lift-${engine.name}`); });

  async function contextAt(width: number, height: number, lateFooter = false, insets?: Insets, trackFooters = false, e2e = true, countFrames = false): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      ...iphone17,
      viewport: { width, height },
      serviceWorkers: 'block',
    });
    try {
      if (trackFooters) {
        await context.addInitScript(() => {
          const targets = new Set<Element>();
          const observe = ResizeObserver.prototype.observe;
          const unobserve = ResizeObserver.prototype.unobserve;
          ResizeObserver.prototype.observe = function (target: Element) {
            if (target instanceof Element && target.id === 'status-banner') targets.add(target);
            return observe.call(this, target);
          };
          ResizeObserver.prototype.unobserve = function (target: Element) {
            targets.delete(target);
            return unobserve.call(this, target);
          };
          (window as unknown as { __footerResizeTargets: () => { connected: boolean }[] }).__footerResizeTargets = () =>
            [...targets].map((node) => ({ connected: node.isConnected }));
        });
      }
      if (countFrames) {
        await context.addInitScript(() => {
          const view = window as unknown as { __rafs: number; __ros: number };
          view.__rafs = 0;
          view.__ros = 0;
          const raf = window.requestAnimationFrame.bind(window);
          window.requestAnimationFrame = (callback: FrameRequestCallback) => raf((time) => {
            view.__rafs += 1;
            callback(time);
          });
          const Native = window.ResizeObserver;
          const Counting = function (this: ResizeObserver, callback: ResizeObserverCallback): ResizeObserver {
            return new Native((entries, observer) => {
              view.__ros += 1;
              callback(entries, observer);
            });
          };
          Counting.prototype = Native.prototype;
          window.ResizeObserver = Counting as unknown as typeof ResizeObserver;
        });
      }
      if (engine.name === 'WebKit') {
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
        });
      }
      const page = await context.newPage();
      if (insets && engine.name === 'Chrome') {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
      }
      const hook = insets && engine.name === 'WebKit' ? insetHook(insets) : '';
      await boot(page, assets, script, lateFooter, cssForInsets(insets, engine.name), hook, e2e);
      return { context, page };
    } catch (error) {
      await context.close();
      throw error;
    }
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
      const banner = await page.locator('#status-banner').boundingBox();
      expect(banner!.height).toBeGreaterThan(30);
      expect(raised.bottom).toBeLessThanOrEqual(banner!.y - 7);
      await page.waitForTimeout(3000);
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
        const element = document.getElementById('status-banner')!;
        const text = 'Last updated 4 min ago · TLE 499h old — live track may drift';
        const apply = () => { if (element.textContent !== text) element.textContent = text; };
        apply();
        new MutationObserver(apply).observe(element, { childList: true, subtree: true, characterData: true });
      });
      await frames(page);
      await page.setViewportSize({ width: 932, height: 430 });
      await frames(page);
      await page.setViewportSize({ width: 402, height: 874 });
      const immediate = await hideBox(page);
      await frames(page);
      const settled = await hideBox(page);
      const place = ({ top, bottom }: HideBox) => ({ top, bottom });
      const banner = await page.locator('#status-banner').boundingBox();
      expect(banner!.height).toBeGreaterThan(30);
      expect(immediate.bottom).toBeLessThanOrEqual(banner!.y - 7);
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

  it('keeps Hide still under a trusted tap that returns to 402x874 before any resize event', async () => {
    const { context, page } = await contextAt(402, 874);
    try {
      await showChrome(page);
      await page.evaluate(() => {
        const element = document.getElementById('status-banner')!;
        const text = 'Last updated 4 min ago · TLE 499h old — live track may drift';
        const apply = () => { if (element.textContent !== text) element.textContent = text; };
        apply();
        new MutationObserver(apply).observe(element, { childList: true, subtree: true, characterData: true });
        const toggle = document.getElementById('map-chrome-toggle')!;
        const log: { type: string; top: number; bottom: number; lift: string; bannerTop: number; bannerH: number }[] = [];
        (window as unknown as { __tapLog: typeof log }).__tapLog = log;
        for (const type of ['pointerdown', 'pointerup', 'click']) {
          toggle.addEventListener(type, () => {
            const box = toggle.getBoundingClientRect();
            const banner = element.getBoundingClientRect();
            log.push({
              type,
              top: box.top,
              bottom: box.bottom,
              lift: document.body.style.getPropertyValue('--map-corner-lift'),
              bannerTop: banner.top,
              bannerH: banner.height,
            });
          }, true);
        }
      });
      await frames(page);
      const point = await page.evaluate(() => {
        const box = document.getElementById('map-chrome-toggle')!.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      const jumps: { from: string; rep: number; down: unknown; afterTop: number }[] = [];
      for (const from of [{ width: 932, height: 430 }, { width: 874, height: 402 }]) {
        for (let rep = 0; rep < 12; rep++) {
          if ((await page.locator('#map-chrome-toggle').textContent()) !== 'Hide') {
            await page.touchscreen.tap(point.x, point.y);
            await frames(page);
          }
          await page.setViewportSize(from);
          await frames(page);
          const mark = await page.evaluate(() => (window as unknown as { __tapLog: unknown[] }).__tapLog.length);
          await page.setViewportSize({ width: 402, height: 874 });
          await page.touchscreen.tap(point.x, point.y);
          const sample = await page.evaluate((start) => {
            const log = (window as unknown as { __tapLog: { type: string; top: number; bottom: number; lift: string; bannerTop: number; bannerH: number }[] }).__tapLog;
            const down = log.slice(start).find((entry) => entry.type === 'pointerdown') ?? null;
            const after = document.getElementById('map-chrome-toggle')!.getBoundingClientRect();
            return { down, afterTop: after.top, afterBottom: after.bottom };
          }, mark);
          const down = sample.down;
          const moved = !down || Math.abs(down.top - sample.afterTop) > 1 || down.bannerH <= 30 || down.bottom > down.bannerTop - 7;
          if (moved) jumps.push({ from: `${from.width}x${from.height}`, rep, down, afterTop: sample.afterTop });
        }
      }
      expect(jumps).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);

  it('updates the corner lift when a late footer wraps and a trusted tap leaves Hide still', async () => {
    const { context, page } = await contextAt(402, 874, true);
    try {
      await showChrome(page);
      expect(await page.locator('#status-banner').count()).toBe(0);
      await page.evaluate(() => {
        const created = document.createElement('footer');
        created.id = 'status-banner';
        created.className = 'banner banner-orange';
        created.textContent = 'Track ready';
        document.body.appendChild(created);
      });
      await frames(page);
      const before = await hideBox(page);
      const short = await page.locator('#status-banner').boundingBox();
      await page.evaluate(() => {
        (window as unknown as { __resizes: number }).__resizes = 0;
        window.addEventListener('resize', () => {
          (window as unknown as { __resizes: number }).__resizes += 1;
        });
        const element = document.getElementById('status-banner')!;
        const text = 'Last updated 4 min ago · TLE 499h old — live track may drift';
        const apply = () => { if (element.textContent !== text) element.textContent = text; };
        apply();
        new MutationObserver(apply).observe(element, { childList: true, subtree: true, characterData: true });
      });
      await page.waitForFunction((floor) => {
        const banner = document.getElementById('status-banner')!.getBoundingClientRect();
        const toggle = document.getElementById('map-chrome-toggle')!.getBoundingClientRect();
        return banner.height > floor && banner.height > 30 && toggle.bottom <= banner.top - 7;
      }, short!.height);
      const settled = await hideBox(page);
      const banner = await page.locator('#status-banner').boundingBox();
      const resizes = await page.evaluate(() => (window as unknown as { __resizes: number }).__resizes);
      expect(resizes).toBe(0);
      expect(banner!.height).toBeGreaterThan(short!.height);
      expect(banner!.height).toBeGreaterThan(30);
      expect(settled.lift).not.toBe(before.lift);
      expect(settled.bottom).toBeLessThanOrEqual(banner!.y - 7);
      const point = await page.evaluate(() => {
        const toggle = document.getElementById('map-chrome-toggle')!;
        const tops: number[] = [];
        (window as unknown as { __tapTops: number[] }).__tapTops = tops;
        toggle.addEventListener('pointerdown', () => {
          tops.push(toggle.getBoundingClientRect().top);
        }, true);
        const box = toggle.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      await page.touchscreen.tap(point.x, point.y);
      await frames(page);
      const tops = await page.evaluate(() => (window as unknown as { __tapTops: number[] }).__tapTops);
      expect(tops).toEqual([settled.top]);
      expect((await hideBox(page)).top).toBe(settled.top);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps Hide still when footer height changes and the trusted tap does not wait for a frame', async () => {
    const insets = { top: 62, right: 0, bottom: 34, left: 0 };
    const { context, page } = await contextAt(402, 874, false, insets);
    try {
      await showChrome(page);
      const measuredInsets = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.paddingTop = 'env(safe-area-inset-top, 0px)';
        probe.style.paddingRight = 'env(safe-area-inset-right, 0px)';
        probe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
        probe.style.paddingLeft = 'env(safe-area-inset-left, 0px)';
        document.body.appendChild(probe);
        const style = getComputedStyle(probe);
        const read = (name: 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft') => Number.parseFloat(style[name]) || 0;
        const value = { top: read('paddingTop'), right: read('paddingRight'), bottom: read('paddingBottom'), left: read('paddingLeft') };
        probe.remove();
        return value;
      });
      expect(measuredInsets).toEqual(insets);
      await page.evaluate(() => {
        const toggle = document.getElementById('map-chrome-toggle')!;
        const log: { type: string; top: number; lift: string; target: string }[] = [];
        (window as unknown as { __heightTap: typeof log }).__heightTap = log;
        for (const type of ['pointerdown', 'pointerup', 'click']) {
          toggle.addEventListener(type, (event) => {
            const box = toggle.getBoundingClientRect();
            const target = event.target instanceof Element ? event.target.id : '';
            log.push({
              type,
              top: box.top,
              lift: document.body.style.getPropertyValue('--map-corner-lift'),
              target,
            });
          }, true);
        }
      });
      const misses: { mode: string; rep: number; aimTop: number; lift: string; tops: number[]; targets: string[]; lifts: string[] }[] = [];
      for (const mode of ['product', 'replaced']) {
        if (mode === 'replaced') {
          await page.evaluate(() => {
            const current = document.getElementById('status-banner')!;
            const replacement = document.createElement('footer');
            replacement.id = current.id;
            replacement.className = current.className;
            replacement.textContent = current.textContent;
            current.replaceWith(replacement);
          });
        }
        for (let rep = 0; rep < 20; rep++) {
          if ((await page.locator('#map-chrome-toggle').textContent()) !== 'Hide') {
            await page.locator('#map-chrome-toggle').click();
            await frames(page);
          }
          await page.evaluate(() => { document.getElementById('status-banner')!.style.height = ''; });
          await page.evaluate(() => { document.getElementById('status-banner')!.style.height = '140px'; });
          const aim = await page.evaluate(() => {
            const toggle = document.getElementById('map-chrome-toggle')!;
            const box = toggle.getBoundingClientRect();
            const footer = document.getElementById('status-banner')!.getBoundingClientRect();
            (window as unknown as { __heightTap: unknown[] }).__heightTap.length = 0;
            return {
              x: box.x + box.width / 2,
              y: box.y + box.height / 2,
              top: box.top,
              bottom: box.bottom,
              lift: document.body.style.getPropertyValue('--map-corner-lift'),
              footerTop: footer.top,
              footerH: footer.height,
            };
          });
          await page.touchscreen.tap(aim.x, aim.y);
          const log = await page.evaluate(() => (window as unknown as { __heightTap: { type: string; top: number; lift: string; target: string }[] }).__heightTap);
          const tops = log.map((entry) => entry.top);
          const targets = log.map((entry) => entry.target);
          const lifts = log.map((entry) => entry.lift);
          const moved = aim.footerH < 100
            || aim.lift === '0px'
            || aim.bottom > aim.footerTop - 7
            || log.length !== 3
            || tops.some((top) => top !== aim.top)
            || targets.some((target) => target !== 'map-chrome-toggle')
            || lifts.some((lift) => lift !== aim.lift);
          if (moved) misses.push({ mode, rep, aimTop: aim.top, lift: aim.lift, tops, targets, lifts });
        }
      }
      expect(misses).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('keeps a fully scrolled Layers dock and a coordinate picker click through sync ticks at 1280x800', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
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
      await page.waitForTimeout(3000);
      await frames(page);
      const after = await page.evaluate(() => ({
        scrollTop: (document.querySelector('.map-control-dock') as HTMLElement).scrollTop,
        writes: (window as unknown as { __styleWrites: string[] }).__styleWrites.length,
      }));
      expect(after.scrollTop).toBe(scrolled!.scrollTop);
      expect(after.writes).toBe(0);
      await page.mouse.click(scrolled!.x, scrolled!.y);
      await frames(page);
      const open = await page.evaluate(() => {
        const panel = document.getElementById('satellite-picker-panel');
        if (!panel || panel.hidden) return false;
        const rect = panel.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      expect(open).toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('clears the corner lift in the same frame when the footer is removed', async () => {
    const { context, page } = await contextAt(402, 874, false, undefined, false, true, true);
    try {
      await showChrome(page);
      await page.evaluate(() => {
        document.getElementById('status-banner')!.style.height = '160px';
      });
      const raised = await hideBox(page);
      expect(Number.parseFloat(raised.lift)).toBeGreaterThan(0);
      const cleared = await page.evaluate(async () => {
        const view = window as unknown as { __rafs: number; __ros: number };
        view.__rafs = 0;
        view.__ros = 0;
        document.getElementById('status-banner')!.remove();
        await Promise.resolve();
        await Promise.resolve();
        return {
          lift: document.body.style.getPropertyValue('--map-corner-lift'),
          rafs: view.__rafs,
          ros: view.__ros,
          gone: document.getElementById('status-banner') === null,
        };
      });
      expect(cleared.rafs).toBe(0);
      expect(cleared.ros).toBe(0);
      expect(cleared.lift).toBe('0px');
      expect(cleared.gone).toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('follows a replacement footer and ignores the detached one', async () => {
    const { context, page } = await contextAt(402, 874, false, undefined, true);
    try {
      await showChrome(page);
      await page.evaluate(() => {
        document.getElementById('status-banner')!.style.height = '80px';
      });
      const before = await hideBox(page);
      expect(Number.parseFloat(before.lift)).toBeGreaterThan(0);
      await page.evaluate(() => {
        const old = document.getElementById('status-banner')!;
        const next = document.createElement('footer');
        next.id = 'status-banner';
        next.className = old.className;
        next.textContent = old.textContent ?? '';
        next.style.height = '80px';
        old.replaceWith(next);
        (window as unknown as { __oldFooter: HTMLElement }).__oldFooter = old;
      });
      await page.evaluate(() => {
        document.getElementById('status-banner')!.style.height = '180px';
      });
      const raised = await hideBox(page);
      expect(Number.parseFloat(raised.lift)).toBeGreaterThan(Number.parseFloat(before.lift));
      const scheduled = await page.evaluate(() => (window as unknown as { __opdCornerSyncs?: number }).__opdCornerSyncs);
      expect(scheduled).toBeGreaterThan(0);
      await page.evaluate(() => {
        (window as unknown as { __oldFooter: HTMLElement }).__oldFooter.style.height = '400px';
      });
      expect(await page.evaluate(() => (window as unknown as { __opdCornerSyncs?: number }).__opdCornerSyncs)).toBe(scheduled);
      expect((await hideBox(page)).lift).toBe(raised.lift);
      const targets = await page.evaluate(() => (window as unknown as { __footerResizeTargets: () => { connected: boolean }[] }).__footerResizeTargets());
      expect(targets).toEqual([{ connected: true }]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('schedules one sync when the detached footer is edited in the same task', async () => {
    const { context, page } = await contextAt(402, 874);
    try {
      await showChrome(page);
      const delta = await page.evaluate(() => new Promise<number>((resolve) => {
        const before = (window as unknown as { __opdCornerSyncs?: number }).__opdCornerSyncs ?? 0;
        const old = document.getElementById('status-banner')!;
        const next = document.createElement('footer');
        next.id = 'status-banner';
        next.className = old.className;
        next.textContent = old.textContent ?? '';
        old.replaceWith(next);
        old.textContent = `${old.textContent ?? ''} · detached`;
        queueMicrotask(() => {
          resolve(((window as unknown as { __opdCornerSyncs?: number }).__opdCornerSyncs ?? 0) - before);
        });
      }));
      expect(delta).toBe(1);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('does not publish the sync counter on a production page', async () => {
    const { context, page } = await contextAt(402, 874, false, undefined, false, false);
    try {
      await showChrome(page);
      const exposed = await page.evaluate(() => new Promise<boolean>((resolve) => {
        const banner = document.getElementById('status-banner');
        if (banner) banner.textContent = `${banner.textContent ?? ''} · extra`;
        queueMicrotask(() => resolve(Object.prototype.hasOwnProperty.call(window, '__opdCornerSyncs')));
      }));
      expect(exposed).toBe(false);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('schedules one sync for a footer mutation batch', async () => {
    const { context, page } = await contextAt(402, 874);
    try {
      await showChrome(page);
      const delta = await page.evaluate(() => new Promise<number>((resolve) => {
        const before = (window as unknown as { __opdCornerSyncs?: number }).__opdCornerSyncs ?? 0;
        const element = document.getElementById('status-banner')!;
        element.textContent = `${element.textContent ?? ''} · extra`;
        queueMicrotask(() => {
          resolve(((window as unknown as { __opdCornerSyncs?: number }).__opdCornerSyncs ?? 0) - before);
        });
      }));
      expect(delta).toBe(1);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('drops the corner-lift observers on pagehide so a mutation writes nothing', async () => {
    const { context, page } = await contextAt(402, 874);
    try {
      await showChrome(page);
      await page.evaluate(() => {
        document.getElementById('status-banner')!.style.height = '160px';
      });
      const raised = await hideBox(page);
      expect(Number.parseFloat(raised.lift)).toBeGreaterThan(0);
      const armed = await page.evaluate(() => (window as unknown as { __opdCornerObservers?: number }).__opdCornerObservers ?? 0);
      expect(armed).toBeGreaterThan(0);
      const hidden = await page.evaluate(() => new Promise<{ observers: number; writes: number; lift: string }>((resolve) => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        let writes = 0;
        const style = document.body.style;
        const setProperty = style.setProperty.bind(style);
        style.setProperty = (property: string, value: string, priority?: string) => {
          writes += 1;
          return setProperty(property, value, priority);
        };
        const banner = document.getElementById('status-banner')!;
        banner.style.height = '240px';
        banner.textContent = `${banner.textContent ?? ''} x`;
        document.body.classList.add('map-slot-probe');
        document.body.classList.remove('map-slot-probe');
        setTimeout(() => {
          resolve({
            observers: (window as unknown as { __opdCornerObservers?: number }).__opdCornerObservers ?? -1,
            writes,
            lift: document.body.style.getPropertyValue('--map-corner-lift'),
          });
        }, 50);
      }));
      expect(hidden.observers).toBe(0);
      expect(hidden.writes).toBe(0);
      expect(hidden.lift).toBe(raised.lift);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('lifts the corners again after a persisted pageshow', async () => {
    const { context, page } = await contextAt(402, 874);
    try {
      await showChrome(page);
      await page.evaluate(() => {
        document.getElementById('status-banner')!.style.height = '80px';
      });
      const before = await hideBox(page);
      expect(Number.parseFloat(before.lift)).toBeGreaterThan(0);
      const restored = await page.evaluate(() => new Promise<{ observers: number; lift: string }>((resolve) => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        const hidden = (window as unknown as { __opdCornerObservers?: number }).__opdCornerObservers ?? -1;
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        document.getElementById('status-banner')!.style.height = '200px';
        setTimeout(() => {
          resolve({
            observers: hidden === 0 ? ((window as unknown as { __opdCornerObservers?: number }).__opdCornerObservers ?? -1) : -1,
            lift: document.body.style.getPropertyValue('--map-corner-lift'),
          });
        }, 50);
      }));
      expect(restored.observers).toBeGreaterThan(0);
      expect(Number.parseFloat(restored.lift)).toBeGreaterThan(Number.parseFloat(before.lift));
    } finally {
      await context.close();
    }
  }, 60_000);

  it('schedules one sync when footer style and text change in the same turn', async () => {
    const { context, page } = await contextAt(402, 874);
    try {
      await showChrome(page);
      const delta = await page.evaluate(() => new Promise<number>((resolve) => {
        const before = (window as unknown as { __opdCornerSyncs?: number }).__opdCornerSyncs ?? 0;
        const element = document.getElementById('status-banner')!;
        element.style.height = '96px';
        element.textContent = `${element.textContent ?? ''} · styled`;
        queueMicrotask(() => {
          resolve(((window as unknown as { __opdCornerSyncs?: number }).__opdCornerSyncs ?? 0) - before);
        });
      }));
      expect(delta).toBe(1);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('schedules no sync for a text change on a footer that is not the watched one', async () => {
    const { context, page } = await contextAt(402, 874);
    try {
      await showChrome(page);
      const delta = await page.evaluate(() => new Promise<number>((resolve) => {
        const banner = document.getElementById('status-banner')!;
        const nested = document.createElement('span');
        nested.id = 'status-banner';
        nested.textContent = 'nested';
        banner.appendChild(nested);
        queueMicrotask(() => {
          queueMicrotask(() => {
            const before = (window as unknown as { __opdCornerSyncs?: number }).__opdCornerSyncs ?? 0;
            nested.textContent = 'nested · changed';
            queueMicrotask(() => {
              resolve(((window as unknown as { __opdCornerSyncs?: number }).__opdCornerSyncs ?? 0) - before);
            });
          });
        });
      }));
      expect(delta).toBe(0);
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
