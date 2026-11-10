import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDeviceContext } from './fixture-session.mjs';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

export const MAP_LIGHTNING_SURFACES = [
  { id: 'webkit-iphone-17-pro-402x874', surface: 'iphone-17-pro', width: 402, height: 874, scale: 3, desktop: false, device: 'iPhone 17 Pro' },
  { id: 'webkit-iphone-17-pro-874x402', surface: 'iphone-17-pro', width: 874, height: 402, scale: 3, desktop: false, device: 'iPhone 17 Pro' },
  { id: 'webkit-ipad-m4-834x1210', surface: 'ipad-pro-11', width: 834, height: 1210, scale: 2, desktop: false, device: 'iPad Pro 11' },
  { id: 'webkit-ipad-m4-1210x834', surface: 'ipad-pro-11', width: 1210, height: 834, scale: 2, desktop: false, device: 'iPad Pro 11' },
  { id: 'webkit-ipad-m4-820x1180', surface: 'ipad-pro-11', width: 820, height: 1180, scale: 2, desktop: false, device: 'iPad Pro 11' },
  { id: 'webkit-ipad-3-768x1024', surface: 'ipad-3', width: 768, height: 1024, scale: 2, desktop: false, device: 'iPad (3rd generation)', deviceBase: 'iPad (gen 5)' },
  { id: 'webkit-desktop-1440x900', surface: 'desktop', width: 1440, height: 900, scale: 1, desktop: true },
];

const HELP = 'drive map-lightning is one WebKit process per surface. Set OPD_VERIFY_SURFACE and OPD_VERIFY_VIEWPORT to iphone-17-pro 402x874 or 874x402, ipad-pro-11 834x1210, 1210x834, or 820x1180, ipad-3 768x1024, or desktop 1440x900. The context is created at that size. drive map and drive all leave this probe out.';

export function mapLightningPlan(surface, viewport) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = MAP_LIGHTNING_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return plan;
}

function contextOptions(plan) {
  const viewport = { width: plan.width, height: plan.height };
  if (plan.desktop) {
    return {
      viewport,
      screen: viewport,
      deviceScaleFactor: plan.scale,
      isMobile: false,
      hasTouch: false,
    };
  }
  const spec = { name: plan.device, viewport, deviceScaleFactor: plan.scale };
  if (plan.deviceBase) spec.deviceBase = plan.deviceBase;
  return {
    ...deviceDescriptor(spec),
    viewport,
    screen: viewport,
    deviceScaleFactor: plan.scale,
  };
}

