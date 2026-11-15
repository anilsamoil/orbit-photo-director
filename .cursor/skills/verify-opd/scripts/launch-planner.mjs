#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
