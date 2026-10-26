import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { chromium } = require('playwright');

export const PLAN_OPEN_SURFACES = [
  { id: 'webkit-iphone-17-pro-402x874', engine: 'webkit', surface: 'iphone-17-pro', width: 402, height: 874, fits: false },
  { id: 'webkit-iphone-17-pro-874x402', engine: 'webkit', surface: 'iphone-17-pro', width: 874, height: 402, fits: false },
  { id: 'webkit-ipad-m4-834x1210', engine: 'webkit', surface: 'ipad-pro-11', width: 834, height: 1210, fits: true },
  { id: 'webkit-ipad-m4-1210x834', engine: 'webkit', surface: 'ipad-pro-11', width: 1210, height: 834, fits: true },
  { id: 'chrome-1440x900', engine: 'chrome', surface: 'desktop', width: 1440, height: 900, fits: true },
];

const HELP = 'drive plan-open is one process per surface. Set OPD_VERIFY_SURFACE and OPD_VERIFY_VIEWPORT to iphone-17-pro 402x874, iphone-17-pro 874x402, ipad-pro-11 834x1210, ipad-pro-11 1210x834, or desktop 1440x900. The context is created at that size. drive iss and drive all leave this probe out.';

export function planOpenPlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = PLAN_OPEN_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return plan;
}

export function insetGateFits(width, height) {
  return width >= 800 && height >= 600;
}

export function planOpenFailures(result) {
  const failures = [];
  if (!result) {
    failures.push('plan open sample missing');
    return failures;
  }
  if (result.helpHidden !== true) failures.push('corner help visible on ISS');
  if (result.snapOrder !== true) failures.push('snap help order');
  if (result.snapLabel !== 'Help — how to use SNAP') failures.push(`snap label ${result.snapLabel}`);
  if (result.helpOpened !== true) failures.push('snap help did not open');
  if (result.fullscreenPosition !== 'absolute') failures.push(`fullscreen position ${result.fullscreenPosition}`);
  if (!(Math.abs(Number(result.fullscreenSize) - 44) <= 1)) failures.push(`fullscreen size ${result.fullscreenSize}`);
  if (result.fullscreenCorner !== true) failures.push('fullscreen corner');
  if (result.fits) {
    if (result.planShown !== true) failures.push('plan hidden on a fitting viewport');
    if (result.night !== true) failures.push(`night shade ${JSON.stringify(result.nightDetail || null)}`);
    if (result.nightRebuilt !== true) failures.push('night minute');
    if (!(Number(result.zoomDelta) > 0.05)) failures.push(`wheel ${result.zoomDelta}`);
    if (result.zoomHeld !== true) failures.push('wheel reset');
    if (result.panMoved !== true || result.panOpened === true) failures.push('pointer pan');
    if (result.detailClickOpened === true) failures.push('detail click opened Map');
    if (result.enterView !== 'view-map') failures.push(`enter ${result.enterView}`);
    if (result.spaceView !== 'view-map') failures.push(`space ${result.spaceView}`);
  } else {
    if (result.planShown === true) failures.push('plan visible under the 800x600 gate');
    if (result.split === true) failures.push('split on a phone');
  }
  return failures;
}

