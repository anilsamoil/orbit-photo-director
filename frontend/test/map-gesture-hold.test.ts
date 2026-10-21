import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, webkit, type BrowserContext, type CDPSession, type Page } from 'playwright';

const require = createRequire(import.meta.url);
const wkPagePath = resolve(dirname(require.resolve('playwright-core')), 'lib/server/webkit/wkPage.js');
const wkPageApi = require(wkPagePath) as {
  WKPage: { prototype: object };
};
type WebKitTouchSession = { send(method: string, params: object): Promise<unknown> };
const webKitTouchSessions: WebKitTouchSession[] = [];
Object.defineProperty(wkPageApi.WKPage.prototype, '_pageProxySession', {
  configurable: true,
  set(value: WebKitTouchSession) {
    Object.defineProperty(this, '_pageProxySession', { value, writable: true, configurable: true });
    webKitTouchSessions.push(value);
  },
  get() {
    return undefined;
  },
});
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveIssPositionSGP4, tleEpochMs } from '../src/iss-sgp4';
import { closeBrowser, launchTracked, type TrackedBrowser } from './close-browser.mjs';
import fixture from './fixtures/iss-sgp4-fixture.json';

const root = resolve(__dirname, '..');
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(existsSync);
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8');
const vendorCss = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const REPS = Number(process.env.GESTURE_REPS ?? '1');

function tleAt(line1: string, epochMs: number): string {
  const year = new Date(epochMs).getUTCFullYear();
  const day = (epochMs - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  const whole = Math.floor(day);
  const fraction = (day - whole).toFixed(8).slice(1);
  const epoch = `${String(year % 100).padStart(2, '0')}${String(whole).padStart(3, '0')}${fraction}`;
  const body = `${line1.slice(0, 18)}${epoch}${line1.slice(32, 68)}`;
  const checksum = [...body].reduce((sum, ch) => sum + (ch === '-' ? 1 : ch >= '0' && ch <= '9' ? Number(ch) : 0), 0) % 10;
  return `${body}${checksum}`;
}

const tle = { line1: tleAt(fixture.tle.line1, Date.now() - 60_000), line2: fixture.tle.line2 };
const tleEpoch = new Date(tleEpochMs(tle)!).toISOString();
const live = liveIssPositionSGP4({ ...fixture, tle, tle_epoch: tleEpoch, tle_age_hours: 0, tle_freshness_factor: 1 }, Date.now());
if (!live) throw new Error('retargeted TLE does not propagate on the real clock');

const manifest = {
  version: 'gesture', generated_at: fixture.start, tle_epoch: tleEpoch,
  cloud_composite_hour: fixture.start, target_data_version: 'gesture', build_version: 'gesture',
  freshness: { tle_hours: 0, cloud_hours: 0, ok: true },
  artifacts: Object.fromEntries(['passes', 'track', 'status', 'top5', 'top_24h', 'cupola_windows'].map((key) => [key, { path: `${key}.json`, sha256: '', bytes: 0 }])),
};
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const origin = 'http://gesture.test';

type MapHandle = {
  isStyleLoaded(): boolean;
  getSource(id: string): unknown;
  getBearing(): number;
  getCenter(): { lng: number; lat: number };
  getPitch(): number;
  isMoving(): boolean;
  setCenter(center: [number, number]): unknown;
  jumpTo(camera: { bearing?: number; pitch?: number }): void;
  on(event: 'move', handler: () => void): void;
  __samples?: number[];
  __pitches?: number[];
  __centers?: number;
};

let assets: Map<string, string | Uint8Array>;
let script: string;

beforeAll(async () => {
  const output = await build({
    configFile: false, root, logLevel: 'silent', define: { __APP_VERSION__: JSON.stringify('gesture-test') },
    build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'gesture', formats: ['iife'] } },
  });
  const bundle = Array.isArray(output) ? output[0]! : output;
  if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
  assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
}, 60_000);

