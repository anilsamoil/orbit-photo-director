import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { webkit } from 'playwright';

const { values } = parseArgs({
  options: {
    fixtures: { type: 'string' },
    output: { type: 'string', default: '/tmp/opd-pin-inspector' },
    url: { type: 'string', default: 'http://127.0.0.1:5173/?e2e' },
    baseline: { type: 'boolean', default: false },
  },
});
assert(values.fixtures, 'Usage: node scripts/verify-pin-inspector.mjs --fixtures <fixture-directory> [--output <directory>] [--baseline]');
const fixtureDir = resolve(values.fixtures);
const outputDir = resolve(values.output);
const meta = JSON.parse(readFileSync(resolve(fixtureDir, 'meta.json'), 'utf8'));
mkdirSync(outputDir, { recursive: true });
const browser = await webkit.launch();
const results = [];
const sizes = [
  ['ipad-landscape', 1180, 820],
  ['iphone-portrait', 390, 844],
  ['iphone-se', 320, 568],
  ['phone-landscape', 874, 402],
];

async function configure(page, legacyLaunch = false) {
  const replacements = new Map();
  if (legacyLaunch) {
    const passes = JSON.parse(readFileSync(resolve(fixtureDir, 'passes.json'), 'utf8'));
    passes.push({
      ...passes[0], target_id: 'launch:verify-legacy', target_name: 'Verify Legacy Launch',
      target_lat: meta.pad.lat, target_lon: meta.pad.lon,
      launch: {
        name: 'Verify Legacy Launch', rocket_type: 'Fixture Rocket', site_name: 'Fixture Pad',
        geometry: 'ascent', kind: 'ascent', net_window_seconds: 0,
        t0: new Date(meta.now + 2 * 3_600_000).toISOString(),
        pad_lat: meta.pad.lat, pad_lon: meta.pad.lon,
      },
    });
    const body = JSON.stringify(passes);
    const manifest = JSON.parse(readFileSync(resolve(fixtureDir, 'manifest.json'), 'utf8'));
    manifest.artifacts.passes.sha256 = createHash('sha256').update(body).digest('hex');
    manifest.artifacts.passes.bytes = Buffer.byteLength(body);
    replacements.set('passes.json', body);
    replacements.set('manifest.json', JSON.stringify(manifest));
  }
  await page.clock.setFixedTime(new Date(meta.now));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (legacyLaunch && path.startsWith('/launch/')) return route.fulfill({ status: 404, body: 'No launch artifact for legacy popup proof' });
    const file = path === '/manifest.json' ? 'manifest.json'
      : path.startsWith('/v/verify/') ? path.split('/').pop()
        : path === '/launch/latest.json' ? 'launch-latest.json'
          : path === '/launch/v/verifyrev.json' ? 'launch.json' : null;
    if (file) {
      return route.fulfill({ contentType: 'application/json', body: replacements.get(file) ?? readFileSync(resolve(fixtureDir, file)) });
    }
    if (path === '/api/browser/session') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Local verification' });
    if (path.startsWith('/api/')) {
      assert.equal(request.method(), 'GET', `Probe must not write API data: ${path}`);
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"not_authenticated"}' });
    }
    return route.continue();
  });
  await page.goto(values.url);
  await page.locator('#tab-map').click();
  await page.waitForFunction(() => window.__opdMap?.isStyleLoaded() && window.__opdMap.getSource('iss-track'));
  await page.evaluate(async () => { await document.fonts.ready; });
  if (await page.locator('#toggle-follow-iss').getAttribute('aria-pressed') === 'true') {
    await page.locator('#map-chrome-toggle').click();
    await page.locator('#toggle-follow-iss').click();
    await page.locator('#map-chrome-toggle').click();
  }
  await page.evaluate(({ lat, lon }) => window.__opdMap.jumpTo({ center: [lon, lat], zoom: 3 }), meta.iss);
}

