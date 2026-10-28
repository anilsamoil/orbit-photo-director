import { createDeviceContext } from './fixture-session.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

export const PIN_FIT_SURFACES = [
  { id: 'webkit-iphone-17-pro-402x874', surface: 'iphone-17-pro', width: 402, height: 874, scale: 3, standalone: true },
  { id: 'webkit-ipad-m4-834x1210', surface: 'ipad-pro-11', width: 834, height: 1210, scale: 2, standalone: false },
];

const HELP = 'drive pin-fit is one process per surface. Set OPD_VERIFY_SURFACE and OPD_VERIFY_VIEWPORT to iphone-17-pro 402x874 or ipad-pro-11 834x1210. drive map and drive all leave this probe out.';

const SHOW_CHROME = `(() => {
  try { localStorage.setItem('opd-map-chrome', 'shown'); } catch {}
})();`;

const LAUNCH_PADDING = { top: '8px', right: '12px', bottom: '8px', left: '12px' };

export function pinFitPlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = PIN_FIT_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return plan;
}

export function pinFitFailures(sample) {
  const failures = [];
  if (!sample) {
    failures.push('pin fit sample missing');
    return failures;
  }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const actual = sample.padding?.[side];
    const wanted = LAUNCH_PADDING[side];
    if (actual !== wanted) failures.push(`padding ${side} ${actual} wanted ${wanted}`);
  }
  if (sample.box !== 190) failures.push(`box ${sample.box} wanted 190`);
  if (!(sample.clientWidth > 0) || sample.scrollWidth > sample.clientWidth) {
    failures.push(`scrollWidth ${sample.scrollWidth} clientWidth ${sample.clientWidth}`);
  }
  if (!(sample.passRows > 0) || sample.passRows !== sample.relRows) {
    failures.push(`pin-pass-row count ${sample.passRows} rel ${sample.relRows}`);
  }
  if (sample.narrowDisplay !== 'flex' || !(sample.narrowPassRows > 0) || sample.narrowPassRows !== sample.narrowRelRows) {
    failures.push(`narrow pin-pass-row count ${sample.narrowPassRows} rel ${sample.narrowRelRows} display ${sample.narrowDisplay}`);
  }
  return failures;
}

function contextOptions(plan) {
  const spec = plan.surface === 'iphone-17-pro'
    ? { name: 'iPhone 17 Pro', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale }
    : { name: 'iPad Pro 11', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale };
  return { ...deviceDescriptor(spec), viewport: { width: plan.width, height: plan.height }, serviceWorkers: 'block' };
}

async function readLaunchPadding(page) {
  return page.evaluate(() => {
    const pane = document.getElementById('map-pane');
    const slot = document.getElementById('map-inspector');
    if (!(pane instanceof HTMLElement) || !(slot instanceof HTMLElement)) return { error: 'map inspector is missing' };
    const hadOpen = pane.classList.contains('map-inspector-open');
    const wasHidden = slot.hidden;
    pane.classList.add('map-inspector-open');
    slot.hidden = false;
    const popup = document.createElement('div');
    popup.className = 'maplibregl-popup';
    const content = document.createElement('div');
    content.className = 'maplibregl-popup-content';
    const card = document.createElement('article');
    card.className = 'card launch launch-v2 launch-ascent-card';
    card.dataset.launch = 'legacy';
    content.appendChild(card);
    popup.appendChild(content);
    slot.appendChild(popup);
    const style = getComputedStyle(content);
    const padding = {
      top: style.paddingTop,
      right: style.paddingRight,
      bottom: style.paddingBottom,
      left: style.paddingLeft,
    };
    popup.remove();
    slot.hidden = wasHidden;
    if (!hadOpen) pane.classList.remove('map-inspector-open');
    return { padding };
  });
}

async function readTargetScroll(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.map-target-popup');
    if (!(card instanceof HTMLElement)) return { error: 'target card missing' };
    const box = document.createElement('div');
    box.style.cssText = 'width:190px;max-width:190px;overflow:auto;position:absolute;left:0;top:0;visibility:hidden;box-sizing:content-box;padding:0;border:0;margin:0';
    box.appendChild(card.cloneNode(true));
    document.body.appendChild(box);
    const sample = {
      box: Math.round(parseFloat(getComputedStyle(box).width)),
      scrollWidth: box.scrollWidth,
      clientWidth: box.clientWidth,
      minWidth: box.firstElementChild instanceof HTMLElement ? box.firstElementChild.style.minWidth : '',
    };
    box.remove();
    return sample;
  });
}

async function readPassRows(page) {
  return page.evaluate(() => {
    const popup = document.querySelector('.dropped-pin-popup');
    if (!(popup instanceof HTMLElement)) return { error: 'dropped pin missing' };
    const tally = (root) => {
      const row = root.querySelector('.pin-pass-row');
      return {
        passRows: root.querySelectorAll('.pin-pass-row').length,
        relRows: root.querySelectorAll('.pin-pass-rel').length,
        display: row instanceof HTMLElement ? getComputedStyle(row).display : 'missing',
      };
    };
    const open = tally(popup);
    const width = popup.style.width;
    const maxWidth = popup.style.maxWidth;
    popup.style.width = '240px';
    popup.style.maxWidth = '240px';
    const narrow = tally(popup);
    popup.style.width = width;
    popup.style.maxWidth = maxWidth;
    return {
      passRows: open.passRows,
      relRows: open.relRows,
      narrowPassRows: narrow.passRows,
      narrowRelRows: narrow.relRows,
      narrowDisplay: narrow.display,
    };
  });
}

