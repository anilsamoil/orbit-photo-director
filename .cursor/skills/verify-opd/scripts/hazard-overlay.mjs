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

const LABEL = 'Published hazard areas \u2014 not a flight path or navigation guidance';
const WHEN = Date.parse('2026-11-13T22:50:00Z');
const EVENT = '0f867f0c-5422-4d44-93b8-d7faaae7019b';
const SIZES = ['402x874', '874x402', '1024x768', '1180x820', '768x1024', '834x1210', '1440x900'];
const CONTROLS = [
  '#map-launch-coverage',
  '.map-toolbar',
  '.map-control-dock',
  '.map-controls-time',
  '#map-legend-toggle',
  '#map-legend-panel',
  '#map-chrome-toggle',
  '.maplibregl-ctrl-group',
];

const origin = process.env.OPD_VERIFY_ORIGIN || 'http://127.0.0.1:41731';
const probe = process.env.OPD_HAZARD_PROBE || 'layout';
const size = String(process.env.OPD_VERIFY_VIEWPORT || '').trim();
const home = process.env.OPD_VERIFY_HOME || '/tmp/opd-verify/default';
const evidence = resolve(home, 'evidence');
const artifacts = '/opt/cursor/artifacts';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!SIZES.includes(size)) fail(`OPD_VERIFY_VIEWPORT must be one of ${SIZES.join(', ')}`);
if (!['layout', 'popup', 'camera'].includes(probe)) fail('OPD_HAZARD_PROBE must be layout, popup, or camera');

const catalogPath = resolve(repo, 'frontend/test/fixtures/starship-catalog-2026-11-10.json');
const hazardPath = resolve(repo, `frontend/public/hazards/v1/${EVENT}.json`);

function catalogBody() {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  catalog.generated_at = new Date(WHEN - 60_000).toISOString();
  catalog.geometry_valid_until = new Date(WHEN + 10 * 60_000).toISOString();
  catalog.schedule_valid_until = new Date(WHEN + 60 * 60_000).toISOString();
  const text = JSON.stringify(catalog);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const pointer = {
    schema_version: 2,
    revision: catalog.revision,
    generated_at: catalog.generated_at,
    valid_until: catalog.geometry_valid_until,
    path: `launch/catalog/v/${catalog.revision}.json`,
    sha256,
  };
  return { text, pointer };
}

function manifestBody() {
  return {
    version: '20261113T225000Z',
    generated_at: new Date(WHEN - 30_000).toISOString(),
    tle_epoch: '2026-11-13T00:00:00Z',
    cloud_composite_hour: '2026-11-13T22:00:00Z',
    target_data_version: 'v1',
    build_version: '1.7.12.0',
    freshness: { tle_hours: 1, cloud_hours: 1, ok: true },
    artifacts: {
      passes: { path: 'v/browser/passes.json', sha256: '', bytes: 2 },
      top5: { path: 'v/browser/top5.json', sha256: '', bytes: 2 },
      track: { path: 'v/browser/track.json', sha256: '', bytes: 2 },
    },
  };
}

