import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const ORIGIN = process.env.HAZARD_ORIGIN ?? 'http://127.0.0.1:5199';
const OUT = '/opt/cursor/artifacts';
const CATALOG_PATH = new URL('../test/fixtures/starship-catalog-2026-11-10.json', import.meta.url);
const LABEL = 'Published hazard areas \u2014 not a flight path';
const INSIDE = Date.parse('2026-11-13T22:50:00Z');
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
const SIZES = [
  [1024, 768],
  [1180, 820],
  [834, 1210],
  [874, 402],
  [402, 874],
];

function catalogFor(nowMs) {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  catalog.generated_at = new Date(nowMs - 60_000).toISOString();
  catalog.geometry_valid_until = new Date(nowMs + 10 * 60_000).toISOString();
  catalog.schedule_valid_until = new Date(nowMs + 60 * 60_000).toISOString();
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

function manifestFor(nowMs) {
  return {
    version: new Date(nowMs).toISOString().replace(/[-:]/g, '').replace('.000', ''),
    generated_at: new Date(nowMs - 30_000).toISOString(),
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

function trackFor(nowMs) {
  return {
    iss_polynomial: {
      start: new Date(nowMs - 60_000).toISOString(),
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

async function prepare(page, nowMs) {
  const { text, pointer } = catalogFor(nowMs);
  await page.addInitScript((frozen) => {
    Date.now = () => frozen;
    localStorage.setItem('opd-map-chrome', 'shown');
  }, nowMs);
  const json = (route, body) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  await page.route('**/api/browser/session', (route) => json(route, {
    ok: true,
    profile: { name: 'anil', displayName: 'Anil' },
    profiles: [{ name: 'anil', displayName: 'Anil' }],
  }));
  await page.route('**/manifest.json', (route) => json(route, manifestFor(nowMs)));
  await page.route('**/v/browser/passes.json', (route) => json(route, []));
  await page.route('**/v/browser/top5.json', (route) => json(route, []));
  await page.route('**/v/browser/track.json', (route) => json(route, trackFor(nowMs)));
  await page.route('**/launch/catalog/latest.json', (route) => json(route, pointer));
  await page.route('**/launch/catalog/v/**', (route) => json(route, text));
  await page.route('**/launch/latest.json', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: '{"error":"not_found"}',
  }));
}

async function openLaunches(page) {
  await page.goto(`${ORIGIN}/?e2e&u=anil`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__opdMap && window.__opdMap.isStyleLoaded(), null, { timeout: 30_000 });
  const launches = page.locator('#filter-launches-map');
  if (await launches.getAttribute('aria-pressed') !== 'true') await launches.click();
  await page.waitForFunction((label) => {
    const caption = document.getElementById('launch-hazard-caption');
    return caption && caption.hidden === false && caption.textContent === label;
  }, LABEL, { timeout: 20_000 });
}

function captionProbe() {
  const selectors = ['#map-launch-coverage', '.map-toolbar', '.map-control-dock', '.map-controls-time', '#map-legend-toggle', '#map-legend-panel', '#map-chrome-toggle', '.maplibregl-ctrl-group'];
  const caption = document.getElementById('launch-hazard-caption');
  const range = document.createRange();
  range.selectNodeContents(caption);
  const boxes = [caption.getBoundingClientRect(), ...range.getClientRects()].map((box) => ({
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
  const view = { width: window.innerWidth, height: window.innerHeight };
  const outside = boxes.filter((box) => box.left < -0.5 || box.top < -0.5 || box.right > view.width + 0.5 || box.bottom > view.height + 0.5 || box.width < 1);
  return {
    text: caption.textContent,
    hidden: caption.hidden,
    rangeText: range.toString(),
    hits: [...new Set(hits)],
    outside,
    legend: !!document.getElementById('map-legend-toggle'),
  };
}

function polygonProbe() {
  const controls = ['#map-launch-coverage', '.map-toolbar', '.map-control-dock', '.map-controls-time', '#map-legend-toggle', '#map-legend-panel', '#map-chrome-toggle', '.maplibregl-ctrl-group'];
  const map = window.__opdMap;
  const source = map.getSource('launch-hazards');
  const data = source && (source._data.geojson || source._data);
  const panels = [];
  for (const selector of controls) {
    for (const node of document.querySelectorAll(selector)) {
      if (node.hidden) continue;
      const box = node.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      panels.push({ selector, left: box.left, top: box.top, right: box.right, bottom: box.bottom });
    }
  }
  const canvas = map.getCanvas().getBoundingClientRect();
  const covered = (point) => panels.some((panel) => (
    point.x > panel.left + 0.5 && point.x < panel.right - 0.5 && point.y > panel.top + 0.5 && point.y < panel.bottom - 0.5
  ));
  const areas = {};
  for (const feature of data.features ?? []) {
    const ring = feature.geometry.coordinates[0];
    const samples = ring.map(([lon, lat]) => map.project([lon, lat]));
    let lon = 0;
    let lat = 0;
    for (const position of ring) {
      lon += position[0];
      lat += position[1];
    }
    samples.push(map.project([lon / ring.length, lat / ring.length]));
    const clear = samples.filter((point) => (
      point.x >= canvas.left && point.x <= canvas.right && point.y >= canvas.top && point.y <= canvas.bottom && !covered(point)
    ));
    areas[feature.properties.area_id] = clear.length;
  }
  const center = map.getCenter();
  return { areas, bearing: map.getBearing(), zoom: map.getZoom(), lng: center.lng, lat: center.lat };
}

function cardProbe() {
  const details = document.querySelector('#map-launch-coverage .map-launch-primary');
  if (details) details.open = true;
  const note = document.querySelector('#map-launch-coverage [data-hazard-note]');
  return {
    text: note ? note.textContent : '',
    hrefs: note ? [...note.querySelectorAll('a')].map((link) => link.textContent) : [],
  };
}

const report = [];
const engines = [
  ['webkit', webkit],
  ['chromium', chromium],
];

for (const [name, browserType] of engines) {
  const browser = await browserType.launch();
  try {
    for (const [width, height] of SIZES) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await prepare(page, INSIDE);
      await openLaunches(page);
      const follow = page.locator('#toggle-follow-iss');
      if ((await follow.getAttribute('class'))?.includes('active')) await follow.click();
      await page.evaluate(() => window.__opdMap.setBearing(143.26));
      const show = page.locator('#map-launch-coverage .launch-brief-actions .btn');
      if (await show.count()) await show.click();
      await page.waitForTimeout(2200);
      const caption = await page.evaluate(captionProbe);
      const polygons = await page.evaluate(polygonProbe);
      const card = await page.evaluate(cardProbe);
      const shot = (width === 874 && height === 402) || (width === 1024 && height === 768) || (width === 1180 && height === 820);
      const file = shot ? `${name}_hazard_${width}x${height}.png` : null;
      if (file) await page.screenshot({ path: `${OUT}/${file}`, fullPage: false });
      report.push({ engine: name, size: `${width}x${height}`, caption, polygons, card, errors, file });
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    let hazardStatus = 200;
    let hazardFetches = 0;
    await prepare(page, INSIDE);
    await page.route('**/hazards/v1/**', (route) => {
      hazardFetches += 1;
      if (hazardStatus === 404) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"missing"}' });
      }
      return route.continue();
    });
    await openLaunches(page);
    const before = hazardFetches;
    hazardStatus = 404;
    await page.evaluate(() => {
      const proto = Document.prototype;
      const original = Object.getOwnPropertyDescriptor(proto, 'visibilityState');
      const set = (value) => {
        Object.defineProperty(proto, 'visibilityState', { configurable: true, get: () => value });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      set('hidden');
      set('visible');
      if (original) Object.defineProperty(proto, 'visibilityState', original);
    });
    await page.waitForFunction(() => {
      const source = window.__opdMap.getSource('launch-hazards');
      const data = source && (source._data.geojson || source._data);
      return (data?.features ?? []).length === 0;
    }, null, { timeout: 15_000 });
    const clearedFetches = hazardFetches;
    hazardStatus = 200;
    await page.evaluate(() => {
      const proto = Document.prototype;
      const original = Object.getOwnPropertyDescriptor(proto, 'visibilityState');
      const set = (value) => {
        Object.defineProperty(proto, 'visibilityState', { configurable: true, get: () => value });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      set('hidden');
      set('visible');
      if (original) Object.defineProperty(proto, 'visibilityState', original);
    });
    await page.waitForFunction(() => {
      const source = window.__opdMap.getSource('launch-hazards');
      const data = source && (source._data.geojson || source._data);
      const areas = new Set((data?.features ?? []).map((feature) => feature.properties && feature.properties.area_id));
      return areas.has('A') && areas.has('B') && areas.has('6/7129');
    }, null, { timeout: 15_000 });
    report.push({
      engine: name,
      size: 'catalog-refresh-after-404',
      before,
      clearedFetches,
      restoredFetches: hazardFetches,
    });
    await context.close();
  } finally {
    await browser.close();
  }
}

const failed = report.filter((row) => {
  const errors = (row.errors ?? []).filter((error) => !error.includes('gibs.earthdata.nasa.gov'));
  if (errors.length) return true;
  if (row.size === 'catalog-refresh-after-404') return row.clearedFetches <= row.before || row.restoredFetches <= row.clearedFetches;
  const caption = row.caption;
  const polygons = row.polygons.areas ?? {};
  const card = row.card.text ?? '';
  return caption.text !== LABEL || caption.hidden || caption.rangeText !== LABEL
    || caption.hits.length > 0 || caption.outside.length > 0 || !caption.legend
    || polygons.A < 1 || polygons.B < 1 || polygons['6/7129'] < 1
    || !card.includes('NAVAREA IV 1080/26') || !card.includes('area A') || !card.includes('maritime')
    || !card.includes('UTC') || !/CST|CDT/.test(card) || !card.includes('Checked 2026-11-13T10:02:00Z')
    || !card.includes('three hours prior to the earliest launch') || !card.includes('SFC-UNL')
    || !card.includes('international waters')
    || !row.card.hrefs.some((href) => href.startsWith('https://'));
});
writeFileSync(`${OUT}/hazard-layout-report.json`, JSON.stringify({ failed: failed.length, report }, null, 2));
console.log(JSON.stringify({ failed: failed.length, report }, null, 2));
if (failed.length) process.exit(1);
