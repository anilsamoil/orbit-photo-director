import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type CDPSession, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixtures/joint-panels.json';

const root = resolve(process.env.OPD_JOINT_SOURCE_ROOT ?? resolve(__dirname, '..'));
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve(root, 'public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const origin = 'http://127.0.0.1:45100';
const sourceHashes = Object.fromEntries(['src/chrome-slots.ts', 'src/map-chrome.ts', 'src/style.css', 'src/map/adapters/maplibre/index.ts'].filter((name) => existsSync(resolve(root, name))).map((name) => [name, createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex')]));
type Insets = { top: number; right: number; bottom: number; left: number };
type InputEvent = { type: string; target: string; trusted: boolean };
type TestWindow = Window & { __opdMap: import('maplibre-gl').Map; __shortEvents: InputEvent[]; __shortBanner?: MutationObserver };
const insetsFor = (bottom: number): Insets => bottom ? { top: 24, right: 0, bottom, left: 47 } : { top: 0, right: 0, bottom: 0, left: 0 };
let assets: Map<string, string | Uint8Array>;
let script: string;

beforeAll(async () => {
  const output = await build({ configFile: false, root, logLevel: 'silent', define: { __APP_VERSION__: JSON.stringify('joint-panels-test') },
    build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'jointPanels', formats: ['iife'] } } });
  const bundle = Array.isArray(output) ? output[0]! : output;
  if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
  assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
}, 60_000);

async function prepare(page: Page, cdp: CDPSession | null, insets: Insets) {
  const now = (JSON.parse(fixture['meta.json']) as { now: number }).now;
  if (cdp) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
  else await page.addInitScript((values) => {
    const replace = (value: string) => value.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof typeof values) => `${values[side]}px`);
    const proto = CSSStyleDeclaration.prototype;
    for (const key of ['cssText', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'width', 'height']) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (descriptor?.set) Object.defineProperty(proto, key, { ...descriptor, set(value: string) { descriptor.set!.call(this, replace(value)); } });
    }
    const set = proto.setProperty;
    proto.setProperty = function (name, value, priority) { return set.call(this, name, value === null ? value : replace(value), priority); };
    const append = Node.prototype.appendChild;
    Node.prototype.appendChild = function <T extends Node>(child: T): T {
      if (child instanceof HTMLElement && child.style.cssText.includes('safe-area-inset-')) child.style.cssText = replace(child.style.cssText);
      return append.call(this, child) as T;
    };
  }, insets);
  await page.clock.setFixedTime(new Date(now));
  const css = cdp ? stylesheet : stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof Insets) => `${insets[side]}px`);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html.replace('</head>', `<style>${vendor}\n${css}</style></head>`).replace('</body>', `<script src="/${script}"></script></body>`) });
    const asset = assets.get(url.pathname);
    if (url.origin === origin && asset !== undefined) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: typeof asset === 'string' ? asset : Buffer.from(asset) });
    const name = url.pathname === '/manifest.json' ? 'manifest.json' : url.pathname.startsWith('/v/verify/') ? url.pathname.split('/').pop()! : url.pathname === '/launch/latest.json' ? 'launch-latest.json' : url.pathname === '/launch/v/verifyrev.json' ? 'launch.json' : '';
    if (name && name in fixture) return route.fulfill({ contentType: 'application/json', body: fixture[name as keyof typeof fixture] });
    if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'joint-panels', displayName: 'Local fixture' } } });
    if (url.pathname.startsWith('/api/browser/profiles/')) return route.fulfill({ json: { ok: true, targets: [], count: 0 } });
    if (url.pathname === '/api/kp') return route.fulfill({ json: { kp: 3, timestamp: new Date(now).toISOString(), age_min: 5 } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
    if (/\.(png|jpe?g)$/.test(url.pathname) || url.pathname.includes('/MapServer/tile/')) return route.fulfill({ contentType: 'image/png', body: raster });
    return route.abort();
  });
  await page.addInitScript((shown) => {
    localStorage.setItem('opd-map-chrome', shown ? 'shown' : 'hidden');
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    const state = window as unknown as TestWindow;
    state.__shortEvents = [];
    for (const type of ['click', 'touchstart', 'touchend', 'contextmenu']) document.addEventListener(type, (event) => {
      const target = event.target as Element;
      state.__shortEvents.push({ type, trusted: event.isTrusted, target: target.id || target.className || target.tagName });
    }, true);
  }, true);
  await page.goto(`${origin}/?e2e&u=joint-panels`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const map = (window as unknown as TestWindow).__opdMap;
    return map?.isStyleLoaded() && !!map.getSource('iss-track');
  });
  await page.evaluate(() => document.fonts.ready);
  const appliedInsets = await page.evaluate(() => {
    const probe = document.createElement('div');
    for (const side of ['top', 'right', 'bottom', 'left']) probe.style.setProperty(`padding-${side}`, `env(safe-area-inset-${side}, 0px)`);
    document.body.appendChild(probe);
    const css = getComputedStyle(probe);
    const values = { top: parseFloat(css.paddingTop), right: parseFloat(css.paddingRight), bottom: parseFloat(css.paddingBottom), left: parseFloat(css.paddingLeft) };
    probe.remove(); return values;
  });
  expect(appliedInsets).toEqual(insets);
}