async function openMap(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).hostname === 'celestrak.org') {
      return route.fulfill({ contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: `ISS\n${tle.line1}\n${tle.line2}` });
    }
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: html.replace('</head>', `<style>${vendorCss}\n${stylesheet}</style></head>`).replace('</body>', `<script src="/${script}"></script></body>`) });
    }
    const asset = assets.get(url.pathname);
    if (url.origin === origin && asset !== undefined) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: typeof asset === 'string' ? asset : Buffer.from(asset) });
    if (url.pathname === '/manifest.json') return route.fulfill({ json: manifest });
    if (['/passes.json', '/top5.json', '/top_24h.json', '/cupola_windows.json'].includes(url.pathname)) return route.fulfill({ json: [] });
    if (url.pathname === '/status.json') return route.fulfill({ json: { last_run: fixture.start, tick_minutes: 30, tle_age_hours: 0, tle_freshness_factor: 1, cloud_source: 'gibs', cloud_composite_hour: fixture.start, target_count: 0, pass_count: 0, version: 'gesture', build_version: 'gesture' } });
    if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'gesture', displayName: 'Local fixture' } } });
    if (url.pathname.startsWith('/api/browser/profiles/')) return route.fulfill({ json: { ok: true, count: 0, targets: [] } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
    if (url.pathname === '/track.json') return route.fulfill({ json: { ...fixture, tle, tle_epoch: tleEpoch, tle_age_hours: 0, tle_freshness_factor: 1 } });
    if (/\.(png|jpe?g)$/.test(url.pathname) || url.pathname.includes('/MapServer/tile/')) return route.fulfill({ contentType: 'image/png', body: raster });
    return route.abort();
  });
  await page.addInitScript(() => {
    localStorage.setItem('opd-map-chrome', 'shown');
  });
  await page.goto(`${origin}/?e2e&u=gesture`, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-map').click();
  await page.waitForFunction(() => {
    const map = (window as unknown as { __opdMap?: MapHandle }).__opdMap;
    return !!map?.isStyleLoaded() && !!map.getSource('iss-track');
  });
  await page.waitForFunction(() => document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed') === 'true');
}

async function northStill(page: Page): Promise<void> {
  await page.locator('#bearing-north').click();
  await page.waitForFunction(() => {
    const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
    return !map.isMoving() && Math.abs(map.getBearing()) < 0.01;
  });
}

async function watchMove(page: Page): Promise<void> {
  await page.evaluate(() => {
    const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
    map.__samples = [];
    map.__pitches = [];
    map.on('move', () => {
      map.__samples!.push(map.getBearing());
      map.__pitches!.push(map.getPitch());
    });
  });
}

function snappedToZero(samples: number[]): boolean {
  let left = false;
  for (const value of samples) {
    if (Math.abs(value) > 15) left = true;
    if (left && Math.abs(value) < 1) return true;
  }
  return false;
}

async function canvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('#map .maplibregl-canvas').boundingBox();
  if (!box) throw new Error('map canvas has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function gestureState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const map = (window as unknown as { __opdMap: MapHandle & {
      isRotating(): boolean;
      dragRotate: { isActive(): boolean; _mouseRotate?: { _active?: boolean; _lastPoint?: unknown; _moved?: boolean }; _mousePitch?: { _active?: boolean; _lastPoint?: unknown } };
      dragPan: { isActive(): boolean; _mousePan?: { _active?: boolean; _lastPoint?: unknown } };
      touchZoomRotate: { isActive(): boolean; _touchRotate?: { _active?: boolean; _firstTwoTouches?: unknown }; _touchZoom?: { _firstTwoTouches?: unknown } };
      touchPitch: { isActive(): boolean; _active?: boolean; _firstTwoTouches?: unknown };
      keyboard: { isActive(): boolean };
    } }).__opdMap;
    return {
      pressed: document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed'),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      moving: map.isMoving(),
      rotating: map.isRotating(),
      dragRotate: map.dragRotate.isActive(),
      dragPan: map.dragPan.isActive(),
      touch: map.touchZoomRotate.isActive(),
      pitchHandler: map.touchPitch.isActive(),
      keyboard: map.keyboard.isActive(),
      lastRotate: map.dragRotate._mouseRotate?._lastPoint != null,
      rotateActive: map.dragRotate._mouseRotate?._active === true,
      rotateMoved: map.dragRotate._mouseRotate?._moved === true,
      lastPan: map.dragPan._mousePan?._lastPoint != null,
      pinch: map.touchZoomRotate._touchRotate?._firstTwoTouches != null || map.touchZoomRotate._touchZoom?._firstTwoTouches != null,
      touchRotateActive: map.touchZoomRotate._touchRotate?._active === true,
      pitchTouches: map.touchPitch._firstTwoTouches != null,
      samples: [...(map.__samples ?? [])],
      pitches: [...(map.__pitches ?? [])],
    };
  });
}

