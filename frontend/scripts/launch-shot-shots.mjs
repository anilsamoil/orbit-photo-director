#!/usr/bin/env node
// Drives the built app in WebKit and Chromium and photographs the launch
// cards with the shot plan. Every card is checked before its shot.
//
// Usage: bun run build && node scripts/launch-shot-shots.mjs <out-dir>
//
// The catalog below is a test fixture. Its launches, times, look angles and
// track points are made up to exercise the cards. None of it is a real
// launch, a real orbit or a real flight path.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: launch-shot-shots.mjs <out-dir>');
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
if (!existsSync(join(DIST, 'index.html'))) throw new Error('run `bun run build` first');
const NOW = Date.parse('2026-11-13T22:50:00Z');
const ALL_SIZES = [[1024, 768], [1180, 820], [834, 1210], [820, 1180], [768, 1024], [874, 402], [402, 874], [1440, 900]];
const ONLY = process.env.OPD_SHOT_SIZES?.split(',');
const SIZES = ALL_SIZES.filter(([width, height]) => !ONLY || ONLY.includes(`${width}x${height}`));
const DETAIL_SIZES = ONLY ? SIZES : [[1440, 900], [402, 874]];

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const LIKELY_NET = Date.parse('2026-11-14T18:10:00Z');
const WATCH_NET = Date.parse('2026-11-15T04:30:00Z');
const PLANE = { kind: 'iss_plane', azimuth_deg: 44.7, source: 'iss_tle_plane', off_plane_deg: 0.35 };
const NONE = { kind: 'none', azimuth_deg: null, source: null, off_plane_deg: null };
const TERMS = { A: [0.2, 0.4], C: [0.5, 0.5], D: [0.1, 0.2], M: [0.8, 1], R: [0.4, 0.6] };

const HONESTY = 'Simulated attitude (+XVV). Window access not verified.';
const LIKELY = {
  name: 'Dragon CRS-35 (test fixture)',
  why: 'Twilight plume 488 km aft, W6, 3 min after liftoff.',
  ascent: [
    'Ascent shot if liftoff is 14 Nov 2026, 18:10:00 UTC. Estimate.',
    'Best time: 14 Nov 2026, 18:13:15 UTC · 14 Nov 2026, 12:13:15 CST · 3 min 15 s after liftoff',
    'Shootable: 14 Nov 2026, 18:12:30–18:15:00 UTC · 2 min 30 s',
    'Stand and look: Cupola W6. Look aft and left, 224.6° clockwise from the direction of travel, 70.2° up from straight down. 488 km away.',
    'Lens: Telephoto. Distant plume.',
    'Light: Twilight plume.',
    'How sure: ISS orbit data 19.3 h old at the event. Robust to timing error. Score 34 to 41 of 100.',
  ],
  pad: [
    'Pad shot if liftoff is 14 Nov 2026, 18:10:00 UTC. Estimate.',
    'Best time: 14 Nov 2026, 18:10:30 UTC · 14 Nov 2026, 12:10:30 CST · 30 s after liftoff',
    'Shootable: 14 Nov 2026, 18:09:00–18:11:30 UTC · 2 min 30 s',
    'Stand and look: Cupola W7. Look aft, 200° clockwise from the direction of travel, 30° up from straight down. 640 km away.',
    'Lens: Wide. Close pad.',
    'Light: Daytime pad.',
    'How sure: ISS orbit data 19.3 h old at the event. Robust to timing error. Score 22 of 100.',
  ],
  direction: 'Launch direction: Estimate. The ISS orbital plane, derived from the ISS TLE. Azimuth 44.7°, 0.35° off the plane.',
  more: '1 more shot window in the details.',
};
const WATCH = {
  name: 'Starlink Group 17-4 (test fixture)',
  why: 'Night pad 910 km left, W1, at liftoff.',
  pad: [
    'Pad shot if liftoff is 15 Nov 2026, 04:30:00 UTC. Estimate.',
    'Best time: 15 Nov 2026, 04:30:00 UTC · 14 Nov 2026, 22:30:00 CST · at liftoff',
    'Shootable: 15 Nov 2026, 04:29:00–04:31:00 UTC · 2 min',
    'Stand and look: Cupola W1. Look left, 268° clockwise from the direction of travel, 61.5° up from straight down. 910 km away.',
    'Lens: Telephoto. Pad is a small target.',
    'Light: Night pad.',
    'How sure: ISS orbit data 29.7 h old at the event. Not robust to timing error. Score 12 to 18 of 100.',
  ],
  direction: 'Launch direction: No sourced launch direction, so no ascent path is drawn. Only the pad can be planned.',
};

