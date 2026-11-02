import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freezeDate } from './freeze-date';
import fixture from './fixtures/iss-sgp4-fixture.json';

const root = resolve(__dirname, '..');
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve(root, 'public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const manifest = {
  version: 'repin', generated_at: fixture.start, tle_epoch: fixture.start,
  cloud_composite_hour: fixture.start, target_data_version: 'repin', build_version: 'repin',
  freshness: { tle_hours: 0, cloud_hours: 0, ok: true },
  artifacts: Object.fromEntries(['passes', 'track', 'status', 'top5', 'top_24h', 'cupola_windows'].map((key) => [key, { path: `${key}.json`, sha256: '', bytes: 0 }])),
};
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const origin = 'http://repin.test';
type Insets = { top: number; right: number; bottom: number; left: number };
const samples = [
  { name: 'iPhone portrait center', insets: { top: 62, right: 0, bottom: 34, left: 0 }, offset: 0, width: 402, height: 874 },
  { name: 'iPhone landscape center', insets: { top: 0, right: 62, bottom: 21, left: 62 }, offset: 0, width: 874, height: 402 },
  { name: 'iPhone landscape center+91', insets: { top: 0, right: 62, bottom: 21, left: 62 }, offset: 91, width: 874, height: 402 },
  { name: 'iPhone landscape center-91', insets: { top: 0, right: 62, bottom: 21, left: 62 }, offset: -91, width: 874, height: 402 },
  { name: 'iPad landscape center+5', insets: { top: 24, right: 0, bottom: 20, left: 0 }, offset: 5, width: 1210, height: 834 },
];

