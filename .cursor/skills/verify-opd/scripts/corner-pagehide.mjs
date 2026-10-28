import { createDeviceContext } from './fixture-session.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { chromium } = require('playwright');

export const PAGEHIDE_SURFACES = [
  { id: 'webkit-ipad-m4-834x1210', engine: 'webkit', surface: 'ipad-pro-11', width: 834, height: 1210 },
  { id: 'webkit-ipad-m4-1210x834', engine: 'webkit', surface: 'ipad-pro-11', width: 1210, height: 834 },
  { id: 'webkit-iphone-17-pro-402x874', engine: 'webkit', surface: 'iphone-17-pro', width: 402, height: 874 },
  { id: 'webkit-iphone-17-pro-874x402', engine: 'webkit', surface: 'iphone-17-pro', width: 874, height: 402 },
  { id: 'chrome-1440x900', engine: 'chrome', surface: 'desktop', width: 1440, height: 900 },
  { id: 'chrome-1280x800', engine: 'chrome', surface: 'desktop', width: 1280, height: 800 },
];

const HELP = 'drive map-pagehide is one process per surface. Set OPD_VERIFY_SURFACE and OPD_VERIFY_VIEWPORT to ipad-pro-11 834x1210, ipad-pro-11 1210x834, iphone-17-pro 402x874, iphone-17-pro 874x402, desktop 1440x900, or desktop 1280x800. drive map and drive all leave this probe out.';

const SHOW_CHROME = `(() => {
  try { localStorage.setItem('opd-map-chrome', 'shown'); } catch {}
})();`;

export function pagehidePlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = PAGEHIDE_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return plan;
}

function roundBox(box) {
  if (!box || !(box.width > 1) || !(box.height > 1) || box.display === 'none') return null;
  const n = (value) => Math.round(Number(value) * 100) / 100;
  return { left: n(box.left), top: n(box.top), width: n(box.width), height: n(box.height) };
}

export function formatBox(box) {
  const rounded = roundBox(box);
  if (!rounded) return 'none';
  return `${rounded.left},${rounded.top},${rounded.width},${rounded.height}`;
}

function sameBox(a, b) {
  return formatBox(a) !== 'none' && formatBox(a) === formatBox(b);
}

export function cornerPagehideFailures(sample) {
  const failures = [];
  const before = sample?.before;
  const hidden = sample?.hidden;
  const cold = sample?.cold;
  const shown = sample?.shown;
  if (!before || !hidden || !cold || !shown) {
    failures.push('corner pagehide sample missing a phase');
    return failures;
  }
  if (!(before.observers > 0)) failures.push(`observers before ${before.observers}`);
  if (hidden.observers !== 0) failures.push(`observers pagehide ${hidden.observers}`);
  if (cold.observers !== 0) failures.push(`observers pageshow cold ${cold.observers}`);
  if (shown.observers !== before.observers) failures.push(`observers pageshow ${shown.observers}`);
  for (const name of ['hide', 'legend']) {
    if (!sameBox(before[name], before[name])) failures.push(`${name} before ${formatBox(before[name])}`);
    for (const [phase, row] of [['pagehide', hidden], ['pageshow cold', cold], ['pageshow', shown]]) {
      if (!sameBox(before[name], row[name])) failures.push(`${name} ${phase} ${formatBox(row[name])}`);
    }
  }
  if (before.hide && !/Hide/.test(before.hide.text || '')) failures.push(`hide label ${before.hide.text}`);
  if (shown.hide && !/Hide/.test(shown.hide.text || '')) failures.push(`hide label ${shown.hide.text}`);
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

async function waitForCorners(page) {
  await page.waitForFunction(() => {
    const text = document.getElementById('status-banner')?.textContent || '';
    const hide = document.getElementById('map-chrome-toggle');
    const legend = document.getElementById('map-legend-toggle');
    const box = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return getComputedStyle(el).display !== 'none' && rect.width > 1 && rect.height > 1;
    };
    return text.length > 0
      && !text.includes('Loading')
      && /Hide/.test(hide?.innerText || hide?.textContent || '')
      && box(hide)
      && box(legend)
      && window.__opdCornerObservers > 0;
  }, null, { timeout: 60000 });
}

async function readCycle(page) {
  return page.evaluate(() => {
    const read = () => {
      const box = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          text: (el.innerText || el.textContent || '').trim(),
          display: style.display,
        };
      };
      return {
        observers: window.__opdCornerObservers,
        hide: box('map-chrome-toggle'),
        legend: box('map-legend-toggle'),
        lift: document.body.style.getPropertyValue('--map-corner-lift'),
      };
    };
    const before = read();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    const hidden = read();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    const cold = read();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    const shown = read();
    return { before, hidden, cold, shown };
  });
}

export async function driveMapPagehide({ baseUrl, evidenceDir, fixtureToken, startOffset = 0 }) {
  const plan = pagehidePlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
  mkdirSync(evidenceDir, { recursive: true });
  const browser = plan.engine === 'chrome'
    ? await chromium.launch({
      headless: true,
      executablePath: chromePath(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    : await launchWebkit();
  let sample;
  try {
    const context = await createDeviceContext(browser, contextOptions(plan), { baseUrl, token: fixtureToken, startOffset });
    if (plan.surface === 'iphone-17-pro') {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      });
    }
    await context.addInitScript(SHOW_CHROME);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    try {
      await page.goto(`${baseUrl}/?e2e`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const size = await assertCreatedSize(page, plan);
      console.log(`viewport map-pagehide surface ${plan.id} opened ${plan.width}x${plan.height} now ${size.w}x${size.h} created-at-size`);
      await waitForCorners(page);
      await page.screenshot({ path: resolve(evidenceDir, `map-pagehide-${plan.id}-before.png`) });
      sample = await readCycle(page);
      await page.screenshot({ path: resolve(evidenceDir, `map-pagehide-${plan.id}-after.png`) });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const failures = cornerPagehideFailures(sample);
  const line = `corner pagehide ${plan.id} observers ${sample.before.observers} hide ${sample.hidden.observers} cold ${sample.cold.observers} show ${sample.shown.observers} hide ${formatBox(sample.before.hide)} legend ${formatBox(sample.before.legend)} lift ${sample.shown.lift || '0px'}`;
  writeFileSync(resolve(evidenceDir, `map-pagehide-${plan.id}.txt`), `${line}\n${failures.join('\n')}\n`);
  console.log(line);
  if (failures.length) throw new Error(['map-pagehide fail', ...failures].join('\n'));
  return line;
}