async function releaseFollow(page) {
  await page.evaluate(() => {
    const button = document.getElementById('toggle-follow-iss');
    if (button instanceof HTMLButtonElement && button.getAttribute('aria-pressed') === 'true') button.click();
  });
  await page.waitForFunction(() => document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed') === 'false');
}

async function pointFor(page, lng, lat) {
  return page.evaluate(({ lng, lat }) => {
    const map = window.__opdMap;
    const canvas = map?.getCanvas();
    if (!map || !canvas) return { ok: false, reason: 'no map' };
    const center = map.getCenter();
    let lon = lng;
    if (center && Number.isFinite(center.lng)) {
      while (lon - center.lng > 180) lon -= 360;
      while (center.lng - lon > 180) lon += 360;
    }
    const projected = map.project([lon, lat]);
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + projected.x;
    const y = rect.top + projected.y;
    const node = document.elementFromPoint(x, y);
    const onCanvas = node === canvas || (node instanceof Node && canvas.contains(node));
    return {
      ok: onCanvas,
      x,
      y,
      hit: node ? (node.id || (typeof node.className === 'string' ? node.className : node.tagName)) : null,
    };
  }, { lng, lat });
}

async function frame(page, lng, lat) {
  await page.evaluate(({ lng, lat }) => {
    window.__opdMap.jumpTo({ center: [lng, lat], zoom: 4 });
  }, { lng, lat });
  await page.waitForFunction(() => {
    const map = window.__opdMap;
    return !!map && !map.isMoving();
  });
}

async function targetAt(page, id) {
  return page.evaluate((targetId) => {
    const map = window.__opdMap;
    const source = map?.getSource?.(targetId === 'verify-reef' ? 'targets' : 'targets');
    const data = source?.serialize?.().data;
    const feature = data?.features?.find((entry) => entry.properties?.target_id === targetId);
    const coords = feature?.geometry?.coordinates;
    if (!coords) return null;
    return { lng: coords[0], lat: coords[1] };
  }, id);
}

export async function drivePinFit({ baseUrl, evidenceDir, fixtureToken, startOffset = 0 }) {
  const plan = pinFitPlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
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
      console.log(`viewport pin-fit surface ${plan.id} opened ${plan.width}x${plan.height} now ${size.w}x${size.h} created-at-size`);
      await page.waitForFunction(() => {
        const text = document.getElementById('status-banner')?.textContent || '';
        const map = window.__opdMap;
        const source = map?.getSource?.('targets');
        const features = source?.serialize?.().data?.features || [];
        return text.length > 0 && !text.includes('Loading')
          && !!map?.getLayer?.('iss-track-layer')
          && features.some((feature) => feature.properties?.target_id === 'verify-reef');
      }, null, { timeout: 60000 });
      const padding = await readLaunchPadding(page);
      if (padding.error) throw new Error(padding.error);
      await releaseFollow(page);
      const reef = await targetAt(page, 'verify-reef');
      const delta = await targetAt(page, 'verify-delta');
      if (!reef || !delta) throw new Error('fixture targets missing');
      await frame(page, reef.lng, reef.lat);
      await page.waitForFunction(() => {
        const map = window.__opdMap;
        if (!map?.queryRenderedFeatures || !map.getLayer('targets-layer')) return false;
        return map.queryRenderedFeatures({ layers: ['targets-layer'] }).some((feature) => feature.properties?.target_id === 'verify-reef');
      });
      const reefPoint = await pointFor(page, reef.lng, reef.lat);
      if (!reefPoint.ok) throw new Error(`target popup missed the canvas ${JSON.stringify(reefPoint)}`);
      await page.mouse.click(reefPoint.x, reefPoint.y);
      const reefOpened = await page.locator('.map-target-popup').waitFor({ timeout: 8000 }).then(() => true, () => false);
      if (!reefOpened) {
        await page.touchscreen.tap(reefPoint.x, reefPoint.y);
        await page.locator('.map-target-popup').waitFor();
      }
      const scroll = await readTargetScroll(page);
      if (scroll.error) throw new Error(scroll.error);
      await page.evaluate(() => {
        document.querySelectorAll('.maplibregl-popup-close-button').forEach((button) => {
          if (button instanceof HTMLElement) button.click();
        });
      });
      await page.waitForFunction(() => !document.querySelector('.map-target-popup'));
      await frame(page, delta.lng, delta.lat);
      const dropPoint = await pointFor(page, delta.lng, delta.lat);
      if (!dropPoint.ok) throw new Error(`pin drop missed the canvas ${JSON.stringify(dropPoint)}`);
      await page.mouse.click(dropPoint.x, dropPoint.y, { button: 'right' });
      const pinOpened = await page.locator('.dropped-pin-popup').waitFor({ timeout: 8000 }).then(() => true, () => false);
      if (!pinOpened) {
        await page.evaluate(({ x, y }) => {
          const node = document.elementFromPoint(x, y);
          node?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
        }, dropPoint);
        await page.locator('.dropped-pin-popup').waitFor();
      }
      const rows = await readPassRows(page);
      if (rows.error) throw new Error(rows.error);
      sample = { padding: padding.padding, ...scroll, ...rows };
      await page.screenshot({ path: resolve(evidenceDir, `pin-fit-${plan.id}.png`) });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const failures = pinFitFailures(sample);
  const line = `pin fit ${plan.id} padding ${sample?.padding?.top} ${sample?.padding?.right} ${sample?.padding?.bottom} ${sample?.padding?.left} scroll ${sample?.scrollWidth}/${sample?.clientWidth} rows ${sample?.passRows} narrow ${sample?.narrowPassRows} ${sample?.narrowDisplay}`;
  writeFileSync(resolve(evidenceDir, `pin-fit-${plan.id}.txt`), `${line}\n${JSON.stringify(sample)}\n${failures.join('\n')}\n`);
  console.log(line);
  if (failures.length) throw new Error(['pin-fit fail', ...failures].join('\n'));
  return line;
}
