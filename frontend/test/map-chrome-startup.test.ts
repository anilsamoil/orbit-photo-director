import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type CDPSession, type Page } from 'playwright';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import inspectorFixture from './fixtures/short-inspector.json';

const root = resolve(process.env.OPD_STARTUP_SOURCE_ROOT ?? resolve(__dirname, '..'));
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve(root, 'public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const origin = 'http://127.0.0.1:45111';
const sourceHashes = Object.fromEntries(['src/chrome-slots.ts', 'src/map-chrome.ts', 'src/style.css', 'src/map/adapters/maplibre/index.ts'].filter((name) => existsSync(resolve(root, name))).map((name) => [name, createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex')]));
type Insets = { top: number; right: number; bottom: number; left: number };
type InputEvent = { type: string; target: string; trusted: boolean; control?: string; expanded?: string | null; x?: number; y?: number };
type TestWindow = Window & { __opdMap: import('maplibre-gl').Map; __shortEvents: InputEvent[]; __shortBanner?: MutationObserver };
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

async function prepare(page: Page, cdp: CDPSession | null, insets: Insets) {
  const fixture = inspectorFixture;
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
      const control = target.closest('#map-chrome-toggle');
      state.__shortEvents.push({ type, trusted: event.isTrusted, target: target.id || target.className || target.tagName,
        control: control?.id, expanded: control?.getAttribute('aria-expanded'),
        x: event instanceof MouseEvent ? event.clientX : undefined, y: event instanceof MouseEvent ? event.clientY : undefined });
    }, true);
  }, true);
  await page.goto(`${origin}/?e2e&u=short-viewport`, { waitUntil: 'domcontentloaded' });
  await page.locator('.maplibregl-ctrl-compass').waitFor({ state: 'attached' });
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


for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
]) describe.skipIf(!existsSync(engine.executablePath))(`supported safe-area startup ${engine.name}`, () => {
  it.each([
    { width: 402, height: 874, top: 62, bottom: 34, left: 0, right: 0 },
    { width: 874, height: 402, top: 0, bottom: 21, left: 62, right: 62 },
    { width: 834, height: 1210, top: 24, bottom: 20, left: 0, right: 0 },
    { width: 1210, height: 834, top: 24, bottom: 20, left: 0, right: 0 },
    { width: 1280, height: 800, top: 0, bottom: 0, left: 0, right: 0 },
    { width: 1440, height: 900, top: 0, bottom: 0, left: 0, right: 0 },
  ])('settles and accepts native Controls clicks at $width×$height T$top/B$bottom/L$left/R$right', async ({ width, height, ...insets }) => {
    const browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath });
    const samples: unknown[] = [];
    let ready = false;
    let error = '';
    try {
      const context = await browser.newContext({ viewport: { width, height }, screen: { width, height }, isMobile: width < 1280, hasTouch: width < 1280, deviceScaleFactor: Math.min(width, height) < 500 ? 3 : width < 1280 ? 2 : 1, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on('console', (message) => { if (message.text().startsWith('STARTUP_WRITES ')) samples.push(JSON.parse(message.text().slice(15))); });
      await page.addInitScript(() => {
        const counts = { class: 0, style: 0 };
        (window as unknown as { __startupWrites: typeof counts }).__startupWrites = counts;
        for (const method of ['toggle', 'add', 'remove', 'replace'] as const) {
          const original = DOMTokenList.prototype[method] as (...args: unknown[]) => unknown;
          Object.defineProperty(DOMTokenList.prototype, method, { configurable: true, value: function (...args: unknown[]) {
            const result = original.apply(this, args);
            if (document.body && this === document.body.classList) {
              counts.class += 1;
              if (counts.class < 15 || counts.class % 1000 === 0) console.log('STARTUP_WRITES ' + JSON.stringify({ ...counts, args, classes: document.body.className,
                chip: document.querySelector('.map-controls-time')?.getBoundingClientRect().toJSON(), zoom: document.querySelector('.maplibregl-ctrl-zoom-in')?.getBoundingClientRect().toJSON() }));
            }
            return result;
          } });
        }
        const set = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
          if (document.body && this === document.body.style) counts.style += 1;
          return set.call(this, name, value, priority);
        };
      });
      const cdp = engine.name === 'Chrome' ? await context.newCDPSession(page) : null;
      const preparation = prepare(page, cdp, insets).then(async () => {
        if (width > height) {
          await page.evaluate(() => {
            const banner = document.querySelector('#status-banner')!;
            banner.className = 'banner banner-red';
            banner.textContent = 'Orbit data ready · verify fixture';
          });
          await page.locator('#map-legend-toggle').click();
          await page.waitForTimeout(300);
          await page.evaluate(() => {
            document.querySelector('#map-legend-toggle')!.addEventListener('click', () => {
              const banner = document.querySelector('#status-banner')!;
              banner.innerHTML = '<p class="banner-copy">Orbit data ready · verify fixture</p><div class="banner-actions"><a class="banner-action" role="button" tabindex="0">Sign in</a><button class="banner-action" role="button" tabindex="0">Reload</button></div>';
            }, { once: true, capture: true });
          });
          await page.locator('#map-legend-toggle').click();
          await page.waitForFunction(() => document.querySelector('#map-legend-toggle')?.getAttribute('aria-expanded') === 'false');
        }
        ready = true;
      }).catch((caught: unknown) => { error = String(caught); });
      await Promise.race([preparation, new Promise((done) => setTimeout(done, 10_000))]);
      if (!ready) {
        const evidence = { engine: engine.name, width, height, insets, ready, error, samples, sourceRoot: root, sourceHashes };
        if (process.env.OPD_STARTUP_EVIDENCE_DIR) {
          mkdirSync(process.env.OPD_STARTUP_EVIDENCE_DIR, { recursive: true });
          writeFileSync(resolve(process.env.OPD_STARTUP_EVIDENCE_DIR, `${engine.name}-${width}x${height}-T${insets.top}-B${insets.bottom}.json`), JSON.stringify(evidence, null, 2));
        }
        await browser.close(); await preparation;
        expect(ready, JSON.stringify(evidence)).toBe(true);
        return;
      }
      await page.waitForTimeout(500);
      const actions: unknown[] = [];
      for (const [selector, expected] of [['#map-chrome-toggle', 'false'], ['#map-chrome-toggle', 'true']] as const) {
        await page.locator(selector).evaluate((element) => {
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
        const target = await page.locator(selector).evaluate((element) => {
          const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, owns: hit === element || !!hit && element.contains(hit), rect: r.toJSON() };
        });
        expect(target.owns, JSON.stringify(target)).toBe(true);
        await page.locator(selector).click();
        const input = await page.evaluate(() => (window as unknown as TestWindow).__shortEvents.filter((event) => event.type === 'click').at(-1));
        expect(input?.trusted, JSON.stringify(input)).toBe(true);
        expect(input?.control, JSON.stringify(input)).toBe('map-chrome-toggle');
        expect(input?.expanded, JSON.stringify(input)).toBe(expected === 'false' ? 'true' : 'false');
        await page.waitForFunction((value) => document.querySelector('#map-chrome-toggle')?.getAttribute('aria-expanded') === value, expected)
          .catch((error: unknown) => { throw new Error(JSON.stringify({ selector, expected, target, input, error: String(error) })); });
        expect(await page.locator('#map-chrome-toggle').getAttribute('aria-expanded')).toBe(expected);
        actions.push({ selector, expected, target, input });
      }
      await page.waitForTimeout(500);
      const idle = await page.evaluate(async () => {
        const state = window as unknown as { __startupWrites: { class: number; style: number }; __shortEvents: InputEvent[] };
        const geometry = () => Object.fromEntries(['.map-command', '.map-controls-time', '.maplibregl-ctrl-top-left', '.map-control-dock'].map((selector) => [selector, document.querySelector(selector)?.getBoundingClientRect().toJSON()]));
        const before = { counts: { ...state.__startupWrites }, geometry: geometry() };
        await new Promise((done) => setTimeout(done, 8_000));
        const after = { counts: { ...state.__startupWrites }, geometry: geometry() };
        return { before, after, writes: { class: after.counts.class - before.counts.class, style: after.counts.style - before.counts.style }, events: state.__shortEvents };
      });
      const evidence = { engine: engine.name, width, height, insets, ready, actions, idle, sourceRoot: root, sourceHashes };
      if (process.env.OPD_STARTUP_EVIDENCE_DIR) {
        mkdirSync(process.env.OPD_STARTUP_EVIDENCE_DIR, { recursive: true });
        const path = resolve(process.env.OPD_STARTUP_EVIDENCE_DIR, `${engine.name}-${width}x${height}-T${insets.top}-B${insets.bottom}`);
        writeFileSync(`${path}.json`, JSON.stringify(evidence, null, 2));
        await page.screenshot({ path: `${path}.png`, scale: 'css' });
      }
      expect(idle.writes, JSON.stringify(evidence)).toEqual({ class: 0, style: 0 });
      expect(idle.after.geometry).toEqual(idle.before.geometry);
      expect(idle.events.filter((event) => event.type === 'click').every((event) => event.trusted)).toBe(true);
    } finally { await browser.close(); }
  }, 45_000);
});
