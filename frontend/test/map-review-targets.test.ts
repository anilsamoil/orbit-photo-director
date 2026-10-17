import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Page } from 'playwright';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { tleEpochMs } from '../src/iss-sgp4';
import fixture from './fixtures/iss-sgp4-fixture.json';
import { buildPassList } from '../src/map/overlays/pass-list';
import { findUpcomingPasses } from '../src/pin-drop';
import { artifact, supported, assessment, envelope, NOW } from './launch-fixtures';
import { parseLaunchArtifact } from '../src/launch-schema';

const root = resolve(process.env.OPD_REVIEW_SOURCE_ROOT || resolve(__dirname, '..'));
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve(root, 'public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const manifest = {
  version: 'repin', generated_at: fixture.start, tle_epoch: new Date(tleEpochMs(fixture.tle)!).toISOString(),
  cloud_composite_hour: fixture.start, target_data_version: 'repin', build_version: 'repin',
  freshness: { tle_hours: 0, cloud_hours: 0, ok: true },
  artifacts: Object.fromEntries(['passes', 'track', 'status', 'top5', 'top_24h', 'cupola_windows'].map((key) => [key, { path: `${key}.json`, sha256: '', bytes: 0 }])),
};
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const origin = 'http://127.0.0.1:45262';
type Insets = { top: number; right: number; bottom: number; left: number };
async function emulateInsets(page: Page, insets: Insets): Promise<void> {
  await page.addInitScript((values) => {
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
}


const longHeading = 'INTERNATIONALSPACESTATIONZARYAEXPEDITIONINTERNATIONALSPACEST';
const targets = [
  { width: 402, height: 874, insets: { top: 62, right: 0, bottom: 34, left: 0 } },
  { width: 874, height: 402, insets: { top: 0, right: 62, bottom: 21, left: 62 } },
  { width: 834, height: 1210, insets: { top: 24, right: 0, bottom: 20, left: 0 } },
  { width: 1210, height: 834, insets: { top: 24, right: 0, bottom: 20, left: 0 } },
  { width: 1440, height: 900, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
  { width: 1280, height: 800, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
].filter((target) => !process.env.OPD_REVIEW_SIZE || process.env.OPD_REVIEW_SIZE === `${target.width}x${target.height}`);
type Target = typeof targets[number];
type PickerEdgeState = {
  started: number;
  scrolledAt: number | null;
  scrollTrusted: boolean;
  events: { type: string; trusted: boolean; owns: boolean; target: string; elapsed: number | null }[];
};
type PickerTouchState = {
  events: { type: string; trusted: boolean; owns: boolean; target: string; pointerType: string | null; rect: DOMRectJSON }[];
};
type DOMRectJSON = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const track = { ...fixture, tle_epoch: manifest.tle_epoch, tle_age_hours: 0, tle_freshness_factor: 1 };
const now = Date.parse(fixture.start);
const passes = findUpcomingPasses(track, 6.4, 40.8, now);
// The pass-row-fit name goes through production buildPassList. Its complete
// content is installed in a native-opened inspector; layout and placement stay real.
const longPassMarkup = buildPassList(6.4, 40.8, 1, [{ name: longHeading, color: '#5cd0ff', passes }], now).outerHTML;
let assets: Map<string, string | Uint8Array>;
let script: string;
let launches: Awaited<ReturnType<typeof envelope>>;
beforeAll(async () => {
  const launchItem = supported({ name: 'Verify Ascent' });
  launchItem.assessment = assessment({ net: { ...assessment().net, at: launchItem.launch_window.net } });
  const launchData = artifact([launchItem]);
  const shifted = JSON.parse(JSON.stringify(launchData).replace(/2026-09-\d\dT\d\d:\d\d:\d\d\.000Z/g, (value) => new Date(Date.parse(value) + now - NOW).toISOString()));
  launches = await envelope(parseLaunchArtifact(shifted));
  const output = await build({
    configFile: false, root, logLevel: 'silent', define: { __APP_VERSION__: JSON.stringify('review-targets-test') },
    build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'review', formats: ['iife'] } },
  });
  const bundle = Array.isArray(output) ? output[0]! : output;
  if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
  assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
}, 60_000);

async function geometry(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const clipped = { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(innerWidth, rect.right), bottom: Math.min(innerHeight, rect.bottom) };
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (/auto|hidden|scroll|clip/.test(style.overflowX)) { clipped.left = Math.max(clipped.left, box.left); clipped.right = Math.min(clipped.right, box.right); }
      if (/auto|hidden|scroll|clip/.test(style.overflowY)) { clipped.top = Math.max(clipped.top, box.top); clipped.bottom = Math.min(clipped.bottom, box.bottom); }
    }
    const points = [[rect.x + rect.width / 2, rect.y + rect.height / 2], [rect.left + 2, rect.y + rect.height / 2], [rect.right - 2, rect.y + rect.height / 2], [rect.x + rect.width / 2, rect.top + 2], [rect.x + rect.width / 2, rect.bottom - 2]].map(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return { x: x!, y: y!, owns: hit === element || !!hit && element.contains(hit), hit: hit?.id || hit?.className || hit?.tagName };
    });
    return { rect: rect.toJSON(), clipped, points };
  });
}