export async function driveMapLightning({ baseUrl, evidenceDir, fixtureDir, fixtureToken, startOffset }) {
  const plan = mapLightningPlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT);
  const size = `${plan.width}x${plan.height}`;
  const { width, height } = plan;
  const { reef } = JSON.parse(await readFile(join(fixtureDir, 'meta.json'), 'utf8'));
  const browser = await launchWebkit();
  let page;
  let phase = 'boot';
  try {
    const context = await createDeviceContext(browser, contextOptions(plan), { baseUrl, token: fixtureToken, startOffset });
    await context.addInitScript(() => localStorage.setItem('opd-map-chrome', 'shown'));
    page = await context.newPage();
    const press = (locator) => (plan.desktop ? locator.click() : locator.tap());
    const evidence = { viewport: { width, height }, labels: {} };
    const readout = page.locator('#lightning-status');
    const toggle = page.getByRole('button', { name: 'Lightning', exact: true });
    let mode = 'observed';
    let requests = 0;
    let observationEnd;
    let heldEnd;
    const sectorCells = (count, lon, lat) => Array.from({ length: count }, (_, index) => [
      Math.round((lon + (index % 16) * 0.02) * 1e3) / 1e3,
      Math.round((lat + Math.floor(index / 16) * 0.02) * 1e3) / 1e3,
      (index % 299) + 1,
      1,
    ]);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const nextPoll = async (key) => {
      phase = key;
      const seen = requests;
      const deadline = Date.now() + 130_000;
      while (requests <= seen) {
        if (Date.now() > deadline) throw new Error(`poll did not fire (${key}, seen ${seen})`);
        await wait(200);
      }
      await wait(400);
    };
    const flashCoords = () => page.evaluate(() => {
      const data = window.__opdMap.getSource('lightning')._data;
      const geojson = data.geojson || data;
      return geojson.features.map((feature) => feature.geometry.coordinates);
    });
    let releaseLoading;
    let loadingStarted;
    let loadingFinished;
    const loading = new Promise(resolve => { loadingStarted = resolve; });
    const resumeLoading = new Promise(resolve => { releaseLoading = resolve; });
    const completedLoading = new Promise(resolve => { loadingFinished = resolve; });
    await page.route('**/lightning/latest.json', async route => {
      requests += 1;
      if (mode === 'loading') {
        loadingStarted();
        await resumeLoading;
        await route.fulfill({ status: 404, body: '' }).catch(() => {});
        loadingFinished();
        return;
      }
      if (mode === 'missing') return route.fulfill({ status: 404, body: '' });
      const age = mode === 'expiry' ? 475_000 : (mode === 'stale' ? 9 : 2) * 60_000;
      const end = mode === 'held' ? heldEnd : Date.now() + startOffset - age;
      observationEnd = end;
      const utc = ms => new Date(ms).toISOString();
      const east = mode === 'overlap'
        ? [[reef.lon, reef.lat, 290, 7]]
        : mode === 'overcap'
          ? sectorCells(513, -75, 10)
          : mode === 'full'
            ? sectorCells(512, -75, 10)
            : [[-75, 10, 290, 7], [-75.5, 10, 10, 2]];
      const west = mode === 'partial' ? null : mode === 'full' ? sectorCells(512, -137, 5) : [];
      const sectors = mode === 'duplicate'
        ? [
            { satellite: 'GOES-19', center_lon: -75.2, cells: [[-75, 10, 10, 1]] },
            { satellite: 'GOES-19', center_lon: -75.2, cells: [[-80, 4, 10, 1]] },
          ]
        : [
            { satellite: 'GOES-19', center_lon: -75.2, cells: east },
            { satellite: 'GOES-18', center_lon: -137, cells: west },
          ];
      await route.fulfill({ json: {
        schema: 1, start: utc(end - 300_000), end: utc(end), generated_at: utc(end + 30_000),
        radius_km: 5500, sectors,
      } });
    });
    await page.goto(`${baseUrl}/?e2e`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__opdMap?.getLayer('targets-layer'));
    assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [width, height]);
    const follow = page.locator('#toggle-follow-iss');
    if (await follow.getAttribute('aria-pressed') === 'true') await press(follow);
    const pan = async (lon, lat) => page.evaluate(center => window.__opdMap.jumpTo({ center, zoom: 4 }), [lon, lat]);
    const expectLabel = async (key, text) => {
      phase = key;
      await page.waitForFunction(part => document.querySelector('#lightning-status')?.textContent.includes(part), text);
      evidence.labels[key] = await readout.textContent();
    };
    assert.equal(requests, 0);
    await pan(-75, 10);
    await press(toggle);
    await expectLabel('east', '9 observed flashes');
    const legendExpanded = await page.locator('#map-legend-toggle').getAttribute('aria-expanded');
    assert.equal(legendExpanded, 'false');
    assert.equal(await readout.isVisible(), false);
    evidence.legendClosed = { ariaExpanded: legendExpanded, statusVisible: false };
    await page.waitForFunction(() => {
      const map = window.__opdMap;
      const canvas = map?.getCanvas();
      if (!canvas || canvas.tagName !== 'CANVAS') return false;
      const rect = canvas.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return false;
      const features = map.queryRenderedFeatures({ layers: ['lightning-layer'] });
      const onCanvas = features.filter((feature) => {
        const point = map.project(feature.geometry.coordinates);
        return point.x >= 0 && point.y >= 0 && point.x <= rect.width && point.y <= rect.height;
      });
      return onCanvas.length >= 2;
    });
    evidence.canvasPaint = await page.evaluate(() => {
      const map = window.__opdMap;
      const canvas = map.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const features = map.queryRenderedFeatures({ layers: ['lightning-layer'] });
      const onCanvas = features.filter((feature) => {
        const point = map.project(feature.geometry.coordinates);
        return point.x >= 0 && point.y >= 0 && point.x <= rect.width && point.y <= rect.height;
      });
      return { tag: canvas.tagName, width: rect.width, height: rect.height, rendered: features.length, onCanvas: onCanvas.length };
    });
    assert.equal(evidence.canvasPaint.tag, 'CANVAS');
    assert.ok(evidence.canvasPaint.onCanvas >= 2);
    await page.screenshot({ path: join(evidenceDir, `map-lightning-legend-closed-${size}.png`) });
    evidence.flashPaint = await page.evaluate(() => window.__opdMap.queryRenderedFeatures({ layers: ['lightning-layer'] })
      .map(f => ({ age: f.properties.ageSeconds, opacity: f.layer.paint['circle-opacity'] }))
      .sort((a, b) => a.age - b.age));
    const newer = evidence.flashPaint[0], older = evidence.flashPaint.at(-1);
    assert.ok(newer.age < older.age && newer.opacity > older.opacity && older.opacity > 0);
    evidence.movement = await page.evaluate(() => {
      const map = window.__opdMap;
      const originalNow = Date.now;
      const heldNow = Date.now();
      Date.now = () => heldNow;
      map.fire('moveend');
      const source = map.getSource('lightning');
      const original = source.setData;
      let uploads = 0;
      source.setData = function (...args) { uploads += 1; return original.apply(this, args); };
      const status = document.getElementById('lightning-status');
      const observer = new MutationObserver(() => {});
      observer.observe(status, { childList: true });
      for (let i = 0; i < 60; i++) map.fire('moveend');
      const statusWrites = observer.takeRecords().length;
      observer.disconnect();
      source.setData = original;
      Date.now = originalNow;
      return { moves: 60, atMs: heldNow, uploads, statusWrites };
    });
    assert.equal(evidence.movement.uploads, 0);
    assert.equal(evidence.movement.statusWrites, 0);
    await press(toggle);
    mode = 'loading';
    await press(toggle);
    await loading;
    await expectLabel('loading', 'Loading observations');
    await press(toggle);
    mode = 'observed';
    await press(toggle);
    await expectLabel('newRequest', '9 observed flashes');
    releaseLoading();
    await completedLoading;
    await expectLabel('afterCancelledRequest', '9 observed flashes');
    evidence.loadingToggle = { requests, retainedNewFeed: true };
    evidence.order = await page.evaluate(() => window.__opdMap.getStyle().layers.map(layer => layer.id));
    for (const above of ['targets-layer', 'iss-track-layer']) {
      assert.ok(evidence.order.indexOf('lightning-layer') < evidence.order.indexOf(above));
    }
    assert.ok(evidence.order.indexOf('geo-ir-layer') < evidence.order.indexOf('lightning-layer'));
    await press(page.locator('#toggle-ir'));
    await page.waitForFunction(() => window.__opdMap.getLayoutProperty('geo-ir-layer', 'visibility') === 'visible');
    evidence.ir = await page.locator('.map-imagery-date').textContent();
    assert.match(evidence.ir, /GOES-East.*(frame \d\d:\d\d UTC|feed unavailable)/);
    evidence.rollback = await page.evaluate(end => {
      const original = Date.now;
      Date.now = () => end - 1;
      window.__opdMap.fire('moveend');
      const result = {
        visibility: window.__opdMap.getLayoutProperty('lightning-layer', 'visibility'),
        text: document.getElementById('lightning-status').textContent,
      };
      Date.now = original;
      document.dispatchEvent(new Event('visibilitychange'));
      return result;
    }, observationEnd);
    assert.equal(evidence.rollback.visibility, 'none');
    assert.match(evidence.rollback.text, /ahead of clock/);
    await page.waitForFunction(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility') === 'visible');
    await page.screenshot({ path: join(evidenceDir, `map-lightning-${size}.png`) });
    await press(page.locator('#time-fwd-45'));
    await expectLabel('scrubbed', 'hidden at scrubbed time');
    assert.equal(await page.evaluate(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility')), 'none');
    await press(page.locator('#time-now'));
    for (const [key, lon, owner] of [
      ['boundaryWest', -106.101, 'GOES-18'],
      ['boundaryTie', -106.1, 'GOES-19'],
      ['boundaryEast', -106.099, 'GOES-19'],
    ]) {
      await pan(lon, 0);
      await expectLabel(key, `${owner} sector`);
    }
    await pan(-137, 5);
    await expectLabel('west', '0 observed flashes');
    await press(toggle);
    mode = 'partial';
    await press(toggle);
    await expectLabel('westIncomplete', 'GOES-18 sector · unavailable');
    await pan(-75, 10);
    await expectLabel('eastStillAvailable', '9 observed flashes');
    await pan(20, 15);
    await expectLabel('outside', 'outside GLM coverage');
    await press(toggle);
    mode = 'overlap';
    await press(toggle);
    await pan(reef.lon, reef.lat);
    phase = 'pin-overlap';
    const pin = await page.waitForFunction(({ lon, lat }) => {
      const map = window.__opdMap;
      const point = map.project([lon, lat]);
      const hits = map.queryRenderedFeatures(point, { layers: ['targets-layer'] });
      if (!hits.some(hit => hit.properties.target_id === 'verify-reef')) return null;
      const flashes = map.queryRenderedFeatures(point, { layers: ['lightning-layer'] });
      const overlap = flashes.map(hit => {
        const dot = map.project(hit.geometry.coordinates);
        return {
          coordinates: hit.geometry.coordinates,
          pixelDistance: Math.hypot(dot.x - point.x, dot.y - point.y),
          radius: hit.layer.paint['circle-radius'],
          opacity: hit.layer.paint['circle-opacity'],
        };
      }).find(dot => dot.opacity > 0 && dot.pixelDistance <= dot.radius);
      if (!overlap) return null;
      const rect = map.getCanvas().getBoundingClientRect();
      return { touch: [point.x + rect.left, point.y + rect.top],
        pin: [lon, lat], dot: overlap };
    }, reef);
    evidence.overlap = await pin.jsonValue();
    const [x, y] = evidence.overlap.touch;
    await page.screenshot({ path: join(evidenceDir, `map-lightning-overlap-${size}.png`) });
    if (plan.desktop) await page.mouse.click(x, y);
    else await page.touchscreen.tap(x, y);
    await page.locator('.maplibregl-popup').filter({ hasText: 'Verify Reef' }).waitFor();
    evidence.targetOpened = 'Verify Reef';
    await page.locator('.maplibregl-popup-close-button').first().click();
    await pan(-75, 10);
    heldEnd = observationEnd;
    if (!Number.isFinite(heldEnd)) throw new Error('map-lightning held window missing');
    mode = 'held';
    phase = 'forward-jump';
    const pageNow = await page.evaluate(() => Date.now());
    await page.evaluate((jumped) => {
      globalThis.__opdLightningNow = Date.now;
      Date.now = () => jumped;
      window.__opdMap.fire('moveend');
    }, pageNow + 3_600_000);
    await expectLabel('forwardJump', 'stale');
    assert.equal(await page.evaluate(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility')), 'none');
    const pollsAtJump = requests;
    await nextPoll('forwardPoll');
    evidence.clockJump = { pollsAtJump, pollsWhileJumped: requests };
    assert.ok(requests > pollsAtJump);
    await expectLabel('forwardPolled', 'stale');
    assert.equal(await page.evaluate(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility')), 'none');
    mode = 'observed';
    await page.evaluate(() => {
      Date.now = globalThis.__opdLightningNow;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const pollsAtRestore = requests;
    await nextPoll('resumePoll');
    evidence.clockJump.pollsAfterRestore = requests;
    assert.ok(requests > pollsAtRestore);
    phase = 'resumed';
    await page.waitForFunction(() => {
      const text = document.querySelector('#lightning-status')?.textContent ?? '';
      return /feed [0-3]m old/.test(text) && !text.includes('stale') && !text.includes('ahead of clock');
    });
    evidence.labels.resumed = await readout.textContent();
    assert.equal(await page.evaluate(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility')), 'visible');
    const kept = await flashCoords();
    assert.ok(kept.length > 0);
    mode = 'overcap';
    await nextPoll('overcap');
    await expectLabel('overcap', 'refresh unavailable');
    assert.deepEqual(await flashCoords(), kept);
    mode = 'duplicate';
    await nextPoll('duplicate');
    await expectLabel('duplicate', 'refresh unavailable');
    assert.deepEqual(await flashCoords(), kept);
    evidence.rejection = { kept: kept.length, overcap: 513, duplicate: 'GOES-19' };
    mode = 'full';
    await pan(-75, 10);
    await nextPoll('full');
    await expectLabel('full', '512 observed flashes');
    const accepted = await flashCoords();
    assert.equal(accepted.length, 1024);
    evidence.cap = { perSatellite: 512, accepted: accepted.length };
    assert.equal(await page.evaluate(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility')), 'visible');
    assert.equal((await readout.textContent() ?? '').includes('refresh unavailable'), false);
    await page.screenshot({ path: join(evidenceDir, `map-lightning-cap-${size}.png`) });
    await press(toggle);
    mode = 'expiry';
    phase = 'expiry-visible';
    await press(toggle);
    await page.waitForFunction(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility') === 'visible');
    phase = 'expiry-hidden';
    await page.waitForFunction(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility') === 'none', null, { timeout: 8_000 });
    await expectLabel('exactExpiry', 'stale');
    evidence.expiration = { deadline: observationEnd + 480_000, hiddenAt: Date.now() + startOffset };
    for (const [state, text] of [['stale', 'stale'], ['missing', 'Feed unavailable']]) {
      await press(toggle);
      mode = state;
      await press(toggle);
      await expectLabel(state, text);
      assert.equal(await page.evaluate(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility')), 'none');
    }
    await press(toggle);
    assert.equal(await readout.isVisible(), false);
    await writeFile(join(evidenceDir, `map-lightning-${size}.json`), JSON.stringify(evidence, null, 2));
    return `map-lightning WebKit ${size} created-at-size: legend aria-expanded=false, canvas ${evidence.canvasPaint.onCanvas}, IR, circles, order, clock, jump, cap, dedupe, zero, stale, unavailable, coverage passed`;
  } catch (error) {
    const state = page ? await page.evaluate(() => ({
      label: document.getElementById('lightning-status')?.textContent,
      center: window.__opdMap?.getCenter(),
      visibility: window.__opdMap?.getLayoutProperty('lightning-layer', 'visibility'),
      dots: window.__opdMap?.queryRenderedFeatures({ layers: ['lightning-layer'] }).map(f => f.geometry),
    })).catch(() => null) : null;
    if (page) await page.screenshot({ path: join(evidenceDir, `map-lightning-failed-${size}.png`) }).catch(() => {});
    throw new Error(`map-lightning ${phase}: ${error.message}; state ${JSON.stringify(state)}`, { cause: error });
  } finally {
    await browser.close();
  }
}
