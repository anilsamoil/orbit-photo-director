import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { devices, webkit } = require('playwright');

const PRODUCT_META = 'width=device-width, initial-scale=1, viewport-fit=cover';
export const NATURAL_CARD_PX = 96;

export const PLACEMENT_CASES = [
  { sceneWidth: 390, reservedShort: 134, place: 'below', width: 201, height: 134 },
  { sceneWidth: 390, reservedShort: 132, place: 'below', width: 198, height: 132 },
  { sceneWidth: 390, reservedShort: 120, place: 'below', width: 180, height: 120 },
  { sceneWidth: 390, reservedShort: 119, place: 'over', width: 333, height: 222 },
  { sceneWidth: 390, reservedShort: 120, place: 'over', width: 333, height: 222 },
  { sceneWidth: 390, reservedShort: 131, place: 'over', width: 333, height: 222 },
  { sceneWidth: 390, reservedShort: 132, place: 'below', width: 198, height: 132 },
  { sceneWidth: 402, reservedShort: 134, place: 'below', width: 201, height: 134 },
  { sceneWidth: 402, reservedShort: 132, place: 'below', width: 198, height: 132 },
  { sceneWidth: 402, reservedShort: 120, place: 'below', width: 180, height: 120 },
  { sceneWidth: 402, reservedShort: 119, place: 'over', width: 345, height: 230 },
  { sceneWidth: 402, reservedShort: 120, place: 'over', width: 345, height: 230 },
  { sceneWidth: 402, reservedShort: 131, place: 'over', width: 345, height: 230 },
  { sceneWidth: 402, reservedShort: 132, place: 'below', width: 198, height: 132 },
];

