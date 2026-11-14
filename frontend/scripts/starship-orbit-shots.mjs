#!/usr/bin/env node
// Drives the built app in WebKit and Chromium and photographs the Satellites
// panel in each Starship orbit state. Every state is checked before its shot.
//
// Usage: bun run build && node scripts/starship-orbit-shots.mjs <out-dir>
//
// No element set is invented here. The only orbit drawn is the ISS element
// set passed in OPD_ISS_TLE (two lines), published as NORAD 25544.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: starship-orbit-shots.mjs <out-dir>');
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
if (!existsSync(join(DIST, 'index.html'))) throw new Error('run `bun run build` first');
const CATALOG_PATH = new URL('../test/fixtures/starship-catalog-2026-11-10.json', import.meta.url);
const NO_DATA = JSON.parse(readFileSync(new URL('../test/fixtures/tracked-lookup-failed.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-13T22:50:00Z');
const ALL_SIZES = [[1024, 768], [1180, 820], [834, 1210], [820, 1180], [768, 1024], [874, 402], [402, 874], [1440, 900]];
const ONLY = process.env.OPD_SHOT_SIZES?.split(',');
const SIZES = ALL_SIZES.filter(([width, height]) => !ONLY || ONLY.includes(`${width}x${height}`));
const DETAIL_SIZES = ONLY ? [] : [[1440, 900], [402, 874]];
const ISS_TLE = (process.env.OPD_ISS_TLE ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

const STARSHIP = NO_DATA.objects[0];
const TEXT = {
  publisherFailed: 'Starship: orbit lookup failed, the publisher could not reach CelesTrak. No orbit is drawn.',
  browserFailed: 'Starship: orbit lookup failed, CelesTrak could not be reached from this browser. No orbit is drawn.',
  noOrbit: 'Starship: no public orbit yet. CelesTrak GP and Supplemental GP list no element set for it.',
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.pbf': 'application/x-protobuf', '.geojson': 'application/json', '.webmanifest': 'application/manifest+json' };

function serveDist() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = join(DIST, path === '/' ? 'index.html' : path);
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function catalogFor(nowMs) {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  catalog.generated_at = new Date(nowMs - 60_000).toISOString();
  catalog.geometry_valid_until = new Date(nowMs + 10 * 60_000).toISOString();
  catalog.schedule_valid_until = new Date(nowMs + 60 * 60_000).toISOString();
  const text = JSON.stringify(catalog);
  return {
    text,
    pointer: {
      schema_version: 2,
      revision: catalog.revision,
      generated_at: catalog.generated_at,
      valid_until: catalog.geometry_valid_until,
      path: `launch/catalog/v/${catalog.revision}.json`,
      sha256: createHash('sha256').update(text).digest('hex'),
    },
  };
}

function issEpochIso() {
  const [line1] = ISS_TLE;
  const year = 2000 + Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));
  return new Date(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000).toISOString();
}

function trackFor(nowMs) {
  const track = {
    iss_polynomial: { start: new Date(nowMs - 60_000).toISOString(), duration_seconds: 7200, lat_coeffs: [-0.01, 28], lon_coeffs: [0.012, -97], polynomial_order: 1 },
    track_points: [[0, 28, -97], [3600, 20, -80]],
    tle_epoch: '2026-11-13T00:00:00Z',
    tle_age_hours: 1,
    tle_freshness_factor: 1,
  };
  if (ISS_TLE.length !== 2) return track;
  return { ...track, tle: { line1: ISS_TLE[0], line2: ISS_TLE[1] }, tle_epoch: issEpochIso() };
}

function issRow() {
  return {
    id: 'iss', label: 'ISS', color: '#5cd0ff', state: 'elements', source: 'gp', name: 'ISS (ZARYA)',
    norad: 25544, intldes: '98067A', line1: ISS_TLE[0], line2: ISS_TLE[1], epoch: issEpochIso(), age_hours: 1,
    lookup: { names: [], patterns: [], max_age_hours: 48, catnr: 25544 },
  };
}

/** Each state: what the publisher says, and what CelesTrak answers a browser. */
const STATES = {
  'lookup-failed': { tracked: NO_DATA, celestrak: 'unreachable' },
  'no-public-orbit': { tracked: { objects: [{ ...STARSHIP, reason: 'no_public_orbit' }] }, celestrak: 'empty' },
  'published-norad-25544': { tracked: () => ({ objects: [STARSHIP, issRow()] }), celestrak: 'unreachable' },
};

async function prepare(page, state, nowMs, celestrakRequests) {
  const { text, pointer } = catalogFor(nowMs);
  const tracked = typeof state.tracked === 'function' ? state.tracked() : state.tracked;
  await page.addInitScript((frozen) => {
    Date.now = () => frozen;
    localStorage.setItem('opd-map-chrome', 'shown');
  }, nowMs);
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) });
  await page.route('**/api/browser/session', (route) => json(route, { ok: true, profile: { name: 'anil', displayName: 'Anil' }, profiles: [{ name: 'anil', displayName: 'Anil' }] }));
  await page.route('**/manifest.json', (route) => json(route, {
    version: new Date(nowMs).toISOString().replace(/[-:]/g, '').replace('.000', ''),
    generated_at: new Date(nowMs - 30_000).toISOString(),
    tle_epoch: '2026-11-13T00:00:00Z',
    cloud_composite_hour: '2026-11-13T22:00:00Z',
    target_data_version: 'v1',
    build_version: 'starship-orbit-shots',
    freshness: { tle_hours: 1, cloud_hours: 1, ok: true },
    artifacts: {
      passes: { path: 'v/browser/passes.json', sha256: '', bytes: 2 },
      top5: { path: 'v/browser/top5.json', sha256: '', bytes: 2 },
      track: { path: 'v/browser/track.json', sha256: '', bytes: 2 },
      tracked: { path: 'v/browser/tracked.json', sha256: '', bytes: 2 },
    },
  }));
  await page.route('**/v/browser/passes.json', (route) => json(route, []));
  await page.route('**/v/browser/top5.json', (route) => json(route, []));
  await page.route('**/v/browser/track.json', (route) => json(route, trackFor(nowMs)));
  await page.route('**/v/browser/tracked.json', (route) => json(route, tracked));
  await page.route('**/launch/catalog/latest.json', (route) => json(route, pointer));
  await page.route('**/launch/catalog/v/**', (route) => json(route, text));
  await page.route('**/launch/latest.json', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
  await page.route('https://celestrak.org/**', (route) => {
    celestrakRequests.push(route.request().url());
    if (state.celestrak === 'empty') return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'No GP data found' });
    return route.abort('connectionfailed');
  });
}