async function dropPin(page, fraction = 0.42) {
  const box = await page.locator('#map > .maplibregl-canvas-container > .maplibregl-canvas').boundingBox();
  assert(box, 'Map canvas exists');
  const inspector = await page.locator('#map-inspector').boundingBox();
  const point = await page.evaluate(({ box, inspector, fraction }) => {
    const canvas = document.querySelector('#map > .maplibregl-canvas-container > .maplibregl-canvas');
    for (const across of [fraction, 0.25, 0.6]) {
      const x = box.x + box.width * across;
      const bottom = inspector && x >= inspector.x && x <= inspector.x + inspector.width
        ? Math.min(box.y + box.height, inspector.y) : box.y + box.height;
      for (const down of [0.5, 0.35, 0.65]) {
        const y = box.y + (bottom - box.y) * down;
        if (document.elementFromPoint(x, y) === canvas) return { x, y };
      }
    }
    return null;
  }, { box, inspector, fraction });
  assert(point, 'An uncovered map canvas point exists outside the inspector and markers');
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.waitForSelector('.dropped-pin-popup');
  await page.waitForTimeout(150);
}

async function inspect(page, bodySelector) {
  return page.evaluate((selector) => {
    const body = [...document.querySelectorAll(selector)].at(-1);
    const popup = body.closest('.maplibregl-popup');
    const content = popup.querySelector('.maplibregl-popup-content');
    const inspector = document.querySelector('#map-inspector');
    const header = body.querySelector('strong, .card-name');
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const chain = (element) => {
      const entries = [];
      while (element) {
        const style = getComputedStyle(element);
        entries.push({ element: element.id || element.className || element.tagName, zIndex: style.zIndex, position: style.position, background: style.backgroundColor });
        element = element.parentElement;
      }
      return entries;
    };
    const headerBox = box(header);
    const contentBox = box(content);
    const popupBox = box(popup);
    const controls = document.querySelector('#map-chrome-toggle');
    const controlsBox = box(controls);
    const controlsHit = document.elementFromPoint(controlsBox.x + controlsBox.width / 2, controlsBox.y + controlsBox.height / 2);
    const firstPassRow = body.matches('.dropped-pin-popup')
      ? [...body.querySelectorAll('div')].find((element) => getComputedStyle(element).display === 'grid') : null;
    const firstPassTime = firstPassRow?.children[1];
    const firstPassTimeBox = firstPassTime ? box(firstPassTime) : null;
    const oldPointerEvents = inspector.style.pointerEvents;
    inspector.style.pointerEvents = 'auto';
    const paintHit = document.elementFromPoint(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2);
    const visiblePaintHit = document.elementFromPoint(
      (Math.max(0, popupBox.x) + Math.min(innerWidth, popupBox.right)) / 2,
      (Math.max(0, popupBox.y) + Math.min(innerHeight, popupBox.bottom)) / 2,
    );
    inspector.style.pointerEvents = oldPointerEvents;
    const splitWords = [];
    for (const span of body.querySelectorAll('span')) {
      if (span.childNodes.length !== 1 || span.firstChild.nodeType !== Node.TEXT_NODE) continue;
      for (const word of ['track', 'Cupola']) {
        const index = span.textContent.indexOf(word);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(span.firstChild, index);
        range.setEnd(span.firstChild, index + word.length);
        const lines = [...range.getClientRects()];
        if (lines.length > 1) splitWords.push({ word, text: span.textContent, lines: lines.length });
      }
    }
    return {
      text: body.textContent,
      popupParent: popup.parentElement.id,
      popup: popupBox,
      content: contentBox,
      header: headerBox,
      headerVisible: headerBox.y >= contentBox.y - 1 && headerBox.bottom <= contentBox.bottom + 1,
      firstPassTime: firstPassTimeBox,
      firstPassTimeText: firstPassTime?.textContent ?? null,
      firstPassTimeVisible: firstPassTimeBox ? firstPassTimeBox.y >= contentBox.y - 1
        && firstPassTimeBox.bottom <= contentBox.bottom + 1
        && firstPassTimeBox.x >= contentBox.x - 1 && firstPassTimeBox.right <= contentBox.right + 1 : null,
      scrollTop: content.scrollTop,
      horizontalOverflow: content.scrollWidth - content.clientWidth,
      paintedHeaderIsPopup: !!paintHit && popup.contains(paintHit),
      paintHit: paintHit?.id || paintHit?.className || paintHit?.tagName,
      visiblePaintHit: visiblePaintHit?.id || visiblePaintHit?.className || visiblePaintHit?.tagName,
      popupAncestors: chain(popup),
      inspectorAncestors: chain(inspector),
      splitWords,
      popupCount: document.querySelectorAll('.maplibregl-popup').length,
      inspectorHidden: inspector.hidden,
      inspectorBackground: getComputedStyle(inspector).backgroundColor,
      controlsClear: controls === controlsHit || controls.contains(controlsHit),
      controlsGap: controlsBox.y - popupBox.bottom,
      map: box(document.querySelector('#map')),
    };
  }, bodySelector);
}

