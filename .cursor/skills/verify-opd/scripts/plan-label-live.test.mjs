import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlanLabelChecks, compareLockedPair, PLAN_TILE_HELPERS } from './drive.mjs';
import { decodePng } from './decode-png.mjs';
import { FRANCE_Z12_NAMES, labelScreenVerdict, labelTile, loadCountryRasterLevels, rasterDuplicateVerdict } from './plan-label-verdict.mjs';
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
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const page = await context.newPage();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  page.on('pageerror', (error) => console.log('pageerror', engine.name, error.message));
  await page.goto(`http://127.0.0.1:${port}/test/plan-label-live.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__planMap, undefined, { timeout: 20000 });
  await waitSettled(page);
  return {
    page,
    context,
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

function loadPng(dir, name) {
  return readFileSync(new URL(`./fixtures/${dir}/${name}.png`, import.meta.url)).toString('base64');
}

function loadDecoded(dir, name) {
  const png = readFileSync(new URL(`./fixtures/${dir}/${name}.png`, import.meta.url));
  return { ...decodePng(png), png };
}

function stockPair(head, main, ignoreRects) {
  const zoom = 7.7;
  const levels = loadCountryRasterLevels();
  const drawn = Math.min(levels.through, Math.round(zoom + 1));
  const ink = levels.bounds.Kenya[String(drawn)].find((entry) => entry.service === 'reference').ink;
  const world = 512 * (2 ** zoom);
  return {
    tilesOk: true,
    tileZ: labelTile(zoom),
    zoom,
    country: 'Kenya',
    center: [37, 1],
    names: [],
    viewport: { width: head.width, height: head.height, origin: { x: 150 - ink[0] * world, y: 360 - ink[1] * world } },
    headShot: head,
    mainShot: main,
    ignoreRects,
    headPlacement: { labels: [], canvas: { left: 0, top: 0, right: head.width, bottom: head.height }, chrome: [] },
    mainPlacement: { labels: [], canvas: { left: 0, top: 0, right: main.width, bottom: main.height }, chrome: [] },
  };
}

async function browserTurn(page, encoded, degrees) {
  const url = await page.evaluate(async ({ encoded, degrees }) => {
    const image = await new Promise((resolve, reject) => {
      const picture = new Image();
      picture.onload = () => resolve(picture);
      picture.onerror = () => reject(new Error('image'));
      picture.src = `data:image/png;base64,${encoded}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#181a1c';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (degrees) {
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(degrees * Math.PI / 180);
      context.drawImage(image, -image.width / 2, -image.height / 2);
    } else context.drawImage(image, 0, 0);
    return canvas.toDataURL('image/png');
  }, { encoded, degrees });
  const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  return { ...decodePng(png), png };
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
      const franceVerdict = labelScreenVerdict({ head: france, main: france, expectedNames: franceNames });
      const crosses = france.labels.some((label) => {
        const box = label.box;
        const frame = france.canvas;
        if (!box || !frame) return false;
        const x = (box.left + box.right) / 2;
        const y = (box.top + box.bottom) / 2;
        const centerIn = x >= frame.left && x <= frame.right && y >= frame.top && y <= frame.bottom;
        return centerIn && (box.left < frame.left || box.top < frame.top || box.right > frame.right || box.bottom > frame.bottom);
      });
      assert.equal(crosses ? franceVerdict.reason : franceVerdict.ok, crosses ? 'canvas' : true, JSON.stringify(franceVerdict));

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
      assert.deepEqual(placedNames(duplicate), ['Brazil', 'Mexico'], `${engine.name} duplicate ${JSON.stringify(placedNames(duplicate))}`);
      assert.equal(duplicate.labels.some((label) => label.name === 'Canada'), false);
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
      const paint = (dir, name, degrees) => browserTurn(page, loadPng(dir, name), degrees || 0);
      const main = await paint('plan-label-regression', `${engine.name}-main`);
      const missed = [];
      try {
        assertPlanLabelChecks(stockPair(main, main));
      } catch (error) {
        missed.push(`main ${error.message}`);
      }
      for (const name of ['removed', 'egypt', 'three', 'nya', 'chrome']) {
        const head = await paint('plan-label-regression', `${engine.name}-${name}`);
        try {
          assertPlanLabelChecks(stockPair(head, main));
          missed.push(`${name} passed`);
        } catch (error) {
          if (!/plan label region/.test(error.message)) missed.push(`${name} ${error.message}`);
        }
      }
      const towns = await paint('plan-label-foreign', 'towns');
      const foreignMain = await paint('plan-label-foreign', `${engine.name}-main`);
      for (const ignore of [undefined, [{ left: 170, top: 290, right: 250, bottom: 480 }]]) {
        try {
          assertPlanLabelChecks(stockPair(towns, foreignMain, ignore));
          missed.push(`towns${ignore ? ' ignored' : ''} passed`);
        } catch (error) {
          if (!/plan label region/.test(error.message)) missed.push(`towns ${error.message}`);
        }
      }
      for (const name of ['greek', 'accent']) {
        const turned = await paint('plan-label-foreign', `${engine.name}-${name}`, 20);
        try {
          assertPlanLabelChecks(stockPair(turned, foreignMain));
          missed.push(`${name} rotated passed`);
        } catch (error) {
          if (!/plan label (region|raster)/.test(error.message)) missed.push(`${name} ${error.message}`);
        }
      }
      assert.deepEqual(missed, []);
    } finally {
      await browser.close();
    }
  });
}

