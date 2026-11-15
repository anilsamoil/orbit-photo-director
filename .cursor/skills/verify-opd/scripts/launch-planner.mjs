#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolateSnapRequests } from './context-state-fixture.mjs';
import { launchWebkit } from './webkit-devices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const require = createRequire(resolve(repo, 'frontend/package.json'));
const { devices } = require('playwright');

const WHEN = Date.parse('2026-11-14T23:40:00Z');
const EVENT = 'fixture-iss-cape';
const SIZES = ['402x874', '874x402', '1024x768', '1180x820', '768x1024', '834x1210', '1440x900'];
const TOGGLE_SIZES = ['402x874', '874x402', '1024x768', '1440x900'];
const MODELED = 'ef9850ad-1096-425b-9d27-f7bbd186e61a';
const OTHER = 'fixture-baikonur';
const SECTOR = 'fixture-starbase';
const CRS = 'fixture-iss-cape';
const SITE = 'fixture-unknown';
const HAZARD = '0f867f0c-5422-4d44-93b8-d7faaae7019b';
const probeName = process.env.OPD_LAUNCH_PLANNER_PROBE || 'card';

const origin = process.env.OPD_VERIFY_ORIGIN || 'http://127.0.0.1:41731';
const size = String(process.env.OPD_VERIFY_VIEWPORT || '').trim();
const home = process.env.OPD_VERIFY_HOME || '/tmp/opd-verify/default';
const evidence = resolve(home, 'evidence');
const artifacts = '/opt/cursor/artifacts';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (probeName !== 'card' && probeName !== 'toggle') fail('OPD_LAUNCH_PLANNER_PROBE must be card or toggle');
if (probeName === 'card' && !SIZES.includes(size)) fail(`OPD_VERIFY_VIEWPORT must be one of ${SIZES.join(', ')}`);
if (probeName === 'toggle' && !TOGGLE_SIZES.includes(size)) fail(`OPD_VERIFY_VIEWPORT must be one of ${TOGGLE_SIZES.join(', ')}`);

function tiedBody() {
  const catalog = JSON.parse(readFileSync(resolve(repo, 'frontend/test/fixtures/launch-planner-tied-catalog.json'), 'utf8'));
  const item = catalog.items.find((entry) => entry.event_id === EVENT);
  if (!item) fail(`missing ${EVENT}`);
  catalog.items = [item];
  catalog.coverage.received = 1;
  catalog.coverage.listed = 1;
  catalog.coverage.evaluated = 1;
  catalog.coverage.tier_counts = { shot: 0, likely: 1, watch: 0, unassessed: 0, none: 0 };
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
    version: '20261114T234000Z',
    generated_at: new Date(WHEN - 30_000).toISOString(),
    tle_epoch: '2026-11-14T07:16:30Z',
    cloud_composite_hour: '2026-11-14T23:00:00Z',
    target_data_version: 'v1',
    build_version: 'verify',
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
      lat_coeffs: [28],
      lon_coeffs: [-80],
      polynomial_order: 0,
    },
    track_points: [[0, 28, -80], [3600, 30, -75]],
    tle_epoch: '2026-11-14T07:16:30Z',
    tle_age_hours: 16,
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