async function openMap(page, origin, selectLaunch) {
  await page.goto(`${origin}/?e2e&u=anil`, { waitUntil: 'domcontentloaded' });
  const tab = page.locator('#tab-map');
  if (await tab.isVisible().catch(() => false)) await tab.click();
  await page.waitForFunction(() => window.__opdMap && window.__opdMap.isStyleLoaded(), null, { timeout: 30_000 });
  const follow = page.locator('#toggle-follow-iss');
  if ((await follow.getAttribute('class'))?.includes('active')) await follow.click();
  if (!selectLaunch) return;
  const launches = page.locator('#filter-launches-map');
  if (await launches.getAttribute('aria-pressed') !== 'true') await launches.click();
  const show = page.locator('#map-launch-coverage .launch-brief-actions .btn');
  await show.first().waitFor({ state: 'visible', timeout: 20_000 });
  await show.first().click();
  await page.waitForTimeout(1500);
}

async function openPicker(page) {
  await page.locator('#toggle-satellite-picker').click();
  await page.waitForSelector('#satellite-picker-panel:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('#satellite-picker-list label').length >= 4);
}

function panelProbe() {
  const panel = document.querySelector('#satellite-picker-panel');
  const box = panel.getBoundingClientRect();
  const row = [...document.querySelectorAll('#satellite-picker-list label')].find((label) => label.textContent.includes('Starship'));
  const map = window.__opdMap;
  return {
    panelInView: box.left >= -0.5 && box.top >= -0.5 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5,
    starshipChecked: row ? row.querySelector('input').checked : null,
    starshipBadge: row ? (row.querySelector('.sat-stale')?.textContent ?? '') : null,
    notes: [...document.querySelectorAll('#satellite-picker-notes .sat-row-note')].map((note) => note.textContent),
    status: document.querySelector('#satellite-picker-status').textContent,
    satelliteLayers: map.getStyle().layers.map((layer) => layer.id).filter((id) => id.startsWith('sat-track-layer-')),
    markers: [...document.querySelectorAll('.tracked-marker, .sat-marker')].map((marker) => marker.title),
  };
}

const report = [];
const failures = [];
const check = (row, ok, what) => {
  if (!ok) failures.push(`${row.engine} ${row.size} ${row.shot}: ${what}`);
};

mkdirSync(OUT, { recursive: true });
const server = await serveDist();
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  for (const [engine, browserType] of [['webkit', webkit], ['chromium', chromium]]) {
    const browser = await browserType.launch();
    try {
      const run = async (stateName, [width, height], selectLaunch, act) => {
        const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
        const page = await context.newPage();
        const errors = [];
        const celestrak = [];
        const consoleErrors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
        page.on('requestfailed', (request) => consoleErrors.push(`requestfailed ${request.url().slice(0, 120)} ${request.failure()?.errorText}`));
        try {
          await prepare(page, STATES[stateName], NOW, celestrak);
          await openMap(page, origin, selectLaunch);
          await openPicker(page);
          const shot = act ? await act(page) : stateName;
          await page.waitForTimeout(600);
          const probe = await page.evaluate(panelProbe);
          const file = `${engine}_${width}x${height}_${shot}_${selectLaunch ? 'launch-selected' : 'nothing-selected'}.png`;
          await page.screenshot({ path: join(OUT, file) });
          const row = { engine, size: `${width}x${height}`, shot, selectLaunch, file, celestrak, errors: errors.filter((error) => !error.includes('gibs.earthdata.nasa.gov')), ...probe };
          report.push(row);
          return row;
        } catch (error) {
          const file = `ERROR_${engine}_${width}x${height}_${stateName}_${selectLaunch ? 'launch-selected' : 'nothing-selected'}.png`;
          await page.screenshot({ path: join(OUT, file) }).catch(() => undefined);
          const row = { engine, size: `${width}x${height}`, shot: stateName, selectLaunch, file, celestrak, errors: [String(error).split('\n')[0]], consoleErrors, notes: [], satelliteLayers: [], markers: [] };
          report.push(row);
          return row;
        } finally {
          await context.close();
        }
      };

      for (const size of SIZES) {
        for (const selectLaunch of [false, true]) {
          const row = await run('lookup-failed', size, selectLaunch);
          check(row, row.errors.length === 0, `page errors ${row.errors.join(' | ')}`);
          check(row, row.panelInView, 'panel leaves the viewport');
          check(row, row.starshipChecked === true, 'Starship box is not checked');
          check(row, row.starshipBadge === 'no orbit', `badge is "${row.starshipBadge}"`);
          check(row, row.notes.includes(TEXT.publisherFailed), `notes are ${JSON.stringify(row.notes)}`);
          check(row, row.satelliteLayers.length === 0 && row.markers.length === 0, 'something is drawn with no element set');
          check(row, row.celestrak.length === 0, 'asked CelesTrak without a tap');
        }
      }

      for (const size of DETAIL_SIZES) {
        const retap = async (page) => {
          const box = page.locator('#satellite-picker-list label', { hasText: 'Starship' });
          await box.click();
          await box.click();
          await page.waitForFunction(() => document.querySelector('#satellite-picker-status').textContent.startsWith('Starship:'));
        };
        const tapped = await run('lookup-failed', size, false, async (page) => { await retap(page); return 'tap-celestrak-unreachable'; });
        check(tapped, tapped.status === TEXT.browserFailed, `status is "${tapped.status}"`);
        check(tapped, tapped.starshipChecked === true, 'box unchecked itself after a failed lookup');
        check(tapped, tapped.celestrak.length === 4, `asked ${tapped.celestrak.length} URLs, want 4`);
        check(tapped, tapped.satelliteLayers.length === 0, 'drew a track after a failed lookup');

        const none = await run('no-public-orbit', size, false);
        check(none, none.notes.includes(TEXT.noOrbit), `notes are ${JSON.stringify(none.notes)}`);
        check(none, none.celestrak.length === 0, 'asked CelesTrak without a tap');

        const noneTapped = await run('no-public-orbit', size, false, async (page) => { await retap(page); return 'tap-celestrak-empty'; });
        check(noneTapped, noneTapped.status === TEXT.noOrbit, `status is "${noneTapped.status}"`);
        check(noneTapped, noneTapped.starshipChecked === true, 'box unchecked itself after a miss');

        if (ISS_TLE.length === 2) {
          const drawn = await run('published-norad-25544', size, false, async (page) => {
            await page.locator('#satellite-picker-input').fill('25544');
            await page.locator('#satellite-picker-add').click();
            await page.waitForFunction(() => document.querySelector('#satellite-picker-status').textContent === 'Tracking added');
            return 'typed-25544-from-publisher';
          });
          check(drawn, drawn.satelliteLayers.join() === 'sat-track-layer-25544', `layers are ${drawn.satelliteLayers}`);
          check(drawn, drawn.markers.length === 1, `markers are ${JSON.stringify(drawn.markers)}`);
          check(drawn, drawn.celestrak.length === 0, 'asked CelesTrak although the publisher carries the object');
          check(drawn, drawn.notes.some((note) => note.startsWith('NORAD 25544: In ISS line of sight now and for the next 24 h or longer, closest 0 km')), `notes are ${JSON.stringify(drawn.notes)}`);
          check(drawn, drawn.notes.includes(TEXT.publisherFailed), 'Starship lost its failed-lookup note');
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`${report.length} shots in ${OUT}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
