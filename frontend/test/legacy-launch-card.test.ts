import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumExecutablePath } from './chromium-executable';
import { freezeDate } from './freeze-date';
import fixture from './fixtures/joint-panels.json';

const webkitReady = existsSync(webkit.executablePath());
const chromePath = chromiumExecutablePath();

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
let chromeBrowser: Browser;

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
  if (webkitReady) browser = await webkit.launch({ headless: true, executablePath: webkit.executablePath() });
  chromeBrowser = await chromium.launch({ headless: true, executablePath: chromePath });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await chromeBrowser?.close();
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

describe.skipIf(!webkitReady)('legacy launch card WebKit', () => {
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

const pinEngines = [
  { name: 'WebKit', ready: webkitReady, browser: () => browser },
  { name: 'Chrome', ready: true, browser: () => chromeBrowser },
];

async function pinOverLaunch(page: Page): Promise<boolean> {
  return page.waitForFunction(() => {
    const slot = document.getElementById('map-inspector');
    if (!slot) return false;
    const popups = [...slot.querySelectorAll(':scope > .maplibregl-popup')];
    const last = popups.at(-1);
    const buriedLaunch = popups.slice(0, -1).some((popup) => popup.querySelector('.launch-ascent-card'));
    return buriedLaunch && !!last?.querySelector('.dropped-pin-popup');
  }, undefined, { timeout: 8_000 }).then(() => true, () => false);
}

async function rightClickCanvas(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const map = (window as unknown as TestWindow).__opdMap;
    return !!map?.isStyleLoaded() && !map.isMoving();
  });
  const seed = await page.locator('.maplibregl-canvas').evaluate((canvas) => {
    const box = canvas.getBoundingClientRect();
    const clear = (x: number, y: number) => {
      for (const dx of [-12, 0, 12]) {
        for (const dy of [-12, 0, 12]) {
          if (document.elementFromPoint(x + dx, y + dy) !== canvas) return false;
        }
      }
      return true;
    };
    let fallback: { x: number; y: number } | null = null;
    for (const fy of [0.18, 0.32, 0.5, 0.68, 0.82]) {
      for (const fx of [0.18, 0.32, 0.5, 0.68, 0.82]) {
        const x = box.x + box.width * fx;
        const y = box.y + box.height * fy;
        if (document.elementFromPoint(x, y) !== canvas) continue;
        if (!fallback) fallback = { x, y };
        if (clear(x, y)) return { x, y };
      }
    }
    return fallback;
  });
  expect(seed, 'a canvas point for the pin').not.toBeNull();
  await page.evaluate(() => {
    (window as unknown as TestWindow).__opdMap.dragRotate.disable();
  });
  // MapLibre drops a contextmenu that arrives before mousedown, and drops one
  // while a touch is active. WebKit on these hasTouch phones does both, so a
  // bare right click never opens the pin. Press, end the touch, deliver
  // contextmenu while the button is down, then release so mouseup fires it.
  await page.mouse.move(seed!.x, seed!.y);
  await page.mouse.down({ button: 'right' });
  await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.maplibregl-canvas');
    canvas?.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
    canvas?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 }));
  }, seed!);
  await page.mouse.up({ button: 'right' });
}

async function dropPinOverLaunch(page: Page): Promise<void> {
  await rightClickCanvas(page);
  if (await pinOverLaunch(page)) return;
  const state = await page.evaluate(() => {
    const slot = document.getElementById('map-inspector');
    const popups = [...(slot?.querySelectorAll(':scope > .maplibregl-popup') ?? [])].map((popup) => popup.querySelector('.launch-ascent-card, .dropped-pin-popup')?.className ?? 'empty');
    return { popups, pins: document.querySelectorAll('.dropped-pin-popup').length };
  });
  throw new Error(`pin did not open over the legacy card: ${JSON.stringify(state)}`);
}