function trackBody() {
  return {
    iss_polynomial: {
      start: new Date(WHEN - 60_000).toISOString(),
      duration_seconds: 7200,
      lat_coeffs: [-0.01, 28],
      lon_coeffs: [0.012, -97],
      polynomial_order: 1,
    },
    track_points: [[0, 28, -97], [3600, 20, -80]],
    tle_epoch: '2026-11-13T00:00:00Z',
    tle_age_hours: 1,
    tle_freshness_factor: 1,
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

function nasaHost(hostname) {
  return hostname === 'nasa.gov' || hostname.endsWith('.nasa.gov');
}

function forbiddenHost(hostname) {
  return hostname === 'map.astroanil.dev' || hostname === 'map.expedition75.com' || nasaHost(hostname);
}

const stamped = catalogBody();
let hazardOverride = null;

function jsonRoute(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function arm(page) {
  await page.addInitScript((frozen) => {
    Date.now = () => frozen;
    localStorage.setItem('opd-map-chrome', 'shown');
  }, WHEN);
  await page.route('**/*', (route) => {
    let hostname = '';
    try { hostname = new URL(route.request().url()).hostname; } catch { return route.abort(); }
    if (forbiddenHost(hostname)) return route.abort();
    return route.fallback();
  });
  await page.route('**/api/browser/session', (route) => jsonRoute(route, {
    ok: true,
    profile: { name: 'anil', displayName: 'Anil' },
    profiles: [{ name: 'anil', displayName: 'Anil' }],
  }));
  await page.route('**/manifest.json', (route) => jsonRoute(route, manifestBody()));
  await page.route('**/v/browser/passes.json', (route) => jsonRoute(route, []));
  await page.route('**/v/browser/top5.json', (route) => jsonRoute(route, []));
  await page.route('**/v/browser/track.json', (route) => jsonRoute(route, trackBody()));
  await page.route('**/launch/catalog/latest.json', (route) => jsonRoute(route, stamped.pointer));
  await page.route('**/launch/catalog/v/**', (route) => jsonRoute(route, stamped.text));
  await page.route('**/launch/latest.json', (route) => jsonRoute(route, { error: 'not_found' }, 404));
  await page.route(`**/hazards/v1/${EVENT}.json`, (route) => {
    if (hazardOverride) return jsonRoute(route, hazardOverride.body, hazardOverride.status);
    return route.fallback();
  });
}

async function openLaunches(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${origin}/?e2e&u=anil`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__opdMap && window.__opdMap.isStyleLoaded(), null, { timeout: 30_000 });
  const launches = page.locator('#filter-launches-map');
  if (await launches.getAttribute('aria-pressed') !== 'true') await launches.click();
  return errors;
}

async function waitForCaption(page) {
  await page.waitForFunction((label) => {
    const caption = document.getElementById('launch-hazard-caption');
    return caption && caption.hidden === false && caption.textContent === label;
  }, LABEL, { timeout: 20_000 });
}

function layoutProbe(selectors) {
  const caption = document.getElementById('launch-hazard-caption');
  const range = document.createRange();
  range.selectNodeContents(caption);
  const boxes = [...range.getClientRects()].map((box) => ({
    left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
  }));
  const controls = [];
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') continue;
      const box = node.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      controls.push({ selector, left: box.left, top: box.top, right: box.right, bottom: box.bottom });
    }
  }
  const hits = [];
  for (const text of boxes) {
    for (const control of controls) {
      const overlaps = text.right > control.left + 0.5 && text.left < control.right - 0.5
        && text.bottom > control.top + 0.5 && text.top < control.bottom - 0.5;
      if (overlaps) hits.push(control.selector);
    }
  }
  const map = window.__opdMap;
  const source = map.getSource('launch-hazards');
  const data = source && (source._data.geojson || source._data);
  const features = data?.features ?? [];
  const lineStrings = features.filter((feature) => feature.geometry?.type === 'LineString').length;
  const vertices = {};
  for (const feature of features) {
    const ring = feature.geometry?.type === 'Polygon' ? feature.geometry.coordinates[0] : [];
    vertices[feature.properties?.area_id] = Array.isArray(ring) ? Math.max(0, ring.length - 1) : 0;
  }
  const card = document.getElementById('map-launch-coverage');
  for (const details of card ? card.querySelectorAll('details') : []) details.open = true;
  const note = card?.querySelector('[data-hazard-note]');
  if (note && card) note.scrollIntoView({ block: 'nearest' });
  const noteBox = note?.getBoundingClientRect();
  const cardBox = card?.getBoundingClientRect();
  const noteReachable = !!(note && card && noteBox && cardBox && noteBox.height > 0
    && noteBox.bottom > cardBox.top + 0.5 && noteBox.top < cardBox.bottom - 0.5);
  const panels = controls.map((control) => control);
  const canvas = map.getCanvas().getBoundingClientRect();
  const covered = (point) => panels.some((panel) => (
    point.x > panel.left + 0.5 && point.x < panel.right - 0.5
    && point.y > panel.top + 0.5 && point.y < panel.bottom - 0.5
  ));
  const areas = {};
  for (const feature of features) {
    const ring = feature.geometry?.coordinates?.[0] ?? [];
    const samples = ring.map(([lon, lat]) => map.project([lon, lat]));
    let lon = 0;
    let lat = 0;
    for (const position of ring) {
      lon += position[0];
      lat += position[1];
    }
    if (ring.length) samples.push(map.project([lon / ring.length, lat / ring.length]));
    areas[feature.properties?.area_id] = samples.filter((point) => (
      point.x >= canvas.left && point.x <= canvas.right && point.y >= canvas.top && point.y <= canvas.bottom && !covered(point)
    )).length;
  }
  const center = map.getCenter();
  return {
    text: caption.textContent,
    hidden: caption.hidden,
    lines: boxes.length,
    hits: [...new Set(hits)],
    legend: !!document.getElementById('map-legend-toggle'),
    coverage: !!document.getElementById('map-launch-coverage'),
    lineStrings,
    vertices,
    polygons: features.length,
    tbc: (card?.textContent ?? '').includes('TBC · Tentative'),
    note: note?.textContent ?? '',
    noteReachable,
    areas,
    bearing: map.getBearing(),
    zoom: map.getZoom(),
    lng: center.lng,
    lat: center.lat,
  };
}

async function shot(page, name) {
  mkdirSync(evidence, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const file = resolve(artifacts, name);
  await page.screenshot({ path: file, fullPage: false });
  await page.screenshot({ path: resolve(evidence, name), fullPage: false });
  return file;
}

function cameraOf(page) {
  return page.evaluate(() => {
    const map = window.__opdMap;
    const center = map.getCenter();
    return { lng: center.lng, lat: center.lat, zoom: map.getZoom(), bearing: map.getBearing() };
  });
}

function sameCamera(left, right) {
  const close = (a, b) => Math.abs(a - b) < 1e-6;
  return close(left.lng, right.lng) && close(left.lat, right.lat)
    && close(left.zoom, right.zoom) && close(left.bearing, right.bearing);
}

async function layoutPass(page) {
  const errors = await openLaunches(page);
  await waitForCaption(page);
  const follow = page.locator('#toggle-follow-iss');
  if ((await follow.getAttribute('class'))?.includes('active')) await follow.click();
  await page.evaluate(() => {
    for (const details of document.querySelectorAll('#map-launch-coverage details')) details.open = true;
    window.__opdMap.setBearing(143.26);
  });
  const show = page.locator('#map-launch-coverage .launch-brief-actions .btn').first();
  if (await show.count()) await show.click();
  await page.waitForTimeout(1200);
  const measured = await page.evaluate(layoutProbe, CONTROLS);
  const ignored = errors.filter((error) => !error.includes('nasa.gov') && !error.includes('gibs.earthdata'));
  const problems = [];
  if (measured.text !== LABEL) problems.push(`label ${JSON.stringify(measured.text)}`);
  if (measured.hidden) problems.push('caption hidden');
  if (size === '874x402' && measured.lines !== 2) problems.push(`lines ${measured.lines}`);
  if (measured.hits.length) problems.push(`hits ${measured.hits.join(',')}`);
  if (!measured.legend || !measured.coverage) problems.push('missing legend or coverage');
  if (measured.lineStrings !== 0) problems.push(`linestrings ${measured.lineStrings}`);
  if (measured.polygons !== 3) problems.push(`polygons ${measured.polygons}`);
  if (measured.vertices.A !== 30 || measured.vertices.B !== 16 || measured.vertices['6/7129'] !== 6) {
    problems.push(`vertices ${JSON.stringify(measured.vertices)}`);
  }
  if (!measured.tbc) problems.push('missing TBC pin card');
  if (!measured.note.includes('NAVAREA IV 1080/26') || !measured.note.includes('SFC-UNL')) problems.push('notice facts missing');
  if (!measured.noteReachable) problems.push('notice facts not reachable');
  for (const id of ['A', 'B', '6/7129']) {
    if (!Number.isFinite(measured.areas?.[id]) || measured.areas[id] < 1) problems.push(`area ${id} covered`);
  }
  if (ignored.length) problems.push(ignored[0]);
  const file = await shot(page, `hazard-layout-${size}.png`);
  const report = { probe, size, measured, problems, file };
  writeFileSync(resolve(artifacts, `hazard-layout-${size}.json`), JSON.stringify(report, null, 2));
  if (problems.length) fail(`hazard layout ${size}: ${problems.join('; ')}`);
  console.log(`hazard layout ${size} lines ${measured.lines} hits 0 polygons 3 linestrings 0 vertices 30/16/6 tbc 1 note reachable tfr ${measured.areas['6/7129']}`);
}

function withSecondAreaA(body) {
  const copy = JSON.parse(JSON.stringify(body));
  const notice = copy.notices.find((item) => item.area_id === 'A');
  const feature = copy.geojson.features.find((item) => item.properties.area_id === 'A');
  copy.notices.push({ ...notice, notice_id: 'HYDROPAC 999/26' });
  copy.geojson.features.push({
    ...feature,
    id: 'HYDROPAC 999/26\u0000A',
    properties: { ...feature.properties, notice_id: 'HYDROPAC 999/26' },
  });
  return copy;
}

async function popupPass(page) {
  const published = JSON.parse(readFileSync(hazardPath, 'utf8'));
  hazardOverride = { status: 200, body: withSecondAreaA(published) };
  await openLaunches(page);
  await waitForCaption(page);
  const follow = page.locator('#toggle-follow-iss');
  if ((await follow.getAttribute('class'))?.includes('active')) await follow.click();
  const show = page.locator('#map-launch-coverage .launch-brief-actions .btn').first();
  if (await show.count()) await show.click();
  await page.waitForFunction(() => window.__opdMap && window.__opdMap.loaded() && !window.__opdMap.isMoving(), null, { timeout: 15_000 });
  const click = await page.evaluate(() => {
    const map = window.__opdMap;
    const canvas = map.getCanvas().getBoundingClientRect();
    const blocked = (x, y) => [...document.querySelectorAll('#map-launch-coverage, .map-toolbar, .map-control-dock, .map-controls-time, #map-legend-toggle, #map-chrome-toggle')]
      .some((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 1 && box.height > 1 && x > box.left && x < box.right && y > box.top && y < box.bottom;
      });
    for (let y = canvas.top + 4; y < canvas.bottom; y += 12) {
      for (let x = canvas.left + 4; x < canvas.right; x += 12) {
        if (blocked(x, y)) continue;
        const hits = map.queryRenderedFeatures([x - canvas.left, y - canvas.top], { layers: ['launch-hazard-fill-layer'] });
        const areas = hits.filter((hit) => hit.properties?.area_id === 'A');
        const notices = new Set(areas.map((hit) => hit.properties?.notice_id));
        if (notices.has('NAVAREA IV 1080/26') && notices.has('HYDROPAC 999/26')) return { x, y };
      }
    }
    return null;
  });
  if (!click) {
    const debug = await page.evaluate(() => {
      const map = window.__opdMap;
      const source = map.getSource('launch-hazards');
      const data = source && (source._data.geojson || source._data);
      const ids = (data?.features ?? []).map((feature) => `${feature.properties?.notice_id}|${feature.properties?.area_id}`);
      const canvas = map.getCanvas().getBoundingClientRect();
      const point = map.project([-97.2, 26]);
      const boxHits = map.queryRenderedFeatures([[0, 0], [canvas.width, canvas.height]], { layers: ['launch-hazard-fill-layer'] });
      return {
        ids,
        visibility: map.getLayoutProperty('launch-hazard-fill-layer', 'visibility'),
        point,
        box: boxHits.length,
        notices: boxHits.map((hit) => `${hit.properties?.notice_id}/${hit.properties?.area_id}`),
        canvas: { w: canvas.width, h: canvas.height },
      };
    });
    fail(`no clear point hits both area A notices ${JSON.stringify(debug)}`);
  }
  await page.mouse.click(click.x, click.y);
  await page.waitForFunction(() => {
    const popup = document.querySelector('.maplibregl-popup');
    return popup && popup.textContent.includes('NAVAREA IV 1080/26 area A') && popup.textContent.includes('HYDROPAC 999/26 area A');
  }, null, { timeout: 10_000 });
  const amended = withSecondAreaA(published);
  amended.checked_at = '2026-11-13T23:00:00Z';
  hazardOverride = { status: 200, body: amended };
  const direct = await page.evaluate(async () => {
    const mod = await import('/src/map/features/launch-corridor/index.ts');
    await mod.reloadLaunchHazards();
    const popup = document.querySelector('.maplibregl-popup');
    return {
      open: !!popup,
      text: popup?.textContent ?? '',
    };
  });
  const kept = await page.evaluate(async () => {
    const main = await import('/src/main.ts');
    await main.refresh();
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    const popup = document.querySelector('.maplibregl-popup');
    return { open: !!popup, text: popup?.textContent ?? '' };
  });
  hazardOverride = { status: 404, body: { error: 'missing' } };
  const withdrawn = await page.evaluate(async () => {
    const cat = await import('/src/launch-catalog.ts');
    await cat.launchCatalog.refresh();
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    const popup = document.querySelector('.maplibregl-popup');
    return { open: !!popup };
  });
  await shot(page, `hazard-popup-${size}.png`);
  const directRewrite = direct.open
    && direct.text.includes('Checked 2026-11-13T23:00:00Z')
    && direct.text.includes('NAVAREA IV 1080/26 area A')
    && direct.text.includes('HYDROPAC 999/26 area A')
    && !direct.text.includes('Checked 2026-11-13T10:02:00Z');
  const keptOpen = kept.open
    && kept.text.includes('NAVAREA IV 1080/26 area A')
    && kept.text.includes('HYDROPAC 999/26 area A');
  const report = { probe, size, direct, kept, withdrawn, directRewrite, keptOpen };
  writeFileSync(resolve(artifacts, `hazard-popup-${size}.json`), JSON.stringify(report, null, 2));
  if (!directRewrite) fail(`hazard popup direct reload did not rewrite ${size}: ${JSON.stringify(direct)}`);
  if (!keptOpen) fail(`hazard popup catalog refresh closed a popup whose notices were still painted ${size}`);
  if (withdrawn.open) fail(`hazard popup stayed open after the catalog refresh withdrew the file ${size}`);
  console.log(`hazard popup ${size} direct rewrite catalog kept open withdrawn closed`);
}

async function gesture(page, kind) {
  hazardOverride = { status: 200, body: readFileSync(hazardPath, 'utf8') };
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  await page.unroute(`**/hazards/v1/${EVENT}.json`);
  await page.route(`**/hazards/v1/${EVENT}.json`, async (route) => {
    await gate;
    return jsonRoute(route, hazardOverride.body, 200);
  });
  await openLaunches(page);
  const follow = page.locator('#toggle-follow-iss');
  if ((await follow.getAttribute('class'))?.includes('active')) await follow.click();
  const north = page.locator('#bearing-north');
  if (await north.count()) await north.click();
  await page.waitForFunction(() => window.__opdMap && !window.__opdMap.isMoving(), null, { timeout: 10_000 });
  const button = page.locator('#map-launch-coverage .launch-brief-actions .btn', { hasText: 'Show launch site' });
  await button.first().waitFor({ timeout: 15_000 });
  await button.first().click();
  const canvas = page.locator('#map canvas');
  const box = await canvas.boundingBox();
  if (!box) fail('map canvas has no box');
  if (kind === 'wheel') {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
  } else {
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await page.keyboard.press('ArrowRight');
  }
  await page.waitForTimeout(300);
  const held = await cameraOf(page);
  release();
  await waitForCaption(page);
  await page.waitForTimeout(400);
  const after = await cameraOf(page);
  if (!sameCamera(held, after)) {
    fail(`hazard camera ${kind} ${size} moved ${JSON.stringify({ held, after })}`);
  }
  return { kind, held, after };
}

const browser = await launchWebkit();
try {
  const context = await browser.newContext(contextOptions(size));
  const page = await context.newPage();
  await arm(page);
  if (probe === 'layout') await layoutPass(page);
  else if (probe === 'popup') await popupPass(page);
  else {
    const wheel = await gesture(page, 'wheel');
    const next = await browser.newContext(contextOptions(size));
    const arrowPage = await next.newPage();
    hazardOverride = { status: 200, body: readFileSync(hazardPath, 'utf8') };
    await arm(arrowPage);
    const arrow = await gesture(arrowPage, 'arrow');
    await shot(arrowPage, `hazard-camera-${size}.png`);
    const report = { probe, size, wheel, arrow };
    writeFileSync(resolve(artifacts, `hazard-camera-${size}.json`), JSON.stringify(report, null, 2));
    console.log(`hazard camera ${size} wheel unchanged arrow unchanged`);
    await next.close();
  }
  if (probe !== 'camera') await context.close();
} finally {
  await browser.close();
}
