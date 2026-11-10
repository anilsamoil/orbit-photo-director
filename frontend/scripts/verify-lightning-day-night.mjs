import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, devices, webkit } from 'playwright';
import { closeBrowser, launchTracked } from '../test/close-browser.mjs';
import { installFrozenDate } from '../test/frozen-date.mjs';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:41731' },
  output: { type: 'string', default: '/tmp/opd-lightning-day-night' },
} });
const base = new URL(values.url);
assert(['127.0.0.1', 'localhost'].includes(base.hostname), 'This verifier requires the local OPD fixture server');
base.searchParams.set('e2e', '');
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const now = Date.parse('2026-11-10T12:00:00Z');
const strikes = [
  { side: 'night', coordinates: [-110, 5] },
  { side: 'day', coordinates: [-70, 5] },
];
const feed = {
  schema: 1, start: '2026-11-10T11:54:00Z', end: '2026-11-10T11:59:00Z',
  generated_at: '2026-11-10T11:59:30Z', radius_km: 5500,
  sectors: [
    { satellite: 'GOES-19', center_lon: -75.2, cells: strikes.map(({ coordinates }) => [...coordinates, 290, 1]) },
    { satellite: 'GOES-18', center_lon: -137, cells: [] },
  ],
};
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const results = [];

async function paint(page) {
  await page.evaluate(() => new Promise(resolveFrame => {
    const map = window.__opdMap;
    map.once('render', () => requestAnimationFrame(() => resolveFrame()));
    map.triggerRepaint();
  }));
}

async function pixels(page, file) {
  await paint(page);
  const canvas = page.locator('#map canvas.maplibregl-canvas');
  const image = await canvas.screenshot({ path: resolve(output, file), scale: 'css' });
  return page.evaluate(async ({ png, samples }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return samples.map(({ side, coordinates }) => {
      const { x, y } = window.__opdMap.project(coordinates);
      const data = context.getImageData(Math.round(x) - 7, Math.round(y) - 7, 15, 15).data;
      let yellow = 0;
      let peak = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) {
        const rgb = [data[i], data[i + 1], data[i + 2]];
        if (rgb[0] > 180 && rgb[1] > 150 && rgb[2] < 150 && rgb[0] > 1.5 * rgb[2]) yellow += 1;
        if (rgb[0] + rgb[1] > peak[0] + peak[1]) peak = rgb;
      }
      return { side, yellow, peak };
    });
  }, { png: image.toString('base64'), samples: strikes });
}

async function toggle(page, id, enabled) {
  const button = page.locator(`#${id}`);
  if ((await button.getAttribute('aria-pressed') === 'true') !== enabled) await button.click();
  await paint(page);
}