async function drag(page: Page, button: 'right' | 'left', ctrl: boolean): Promise<Record<string, unknown>> {
  const { x, y } = await canvasPoint(page);
  await page.mouse.move(x, y);
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.down({ button });
  let seen = 0;
  for (let i = 1; seen < 40 && i <= 16; i += 1) {
    await page.mouse.move(x + i * 14, y);
    try {
      await page.waitForFunction((floor) => {
        const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
        return Math.abs(map.getBearing()) > floor;
      }, seen, { timeout: 20_000 });
    } catch (error) {
      const state = await gestureState(page);
      throw new Error(`${String(error)} step=${i} seen=${seen} ${JSON.stringify(state)}`);
    }
    seen = await page.evaluate(() => Math.abs((window as unknown as { __opdMap: MapHandle }).__opdMap.getBearing()));
  }
  await page.waitForTimeout(1100);
  const held = await gestureState(page);
  await page.mouse.up({ button });
  if (ctrl) await page.keyboard.up('Control');
  await page.waitForFunction(() => !(window as unknown as { __opdMap: MapHandle }).__opdMap.isMoving());
  return held;
}

async function armGestureTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const map = (window as unknown as { __opdMap: MapHandle & { on(type: string, handler: (event: { originalEvent?: Event }) => void): void } }).__opdMap;
    (window as unknown as { __gestureTrace?: unknown[] }).__gestureTrace = [];
    for (const name of ['rotatestart', 'pitchstart', 'dragstart']) {
      map.on(name, (event) => {
        const original = event.originalEvent;
        (window as unknown as { __gestureTrace: unknown[] }).__gestureTrace.push({
          name,
          type: original?.type ?? null,
          trusted: original?.isTrusted ?? null,
        });
      });
    }
  });
}

async function sendRealTouch(engine: string, client: CDPSession | null, type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]): Promise<void> {
  const touchPoints = points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y), id: point.id }));
  if (engine === 'Chrome') {
    if (!client) throw new Error('Chrome touch session was not opened');
    await client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : touchPoints });
    return;
  }
  const session = webKitTouchSessions.at(-1);
  if (!session) throw new Error('WebKit touch session was not captured');
  await session.send('Input.dispatchTouchEvent', { type, touchPoints });
}

