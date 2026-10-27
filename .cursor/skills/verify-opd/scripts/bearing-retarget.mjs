import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceDescriptor } from './webkit-devices.mjs';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { chromium, webkit } = require('playwright');

export const BEARING_SURFACES = [
  { id: 'webkit-iphone-17-pro-402x874', engine: 'webkit', surface: 'iphone-17-pro', width: 402, height: 874, touch: true },
  { id: 'webkit-ipad-m4-834x1210', engine: 'webkit', surface: 'ipad-pro-11', width: 834, height: 1210, touch: true },
  { id: 'webkit-ipad-m4-1210x834', engine: 'webkit', surface: 'ipad-pro-11', width: 1210, height: 834, touch: true },
  { id: 'chrome-402x874', engine: 'chrome', surface: 'chrome', width: 402, height: 874, touch: false },
];

const HELP = 'drive map-bearing is one surface per process: OPD_VERIFY_SURFACE=iphone-17-pro OPD_VERIFY_VIEWPORT=402x874, OPD_VERIFY_SURFACE=ipad-pro-11 OPD_VERIFY_VIEWPORT=834x1210, OPD_VERIFY_SURFACE=ipad-pro-11 OPD_VERIFY_VIEWPORT=1210x834, or OPD_VERIFY_SURFACE=chrome OPD_VERIFY_VIEWPORT=402x874.';

export const BEARING_POLY_START_MS = Date.parse('2026-10-18T12:00:00.000Z');
export const BEARING_VIEW_MS = BEARING_POLY_START_MS + 60_000;

export function bearingPolynomial() {
  return {
    start: new Date(BEARING_POLY_START_MS).toISOString(),
    duration_seconds: 7200,
    lat_coeffs: [10],
    lon_coeffs: [0.05, 20],
    polynomial_order: 1,
  };
}

function evalPoly(coeffs, t) {
  let acc = 0;
  for (const c of coeffs) acc = acc * t + c;
  return acc;
}

export function bearingSamples(nowMs = BEARING_VIEW_MS) {
  const poly = bearingPolynomial();
  const at = (ms) => {
    const t = (ms - BEARING_POLY_START_MS) / 1000;
    if (t < 0 || t > poly.duration_seconds) return null;
    return { lat: evalPoly(poly.lat_coeffs, t), lon: evalPoly(poly.lon_coeffs, t) };
  };
  return { here: at(nowMs), ahead: at(nowMs + 30_000) };
}

export function bearingPlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = BEARING_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return plan;
}

function chromePath() {
  return [process.env.OPD_VERIFY_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((entry) => entry && existsSync(entry));
}

function contextOptions(plan) {
  if (plan.engine === 'chrome') {
    return { viewport: { width: plan.width, height: plan.height }, serviceWorkers: 'block', reducedMotion: 'no-preference' };
  }
  const spec = plan.surface === 'iphone-17-pro'
    ? { name: 'iPhone 17 Pro', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: 3 }
    : { name: 'iPad Pro 11', viewport: { width: plan.width, height: plan.height } };
  const device = deviceDescriptor(spec);
  return {
    ...device,
    viewport: { width: plan.width, height: plan.height },
    serviceWorkers: 'block',
    reducedMotion: 'no-preference',
  };
}

const SHOW_CHROME = `(() => {
  try {
    localStorage.setItem('opd-map-chrome', 'shown');
    localStorage.removeItem('opd-map-bearing-mode');
  } catch {}
})();`;

const BURST_BEFORE_PAINT = `(() => {
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const out = orig.call(this, type, listener, options);
    if (window.__opdBearingBurst !== 'fired' && type === 'click' && this && this.id === 'bearing-iss') {
      window.__opdBearingBurst = 'fired';
      document.getElementById('bearing-north').click();
      document.getElementById('bearing-iss').click();
      document.getElementById('bearing-north').click();
    }
    return out;
  };
})();`;

async function sample(page) {
  return page.evaluate(() => {
    const map = window.__opdMap;
    const north = document.getElementById('bearing-north');
    const iss = document.getElementById('bearing-iss');
    if (!map || typeof map.getBearing !== 'function' || !north || !iss) return null;
    const bearing = map.getBearing();
    return {
      bearing,
      text: Number(bearing).toFixed(2),
      moving: typeof map.isMoving === 'function' ? map.isMoving() : false,
      north: north.classList.contains('active'),
      iss: iss.classList.contains('active'),
    };
  });
}

function northSettled(state) {
  return !!state && state.north && !state.moving && state.text === '0.00';
}

async function settleNorth(page, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 6000) {
    last = await sample(page);
    if (northSettled(last)) return last;
    await page.waitForTimeout(40);
  }
  throw new Error(`${label} did not settle on North 0.00 ${JSON.stringify(last)}`);
}