function envelope(over) {
  return {
    evaluated_at: iso(NOW - 60_000), limb_margin_deg: 6, plume_mrad: null, track: [],
    confidence: { tle_age_h: 19.3, along_track_sigma_km: 9, timing_sigma_s: 1.2, robust: true },
    ...over,
  };
}

function fixtureCatalog() {
  const items = [
    {
      event_id: 'fixture-likely', revision: 'fixturelikely1', name: LIKELY.name, rocket: 'Falcon 9 Block 5',
      site: { name: 'Kennedy Space Center, FL, USA', lat: 28.608, lon: -80.604, pad: 'Launch Complex 39A' },
      schedule: { net: iso(LIKELY_NET), window_start: iso(LIKELY_NET), window_end: iso(LIKELY_NET), precision: 'Second', status: 'Go', destination: 'ISS' },
      direction: PLANE, tier: 'likely', why: LIKELY.why, reasons: [],
      shots: [
        envelope({
          subject: 'pad', liftoff: iso(LIKELY_NET), direction: PLANE,
          start: iso(LIKELY_NET - 60_000), best: iso(LIKELY_NET + 30_000), end: iso(LIKELY_NET + 90_000), best_offset_s: 30,
          look: { frame: 'orbital-lvlh', azimuth_deg: 200, off_nadir_deg: 30 }, window: 'W7', slant_km: 640.2,
          light: 'pad_day', lens: 'wide', lens_reason: 'Close pad.',
          score: { low: 22, high: 22, terms: TERMS },
        }),
        envelope({
          subject: 'ascent', liftoff: iso(LIKELY_NET), direction: PLANE,
          start: iso(LIKELY_NET + 150_000), best: iso(LIKELY_NET + 195_000), end: iso(LIKELY_NET + 300_000), best_offset_s: 195,
          look: { frame: 'orbital-lvlh', azimuth_deg: 224.6, off_nadir_deg: 70.2 }, window: 'W6', slant_km: 488.3,
          plume_mrad: 1.6, light: 'twilight_plume', lens: 'telephoto', lens_reason: 'Distant plume.',
          track: [
            { t_offset_s: 150, lat: 29.4, lon: -79.7, alt_km: 70 },
            { t_offset_s: 195, lat: 30.1, lon: -78.9, alt_km: 105 },
            { t_offset_s: 240, lat: 31.0, lon: -77.9, alt_km: 135 },
            { t_offset_s: 300, lat: 32.4, lon: -76.2, alt_km: 170 },
          ],
          score: { low: 34, high: 41, terms: TERMS },
        }),
      ],
    },
    {
      event_id: 'fixture-watch', revision: 'fixturewatch1', name: WATCH.name, rocket: 'Falcon 9 Block 5',
      site: { name: 'Vandenberg SFB, CA, USA', lat: 34.632, lon: -120.611, pad: 'Space Launch Complex 4E' },
      schedule: { net: iso(WATCH_NET), window_start: iso(WATCH_NET), window_end: iso(WATCH_NET + 4 * 3600_000), precision: 'Minute', status: 'TBC', destination: null },
      direction: NONE, tier: 'watch', why: WATCH.why, reasons: [],
      shots: [
        envelope({
          subject: 'pad', liftoff: iso(WATCH_NET), direction: NONE,
          start: iso(WATCH_NET - 60_000), best: iso(WATCH_NET), end: iso(WATCH_NET + 60_000), best_offset_s: 0,
          look: { frame: 'orbital-lvlh', azimuth_deg: 268, off_nadir_deg: 61.5 }, window: 'W1', slant_km: 910.4,
          light: 'pad_night', lens: 'telephoto', lens_reason: 'Pad is a small target.',
          score: { low: 12, high: 18, terms: TERMS },
          confidence: { tle_age_h: 29.7, along_track_sigma_km: 30, timing_sigma_s: 40, robust: false },
        }),
      ],
    },
  ];
  const catalog = {
    schema_version: 3, revision: 'launchshotfixture1', generated_at: iso(NOW - 60_000),
    schedule_valid_until: iso(NOW + 60 * 60_000), geometry_valid_until: iso(NOW + 10 * 60_000),
    tle: { epoch: iso(NOW - 3600_000), sha256: 'a'.repeat(64), source: 'test fixture' },
    coverage: {
      from: iso(NOW - 3600_000), until: iso(NOW + 14 * 24 * 3600_000), schedule_fetched_at: iso(NOW - 60_000),
      pages: 1, received: 2, listed: 2, evaluated: 2,
      tier_counts: { shot: 0, likely: 1, watch: 1, unassessed: 0, none: 0 }, complete: true, reasons: [],
    },
    items,
  };
  const text = JSON.stringify(catalog);
  return {
    text,
    pointer: {
      schema_version: 2, revision: catalog.revision, generated_at: catalog.generated_at,
      valid_until: catalog.geometry_valid_until, path: `launch/catalog/v/${catalog.revision}.json`,
      sha256: createHash('sha256').update(text).digest('hex'),
    },
  };
}

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