function assertReadable(row, label, popupCount = 1) {
  assert.equal(row.popupParent, 'map-inspector', `${label}: popup is reparented into the inspector`);
  assert.equal(row.popupCount, popupCount, `${label}: one popup is present`);
  assert.equal(row.inspectorHidden, false, `${label}: inspector is open`);
  assert.equal(row.scrollTop, 0, `${label}: popup opens at the top`);
  assert(row.headerVisible, `${label}: header is inside the visible content`);
  if (row.firstPassTimeVisible !== null) {
    assert(row.firstPassTimeVisible, `${label}: first pass UTC time is initially inside the visible content`);
  }
  assert(row.paintedHeaderIsPopup, `${label}: header paints above inspector, including when its pointer events are enabled`);
  assert(row.horizontalOverflow <= 1, `${label}: no horizontal popup overflow (${row.horizontalOverflow}px)`);
  assert.deepEqual(row.splitWords, [], `${label}: track and Cupola are not split inside words`);
  assert(row.controlsClear, `${label}: Controls is directly tappable with the popup open`);
  assert(row.controlsGap >= 7, `${label}: popup stays above Controls, not behind it (${row.controlsGap}px gap)`);
  assert.equal(row.inspectorBackground, 'rgba(0, 0, 0, 0)', `${label}: unused inspector area is transparent`);
  assert(row.map.right >= row.popup.right - 1 && row.map.bottom >= row.popup.bottom - 1,
    `${label}: the map extends under the inspector instead of leaving an empty reserved strip`);
}

async function closePopup(page, remaining = 0) {
  await page.locator('.maplibregl-popup-close-button').last().click();
  await page.waitForFunction((count) => document.querySelectorAll('.maplibregl-popup').length === count
    && document.querySelector('#map-inspector').hidden === (count === 0)
    && document.querySelector('#map-pane').classList.contains('map-inspector-open') === (count > 0), remaining);
}

async function checkFooter(page, name) {
  const button = page.locator('.pin-add-button');
  await button.scrollIntoViewIfNeeded();
  const footer = await button.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const content = element.closest('.maplibregl-popup-content').getBoundingClientRect();
    const points = [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]];
    return {
      inside: rect.top >= content.top - 1 && rect.bottom <= content.bottom + 1,
      tail: content.bottom - rect.bottom,
      hits: points.map(([x, y]) => {
        const hit = document.elementFromPoint(rect.x + rect.width * x, rect.y + rect.height * y);
        return { clear: hit === element || element.contains(hit), hit: hit?.id || hit?.className || hit?.tagName }; 
      }),
    };
  });
  assert(footer.inside, `${name}: Add is inside the visible popup after scroll`);
  assert(footer.hits.every((hit) => hit.clear), `${name}: chrome does not cover Add: ${JSON.stringify(footer.hits)}`);
  assert(footer.tail <= 22, `${name}: no empty opaque tail below Add (${footer.tail}px)`);
  await page.screenshot({ path: resolve(outputDir, `${name}-footer.png`) });
  await button.click();
  await page.locator('.pin-add-name').waitFor({ state: 'visible' });
  await page.locator('.pin-add-cancel').click();
  assert.equal(await page.locator('.pin-add-button').count(), 1, `${name}: Cancel restores Add`);
  return footer;
}