async function banner(page: Page, variant: 'plain' | 'actions' | 'long') {
  await page.evaluate((mode) => {
    const element = document.querySelector('#status-banner')!;
    const text = mode === 'long' ? 'SIGN IN AGAIN. The session ended while disconnected. Reconnect to restore the latest orbit predictions, then sign in again to synchronize your selected photography targets and shot list.' : 'Orbit data ready · verify fixture';
    const content = mode === 'plain' ? text : `<p class="banner-copy">${text}</p><div class="banner-actions"><a class="banner-action" role="button" tabindex="0">Sign in</a><button class="banner-action" role="button" tabindex="0">Reload</button></div>`;
    const apply = () => {
      if (element.className !== 'banner banner-red') element.className = 'banner banner-red';
      if (element.innerHTML !== content) element.innerHTML = content;
    };
    apply();
    const state = window as unknown as TestWindow;
    state.__shortBanner = new MutationObserver(apply);
    state.__shortBanner.observe(element, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  }, variant);
}

async function ownScroll(page: Page, selector: string) {
  await page.locator(selector).first().evaluate((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (!/auto|scroll/.test(style.overflowX + style.overflowY)) continue;
      const a = element.getBoundingClientRect(), b = parent.getBoundingClientRect();
      if (a.left < b.left) parent.scrollLeft -= Math.ceil(b.left - a.left);
      if (a.right > b.right) parent.scrollLeft += Math.ceil(a.right - b.right);
      if (a.top < b.top) parent.scrollTop -= Math.ceil(b.top - a.top);
      if (a.bottom > b.bottom) parent.scrollTop += Math.ceil(a.bottom - b.bottom);
    }
  });
}

async function targetGeometry(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const r = element.getBoundingClientRect();
    const points = [[r.x + r.width / 2, r.y + r.height / 2], [r.left + 2, r.y + r.height / 2], [r.right - 2, r.y + r.height / 2], [r.x + r.width / 2, r.top + 2], [r.x + r.width / 2, r.bottom - 2]].map(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return { x: x!, y: y!, owns: hit === element || !!hit && element.contains(hit), hit: hit?.id || hit?.className || hit?.tagName };
    });
    return { rect: r.toJSON(), points };
  });
}


async function save(page: Page, name: string, evidence: unknown) {
  if (!process.env.OPD_JOINT_EVIDENCE_DIR) return;
  mkdirSync(process.env.OPD_JOINT_EVIDENCE_DIR, { recursive: true });
  const path = resolve(process.env.OPD_JOINT_EVIDENCE_DIR, name);
  writeFileSync(`${path}.json`, JSON.stringify({ sourceRoot: root, sourceHashes, evidence }, null, 2));
  await page.screenshot({ path: `${path}.png`, scale: 'css' });
}