async function prepare(page) {
  const { text, pointer } = fixtureCatalog();
  await page.addInitScript((frozen) => {
    Date.now = () => frozen;
    localStorage.setItem('opd-map-chrome', 'shown');
    localStorage.setItem('opd-map-launch-brief-open', '1');
  }, NOW);
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) });
  const missing = (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
  await page.route('**/api/browser/session', (route) => json(route, { ok: true, profile: { name: 'anil', displayName: 'Anil' }, profiles: [{ name: 'anil', displayName: 'Anil' }] }));
  await page.route('**/manifest.json', (route) => json(route, {
    version: new Date(NOW).toISOString().replace(/[-:]/g, '').replace('.000', ''),
    generated_at: iso(NOW - 30_000),
    tle_epoch: '2026-11-13T00:00:00Z',
    cloud_composite_hour: '2026-11-13T22:00:00Z',
    target_data_version: 'v1',
    build_version: 'launch-shot-shots',
    freshness: { tle_hours: 1, cloud_hours: 1, ok: true },
    artifacts: {
      passes: { path: 'v/browser/passes.json', sha256: '', bytes: 2 },
      top5: { path: 'v/browser/top5.json', sha256: '', bytes: 2 },
      track: { path: 'v/browser/track.json', sha256: '', bytes: 2 },
    },
  }));
  await page.route('**/v/browser/passes.json', (route) => json(route, []));
  await page.route('**/v/browser/top5.json', (route) => json(route, []));
  await page.route('**/v/browser/track.json', (route) => json(route, {
    iss_polynomial: { start: iso(NOW - 60_000), duration_seconds: 7200, lat_coeffs: [-0.01, 28], lon_coeffs: [0.012, -97], polynomial_order: 1 },
    track_points: [[0, 28, -97], [3600, 20, -80]],
    tle_epoch: '2026-11-13T00:00:00Z',
    tle_age_hours: 1,
    tle_freshness_factor: 1,
  }));
  await page.route('**/launch/catalog/latest.json', (route) => json(route, pointer));
  await page.route('**/launch/catalog/v/**', (route) => json(route, text));
  await page.route('**/launch/latest.json', missing);
  await page.route('**/hazards/v1/**', missing);
  await page.route('https://celestrak.org/**', (route) => route.abort('connectionfailed'));
}

async function openBrief(page, origin) {
  await page.goto(`${origin}/?e2e&u=anil`, { waitUntil: 'domcontentloaded' });
  const tab = page.locator('#tab-map');
  if (await tab.isVisible().catch(() => false)) await tab.click();
  await page.waitForFunction(() => window.__opdMap && window.__opdMap.isStyleLoaded(), null, { timeout: 30_000 });
  const follow = page.locator('#toggle-follow-iss');
  if ((await follow.getAttribute('class'))?.includes('active')) await follow.click();
  const launches = page.locator('#filter-launches-map');
  if (await launches.getAttribute('aria-pressed') !== 'true') await launches.click();
  await page.locator('#map-launch-coverage .launch-tier').first().waitFor({ state: 'visible', timeout: 20_000 });
}

