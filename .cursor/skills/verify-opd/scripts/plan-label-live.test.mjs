import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN_TILE_HELPERS } from './drive.mjs';
import { imageryLabelRegions, FRANCE_Z12_NAMES, labelScreenVerdict, rasterDuplicateVerdict } from './plan-label-verdict.mjs';
import { ocrFrame } from './raster-ocr.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const frontend = resolve(root, 'frontend');
const require = createRequire(resolve(frontend, 'package.json'));
const { chromium, webkit } = require('playwright');
const { createServer } = require('vite');
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((path) => existsSync(path));
const engines = [
  { name: 'chromium', type: chromium, executablePath: chromePath },
  { name: 'webkit', type: webkit },
];
const kenyaCamera = { center: [37, 1], zoom: 6.5 };

async function waitSettled(page) {
  await page.waitForFunction(() => {
    const map = window.__planMap;
    return !!map && map.loaded() === true && map.areTilesLoaded() === true;
  }, undefined, { timeout: 45000 });
}

async function readPlacement(page) {
  return page.evaluate(async (helpers) => {
    const run = new Function(`${helpers}; return planLabelPlacement;`)();
    return run(window.__planMap);
  }, PLAN_TILE_HELPERS);
}

async function go(page, center, zoom) {
  await page.evaluate(({ center, zoom }) => {
    window.__planMap.jumpTo({ center, zoom });
  }, { center, zoom });
  await waitSettled(page);
  await page.waitForTimeout(500);
}

function placedNames(placement) {
  return [...new Set((placement.labels || []).filter((label) => label.box).map((label) => label.name))].sort();
}