function chromePath() {
  return [process.env.OPD_VERIFY_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/local/bin/google-chrome'].find((entry) => entry && existsSync(entry));
}

function contextOptions(plan) {
  if (plan.engine === 'chrome') {
    return {
      viewport: { width: plan.width, height: plan.height },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      serviceWorkers: 'block',
    };
  }
  const spec = plan.surface === 'iphone-17-pro'
    ? { name: 'iPhone 17 Pro', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: 3 }
    : { name: 'iPad Pro 11', viewport: { width: plan.width, height: plan.height } };
  const device = deviceDescriptor(spec);
  return {
    ...device,
    viewport: { width: plan.width, height: plan.height },
    serviceWorkers: 'block',
  };
}

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

async function waitIss(page) {
  await page.waitForFunction(() => {
    const banner = document.getElementById('status-banner')?.textContent || '';
    const scene = document.querySelector('[data-iss-scene]');
    return banner.length > 0 && !banner.includes('Loading') && scene && document.getElementById('view')?.className === 'view-iss';
  }, null, { timeout: 45000 });
}

async function readChrome(page) {
  return page.evaluate(() => {
    const scene = document.querySelector('[data-iss-scene]');
    const button = document.querySelector('[data-iss-fullscreen]');
    const help = document.querySelector('[data-iss-snap-help]');
    const picker = document.querySelector('[data-iss-launch-picker-wrap]');
    const launches = document.querySelector('[data-iss-launches]');
    const fab = document.getElementById('help-fab');
    const plan = document.querySelector('[data-pip="plan"]');
    const box = button ? button.getBoundingClientRect() : null;
    const sceneBox = scene ? scene.getBoundingClientRect() : null;
    const planBox = plan ? plan.getBoundingClientRect() : null;
    return {
      helpHidden: fab instanceof HTMLElement && fab.hidden === true,
      snapOrder: picker?.nextElementSibling === help && help?.nextElementSibling === launches,
      snapLabel: help?.getAttribute('aria-label') || '',
      fullscreenPosition: button ? getComputedStyle(button).position : '',
      fullscreenSize: box ? box.width : 0,
      fullscreenCorner: !!(box && sceneBox && sceneBox.right - box.right <= 96 && sceneBox.bottom - box.bottom <= 96 && box.width >= 40),
      planShown: !!(plan && plan.hidden !== true && planBox && planBox.width > 40 && planBox.height > 40),
      split: scene?.getAttribute('data-iss-split') === 'on',
    };
  });
}

async function openSnapHelp(page) {
  await page.locator('[data-iss-snap-help]').click();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('.help-modal');
    const label = dialog?.getAttribute('aria-label') || '';
    return label.includes('Help');
  }, null, { timeout: 10000 });
  await page.locator('.help-close').click();
  await page.waitForFunction(() => !document.querySelector('.help-modal'), null, { timeout: 10000 });
}

function nightSignatureExpression() {
  return `(() => {
    const orbit = document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset;
    if (!orbit?.getStyle || !orbit.getLayer('inset-night')) return '';
    const ids = (orbit.getStyle().layers || []).map((layer) => layer.id);
    const opacity = orbit.getPaintProperty('inset-night', 'fill-opacity');
    let count = 0;
    let mark = '';
    try {
      const features = orbit.querySourceFeatures('inset-night');
      count = features.length;
      const ring = features[0] && features[0].geometry && features[0].geometry.coordinates;
      const text = ring ? JSON.stringify(ring) : '';
      let hash = 0;
      for (let i = 0; i < text.length; i += 1) hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
      mark = text.length + ':' + hash;
    } catch (error) {
      mark = '';
    }
    return [ids.indexOf('inset-basemap'), ids.indexOf('inset-night'), ids.indexOf('inset-labels'), opacity, count, mark].join('|');
  })()`;
}

async function readNight(page) {
  return page.evaluate(`(() => {
    const orbit = document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset;
    if (!orbit?.getStyle || !orbit.getLayer) return { ok: false, reason: 'map' };
    const ids = (orbit.getStyle().layers || []).map((layer) => layer.id);
    const basemap = ids.indexOf('inset-basemap');
    const night = ids.indexOf('inset-night');
    const labels = ids.indexOf('inset-labels');
    const opacity = orbit.getPaintProperty('inset-night', 'fill-opacity');
    let count = 0;
    try {
      count = orbit.querySourceFeatures('inset-night').length;
    } catch (error) {
      count = 0;
    }
    const ordered = basemap >= 0 && night === basemap + 1 && labels > night;
    return { ok: ordered && opacity === 0.28 && count > 0, ordered, opacity, count, ids };
  })()`);
}

async function pointerKind(plan) {
  return plan.engine === 'webkit' ? 'touch' : 'mouse';
}