async function emulateInsets(page: Page, insets: Insets): Promise<void> {
  await page.addInitScript((values) => {
    const replace = (value: string) => value.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof typeof values) => `${values[side]}px`);
    const proto = CSSStyleDeclaration.prototype;
    for (const key of ['cssText', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
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
}

for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
]) describe.skipIf(!existsSync(engine.executablePath))(`trusted centered re-pin ${engine.name}`, () => {
  let browser: Browser;
  let assets: Map<string, string | Uint8Array>;
  let script: string;
  beforeAll(async () => {
    const output = await build({
      configFile: false, root, logLevel: 'silent', define: { __APP_VERSION__: JSON.stringify('repin-test') },
      build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'repin', formats: ['iife'] } },
    });
    const bundle = Array.isArray(output) ? output[0]! : output;
    if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
    assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
    script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
    browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath });
  }, 60_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  it.each(samples)('keeps $name on the canvas with an open inspector and unchanged time', async ({ name, insets, offset, width, height }) => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const cdp = engine.name === 'Chrome' ? await context.newCDPSession(page) : null;
      if (cdp) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
      else await emulateInsets(page, insets);
      await freezeDate(page, fixture.start);
      const css = cdp ? stylesheet : stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof Insets) => `${insets[side]}px`);
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html.replace('</head>', `<style>${vendor}\n${css}</style></head>`).replace('</body>', `<script src="/${script}"></script></body>`) });
        const asset = assets.get(url.pathname);
        if (url.origin === origin && asset !== undefined) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: typeof asset === 'string' ? asset : Buffer.from(asset) });
        if (url.pathname === '/manifest.json') return route.fulfill({ json: manifest });
        if (['/passes.json', '/top5.json', '/top_24h.json', '/cupola_windows.json'].includes(url.pathname)) return route.fulfill({ json: [] });
        if (url.pathname === '/status.json') return route.fulfill({ json: { last_run: fixture.start, tick_minutes: 30, tle_age_hours: 0, tle_freshness_factor: 1, cloud_source: 'gibs', cloud_composite_hour: fixture.start, target_count: 0, pass_count: 0, version: 'repin', build_version: 'repin' } });
        if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'repin', displayName: 'Local fixture' } } });
        if (url.pathname.startsWith('/api/browser/profiles/')) return route.fulfill({ json: { ok: true, count: 0, targets: [] } });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
        if (url.pathname === '/track.json') return route.fulfill({ json: { ...fixture, tle_epoch: fixture.start, tle_age_hours: 0, tle_freshness_factor: 1 } });
        if (/\.(png|jpe?g)$/.test(url.pathname) || url.pathname.includes('/MapServer/tile/')) return route.fulfill({ contentType: 'image/png', body: raster });
        return route.abort();
      });
      await page.goto(`${origin}/?e2e&u=repin`, { waitUntil: 'domcontentloaded' });
      // Observe the initial Map load without starting a second concurrent render.
      await page.waitForFunction(() => document.querySelector('#view')?.className === 'view-map'
        && document.querySelector('#tab-map')?.classList.contains('active'));
      await page.waitForFunction(() => {
        const map = (window as unknown as { __opdMap?: import('maplibre-gl').Map }).__opdMap;
        return map?.isStyleLoaded() && !!map.getSource('iss-track');
      });
      await page.evaluate(() => document.fonts.ready);
      const appliedInsets = await page.evaluate(() => {
        const probe = document.createElement('div');
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) probe.style.setProperty(`padding-${side.toLowerCase()}`, `env(safe-area-inset-${side.toLowerCase()}, 0px)`);
        document.body.appendChild(probe);
        const css = getComputedStyle(probe);
        const values = { top: parseFloat(css.paddingTop), right: parseFloat(css.paddingRight), bottom: parseFloat(css.paddingBottom), left: parseFloat(css.paddingLeft) };
        probe.remove(); return values;
      });
      expect(appliedInsets).toEqual(insets);
      await page.locator('#map-chrome-toggle').click();
      if (await page.locator('#toggle-follow-iss').getAttribute('aria-pressed') === 'true') await page.locator('#toggle-follow-iss').click();
      await page.locator('#bearing-north').click();
      await page.locator('#map-chrome-toggle').click();
      await page.waitForFunction(() => {
        const map = (window as unknown as { __opdMap: import('maplibre-gl').Map }).__opdMap;
        return !map.isMoving() && Math.abs(map.getBearing()) < .01;
      });
      await page.evaluate(() => {
        const map = (window as unknown as { __opdMap: import('maplibre-gl').Map }).__opdMap;
        map.jumpTo({ center: [40.900958, -41.725185], zoom: 3, bearing: 0 });
      });
      await page.waitForTimeout(400);
      const seed = await page.evaluate(() => {
        const r = document.querySelector('.maplibregl-canvas')!.getBoundingClientRect();
        return { x: r.x + r.width / 2 - 120, y: r.y + r.height / 2 - 30 };
      });
      await page.mouse.click(seed.x, seed.y, { button: 'right' });
      await page.waitForSelector('.dropped-pin-popup');
      await page.locator('#map-chrome-toggle').click();
      await page.waitForTimeout(600);
      const before = await page.evaluate(async (offset) => {
        const map = (window as unknown as { __opdMap: import('maplibre-gl').Map }).__opdMap;
        const canvas = map.getCanvas(), r = canvas.getBoundingClientRect();
        const point = { x: r.x + r.width / 2, y: r.y + r.height / 2 + offset };
        const ll = map.unproject([point.x - r.x, point.y - r.y]);
        const source = map.getSource('dropped-pin') as import('maplibre-gl').GeoJSONSource;
        return { point, expected: [Math.round(ll.lng), Math.round(ll.lat)], pin: await source.getData(), time: (document.querySelector('#time-slider') as HTMLInputElement).value, owner: document.elementFromPoint(point.x, point.y)?.className, timeBox: document.querySelector('.map-controls-time')!.getBoundingClientRect().toJSON(), mapBox: r.toJSON(), paneBox: document.querySelector('#map-pane')!.getBoundingClientRect().toJSON(), classes: document.body.className };
      }, offset);
      await page.evaluate(() => {
        const events: { trusted: boolean; target: string; type: string }[] = [];
        (window as unknown as { __repinEvents: typeof events }).__repinEvents = events;
        for (const type of ['touchstart', 'contextmenu']) document.addEventListener(type, (event) => events.push({ trusted: event.isTrusted, target: (event.target as HTMLElement).className, type }), true);
      });
      const waitForPin = () => page.evaluate(async (expected) => {
        const map = (window as unknown as { __opdMap: import('maplibre-gl').Map }).__opdMap;
        const source = map.getSource('dropped-pin') as import('maplibre-gl').GeoJSONSource;
        const deadline = performance.now() + 5_000;
        do {
          const data = await source.getData();
          if (data.type === 'FeatureCollection' && data.features[0]?.geometry.type === 'Point'
            && data.features[0].geometry.coordinates.every((value, index) => value === expected[index])) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (performance.now() < deadline);
        throw new Error(`Native hold did not update the pin to ${expected}`);
      }, before.expected);
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: before.point.x, y: before.point.y, radiusX: 2, radiusY: 2, force: 1 }] });
        try { await waitForPin(); }
        finally { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
      } else {
        await page.mouse.move(before.point.x, before.point.y);
        await page.mouse.down({ button: 'right' });
        await page.waitForTimeout(650);
        await page.mouse.up({ button: 'right' });
      }
      await waitForPin();
      const after = await page.evaluate(async () => {
        const map = (window as unknown as { __opdMap: import('maplibre-gl').Map }).__opdMap;
        const source = map.getSource('dropped-pin') as import('maplibre-gl').GeoJSONSource;
        const data = await source.getData();
        if (data.type !== 'FeatureCollection' || data.features[0]?.geometry.type !== 'Point') throw new Error('No dropped point');
        return { pin: data.features[0]?.geometry.coordinates, time: (document.querySelector('#time-slider') as HTMLInputElement).value, events: (window as unknown as { __repinEvents: { trusted: boolean; target: string; type: string }[] }).__repinEvents };
      });
      const evidence = process.env.OPD_REPIN_EVIDENCE_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        const path = resolve(evidence, `${engine.name.toLowerCase()}-${name.replace(/[^a-zA-Z0-9-]/g, '_')}`);
        writeFileSync(`${path}.json`, JSON.stringify({ engine: engine.name, name, insets, input: cdp ? 'trusted touch hold' : 'trusted right-pointer hold', before, after }, null, 2));
        await page.screenshot({ path: `${path}.png` });
      }
      expect.soft(after.pin, `${name}: ${JSON.stringify({ before, after })}`).toEqual(before.expected);
      expect.soft(after.time).toBe(before.time);
      expect(after.events.some((event) => event.trusted && event.target.includes('maplibregl-canvas'))).toBe(true);
      expect(await page.locator('.dropped-pin-popup').count()).toBe(1);
    } finally { await context.close(); }
  }, 30_000);
});