async function click(page: Page, selector: string) {
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  const measured = await geometry(page, selector);
  expect(measured.points[0]!.owns, JSON.stringify({ selector, measured })).toBe(true);
  await page.mouse.click(measured.points[0]!.x, measured.points[0]!.y);
  return measured;
}

async function evidence(page: Page, name: string, value: unknown) {
  if (!process.env.OPD_REVIEW_EVIDENCE_DIR) return;
  mkdirSync(process.env.OPD_REVIEW_EVIDENCE_DIR, { recursive: true });
  const path = resolve(process.env.OPD_REVIEW_EVIDENCE_DIR, name);
  writeFileSync(`${path}.json`, JSON.stringify(value, null, 2));
  await page.screenshot({ path: `${path}.png`, scale: 'css' });
}

const engines = [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
];

async function prepare(engine: typeof engines[number], target: Target) {
  const { width, height, insets } = target;
  // Each case owns the complete browser process tree, including GPU resources.
  // Match the established startup harness's default backend instead of forcing
  // SwiftShader and retaining its GPU process across all sixteen map contexts.
  const browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath });
  try {
    // Native backing scales: iPhone 3x, iPad M4 2x in both orientations, desktop 1x.
    const deviceScaleFactor = Math.min(width, height) < 500 ? 3 : width < 1280 ? 2 : 1;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', hasTouch: width < 1300, deviceScaleFactor });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const cdp = engine.name === 'Chrome' ? await context.newCDPSession(page) : null;
    if (cdp) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
    else await emulateInsets(page, insets);
    await page.clock.setFixedTime(new Date(fixture.start));
    const css = cdp ? stylesheet : stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof Insets) => `${insets[side]}px`);
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'celestrak.org') return route.fulfill({ contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: `LOCAL FIXTURE\n${fixture.tle.line1}\n${fixture.tle.line2}` });
      if (url.origin === origin && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html.replace('</head>', `<style>${vendor}\n${css}</style></head>`).replace('</body>', `<script src="/${script}"></script></body>`) });
      const asset = assets.get(url.pathname);
      if (url.origin === origin && asset !== undefined) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: typeof asset === 'string' ? asset : Buffer.from(asset) });
      if (url.pathname === '/manifest.json') return route.fulfill({ json: manifest });
      if (['/passes.json', '/top5.json', '/top_24h.json', '/cupola_windows.json'].includes(url.pathname)) return route.fulfill({ json: [] });
      if (url.pathname === '/status.json') return route.fulfill({ json: { last_run: fixture.start, tick_minutes: 30, tle_age_hours: 0, tle_freshness_factor: 1, cloud_source: 'gibs', cloud_composite_hour: fixture.start, target_count: 0, pass_count: 0, version: 'review', build_version: 'review' } });
      if (url.pathname === '/launch/latest.json') return route.fulfill({ json: launches.pointer });
      if (url.pathname === `/${launches.pointer.path}`) return route.fulfill({ contentType: 'application/json', body: launches.body });
      if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'review', displayName: 'Local fixture' } } });
      if (url.pathname.startsWith('/api/browser/profiles/')) return route.fulfill({ json: { ok: true, count: 0, targets: [] } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
      if (url.pathname === '/track.json') return route.fulfill({ json: track });
      if (/\.(png|jpe?g)$/.test(url.pathname) || url.pathname.includes('/MapServer/tile/')) return route.fulfill({ contentType: 'image/png', body: raster });
      return route.abort();
    });
    await page.addInitScript((start) => {
      localStorage.setItem('opd-map-chrome', 'shown');
      const at = new Date(Date.parse(start) + 60 * 60 * 1000).toISOString();
      const shot = JSON.stringify([{ key: `review|${at}`, target_id: 'review', target_name: 'Review fixture', closest_approach: at }]);
      localStorage.setItem('opd_shotlist_v1:review', shot);
      localStorage.setItem('opd_shotlist_v1', shot);
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      const readiness = { countdownTicks: 0 };
      (window as unknown as { __reviewReadiness: typeof readiness }).__reviewReadiness = readiness;
      const scheduleInterval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (typeof handler !== 'function' || handler.name !== 'rerenderCountdowns') return scheduleInterval(handler, delay, ...args);
        return scheduleInterval(function (this: Window, ...values: unknown[]) {
          const result = Reflect.apply(handler, this, values);
          readiness.countdownTicks += 1;
          return result;
        }, delay, ...args);
      }) as typeof window.setInterval;
      const events: { type: string; trusted: boolean; target: string }[] = [];
      (window as unknown as { __reviewEvents: typeof events }).__reviewEvents = events;
      for (const type of ['pointerdown', 'pointerup', 'click', 'contextmenu', 'input']) document.addEventListener(type, (event) => {
        const element = event.target as Element;
        events.push({ type, trusted: event.isTrusted, target: element.id || element.className || element.tagName });
      }, true);
    }, fixture.start);
    await page.goto(`${origin}/?e2e&u=review`, { waitUntil: 'domcontentloaded' });
    // The first countdown tick initializes launchStore's boundary key and
    // replaces the brief. Wait for that real render before taking native targets.
    await page.waitForFunction((sha256) => {
      const saved = JSON.parse(localStorage.getItem('opd-launch-v2') || 'null');
      return saved?.pointer?.sha256 === sha256
        && (window as unknown as { __reviewReadiness: { countdownTicks: number } }).__reviewReadiness.countdownTicks > 0;
    }, launches.pointer.sha256);
    await click(page, '#tab-map');
    await page.waitForFunction(() => {
      const map = (window as unknown as { __opdMap?: import('maplibre-gl').Map }).__opdMap;
      return map?.isStyleLoaded() && !!map.getSource('iss-track');
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.body.classList.contains('shotlist-bar-visible'));
    // Hold the exact production recovery-banner content while unrelated status ticks run.
    await page.evaluate(() => {
      const banner = document.querySelector('#status-banner')!;
      banner.className = 'banner banner-red';
      const copy = '<p class="banner-copy">SIGN IN AGAIN — session expired, data frozen 26h 0m ago. Tap here.</p><div class="banner-actions"><a class="banner-action" role="button" tabindex="0">Sign in</a><button class="banner-action">Reload</button></div>';
      const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;
      const apply = () => { banner.innerHTML = copy; };
      Object.defineProperty(banner, 'textContent', { configurable: true, get() { return descriptor.get!.call(this); }, set() { apply(); } });
      apply();
    });
    await page.waitForTimeout(400);
    const applied = await page.evaluate(() => {
      const probe = document.createElement('div');
      for (const side of ['top', 'right', 'bottom', 'left']) probe.style.setProperty(`padding-${side}`, `env(safe-area-inset-${side}, 0px)`);
      document.body.appendChild(probe);
      const css = getComputedStyle(probe);
      const values = { top: parseFloat(css.paddingTop), right: parseFloat(css.paddingRight), bottom: parseFloat(css.paddingBottom), left: parseFloat(css.paddingLeft) };
      probe.remove(); return values;
    });
    expect(applied).toEqual(insets);
    return { page, browser };
  } catch (error) { await browser.close(); throw error; }
}