async function provePlanLive(page, plan, shotPath) {
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-pip="plan"] canvas');
    const orbit = document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset;
    return canvas && orbit && typeof orbit.getZoom === 'function' && orbit.isStyleLoaded && orbit.isStyleLoaded();
  }, null, { timeout: 30000 });
  let night = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    night = await readNight(page);
    if (night?.ok) break;
    await page.waitForTimeout(500);
  }
  const beforeSig = await page.evaluate(nightSignatureExpression());
  await page.evaluate(() => {
    const real = Date.now;
    window.__opdPlanNowOriginal = real;
    Date.now = () => real() + 70000;
  });
  let nightRebuilt = false;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await page.waitForTimeout(400);
    const next = await page.evaluate(nightSignatureExpression());
    if (next && next !== beforeSig) {
      nightRebuilt = true;
      break;
    }
  }
  await page.evaluate(() => {
    if (typeof window.__opdPlanNowOriginal === 'function') Date.now = window.__opdPlanNowOriginal;
  });
  const zoomed = await page.evaluate(() => {
    const canvas = document.querySelector('[data-pip="plan"] canvas');
    const orbit = document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset;
    if (!canvas || !orbit?.getZoom) return { ok: false, reason: 'map' };
    const before = orbit.getZoom();
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -240,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }));
    return { ok: true, before };
  });
  let settled = zoomed?.before;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await page.waitForTimeout(250);
    settled = await page.evaluate(() => document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset?.getZoom?.());
    if (typeof settled === 'number' && typeof zoomed?.before === 'number' && Math.abs(settled - zoomed.before) > 0.05) break;
  }
  await page.waitForTimeout(5600);
  const afterZoom = await page.evaluate(() => {
    const orbit = document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset;
    return {
      zoom: orbit?.getZoom?.(),
      view: document.getElementById('view')?.className || '',
    };
  });
  const kind = await pointerKind(plan);
  if (shotPath) await page.screenshot({ path: shotPath });
  const pan = await page.evaluate((pointerType) => {
    const canvas = document.querySelector('[data-pip="plan"] canvas');
    const orbit = document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset;
    if (!canvas || !orbit?.getCenter) return { moved: false, opened: true, reason: 'map' };
    const box = canvas.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const before = orbit.getCenter();
    const send = (type, clientX, clientY) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerId: 7,
      pointerType,
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
    }));
    send('pointerdown', x, y);
    send('pointermove', x + 48, y);
    send('pointermove', x + 96, y);
    send('pointerup', x + 96, y);
    const after = orbit.getCenter();
    const moved = Math.abs(before.lng - after.lng) + Math.abs(before.lat - after.lat) > 0.02;
    return { moved, opened: document.getElementById('view')?.className !== 'view-iss', view: document.getElementById('view')?.className || '' };
  }, kind);
  const detail = await page.evaluate((pointerType) => {
    const button = document.querySelector('[data-pip="plan"]');
    if (!(button instanceof HTMLButtonElement)) return { opened: true, reason: 'button' };
    const box = button.getBoundingClientRect();
    const x = box.left + Math.min(24, box.width / 2);
    const y = box.top + Math.min(24, box.height / 2);
    const send = (type, clientX) => button.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: y,
      pointerId: 9,
      pointerType,
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
    }));
    send('pointerdown', x);
    send('pointermove', x + 18);
    send('pointerup', x + 18);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: x + 18, clientY: y }));
    return { opened: document.getElementById('view')?.className !== 'view-iss' };
  }, kind);
  await page.evaluate((pointerType) => {
    const button = document.querySelector('[data-pip="plan"]');
    const box = button.getBoundingClientRect();
    const x = box.left + Math.min(30, box.width / 2);
    const y = box.top + Math.min(30, box.height / 2);
    const send = (type, clientX) => button.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: y,
      pointerId: 11,
      pointerType,
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
    }));
    send('pointerdown', x);
    send('pointermove', x + 22);
    send('pointerup', x + 22);
    return true;
  }, kind);
  await page.locator('[data-pip="plan"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('view')?.className === 'view-map', null, { timeout: 8000 });
  const enterView = await page.evaluate(() => document.getElementById('view')?.className || '');
  await page.locator('#tab-iss').click();
  await page.waitForFunction(() => {
    const view = document.getElementById('view')?.className;
    const canvas = document.querySelector('[data-pip="plan"] canvas');
    return view === 'view-iss' && canvas;
  }, null, { timeout: 45000 });
  await page.evaluate((pointerType) => {
    const button = document.querySelector('[data-pip="plan"]');
    const box = button.getBoundingClientRect();
    const x = box.left + Math.min(30, box.width / 2);
    const y = box.top + Math.min(36, box.height / 2);
    const send = (type, clientX) => button.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: y,
      pointerId: 13,
      pointerType,
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
    }));
    send('pointerdown', x);
    send('pointermove', x + 22);
    send('pointerup', x + 22);
    return true;
  }, kind);
  await page.locator('[data-pip="plan"]').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('view')?.className === 'view-map', null, { timeout: 8000 });
  const spaceView = await page.evaluate(() => document.getElementById('view')?.className || '');
  const zoomDelta = typeof settled === 'number' && typeof zoomed?.before === 'number' ? settled - zoomed.before : 0;
  const zoomHeld = typeof afterZoom.zoom === 'number' && typeof settled === 'number'
    && Math.abs(afterZoom.zoom - settled) <= 0.03
    && Math.abs(afterZoom.zoom - zoomed.before) > 0.05
    && afterZoom.view === 'view-iss';
  return {
    night: night?.ok === true,
    nightDetail: night,
    nightRebuilt,
    zoomDelta,
    zoomHeld,
    panMoved: pan?.moved === true,
    panOpened: pan?.opened === true,
    detailClickOpened: detail?.opened === true,
    enterView,
    spaceView,
  };
}