async function checkControls(page, name) {
  const toggle = page.locator('#map-chrome-toggle');
  const initial = await toggle.getAttribute('aria-expanded');
  for (const expanded of [initial === 'true' ? 'false' : 'true', initial]) {
    await toggle.click({ timeout: 3000 });
    assert.equal(await toggle.getAttribute('aria-expanded'), expanded, `${name}: Controls toggles while the pin remains open`);
    assert.equal(await page.locator('.dropped-pin-popup').count(), 1, `${name}: toggling Controls preserves the pin`);
    await page.locator('.maplibregl-popup-content').evaluate((element) => { element.scrollTop = 0; });
    assertReadable(await inspect(page, '.dropped-pin-popup'), `${name}: Controls expanded=${expanded}`);
  }
  return { toggledOpenAndClosed: true };
}

async function checkTarget(page, name, keepPin = false) {
  await page.evaluate(({ lat, lon }) => window.__opdMap.jumpTo({ center: [lon, lat], zoom: 4 }), meta.reef);
  await page.waitForTimeout(200);
  const point = await page.evaluate(({ lat, lon }) => {
    const map = window.__opdMap;
    const point = map.project([lon, lat]);
    const box = map.getCanvas().getBoundingClientRect();
    return { x: box.x + point.x, y: box.y + point.y };
  }, meta.reef);
  await page.mouse.click(point.x, point.y);
  await page.waitForSelector('.map-target-popup');
  await page.waitForTimeout(150);
  const target = await inspect(page, '.map-target-popup');
  assertReadable(target, `${name}: target`, keepPin ? 2 : 1);
  assert(target.text.includes('Verify Reef'), `${name}: real fixture target opened`);
  await page.screenshot({ path: resolve(outputDir, `${name}-target.png`) });
  await closePopup(page, keepPin ? 1 : 0);
  if (keepPin) {
    target.survivingPin = await inspect(page, '.dropped-pin-popup');
    assertReadable(target.survivingPin, `${name}: pin survives closing target`);
    await closePopup(page);
  }
  return target;
}


async function checkLegacyLaunch() {
  const name = 'after-iphone-portrait-legacy-launch';
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await configure(page, true);
    await page.locator('#map-chrome-toggle').click();
    await page.locator('#filter-launches-map').click();
    await page.evaluate(({ lat, lon }) => window.__opdMap.jumpTo({ center: [lon, lat], zoom: 4 }), meta.pad);
    await page.waitForFunction(() => {
      const map = window.__opdMap;
      return map.queryRenderedFeatures({ layers: ['ascent-pad-layer'] }).some((feature) => feature.properties.target_id === 'launch:verify-legacy');
    });
    const point = await page.evaluate(({ lat, lon }) => {
      const map = window.__opdMap;
      const projected = map.project([lon, lat]);
      const box = map.getCanvas().getBoundingClientRect();
      return { x: box.x + projected.x, y: box.y + projected.y };
    }, meta.pad);
    await page.mouse.click(point.x, point.y);
    await page.waitForSelector('.launch-ascent-card[data-launch="legacy"]');
    await page.waitForTimeout(150);
    const launch = await inspect(page, '.launch-ascent-card');
    assertReadable(launch, name);
    assert(launch.text.includes('Verify Legacy Launch'), 'Legacy launch fixture opens through its pad');
    await page.screenshot({ path: resolve(outputDir, `${name}.png`) });
    results.push({ name, launch, scope: 'Legacy shared inspector popup, not CRS-35 or the schema-3 picker.' });
    await closePopup(page);
    console.log(`${name}: passed`);
  } finally {
    await context.close();
  }
}