function pageSend(page, beforeCapture) {
  let scripts = 0;
  const send = async (method, params = {}) => {
    if (method === 'Runtime.evaluate') {
      scripts += 1;
      if (scripts === 2 && beforeCapture) await beforeCapture();
      try {
        const value = await page.evaluate((expression) => (0, eval)(expression), params.expression);
        return { result: { value } };
      } catch (error) {
        return { exceptionDetails: { text: error && error.message ? error.message : String(error) } };
      }
    }
    if (method === 'Page.captureScreenshot') {
      const clip = params.clip;
      const buffer = await page.screenshot({
        type: 'png',
        clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
      });
      return { data: Buffer.from(buffer).toString('base64') };
    }
    if (method === 'Page.bringToFront') {
      await page.bringToFront();
      return {};
    }
    throw new Error(`unhandled ${method}`);
  };
  send.page = page;
  return send;
}

async function nestPlanFrame(page) {
  await page.evaluate(() => {
    const frame = document.querySelector('[data-pip-frame]');
    if (!frame || frame.closest('[data-pip="plan"]')) return;
    const wrap = document.createElement('div');
    wrap.dataset.pip = 'plan';
    frame.parentElement.insertBefore(wrap, frame);
    wrap.appendChild(frame);
  });
}

async function showCanada(page) {
  await page.evaluate(() => {
    const frame = document.querySelector('[data-pip-frame]');
    const map = frame.__opdTrackInset;
    frame.dataset.insetHiddenCountries = '';
    map.setPaintProperty('inset-countries', 'text-opacity', 1);
    const native = map.setPaintProperty.bind(map);
    map.setPaintProperty = (layer, prop, value) => {
      if (layer === 'inset-countries' && prop === 'text-opacity') return map;
      return native(layer, prop, value);
    };
  });
}

async function renameFrance(page) {
  await page.evaluate(async () => {
    const map = document.querySelector('[data-pip-frame]').__opdTrackInset;
    const data = await map.getSource('inset-countries').getData();
    const features = data.features.map((feature) => feature.properties && feature.properties.name === 'France'
      ? { ...feature, properties: { ...feature.properties, name: 'Egypt' } }
      : feature);
    await map.getSource('inset-countries').setData({ type: 'FeatureCollection', features });
  });
}

test('the paired capture rejects Egypt that arrives on main after the early row', { timeout: 180000 }, async () => {
  const session = await openMap(engines[0]);
  const main = await session.context.newPage();
  try {
    await main.goto(session.page.url(), { waitUntil: 'domcontentloaded' });
    await main.waitForFunction(() => !!window.__planMap, undefined, { timeout: 20000 });
    await waitSettled(main);
    await nestPlanFrame(session.page);
    await nestPlanFrame(main);
    for (const page of [session.page, main]) {
      await page.evaluate(() => {
        const frame = document.querySelector('#frame');
        frame.style.width = '860px';
        frame.style.height = '700px';
        frame.__opdTrackInset.resize();
      });
    }
    await go(session.page, [2, 46], 2.5);
    await go(main, [2, 46], 2.5);
    let failed = null;
    try {
      await compareLockedPair(pageSend(session.page), pageSend(main, () => renameFrance(main)), 2, 46, 2.5, 'France');
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, 'paired caller accepted the early France placement');
    assert.match(failed.message, /plan label place/);
    assert.match(failed.message, /"reason":"parity"/);
  } finally {
    await main.close();
    await session.close();
  }
});