async function touchGesture(page: Page, engine: string, kind: 'rotate' | 'pitch'): Promise<Record<string, unknown>> {
  const { x, y } = await canvasPoint(page);
  const pair = (step: number): { x: number; y: number; id: number }[] => kind === 'pitch'
    ? [{ x: x - 60, y: y - step * 16, id: 1 }, { x: x + 60, y: y - step * 16, id: 2 }]
    : [
      { x: x + 60 * Math.cos(Math.PI / 2 + step * 0.35), y: y + 60 * Math.sin(Math.PI / 2 + step * 0.35), id: 1 },
      { x: x + 60 * Math.cos(-Math.PI / 2 + step * 0.35), y: y + 60 * Math.sin(-Math.PI / 2 + step * 0.35), id: 2 },
    ];
  await armGestureTrace(page);
  const client = engine === 'Chrome' ? await page.context().newCDPSession(page) : null;
  try {
    await sendRealTouch(engine, client, 'touchStart', pair(0));
    for (let step = 1; step <= 8; step += 1) {
      await sendRealTouch(engine, client, 'touchMove', pair(step));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    }
    await page.waitForTimeout(1100);
    const held = await gestureState(page);
    const trace = await page.evaluate(() => (window as unknown as { __gestureTrace?: unknown[] }).__gestureTrace ?? []);
    held.trace = trace;
    await sendRealTouch(engine, client, 'touchEnd', pair(8));
    await page.waitForFunction(() => !(window as unknown as { __opdMap: MapHandle }).__opdMap.isMoving());
    await page.waitForTimeout(1200);
    const after = await gestureState(page);
    held.afterBearing = after.bearing;
    held.afterPitch = after.pitch;
    held.afterPressed = after.pressed;
    held.afterSamples = after.samples;
    return held;
  } finally {
    await client?.detach();
  }
}

async function armCenters(page: Page): Promise<void> {
  await page.evaluate(() => {
    const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
    const orig = map.setCenter.bind(map);
    map.__centers = 0;
    map.setCenter = (center) => {
      map.__centers = (map.__centers ?? 0) + 1;
      return orig(center);
    };
  });
}

async function resumeFollow(page: Page): Promise<void> {
  const pressed = await page.locator('#toggle-follow-iss').getAttribute('aria-pressed');
  if (pressed !== 'true') await page.locator('#toggle-follow-iss').click();
  await armCenters(page);
  try {
    await page.evaluate(async () => {
      const start = performance.now();
      const label = document.getElementById('iss-now');
      let ticks = 0;
      const observer = label ? new MutationObserver(() => { ticks += 1; }) : null;
      if (label) observer?.observe(label, { childList: true, characterData: true, subtree: true });
      await new Promise<void>((resolve, reject) => {
        const step = (): void => {
          const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
          if ((map.__centers ?? 0) > 0) {
            observer?.disconnect();
            resolve();
            return;
          }
          if (performance.now() - start > 8000) {
            observer?.disconnect();
            reject(new Error(`follow did not recenter ticks=${ticks}`));
            return;
          }
          setTimeout(step, 100);
        };
        setTimeout(step, 100);
      });
    });
  } catch (error) {
    const state = await page.evaluate(() => {
      const map = (window as unknown as { __opdMap: MapHandle & {
        isRotating(): boolean;
        dragRotate: { isActive(): boolean; _mouseRotate?: { _lastPoint?: unknown }; _mousePitch?: { _lastPoint?: unknown }; _mouseRoll?: { _lastPoint?: unknown } };
        dragPan: { isActive(): boolean; _mousePan?: { _lastPoint?: unknown }; _touchPan?: { _lastPoint?: unknown } };
        touchZoomRotate: { isActive(): boolean; _touchZoom?: { _firstTwoTouches?: unknown }; _touchRotate?: { _firstTwoTouches?: unknown } };
        touchPitch: { isActive(): boolean; _firstTwoTouches?: unknown };
        keyboard: { isActive(): boolean };
      } }).__opdMap;
      const held = (point: { _lastPoint?: unknown } | undefined): boolean => point?._lastPoint != null;
      return {
        pressed: document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed'),
        hidden: document.hidden,
        visibility: document.visibilityState,
        centers: map.__centers ?? 0,
        bearing: map.getBearing(),
        moving: map.isMoving(),
        rotating: map.isRotating(),
        dragRotate: map.dragRotate.isActive(),
        dragPan: map.dragPan.isActive(),
        touch: map.touchZoomRotate.isActive(),
        pitch: map.touchPitch.isActive(),
        keyboard: map.keyboard.isActive(),
        lastRotate: held(map.dragRotate._mouseRotate),
        lastPitch: held(map.dragRotate._mousePitch),
        lastRoll: held(map.dragRotate._mouseRoll),
        lastPan: held(map.dragPan._mousePan),
        lastTouchPan: held(map.dragPan._touchPan),
        pinch: map.touchZoomRotate._touchZoom?._firstTwoTouches != null || map.touchZoomRotate._touchRotate?._firstTwoTouches != null,
        pitchTouches: map.touchPitch._firstTwoTouches != null,
        label: document.getElementById('iss-now')?.textContent ?? null,
      };
    });
    throw new Error(`${String(error)} ${JSON.stringify(state)}`);
  }
  expect(await page.locator('#toggle-follow-iss').getAttribute('aria-pressed')).toBe('true');
}

