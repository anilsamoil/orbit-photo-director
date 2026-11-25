#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchWebkit } from './webkit-devices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const require = createRequire(resolve(repo, 'frontend/package.json'));
const { devices } = require('playwright');

const WHEN = Date.parse('2026-11-16T12:00:00Z');
const SIZES = ['402x874', '874x402', '1024x768', '1180x820', '834x1210', '1440x900'];
const CONTROLS = [
  '#map-chrome-toggle',
  '#map-legend-toggle',
  '.maplibregl-ctrl-zoom-in',
  '.maplibregl-ctrl-zoom-out',
  '.maplibregl-ctrl-compass',
  '.map-controls-time',
  '#toggle-satellite-picker',
];
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQzlv1HwAELgI7OfS9ngAAAABJRU5ErkJggg==', 'base64');

const origin = process.env.OPD_VERIFY_ORIGIN || 'http://127.0.0.1:41731';
const size = String(process.env.OPD_VERIFY_VIEWPORT || '').trim();
const home = process.env.OPD_VERIFY_HOME || '/tmp/opd-verify/default';
const evidence = resolve(home, 'evidence');
const artifacts = '/opt/cursor/artifacts';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!SIZES.includes(size)) fail(`OPD_VERIFY_VIEWPORT must be one of ${SIZES.join(', ')}`);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function agedShip() {
  const text = readFileSync(resolve(repo, 'frontend/test/fixtures/celestrak-starship-fictional.txt'), 'utf8');
  const rows = text.split('\n');
  const at = rows.indexOf('SHIP 91');
  const line1 = rows[at + 1];
  const line2 = rows[at + 2];
  const aged = `${line1.slice(0, 18)}26${(320.5 - 13 / 24).toFixed(8)}${line1.slice(32)}`;
  return { name: 'SHIP 91', line1: aged, line2 };
}

function issTle() {
  const fixture = JSON.parse(readFileSync(resolve(repo, 'frontend/test/fixtures/iss-sgp4-fixture.json'), 'utf8'));
  return fixture.tle;
}

const ship = agedShip();
const iss = issTle();

function trackedBody() {
  return {
    objects: [{
      id: 'starship',
      label: 'Starship',
      color: '#ff5c5c',
      state: 'elements',
      source: 'supgp',
      name: ship.name,
      norad: Number(ship.line1.slice(2, 7)),
      intldes: ship.line1.slice(9, 17).trim(),
      line1: ship.line1,
      line2: ship.line2,
      epoch: '2026-11-15T23:00:00Z',
      age_hours: 13,
      lookup: {
        names: ['STARSHIP', 'SHIP'],
        patterns: ['^STARSHIP(?:[\\s-]|$)(?!.*\\bDEB\\b)', '^SHIP[\\s-]+\\d+\\b(?!.*\\bDEB\\b)'],
        max_age_hours: 12,
        grace_hours: 72,
      },
    }],
  };
}

function trackBody() {
  return {
    iss_polynomial: {
      start: new Date(WHEN - 60_000).toISOString(),
      duration_seconds: 7200,
      lat_coeffs: [25],
      lon_coeffs: [-80],
      polynomial_order: 0,
    },
    track_points: [[0, 25, -80], [3600, 20, -70]],
    tle: iss,
    tle_epoch: '2024-10-16T18:58:12Z',
    tle_age_hours: 1,
    tle_freshness_factor: 1,
  };
}

function manifestFor(trackText, trackedText) {
  const trackSha = sha256(trackText);
  const trackedSha = sha256(trackedText);
  return {
    version: '20261116T120000Z',
    generated_at: new Date(WHEN - 30_000).toISOString(),
    tle_epoch: '2024-10-16T18:58:12Z',
    cloud_composite_hour: '2026-11-16T12:00:00Z',
    target_data_version: 'v1',
    build_version: 'verify',
    freshness: { tle_hours: 1, cloud_hours: 1, ok: true },
    artifacts: {
      passes: { path: 'v/browser/passes.json', sha256: sha256('[]'), bytes: 2 },
      top5: { path: 'v/browser/top5.json', sha256: sha256('[]'), bytes: 2 },
      track: { path: `v/verify/${trackSha}/track.json`, sha256: trackSha, bytes: Buffer.byteLength(trackText) },
      tracked: { path: `v/verify/${trackedSha}/tracked.json`, sha256: trackedSha, bytes: Buffer.byteLength(trackedText) },
    },
  };
}

function contextOptions(token) {
  const [width, height] = token.split('x').map(Number);
  const desktop = token === '1440x900';
  const phone = token === '402x874' || token === '874x402';
  const baseName = desktop ? 'Desktop Safari' : phone ? 'iPhone 13' : 'iPad Pro 11';
  const base = devices[baseName];
  if (!base) fail(`Playwright has no ${baseName} device`);
  return {
    ...base,
    viewport: { width, height },
    screen: { width, height },
    deviceScaleFactor: desktop ? 1 : phone ? 3 : 2,
    isMobile: !desktop,
    hasTouch: !desktop,
  };
}

function json(route, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return route.fulfill({ status: 200, contentType: 'application/json', body: text });
}

const trackText = JSON.stringify(trackBody());
const trackedText = JSON.stringify(trackedBody());
const manifest = manifestFor(trackText, trackedText);