async function trustedNorth(page, touch) {
  const box = await page.locator('#bearing-north').boundingBox();
  if (!box || box.width < 20 || box.height < 20) throw new Error(`north button box ${JSON.stringify(box)}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function assertCreatedSize(page, plan) {
  const size = await page.evaluate(({ width, height }) => {
    const root = document.documentElement;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && (root.clientWidth !== width || root.clientHeight !== height)) {
      meta.setAttribute('content', `width=${width}, height=${height}, initial-scale=1, viewport-fit=cover`);
    }
    return { w: window.innerWidth, h: window.innerHeight, cw: root.clientWidth, ch: root.clientHeight };
  }, plan);
  if (size.w !== plan.width || size.h !== plan.height) {
    throw new Error(`created-at-size ${plan.width}x${plan.height} opened ${size.w}x${size.h}`);
  }
  return size;
}

async function openSized(page, baseUrl, plan) {
  await page.goto(`${baseUrl}/?e2e`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const size = await assertCreatedSize(page, plan);
  console.log(`viewport map-bearing surface ${plan.id} opened ${plan.width}x${plan.height} now ${size.w}x${size.h} created-at-size`);
}

function installFrozenDate(fixed) {
  const NativeDate = Date;
  function FrozenDate(...args) {
    if (new.target === undefined) return new NativeDate(fixed).toString();
    if (args.length === 0) return Reflect.construct(NativeDate, [fixed], new.target);
    return Reflect.construct(NativeDate, args, new.target);
  }
  Object.setPrototypeOf(FrozenDate, NativeDate);
  FrozenDate.prototype = NativeDate.prototype;
  FrozenDate.now = () => fixed;
  globalThis.Date = FrozenDate;
  const nativeNow = performance.now.bind(performance);
  let origin = nativeNow();
  let virtual = origin;
  let frameAdvanced = false;
  performance.now = () => {
    if (!frameAdvanced) {
      frameAdvanced = true;
      const now = nativeNow();
      virtual += Math.min(32, Math.max(0, now - origin));
      origin = now;
      requestAnimationFrame(() => { frameAdvanced = false; });
    }
    return virtual;
  };
}

function prepareBearingTrack(baseUrl) {
  let pending = null;
  return () => {
    if (!pending) {
      pending = (async () => {
        const manifestResponse = await fetch(`${baseUrl}/manifest.json`);
        if (!manifestResponse.ok) throw new Error(`bearing manifest fetch ${manifestResponse.status}`);
        const manifest = await manifestResponse.json();
        const response = await fetch(new URL(manifest.artifacts.track.path, `${baseUrl}/`));
        if (!response.ok) throw new Error(`bearing track fetch ${response.status}`);
        const track = await response.json();
        track.iss_polynomial = bearingPolynomial();
        const body = JSON.stringify(track);
        const sha256 = createHash('sha256').update(body).digest('hex');
        return { body, path: `v/verify/${sha256}/track.json`, sha256, bytes: Buffer.byteLength(body) };
      })();
    }
    return pending;
  };
}

export async function installBearingTrack(page, baseUrl) {
  const prepared = prepareBearingTrack(baseUrl);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path !== '/manifest.json' && !/^\/v\/verify\/[a-f0-9]{64}\/track\.json$/.test(path)) {
      await route.continue();
      return;
    }
    const track = await prepared();
    if (path === `/${track.path}`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: track.body,
      });
      return;
    }
    if (path !== '/manifest.json') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const manifest = await response.json();
    if (manifest?.artifacts?.track) {
      manifest.artifacts.track.path = track.path;
      manifest.artifacts.track.sha256 = track.sha256;
      manifest.artifacts.track.bytes = track.bytes;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(manifest),
    });
  });
}

async function proveStartupTap(page, plan, baseUrl) {
  let tapped = null;
  let tapError = null;
  await page.exposeBinding('__opdEaseStarted', async (_source, payload) => {
    if (tapped || tapError) return;
    const info = JSON.parse(payload);
    const midEase = info.moving && info.width >= 20 && info.commanded > 1 && Math.abs(info.bearing - info.commanded) > 1;
    if (!midEase) return;
    try {
      if (plan.touch) await page.touchscreen.tap(info.x, info.y);
      else await page.mouse.click(info.x, info.y);
      tapped = info;
    } catch (error) {
      tapError = error;
    }
  });
  await page.addInitScript(() => {
    window.__opdWatchStartup = true;
    const signal = (map) => {
      if (!window.__opdWatchStartup) return;
      const north = document.getElementById('bearing-north');
      if (!north) return;
      const rect = north.getBoundingClientRect();
      const bearing = map.getBearing();
      const commanded = window.__opdIssEase;
      if (!(commanded > 1) || !map.isMoving() || rect.width < 20) return;
      if (Math.abs(bearing - commanded) <= 1) return;
      window.__opdWatchStartup = false;
      window.__opdEaseStarted(JSON.stringify({
        bearing,
        commanded,
        moving: true,
        width: rect.width,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      }));
    };
    const watch = () => {
      if (!window.__opdWatchStartup) return;
      const map = window.__opdMap;
      if (!map || typeof map.easeTo !== 'function' || typeof map.getBearing !== 'function' || typeof map.isMoving !== 'function') {
        requestAnimationFrame(watch);
        return;
      }
      if (!map.__opdHooked) {
        map.__opdHooked = true;
        const ease = map.easeTo.bind(map);
        map.easeTo = (opts) => {
          const result = ease(opts);
          if (opts && opts.duration >= 600 && opts.bearing > 1 && map.isMoving() && Math.abs(map.getBearing()) < 1) {
            window.__opdIssEase = opts.bearing;
          }
          signal(map);
          return result;
        };
      }
      signal(map);
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await openSized(page, baseUrl, plan);
  const started = Date.now();
  while (!tapped && !tapError && Date.now() - started < 20000) {
    await page.waitForTimeout(40);
  }
  if (tapError) throw tapError;
  if (!tapped) {
    const last = await sample(page);
    const watch = await page.evaluate(() => ({
      commanded: window.__opdIssEase || 0,
      flag: window.__opdWatchStartup,
      binding: typeof window.__opdEaseStarted,
    }));
    throw new Error(`${plan.id} startup ease was not in flight ${JSON.stringify({ last, watch })}`);
  }
  const settled = await settleNorth(page, `${plan.id} startup North`);
  console.log(`bearing retarget ${plan.id} startup-north ${settled.text} from ${tapped.bearing.toFixed(2)}`);
  return settled;
}

async function proveBurst(page, plan, baseUrl) {
  await page.addInitScript(() => { window.__opdWatchStartup = false; });
  await page.addInitScript(BURST_BEFORE_PAINT);
  await openSized(page, baseUrl, plan);
  await page.waitForFunction(() => window.__opdBearingBurst === 'fired' && window.__opdMap && typeof window.__opdMap.getBearing === 'function', null, { timeout: 60000 });
  const settled = await settleNorth(page, `${plan.id} burst`);
  console.log(`bearing retarget ${plan.id} burst-north ${settled.text}`);
  return settled;
}

async function openCanvasPoint(page) {
  const point = await page.evaluate(() => {
    const canvas = document.querySelector('#map canvas.maplibregl-canvas');
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    for (let y = box.top + 36; y < box.bottom - 36; y += 24) {
      for (let x = box.left + 36; x < box.right - 200; x += 28) {
        if (document.elementFromPoint(x, y) === canvas) {
          return { x, y, endX: Math.min(box.right - 20, x + 160), endY: Math.min(box.bottom - 20, y + 12) };
        }
      }
    }
    return null;
  });
  if (!point) throw new Error('no open #map canvas point for drag-rotate');
  return point;
}

async function dragRotate(page) {
  const point = await openCanvasPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(point.endX, point.endY, { steps: 16 });
  const mid = await sample(page);
  return { mid, ...point };
}

async function releaseDrag(page) {
  await page.mouse.up({ button: 'right' }).catch(() => {});
  await page.mouse.up().catch(() => {});
  await page.keyboard.up('Control').catch(() => {});
}

async function rotateOffNorth(page) {
  let drag = await dragRotate(page);
  if (drag.mid && Math.abs(drag.mid.bearing) >= 5) return { ...drag, button: 'right' };
  await releaseDrag(page);
  await page.keyboard.down('Control');
  const point = await openCanvasPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.endX, point.endY, { steps: 16 });
  return { mid: await sample(page), button: 'left', ...point };
}

async function proveDrag(page, plan) {
  const dragged = await rotateOffNorth(page);
  if (!dragged.mid || Math.abs(dragged.mid.bearing) < 5) {
    throw new Error(`${plan.id} drag-rotate did not leave north ${JSON.stringify(dragged)}`);
  }
  await releaseDrag(page);
  await page.waitForTimeout(800);
  const held = await sample(page);
  if (!held || held.text === '0.00') throw new Error(`${plan.id} drag-rotate snapped to north ${JSON.stringify(held)}`);
  console.log(`bearing retarget ${plan.id} drag-held ${held.text}`);
  const again = await rotateOffNorth(page);
  if (!again.mid || Math.abs(again.mid.bearing) < 5) {
    throw new Error(`${plan.id} second drag-rotate did not leave north ${JSON.stringify(again.mid)}`);
  }
  await page.evaluate(() => document.getElementById('bearing-north').click());
  const frame = await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      const map = window.__opdMap;
      resolve({
        bearing: map.getBearing(),
        text: map.getBearing().toFixed(2),
        moving: map.isMoving(),
      });
    });
  }));
  await releaseDrag(page);
  if (frame.text === '0.00') throw new Error(`${plan.id} North mid-drag jumped to 0.00 in one frame from ${again.mid.text}`);
  console.log(`bearing retarget ${plan.id} mid-drag-frame ${frame.text}`);
  return held;
}

export async function driveMapBearing({ baseUrl, evidenceDir }) {
  const plan = bearingPlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
  mkdirSync(evidenceDir, { recursive: true });
  const browser = plan.engine === 'chrome'
    ? await chromium.launch({ headless: true, executablePath: chromePath() })
    : await webkit.launch();
  try {
    const context = await browser.newContext(contextOptions(plan));
    if (plan.surface === 'iphone-17-pro') {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      });
    }
    await context.addInitScript(SHOW_CHROME);
    await context.addInitScript(installFrozenDate, BEARING_VIEW_MS);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await installBearingTrack(page, baseUrl);
    try {
      await proveStartupTap(page, plan, baseUrl);
      await page.screenshot({ path: resolve(evidenceDir, `bearing-${plan.id}-startup.png`) });
      await proveBurst(page, plan, baseUrl);
      await page.screenshot({ path: resolve(evidenceDir, `bearing-${plan.id}-burst.png`) });
      await proveDrag(page, plan);
      await page.screenshot({ path: resolve(evidenceDir, `bearing-${plan.id}-drag.png`) });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return `bearing retarget ${plan.id} North 0.00`;
}
