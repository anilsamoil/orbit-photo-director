import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDeviceContext } from './fixture-session.mjs';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

export async function driveMapLightning({ baseUrl, evidenceDir, fixtureDir, fixtureToken, startOffset }) {
  const surface = process.env.OPD_VERIFY_SURFACE;
  const size = process.env.OPD_VERIFY_VIEWPORT;
  const phone = surface === 'iphone-17-pro' && size === '402x874';
  if (!phone && !(surface === 'ipad-pro-11' && ['1210x834', '820x1180'].includes(size))) {
    throw new Error('map-lightning expects ipad-pro-11 1210x834 or 820x1180, or iphone-17-pro 402x874');
  }
  const [width, height] = size.split('x').map(Number);
  const viewport = { width, height };
  const { reef } = JSON.parse(await readFile(join(fixtureDir, 'meta.json'), 'utf8'));
  const browser = await launchWebkit();
  try {
    const context = await createDeviceContext(browser, {
      ...deviceDescriptor({ name: phone ? 'iPhone 17 Pro' : 'iPad Pro 11' }),
      viewport, screen: viewport, deviceScaleFactor: phone ? 3 : 2,
    }, { baseUrl, token: fixtureToken, startOffset });
    await context.addInitScript(() => localStorage.setItem('opd-map-chrome', 'shown'));
    const page = await context.newPage();
    const evidence = { viewport, labels: {} };
    const readout = page.locator('#lightning-status');
    const toggle = page.getByRole('button', { name: 'Lightning', exact: true });
    let mode = 'observed';
    let requests = 0;
    await page.route('**/lightning/latest.json', async route => {
      requests += 1;
      if (mode === 'missing') return route.fulfill({ status: 404, body: '' });
      const end = Date.now() + startOffset - (mode === 'stale' ? 9 : 2) * 60_000;
      const utc = ms => new Date(ms).toISOString();
      await route.fulfill({ json: {
        schema: 1, start: utc(end - 300_000), end: utc(end), generated_at: utc(end + 30_000),
        radius_km: 5500, sectors: [
          { satellite: 'GOES-19', center_lon: -75.2, cells: [[-75, 10, 290, 7], [-75.5, 10, 10, 2]] },
          { satellite: 'GOES-18', center_lon: -137, cells: mode === 'partial' ? null : [] },
        ],
      } });
    });
    await page.goto(`${baseUrl}/?e2e`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__opdMap?.getLayer('targets-layer'));
    assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [width, height]);
    const follow = page.locator('#toggle-follow-iss');
    if (await follow.getAttribute('aria-pressed') === 'true') await follow.tap();
    const pan = async (lon, lat) => page.evaluate(center => window.__opdMap.jumpTo({ center, zoom: 4 }), [lon, lat]);
    const expectLabel = async (key, text) => {
      await page.waitForFunction(part => document.querySelector('#lightning-status')?.textContent.includes(part), text);
      evidence.labels[key] = await readout.innerText();
    };
    assert.equal(requests, 0);
    await pan(-75, 10);
    await toggle.tap();
    await expectLabel('east', '9 observed flashes');
    assert.equal(await readout.isVisible(), true);
    await page.waitForFunction(() => window.__opdMap.queryRenderedFeatures({ layers: ['lightning-layer'] }).length >= 2);
    evidence.flashPaint = await page.evaluate(() => window.__opdMap.queryRenderedFeatures({ layers: ['lightning-layer'] })
      .map(f => ({ age: f.properties.ageSeconds, opacity: f.layer.paint['circle-opacity'] }))
      .sort((a, b) => a.age - b.age));
    const newer = evidence.flashPaint[0], older = evidence.flashPaint.at(-1);
    assert.ok(newer.age < older.age && newer.opacity > older.opacity && older.opacity > 0);
    evidence.order = await page.evaluate(() => window.__opdMap.getStyle().layers.map(layer => layer.id));
    for (const above of ['targets-layer', 'iss-track-layer']) {
      assert.ok(evidence.order.indexOf('lightning-layer') < evidence.order.indexOf(above));
    }
    assert.ok(evidence.order.indexOf('geo-ir-layer') < evidence.order.indexOf('lightning-layer'));
    await page.locator('#toggle-ir').tap();
    await page.waitForFunction(() => window.__opdMap.getLayoutProperty('geo-ir-layer', 'visibility') === 'visible');
    evidence.ir = await page.locator('.map-imagery-date').innerText();
    assert.match(evidence.ir, /GOES-East.*(frame \d\d:\d\d UTC|feed unavailable)/);
    await page.screenshot({ path: join(evidenceDir, `map-lightning-${size}.png`) });
    await page.locator('#time-fwd-45').tap();
    await expectLabel('scrubbed', 'hidden at scrubbed time');
    assert.equal(await page.evaluate(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility')), 'none');
    await page.locator('#time-now').tap();
    await pan(-137, 5);
    await expectLabel('west', '0 observed flashes');
    await toggle.tap();
    mode = 'partial';
    await toggle.tap();
    await expectLabel('westIncomplete', 'GOES-18 sector · unavailable');
    await pan(-75, 10);
    await expectLabel('eastStillAvailable', '9 observed flashes');
    await pan(20, 15);
    await expectLabel('outside', 'outside GLM coverage');
    await pan(reef.lon, reef.lat);
    const pin = await page.waitForFunction(({ lon, lat }) => {
      const map = window.__opdMap;
      const point = map.project([lon, lat]);
      const hits = map.queryRenderedFeatures(point, { layers: ['targets-layer'] });
      if (!hits.some(hit => hit.properties.target_id === 'verify-reef')) return null;
      const rect = map.getCanvas().getBoundingClientRect();
      return [point.x + rect.left, point.y + rect.top];
    }, reef);
    const [x, y] = await pin.jsonValue();
    await page.touchscreen.tap(x, y);
    await page.locator('.maplibregl-popup').filter({ hasText: 'Verify Reef' }).waitFor();
    evidence.targetOpened = 'Verify Reef';
    await page.locator('.maplibregl-popup-close-button').first().click();
    await pan(-75, 10);
    for (const [state, text] of [['stale', 'stale'], ['missing', 'Feed unavailable']]) {
      await toggle.tap();
      mode = state;
      await toggle.tap();
      await expectLabel(state, text);
      assert.equal(await page.evaluate(() => window.__opdMap.getLayoutProperty('lightning-layer', 'visibility')), 'none');
    }
    await toggle.tap();
    assert.equal(await readout.isVisible(), false);
    await writeFile(join(evidenceDir, `map-lightning-${size}.json`), JSON.stringify(evidence, null, 2));
    return `map-lightning WebKit ${size} created-at-size: IR, circles, order, clock, zero, stale, unavailable, coverage passed`;
  } finally {
    await browser.close();
  }
}