async function openMap(engine) {
  const server = await createServer({
    configFile: resolve(frontend, 'vite.config.ts'),
    root: frontend,
    optimizeDeps: { exclude: ['maplibre-gl'] },
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath });
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  page.on('pageerror', (error) => console.log('pageerror', engine.name, error.message));
  await page.goto(`http://127.0.0.1:${port}/test/plan-label-live.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__planMap, undefined, { timeout: 20000 });
  await waitSettled(page);
  return {
    page,
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

function loadPng(dir, name) {
  return readFileSync(new URL(`./fixtures/${dir}/${name}.png`, import.meta.url)).toString('base64');
}

async function browserRegionChanged(page, head, main, degrees, ignore) {
  return page.evaluate(async ({ head, main, degrees, regions, ignore }) => {
    void ignore;
    const load = (encoded) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('image'));
      image.src = `data:image/png;base64,${encoded}`;
    });
    const paint = async (encoded, turn) => {
      const image = await load(encoded);
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#181a1c';
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (turn) {
        context.translate(canvas.width / 2, canvas.height / 2);
        context.rotate(turn * Math.PI / 180);
        context.drawImage(image, -image.width / 2, -image.height / 2);
      } else context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const left = await paint(head, degrees || 0);
    const right = await paint(main, 0);
    const changed = (box) => {
      const x0 = Math.max(0, Math.floor(box[0]));
      const y0 = Math.max(0, Math.floor(box[1]));
      const x1 = Math.min(left.width, Math.ceil(box[2]));
      const y1 = Math.min(left.height, Math.ceil(box[3]));
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const index = (y * left.width + x) * 4;
          const delta = Math.abs(left.data[index] - right.data[index])
            + Math.abs(left.data[index + 1] - right.data[index + 1])
            + Math.abs(left.data[index + 2] - right.data[index + 2]);
          if (delta > 48) return true;
        }
      }
      return false;
    };
    return regions.some(changed);
  }, { head, main, degrees, ignore: ignore || null, regions: imageryLabelRegions({ width: 478, height: 690, ...kenyaCamera }) });
}

for (const engine of engines) {
  test(`plan label cameras and mutants on ${engine.name}`, { timeout: 180000 }, async () => {
    const session = await openMap(engine);
    try {
      const { page } = session;
      await go(page, [-100, 50], 2.99);
      const canada = await readPlacement(page);
      const canadaNames = placedNames(canada);
      assert.deepEqual(canadaNames, ['Canada'], `${engine.name} Canada ${JSON.stringify(canadaNames)}`);
      assert.equal(canada.labels.some((label) => label.name === 'Canada' && label.opacity === 0), false);
      const canadaBox = canada.labels.find((label) => label.name === 'Canada' && label.box);
      assert.ok(canadaBox, `${engine.name} Canada has no collision box`);
      const canadaVerdict = labelScreenVerdict({
        head: canada,
        main: canada,
        expectedNames: canadaNames,
      });
      assert.equal(canadaVerdict.ok, true, JSON.stringify(canadaVerdict));

      await go(page, [2, 46], 1.2);
      const france = await readPlacement(page);
      const franceNames = placedNames(france);
      assert.deepEqual(franceNames, [...FRANCE_Z12_NAMES].sort(), `${engine.name} France ${JSON.stringify(franceNames)}`);
      assert.equal(labelScreenVerdict({ head: france, main: france, expectedNames: franceNames }).ok, true);

      await page.evaluate(() => {
        window.__planMap.setLayoutProperty('inset-countries', 'text-field', 'Mexico');
      });
      await waitSettled(page);
      await page.waitForTimeout(400);
      const swapped = await readPlacement(page);
      assert.equal(swapped.labels.some((label) => label.name === 'France'), false, `${engine.name} swapped still shows France`);
      assert.equal(labelScreenVerdict({
        head: swapped,
        main: france,
        expectedNames: franceNames,
      }).ok, false);

      await page.evaluate(() => {
        window.__planMap.setLayoutProperty('inset-countries', 'text-field', ['get', 'name']);
        window.__planMap.setPaintProperty('inset-countries', 'text-opacity', 0);
      });
      await waitSettled(page);
      await page.waitForTimeout(400);
      const hidden = await readPlacement(page);
      assert.deepEqual(hidden.labels.filter((label) => label.opacity > 0), []);

      await page.evaluate(() => {
        window.__planMap.setPaintProperty('inset-countries', 'text-opacity', 1);
      });
      await waitSettled(page);
      await page.waitForTimeout(400);
      const missing = await page.evaluate((helpers) => {
        const run = new Function(`${helpers}; return planLabelPlacement;`)();
        const map = window.__planMap;
        const grid = map.style.placement.collisionIndex.grid;
        const width = map.getCanvas().clientWidth;
        const height = map.getCanvas().clientHeight;
        const boxes = grid.bboxes;
        for (let index = 0; index < boxes.length; index += 4) {
          const x1 = boxes[index] - 100;
          const y1 = boxes[index + 1] - 100;
          const x2 = boxes[index + 2] - 100;
          const y2 = boxes[index + 3] - 100;
          if (x2 > x1 && y2 > y1 && x1 >= 0 && y1 >= 0 && x2 <= width && y2 <= height) {
            boxes[index + 2] = boxes[index];
            break;
          }
        }
        return run(map);
      }, PLAN_TILE_HELPERS);
      assert.equal(missing.labels.some((label) => label.box == null), true, `${engine.name} missing collision box still has a rectangle`);
      const missingNames = [...new Set(missing.labels.map((label) => label.name))].sort();
      assert.equal(labelScreenVerdict({ head: missing, main: missing, expectedNames: missingNames }).reason, 'position');

      await go(page, [-100, 50], 1.5);
      const duplicate = await readPlacement(page);
      const readWord = async (word) => {
        const painted = await page.evaluate(async (word) => {
        const canvas = document.createElement('canvas');
        canvas.width = 420;
        canvas.height = 160;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#111111';
        context.font = '64px sans-serif';
        context.fillText(word, 40, 100);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const bytes = new Uint8Array(await blob.arrayBuffer());
          return Array.from(bytes);
        }, word);
        return ocrFrame(Buffer.from(painted)).text;
      };
      const mexicoText = await readWord('MEXICO');
      const canadaText = await readWord('CANADA');
      assert.match(mexicoText, /MEXICO/, `${engine.name} painted ${JSON.stringify(mexicoText)}`);
      assert.match(canadaText, /CANADA/, `${engine.name} painted ${JSON.stringify(canadaText)}`);
      const mexico = rasterDuplicateVerdict({
        declared: 'CANADA',
        text: mexicoText,
        opacity: 0,
        position: duplicate.rasterBox,
      });
      assert.equal(mexico.ok, false, `${engine.name} MEXICO read ${JSON.stringify(mexico)}`);
      assert.equal(mexico.reason, 'raster');
      const read = rasterDuplicateVerdict({
        declared: 'CANADA',
        text: canadaText,
        opacity: duplicate.opacity.Canada,
        position: duplicate.rasterBox,
      });
      assert.equal(read.ok, true, `${engine.name} CANADA read ${JSON.stringify(read)}`);
      const missingBox = await page.evaluate((helpers) => {
        const project = new Function(`${helpers}; return planProjectRasterBox;`)();
        const place = new Function(`${helpers}; return planLabelPlacement;`)();
        const frame = document.querySelector('#frame');
        delete frame.dataset.insetHiddenCountries;
        const grid = window.__planMap.style.placement.collisionIndex.grid;
        grid.boxKeys.length = 0;
        grid.bboxes.length = 0;
        return { box: project(window.__planMap, null), opacity: place(window.__planMap).opacity };
      }, PLAN_TILE_HELPERS);
      const noPosition = rasterDuplicateVerdict({
        declared: 'CANADA',
        text: canadaText,
        opacity: 0,
        position: missingBox.box,
      });
      assert.equal(missingBox.box, null);
      assert.equal(noPosition.reason, 'position');
      const noOpacity = rasterDuplicateVerdict({
        declared: 'CANADA',
        text: canadaText,
        opacity: missingBox.opacity.Canada,
        position: duplicate.rasterBox,
      });
      assert.equal(noOpacity.reason, 'opacity', `${engine.name} opacity ${JSON.stringify(missingBox.opacity)}`);
      assert.ok(duplicate.rasterBox, `${engine.name} Canada duplicate has no projected raster box`);
      assert.equal(duplicate.opacity.Canada, 0, `${engine.name} Canada duplicate opacity ${JSON.stringify(duplicate.opacity)}`);
    } finally {
      await session.close();
    }
  });

  test(`imagery label regions on ${engine.name}`, { timeout: 120000 }, async () => {
    const browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath });
    try {
      const page = await browser.newPage();
      const main = loadPng('plan-label-regression', `${engine.name}-main`);
      const missed = [];
      if (await browserRegionChanged(page, main, main, 0)) missed.push('main');
      for (const name of ['removed', 'egypt', 'three', 'nya', 'chrome']) {
        const head = loadPng('plan-label-regression', `${engine.name}-${name}`);
        if (!await browserRegionChanged(page, head, main, 0)) missed.push(name);
      }
      const towns = loadPng('plan-label-foreign', 'towns');
      const foreignMain = loadPng('plan-label-foreign', `${engine.name}-main`);
      if (!await browserRegionChanged(page, towns, foreignMain, 0)) missed.push('towns');
      if (!await browserRegionChanged(page, towns, foreignMain, 0, { left: 0, top: 0, right: 478, bottom: 690 })) missed.push('towns ignored');
      for (const name of ['greek', 'accent']) {
        const head = loadPng('plan-label-foreign', `${engine.name}-${name}`);
        if (!await browserRegionChanged(page, head, foreignMain, 20)) missed.push(`${name} rotated`);
      }
      assert.deepEqual(missed, []);
    } finally {
      await browser.close();
    }
  });
}