function jsonRoute(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const stamped = tiedBody();

function probe() {
  const lineCoords = (feature) => (feature.geometry?.type === 'LineString' ? feature.geometry.coordinates : []);
  const overlapBox = (a, b) => {
    if (!a || !b) return null;
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (width <= 0.5 || height <= 0.5) return null;
    return { width: Math.round(width * 10) / 10, height: Math.round(height * 10) / 10 };
  };
  const card = document.querySelector('#map-launch-coverage article.launch-tier');
  const fact = (label) => {
    const row = [...(card?.querySelectorAll('.launch-fact') ?? [])].find((line) => (
      line.querySelector('.launch-fact-label')?.textContent === label
    ));
    return row?.querySelector('span:last-child')?.textContent ?? '';
  };
  const map = window.__opdMap;
  const source = map.getSource('ascent-trajectory');
  const raw = source && (source._data?.geojson || source._data?.data || source._data);
  const features = raw?.features ?? [];
  const ofRole = (role) => features.filter((feature) => feature.properties?.role === role);
  const lats = (role) => ofRole(role).flatMap((feature) => lineCoords(feature).map((pair) => pair[1]));
  const branches = (role) => [...new Set(ofRole(role).map((feature) => feature.properties?.branch).filter(Boolean))];
  const canvas = map.getCanvas().getBoundingClientRect();
  const rendered = map.queryRenderedFeatures([[0, 0], [canvas.width, canvas.height]], { layers: ['ascent-trajectory-layer'] });
  const caption = document.getElementById('launch-ascent-caption');
  const coverage = document.getElementById('map-launch-coverage');
  const captionBox = caption ? caption.getBoundingClientRect() : null;
  const cardBox = coverage ? coverage.getBoundingClientRect() : null;
  const box = (rect) => rect && {
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
  };
  const corridorLats = lats('corridor');
  return {
    tier: card?.dataset.tier ?? '',
    eventId: card?.dataset.eventId ?? '',
    direction: fact('Launch direction'),
    look: fact('Stand and look'),
    title: card?.querySelector('[data-shot-plan="title"]')?.textContent ?? '',
    why: card?.querySelector('p')?.textContent ?? '',
    branches: branches('model'),
    edgeBranches: branches('edge'),
    corridorCount: ofRole('corridor').length,
    corridorMin: corridorLats.length ? Math.min(...corridorLats) : null,
    corridorMax: corridorLats.length ? Math.max(...corridorLats) : null,
    renderedCorridor: rendered.filter((feature) => feature.properties?.role === 'corridor').length,
    renderedModel: rendered.filter((feature) => feature.properties?.role === 'model').length,
    caption: caption?.textContent ?? '',
    captionHidden: caption ? caption.hidden : true,
    captionBox: box(captionBox),
    cardBox: box(cardBox),
    overlap: overlapBox(captionBox, cardBox),
  };
}

function scheduleAt(net, start, end) {
  return { destination: null, net, precision: 'Second', status: 'Go', window_start: start, window_end: end };
}

function toggleCatalog() {
  const catalog = JSON.parse(readFileSync(resolve(repo, 'frontend/test/fixtures/launch-planner-tied-catalog.json'), 'utf8'));
  const starshipCatalog = JSON.parse(readFileSync(resolve(repo, 'frontend/test/fixtures/starship-catalog-2026-11-10.json'), 'utf8'));
  const take = (id) => {
    const item = catalog.items.find((entry) => entry.event_id === id);
    if (!item) fail(`missing ${id}`);
    return structuredClone(item);
  };
  const dropAscent = (item) => {
    delete item.ascent;
    return item;
  };
  const vulcan = take(MODELED);
  vulcan.shots = [];
  vulcan.tier = 'watch';
  vulcan.schedule = scheduleAt('2026-11-14T23:46:00Z', '2026-11-14T23:45:00Z', '2026-11-14T23:59:00Z');
  const other = take(OTHER);
  other.shots = [];
  other.tier = 'watch';
  other.schedule = scheduleAt('2026-11-14T23:52:00Z', '2026-11-14T23:50:00Z', '2026-11-14T23:59:00Z');
  const sector = take(SECTOR);
  sector.shots = [];
  sector.tier = 'watch';
  sector.schedule = scheduleAt('2026-11-15T00:05:00Z', '2026-11-15T00:00:00Z', '2026-11-15T00:20:00Z');
  const crs = dropAscent(take(CRS));
  crs.tier = 'watch';
  crs.name = 'Falcon 9 Block 5 | Dragon CRS-2 SpX-35';
  crs.direction = { kind: 'iss_plane', azimuth_deg: 44.7, source: 'iss_tle_plane', off_plane_deg: 0.35 };
  const ascentShot = crs.shots.find((shot) => shot.subject === 'ascent' && shot.track.length >= 2);
  if (!ascentShot) fail('missing CRS corridor track');
  ascentShot.direction = { kind: 'iss_plane', azimuth_deg: 44.7, source: 'iss_tle_plane', off_plane_deg: 0.35 };
  crs.shots = [ascentShot];
  crs.schedule = scheduleAt('2026-11-15T00:12:00Z', '2026-11-15T00:10:00Z', '2026-11-15T00:30:00Z');
  const site = dropAscent(take(SITE));
  site.shots = [];
  site.tier = 'watch';
  site.name = 'Site only';
  site.direction = { kind: 'none', azimuth_deg: null, source: null, off_plane_deg: null };
  site.schedule = scheduleAt('2026-11-15T00:18:00Z', '2026-11-15T00:15:00Z', '2026-11-15T00:30:00Z');
  const hazardItem = starshipCatalog.items.find((entry) => entry.event_id === HAZARD);
  if (!hazardItem) fail('missing hazard launch');
  const hazard = dropAscent(structuredClone(hazardItem));
  hazard.shots = [];
  hazard.tier = 'watch';
  hazard.direction = { kind: 'none', azimuth_deg: null, source: null, off_plane_deg: null };
  hazard.schedule = scheduleAt('2026-11-15T00:25:00Z', '2026-11-14T23:45:00Z', '2026-11-15T00:39:00Z');
  catalog.items = [vulcan, other, sector, crs, site, hazard];
  catalog.coverage.received = catalog.items.length;
  catalog.coverage.listed = catalog.items.length;
  catalog.coverage.evaluated = catalog.items.length;
  catalog.coverage.tier_counts = { shot: 0, likely: 0, watch: catalog.items.length, unassessed: 0, none: 0 };
  return catalog;
}

function toggleBody() {
  const catalog = toggleCatalog();
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

function assertToggleCatalog(text) {
  const file = resolve(artifacts, 'launch-brief-toggle-catalog.json');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(file, text);
  const bun = existsSync(resolve(process.env.HOME || '', '.bun/bin/bun'))
    ? resolve(process.env.HOME || '', '.bun/bin/bun')
    : 'bun';
  const result = spawnSync(bun, ['-e', `
    import { readFileSync } from 'node:fs';
    import { parseLaunchArtifact } from './src/launch-schema.ts';
    parseLaunchArtifact(JSON.parse(readFileSync(process.env.TOGGLE_CATALOG, 'utf8')));
    console.log('toggle catalog parsed');
  `], {
    cwd: resolve(repo, 'frontend'),
    encoding: 'utf8',
    env: { ...process.env, TOGGLE_CATALOG: file },
  });
  if (result.status !== 0) fail(result.stderr || result.stdout || 'toggle catalog rejected');
}

const toggleIds = { modeled: MODELED, other: OTHER, sector: SECTOR, crs: CRS, site: SITE, hazard: HAZARD };

function toggleBoard(ids) {
  const buttonOf = (id) => document.querySelector(`#map-launch-coverage [data-event-id="${id}"] .launch-brief-actions button`);
  const describe = (id) => {
    const button = buttonOf(id);
    if (!button) return null;
    return {
      text: button.textContent,
      pressed: button.hasAttribute('aria-pressed') ? button.getAttribute('aria-pressed') : null,
    };
  };
  const primary = document.querySelector('#map-launch-coverage .map-launch-primary');
  const summary = primary?.querySelector('summary') ?? null;
  const map = window.__opdMap;
  const style = map.getStyle();
  const source = map.getSource('ascent-trajectory');
  const raw = source && (source._data?.geojson || source._data?.data || source._data);
  const features = raw?.features ?? [];
  const keyOf = (feature) => {
    const coords = feature.geometry?.type === 'LineString' ? feature.geometry.coordinates : [];
    const flat = coords.map((pair) => `${Number(pair[0]).toFixed(4)},${Number(pair[1]).toFixed(4)}`).join(';');
    return `${feature.id ?? ''}|${feature.properties?.event_id ?? ''}|${feature.properties?.role ?? ''}|${flat}`;
  };
  const caption = document.getElementById('launch-ascent-caption');
  const pane = document.getElementById('map-pane');
  const brief = document.getElementById('map-launch-coverage');
  return {
    summary: summary?.textContent ?? '',
    open: !!primary?.open,
    summaryFocused: document.activeElement === summary,
    focusVisible: !!(summary && summary.matches(':focus-visible')),
    caption: caption?.textContent ?? '',
    captionHidden: caption ? caption.hidden : true,
    popup: !!document.querySelector('.maplibregl-popup'),
    sources: Object.keys(style.sources).sort(),
    layers: style.layers.map((layer) => layer.id),
    featureIds: features.map((feature) => feature.id ?? null),
    featureKeys: features.map(keyOf),
    scroll: {
      y: window.scrollY,
      top: document.scrollingElement ? document.scrollingElement.scrollTop : 0,
      pane: pane ? pane.scrollTop : 0,
      brief: brief ? brief.scrollTop : 0,
    },
    buttons: {
      modeled: describe(ids.modeled),
      other: describe(ids.other),
      sector: describe(ids.sector),
      crs: describe(ids.crs),
      site: describe(ids.site),
      hazard: describe(ids.hazard),
    },
  };
}

function sameList(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function crsKeys(board) {
  return board.featureKeys.filter((key) => key.includes(`|${CRS}|corridor|`));
}

function eventRoles(board, eventId) {
  return board.featureKeys.filter((key) => key.includes(`|${eventId}|`) && !key.includes('|corridor|'));
}

async function shotNamed(page, name) {
  mkdirSync(evidence, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: resolve(artifacts, name) });
  await page.screenshot({ path: resolve(evidence, name) });
}

async function runToggle() {
  const published = toggleBody();
  assertToggleCatalog(published.text);
  if (process.env.OPD_LAUNCH_PLANNER_DRY === 'catalog') {
    console.log(`toggle catalog ${size} parsed`);
    return;
  }
  const touch = contextOptions(size).hasTouch;
  const how = touch ? 'tap' : 'click';
  const browser = await launchWebkit();
  isolateSnapRequests(browser, origin);
  const problems = [];
  try {
    const context = await browser.newContext(contextOptions(size));
    const page = await context.newPage();
    await page.addInitScript((frozen) => {
      Date.now = () => frozen;
      localStorage.setItem('opd-map-chrome', 'shown');
      localStorage.setItem('opd-map-launch-brief-open', '1');
    }, WHEN);
    await page.route('**/api/browser/session', (route) => jsonRoute(route, {
      ok: true,
      profile: { name: 'anil', displayName: 'Anil' },
      profiles: [{ name: 'anil', displayName: 'Anil' }],
    }));
    await page.route('**/manifest.json', (route) => jsonRoute(route, manifestBody()));
    await page.route('**/v/browser/passes.json', (route) => jsonRoute(route, []));
    await page.route('**/v/browser/top5.json', (route) => jsonRoute(route, []));
    await page.route('**/v/browser/track.json', (route) => jsonRoute(route, trackBody()));
    await page.route('**/launch/catalog/latest.json', (route) => jsonRoute(route, published.pointer));
    await page.route('**/launch/catalog/v/**', (route) => jsonRoute(route, published.text));
    await page.route('**/launch/latest.json', (route) => jsonRoute(route, { error: 'not_found' }, 404));
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const read = () => page.evaluate(toggleBoard, toggleIds);
    const activate = async (locator, method) => {
      await locator.scrollIntoViewIfNeeded();
      if (method === 'tap') await locator.tap();
      else if (method === 'click') await locator.click();
      else {
        await locator.focus();
        const before = await page.evaluate(() => ({
          y: window.scrollY,
          top: document.scrollingElement ? document.scrollingElement.scrollTop : 0,
          pane: document.getElementById('map-pane')?.scrollTop ?? 0,
          brief: document.getElementById('map-launch-coverage')?.scrollTop ?? 0,
        }));
        await page.keyboard.press(method === 'space' ? 'Space' : 'Enter');
        const after = await page.evaluate(() => ({
          y: window.scrollY,
          top: document.scrollingElement ? document.scrollingElement.scrollTop : 0,
          pane: document.getElementById('map-pane')?.scrollTop ?? 0,
          brief: document.getElementById('map-launch-coverage')?.scrollTop ?? 0,
        }));
        return { before, after };
      }
      return null;
    };
    const openDetails = async (selector) => {
      const details = page.locator(selector);
      if (!(await details.evaluate((node) => node.open))) await activate(details.locator('summary'), how);
      await page.waitForFunction((sel) => document.querySelector(sel)?.open === true, selector);
    };
    const control = (id) => page.locator(`#map-launch-coverage [data-event-id="${id}"] .launch-brief-actions button`);
    await page.goto(`${origin}/?e2e&u=anil`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__opdMap && window.__opdMap.isStyleLoaded(), null, { timeout: 30_000 });
    const launches = page.locator('#filter-launches-map');
    if (await launches.getAttribute('aria-pressed') !== 'true') await launches.click();
    const follow = page.locator('#toggle-follow-iss');
    if ((await follow.getAttribute('class'))?.includes('active')) await follow.click();
    await page.waitForFunction((id) => (
      document.querySelector(`#map-launch-coverage .map-launch-primary [data-event-id="${id}"] .launch-brief-actions button`)?.textContent === 'Show site and modeled ascent'
    ), MODELED, { timeout: 20_000 });
    await page.waitForFunction((id) => (
      document.querySelector(`[data-event-id="${id}"] .launch-brief-actions button`)?.textContent === 'Show published hazard areas'
    ), HAZARD, { timeout: 20_000 });
    const baseline = await read();
    await openDetails('#map-launch-coverage .map-launch-more');
    await activate(control(HAZARD), how);
    await page.waitForFunction(() => {
      const map = window.__opdMap;
      if (!map || map.isMoving()) return false;
      const canvas = map.getCanvas().getBoundingClientRect();
      return map.queryRenderedFeatures([[0, 0], [canvas.width, canvas.height]], { layers: ['launch-hazard-fill-layer'] }).length > 0;
    }, null, { timeout: 15_000 }).catch(() => null);
    await page.evaluate(() => {
      const primary = document.querySelector('#map-launch-coverage .map-launch-primary');
      const more = document.querySelector('#map-launch-coverage .map-launch-more');
      if (primary) primary.open = false;
      if (more) more.open = false;
    });
    const point = await page.evaluate(() => {
      const map = window.__opdMap;
      const canvas = map.getCanvas().getBoundingClientRect();
      const blocked = (x, y) => [...document.querySelectorAll('#map-launch-coverage, .map-toolbar, .map-control-dock, .map-controls-time, #map-legend-toggle, #map-chrome-toggle, .maplibregl-ctrl-group')]
        .some((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 1 && box.height > 1 && x > box.left && x < box.right && y > box.top && y < box.bottom;
        });
      for (let y = canvas.top + 8; y < canvas.bottom - 8; y += 18) {
        for (let x = canvas.left + 8; x < canvas.right - 8; x += 18) {
          if (blocked(x, y)) continue;
          const hits = map.queryRenderedFeatures([x - canvas.left, y - canvas.top], { layers: ['launch-hazard-fill-layer'] });
          if (hits.length) return { x, y };
        }
      }
      return null;
    });
    let hazardPopup = 'none';
    let hazardDebug = null;
    if (!point) {
      hazardDebug = await page.evaluate(() => {
        const map = window.__opdMap;
        const source = map.getSource('launch-hazards');
        const raw = source && (source._data?.geojson || source._data?.data || source._data);
        const canvas = map.getCanvas().getBoundingClientRect();
        const hits = map.queryRenderedFeatures([[0, 0], [canvas.width, canvas.height]], { layers: ['launch-hazard-fill-layer'] });
        return {
          features: raw?.features?.length ?? 0,
          hits: hits.length,
          visibility: map.getLayoutProperty('launch-hazard-fill-layer', 'visibility'),
        };
      });
    }
    if (point) {
      if (touch) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(600);
      hazardPopup = (await read()).popup ? 'open' : 'closed';
    }
    await openDetails('#map-launch-coverage .map-launch-primary');
    await activate(control(MODELED), how);
    await page.waitForFunction((id) => {
      const map = window.__opdMap;
      const source = map.getSource('ascent-trajectory');
      const raw = source && (source._data?.geojson || source._data?.data || source._data);
      return (raw?.features ?? []).some((feature) => feature.properties?.event_id === id && feature.properties?.role === 'model');
    }, MODELED, { timeout: 15_000 });
    const shown = await read();
    await shotNamed(page, `launch-brief-toggle-${size}-shown.png`);
    await openDetails('#map-launch-coverage .map-launch-primary');
    const reopened = await read();
    await shotNamed(page, `launch-brief-toggle-${size}-hide.png`);
    await activate(control(MODELED), how);
    await page.waitForFunction((id) => {
      const map = window.__opdMap;
      const source = map.getSource('ascent-trajectory');
      const raw = source && (source._data?.geojson || source._data?.data || source._data);
      return !(raw?.features ?? []).some((feature) => feature.properties?.event_id === id && feature.properties?.role === 'model');
    }, MODELED, { timeout: 15_000 });
    const hidden = await read();
    await shotNamed(page, `launch-brief-toggle-${size}-cleared.png`);
    await openDetails('#map-launch-coverage .map-launch-primary');
    await activate(control(MODELED), how);
    await page.waitForFunction((id) => {
      const map = window.__opdMap;
      const source = map.getSource('ascent-trajectory');
      const raw = source && (source._data?.geojson || source._data?.data || source._data);
      return (raw?.features ?? []).some((feature) => feature.properties?.event_id === id && feature.properties?.role === 'model');
    }, MODELED, { timeout: 15_000 });
    const shownAgain = await read();
    await openDetails('#map-launch-coverage .map-launch-more');
    await activate(control(OTHER), how);
    await page.waitForFunction((id) => {
      const source = window.__opdMap.getSource('ascent-trajectory');
      const raw = source && (source._data?.geojson || source._data?.data || source._data);
      const features = raw?.features ?? [];
      return features.some((feature) => feature.properties?.event_id === id && feature.properties?.role === 'model');
    }, OTHER, { timeout: 15_000 });
    const replaced = await read();
    await openDetails('#map-launch-coverage .map-launch-more');
    await activate(control(SECTOR), how);
    await page.waitForFunction((id) => (
      document.querySelector(`[data-event-id="${id}"] .launch-brief-actions button`)?.textContent === 'Hide assumed sector'
    ), SECTOR, { timeout: 15_000 });
    const sectorOn = await read();
    await openDetails('#map-launch-coverage .map-launch-more');
    await activate(control(SECTOR), how);
    await page.waitForFunction((id) => (
      document.querySelector(`[data-event-id="${id}"] .launch-brief-actions button`)?.textContent === 'Show site and assumed sector'
    ), SECTOR, { timeout: 15_000 });
    const sectorOff = await read();
    let space = null;
    if (!touch) {
      await openDetails('#map-launch-coverage .map-launch-primary');
      await activate(control(MODELED), 'enter');
      await page.waitForFunction((id) => {
        const primary = document.querySelector('#map-launch-coverage .map-launch-primary');
        const source = window.__opdMap.getSource('ascent-trajectory');
        const raw = source && (source._data?.geojson || source._data?.data || source._data);
        const drawn = (raw?.features ?? []).some((feature) => feature.properties?.event_id === id && feature.properties?.role === 'model');
        return primary && !primary.open && drawn;
      }, MODELED, { timeout: 15_000 });
      const byEnter = await read();
      if (!byEnter.summaryFocused) problems.push('Enter did not focus the summary');
      await openDetails('#map-launch-coverage .map-launch-primary');
      await activate(control(MODELED), 'enter');
      await page.waitForFunction((id) => (
        document.querySelector(`[data-event-id="${id}"] .launch-brief-actions button`)?.getAttribute('aria-pressed') === 'false'
      ), MODELED, { timeout: 15_000 });
      await openDetails('#map-launch-coverage .map-launch-primary');
      space = await activate(control(MODELED), 'space');
      await page.waitForFunction((id) => {
        const primary = document.querySelector('#map-launch-coverage .map-launch-primary');
        const source = window.__opdMap.getSource('ascent-trajectory');
        const raw = source && (source._data?.geojson || source._data?.data || source._data);
        const drawn = (raw?.features ?? []).some((feature) => feature.properties?.event_id === id && feature.properties?.role === 'model');
        return primary && !primary.open && drawn;
      }, MODELED, { timeout: 15_000 });
    }
    const expectButton = (board, name, text, pressed) => {
      const button = board.buttons[name];
      if (!button) problems.push(`${name} button missing`);
      else if (button.text !== text || button.pressed !== pressed) problems.push(`${name} ${button.text} pressed ${button.pressed}`);
    };
    if (baseline.summary !== 'Next launch · Watch') problems.push(`summary ${baseline.summary}`);
    expectButton(baseline, 'modeled', 'Show site and modeled ascent', 'false');
    expectButton(baseline, 'sector', 'Show site and assumed sector', 'false');
    expectButton(baseline, 'crs', 'Show site and corridor', null);
    expectButton(baseline, 'site', 'Show launch site', null);
    expectButton(baseline, 'hazard', 'Show published hazard areas', null);
    if (!crsKeys(baseline).length) problems.push('published corridor missing before show');
    if (shown.open) problems.push('show left the brief open');
    if (!shown.summaryFocused) problems.push('show did not focus the summary');
    if (shown.captionHidden || !shown.caption.includes('grade')) problems.push('show dropped the caption');
    if (!eventRoles(shown, MODELED).length) problems.push('show drew no modeled features');
    if (shown.popup) problems.push('show left a launch popup open');
    expectButton(reopened, 'modeled', 'Hide modeled ascent', 'true');
    if (hidden.captionHidden !== true) problems.push('hide left the caption');
    if (eventRoles(hidden, MODELED).length) problems.push('hide left modeled features');
    expectButton(hidden, 'modeled', 'Show site and modeled ascent', 'false');
    for (const board of [shown, hidden, shownAgain]) {
      if (!sameList(board.sources, baseline.sources) || !sameList(board.layers, baseline.layers)) {
        problems.push(`sources ${board.sources.length} layers ${board.layers.length}`);
      }
      if (!sameList(crsKeys(board), crsKeys(baseline))) problems.push('published corridor changed');
    }
    if (!sameList(shownAgain.featureIds, shown.featureIds) || !sameList(shownAgain.featureKeys, shown.featureKeys)) {
      problems.push('feature ids changed across show hide show');
    }
    expectButton(replaced, 'modeled', 'Show site and modeled ascent', 'false');
    expectButton(replaced, 'other', 'Hide modeled ascent', 'true');
    expectButton(replaced, 'hazard', 'Show launch site', null);
    if (eventRoles(replaced, MODELED).length || !eventRoles(replaced, OTHER).length) problems.push('other launch did not replace the drawing');
    expectButton(sectorOn, 'sector', 'Hide assumed sector', 'true');
    expectButton(sectorOn, 'other', 'Show site and modeled ascent', 'false');
    expectButton(sectorOff, 'sector', 'Show site and assumed sector', 'false');
    expectButton(sectorOff, 'hazard', 'Show published hazard areas', null);
    if (space) {
      const pageScroll = (box) => ({ y: box.y, top: box.top, pane: box.pane });
      if (!sameList(pageScroll(space.before), pageScroll(space.after))) {
        problems.push(`Space scrolled ${JSON.stringify(pageScroll(space.before))} -> ${JSON.stringify(pageScroll(space.after))}`);
      }
    }
    const ignored = errors.filter((error) => !error.includes('nasa.gov') && !error.includes('gibs.earthdata'));
    if (ignored.length) problems.push(ignored[0]);
    const report = {
      size,
      how,
      focusVisible: shown.focusVisible,
      hazardPopup,
      hazardDebug,
      space,
      sourceCount: baseline.sources.length,
      layerCount: baseline.layers.length,
      featureCount: shown.featureKeys.length,
      problems,
    };
    writeFileSync(resolve(artifacts, `launch-brief-toggle-${size}.json`), JSON.stringify(report, null, 2));
    if (problems.length) throw new Error(`launch brief toggle ${size}: ${problems.join('; ')}`);
    const spaceNote = touch ? 'n/a' : '0';
    console.log(`launch brief toggle ${size} ${how} show hide show sources ${baseline.sources.length} layers ${baseline.layers.length} features identical focus-visible ${shown.focusVisible ? 1 : 0} hazard-popup ${hazardPopup} space-scroll ${spaceNote}`);
    await context.close();
  } finally {
    await browser.close();
  }
}

if (probeName === 'toggle') {
  try {
    await runToggle();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (probeName === 'card') {
const browser = await launchWebkit();
isolateSnapRequests(browser, origin);
try {
  const context = await browser.newContext(contextOptions(size));
  const page = await context.newPage();
  await page.addInitScript((frozen) => {
    Date.now = () => frozen;
    localStorage.setItem('opd-map-chrome', 'shown');
    localStorage.setItem('opd-map-launch-brief-open', '1');
  }, WHEN);
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${origin}/?e2e&u=anil`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__opdMap && window.__opdMap.isStyleLoaded(), null, { timeout: 30_000 });
  const launches = page.locator('#filter-launches-map');
  if (await launches.getAttribute('aria-pressed') !== 'true') await launches.click();
  const follow = page.locator('#toggle-follow-iss');
  if ((await follow.getAttribute('class'))?.includes('active')) await follow.click();
  const show = page.locator('#map-launch-coverage .launch-brief-actions .btn', { hasText: 'Show site and corridor' });
  await show.first().waitFor({ timeout: 20_000 });
  await show.first().click();
  await page.waitForFunction(() => {
    const map = window.__opdMap;
    const source = map && map.getSource('ascent-trajectory');
    const raw = source && (source._data?.geojson || source._data?.data || source._data);
    const features = raw?.features ?? [];
    const branches = new Set(features.filter((feature) => feature.properties?.role === 'model').map((feature) => feature.properties?.branch));
    return branches.has('northbound') && branches.has('southbound');
  }, null, { timeout: 15_000 });
  await page.waitForTimeout(700);
  const measured = await page.evaluate(probe);
  mkdirSync(evidence, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const file = `launch-planner-${size}.png`;
  await page.screenshot({ path: resolve(artifacts, file) });
  await page.screenshot({ path: resolve(evidence, file) });
  const problems = [];
  if (measured.eventId !== EVENT) problems.push(`event ${measured.eventId}`);
  if (measured.tier !== 'likely') problems.push(`tier ${measured.tier}`);
  if (!measured.direction.includes('Modeled, grade C.')) problems.push('missing grade');
  if (!measured.direction.includes('Source: ') || !measured.direction.includes('Not a published trajectory.')) problems.push('missing source sentence');
  if (!measured.direction.includes('northbound branch, selected scenario, azimuth 42.8°')) problems.push('card direction is not the selected branch');
  if (!measured.direction.includes('southbound branch')) problems.push('card omits the other fan');
  if (!measured.title.includes('Estimate.') || !measured.title.includes('Modeled azimuth 42.8°')) problems.push(`title ${measured.title}`);
  if (!measured.look.includes('Cupola W1') || !measured.look.includes('833 km')) problems.push(`look ${measured.look}`);
  if (measured.look.includes('991')) problems.push('first shot used the longer branch');
  if (!measured.why.includes('833 km') || measured.why.includes('991 km')) problems.push(`why ${measured.why}`);
  if (measured.branches.length !== 2 || !measured.branches.includes('northbound') || !measured.branches.includes('southbound')) {
    problems.push(`fans ${measured.branches.join(',')}`);
  }
  if (!measured.edgeBranches.includes('northbound') || !measured.edgeBranches.includes('southbound')) {
    problems.push(`edges ${measured.edgeBranches.join(',')}`);
  }
  if (measured.corridorCount < 1 || measured.renderedCorridor < 1 || measured.renderedModel < 1) problems.push('corridor or fans not painted');
  if (!(measured.corridorMax > 37 && measured.corridorMax < 38 && measured.corridorMin > 28)) {
    problems.push(`corridor lat ${measured.corridorMin}..${measured.corridorMax}`);
  }
  if (measured.captionHidden || !measured.caption.includes('grade C') || !measured.caption.includes('Source: ')) {
    problems.push('ascent caption missing grade or source');
  }
  if (!measured.caption.includes("Only this launch's fans are shown.")) problems.push('caption did not name the fans');
  const ignored = errors.filter((error) => !error.includes('nasa.gov') && !error.includes('gibs.earthdata'));
  if (ignored.length) problems.push(ignored[0]);
  const overlap = measured.overlap;
  const report = { size, measured, problems, file: resolve(artifacts, file) };
  writeFileSync(resolve(artifacts, `launch-planner-${size}.json`), JSON.stringify(report, null, 2));
  if (problems.length) fail(`launch planner ${size}: ${problems.join('; ')}`);
  const under = overlap ? 1 : 0;
  const box = overlap ? `${overlap.width}x${overlap.height}` : '0x0';
  console.log(`launch planner ${size} card modeled grade C azimuth 42.8 km 833 fans 2 corridor northbound caption-under-card ${under} overlap ${box}`);
  await context.close();
} finally {
  await browser.close();
}
}