for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
]) describe.skipIf(!existsSync(engine.executablePath))(`joint panel convergence ${engine.name}`, () => {
  let browser: Browser;
  beforeAll(async () => { browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  it('keeps native Legend → pin → Satellite geometry idle for ten wall-clock seconds', async () => {
    const width = 390, height = 520, insets = insetsFor(20);
    const context = await browser.newContext({ viewport: { width, height }, screen: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: 'block' });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      const cdp = engine.name === 'Chrome' ? await context.newCDPSession(page) : null;
      await prepare(page, cdp, insets);
      await banner(page, 'plain');
      if (await page.locator('#toggle-follow-iss').getAttribute('aria-pressed') === 'true') await page.locator('#toggle-follow-iss').click();
      await page.locator('#bearing-north').click();
      await page.evaluate(() => (window as unknown as TestWindow).__opdMap.jumpTo({ center: [-90, 40], zoom: 3, bearing: 0 }));
      await page.locator('#map-legend-toggle').click();
      await page.waitForTimeout(300);
      const seed = { x: 195, y: 206.4 };
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === (window as unknown as TestWindow).__opdMap.getCanvas(), seed)).toBe(true);
      await page.mouse.click(seed.x, seed.y, { button: 'right' });
      await page.locator('.pin-pass-row').first().waitFor();
      await ownScroll(page, '#toggle-satellite-picker');
      await page.waitForTimeout(400);
      const opener = await targetGeometry(page, '#toggle-satellite-picker');
      expect(opener.points[0]!.owns).toBe(true);
      await page.mouse.click(opener.points[0]!.x, opener.points[0]!.y);
      await page.locator('#satellite-picker-panel:not([hidden])').waitFor();
      await page.waitForTimeout(800);
      const before = await page.evaluate(() => {
        const state = window as unknown as Window & { __jointIdle: { style: number; class: number; mutations: number; samples: unknown[] } };
        const idle = state.__jointIdle = { style: 0, class: 0, mutations: 0, samples: [] };
        const set = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
          if (this === document.body.style) idle.style++;
          return set.call(this, name, value, priority);
        };
        for (const method of ['add', 'remove', 'toggle', 'replace'] as const) {
          const original = DOMTokenList.prototype[method];
          Object.defineProperty(DOMTokenList.prototype, method, { configurable: true, value: function (...args: unknown[]) {
            if (this === document.body.classList) idle.class++;
            return Reflect.apply(original, this, args);
          } });
        }
        const observer = new MutationObserver((records) => { idle.mutations += records.length; });
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
        observer.observe(document.querySelector('#map-inspector')!, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
        return ['.map-controls-time', '#satellite-picker-panel', '#map-inspector', '#map-legend-panel'].map((selector) => document.querySelector(selector)!.getBoundingClientRect().toJSON());
      });
      const wallStart = Date.now();
      const samples = [];
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(2_000);
        samples.push(await page.evaluate(() => ['.map-controls-time', '#satellite-picker-panel', '#map-inspector', '#map-legend-panel'].map((selector) => document.querySelector(selector)!.getBoundingClientRect().toJSON())));
      }
      const wallMs = Date.now() - wallStart;
      const idle = await page.evaluate(() => (window as unknown as Window & { __jointIdle: { style: number; class: number; mutations: number } }).__jointIdle);
      const events = await page.evaluate(() => (window as unknown as TestWindow).__shortEvents);
      const row = page.locator('.pin-pass-row').first();
      const popup = await row.evaluate((element) => element.closest('.maplibregl-popup-content')!.getBoundingClientRect().toJSON());
      if (cdp) {
        const delta = await row.evaluate((element) => {
          const parent = element.closest('.maplibregl-popup-content') as HTMLElement;
          return element.getBoundingClientRect().top - parent.getBoundingClientRect().top - parent.clientTop;
        });
        await page.mouse.move(popup.x + popup.width / 2, popup.y + popup.height / 2);
        await page.mouse.wheel(0, Math.floor(delta));
        await page.waitForTimeout(500);
      } else await row.evaluate((element) => {
        const parent = element.closest('.maplibregl-popup-content') as HTMLElement;
        parent.scrollTop += Math.floor(element.getBoundingClientRect().top - parent.getBoundingClientRect().top - parent.clientTop);
      });
      const pass = await row.evaluate((element) => {
        const parent = element.closest('.maplibregl-popup-content') as HTMLElement, r = parent.getBoundingClientRect(), row = element.getBoundingClientRect();
        return { row: row.toJSON(), top: r.top + parent.clientTop, bottom: r.top + parent.clientTop + parent.clientHeight, clientHeight: parent.clientHeight, overflow: parent.scrollWidth - parent.clientWidth };
      });
      const evidence = { engine: engine.name, width, height, insets, seed, opener, before, samples, wallMs, idle, events, pass };
      await save(page, engine.name.toLowerCase(), evidence);
      console.log(JSON.stringify({ engine: engine.name, wallMs, idle, pass }));
      expect.soft(wallMs).toBeGreaterThanOrEqual(10_000);
      expect.soft({ style: idle.style, class: idle.class, mutations: idle.mutations }, JSON.stringify(evidence)).toEqual({ style: 0, class: 0, mutations: 0 });
      for (const sample of samples) expect.soft(sample, JSON.stringify(evidence)).toEqual(before);
      expect.soft(events.every((event) => event.trusted), JSON.stringify(events)).toBe(true);
      expect.soft(events.some((event) => event.type === 'click' && event.target === 'map-legend-toggle')).toBe(true);
      expect.soft(events.some((event) => event.type === 'contextmenu' && event.target === 'maplibregl-canvas')).toBe(true);
      expect.soft(events.some((event) => event.type === 'click' && event.target === 'toggle-satellite-picker')).toBe(true);
      expect.soft(pass.row.height).toBeLessThanOrEqual(pass.clientHeight);
      expect.soft(pass.row.top).toBeGreaterThanOrEqual(pass.top - .5);
      expect.soft(pass.row.bottom).toBeLessThanOrEqual(pass.bottom + .5);
      expect.soft(pass.overflow).toBe(0);
    } finally { await context.close(); }
  }, 60_000);
});
