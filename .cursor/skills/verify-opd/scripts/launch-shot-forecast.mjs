import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { chromium } = require('playwright');

export const LAUNCH_SHOT_FORECAST_SURFACES = [
  { id: 'chrome-1440x900', engine: 'chrome', surface: 'desktop', width: 1440, height: 900 },
  { id: 'webkit-iphone-17-pro-402x874', engine: 'webkit', surface: 'iphone-17-pro', width: 402, height: 874, scale: 3 },
  { id: 'webkit-ipad-m4-834x1210', engine: 'webkit', surface: 'ipad-pro-11', width: 834, height: 1210, scale: 2 },
];

const PLAIN_SUMMARY = 'Next launch · Shot';
const FORECAST_SUMMARY = 'Next launch · Shot (forecast)';
const PLAIN_LABEL = 'LAUNCH / SHOT';
const FORECAST_LABEL = 'Shot (forecast)';

const HELP = 'drive launch-shot-forecast is one process per surface. Set OPD_VERIFY_SURFACE and OPD_VERIFY_VIEWPORT to desktop 1440x900, iphone-17-pro 402x874, or ipad-pro-11 834x1210. drive map and drive all leave this probe out.';

export function launchShotForecastPlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = LAUNCH_SHOT_FORECAST_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return plan;
}

export function launchShotForecastFailures(sample) {
  const failures = [];
  if (!sample) {
    failures.push('launch shot forecast sample missing');
    return failures;
  }
  if (sample.plainSummary !== PLAIN_SUMMARY) failures.push(`plain summary ${JSON.stringify(sample.plainSummary)}`);
  if (sample.plainLabel !== PLAIN_LABEL) failures.push(`plain label ${JSON.stringify(sample.plainLabel)}`);
  if (sample.forecastSummary !== FORECAST_SUMMARY) failures.push(`forecast summary ${JSON.stringify(sample.forecastSummary)}`);
  if (sample.forecastLabel !== FORECAST_LABEL) failures.push(`forecast label ${JSON.stringify(sample.forecastLabel)}`);
  if (sample.mark !== 1) failures.push(`page reloaded mark ${sample.mark}`);
  if (!(sample.tickMs >= 0) || sample.tickMs > 8000) failures.push(`tick ${sample.tickMs}`);
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
    ? { name: 'iPhone 17 Pro', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale }
    : { name: 'iPad Pro 11', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale };
  return { ...deviceDescriptor(spec), viewport: { width: plan.width, height: plan.height }, serviceWorkers: 'block' };
}