function probe() {
  const lines = (root) => [...root.querySelectorAll('.launch-plan > *')].map((line) => {
    const label = line.querySelector('.launch-fact-label');
    return label ? `${label.textContent}: ${line.lastElementChild.textContent}` : line.textContent;
  });
  const box = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
  };
  const card = (root) => (root ? {
    name: root.querySelector('.launch-name')?.textContent ?? '',
    tier: root.dataset.tier ?? '',
    why: [...root.children].find((child) => child.tagName === 'P')?.textContent ?? '',
    lines: lines(root),
  } : null);
  const issCard = document.querySelector('[data-iss-launch-card]');
  const panel = document.querySelector('#map-launch-coverage');
  const dialog = document.querySelector('.launch-dialog');
  return {
    panel: panel && !panel.hidden ? box(panel) : null,
    legend: box(document.querySelector('#map-legend-toggle')),
    caption: box(document.querySelector('#launch-hazard-caption')),
    cards: [...document.querySelectorAll('#map-launch-coverage .launch-tier')].map(card),
    dialog: dialog ? { title: dialog.querySelector('h2')?.textContent ?? '', lines: lines(dialog), box: box(dialog) } : null,
    iss: issCard && !issCard.hidden ? {
      place: document.querySelector('[data-iss-scene]')?.dataset.issLaunchPlace ?? '',
      lines: [...issCard.querySelectorAll('[data-iss-launch-verdict], [data-iss-launch-plan] p, [data-iss-launch-note]')].map((line) => line.textContent),
      hidden: [...issCard.querySelectorAll('[data-iss-launch-verdict], [data-iss-launch-plan] p, [data-iss-launch-note], [data-iss-launch-plan-open]')]
        .filter((line) => line.getBoundingClientRect().height === 0).map((line) => line.textContent),
      reach: (() => {
        const open = issCard.querySelector('[data-iss-launch-plan-open]').getBoundingClientRect();
        if (open.height === 0) return false;
        const hit = document.elementFromPoint(open.left + open.width / 2, open.top + open.height / 2);
        return !!hit?.closest('[data-iss-launch-plan-open]');
      })(),
      box: box(issCard),
    } : null,
    corridorLayers: window.__opdMap.getStyle().layers.map((layer) => layer.id).filter((id) => id.includes('corridor')),
    viewport: { width: innerWidth, height: innerHeight },
  };
}

const overlaps = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);

const report = [];
const failures = [];

function checkCards(row) {
  const fail = (what) => failures.push(`${row.engine} ${row.size} ${row.shot}: ${what}`);
  if (row.errors.length) fail(`page errors ${row.errors.join(' | ')}`);
  if (!row.panel) return fail('the launch brief is not shown');
  if (!row.legend) fail('the Legend button is not shown');
  if (overlaps(row.panel, row.legend)) fail('the launch brief overlaps the Legend button');
  if (overlaps(row.panel, row.caption)) fail('the launch brief overlaps the hazard caption');
  if (row.panel.left < -0.5 || row.panel.top < -0.5 || row.panel.right > row.viewport.width + 0.5 || row.panel.bottom > row.viewport.height + 0.5) {
    fail('the launch brief leaves the viewport');
  }
  const likely = row.cards.find((card) => card.name === LIKELY.name);
  const watch = row.cards.find((card) => card.name === WATCH.name);
  if (!likely) fail('the Likely card is missing');
  else {
    if (likely.tier !== 'likely' || likely.why !== LIKELY.why) fail(`Likely card says "${likely.tier}: ${likely.why}"`);
    const want = [...LIKELY.ascent, LIKELY.direction, HONESTY, LIKELY.more];
    if (!same(likely.lines, want)) fail(`Likely plan is ${JSON.stringify(likely.lines)}`);
  }
  if (!watch) fail('the Watch card is missing');
  else {
    if (watch.tier !== 'watch' || watch.why !== WATCH.why) fail(`Watch card says "${watch.tier}: ${watch.why}"`);
    const want = [...WATCH.pad, WATCH.direction, HONESTY];
    if (!same(watch.lines, want)) fail(`Watch plan is ${JSON.stringify(watch.lines)}`);
    if (watch.lines.some((line) => line.startsWith('Ascent shot'))) fail('Watch card plans an ascent with no direction');
  }
}

