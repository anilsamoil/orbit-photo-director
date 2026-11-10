import { createDeviceContext } from './fixture-session.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

export const PIN_TITLE_TEXT = 'INTERNATIONALSPACESTATIONZARYAEXPEDITIONINTERNATIONALSPACEST';

export const PIN_TITLE_SURFACES = [
  { id: 'webkit-ipad-m4-1210x834', surface: 'ipad-pro-11', width: 1210, height: 834, scale: 2, desktop: false },
  { id: 'webkit-desktop-1440x900', surface: 'desktop', width: 1440, height: 900, scale: 1, desktop: true },
];

const HELP = 'drive pin-title is one WebKit process per surface. Set OPD_VERIFY_SURFACE and OPD_VERIFY_VIEWPORT to ipad-pro-11 1210x834 or desktop 1440x900. The context is created at that size. drive map and drive all leave this probe out.';

const SHOW_CHROME = `(() => {
  try { localStorage.setItem('opd-map-chrome', 'shown'); } catch {}
})();`;

export function pinTitlePlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = PIN_TITLE_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return plan;
}

function partFailures(name, box, wrapped) {
  const failures = [];
  if (!box) {
    failures.push(`${name} missing`);
    return failures;
  }
  if (wrapped) {
    if (!(box.lines > 1)) failures.push(`${name} lines ${box.lines} wanted wrap`);
  } else if (box.lines !== 1) {
    failures.push(`${name} lines ${box.lines} wanted 1`);
  }
  if (!(box.clientWidth > 0) || box.scrollWidth > box.clientWidth) {
    failures.push(`${name} scrollWidth ${box.scrollWidth} clientWidth ${box.clientWidth}`);
  }
  if (box.inside !== true) failures.push(`${name} leaves the inspector`);
  return failures;
}

export function pinTitleFailures(sample) {
  if (!sample) return ['pin title sample missing'];
  const failures = [];
  if (!(sample.container > 260)) failures.push(`container ${sample.container} wanted above 260`);
  if (sample.overflowWrap !== 'anywhere') failures.push(`overflow-wrap ${sample.overflowWrap}`);
  if (!sample.normalText || sample.normalText === PIN_TITLE_TEXT) failures.push('normal title missing');
  failures.push(...partFailures('normal', sample.normal, false));
  failures.push(...partFailures('title', sample.title, true));
  failures.push(...partFailures('heading', sample.heading, true));
  return failures;
}

function contextOptions(plan) {
  if (plan.desktop) {
    return {
      viewport: { width: plan.width, height: plan.height },
      screen: { width: plan.width, height: plan.height },
      deviceScaleFactor: plan.scale,
      isMobile: false,
      hasTouch: false,
      serviceWorkers: 'block',
    };
  }
  const spec = { name: 'iPad Pro 11', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale };
  return { ...deviceDescriptor(spec), viewport: { width: plan.width, height: plan.height }, serviceWorkers: 'block' };
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

async function readTitle(page) {
  return page.evaluate(async (titleText) => {
    const popup = document.querySelector('.dropped-pin-popup');
    const inspector = document.getElementById('map-inspector');
    if (!(popup instanceof HTMLElement) || !(inspector instanceof HTMLElement)) return { error: 'dropped pin missing' };
    const strong = popup.querySelector(':scope > strong');
    const heading = popup.querySelector('.pin-pass-heading');
    if (!(strong instanceof HTMLElement) || !(heading instanceof HTMLElement)) return { error: 'pin title missing' };
    const read = (element) => {
      const bounds = inspector.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const texts = [...range.getClientRects()].filter((text) => text.width > 0 && text.height > 0);
      const inside = texts.length > 0 && texts.every((text) => text.left >= bounds.left - 1
        && text.right <= bounds.right + 1
        && text.top >= bounds.top - 1
        && text.bottom <= bounds.bottom + 1);
      return {
        lines: texts.length,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        inside,
      };
    };
    const normalText = strong.textContent || '';
    const normal = read(strong);
    const overflowWrap = getComputedStyle(strong).overflowWrap;
    const container = popup.clientWidth;
    strong.textContent = titleText;
    heading.textContent = titleText;
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    return {
      container,
      overflowWrap,
      normalText,
      normal,
      title: read(strong),
      heading: read(heading),
    };
  }, PIN_TITLE_TEXT);
}

export async function drivePinTitle({ baseUrl, evidenceDir, fixtureToken, startOffset = 0 }) {
  const plan = pinTitlePlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
  mkdirSync(evidenceDir, { recursive: true });
  const browser = await launchWebkit();
  let sample;
  try {
    const context = await createDeviceContext(browser, contextOptions(plan), { baseUrl, token: fixtureToken, startOffset });
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
      console.log(`viewport pin-title surface ${plan.id} opened ${plan.width}x${plan.height} now ${size.w}x${size.h} created-at-size`);
      await page.waitForFunction(() => {
        const text = document.getElementById('status-banner')?.textContent || '';
        const map = window.__opdMap;
        return text.length > 0 && !text.includes('Loading') && !!map?.getLayer?.('iss-track-layer');
      }, null, { timeout: 60000 });
      await releaseFollow(page);
      await page.evaluate(() => {
        window.__opdMap.jumpTo({ center: [20, 10], zoom: 4 });
      });
      await page.waitForFunction(() => {
        const map = window.__opdMap;
        return !!map && !map.isMoving();
      });
      const dropPoint = await pointFor(page, 20, 10);
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
      sample = await readTitle(page);
      if (sample.error) throw new Error(sample.error);
      await page.screenshot({ path: resolve(evidenceDir, `pin-title-${plan.id}.png`) });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const failures = pinTitleFailures(sample);
  const line = `pin title ${plan.id} container ${sample?.container} overflow-wrap ${sample?.overflowWrap} normal ${sample?.normal?.lines} title ${sample?.title?.lines} scroll ${sample?.title?.scrollWidth}/${sample?.title?.clientWidth}`;
  writeFileSync(resolve(evidenceDir, `pin-title-${plan.id}.txt`), `${line}\n${JSON.stringify(sample)}\n${failures.join('\n')}\n`);
  console.log(line);
  if (failures.length) throw new Error(['pin-title fail', ...failures].join('\n'));
  return line;
}