test('a delayed Canada paint is read from the captured placement', { timeout: 180000 }, async () => {
  const session = await openMap(engines[0]);
  const main = await session.context.newPage();
  try {
    await main.goto(session.page.url(), { waitUntil: 'domcontentloaded' });
    await main.waitForFunction(() => !!window.__planMap, undefined, { timeout: 20000 });
    await waitSettled(main);
    await nestPlanFrame(session.page);
    await nestPlanFrame(main);
    await go(session.page, [-100, 50], 1.5);
    await go(main, [-100, 50], 1.5);
    let failed = null;
    try {
      await compareLockedPair(pageSend(session.page, () => showCanada(session.page)), pageSend(main, () => showCanada(main)), -100, 50, 1.5, 'Canada');
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, 'paired caller accepted the early Canada opacity');
    assert.match(failed.message, /plan label raster-name/);
    assert.match(failed.message, /"reason":"opacity"/);
  } finally {
    await main.close();
    await session.close();
  }
});

test('a long symbol fade with a moved text offset fails closed', { timeout: 90000 }, async () => {
  const session = await openMap(engines[0]);
  try {
    const { page } = session;
    const result = await page.evaluate(async (helpers) => {
      const map = window.__planMap;
      const waitLoaded = () => new Promise((resolve) => {
        const start = performance.now();
        const tick = () => {
          if ((map.loaded() && map.areTilesLoaded()) || performance.now() - start > 5000) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      map.jumpTo({ center: [2, 46], zoom: 2.2 });
      await waitLoaded();
      map._idleTriggered = true;
      map._fadeDuration = 12000;
      map.setLayoutProperty('inset-countries', 'text-offset', [8, 0]);
      await new Promise((resolve) => {
        const start = performance.now();
        const tick = () => {
          const placement = map.style.placement;
          if ((placement && placement.fadeDuration >= 5000) || performance.now() - start > 4000) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      map._fadeDuration = 0;
      map.triggerRepaint();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      map._fadeDuration = 12000;
      map.jumpTo({ center: [2.4, 46], zoom: 2.2 });
      const armed = await new Promise((resolve) => {
        const start = performance.now();
        const onRender = () => {
          const placement = map.style.placement;
          const live = !!placement
            && placement.stale === false
            && placement.fadeDuration >= 5000
            && placement.hasTransitions(performance.now()) === true
            && placement.hasTransitions() === false
            && map.loaded() === true
            && map.areTilesLoaded() === true;
          if (live || performance.now() - start > 4000) {
            map.off('render', onRender);
            resolve(live);
          }
        };
        map.on('render', onRender);
        map.triggerRepaint();
      });
      const run = new Function(`${helpers}; return planWaitTiles;`)();
      const started = performance.now();
      const waited = await run(map, true);
      const placement = map.style.placement;
      return {
        armed,
        offset: map.getLayoutProperty('inset-countries', 'text-offset'),
        tilesOk: waited.tilesOk,
        elapsed: performance.now() - started,
        repaintMs: waited.repaintMs,
        stillFading: placement.hasTransitions(performance.now()),
        bare: placement.hasTransitions(),
        stale: placement.stale,
      };
    }, PLAN_TILE_HELPERS);
    assert.equal(result.armed, true, JSON.stringify(result));
    assert.deepEqual(result.offset, [8, 0]);
    assert.equal(result.bare, false, JSON.stringify(result));
    assert.equal(result.stillFading, true, JSON.stringify(result));
    assert.equal(result.tilesOk, false, JSON.stringify(result));
    assert.ok(result.elapsed >= 1500 && result.elapsed < 7000, JSON.stringify(result));
  } finally {
    await session.close();
  }
});
