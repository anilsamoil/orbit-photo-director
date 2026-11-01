import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDeviceContext } from './fixture-session.mjs';
import { liveFixtureRoot, readDriveClock } from './fixtures.mjs';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

export const LIGHTNING_CASES = [
  { id: 'verify-glm-2m', name: 'Verify GLM Fresh', source: 'glm-2m', potential: 0.8, rate: 4, chip: 'observed lightning flashes' },
  { id: 'verify-gfs-cape', name: 'Verify GFS Cape', source: 'gfs-cape', potential: 0.6, rate: 0, chip: 'lightning forecast' },
  { id: 'verify-glm-quiet', name: 'Verify GLM Quiet', source: 'glm-5m', potential: 0.4, rate: 0, chip: 'lightning forecast' },
  { id: 'verify-potential-zero', name: 'Verify Potential Zero', source: 'glm-2m', potential: 0, rate: 3, chip: null },
  { id: 'verify-glm-nodata', name: 'Verify GLM None', source: 'glm-no-data', potential: 0, rate: 0, chip: null },
  { id: 'verify-glm-45m', name: 'Verify GLM Stale', source: 'glm-45m', potential: 0.7, rate: 2, chip: 'observed lightning flashes' },
  { id: 'verify-potential-floor', name: 'Verify Potential Floor', source: 'glm-2m', potential: 0.05, rate: 6, chip: null },
];

export const LIGHTNING_SURFACES = [
  { id: 'webkit-iphone-17-pro-402x874', surface: 'iphone-17-pro', width: 402, height: 874, scale: 3, desktop: false },
  { id: 'webkit-ipad-m4-1210x834', surface: 'ipad-pro-11', width: 1210, height: 834, scale: 2, desktop: false },
  { id: 'webkit-desktop-1440x900', surface: 'desktop', width: 1440, height: 900, scale: 1, desktop: true },
];

const HELP = 'drive queue-lightning is one WebKit process per surface. Set OPD_VERIFY_SURFACE and OPD_VERIFY_VIEWPORT to iphone-17-pro 402x874, ipad-pro-11 1210x834, or desktop 1440x900. The context is created at that size. drive queue and drive all leave this probe out.';

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function lightningPlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = LIGHTNING_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return plan;
}

export const LIGHTNING_PAGE = 5;

export function lightningPages(cases = LIGHTNING_CASES) {
  const pages = [];
  for (let index = 0; index < cases.length; index += LIGHTNING_PAGE) pages.push(cases.slice(index, index + LIGHTNING_PAGE));
  return pages;
}

export function installLightningPasses(fixtureDir, cases = LIGHTNING_CASES) {
  const clock = readDriveClock(fixtureDir);
  if (!clock) throw new Error('queue-lightning needs drive-clock.json');
  const root = liveFixtureRoot(fixtureDir);
  const top5Path = join(root, 'top5.json');
  const manifestPath = join(root, 'manifest.json');
  const top5 = JSON.parse(readFileSync(top5Path, 'utf8'));
  if (!Array.isArray(top5) || top5.length === 0) throw new Error('queue-lightning top5 is empty');
  const template = top5.find((pass) => pass?.target_id === 'verify-reef') || top5[0];
  const next = cases.map((item) => {
    const index = LIGHTNING_CASES.findIndex((entry) => entry.id === item.id);
    return {
      ...template,
      target_id: item.id,
      target_name: item.name,
      closest_approach: iso(clock.start + (22 + Math.max(0, index) * 4) * 60_000),
      score: 90 - Math.max(0, index),
      lightning_potential: item.potential,
      lightning_source: item.source,
      flash_rate_per_min: item.rate,
    };
  });
  const text = JSON.stringify(next);
  writeFileSync(top5Path, text);
  const sha = createHash('sha256').update(text).digest('hex');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = manifest?.artifacts?.top5;
  if (!entry) throw new Error('queue-lightning manifest has no top5');
  entry.sha256 = sha;
  entry.bytes = Buffer.byteLength(text);
  entry.path = `v/verify/${sha}/top5.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { sha, count: next.length };
}

export function lightningFailures(sample) {
  if (!sample?.cards) return ['queue lightning sample missing'];
  const failures = [];
  if (!String(sample.view || '').includes('view-queue')) failures.push(`view ${sample.view || 'missing'}`);
  for (const item of LIGHTNING_CASES) {
    const card = sample.cards.find((entry) => entry.id === item.id);
    if (!card) {
      failures.push(`${item.id} missing`);
      continue;
    }
    if (card.rendered !== true) failures.push(`${item.id} did not render`);
    if (card.name !== item.name) failures.push(`${item.id} name ${JSON.stringify(card.name)}`);
    const text = card.text || '';
    if (item.chip) {
      if (!text.includes(item.chip)) failures.push(`${item.id} chip ${JSON.stringify(text)} wanted ${item.chip}`);
      if (item.chip === 'observed lightning flashes' && text.includes('lightning forecast')) {
        failures.push(`${item.id} chip also says forecast`);
      }
      if (item.chip === 'lightning forecast' && text.includes('observed')) {
        failures.push(`${item.id} chip also says observed`);
      }
      if (card.clip) failures.push(`${item.id} clips`);
      if (card.overlap) failures.push(`${item.id} overlaps ${card.overlap}`);
      if (card.inside !== true) failures.push(`${item.id} leaves the card`);
    } else if (text) {
      failures.push(`${item.id} chip ${JSON.stringify(text)} wanted none`);
    }
  }
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
  const spec = {
    name: plan.surface === 'iphone-17-pro' ? 'iPhone 17 Pro' : 'iPad Pro 11',
    viewport: { width: plan.width, height: plan.height },
    deviceScaleFactor: plan.scale,
  };
  return {
    ...deviceDescriptor(spec),
    viewport: { width: plan.width, height: plan.height },
    screen: { width: plan.width, height: plan.height },
    serviceWorkers: 'block',
  };
}

async function readChips(page, cases) {
  return page.evaluate((cases) => {
    const area = (a, b) => {
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return w > 1 && h > 1 ? w * h : 0;
    };
    const cards = cases.map((item) => {
      const card = document.querySelector(`#cards article.card[data-target-id="${item.id}"]`);
      if (!(card instanceof HTMLElement)) return { id: item.id, rendered: false, name: '', text: '', clip: false, overlap: '', inside: false };
      card.scrollIntoView({ block: 'center', inline: 'nearest' });
      const name = card.querySelector('.card-name');
      const chip = card.querySelector('.weather-lightning');
      const cardBox = card.getBoundingClientRect();
      const nameText = name instanceof HTMLElement ? name.textContent || '' : '';
      let text = '';
      let clip = false;
      let inside = true;
      let overlap = '';
      if (chip instanceof HTMLElement) {
        text = chip.textContent || '';
        const box = chip.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(chip);
        const texts = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
        clip = chip.scrollWidth > chip.clientWidth + 1
          || chip.scrollHeight > chip.clientHeight + 1
          || texts.some((rect) => rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1);
        const onCard = box.width > 0 && box.height > 0
          && box.left >= cardBox.left - 1 && box.right <= cardBox.right + 1
          && box.top >= cardBox.top - 1 && box.bottom <= cardBox.bottom + 1
          && texts.every((rect) => rect.left >= cardBox.left - 1 && rect.right <= cardBox.right + 1
            && rect.top >= cardBox.top - 1 && rect.bottom <= cardBox.bottom + 1);
        const onScreen = box.left >= -1 && box.top >= -1
          && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1;
        inside = onCard && onScreen;
        for (const tag of card.querySelectorAll('.card-meta .tag')) {
          if (tag === chip) continue;
          if (area(box, tag.getBoundingClientRect()) > 0) {
            overlap = tag.className || 'tag';
            break;
          }
        }
      }
      return {
        id: item.id,
        name: nameText,
        rendered: nameText === item.name && cardBox.width > 0 && cardBox.height > 0,
        text,
        clip,
        overlap,
        inside,
      };
    });
    return { view: document.getElementById('view')?.className || '', cards };
  }, cases);
}