for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
]) describe.skipIf(!existsSync(engine.executablePath))(`gesture hold ${engine.name}`, () => {
  let session: TrackedBrowser;
  beforeAll(async () => {
    session = await launchTracked(engine.type, { headless: true, executablePath: engine.executablePath });
  }, 60_000);
  afterAll(async () => { await closeBrowser(session, engine.name); }, 60_000);

  async function pageAt(width: number, height: number, touch: boolean): Promise<{ page: Page; context: BrowserContext }> {
    const context = await session.browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    return { page, context };
  }

  it('keeps a ctrl-left drag through a follow tick', async () => {
    for (let rep = 0; rep < REPS; rep += 1) {
      const { page, context } = await pageAt(1280, 800, false);
      try {
        await openMap(page);
        await northStill(page);
        await watchMove(page);
        const held = await drag(page, 'left', true);
        await page.waitForTimeout(1200);
        const after = await gestureState(page);
        const end = Math.abs(Number(after.bearing));
        expect(Math.abs(Number(held.bearing)), JSON.stringify(held)).toBeGreaterThan(20);
        expect(snappedToZero(after.samples as number[]), `${engine.name} ctrl ${end} ${JSON.stringify(after)}`).toBe(false);
        expect(end, JSON.stringify(after)).toBeGreaterThan(20);
      } finally {
        await context.close();
      }
    }
  }, Math.max(180_000, REPS * 90_000));

  it('keeps a shift-arrow rotate through a follow tick', async () => {
    const { page, context } = await pageAt(1280, 800, false);
    try {
      await openMap(page);
      await northStill(page);
      await watchMove(page);
      await page.locator('#map .maplibregl-canvas').focus();
      await page.keyboard.down('Shift');
      let seen = 0;
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('ArrowRight');
        if (i === 2) await page.waitForTimeout(400);
        await page.waitForFunction((floor) => Math.abs((window as unknown as { __opdMap: MapHandle }).__opdMap.getBearing()) > floor, seen);
        seen = await page.evaluate(() => Math.abs((window as unknown as { __opdMap: MapHandle }).__opdMap.getBearing()));
      }
      await page.keyboard.up('Shift');
      await page.waitForFunction(() => !(window as unknown as { __opdMap: MapHandle }).__opdMap.isMoving());
      const samples = await page.evaluate(() => (window as unknown as { __opdMap: MapHandle }).__opdMap.__samples ?? []);
      expect(snappedToZero(samples)).toBe(false);
      expect(Math.abs(samples[samples.length - 1] ?? 0)).toBeGreaterThan(5);
    } finally {
      await context.close();
    }
  }, 60_000);

  it.each([
    { width: 390, height: 844, label: 'phone' },
    { width: 1024, height: 768, label: 'ipad' },
  ])('keeps a two-finger rotate on $label', async ({ width, height }) => {
    for (let rep = 0; rep < REPS; rep += 1) {
      const { page, context } = await pageAt(width, height, true);
      try {
        await openMap(page);
        await northStill(page);
        await watchMove(page);
        const held = await touchGesture(page, engine.name, 'rotate');
        const end = Math.abs(Number(held.afterBearing));
        const trace = held.trace as { name: string; trusted: boolean }[];
        expect(trace.some((event) => event.name === 'rotatestart' && event.trusted), JSON.stringify(held)).toBe(true);
        expect(Math.abs(Number(held.bearing)), JSON.stringify(held)).toBeGreaterThan(15);
        expect(snappedToZero(held.afterSamples as number[]), `${engine.name} ${width}x${height} rotate ${end} ${JSON.stringify(held)}`).toBe(false);
        expect(end, JSON.stringify(held)).toBeGreaterThan(15);
      } finally {
        await context.close();
      }
    }
  }, Math.max(180_000, REPS * 90_000));

  it.each([
    { width: 390, height: 844, label: 'phone' },
    { width: 1024, height: 768, label: 'ipad' },
  ])('keeps a two-finger pitch on $label', async ({ width, height }) => {
    const { page, context } = await pageAt(width, height, true);
    try {
      await openMap(page);
      await northStill(page);
      await watchMove(page);
      const held = await touchGesture(page, engine.name, 'pitch');
      const pitches = held.pitches as number[];
      const end = Math.abs(Number(held.afterPitch));
      expect(snappedToZero(pitches), `${engine.name} ${width}x${height} pitch ${end} ${JSON.stringify(held)}`).toBe(false);
      expect(Math.abs(Number(held.pitch)), JSON.stringify(held)).toBeGreaterThan(10);
      expect(end, JSON.stringify(held)).toBeGreaterThan(10);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('a follow tick before the first right-drag move still rotates', async () => {
    const { page, context } = await pageAt(1280, 800, false);
    try {
      await openMap(page);
      await northStill(page);
      const { x, y } = await canvasPoint(page);
      await page.mouse.move(x, y);
      await page.mouse.down({ button: 'right' });
      await page.waitForTimeout(1200);
      await page.mouse.move(x + 40, y);
      await page.waitForFunction(() => Math.abs((window as unknown as { __opdMap: MapHandle }).__opdMap.getBearing()) > 10);
      await page.mouse.up({ button: 'right' });
    } finally {
      await context.close();
    }
  }, 40_000);

  it('a right-click on the Map tab does not block follow', async () => {
    const { page, context } = await pageAt(1280, 800, false);
    try {
      await openMap(page);
      await page.locator('#tab-map').click({ button: 'right' });
      expect(await page.locator('#toggle-follow-iss').getAttribute('aria-pressed')).toBe('true');
      await armCenters(page);
      await page.waitForFunction(() => ((window as unknown as { __opdMap: MapHandle }).__opdMap.__centers ?? 0) > 0);
      expect(await page.locator('#toggle-follow-iss').getAttribute('aria-pressed')).toBe('true');
    } finally {
      await context.close();
    }
  }, 40_000);

  it('blur mid-gesture lets follow recenter again', async () => {
    const { page, context } = await pageAt(1280, 800, false);
    try {
      await openMap(page);
      await northStill(page);
      const { x, y } = await canvasPoint(page);
      await page.mouse.move(x, y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(x + 40, y);
      await page.waitForFunction(() => Math.abs((window as unknown as { __opdMap: MapHandle }).__opdMap.getBearing()) > 10);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.mouse.up({ button: 'right' });
      await resumeFollow(page);
    } finally {
      await context.close();
    }
  }, 40_000);

  it('a hidden tab mid-gesture lets follow recenter again', async () => {
    const { page, context } = await pageAt(1280, 800, false);
    const notes: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' || text.includes('[map]')) notes.push(`${msg.type()} ${text}`);
    });
    page.on('pageerror', (error) => notes.push(`pageerror ${error.message}`));
    try {
      await openMap(page);
      await northStill(page);
      const { x, y } = await canvasPoint(page);
      await page.mouse.move(x, y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(x + 40, y);
      await page.waitForFunction(() => Math.abs((window as unknown as { __opdMap: MapHandle }).__opdMap.getBearing()) > 10);
      await page.evaluate(() => {
        const proto = Document.prototype;
        const hidden = Object.getOwnPropertyDescriptor(proto, 'hidden');
        const state = Object.getOwnPropertyDescriptor(proto, 'visibilityState');
        Object.defineProperty(proto, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(proto, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        if (hidden) Object.defineProperty(proto, 'hidden', hidden);
        if (state) Object.defineProperty(proto, 'visibilityState', state);
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.mouse.up({ button: 'right' });
      const canvases = await page.locator('#map .maplibregl-canvas').count();
      try {
        await resumeFollow(page);
      } catch (error) {
        throw new Error(`${String(error)} canvases=${canvases} notes=${JSON.stringify(notes)}`);
      }
      expect(canvases).toBe(1);
    } finally {
      await context.close();
    }
  }, 40_000);

  it('a failed map reload leaves follow moving the map already on screen', async () => {
    const { page, context } = await pageAt(1280, 800, false);
    try {
      await openMap(page);
      await page.route('**/track.json', (route) => route.fulfill({ status: 500, body: 'no' }));
      await page.locator('#tab-map').click();
      await page.waitForTimeout(300);
      expect(await page.locator('#map .maplibregl-canvas').count()).toBe(1);
      expect(await page.locator('#toggle-follow-iss').getAttribute('aria-pressed')).toBe('true');
      await armCenters(page);
      await page.waitForFunction(() => ((window as unknown as { __opdMap: MapHandle }).__opdMap.__centers ?? 0) > 0);
    } finally {
      await context.close();
    }
  }, 40_000);

  it('a pointercancel mid-gesture lets follow recenter again', async () => {
    const { page, context } = await pageAt(1280, 800, false);
    try {
      await openMap(page);
      await northStill(page);
      const { x, y } = await canvasPoint(page);
      await page.mouse.move(x, y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(x + 40, y);
      await page.waitForFunction(() => Math.abs((window as unknown as { __opdMap: MapHandle }).__opdMap.getBearing()) > 10);
      const rotating = (): Promise<boolean> => page.evaluate(() => {
        const map = (window as unknown as { __opdMap: MapHandle & { dragRotate: { isActive(): boolean } } }).__opdMap;
        return map.dragRotate.isActive();
      });
      expect(await rotating()).toBe(true);
      await page.locator('#map .maplibregl-canvas').dispatchEvent('pointercancel');
      expect(await rotating()).toBe(false);
      await page.evaluate(() => {
        const follow = document.getElementById('toggle-follow-iss');
        if (follow?.getAttribute('aria-pressed') !== 'true') follow?.click();
      });
      await page.waitForFunction(() => !(window as unknown as { __opdMap: MapHandle }).__opdMap.isMoving());
      await armCenters(page);
      await page.waitForFunction(() => ((window as unknown as { __opdMap: MapHandle }).__opdMap.__centers ?? 0) > 0);
      await page.mouse.up({ button: 'right' });
    } finally {
      await context.close();
    }
  }, 40_000);

  it('pointer capture loss mid-gesture lets follow recenter again', async () => {
    const { page, context } = await pageAt(1280, 800, false);
    try {
      await openMap(page);
      await northStill(page);
      const { x, y } = await canvasPoint(page);
      await page.mouse.move(x, y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(x + 40, y);
      await page.waitForFunction(() => Math.abs((window as unknown as { __opdMap: MapHandle }).__opdMap.getBearing()) > 10);
      await page.locator('#map .maplibregl-canvas').dispatchEvent('lostpointercapture', { buttons: 2 });
      await page.mouse.up({ button: 'right' });
      await resumeFollow(page);
    } finally {
      await context.close();
    }
  }, 40_000);

  it.each([
    { width: 402, height: 874 },
    { width: 834, height: 1210 },
  ])('a one-finger fling keeps its momentum at $width×$height', async ({ width, height }) => {
    const { page, context } = await pageAt(width, height, true);
    const client = engine.name === 'Chrome' ? await context.newCDPSession(page) : null;
    try {
      await openMap(page);
      if (await page.locator('#toggle-follow-iss').getAttribute('aria-pressed') === 'true') {
        await page.locator('#toggle-follow-iss').click();
      }
      await northStill(page);
      const center = (): Promise<{ lng: number; lat: number }> => page.evaluate(() => {
        const at = (window as unknown as { __opdMap: MapHandle }).__opdMap.getCenter();
        return { lng: at.lng, lat: at.lat };
      });
      const apart = (a: { lng: number; lat: number }, b: { lng: number; lat: number }): number => Math.max(Math.abs(a.lng - b.lng), Math.abs(a.lat - b.lat));
      const box = await page.locator('#map .maplibregl-canvas').boundingBox();
      if (!box) throw new Error('map canvas has no box');
      const y = box.y + box.height * 0.55;
      const x = box.x + Math.min(box.width * 0.28, 180);
      const travel = Math.min(220, box.width * 0.5);
      const start = await center();
      await page.evaluate(() => {
        const w = window as unknown as { __opdMap: MapHandle; __flingAt?: { lng: number; lat: number } };
        const note = (): void => {
          if (w.__flingAt) return;
          const at = w.__opdMap.getCenter();
          w.__flingAt = { lng: at.lng, lat: at.lat };
        };
        window.addEventListener('pointerup', note, true);
        window.addEventListener('touchend', note, true);
      });
      await sendRealTouch(engine.name, client, 'touchStart', [{ x, y, id: 1 }]);
      const slowStep = travel / 8;
      const flickStep = travel / 4;
      for (let step = 1; step <= 4; step += 1) {
        await sendRealTouch(engine.name, client, 'touchMove', [{ x: x + step * slowStep, y, id: 1 }]);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
      }
      const flickAt = (step: number): { x: number; y: number; id: number } => ({ x: x + 4 * slowStep + step * flickStep, y, id: 1 });
      if (engine.name === 'Chrome' && client) {
        const advance = async (budget: number): Promise<void> => {
          const expired = new Promise((resolve) => client.once('Emulation.virtualTimeBudgetExpired', resolve));
          await client.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget });
          await expired;
        };
        await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
        await sendRealTouch(engine.name, client, 'touchMove', [flickAt(1)]);
        await advance(40);
        await sendRealTouch(engine.name, client, 'touchMove', [flickAt(2)]);
        await advance(20);
        await sendRealTouch(engine.name, client, 'touchEnd', [flickAt(2)]);
        await advance(2500);
      } else {
        await Promise.all([
          sendRealTouch(engine.name, client, 'touchMove', [flickAt(1)]),
          sendRealTouch(engine.name, client, 'touchMove', [flickAt(2)]),
          sendRealTouch(engine.name, client, 'touchEnd', [flickAt(2)]),
        ]);
      }
      await page.waitForFunction(() => !(window as unknown as { __opdMap: MapHandle }).__opdMap.isMoving());
      const atLift = await page.evaluate(() => (window as unknown as { __flingAt?: { lng: number; lat: number } }).__flingAt);
      if (!atLift) throw new Error(`${engine.name} ${width}x${height} recorded no lift center`);
      const after = await center();
      expect(apart(start, atLift), `${engine.name} ${width}x${height} drag`).toBeGreaterThan(0.05);
      expect(apart(atLift, after), `${engine.name} ${width}x${height} fling`).toBeGreaterThan(0.15);
    } finally {
      await client?.detach();
      await context.close();
    }
  }, 40_000);
});
