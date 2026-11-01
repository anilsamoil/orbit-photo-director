import { createDeviceContext } from './fixture-session.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

export const MAP_HOLD_SURFACES = [
  { id: 'webkit-iphone-17-pro-402x874', surface: 'iphone-17-pro', width: 402, height: 874, scale: 3, standalone: true },
  { id: 'webkit-ipad-m4-834x1210', surface: 'ipad-pro-11', width: 834, height: 1210, scale: 2, standalone: false },
];

const HELP = 'drive map-hold is one process per surface. Set OPD_VERIFY_SURFACE and OPD_VERIFY_VIEWPORT to iphone-17-pro 402x874 or ipad-pro-11 834x1210. drive map and drive all leave this probe out.';

const SHOW_CHROME = `(() => {
  try { localStorage.setItem('opd-map-chrome', 'shown'); } catch {}
})();`;

export function mapHoldPlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = MAP_HOLD_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return plan;
}

export function mapHoldFailures(sample) {
  const failures = [];
  if (!sample) {
    failures.push('map hold sample missing');
    return failures;
  }
  const expect = (name, actual, wanted) => {
    if (actual !== wanted) failures.push(`${name} ${actual} wanted ${wanted}`);
  };
  expect('idle', sample.idle, '0px');
  expect('held', sample.held, '0px');
  expect('chord', sample.chord, '0px');
  expect('released', sample.released, '372px');
  expect('otherPointer', sample.otherPointer, '0px');
  expect('otherReleased', sample.otherReleased, '372px');
  expect('cancelled', sample.cancelled, '372px');
  expect('blurred', sample.blurred, '372px');
  expect('lost', sample.lost, '372px');
  return failures;
}

function contextOptions(plan) {
  const spec = plan.surface === 'iphone-17-pro'
    ? { name: 'iPhone 17 Pro', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale }
    : { name: 'iPad Pro 11', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale };
  return { ...deviceDescriptor(spec), viewport: { width: plan.width, height: plan.height }, serviceWorkers: 'block' };
}

async function readHold(page) {
  return page.evaluate(async () => {
    const button = document.getElementById('map-chrome-toggle');
    const banner = document.getElementById('status-banner');
    const sync = window.__opdSyncMapChrome;
    if (!(button instanceof HTMLButtonElement) || !(banner instanceof HTMLElement) || typeof sync !== 'function') {
      return { error: 'map chrome is not bound' };
    }
    const lift = () => document.body.style.getPropertyValue('--map-corner-lift') || '0px';
    const domRect = (x, y, w, h) => ({
      x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() { return {}; },
    });
    const paint = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
    });
    const point = (type, init) => {
      button.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init }));
    };
    const bannerH = 80;
    const bannerY = window.innerHeight - bannerH;
    banner.getBoundingClientRect = () => domRect(0, bannerY, 400, bannerH);
    const flat = () => {
      button.getBoundingClientRect = () => domRect(0, 0, 88, 44);
    };
    const demand = () => {
      button.getBoundingClientRect = () => {
        const applied = Number.parseFloat(lift()) || 0;
        return domRect(0, bannerY + 320 - applied, 88, 44);
      };
    };
    const settle = async () => {
      flat();
      sync();
      await paint();
    };
    await settle();
    const idle = lift();
    point('pointerdown', { button: 0, buttons: 1, pointerId: 4 });
    demand();
    sync();
    const held = lift();
    point('pointerup', { button: 0, buttons: 2, pointerId: 4 });
    await paint();
    const chord = lift();
    point('pointerup', { button: 2, buttons: 0, pointerId: 4 });
    await paint();
    const released = lift();

    await settle();
    point('pointerdown', { button: 0, buttons: 1, pointerId: 4 });
    demand();
    sync();
    point('pointerup', { button: 0, buttons: 0, pointerId: 9 });
    point('pointercancel', { button: 0, buttons: 0, pointerId: 9 });
    point('lostpointercapture', { buttons: 0, pointerId: 9 });
    await paint();
    sync();
    const otherPointer = lift();
    point('pointerup', { button: 2, buttons: 0, pointerId: 4 });
    await paint();
    const otherReleased = lift();

    await settle();
    point('pointerdown', { button: 0, buttons: 1, pointerId: 4 });
    demand();
    sync();
    point('pointercancel', { button: 0, buttons: 0, pointerId: 4 });
    await paint();
    const cancelled = lift();

    await settle();
    point('pointerdown', { button: 0, buttons: 1, pointerId: 4 });
    demand();
    sync();
    window.dispatchEvent(new Event('blur'));
    await paint();
    const blurred = lift();

    await settle();
    point('pointerdown', { button: 0, buttons: 1, pointerId: 4 });
    demand();
    sync();
    point('lostpointercapture', { buttons: 2, pointerId: 4 });
    await paint();
    const lost = lift();
    return { idle, held, chord, released, otherPointer, otherReleased, cancelled, blurred, lost };
  });
}

export async function driveMapHold({ baseUrl, evidenceDir, fixtureToken, startOffset = 0 }) {
  const plan = mapHoldPlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
  mkdirSync(evidenceDir, { recursive: true });
  const browser = await launchWebkit();
  let sample;
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
      console.log(`viewport map-hold surface ${plan.id} opened ${plan.width}x${plan.height} now ${size.w}x${size.h} created-at-size`);
      await page.waitForFunction(() => {
        const text = document.getElementById('status-banner')?.textContent || '';
        return typeof window.__opdSyncMapChrome === 'function' && !!document.getElementById('map-chrome-toggle') && text.length > 0 && !text.includes('Loading');
      }, null, { timeout: 60000 });
      sample = await readHold(page);
      await page.screenshot({ path: resolve(evidenceDir, `map-hold-${plan.id}.png`) });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const failures = sample?.error ? [sample.error] : mapHoldFailures(sample);
  const line = `map hold ${plan.id} idle ${sample?.idle} held ${sample?.held} chord ${sample?.chord} released ${sample?.released} cancel ${sample?.cancelled} blur ${sample?.blurred} lost ${sample?.lost}`;
  writeFileSync(resolve(evidenceDir, `map-hold-${plan.id}.txt`), `${line}\n${JSON.stringify(sample)}\n${failures.join('\n')}\n`);
  console.log(line);
  if (failures.length) throw new Error(['map-hold fail', ...failures].join('\n'));
  return line;
}