export async function drivePlanOpen({ baseUrl, evidenceDir }) {
  const plan = planOpenPlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
  if (plan.fits !== insetGateFits(plan.width, plan.height)) {
    throw new Error(`gate mismatch ${plan.id}`);
  }
  mkdirSync(evidenceDir, { recursive: true });
  const browser = plan.engine === 'chrome'
    ? await chromium.launch({
      headless: true,
      executablePath: chromePath(),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
    })
    : await launchWebkit();
  let result;
  try {
    const context = await browser.newContext(contextOptions(plan));
    if (plan.surface === 'iphone-17-pro') {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    try {
      await page.goto(`${baseUrl}/?e2e`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const size = await assertCreatedSize(page, plan);
      console.log(`viewport plan-open surface ${plan.id} opened ${plan.width}x${plan.height} now ${size.w}x${size.h} created-at-size`);
      await page.waitForFunction(() => {
        const text = document.getElementById('status-banner')?.textContent || '';
        return text.length > 0 && !text.includes('Loading');
      }, null, { timeout: 30000 });
      await page.locator('#tab-iss').click();
      await waitIss(page);
      const chrome = await readChrome(page);
      await openSnapHelp(page);
      const shot = resolve(evidenceDir, `plan-open-${plan.id}.png`);
      const live = plan.fits ? await provePlanLive(page, plan, shot) : {};
      result = { ...chrome, helpOpened: true, fits: plan.fits, ...live };
      if (!plan.fits) await page.screenshot({ path: shot });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const failures = planOpenFailures(result);
  const gate = result.fits ? 'shown' : 'hidden';
  const line = result.fits
    ? `plan open ${plan.id} ${plan.width}x${plan.height} created-at-size help snap fullscreen corner plan ${gate} night ${result.night ? 'on' : 'off'} rebuilt ${result.nightRebuilt ? 'yes' : 'no'} wheel ${Number(result.zoomDelta).toFixed(2)} pan ${result.panMoved ? 'moved' : 'still'} detail ${result.detailClickOpened ? 'opened' : 'held'} enter ${result.enterView} space ${result.spaceView}`
    : `plan open ${plan.id} ${plan.width}x${plan.height} created-at-size help snap fullscreen corner plan ${gate} split ${result.split ? 'on' : 'off'}`;
  writeFileSync(resolve(evidenceDir, `plan-open-${plan.id}.txt`), `${line}\n${failures.join('\n')}\n`);
  console.log(line);
  if (failures.length) throw new Error(['plan-open fail', ...failures].join('\n'));
  return line;
}