async function touchEvent(page, type, offset = 0) {
  await page.evaluate(({ type, offset }) => {
    const canvas = document.querySelector('#map > .maplibregl-canvas-container > .maplibregl-canvas');
    const box = canvas.getBoundingClientRect();
    const touch = {
      identifier: 1, target: canvas,
      clientX: box.x + box.width * 0.42 + offset,
      clientY: box.y + box.height * 0.5,
      pageX: box.x + box.width * 0.42 + offset,
      pageY: box.y + box.height * 0.5,
      screenX: box.x + box.width * 0.42 + offset,
      screenY: box.y + box.height * 0.5,
    };
    const touches = type === 'touchend' ? [] : [touch];
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: touches },
      targetTouches: { value: touches },
      changedTouches: { value: [touch] },
    });
    canvas.dispatchEvent(event);
  }, { type, offset });
}

async function checkLongPress(page, name) {
  await touchEvent(page, 'touchstart');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.dropped-pin-popup').count(), 0, `${name}: short hold does not drop a pin`);
  await page.waitForTimeout(350);
  await page.waitForSelector('.dropped-pin-popup');
  await touchEvent(page, 'touchend');
  const held = await inspect(page, '.dropped-pin-popup');
  assertReadable(held, `${name}: synthetic 600 ms hold`);
  await page.screenshot({ path: resolve(outputDir, `${name}-long-press.png`) });
  await closePopup(page);
  await touchEvent(page, 'touchstart');
  await touchEvent(page, 'touchmove', 30);
  await page.waitForTimeout(600);
  await touchEvent(page, 'touchend', 30);
  assert.equal(await page.locator('.dropped-pin-popup').count(), 0, `${name}: drag cancels long press`);
  return { held, method: 'Synthetic DOM touch events in WebKit; 250 ms does not open, 600 ms opens, 30 px move cancels. This is not an OS-level iPad gesture.' };
}

try {
  for (const [device, width, height] of sizes) {
    for (const chromeShown of values.baseline ? [false] : [false, true]) {
      const name = `${values.baseline ? 'before' : 'after'}-${device}-${chromeShown ? 'controls-shown' : 'controls-hidden'}`;
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, deviceScaleFactor: 1, serviceWorkers: 'block' });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      try {
        await configure(page);
        if (chromeShown) await page.locator('#map-chrome-toggle').click();
        await dropPin(page);
        const pin = await inspect(page, '.dropped-pin-popup');
        await page.screenshot({ path: resolve(outputDir, `${name}.png`) });
        const row = { name, viewport: { width, height }, chromeShown, pin, pageErrors };
        results.push(row);
        if (values.baseline) {
          assert.equal(pin.visiblePaintHit, 'map-inspector', `${name}: baseline reproduces the painted inspector over popup`);
        } else {
          assertReadable(pin, name);
          assert.equal(pin.firstPassTimeVisible, true, `${name}: first pass UTC time is initially visible`);
          assert(/\d{2}:\d{2}Z/.test(pin.text), `${name}: actual upcoming pass times are present`);
          row.footer = await checkFooter(page, name);
          row.controls = await checkControls(page, name);
          await dropPin(page, 0.32);
          row.replacement = await inspect(page, '.dropped-pin-popup');
          assertReadable(row.replacement, `${name}: replacement`);
          const keepPin = !chromeShown && device === 'ipad-landscape';
          if (!keepPin) await closePopup(page);
          row.target = await checkTarget(page, name, keepPin);
          if (!chromeShown && device === 'ipad-landscape') row.longPress = await checkLongPress(page, name);
          assert.deepEqual(pageErrors, [], `${name}: no unhandled browser errors`);
        }
        console.log(`${name}: passed`);
      } catch (error) {
        await page.screenshot({ path: resolve(outputDir, `${name}-failure.png`) });
        console.error(name, pageErrors, await page.evaluate(() => ({ map: !!window.__opdMap, loaded: window.__opdMap?.isStyleLoaded(), sources: Object.keys(window.__opdMap?.getStyle()?.sources ?? {}) })));
        throw error;
      } finally {
        await context.close();
      }
    }
  }
  if (!values.baseline) await checkLegacyLaunch();
} finally {
  writeFileSync(resolve(outputDir, values.baseline ? 'baseline-report.json' : 'report.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
