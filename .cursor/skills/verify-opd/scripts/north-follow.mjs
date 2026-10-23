import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceDescriptor } from './webkit-devices.mjs';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { chromium, webkit } = require('playwright');

export const NORTH_SURFACES = [
  { id: 'chrome-desktop-1440x900', engine: 'chrome', surface: 'desktop', width: 1440, height: 900, touch: false },
  { id: 'chrome-desktop-1280x800', engine: 'chrome', surface: 'desktop', width: 1280, height: 800, touch: false },
  { id: 'webkit-iphone-17-pro-402x874', engine: 'webkit', surface: 'iphone-17-pro', width: 402, height: 874, touch: true },
  { id: 'webkit-iphone-17-pro-874x402', engine: 'webkit', surface: 'iphone-17-pro', width: 874, height: 402, touch: true },
  { id: 'webkit-ipad-m4-834x1210', engine: 'webkit', surface: 'ipad-pro-11', width: 834, height: 1210, touch: true },
  { id: 'webkit-ipad-m4-1210x834', engine: 'webkit', surface: 'ipad-pro-11', width: 1210, height: 834, touch: true },
];

const HELP = 'drive map-north is one surface per process: OPD_VERIFY_SURFACE=desktop OPD_VERIFY_VIEWPORT=1440x900 or 1280x800, OPD_VERIFY_SURFACE=iphone-17-pro OPD_VERIFY_VIEWPORT=402x874 or 874x402, or OPD_VERIFY_SURFACE=ipad-pro-11 OPD_VERIFY_VIEWPORT=834x1210 or 1210x834. The Playwright context is created at that size. WebKit is iPhone and iPad.';

const webKitTouchSessions = [];
let webKitTouchHooked = false;

export function northPlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = NORTH_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
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

function hookWebKitTouch() {
  if (webKitTouchHooked) return;
  webKitTouchHooked = true;
  const wkPagePath = resolve(dirname(require.resolve('playwright-core')), 'lib/server/webkit/wkPage.js');
  const wkPageApi = require(wkPagePath);
  Object.defineProperty(wkPageApi.WKPage.prototype, '_pageProxySession', {
    configurable: true,
    set(value) {
      Object.defineProperty(this, '_pageProxySession', { value, writable: true, configurable: true });
      webKitTouchSessions.push(value);
    },
    get() {
      return undefined;
    },
  });
}

const SHOW_CHROME = `(() => {
  try {
    localStorage.setItem('opd-map-chrome', 'shown');
    localStorage.removeItem('opd-map-bearing-mode');
  } catch {}
})();`;

async function assertCreatedSize(page, plan) {
  const size = await page.evaluate(({ width, height }) => {
    const root = document.documentElement;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && (root.clientWidth !== width || root.clientHeight !== height)) {
      meta.setAttribute('content', `width=${width}, height=${height}, initial-scale=1, viewport-fit=cover`);
    }
    return { w: window.innerWidth, h: window.innerHeight };
  }, plan);
  if (size.w !== plan.width || size.h !== plan.height) {
    throw new Error(`created-at-size ${plan.width}x${plan.height} opened ${size.w}x${size.h}`);
  }
  return size;
}

async function readMap(page) {
  return page.evaluate(() => {
    const map = window.__opdMap;
    const follow = document.getElementById('toggle-follow-iss');
    const north = document.getElementById('bearing-north');
    const iss = document.getElementById('bearing-iss');
    if (!map || typeof map.getBearing !== 'function' || !follow || !north) return null;
    const bearing = map.getBearing();
    return {
      bearing,
      text: Number(bearing).toFixed(2),
      abs: Math.abs(bearing),
      moving: typeof map.isMoving === 'function' ? map.isMoving() : false,
      dragRotate: typeof map.dragRotate?.isActive === 'function' ? map.dragRotate.isActive() : null,
      follow: follow.getAttribute('aria-pressed'),
      north: north.classList.contains('active'),
      iss: iss ? iss.classList.contains('active') : false,
      mode: localStorage.getItem('opd-map-bearing-mode'),
    };
  });
}

function fastestDegPerMs(samples) {
  let rate = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const dt = Math.max(1, samples[i].at - samples[i - 1].at);
    rate = Math.max(rate, Math.abs(samples[i].bearing - samples[i - 1].bearing) / dt);
  }
  return rate;
}