async function centerTap(page: Page) {
  const point = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas');
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    const slot = document.getElementById('map-inspector');
    const slotBox = slot?.getBoundingClientRect();
    return {
      x, y,
      hit: hit?.id || (typeof hit?.className === 'string' ? hit.className : hit?.tagName) || 'none',
      canvas: hit === canvas,
      inspector: slotBox ? { x: slotBox.x, y: slotBox.y, w: slotBox.width, h: slotBox.height } : null,
    };
  });
  expect(point).not.toBeNull();
  await page.evaluate(() => { (window as unknown as TestWindow).__legacyHits = []; });
  await page.touchscreen.tap(point!.x, point!.y);
  const hits = await page.evaluate(() => (window as unknown as TestWindow).__legacyHits);
  return { point: point!, trustedCanvas: hits.some((event) => event.type === 'click' && event.trusted && event.target.includes('maplibregl-canvas')) };
}

type SheetBox = { x: number; y: number; w: number; h: number };
type SheetProbe = {
  sheet: SheetBox;
  row: SheetBox | null;
  shoot: SheetBox | null;
  hit: string;
  canvas: boolean;
  coverage: SheetBox | null;
};

function phoneContext(engine: (typeof pinEngines)[number], width: number, height: number) {
  return engine.browser().newContext({
    viewport: { width, height },
    screen: { width, height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    serviceWorkers: 'block',
  });
}

async function dropPin(page: Page) {
  await rightClickCanvas(page);
  const opened = await page.locator('.dropped-pin-popup').waitFor({ timeout: 8_000 }).then(() => true, () => false);
  if (!opened) throw new Error('pin did not open');
}

async function sheetProbe(page: Page): Promise<SheetProbe> {
  await page.waitForFunction(() => {
    const slot = document.getElementById('map-inspector');
    const box = slot?.getBoundingClientRect();
    return !!box && box.width > 20 && box.height > 20 && slot?.querySelector('.dropped-pin-popup');
  });
  return page.evaluate(() => {
    const boxOf = (element: Element | null) => {
      const box = element?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return null;
      return { x: box.x, y: box.y, w: box.width, h: box.height };
    };
    const slot = document.getElementById('map-inspector');
    const coverage = document.getElementById('map-launch-coverage');
    const canvas = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas');
    const canvasBox = canvas!.getBoundingClientRect();
    const x = canvasBox.x + canvasBox.width / 2;
    const y = canvasBox.y + canvasBox.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      sheet: boxOf(slot)!,
      row: boxOf(document.querySelector('.pin-pass-row')),
      shoot: boxOf(document.querySelector('.pin-pass-shoot')),
      hit: hit?.id || (typeof hit?.className === 'string' ? hit.className : hit?.tagName) || 'none',
      canvas: hit === canvas,
      coverage: !coverage || coverage.hidden ? null : boxOf(coverage),
    };
  });
}

function insideViewport(box: SheetBox, width: number, height: number) {
  return box.x >= -1 && box.y >= -1 && box.x + box.w <= width + 1 && box.y + box.h <= height + 1;
}

function withinCouple(actual: SheetBox, expected: SheetBox) {
  return Math.abs(actual.x - expected.x) <= 2
    && Math.abs(actual.y - expected.y) <= 2
    && Math.abs(actual.w - expected.w) <= 2
    && Math.abs(actual.h - expected.h) <= 2;
}