async function showCases(page, cases) {
  await page.waitForFunction(() => {
    const text = document.getElementById('status-banner')?.textContent || '';
    return text.length > 0 && !text.includes('Loading');
  }, null, { timeout: 60000 });
  await page.locator('#tab-queue').click();
  await page.waitForFunction((names) => {
    const view = document.getElementById('view');
    const text = document.getElementById('cards')?.innerText || '';
    return view?.classList.contains('view-queue') && names.every((name) => text.includes(name));
  }, cases.map((item) => item.name), { timeout: 60000 });
}

export async function driveQueueLightning({ baseUrl, evidenceDir, fixtureDir, fixtureToken, startOffset = 0 }) {
  const plan = lightningPlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
  const pages = lightningPages();
  installLightningPasses(fixtureDir, pages[0]);
  mkdirSync(evidenceDir, { recursive: true });
  const browser = await launchWebkit();
  let sample;
  try {
    const context = await createDeviceContext(browser, contextOptions(plan), { baseUrl, token: fixtureToken, startOffset });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    try {
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
      console.log(`viewport queue-lightning surface ${plan.id} opened ${plan.width}x${plan.height} now ${size.w}x${size.h} created-at-size`);
      const cards = [];
      let view = '';
      for (let index = 0; index < pages.length; index += 1) {
        if (index > 0) {
          installLightningPasses(fixtureDir, pages[index]);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          const again = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
          if (again.w !== plan.width || again.h !== plan.height) {
            throw new Error(`reload changed ${plan.width}x${plan.height} to ${again.w}x${again.h}`);
          }
        }
        await showCases(page, pages[index]);
        const part = await readChips(page, pages[index]);
        view = part.view;
        cards.push(...part.cards);
        if (index === 0) {
          await page.evaluate((id) => {
            document.querySelector(`#cards article.card[data-target-id="${id}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest' });
          }, 'verify-glm-2m');
          await page.screenshot({ path: resolve(evidenceDir, `queue-lightning-${plan.id}.png`) });
        }
      }
      sample = { view, cards };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const failures = lightningFailures(sample);
  const counts = LIGHTNING_CASES.reduce((sum, item) => {
    const key = item.chip === 'observed lightning flashes' ? 'observed' : item.chip === 'lightning forecast' ? 'forecast' : 'none';
    sum[key] += 1;
    return sum;
  }, { observed: 0, forecast: 0, none: 0 });
  const line = `queue lightning ${plan.id} observed ${counts.observed} forecast ${counts.forecast} none ${counts.none}`;
  writeFileSync(resolve(evidenceDir, `queue-lightning-${plan.id}.txt`), `${line}\n${JSON.stringify(sample)}\n${failures.join('\n')}\n`);
  console.log(line);
  if (failures.length) throw new Error(['queue-lightning fail', ...failures].join('\n'));
  return line;
}
