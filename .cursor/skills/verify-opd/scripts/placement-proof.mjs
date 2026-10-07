import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { devices, webkit } = require('playwright');

const PRODUCT_META = 'width=device-width, initial-scale=1, viewport-fit=cover';

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

async function until(page, ready, label) {
  const started = Date.now();
  let last = null;
  let matched = 0;
  while (Date.now() - started < 3000) {
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
    card.style.boxSizing = 'border-box';
    card.style.height = `${height}px`;
    card.style.minHeight = `${height}px`;
    card.style.maxHeight = `${height}px`;
    card.style.overflow = 'hidden';
  }, px);
}

function cardBoxFor(ruler, reservedShort) {
  return ruler.card + (Math.min(ruler.width, ruler.height) - reservedShort);
}

export async function proveLaunchPlacement(baseUrl, evidenceDir) {
  const browser = await webkit.launch();
  const lines = [];
  try {
    for (const scene of SCENES) {
      const context = await browser.newContext(scene.context);
      await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
      const page = await context.newPage();
      try {
        await enterIss(page, baseUrl);
        const natural = await until(
          page,
          (row) => row.sceneWidth === scene.sceneWidth && row.sceneHeight === 565 && row.innerWidth === scene.context.viewport.width && row.innerHeight === 726 && row.meta === PRODUCT_META && row.place !== '',
          `${scene.name} natural scene`,
        );
        lines.push(`${scene.name} natural ${natural.width}x${natural.height} ${natural.place} scene ${natural.sceneWidth}x${natural.sceneHeight} card ${natural.card}`);
        await setCardBox(page, 64);
        const ruler = await until(
          page,
          (row) => row.place === 'below' && row.card === 64 && row.height !== natural.height && row.sceneWidth === scene.sceneWidth && row.sceneHeight === 565 && row.innerHeight === 726 && row.meta === PRODUCT_META,
          `${scene.name} ruler below`,
        );
        const cases = PLACEMENT_CASES.filter((item) => item.sceneWidth === scene.sceneWidth);
        for (const item of cases) {
          const card = cardBoxFor(ruler, item.reservedShort);
          await setCardBox(page, card);
          const laid = await until(
            page,
            (row) => row.place === item.place && row.width === item.width && row.height === item.height && row.sceneHeight === 565 && row.innerWidth === scene.context.viewport.width && row.innerHeight === 726 && row.meta === PRODUCT_META,
            `${scene.name} reserved ${item.reservedShort} from card ${card} expected ${item.place} ${item.width}x${item.height}`,
          );
          if (evidenceDir && ((item.reservedShort === 134 && item.place === 'below') || (item.reservedShort === 119 && item.place === 'over'))) {
            mkdirSync(evidenceDir, { recursive: true });
            await page.screenshot({ path: resolve(evidenceDir, `placement-${scene.sceneWidth}-${item.place}-${item.reservedShort}.png`) });
          }
          lines.push(`${scene.name} reserved ${item.reservedShort} ${laid.width}x${laid.height} ${laid.place}`);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
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
  proveLaunchPlacement(baseUrl, evidenceDir || undefined).then((line) => {
    console.log(line);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