mkdirSync(OUT, { recursive: true });
const server = await serveDist();
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  for (const [engine, browserType] of [['webkit', webkit], ['chromium', chromium]]) {
    const browser = await browserType.launch();
    try {
      const run = async ([width, height], shot, act) => {
        const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        const base = { engine, size: `${width}x${height}`, shot, file: `${engine}_${width}x${height}_${shot}.png` };
        try {
          await prepare(page);
          await openBrief(page, origin);
          if (act) await act(page);
          await page.waitForTimeout(600);
          const seen = await page.evaluate(probe);
          const row = { ...base, errors: errors.filter((error) => !error.includes('gibs.earthdata.nasa.gov')), ...seen };
          report.push(row);
          return { row, page, context };
        } catch (error) {
          await page.screenshot({ path: join(OUT, `ERROR_${base.file}`) }).catch(() => undefined);
          await context.close();
          const row = { ...base, errors: [String(error).split('\n')[0]], panel: null, legend: null, caption: null, cards: [], dialog: null, iss: null, corridorLayers: [], viewport: { width, height } };
          report.push(row);
          return { row, page: null, context: null };
        }
      };
      const finish = async ({ row, page, context }) => {
        if (!page) return;
        await page.screenshot({ path: join(OUT, row.file) });
        await context.close();
      };

      for (const size of SIZES) {
        const idle = await run(size, 'nothing-selected');
        checkCards(idle.row);
        await finish(idle);

        const picked = await run(size, 'launch-selected', async (page) => {
          await page.locator(`#map-launch-coverage .launch-tier[data-event-id="fixture-likely"] .launch-brief-actions .btn`).click();
          await page.waitForTimeout(1500);
          const launches = page.locator('#filter-launches-map');
          if (await launches.getAttribute('aria-expanded') !== 'true') await launches.click();
          await page.locator('#map-launch-coverage .launch-tier').first().waitFor({ state: 'visible', timeout: 10_000 });
        });
        checkCards(picked.row);
        await finish(picked);
      }

      for (const size of DETAIL_SIZES) {
        const details = await run(size, 'details-two-envelopes', async (page) => {
          await page.locator(`#map-launch-coverage .launch-tier[data-event-id="fixture-likely"] .launch-name`).click();
          await page.locator('.launch-dialog[open]').waitFor({ state: 'visible', timeout: 10_000 });
        });
        const fail = (what) => failures.push(`${engine} ${details.row.size} details-two-envelopes: ${what}`);
        const want = [...LIKELY.ascent, ...LIKELY.pad, LIKELY.direction, HONESTY];
        if (!details.row.dialog) fail('the details dialog did not open');
        else {
          if (details.row.dialog.title !== LIKELY.name) fail(`dialog title is "${details.row.dialog.title}"`);
          if (!same(details.row.dialog.lines, want)) fail(`dialog plan is ${JSON.stringify(details.row.dialog.lines)}`);
          const box = details.row.dialog.box;
          if (!box || box.left < -0.5 || box.top < -0.5 || box.right > size[0] + 0.5 || box.bottom > size[1] + 0.5) fail('the dialog leaves the viewport');
        }
        await finish(details);

        const iss = await run(size, 'iss-view-card', async (page) => {
          await page.locator('#tab-iss').click();
          const picker = page.locator('[data-iss-launch-picker]');
          await picker.waitFor({ state: 'visible', timeout: 20_000 });
          await picker.selectOption('fixture-likely');
          await page.locator('[data-iss-launch-card]:not([hidden]) [data-iss-launch-verdict]').waitFor({ state: 'attached', timeout: 10_000 });
          await page.waitForTimeout(1500);
        });
        const issFail = (what) => failures.push(`${engine} ${iss.row.size} iss-view-card: ${what}`);
        const issWant = [
          `Likely. ${LIKELY.why}`, LIKELY.ascent[1], LIKELY.ascent[3],
          LIKELY.direction.replace('Launch direction: ', ''), HONESTY,
        ];
        if (!iss.row.iss) issFail('the ISS view launch card is not shown');
        else {
          if (!same(iss.row.iss.lines, issWant)) issFail(`ISS card says ${JSON.stringify(iss.row.iss.lines)}`);
          const box = iss.row.iss.box;
          if (!box || box.left < -0.5 || box.right > size[0] + 0.5) issFail('the ISS card leaves the viewport sideways');
          const side = iss.row.iss.place === 'side';
          const all = [...issWant, 'Shot plan'];
          const want = !side ? all : size[1] > 564 ? [] : [LIKELY.ascent[1], LIKELY.ascent[3], issWant[3]];
          if (!same(iss.row.iss.hidden, want)) issFail(`ISS card hides ${JSON.stringify(iss.row.iss.hidden)} in place ${iss.row.iss.place}`);
          if (side && !iss.row.iss.reach) issFail('the Shot plan button cannot be tapped');
        }
        if (iss.page) {
          await iss.page.screenshot({ path: join(OUT, iss.row.file) });
          const opener = iss.row.iss?.place === 'side' ? '[data-iss-launch-plan-open]' : '[data-iss-launch-name]';
          await iss.page.locator(`[data-iss-launch-card] ${opener}`).click({ timeout: 5000 }).catch(() => undefined);
          await iss.page.waitForTimeout(400);
          const opened = (await iss.page.evaluate(probe)).dialog;
          iss.row.file = iss.row.file.replace('iss-view-card', 'iss-view-shot-plan');
          iss.row.opened = opened;
          if (!opened) issFail(`tapping ${opener} did not open the shot plan`);
          else if (!same(opened.lines, [...LIKELY.ascent, ...LIKELY.pad, LIKELY.direction, HONESTY])) issFail(`shot plan dialog says ${JSON.stringify(opened.lines)}`);
        }
        await finish(iss);
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