function overlapArea(a: SheetBox | null, b: SheetBox | null) {
  if (!a || !b) return 0;
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

async function briefState(page: Page) {
  return page.evaluate(() => {
    const brief = document.getElementById('map-launch-coverage');
    const slot = document.getElementById('map-inspector');
    const boxOf = (element: Element | null) => {
      const box = element?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return null;
      return { x: box.x, y: box.y, w: box.width, h: box.height };
    };
    const briefBox = boxOf(brief);
    const sheet = boxOf(slot);
    const style = brief ? getComputedStyle(brief) : null;
    const hitAt = (box: { x: number; y: number; w: number; h: number } | null) => {
      if (!box) return 'none';
      const hit = document.elementFromPoint(box.x + box.w / 2, box.y + box.h / 2);
      const host = hit?.closest('#map-launch-coverage, #map-inspector, .maplibregl-canvas');
      return host?.id || (typeof host?.className === 'string' ? host.className : hit?.tagName) || 'none';
    };
    return {
      hidden: brief?.hidden ?? null,
      display: style?.display ?? 'missing',
      brief: briefBox,
      sheet,
      hit: hitAt(briefBox),
    };
  });
}

for (const engine of pinEngines) describe.skipIf(!engine.ready)(`pin inspector over a legacy launch card ${engine.name}`, () => {
  it.each([
    { width: 402, height: 874 },
    { width: 874, height: 402 },
  ])('keeps a center tap on the canvas at $width×$height', async ({ width, height }) => {
    const results = [];
    for (let rep = 1; rep <= 3; rep += 1) {
      const context = await engine.browser().newContext({
        viewport: { width, height },
        screen: { width, height },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
        serviceWorkers: 'block',
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        await prepare(page);
        const pad = await padPoint(page);
        await page.touchscreen.tap(pad.x, pad.y);
        await page.locator('.launch-ascent-card[data-launch="legacy"]').waitFor();
        await dropPinOverLaunch(page);
        const tap = await centerTap(page);
        results.push({ rep, ...tap.point, trustedCanvas: tap.trustedCanvas });
      } finally {
        await context.close();
      }
    }
    console.log(`PIN_OVER_LEGACY ${JSON.stringify({ engine: engine.name, width, height, results })}`);
    expect(results.every((result) => result.canvas && result.trustedCanvas), JSON.stringify(results)).toBe(true);
  }, 120_000);

  it.each([
    { width: 402, height: 874 },
    { width: 874, height: 402 },
  ])('gives a buried launch card the same pin sheet as no card at $width×$height', async ({ width, height }) => {
    const context = await phoneContext(engine, width, height);
    try {
      const plainPage = await context.newPage();
      plainPage.setDefaultTimeout(20_000);
      await prepare(plainPage);
      await plainPage.locator('#filter-launches-map').click();
      await plainPage.waitForFunction(() => document.getElementById('map-launch-coverage')?.hidden === true);
      await dropPin(plainPage);
      const plain = await sheetProbe(plainPage);
      await plainPage.close();
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await prepare(page);
      const pad = await padPoint(page);
      await page.touchscreen.tap(pad.x, pad.y);
      await page.locator('.launch-ascent-card[data-launch="legacy"]').waitFor();
      await dropPinOverLaunch(page);
      const buried = await sheetProbe(page);
      const tap = await centerTap(page);
      const evidence = { engine: engine.name, width, height, plain, buried, trustedCanvas: tap.trustedCanvas };
      console.log(`BURIED_SHEET ${JSON.stringify(evidence)}`);
      expect(buried.row, JSON.stringify(evidence)).not.toBeNull();
      expect(buried.shoot, JSON.stringify(evidence)).not.toBeNull();
      expect(insideViewport(buried.row!, width, height), JSON.stringify(evidence)).toBe(true);
      expect(insideViewport(buried.shoot!, width, height), JSON.stringify(evidence)).toBe(true);
      expect(buried.canvas && tap.trustedCanvas, JSON.stringify(evidence)).toBe(true);
      expect(withinCouple(buried.sheet, plain.sheet), JSON.stringify(evidence)).toBe(true);
    } finally {
      await context.close();
    }
  }, 90_000);

  it.each([
    { width: 402, height: 874 },
    { width: 874, height: 402 },
  ])('hides the launch brief while a pin replaces the card and brings it back at $width×$height', async ({ width, height }) => {
    const context = await phoneContext(engine, width, height);
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await prepare(page);
      const pad = await padPoint(page);
      await page.touchscreen.tap(pad.x, pad.y);
      await page.locator('.launch-ascent-card[data-launch="legacy"]').waitFor();
      const open = await briefState(page);
      await dropPinOverLaunch(page);
      const buried = await briefState(page);
      const buriedOverlap = overlapArea(buried.brief, buried.sheet);
      await page.locator('#map-inspector > .maplibregl-popup:last-child .maplibregl-popup-close-button').click();
      await page.waitForFunction(() => {
        const slot = document.getElementById('map-inspector');
        const last = slot?.querySelector(':scope > .maplibregl-popup:last-child');
        return !!last?.querySelector('.launch-ascent-card') && document.getElementById('map-launch-coverage')?.hidden === false;
      });
      const restored = await briefState(page);
      const restoredOverlap = overlapArea(restored.brief, restored.sheet);
      const evidence = { engine: engine.name, width, height, open, buried, buriedOverlap, restored, restoredOverlap };
      console.log(`BRIEF_HOLD ${JSON.stringify(evidence)}`);
      expect(open.hidden, JSON.stringify(evidence)).toBe(false);
      expect(buried.hidden, JSON.stringify(evidence)).toBe(true);
      expect(buried.display, JSON.stringify(evidence)).toBe('none');
      expect(buriedOverlap, JSON.stringify(evidence)).toBe(0);
      expect(restored.hidden, JSON.stringify(evidence)).toBe(false);
      expect(restored.display, JSON.stringify(evidence)).not.toBe('none');
      expect(restored.brief, JSON.stringify(evidence)).not.toBeNull();
      expect(restoredOverlap, JSON.stringify(evidence)).toBe(0);
      expect(restored.hit, JSON.stringify(evidence)).toBe('map-launch-coverage');
    } finally {
      await context.close();
    }
  }, 90_000);

  it.each([
    { width: 402, height: 874 },
    { width: 874, height: 402 },
  ])('keeps the coverage brief hidden when the queue re-renders over a buried card at $width×$height', async ({ width, height }) => {
    const context = await phoneContext(engine, width, height);
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await prepare(page);
      const pad = await padPoint(page);
      await page.touchscreen.tap(pad.x, pad.y);
      await page.locator('.launch-ascent-card[data-launch="legacy"]').waitFor();
      await dropPinOverLaunch(page);
      const buried = await briefState(page);
      const trace = await page.evaluate(async () => {
        const brief = document.getElementById('map-launch-coverage');
        const button = document.querySelector<HTMLButtonElement>('#sort-time-queue');
        const slot = document.getElementById('map-inspector');
        const probe = document.createElement('span');
        probe.id = 'brief-rerender-probe';
        brief?.append(probe);
        const samples: boolean[] = [];
        const observer = new MutationObserver(() => {
          if (brief) samples.push(brief.hidden);
        });
        if (brief) observer.observe(brief, { attributes: true, attributeFilter: ['hidden'] });
        if (brief) samples.push(brief.hidden);
        button?.click();
        if (brief) samples.push(brief.hidden);
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        if (brief) samples.push(brief.hidden);
        observer.disconnect();
        const last = slot?.querySelector(':scope > .maplibregl-popup:last-child');
        return {
          samples,
          rebuilt: brief?.querySelector('#brief-rerender-probe') === null,
          launchesOn: document.getElementById('filter-launches-map')?.getAttribute('aria-pressed') === 'true',
          buried: !!slot?.querySelector('.launch-ascent-card') && !last?.querySelector('.launch-ascent-card'),
        };
      });
      const after = await briefState(page);
      const evidence = { engine: engine.name, width, height, buried, trace, after };
      console.log(`BRIEF_RERENDER ${JSON.stringify(evidence)}`);
      expect(buried.hidden, JSON.stringify(evidence)).toBe(true);
      expect(trace.rebuilt, JSON.stringify(evidence)).toBe(true);
      expect(trace.launchesOn, JSON.stringify(evidence)).toBe(true);
      expect(trace.buried, JSON.stringify(evidence)).toBe(true);
      expect(trace.samples.length, JSON.stringify(evidence)).toBeGreaterThan(0);
      expect(trace.samples.every((hidden) => hidden), JSON.stringify(evidence)).toBe(true);
      expect(after.hidden, JSON.stringify(evidence)).toBe(true);
      expect(after.display, JSON.stringify(evidence)).toBe('none');
    } finally {
      await context.close();
    }
  }, 90_000);
});