for (const surface of [
  { name: 'chromium-desktop-1440x900', engine: chromium, context: { viewport: { width: 1440, height: 900 } } },
  { name: 'webkit-ipad-820x1180', engine: webkit, context: { ...devices['iPad Pro 11'], viewport: { width: 820, height: 1180 } } },
  { name: 'webkit-ipad-1210x834', engine: webkit, context: { ...devices['iPad Pro 11'], viewport: { width: 1210, height: 834 } } },
]) {
  const session = await launchTracked(surface.engine, surface.engine === chromium ? { channel: 'chrome', headless: true } : { headless: true });
  try {
    const context = await session.browser.newContext({ ...surface.context, serviceWorkers: 'block' });
    await context.addInitScript(installFrozenDate, now);
    await context.addInitScript(() => localStorage.setItem('opd-map-chrome', 'shown'));
    const page = await context.newPage();
    const transparentRaster = Buffer.from(await page.evaluate(() => document.createElement('canvas').toDataURL().split(',')[1]), 'base64');
    await page.route('**/lightning/latest.json', route => route.fulfill({ json: feed }));
    await page.route(/(?:gibs\.earthdata\.nasa\.gov|server\.arcgisonline\.com|realearth\.ssec\.wisc\.edu)\//, route =>
      route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' },
        body: route.request().url().includes('/Reference/') ? transparentRaster : raster }));
    await page.goto(base.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__opdMap?.getLayer('targets-layer'));
    await toggle(page, 'toggle-follow-iss', false);
    await page.evaluate(() => window.__opdMap.jumpTo({ center: [-90, 5], zoom: 2, bearing: 0, pitch: 0 }));
    await toggle(page, 'toggle-lightning', true);
    await page.waitForFunction(() => window.__opdMap.getSource('lightning')?.loaded());
    const row = { surface: surface.name, states: [] };
    for (const nightLights of [false, true]) {
      await toggle(page, 'toggle-night-lights', nightLights);
      for (const terminator of [false, true]) {
        await toggle(page, 'toggle-terminator', terminator);
        const key = `${surface.name}-terminator-${terminator}-lights-${nightLights}`;
        const order = await page.evaluate(() => window.__opdMap.getStyle().layers.map(layer => layer.id));
        assert(order.includes('lightning-layer'), 'The lightning layer exists');
        for (const under of ['terminator-night-fill-layer', 'viirs-night-lights-layer']) {
          assert(order.includes(under), `${under} exists`);
          assert(order.indexOf(under) < order.indexOf('lightning-layer'), `${under} paints below lightning`);
        }
        for (const above of ['iss-track-layer', 'targets-layer', 'esri-labels-reference-layer']) {
          assert(order.includes(above), `${above} exists`);
          assert(order.indexOf(above) > order.indexOf('lightning-layer'), `${above} remains above lightning`);
        }
        const lightsVisibility = await page.evaluate(() => window.__opdMap.getLayoutProperty('viirs-night-lights-layer', 'visibility'));
        assert.equal(lightsVisibility, nightLights ? 'visible' : 'none', 'The VIIRS layer follows the night-lights toggle');
        if (terminator) {
          const sides = await page.evaluate(samples => samples.map(({ coordinates }) =>
            window.__opdMap.queryRenderedFeatures(window.__opdMap.project(coordinates), { layers: ['terminator-night-fill-layer'] }).length > 0), strikes);
          assert.deepEqual(sides, [true, false], 'The strikes lie on opposite sides of the real terminator fill');
        }
        const painted = await pixels(page, `${key}-painted.png`);
        await toggle(page, 'toggle-lightning', false);
        const cleared = await pixels(page, `${key}-cleared.png`);
        for (let i = 0; i < strikes.length; i += 1) {
          assert(painted[i].yellow - cleared[i].yellow >= 8, `${key} ${strikes[i].side} strike adds yellow pixels`);
        }
        row.states.push({ terminator, nightLights, lightsVisibility, painted, cleared, order });
        await toggle(page, 'toggle-lightning', true);
        await page.waitForFunction(() => window.__opdMap.getSource('lightning')?.loaded());
      }
    }
    await writeFile(resolve(output, `${surface.name}.json`), JSON.stringify(row, null, 2));
    for (const state of row.states.slice(1)) {
      for (let i = 0; i < strikes.length; i += 1) {
        assert(state.painted[i].yellow >= row.states[0].painted[i].yellow * 0.75,
          `${surface.name} ${strikes[i].side} strike keeps its visible pixel area through overlay toggles`);
        assert(state.painted[i].peak.every((value, channel) => Math.abs(value - row.states[0].painted[i].peak[channel]) <= 5),
          `${surface.name} ${strikes[i].side} strike keeps its visible color through overlay toggles`);
      }
    }
    await page.evaluate(async () => {
      const source = window.__opdMap.getSource('lightning');
      const data = await source.getData();
      source.setData({ ...data, features: data.features.filter(feature => feature.geometry.coordinates[0] > -90) });
    });
    await page.waitForFunction(() => window.__opdMap.getSource('lightning').loaded());
    const hiddenNight = await pixels(page, `${surface.name}-negative-control.png`);
    const baseline = row.states.at(-1).cleared;
    assert(hiddenNight[0].yellow - baseline[0].yellow < 8, 'The pixel test detects a removed night-side strike');
    assert(hiddenNight[1].yellow - baseline[1].yellow >= 8, 'The negative control retains the day-side strike');
    row.negativeControl = hiddenNight;
    results.push(row);
    await writeFile(resolve(output, `${surface.name}.json`), JSON.stringify(row, null, 2));
    console.log(`${surface.name} passed both strikes, terminator and night lights on/off, cleared-pixel comparisons, ISS/label order, and missing-night negative control`);
  } finally {
    await closeBrowser(session, surface.name);
  }
}
await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