const SCENES = [
  { name: 'iphone-13', sceneWidth: 390, context: { ...devices['iPhone 13'], viewport: { width: 390, height: 726 } } },
  {
    name: 'iphone-17-pro',
    sceneWidth: 402,
    context: { ...devices['iPhone 13'], viewport: { width: 402, height: 726 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  },
];

function readLayout() {
  const scene = document.querySelector('[data-iss-scene]');
  const frame = document.querySelector('[data-iss-frame]');
  const card = document.querySelector('[data-iss-launch-card]');
  if (!scene || !frame || !card) return null;
  const box = frame.getBoundingClientRect();
  return {
    place: scene.dataset.issLaunchPlace || '',
    width: Math.round(box.width),
    height: Math.round(box.height),
    card: card.offsetHeight,
    sceneWidth: scene.clientWidth,
    sceneHeight: scene.clientHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    meta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '',
  };
}

async function enterIss(page, baseUrl) {
  await page.goto(`${baseUrl.replace(/\/$/, '')}/?e2e`, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-iss').click();
  await page.locator('[data-iss-preset="nadir"]').click();
  await page.waitForFunction(
    () => (document.querySelector('[data-iss-launch-picker]')?.querySelectorAll('option').length || 0) > 2,
    null,
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const picker = document.querySelector('[data-iss-launch-picker]');
    const option = [...picker.options].find((entry) => (entry.textContent || '').includes('Verify Pad'));
    if (!option) throw new Error('Verify Pad missing');
    picker.value = option.value;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function until(page, ready, label, timeout = 3000) {
  const started = Date.now();
  let last = null;
  let matched = 0;
  while (Date.now() - started < timeout) {
    last = await page.evaluate(readLayout);
    if (last && ready(last)) {
      matched += 1;
      if (matched >= 2) return last;
    } else {
      matched = 0;
    }
    await page.waitForTimeout(80);
  }
  throw new Error(`${label} saw ${JSON.stringify(last)}`);
}

async function setCardBox(page, px) {
  await page.evaluate((height) => {
    const card = document.querySelector('[data-iss-launch-card]');
    const frame = document.querySelector('[data-iss-frame]');
    card.style.boxSizing = 'border-box';
    card.style.height = `${height}px`;
    card.style.minHeight = `${height}px`;
    card.style.maxHeight = `${height}px`;
    card.style.overflow = 'hidden';
    frame.style.height = '1px';
  }, px);
}

function cardBoxFor(ruler, reservedShort) {
  return ruler.card + (Math.min(ruler.width, ruler.height) - reservedShort);
}

export function placementScenes(sceneWidth) {
  if (sceneWidth === undefined) return SCENES;
  const scenes = SCENES.filter((scene) => scene.sceneWidth === sceneWidth);
  if (!scenes.length) throw new Error(`placement proof has no ${sceneWidth}-wide scene`);
  return scenes;
}

export function acceptsNatural(scene, row) {
  if (!row) return false;
  const fitted = Math.abs(row.width - Math.round(row.height * 3 / 2)) <= 1;
  return row.sceneWidth === scene.sceneWidth
    && row.sceneHeight === 565
    && row.innerWidth === scene.context.viewport.width
    && row.innerHeight === 726
    && row.meta === PRODUCT_META
    && row.place === 'below'
    && row.card === NATURAL_CARD_PX
    && row.height >= 120
    && row.height < 200
    && row.width > row.height
    && fitted;
}

async function openScene(scene) {
  const profile = mkdtempSync(join(tmpdir(), 'opd-placement-'));
  try {
    const context = await webkit.launchPersistentContext(profile, {
      ...scene.context,
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    });
    await context.route('**/*', (route) => {
      const headers = { ...route.request().headers() };
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
      headers['cache-control'] = 'no-cache';
      headers.pragma = 'no-cache';
      return route.continue({ headers });
    });
    const page = context.pages()[0] || await context.newPage();
    return {
      page,
      async close() {
        try {
          await context.close();
        } finally {
          rmSync(profile, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

export async function proveLaunchPlacement(baseUrl, evidenceDir, sceneWidth) {
  const lines = [];
  for (const scene of placementScenes(sceneWidth)) {
    const opened = await openScene(scene);
    const page = opened.page;
    try {
      await enterIss(page, baseUrl);
      const controlled = await page.evaluate(async () => {
        const worker = navigator.serviceWorker;
        if (!worker) return { controller: false, registrations: 0 };
        const registrations = await worker.getRegistrations();
        return { controller: Boolean(worker.controller), registrations: registrations.length };
      });
      if (controlled.controller || controlled.registrations) {
        throw new Error(`${scene.name} placement page is controlled by a service worker ${JSON.stringify(controlled)}`);
      }
      const natural = await until(page, (row) => acceptsNatural(scene, row), `${scene.name} natural scene`, 8000);
      await page.waitForTimeout(600);
      const settled = await page.evaluate(readLayout);
      if (!acceptsNatural(scene, settled) || settled.width !== natural.width || settled.height !== natural.height || settled.card !== natural.card) {
        throw new Error(`${scene.name} natural moved ${JSON.stringify(natural)} -> ${JSON.stringify(settled)}`);
      }
      lines.push(`${scene.name} natural ${settled.width}x${settled.height} ${settled.place} scene ${settled.sceneWidth}x${settled.sceneHeight} card ${settled.card}`);
      await setCardBox(page, 64);
      const ruler = await until(
        page,
        (row) => row.place === 'below' && row.card === 64 && row.height > 1 && row.height !== settled.height && row.sceneWidth === scene.sceneWidth && row.sceneHeight === 565 && row.innerHeight === 726 && row.meta === PRODUCT_META,
        `${scene.name} ruler below`,
      );
      const cases = PLACEMENT_CASES.filter((item) => item.sceneWidth === scene.sceneWidth);
      for (const item of cases) {
        const card = cardBoxFor(ruler, item.reservedShort);
        await setCardBox(page, card);
        const laid = await until(
          page,
          (row) => row.place === item.place && row.width === item.width && row.height === item.height && row.height > 1 && row.sceneHeight === 565 && row.innerWidth === scene.context.viewport.width && row.innerHeight === 726 && row.meta === PRODUCT_META,
          `${scene.name} reserved ${item.reservedShort} from card ${card} expected ${item.place} ${item.width}x${item.height}`,
        );
        if (evidenceDir && ((item.reservedShort === 134 && item.place === 'below') || (item.reservedShort === 119 && item.place === 'over'))) {
          mkdirSync(evidenceDir, { recursive: true });
          await page.screenshot({ path: resolve(evidenceDir, `placement-${scene.sceneWidth}-${item.place}-${item.reservedShort}.png`) });
        }
        lines.push(`${scene.name} reserved ${item.reservedShort} ${laid.width}x${laid.height} ${laid.place}`);
      }
    } finally {
      await opened.close();
    }
  }
  return lines.join('; ');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error('usage: node placement-proof.mjs <baseUrl> [evidenceDir]');
    process.exit(1);
  }
  const evidenceDir = process.argv[3] || '';
  const sceneWidth = process.argv[4] ? Number(process.argv[4]) : undefined;
  proveLaunchPlacement(baseUrl, evidenceDir || undefined, sceneWidth).then((line) => {
    console.log(line);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