for (const engine of engines) describe.skipIf(!existsSync(engine.executablePath))(`supported review regressions ${engine.name}`, () => {
  it.each(targets.filter((target) => target.width === 402 || target.width === 874).flatMap((target) =>
    [3, 4].flatMap((row) => [1, 2].map((inset) => ({ ...target, row, inset }))),
  ))('P2: repeated native picker touches keep row $row hit geometry at $width×$height, edge $inset px', async (target) => {
    const { page, browser } = await prepare(engine, target);
    try {
      await click(page, '#map-legend-toggle');
      await click(page, '#toggle-satellite-picker');
      const selector = `#satellite-picker-list label:nth-child(${target.row})`;
      await page.locator(selector).scrollIntoViewIfNeeded();
      // Let the scrollbar fade: this regression is the touch-induced hover box,
      // independently of the immediate-after-scroll reservation test below.
      await page.waitForTimeout(3200);
      await page.evaluate((selector) => {
        const state: PickerTouchState = { events: [] };
        (window as unknown as { __pickerTouch: PickerTouchState }).__pickerTouch = state;
        for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, (event) => {
          // Selection renders a fresh list; resolve the current label each time.
          const element = document.querySelector(selector)!;
          const hit = event.target as Element;
          const rect = element.getBoundingClientRect();
          state.events.push({ type, trusted: event.isTrusted, owns: hit === element || element.contains(hit), target: hit.id || hit.tagName,
            pointerType: event instanceof PointerEvent ? event.pointerType : null,
            rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } });
        }, true);
      }, selector);
      const initial = await geometry(page, selector);
      expect(initial.points[0]!.owns, JSON.stringify(initial)).toBe(true);
      await page.touchscreen.tap(initial.points[0]!.x, initial.points[0]!.y);
      await page.waitForFunction(() => document.querySelector('#satellite-picker-status')!.textContent === 'Tracking added');
      expect(await page.locator(`${selector} input`).isChecked()).toBe(true);
      await page.waitForTimeout(250);
      const centerEvents = await page.evaluate(() => (window as unknown as { __pickerTouch: PickerTouchState }).__pickerTouch.events);
      const touches = [];
      // Uncheck at the painted edge, then recheck there without a mouse move or
      // a center recovery. Both gestures must retain their original hit target.
      for (const checked of [false, true]) {
        const before = await geometry(page, selector);
        const point = { x: before.rect.right - target.inset, y: before.rect.y + before.rect.height / 2 };
        const owns = await page.locator(selector).evaluate((element, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit === element || !!hit && element.contains(hit);
        }, point);
        await page.evaluate(() => { (window as unknown as { __pickerTouch: PickerTouchState }).__pickerTouch.events.length = 0; });
        await page.touchscreen.tap(point.x, point.y);
        await page.waitForTimeout(250);
        touches.push({ before, point, owns, expectedChecked: checked,
          checked: await page.locator(`${selector} input`).isChecked(), after: await geometry(page, selector),
          events: await page.evaluate(() => (window as unknown as { __pickerTouch: PickerTouchState }).__pickerTouch.events) });
      }
      await evidence(page, `${engine.name}-P2-repeat-${target.width}x${target.height}-row${target.row}-edge${target.inset}`, { target, initial, centerEvents, touches });
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        expect.soft(centerEvents.some((event) => event.type === type && event.trusted && event.owns), JSON.stringify(centerEvents)).toBe(true);
      }
      for (const touch of touches) {
        const detail = JSON.stringify(touch);
        expect.soft(touch.owns, detail).toBe(true);
        expect.soft(touch.checked, detail).toBe(touch.expectedChecked);
        for (const type of ['pointerdown', 'pointerup', 'click']) {
          expect.soft(touch.events.some((event) => event.type === type && event.trusted && event.owns), detail).toBe(true);
        }
        expect.soft(touch.events.filter((event) => event.type.startsWith('pointer')).map((event) => event.pointerType), detail).toEqual(['touch', 'touch']);
        for (const rect of [touch.before.rect, ...touch.events.map((event) => event.rect), touch.after.rect]) {
          expect.soft(rect.height, detail).toBeGreaterThanOrEqual(44);
          for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
            expect.soft(Math.abs(rect[edge] - initial.rect[edge]), detail).toBeLessThanOrEqual(0.1);
          }
        }
      }
    } finally { await browser.close(); }
  }, 60_000);

  it.each(targets.filter((target) => target.width === 402 || target.width === 874).flatMap((target) => [
    { ...target, control: 'label', selector: '#satellite-picker-list label:nth-child(3)' },
    { ...target, control: 'input', selector: '#satellite-picker-input' },
  ]))('P2: picker $control accepts a native right-edge tap immediately after scrolling at $width×$height', async (target) => {
    const { page, browser } = await prepare(engine, target);
    try {
      await click(page, '#map-legend-toggle');
      await click(page, '#toggle-satellite-picker');
      await page.waitForSelector('#satellite-picker-panel:not([hidden])');
      const before = await page.evaluate((selector) => {
        const panel = document.querySelector('#satellite-picker-panel')!;
        const element = document.querySelector(selector)!;
        const edge: PickerEdgeState = { started: performance.now(), scrolledAt: null, scrollTrusted: false, events: [] };
        (window as unknown as { __pickerEdge: PickerEdgeState }).__pickerEdge = edge;
        panel.addEventListener('scroll', (event) => {
          edge.scrolledAt = event.timeStamp;
          edge.scrollTrusted = event.isTrusted;
        }, { once: true });
        for (const type of ['pointerdown', 'pointerup', 'click', 'focus']) document.addEventListener(type, (event) => {
          const hit = event.target as Element;
          edge.events.push({ type, trusted: event.isTrusted, owns: hit === element || element.contains(hit), target: hit.id || hit.tagName, elapsed: edge.scrolledAt === null ? null : event.timeStamp - edge.scrolledAt });
        }, true);
        return { scrollTop: panel.scrollTop };
      }, target.selector);
      await page.locator(target.selector).scrollIntoViewIfNeeded();
      await page.waitForFunction(() => (window as unknown as { __pickerEdge: PickerEdgeState }).__pickerEdge.scrolledAt !== null);
      // Exercise the visible native scrollbar, not the settled state after its fade.
      // Locator preparation can be slow; the timing origin is the browser's scroll event.
      await page.waitForTimeout(100);
      const measured = await geometry(page, target.selector);
      const point = measured.points[2]!;
      await page.touchscreen.tap(point.x, point.y);
      await page.waitForTimeout(100);
      const after = await page.evaluate((selector) => {
        const element = document.querySelector(selector)!;
        const edge = (window as unknown as { __pickerEdge: PickerEdgeState }).__pickerEdge;
        return {
          scrollTop: document.querySelector('#satellite-picker-panel')!.scrollTop,
          scrolledAt: edge.scrolledAt,
          scrollTrusted: edge.scrollTrusted,
          preScrollElapsed: edge.scrolledAt === null ? null : edge.scrolledAt - edge.started,
          activated: element.matches('label') ? element.querySelector<HTMLInputElement>('input')!.checked : document.activeElement === element,
          events: edge.events,
        };
      }, target.selector);
      await evidence(page, `${engine.name}-P2-${target.width}x${target.height}-${target.control}`, { target, before, measured, after });
      expect.soft(after.scrollTop, JSON.stringify({ before, after })).toBeGreaterThan(before.scrollTop);
      expect.soft(after.scrollTrusted, JSON.stringify(after)).toBe(true);
      expect.soft(measured.rect.height).toBeGreaterThanOrEqual(44);
      expect.soft(point.owns, JSON.stringify({ point, after })).toBe(true);
      expect.soft(after.activated, JSON.stringify(after)).toBe(true);
      expect.soft(after.events.some((event) => event.type === 'click' && event.trusted && event.owns), JSON.stringify(after)).toBe(true);
      const down = after.events.find((event) => event.type === 'pointerdown');
      expect.soft(down?.trusted, JSON.stringify(after)).toBe(true);
      expect.soft(down?.elapsed, JSON.stringify(after)).toBeGreaterThanOrEqual(0);
      expect.soft(down?.elapsed, JSON.stringify(after)).toBeLessThan(1000);
    } finally { await browser.close(); }
  }, 60_000);

  it.each(targets)('F1: picker has 44px effective native targets at $width×$height', async (target) => {
    const { page, browser } = await prepare(engine, target);
    try {
      await click(page, '#map-legend-toggle');
      await click(page, '#toggle-satellite-picker');
      await page.waitForSelector('#satellite-picker-panel:not([hidden])');
      const measured = [];
      for (let index = 1; index <= 4; index += 1) {
        const selector = `#satellite-picker-list label:nth-child(${index})`;
        const box = await click(page, selector);
        measured.push({ selector, ...box });
        expect.soft(box.rect.height, JSON.stringify({ selector, box })).toBeGreaterThanOrEqual(44);
        expect.soft(box.points.every((point) => point.owns), JSON.stringify({ selector, box })).toBe(true);
        await page.waitForFunction(() => document.querySelector('#satellite-picker-status')!.textContent === 'Tracking added');
        await page.waitForTimeout(100);
        expect(await page.locator(`${selector} input`).isChecked()).toBe(true);
      }
      const input = await click(page, '#satellite-picker-input');
      measured.push({ selector: '#satellite-picker-input', ...input });
      expect.soft(input.rect.height, JSON.stringify(input)).toBeGreaterThanOrEqual(44);
      await page.keyboard.type('25545');
      const add = await click(page, '#satellite-picker-add');
      measured.push({ selector: '#satellite-picker-add', ...add });
      expect.soft(add.rect.height, JSON.stringify(add)).toBeGreaterThanOrEqual(44);
      await page.waitForFunction(() => document.querySelector('#satellite-picker-status')!.textContent === 'Tracking added');
      expect(await page.locator('#satellite-picker-input').inputValue()).toBe('');
      const events = await page.evaluate(() => (window as unknown as { __reviewEvents: unknown[] }).__reviewEvents);
      await evidence(page, `${engine.name}-F1-${target.width}x${target.height}`, { target, measured, events });
    } finally { await browser.close(); }
  }, 60_000);

  it.each(targets)('F2: schema-2 fallback title opens details with a 44px native target at $width×$height', async (target) => {
    const { page, browser } = await prepare(engine, target);
    try {
      await click(page, '#filter-launches-map');
      await page.waitForSelector('.map-launch-brief summary');
      if (!await page.locator('.map-launch-primary').evaluate((element) => (element as HTMLDetailsElement).open)) await click(page, '.map-launch-brief summary');
      await page.waitForSelector('.map-launch-brief .launch-name');
      const title = await click(page, '.map-launch-brief .launch-name');
      expect.soft(title.rect.height, JSON.stringify(title)).toBeGreaterThanOrEqual(44);
      expect.soft(title.points.every((point) => point.owns), JSON.stringify(title)).toBe(true);
      await page.waitForSelector('#launch-details-title');
      expect(await page.locator('#launch-details-title').textContent()).toBe('LAUNCH / ASCENT: Verify Ascent');
      const events = await page.evaluate(() => (window as unknown as { __reviewEvents: unknown[] }).__reviewEvents);
      await evidence(page, `${engine.name}-F2-${target.width}x${target.height}`, { target, title, events });
    } finally { await browser.close(); }
  }, 60_000);

  it.each([false, true].flatMap((legend) => [
    { legend, shown: true, target: { width: 874, height: 402, insets: { top: 0, right: 62, bottom: 21, left: 62 } } },
    { legend, shown: false, target: { width: 402, height: 874, insets: { top: 62, right: 0, bottom: 34, left: 0 } } },
  ]))('F3: long pass fixture clears Close and fits first row at $target.width×$target.height, Controls=$shown, Legend=$legend', async ({ legend, shown, target }) => {
    const { page, browser } = await prepare(engine, target);
    try {
      if (await page.locator('#toggle-follow-iss').getAttribute('aria-pressed') === 'true') await click(page, '#toggle-follow-iss');
      await click(page, '#bearing-north');
      await page.evaluate(() => (window as unknown as { __opdMap: import('maplibre-gl').Map }).__opdMap.jumpTo({ center: [40.8, 6.4], zoom: 3 }));
      await page.waitForTimeout(300);
      const point = await page.locator('.maplibregl-canvas').evaluate((canvas) => {
        const r = canvas.getBoundingClientRect();
        for (const fx of [.5, .4, .6]) for (const fy of [.5, .35, .65]) {
          const x = r.x + r.width * fx, y = r.y + r.height * fy;
          if (document.elementFromPoint(x, y) === canvas) return { x, y };
        }
        throw new Error('No hit-owned canvas point');
      });
      await page.mouse.click(point.x, point.y, { button: 'right' });
      await page.locator('.dropped-pin-popup').waitFor({ state: 'attached' });
      await page.locator('.dropped-pin-popup').evaluate((element, markup) => { element.outerHTML = markup; }, longPassMarkup);
      if (legend) await click(page, '#map-legend-toggle');
      if (!shown) await click(page, '#map-chrome-toggle');
      await page.waitForTimeout(500);
      const measured = await page.evaluate(() => {
        const popup = document.querySelector<HTMLElement>('#map-inspector .maplibregl-popup-content')!;
        const rect = popup.getBoundingClientRect();
        const textRects = (element: Element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const result: ReturnType<DOMRect['toJSON']>[] = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            result.push(...[...range.getClientRects()].filter((r) => r.width && r.height).map((r) => r.toJSON()));
          }
          return result;
        };
        const heading = textRects(popup.querySelector('.pin-pass-heading')!);
        const close = textRects(popup.querySelector('.maplibregl-popup-close-button')!);
        const row = popup.querySelector('.pin-pass-row')!;
        const content = [...textRects(popup.querySelector('.dropped-pin-popup > strong')!), ...heading, ...textRects(row)];
        const overlaps = heading.flatMap((a) => close.filter((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .01 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .01).map((b) => ({ heading: a, close: b })));
        const clippingBounds = [{ name: 'viewport', left: 0, top: 0, right: innerWidth, bottom: innerHeight }];
        for (let parent: Element | null = popup; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
          const x = /auto|scroll|hidden|clip/.test(style.overflowX), y = /auto|scroll|hidden|clip/.test(style.overflowY);
          if (x || y) clippingBounds.push({ name: parent.id || parent.className, left: x ? box.left : -Infinity, right: x ? box.right : Infinity, top: y ? box.top : -Infinity, bottom: y ? box.bottom : Infinity });
        }
        const clips = content.flatMap((r) => clippingBounds.filter((b) => r.left < b.left || r.right > b.right || r.top < b.top || r.bottom > b.bottom).map((b) => ({ rect: r, ancestor: b.name })));
        return { popup: rect.toJSON(), firstRow: row.getBoundingClientRect().toJSON(), scrollTop: popup.scrollTop, heading, close, overlaps, clips, content, events: (window as unknown as { __reviewEvents: { type: string; trusted: boolean; target: string }[] }).__reviewEvents };
      });
      await evidence(page, `${engine.name}-F3-${target.width}x${target.height}-shown-${shown}-legend-${legend}`, { target, shown, legend, measured });
      expect.soft(measured.scrollTop).toBe(0);
      // F3's narrow landscape has actual heading/Close ink overlap. The wide
      // portrait KEEP has intersecting line boxes but separated glyph ink.
      if (shown) expect.soft(measured.overlaps, JSON.stringify(measured)).toEqual([]);
      expect.soft(measured.clips, JSON.stringify(measured)).toEqual([]);
      expect.soft(measured.firstRow.bottom, JSON.stringify(measured)).toBeLessThanOrEqual(measured.popup.bottom);
      expect.soft(measured.events.every((event) => event.trusted)).toBe(true);
      expect.soft(measured.events.some((event) => event.type === 'contextmenu' && event.target === 'maplibregl-canvas')).toBe(true);
      await click(page, '#map-inspector .maplibregl-popup-close-button');
      expect(await page.locator('.dropped-pin-popup').count()).toBe(0);
    } finally { await browser.close(); }
  }, 60_000);
});