function probe(controlSelectors) {
  const boxes = (selector) => [...document.querySelectorAll(selector)].flatMap((node) => {
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return [];
    const box = node.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return [];
    return [{ selector, left: box.left, top: box.top, right: box.right, bottom: box.bottom }];
  });
  const controls = controlSelectors.flatMap((selector) => boxes(selector));
  const stale = [...document.querySelectorAll('.sat-stale, #satellite-picker-notes .sat-row-note')]
    .filter((node) => (node.textContent || '').includes('stale orbit'));
  const hits = [];
  for (const node of stale) {
    const box = node.getBoundingClientRect();
    for (const control of controls) {
      const overlaps = box.right > control.left + 0.5 && box.left < control.right - 0.5
        && box.bottom > control.top + 0.5 && box.top < control.bottom - 0.5;
      if (overlaps) hits.push(control.selector);
    }
  }
  const view = { width: window.innerWidth, height: window.innerHeight };
  const inside = (node) => {
    const box = node.getBoundingClientRect();
    return box.width > 1 && box.height > 1 && box.right > 0 && box.bottom > 0
      && box.left < view.width && box.top < view.height;
  };
  const note = [...document.querySelectorAll('#satellite-picker-notes .sat-row-note')]
    .map((node) => node.textContent || '')
    .find((text) => text.includes('stale orbit, epoch')) || '';
  const rect = (node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  };
  return {
    iss: [...document.querySelectorAll('.iss-marker')].filter(inside).length,
    starship: [...document.querySelectorAll('.tracked-marker')].filter(inside).length,
    issRect: [...document.querySelectorAll('.iss-marker')].map(rect),
    starRect: [...document.querySelectorAll('.tracked-marker')].map(rect),
    zoom: window.__opdMap.getZoom(),
    badge: document.querySelector('.sat-stale')?.textContent || '',
    note,
    hits: [...new Set(hits)],
    layers: window.__opdMap.getStyle().layers.map((layer) => layer.id).filter((id) => id.includes('starship')),
  };
}

const browser = await launchWebkit();
try {
  const context = await browser.newContext(contextOptions(size));
  const host = new URL(origin).host;
  await context.route('**/*', (route) => {
    let url;
    try { url = new URL(route.request().url()); } catch { return route.abort(); }
    if (url.host === host) return route.fallback();
    const type = route.request().resourceType();
    if (type === 'image' || /\/tile\/|\/wmts\//.test(url.pathname)) {
      return route.fulfill({ contentType: 'image/png', body: TILE });
    }
    return route.abort();
  });
  await context.route('**/manifest.json', (route) => json(route, manifest));
  await context.route('**/passes.json', (route) => json(route, []));
  await context.route('**/top5.json', (route) => json(route, []));
  await context.route('**/track.json', (route) => json(route, trackText));
  await context.route('**/tracked.json', (route) => json(route, trackedText));
  await context.route('**/api/browser/session', (route) => json(route, {
    ok: true,
    profile: { name: 'anil', displayName: 'Anil' },
    profiles: [{ name: 'anil', displayName: 'Anil' }],
  }));
  const page = await context.newPage();
  await page.addInitScript((frozen) => {
    Date.now = () => frozen;
    localStorage.setItem('opd-map-chrome', 'shown');
  }, WHEN);
  await page.goto(`${origin}/?e2e&u=anil`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__opdMap && window.__opdMap.isStyleLoaded(), null, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('.iss-marker') && document.querySelector('.tracked-marker'), null, { timeout: 20_000 });
  const follow = page.locator('#toggle-follow-iss');
  if ((await follow.getAttribute('class'))?.includes('active')) await follow.click();
  await page.evaluate(() => {
    window.__opdMap.fitBounds([[-90, -30], [-75, 30]], { padding: 24, duration: 0, maxZoom: 2 });
  });
  await page.waitForTimeout(400);
  const picker = page.locator('#toggle-satellite-picker');
  if (await picker.count()) await picker.click();
  await page.waitForFunction(() => {
    const note = document.querySelector('#satellite-picker-notes .sat-row-note');
    return note && note.textContent.includes('stale orbit, epoch 13 h old');
  }, null, { timeout: 10_000 });
  const measured = await page.evaluate(probe, CONTROLS);
  mkdirSync(evidence, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const file = `starship-orbit-${size}.png`;
  await page.screenshot({ path: resolve(artifacts, file) });
  await page.screenshot({ path: resolve(evidence, file) });
  writeFileSync(resolve(artifacts, `starship-orbit-${size}.json`), JSON.stringify(measured, null, 2));
  const problems = [];
  if (measured.iss < 1) problems.push('iss marker missing');
  if (measured.starship < 1) problems.push('starship marker missing');
  if (measured.badge !== 'stale orbit') problems.push(`badge ${measured.badge}`);
  if (!measured.note.includes('stale orbit, epoch 13 h old')) problems.push(`note ${measured.note}`);
  if (measured.hits.length) problems.push(`hits ${measured.hits.join(',')}`);
  if (!measured.layers.some((id) => id.includes('starship'))) problems.push('no starship layer');
  if (problems.length) fail(`starship orbit ${size}: ${problems.join('; ')} ${JSON.stringify(measured)}`);
  console.log(`starship orbit ${size} iss 1 starship 1 stale "stale orbit, epoch 13 h old" hits 0`);
  await context.close();
} finally {
  await browser.close();
}
