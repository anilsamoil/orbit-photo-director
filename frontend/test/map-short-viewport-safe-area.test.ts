import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type CDPSession, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import inspectorFixture from './fixtures/short-inspector.json';
import launchFixture from './fixtures/short-launch.json';

const root = resolve(process.env.OPD_SHORT_SOURCE_ROOT ?? resolve(__dirname, '..'));
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve(root, 'public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const origin = 'http://127.0.0.1:45110';
const sourceHashes = Object.fromEntries(['src/chrome-slots.ts', 'src/map-chrome.ts', 'src/style.css', 'src/map/adapters/maplibre/index.ts'].filter((name) => existsSync(resolve(root, name))).map((name) => [name, createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex')]));
type Insets = { top: number; right: number; bottom: number; left: number };
type InputEvent = { type: string; target: string; trusted: boolean };
type TestWindow = Window & { __opdMap: import('maplibre-gl').Map; __shortEvents: InputEvent[]; __shortBanner?: MutationObserver };
const insetsFor = (bottom: number): Insets => bottom ? { top: 24, right: 0, bottom, left: 47 } : { top: 0, right: 0, bottom: 0, left: 0 };
let assets: Map<string, string | Uint8Array>;
let script: string;

beforeAll(async () => {
  const output = await build({ configFile: false, root, logLevel: 'silent', define: { __APP_VERSION__: JSON.stringify('short-viewport-test') },
    build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'shortViewport', formats: ['iife'] } } });
  const bundle = Array.isArray(output) ? output[0]! : output;
  if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
  assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
}, 60_000);

async function prepare(page: Page, cdp: CDPSession | null, insets: Insets, kind: 'inspector' | 'launch') {
  const fixture = kind === 'inspector' ? inspectorFixture : launchFixture;
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
    if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'short-viewport', displayName: 'Local fixture' } } });
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
  }, kind === 'launch');
  await page.goto(`${origin}/?e2e&u=short-viewport`, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-map').click();
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

async function idleLayout(page: Page) {
  return page.evaluate(async () => {
    const records: { target: string; attribute: string | null }[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch.map((record) => ({ target: (record.target as Element).id || (record.target as Element).className, attribute: record.attributeName }))));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    const inspector = document.querySelector('#map-inspector');
    if (inspector) observer.observe(inspector, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    observer.disconnect();
    return records;
  });
}

async function save(page: Page, name: string, evidence: unknown) {
  if (!process.env.OPD_SHORT_EVIDENCE_DIR) return;
  mkdirSync(process.env.OPD_SHORT_EVIDENCE_DIR, { recursive: true });
  const path = resolve(process.env.OPD_SHORT_EVIDENCE_DIR, name);
  writeFileSync(`${path}.json`, JSON.stringify({ sourceRoot: root, sourceHashes, evidence }, null, 2));
  await page.screenshot({ path: `${path}.png`, scale: 'css' });
}

const launchCases = [
  { name: 'satellite-zero', width: 568, height: 320, bottom: 0, selectedShot: true, banner: 'actions', selector: '#toggle-satellite-picker', outcome: 'picker' },
  { name: 'satellite-B20', width: 568, height: 320, bottom: 20, selectedShot: false, banner: 'actions', selector: '#toggle-satellite-picker', outcome: 'picker' },
  { name: 'launch-name-long-B34', width: 390, height: 520, bottom: 34, selectedShot: true, banner: 'long', selector: '.map-launch-brief .launch-name', outcome: 'modal' },
  { name: 'launch-summary-plain', width: 568, height: 320, bottom: 0, selectedShot: true, banner: 'plain', selector: '.map-launch-primary > summary', outcome: 'summary' },
] as const;

for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
]) describe.skipIf(!existsSync(engine.executablePath))(`short viewport trusted input ${engine.name}`, () => {
  let browser: Browser;
  beforeAll(async () => { browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  it.each([{ width: 568, height: 320, dx: 91, dy: 0 }, { width: 390, height: 520, dx: 0, dy: 89 }])('preserves the B34 hold and a complete first pass at $width×$height', async ({ width, height, dx, dy }) => {
    const insets = insetsFor(34);
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const cdp = engine.name === 'Chrome' ? await context.newCDPSession(page) : null;
      await prepare(page, cdp, insets, 'inspector');
      await page.locator('#map-chrome-toggle').click();
      if (await page.locator('#toggle-follow-iss').getAttribute('aria-pressed') === 'true') await page.locator('#toggle-follow-iss').click();
      await page.locator('#map-chrome-toggle').click();
      await page.evaluate((center) => (window as unknown as TestWindow).__opdMap.jumpTo({ center, zoom: 3, bearing: 0 }), [40.90095837248486, -41.72518486424848] as [number, number]);
      await page.waitForFunction(() => {
        const map = (window as unknown as TestWindow).__opdMap;
        const canvas = map.getCanvas(), r = canvas.getBoundingClientRect(), center = map.getCenter();
        return !map.isMoving() && Math.abs(map.getBearing()) < .01 && Math.abs(map.getZoom() - 3) < .01
          && Math.abs(center.lng - 40.90095837248486) < .000001 && Math.abs(center.lat + 41.72518486424848) < .000001
          && map.listens('contextmenu') && document.body.classList.contains('map-chrome-hidden')
          && document.querySelector('#map-pane')!.classList.contains('map-chrome-hidden')
          && document.querySelector('#toggle-follow-iss')!.getAttribute('aria-pressed') === 'false'
          && document.elementFromPoint(r.x + r.width * .3, r.y + r.height * .35) === canvas;
      });
      const seed = await page.evaluate(() => {
        const map = (window as unknown as TestWindow).__opdMap, r = map.getCanvas().getBoundingClientRect();
        const point = { x: r.x + r.width * .3, y: r.y + r.height * .35 };
        const ll = map.unproject([point.x - r.x, point.y - r.y]);
        return { ...point, bearing: map.getBearing(), expectedPin: [Math.round(ll.lng), Math.round(ll.lat)] };
      });
      expect(seed.expectedPin).toEqual(width === 568 ? [31, -39] : [34, -37]);
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: seed.x, y: seed.y, radiusX: 2, radiusY: 2, force: 1 }] });
        await page.waitForTimeout(650);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else await page.mouse.click(seed.x, seed.y, { button: 'right' });
      const seeded = await page.evaluate(async () => {
        const state = window as unknown as TestWindow;
        const source = state.__opdMap.getSource('dropped-pin') as import('maplibre-gl').GeoJSONSource | undefined;
        const data = source ? await source.getData() : null;
        return { pin: data?.type === 'FeatureCollection' && data.features[0]?.geometry.type === 'Point' ? data.features[0].geometry.coordinates : null,
          events: state.__shortEvents.filter((event) => event.type === 'touchstart' || event.type === 'contextmenu') };
      });
      expect(seeded.pin, JSON.stringify({ seed, seeded })).toEqual(seed.expectedPin);
      expect(seeded.events.some((event) => event.trusted && event.target === 'maplibregl-canvas')).toBe(true);
      await page.locator('.pin-pass-row').first().waitFor();
      await page.locator('#map-chrome-toggle').click();
      await page.waitForTimeout(800);
      const idle = await idleLayout(page);
      const pass = await page.locator('.pin-pass-row').first().evaluate((row) => {
        const popup = row.closest('.maplibregl-popup-content') as HTMLElement;
        const measure = () => {
          const r = popup.getBoundingClientRect();
          const scrollport = { top: r.top + popup.clientTop, bottom: r.top + popup.clientTop + popup.clientHeight, left: r.left + popup.clientLeft, right: r.left + popup.clientLeft + popup.clientWidth };
          return { popup: r.toJSON(), scrollport, row: row.getBoundingClientRect().toJSON(), scrollTop: popup.scrollTop, clientHeight: popup.clientHeight };
        };
        const before = measure();
        popup.scrollTop += Math.floor(row.getBoundingClientRect().top - popup.getBoundingClientRect().top - 1);
        const after = measure(); popup.scrollTop = 0;
        return { before, after };
      });
      const before = await page.evaluate(async ({ dx, dy }) => {
        const map = (window as unknown as TestWindow).__opdMap, r = map.getCanvas().getBoundingClientRect();
        const point = { x: r.x + r.width / 2 + dx, y: r.y + r.height / 2 + dy };
        const ll = map.unproject([point.x - r.x, point.y - r.y]);
        return { point, expected: [Math.round(ll.lng), Math.round(ll.lat)], pin: await (map.getSource('dropped-pin') as import('maplibre-gl').GeoJSONSource).getData(), owner: document.elementFromPoint(point.x, point.y)?.className, time: (document.querySelector('#time-slider') as HTMLInputElement).value, classes: document.body.className };
      }, { dx, dy });
      await page.evaluate(() => { (window as unknown as TestWindow).__shortEvents = []; });
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...before.point, radiusX: 2, radiusY: 2, force: 1 }] });
        await page.waitForTimeout(650); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.move(before.point.x, before.point.y);
        await page.mouse.down({ button: 'right' }); await page.waitForTimeout(650); await page.mouse.up({ button: 'right' });
      }
      await page.waitForTimeout(200);
      const after = await page.evaluate(async () => {
        const state = window as unknown as TestWindow;
        const data = await (state.__opdMap.getSource('dropped-pin') as import('maplibre-gl').GeoJSONSource).getData();
        if (data.type !== 'FeatureCollection' || data.features[0]?.geometry.type !== 'Point') throw new Error('No dropped point');
        return { pin: data.features[0].geometry.coordinates, time: (document.querySelector('#time-slider') as HTMLInputElement).value, events: state.__shortEvents };
      });
      const evidence = { engine: engine.name, width, height, insets, seed, seeded, idle, pass, before, after };
      await save(page, `${engine.name.toLowerCase()}-inspector-${width}x${height}`, evidence);
      expect.soft(idle, JSON.stringify(evidence)).toEqual([]);
      expect.soft(after.pin, JSON.stringify(evidence)).toEqual(before.expected);
      expect.soft(after.time).toBe(before.time);
      expect.soft(after.events.some((event) => event.trusted && event.target === 'maplibregl-canvas')).toBe(true);
      expect.soft(pass.after.row.top, JSON.stringify(evidence)).toBeGreaterThanOrEqual(pass.after.scrollport.top);
      expect.soft(pass.after.row.bottom, JSON.stringify(evidence)).toBeLessThanOrEqual(pass.after.scrollport.bottom);
      if (width === 568) expect.soft(pass.before.row.bottom, JSON.stringify(evidence)).toBeLessThanOrEqual(pass.before.scrollport.bottom);
    } finally { await context.close(); }
  }, 30_000);
  it.each(launchCases)('delivers the own-scrolled $name center while Launches is visible', async ({ name, width, height, bottom, selectedShot, banner: variant, selector, outcome }) => {
    const insets = insetsFor(bottom);
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: 'block' });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      const cdp = engine.name === 'Chrome' ? await context.newCDPSession(page) : null;
      await prepare(page, cdp, insets, 'launch');
      if (selectedShot) {
        await page.locator('#tab-queue').click(); await page.locator('.btn-remind').first().click(); await page.locator('#tab-map').click();
        await page.waitForFunction(() => document.body.classList.contains('shotlist-bar-visible'));
      }
      if (await page.locator('#map-legend-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#map-legend-toggle').click();
      if (await page.locator('#filter-launches-map').getAttribute('aria-pressed') === 'true') await page.locator('#filter-launches-map').click();
      await banner(page, variant);
      await page.locator('#filter-launches-map').click(); await page.locator('.map-launch-brief').waitFor();
      await page.waitForTimeout(1400);
      const idle = await idleLayout(page);
      await ownScroll(page, selector); await page.waitForTimeout(2800);
      const target = await targetGeometry(page, selector);
      const state = () => page.evaluate(() => ({
        modal: !!document.querySelector('#launch-details-title'), pickerHidden: (document.querySelector('#satellite-picker-panel') as HTMLElement).hidden,
        time: (document.querySelector('#time-slider') as HTMLInputElement).value,
        details: [...document.querySelectorAll<HTMLDetailsElement>('.map-launch-brief details')].map((element) => element.open),
        classes: document.body.className, events: (window as unknown as TestWindow).__shortEvents,
        boxes: Object.fromEntries(['#map', '.map-toolbar', '.maplibregl-ctrl-zoom-in', '.maplibregl-ctrl-zoom-out', '.maplibregl-ctrl-compass', '#map-chrome-toggle', '#map-legend-toggle', '#map-legend-panel', '#status-banner', '#shotlist-bar', '.map-command', '.map-controls-time', '#time-slider', '.map-control-dock', '#map-launch-coverage'].map((selector) => [selector, document.querySelector(selector)?.getBoundingClientRect().toJSON()])),
        bodyStyle: document.body.style.cssText,
      }));
      const before = await state();
      await page.evaluate(() => { (window as unknown as TestWindow).__shortEvents = []; });
      await page.mouse.click(target.points[0]!.x, target.points[0]!.y); await page.waitForTimeout(700);
      const after = await state();
      const evidence = { engine: engine.name, name, width, height, insets, selectedShot, variant, idle, target, before, after };
      await save(page, `${engine.name.toLowerCase()}-${name}`, evidence);
      expect.soft(idle, JSON.stringify(evidence)).toEqual([]);
      expect.soft(target.points[0]!.owns, JSON.stringify(evidence)).toBe(true);
      if (outcome === 'picker') {
        expect.soft(target.points.map((point) => point.owns), JSON.stringify(evidence)).toEqual([true, true, true, true, true]);
        expect.soft(after.pickerHidden, JSON.stringify(evidence)).toBe(false);
        expect.soft(after.events.some((event) => event.type === 'click' && event.target === 'toggle-satellite-picker' && event.trusted)).toBe(true);
      } else if (outcome === 'modal') expect.soft(after.modal, JSON.stringify(evidence)).toBe(true);
      else expect.soft(after.details[0], JSON.stringify(evidence)).toBe(!before.details[0]);
      expect.soft(after.time, JSON.stringify(evidence)).toBe(before.time);
      expect(after.events.some((event) => event.type === 'click' && event.trusted)).toBe(true);
    } finally { await context.close(); }
  }, 30_000);
});