function snappedNorth(samples) {
  let left = false;
  for (const sample of samples) {
    const bearing = typeof sample === 'number' ? sample : sample.bearing;
    if (Math.abs(bearing) > 15) left = true;
    if (left && Math.abs(bearing) < 1) return true;
  }
  return false;
}

async function press(page, selector, touch) {
  const box = await page.locator(selector).boundingBox();
  if (!box || box.width < 20 || box.height < 20) throw new Error(`${selector} box ${JSON.stringify(box)}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function openCanvasPoint(page) {
  const point = await page.evaluate(() => {
    const canvas = document.querySelector('#map canvas.maplibregl-canvas');
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    for (const travel of [120, 80]) {
      for (let y = box.top + 36; y < box.bottom - 36; y += 24) {
        for (let x = box.left + 36; x < box.right - travel - 20; x += 28) {
          if (document.elementFromPoint(x, y) !== canvas) continue;
          if (document.elementFromPoint(x + travel, y) !== canvas) continue;
          return { x, y, endX: x + travel, endY: y };
        }
      }
    }
    return null;
  });
  if (!point) throw new Error('no open #map canvas point for drag-rotate');
  return point;
}

async function waitStill(page, label, ready, timeoutMs = 20000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readMap(page);
    if (last && ready(last)) return last;
    await page.waitForTimeout(40);
  }
  throw new Error(`${label} ${JSON.stringify(last)}`);
}

async function openMap(page, baseUrl, plan) {
  await page.goto(`${baseUrl}/?e2e`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const size = await assertCreatedSize(page, plan);
  console.log(`viewport map-north surface ${plan.id} opened ${plan.width}x${plan.height} now ${size.w}x${size.h} created-at-size`);
  await page.waitForFunction(() => {
    const map = window.__opdMap;
    return !!map?.isStyleLoaded?.() && !!map.getSource?.('iss-track')
      && document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed') === 'true'
      && document.getElementById('bearing-north');
  }, null, { timeout: 60000 });
  await waitStill(page, `${plan.id} map idle`, (state) => !state.moving, 20000);
}

async function proveEase(page, plan) {
  await page.exposeBinding('__opdNorthNow', async () => {
    await press(page, '#bearing-north', plan.touch);
  });
  await page.evaluate(() => {
    const map = window.__opdMap;
    const orig = map.setCenter.bind(map);
    let armed = false;
    map.setCenter = (center) => {
      const result = orig(center);
      if (!armed) {
        armed = true;
        window.setTimeout(() => {
          map.jumpTo({ bearing: 80 });
          map.__samples = [];
          map.on('move', () => {
            map.__samples.push({ bearing: map.getBearing(), at: performance.now() });
          });
          map.__northClicked = performance.now();
          window.__opdNorthNow();
        }, 500);
      }
      return result;
    };
  });
  const settled = await waitStill(page, `${plan.id} north ease`, (state) => {
    return state.follow === 'true' && state.north && !state.moving && state.abs < 0.01;
  }, 20000);
  const samples = await page.evaluate(() => window.__opdMap.__samples || []);
  const rate = fastestDegPerMs(samples);
  const left = samples.some((sample) => Math.abs(sample.bearing) > 20);
  if (!left || rate >= 0.5) {
    throw new Error(`${plan.id} north ease snapped rate ${rate.toFixed(3)} n ${samples.length} left ${left}`);
  }
  console.log(`north follow ${plan.id} ease ${settled.text} follow true rate ${rate.toFixed(3)} n ${samples.length}`);
  return settled;
}

async function dragOnce(page) {
  const point = await openCanvasPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(point.endX, point.endY, { steps: 16 });
  const mid = await readMap(page);
  await page.mouse.up({ button: 'right' });
  await page.mouse.up();
  if (mid && mid.abs >= 5) return mid;
  await page.keyboard.down('Control');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.endX, point.endY, { steps: 16 });
  const again = await readMap(page);
  await page.mouse.up();
  await page.keyboard.up('Control');
  return again;
}

async function dragOffNorth(page) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await dragOnce(page);
    if (last && last.abs >= 5) return last;
  }
  return last;
}

async function proveDrag(page, plan) {
  await page.evaluate(() => {
    const map = window.__opdMap;
    map.__samples = [];
    map.on('move', () => { map.__samples.push(map.getBearing()); });
  });
  const mid = await dragOffNorth(page, plan);
  if (!mid || mid.abs < 5) throw new Error(`${plan.id} drag stayed at ${mid ? mid.text : 'null'}`);
  const held = await waitStill(page, `${plan.id} drag settle`, (state) => !state.moving, 10000);
  const samples = await page.evaluate(() => window.__opdMap.__samples || []);
  if (held.follow !== 'false' || held.abs <= 5 || snappedNorth(samples)) {
    throw new Error(`${plan.id} drag snapped ${JSON.stringify(held)}`);
  }
  console.log(`north follow ${plan.id} drag-held ${held.text} follow false`);
  return held;
}

async function proveKeys(page, plan) {
  if (plan.touch) {
    console.log(`north follow ${plan.id} keys skipped touch`);
    return;
  }
  if ((await readMap(page)).follow !== 'true') await press(page, '#toggle-follow-iss', false);
  await press(page, '#bearing-north', false);
  await waitStill(page, `${plan.id} keys north`, (state) => state.follow === 'true' && !state.moving && state.abs < 0.01, 15000);
  await page.evaluate(() => {
    const map = window.__opdMap;
    map.__samples = [];
    map.on('move', () => { map.__samples.push(map.getBearing()); });
  });
  await page.locator('#map .maplibregl-canvas').focus();
  await page.keyboard.down('Shift');
  let seen = 0;
  for (let i = 0; i < 8 && seen < 8; i += 1) {
    await page.keyboard.press('ArrowRight');
    seen = Math.abs((await readMap(page))?.bearing || 0);
  }
  await page.keyboard.up('Shift');
  const held = await waitStill(page, `${plan.id} keys settle`, (state) => !state.moving, 10000);
  const samples = await page.evaluate(() => window.__opdMap.__samples || []);
  if (held.follow !== 'false' || held.abs <= 5 || snappedNorth(samples)) {
    throw new Error(`${plan.id} keys snapped ${JSON.stringify(held)}`);
  }
  console.log(`north follow ${plan.id} keys-held ${held.text} follow false`);
}

async function proveSnap(page, plan) {
  if (plan.height < 500) {
    console.log(`north follow ${plan.id} snap skipped short`);
    return;
  }
  const state = await readMap(page);
  if (state.follow !== 'false') await press(page, '#toggle-follow-iss', plan.touch);
  await waitStill(page, `${plan.id} follow off`, (row) => row.follow === 'false', 8000);
  await press(page, '#bearing-north', plan.touch);
  await waitStill(page, `${plan.id} snap north`, (row) => !row.moving && row.abs < 0.01, 15000);
  const point = await openCanvasPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button: 'right' });
  let offset = 0;
  let bearing = 0;
  const readBearing = async () => Math.abs((await readMap(page))?.bearing || 0);
  while (bearing < 3 && offset < 40) {
    offset += 0.25;
    await page.mouse.move(Math.min(point.x + offset, point.endX), point.y);
    bearing = await readBearing();
  }
  while (bearing >= 6 && offset > 0) {
    offset -= 0.25;
    await page.mouse.move(Math.min(point.x + offset, point.endX), point.y);
    bearing = await readBearing();
  }
  if (!(bearing > 2 && bearing < 7)) {
    await page.mouse.up({ button: 'right' });
    throw new Error(`${plan.id} near-north held ${bearing.toFixed(2)}`);
  }
  await page.mouse.up({ button: 'right' });
  const end = await waitStill(page, `${plan.id} snap release`, (row) => !row.moving, 8000);
  if (end.abs <= 1) throw new Error(`${plan.id} near-north snapped to ${end.text}`);
  console.log(`north follow ${plan.id} snap-held ${end.text}`);
}

async function proveAfterRotate(page, plan) {
  const mid = await dragOffNorth(page, plan);
  if (!mid || mid.abs < 5) throw new Error(`${plan.id} post-rotate drag stayed at ${mid ? mid.text : 'null'}`);
  await waitStill(page, `${plan.id} post-rotate settle`, (row) => !row.moving && row.abs > 5, 10000);
  await page.waitForTimeout(50);
  await press(page, '#bearing-north', plan.touch);
  const settled = await waitStill(page, `${plan.id} north after rotate`, (row) => row.north && !row.moving && row.abs < 0.01, 15000);
  console.log(`north follow ${plan.id} after-rotate ${settled.text}`);
}

async function sendTouch(engine, client, type, points) {
  const touchPoints = points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y), id: point.id }));
  if (engine === 'chrome') {
    if (!client) throw new Error('Chrome touch session was not opened');
    await client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : touchPoints });
    return;
  }
  const session = webKitTouchSessions.at(-1);
  if (!session) throw new Error('WebKit touch session was not captured');
  await session.send('Input.dispatchTouchEvent', { type, touchPoints });
}

function apart(a, b) {
  return Math.max(Math.abs(a.lng - b.lng), Math.abs(a.lat - b.lat));
}

async function centerOf(page) {
  return page.evaluate(() => {
    const at = window.__opdMap.getCenter();
    return { lng: at.lng, lat: at.lat };
  });
}

async function proveFling(page, plan) {
  if (!plan.touch) {
    console.log(`north follow ${plan.id} fling skipped desktop`);
    return;
  }
  const state = await readMap(page);
  if (state.follow !== 'false') await press(page, '#toggle-follow-iss', true);
  await press(page, '#bearing-north', true);
  await waitStill(page, `${plan.id} fling north`, (row) => row.follow === 'false' && !row.moving && row.abs < 0.01, 15000);
  const box = await page.locator('#map .maplibregl-canvas').boundingBox();
  if (!box) throw new Error(`${plan.id} fling canvas has no box`);
  const y = box.y + box.height * 0.55;
  const x = box.x + Math.min(box.width * 0.28, 180);
  const travel = Math.min(220, box.width * 0.5);
  const start = await centerOf(page);
  await page.evaluate(() => {
    const note = () => {
      if (window.__flingAt) return;
      const at = window.__opdMap.getCenter();
      window.__flingAt = { lng: at.lng, lat: at.lat };
    };
    window.addEventListener('pointerup', note, true);
    window.addEventListener('touchend', note, true);
  });
  const client = plan.engine === 'chrome' ? await page.context().newCDPSession(page) : null;
  const slowStep = travel / 8;
  const flickStep = travel / 4;
  try {
    await sendTouch(plan.engine, client, 'touchStart', [{ x, y, id: 1 }]);
    for (let step = 1; step <= 4; step += 1) {
      await sendTouch(plan.engine, client, 'touchMove', [{ x: x + step * slowStep, y, id: 1 }]);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    }
    const flickAt = (step) => ({ x: x + 4 * slowStep + step * flickStep, y, id: 1 });
    await Promise.all([
      sendTouch(plan.engine, client, 'touchMove', [flickAt(1)]),
      sendTouch(plan.engine, client, 'touchMove', [flickAt(2)]),
      sendTouch(plan.engine, client, 'touchEnd', [flickAt(2)]),
    ]);
    await waitStill(page, `${plan.id} fling coast`, (row) => !row.moving, 8000);
    const atLift = await page.evaluate(() => window.__flingAt || null);
    if (!atLift) throw new Error(`${plan.id} fling recorded no lift center`);
    const after = await centerOf(page);
    const dragged = apart(start, atLift);
    const coast = apart(atLift, after);
    if (dragged <= 0.05 || coast <= 0.15) {
      throw new Error(`${plan.id} fling drag ${dragged.toFixed(3)} coast ${coast.toFixed(3)}`);
    }
    console.log(`north follow ${plan.id} fling drag ${dragged.toFixed(3)} coast ${coast.toFixed(3)}`);
  } finally {
    await client?.detach();
  }
}

export async function driveMapNorth({ baseUrl, evidenceDir }) {
  const plan = northPlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
  mkdirSync(evidenceDir, { recursive: true });
  if (plan.engine === 'webkit') hookWebKitTouch();
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
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    try {
      await openMap(page, baseUrl, plan);
      await proveEase(page, plan);
      await page.screenshot({ path: resolve(evidenceDir, `north-${plan.id}-ease.png`) });
      await proveDrag(page, plan);
      await page.screenshot({ path: resolve(evidenceDir, `north-${plan.id}-drag.png`) });
      await proveKeys(page, plan);
      await proveSnap(page, plan);
      await page.screenshot({ path: resolve(evidenceDir, `north-${plan.id}-snap.png`) });
      await proveAfterRotate(page, plan);
      await proveFling(page, plan);
      if (plan.touch) await page.screenshot({ path: resolve(evidenceDir, `north-${plan.id}-fling.png`) });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return `north follow ${plan.id}`;
}
