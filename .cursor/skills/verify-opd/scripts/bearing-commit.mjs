import { createDeviceContext } from './fixture-session.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

export const BEARING_COMMIT_SURFACES = [
  { id: 'webkit-iphone-17-pro-402x874', surface: 'iphone-17-pro', width: 402, height: 874, scale: 3, standalone: true },
  { id: 'webkit-ipad-m4-834x1210', surface: 'ipad-pro-11', width: 834, height: 1210, scale: 2, standalone: false },
];

const HELP = 'drive map-bearing-commit is one process per surface. Set OPD_VERIFY_SURFACE and OPD_VERIFY_VIEWPORT to iphone-17-pro 402x874 or ipad-pro-11 834x1210. drive map and drive all leave this probe out.';

const NORTH_DEG = 0.5;
const HELD_DEG = 5;

const SHOW_CHROME = `(() => {
  try {
    localStorage.setItem('opd-map-chrome', 'shown');
    localStorage.removeItem('opd-map-bearing-mode');
  } catch {}
})();`;

export function bearingCommitPlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = BEARING_COMMIT_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return plan;
}

function nearNorth(bearing) {
  return Math.abs(Number(bearing)) < NORTH_DEG;
}

function heldOffNorth(bearing) {
  return Math.abs(Number(bearing)) >= HELD_DEG;
}

export function bearingCommitFailures(sample) {
  const failures = [];
  if (!sample?.plain || !sample?.zoom || !sample?.rotate) {
    failures.push('bearing commit sample missing');
    return failures;
  }
  for (const name of ['plain', 'zoom', 'rotate']) {
    if (!sample[name].armed) failures.push(`${name} ease was not in flight`);
  }
  const plainWrites = sample.plain.writes || [];
  if (!plainWrites.some(nearNorth) || !nearNorth(sample.plain.bearing)) {
    failures.push(`plain commit ${sample.plain.bearing} writes ${plainWrites.join(',')}`);
  }
  for (const name of ['zoom', 'rotate']) {
    const row = sample[name];
    const writes = row.writes || [];
    if (!row.started) failures.push(`${name} start did not land`);
    if (writes.some(nearNorth) || nearNorth(row.bearing) || !heldOffNorth(row.bearing)) {
      failures.push(`${name} stale bearing ${row.bearing} writes ${writes.join(',')}`);
    }
  }
  return failures;
}

function contextOptions(plan) {
  const spec = plan.surface === 'iphone-17-pro'
    ? { name: 'iPhone 17 Pro', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale }
    : { name: 'iPad Pro 11', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale };
  return {
    ...deviceDescriptor(spec),
    viewport: { width: plan.width, height: plan.height },
    serviceWorkers: 'block',
    reducedMotion: 'no-preference',
  };
}

async function openSized(page, baseUrl, plan) {
  await page.goto(`${baseUrl}/?e2e`, { waitUntil: 'domcontentloaded', timeout: 60000 });
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

async function waitBound(page) {
  await page.waitForFunction(() => {
    const map = window.__opdMap;
    const follow = document.getElementById('toggle-follow-iss');
    const north = document.getElementById('bearing-north');
    return map && typeof map.getBearing === 'function' && typeof map.fire === 'function'
      && !map.isMoving() && follow && follow.getAttribute('aria-pressed') !== null && north;
  }, null, { timeout: 60000 });
}

async function readCommit(page, kind) {
  return page.evaluate(async (gesture) => {
    const map = window.__opdMap;
    const follow = document.getElementById('toggle-follow-iss');
    if (follow && follow.getAttribute('aria-pressed') === 'true') follow.click();
    const writes = [];
    const events = [];
    const orig = map.setBearing.bind(map);
    map.setBearing = (bearing) => {
      writes.push(bearing);
      return orig(bearing);
    };
    for (const type of ['zoomstart', 'rotatestart']) {
      map.on(type, (event) => {
        events.push({ type, user: !!(event && event.originalEvent) });
      });
    }
    orig(40);
    writes.length = 0;
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
      }
      return virtual;
    };
    window.requestAnimationFrame = () => 0;
    document.getElementById('bearing-north').click();
    const bearing = map.getBearing();
    const armed = map.isMoving() === true && Math.abs(bearing) >= 5;
    if (gesture === 'zoom') map.fire('zoomstart', { originalEvent: new WheelEvent('wheel', { bubbles: true }) });
    if (gesture === 'rotate') map.fire('rotatestart', { originalEvent: new MouseEvent('mousedown', { bubbles: true, button: 2 }) });
    const started = gesture === 'plain' || events.some((event) => event.user && event.type === (gesture === 'zoom' ? 'zoomstart' : 'rotatestart'));
    await new Promise((resolve) => setTimeout(resolve, 900));
    return { armed, started, bearing: map.getBearing(), writes: writes.slice() };
  }, kind);
}

function formatBearing(bearing) {
  const value = Number(bearing);
  if (!Number.isFinite(value)) return 'missing';
  return value.toFixed(2);
}

export async function driveMapBearingCommit({ baseUrl, evidenceDir, fixtureToken, startOffset = 0 }) {
  const plan = bearingCommitPlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
  mkdirSync(evidenceDir, { recursive: true });
  const browser = await launchWebkit();
  const sample = {};
  try {
    const context = await createDeviceContext(browser, contextOptions(plan), { baseUrl, token: fixtureToken, startOffset });
    if (plan.standalone) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      });
    }
    await context.addInitScript(SHOW_CHROME);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    try {
      let logged = false;
      for (const kind of ['plain', 'zoom', 'rotate']) {
        const size = await openSized(page, baseUrl, plan);
        if (!logged) {
          console.log(`viewport map-bearing-commit surface ${plan.id} opened ${plan.width}x${plan.height} now ${size.w}x${size.h} created-at-size`);
          logged = true;
        }
        await waitBound(page);
        sample[kind] = await readCommit(page, kind);
        await page.screenshot({ path: resolve(evidenceDir, `bearing-commit-${plan.id}-${kind}.png`) });
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const failures = bearingCommitFailures(sample);
  const line = `bearing commit ${plan.id} plain ${formatBearing(sample.plain?.bearing)} zoom ${formatBearing(sample.zoom?.bearing)} rotate ${formatBearing(sample.rotate?.bearing)}`;
  writeFileSync(resolve(evidenceDir, `bearing-commit-${plan.id}.txt`), `${line}\n${JSON.stringify(sample)}\n${failures.join('\n')}\n`);
  console.log(line);
  if (failures.length) throw new Error(['map-bearing-commit fail', ...failures].join('\n'));
  return line;
}