async function armForecastEdge(baseUrl) {
  const response = await fetch(`${baseUrl}/api/verify/forecast-edge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ boundary: Date.now() }),
  });
  if (!response.ok) throw new Error(`forecast edge arm ${response.status}`);
  return response.json();
}

async function dumpBrief(page) {
  return page.evaluate(async () => {
    const map = window.__opdMap;
    const pads = map?.getSource?.('ascent-pad');
    let label = null;
    if (pads?.getData) {
      const data = await pads.getData();
      const feature = (data.features || []).find((entry) => entry.properties && entry.properties.event_id === 'verify-ascent');
      label = feature?.properties?.label ?? null;
    }
    return {
      summary: document.querySelector('.map-launch-primary > summary')?.textContent ?? null,
      label,
      brief: document.getElementById('map-launch-coverage')?.innerText ?? null,
      banner: document.getElementById('status-banner')?.textContent ?? null,
      mark: window.__opdForecastMark || 0,
    };
  });
}

export async function driveLaunchShotForecast({ baseUrl, evidenceDir }) {
  const plan = launchShotForecastPlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
  mkdirSync(evidenceDir, { recursive: true });
  const clock = await armForecastEdge(baseUrl);
  const browser = plan.engine === 'chrome'
    ? await chromium.launch({
      headless: true,
      executablePath: chromePath(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    : await launchWebkit();
  let sample;
  try {
    const context = await browser.newContext(contextOptions(plan));
    await context.addCookies([{
      name: 'opd-verify-catalog',
      value: 'forecast-edge',
      url: baseUrl,
    }]);
    if (plan.surface === 'iphone-17-pro') {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      });
    }
    await context.addInitScript((plain) => {
      let current = plain;
      Date.now = () => current;
      window.__opdSetNow = (ms) => { current = ms; };
      window.__opdForecastMark = 1;
      const start = window.setInterval.bind(window);
      window.__opdCountdown = 0;
      window.setInterval = (fn, ms, ...rest) => {
        if (ms === 1000) window.__opdCountdown += 1;
        return start(fn, ms, ...rest);
      };
      try { localStorage.setItem('opd-map-chrome', 'shown'); } catch { /* storage can be closed */ }
    }, clock.plain);
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
      console.log(`viewport launch-shot-forecast surface ${plan.id} opened ${plan.width}x${plan.height} now ${size.w}x${size.h} created-at-size`);
      await page.waitForFunction(() => {
        const text = document.getElementById('status-banner')?.textContent || '';
        return text.length > 0 && !text.includes('Loading');
      }, null, { timeout: 60000 });
      try {
        await page.waitForFunction((wanted) => {
          return document.querySelector('.map-launch-primary > summary')?.textContent === wanted;
        }, PLAIN_SUMMARY, { timeout: 30000 });
      } catch (error) {
        const dump = await dumpBrief(page);
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${JSON.stringify(dump)}`);
      }
      await page.waitForFunction(() => window.__opdCountdown >= 1, null, { timeout: 30000 });
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        const button = document.getElementById('filter-launches-map');
        if (button && button.getAttribute('aria-pressed') !== 'true') button.click();
        const details = document.querySelector('.map-launch-primary');
        if (details) details.open = true;
        document.querySelector('.map-launch-primary > summary')?.scrollIntoView({ block: 'center' });
      });
      try {
        await page.waitForFunction((wanted) => {
          const summary = document.querySelector('.map-launch-primary > summary')?.textContent;
          const pads = window.__opdMap?.getSource?.('ascent-pad');
          return summary === wanted.summary && pads;
        }, { summary: PLAIN_SUMMARY }, { timeout: 15000 });
      } catch (error) {
        const dump = await dumpBrief(page);
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${JSON.stringify(dump)}`);
      }
      await page.waitForFunction(async (wanted) => {
        const pads = window.__opdMap?.getSource?.('ascent-pad');
        if (!pads?.getData) return false;
        const data = await pads.getData();
        const feature = (data.features || []).find((entry) => entry.properties && entry.properties.event_id === 'verify-ascent');
        return feature?.properties?.label === wanted;
      }, PLAIN_LABEL, { timeout: 15000 });
      const plain = await dumpBrief(page);
      if (plain.summary !== PLAIN_SUMMARY || plain.label !== PLAIN_LABEL) {
        throw new Error(`plain sample moved before the flip ${JSON.stringify(plain)}`);
      }
      await page.screenshot({ path: resolve(evidenceDir, `launch-shot-forecast-${plan.id}-plain.png`) });
      const started = Date.now();
      await page.evaluate((next) => { window.__opdSetNow(next); }, clock.forecast);
      try {
        await page.waitForFunction((wanted) => {
          return document.querySelector('.map-launch-primary > summary')?.textContent === wanted;
        }, FORECAST_SUMMARY, { timeout: 8000 });
      } catch (error) {
        const dump = await dumpBrief(page);
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${JSON.stringify(dump)}`);
      }
      const flipped = await dumpBrief(page);
      await page.evaluate(() => {
        document.querySelector('.map-launch-primary > summary')?.scrollIntoView({ block: 'center' });
      });
      await page.screenshot({ path: resolve(evidenceDir, `launch-shot-forecast-${plan.id}-forecast.png`) });
      sample = {
        plainSummary: plain.summary,
        plainLabel: plain.label,
        forecastSummary: flipped.summary,
        forecastLabel: flipped.label,
        mark: flipped.mark,
        tickMs: Date.now() - started,
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const failures = launchShotForecastFailures(sample);
  const line = `launch shot forecast ${plan.id} plain ${JSON.stringify(sample?.plainSummary)} ${JSON.stringify(sample?.plainLabel)} forecast ${JSON.stringify(sample?.forecastSummary)} ${JSON.stringify(sample?.forecastLabel)} tick ${sample?.tickMs} mark ${sample?.mark}`;
  writeFileSync(resolve(evidenceDir, `launch-shot-forecast-${plan.id}.txt`), `${line}\n${JSON.stringify(sample)}\n${JSON.stringify(clock)}\n${failures.join('\n')}\n`);
  console.log(line);
  if (failures.length) throw new Error(['launch-shot-forecast fail', ...failures].join('\n'));
  return line;
}
