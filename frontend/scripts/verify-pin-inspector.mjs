import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, devices, webkit } from 'playwright';

const { values } = parseArgs({
  options: {
    fixtures: { type: 'string' },
    output: { type: 'string', default: '/tmp/opd-pin-inspector' },
    url: { type: 'string', default: 'http://127.0.0.1:5173/?e2e' },
    baseline: { type: 'boolean', default: false },
    chrome: { type: 'string' },
    device: { type: 'string' },
  },
});
assert(values.fixtures, 'Usage: node scripts/verify-pin-inspector.mjs --fixtures <fixture-directory> [--output <directory>] [--url <built-bundle-url>] [--baseline] [--device <name>] [--chrome <executable>]');
const fixtureDir = resolve(values.fixtures);
const outputDir = resolve(values.output);
const meta = JSON.parse(readFileSync(resolve(fixtureDir, 'meta.json'), 'utf8'));
mkdirSync(outputDir, { recursive: true });
const browser = await webkit.launch();
const desktopBrowser = await chromium.launch(values.chrome ? { executablePath: values.chrome } : { channel: 'chrome' });
const results = [];
const fixtureSaves = new WeakMap();
const verifierSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const rasterFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const sizes = [
  ['desktop', null, 1400, 900],
  ['ipad-portrait', 'iPad Pro 11', 834, 1194],
  ['ipad-landscape', 'iPad Pro 11', 1194, 834],
  ['iphone13-portrait', 'iPhone 13', 390, 844],
  ['iphone13-landscape', 'iPhone 13', 844, 390],
  ['iphone17-portrait', 'iPhone 17 Pro', 402, 874],
  ['iphone17-landscape', 'iPhone 17 Pro', 874, 402],
];

async function configure(page, legacyLaunch = false) {
  const saved = [];
  fixtureSaves.set(page, saved);
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
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;
    if ((requestUrl.hostname === 'gibs.earthdata.nasa.gov' && /\.(?:png|jpe?g)$/.test(path))
      || (requestUrl.hostname === 'server.arcgisonline.com' && path.includes('/MapServer/tile/'))) {
      return route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: rasterFixture });
    }
    if (legacyLaunch && path.startsWith('/launch/')) return route.fulfill({ status: 404, body: 'No launch artifact for legacy popup proof' });
    const file = path === '/manifest.json' ? 'manifest.json'
      : path.startsWith('/v/verify/') ? path.split('/').pop()
        : path === '/launch/latest.json' ? 'launch-latest.json'
          : path === '/launch/v/verifyrev.json' ? 'launch.json' : null;
    if (file) {
      return route.fulfill({ contentType: 'application/json', body: replacements.get(file) ?? readFileSync(resolve(fixtureDir, file)) });
    }
    if (path === '/api/browser/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, profile: { name: 'verify-inspector', displayName: 'Local inspector fixture' } }) });
    if (path === '/api/browser/profiles/verify-inspector/targets') {
      if (request.method() === 'POST') saved.push(request.postDataJSON());
      else assert.equal(request.method(), 'GET', 'Only the locally intercepted fixture Save may mutate data');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, count: saved.length, targets: saved }) });
    }
    if (path.startsWith('/api/')) {
      assert.equal(request.method(), 'GET', `Probe must not write API data: ${path}`);
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"not_authenticated"}' });
    }
    return route.continue();
  });
  const url = new URL(values.url);
  url.searchParams.set('u', 'verify-inspector');
  await page.goto(url.href);
  assert(await page.locator('script[src*="/assets/"]').count() > 0
    && await page.locator('script[src*="/@vite/client"]').count() === 0, 'Verifier requires a built bundle, not the Vite development server');
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
      controlsGap: Math.max(controlsBox.y - popupBox.bottom, popupBox.y - controlsBox.bottom,
        controlsBox.x - popupBox.right, popupBox.x - controlsBox.right),
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
  if (row.content.height >= 180 && row.firstPassTimeVisible !== null) {
    assert(row.firstPassTimeVisible, `${label}: first pass UTC time is initially inside the visible content`);
  }
  assert(row.paintedHeaderIsPopup, `${label}: header paints above inspector, including when its pointer events are enabled`);
  assert(row.horizontalOverflow <= 1, `${label}: no horizontal popup overflow (${row.horizontalOverflow}px)`);
  assert.deepEqual(row.splitWords, [], `${label}: track and Cupola are not split inside words`);
  assert(row.controlsClear, `${label}: Controls is directly tappable with the popup open`);
  assert(row.controlsGap >= 7, `${label}: popup keeps an 8px separation from Controls (${row.controlsGap}px gap)`);
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
const actionable = '.map-control-dock button, #map-legend-toggle, .maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out, .maplibregl-ctrl-compass, #time-slider, .time-step-btn, #map-chrome-toggle';
const surfaceSelectors = ['.map-control-dock', '#map-legend-panel', '.maplibregl-ctrl-group', '.map-command .map-controls-time', '#map-legend-toggle', '#map-chrome-toggle'];

function expect(row, category, label, condition, evidence) {
  const check = { category, label, passed: !!condition, ...(evidence === undefined ? {} : { evidence }) };
  row.checks.push(check);
  if (!condition) row.failures.push(check);
}

async function capture(row, category, label, fn) {
  try {
    const evidence = await fn();
    expect(row, category, label, true);
    return evidence;
  } catch (error) {
    expect(row, category, label, false, error.message);
    return null;
  }
}

async function geometry(page) {
  return page.evaluate(({ actionable, surfaceSelectors }) => {
    const box = (r) => ({ x: r.left, y: r.top, right: r.right, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top });
    const visible = (element) => {
      let r = element.getBoundingClientRect();
      let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
        if (ancestor === element) continue;
        const clip = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, clip.left + ancestor.clientLeft); right = Math.min(right, clip.left + ancestor.clientLeft + ancestor.clientWidth); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, clip.top + ancestor.clientTop); bottom = Math.min(bottom, clip.top + ancestor.clientTop + ancestor.clientHeight); }
      }
      return right - left > 1 && bottom - top > 1 ? box({ left, top, right, bottom }) : null;
    };
    const identity = (element) => element?.id || element?.className || element?.tagName;
    const samples = (element, rect, diagnostic = false) => {
      const old = element.style.pointerEvents;
      if (diagnostic) element.style.pointerEvents = 'auto';
      const hits = [[0.15, 0.15], [0.85, 0.15], [0.5, 0.5], [0.15, 0.85], [0.85, 0.85]].map(([fx, fy]) => {
        const x = rect.x + rect.width * fx, y = rect.y + rect.height * fy;
        const hit = document.elementFromPoint(x, y);
        return { x, y, clear: !!hit && (hit === element || element.contains(hit)), popupClear: !!hit && !!element.closest('.maplibregl-popup')?.contains(hit), hit: identity(hit) };
      });
      if (diagnostic) element.style.pointerEvents = old;
      return hits;
    };
    const controls = [...document.querySelectorAll(actionable)].flatMap((element) => {
      const rect = visible(element);
      return rect ? [{ id: element.id || [...element.classList].find((name) => name.startsWith('maplibregl-ctrl-')), rect, hits: samples(element, rect), disabled: element.disabled }] : [];
    });
    const surfaces = surfaceSelectors.flatMap((selector) => [...document.querySelectorAll(selector)].flatMap((element) => {
      const rect = visible(element);
      return rect ? [{ selector, rect, hits: selector === '#map-legend-panel' ? samples(element, rect, true) : [] }] : [];
    }));
    const popup = document.querySelector('.dropped-pin-popup')?.closest('.maplibregl-popup');
    const parts = popup ? [
      ['header', popup.querySelector('.dropped-pin-popup > strong, .dropped-pin-popup strong')],
      ...[...popup.querySelectorAll('.dropped-pin-popup div')].filter((element) => getComputedStyle(element).display === 'grid').map((element, index) => [`pass-row-${index}`, element]),
      ...['.pin-add-button', '.pin-add-save', '.pin-add-cancel', '.maplibregl-popup-close-button'].map((selector) => [selector, popup.querySelector(selector)]),
    ].flatMap(([label, element]) => {
      if (!element) return [];
      const rect = visible(element);
      if (!rect) return [];
      const raw = element.getBoundingClientRect();
      const textRects = label.startsWith('pass-row-') ? [...element.children].flatMap((span, index) => {
        const range = document.createRange();
        range.selectNodeContents(span);
        return [...range.getClientRects()].map((rect) => ({ index, text: span.textContent, rect: box(rect) }));
      }) : [];
      const textOutsideRow = textRects.filter(({ rect }) => rect.x < raw.left - 1 || rect.right > raw.right + 1 || rect.y < raw.top - 1 || rect.bottom > raw.bottom + 1);
      const overlappingText = textRects.flatMap((a, index) => textRects.slice(index + 1).filter((b) => a.index !== b.index
        && Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.x, b.rect.x) > 0.5
        && Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.y, b.rect.y) > 0.5).map((b) => ({ a, b })));
      return [{ label, rect, rawHeight: raw.height, hits: samples(element, rect), textOutsideRow, overlappingText }];
    }) : [];
    return { controls, surfaces, parts, popup: popup && visible(popup), content: popup && box(popup.querySelector('.maplibregl-popup-content').getBoundingClientRect()) };
  }, { actionable, surfaceSelectors });
}

function categoryFor(id) {
  if (/legend/.test(id)) return 'legend';
  if (/time-|command/.test(id)) return 'time';
  if (/compass|zoom|ctrl-group/.test(id)) return 'compass';
  if (/chrome-toggle/.test(id)) return 'controls';
  return 'dock';
}

async function checkClearance(page, row, stage) {
  const snapshot = await geometry(page);
  row.geometry.push({ stage, ...snapshot });
  for (const control of snapshot.controls) {
    expect(row, categoryFor(control.id), `${stage}: ${control.id} paint/hit clearance`, control.hits.every((hit) => hit.clear), control);
  }
  for (const surface of snapshot.surfaces) {
    const category = categoryFor(surface.selector);
    if (snapshot.popup) {
      const a = surface.rect, b = snapshot.popup;
      const overlap = Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0.5;
      expect(row, category, `${stage}: ${surface.selector} / popup content footprint separation`, !overlap, overlap ? { chrome: a, popup: b } : undefined);
    }
    if (surface.hits.length) expect(row, category, `${stage}: expanded Legend five paint samples`, surface.hits.every((hit) => hit.clear), surface);
    for (const part of snapshot.parts) {
      const a = surface.rect, b = part.rect;
      const overlap = Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0.5;
      expect(row, category, `${stage}: ${surface.selector} / ${part.label} rect separation`, !overlap, overlap ? { chrome: a, popupPart: b } : undefined);
    }
  }
  for (const part of snapshot.parts) {
    if (part.label.startsWith('pass-row-')) {
      expect(row, 'popup', `${stage}: ${part.label} text stays inside row`, part.textOutsideRow.length === 0, part.textOutsideRow);
      expect(row, 'popup', `${stage}: ${part.label} text columns do not overlap`, part.overlappingText.length === 0, part.overlappingText);
    }
    expect(row, 'popup', `${stage}: chrome does not cover ${part.label} paint`, part.hits.every((hit) => part.label === 'header' || part.label.startsWith('pass-row-') ? hit.popupClear : hit.clear), part);
  }
  return snapshot;
}

async function rawTap(page, id, touch, row, label = id) {
  const snapshot = await geometry(page);
  const control = snapshot.controls.find((entry) => entry.id === id);
  assert(control, `${id} has a visible clipped rect`);
  const center = control.hits[2];
  expect(row, categoryFor(id), `${label}: elementFromPoint before actual ${touch ? 'tap' : 'click'}`, center.clear, center);
  if (touch) await page.touchscreen.tap(center.x, center.y);
  else await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(150);
  expect(row, 'lifecycle', `${label}: pin stays open`, await page.locator('.dropped-pin-popup').count() === 1);
  return control;
}

async function controlState(page, id) {
  return page.evaluate((id) => {
    const element = document.getElementById(id) || document.querySelector(`.${id}`);
    if (id === 'maplibregl-ctrl-compass') return window.__opdMap.getBearing();
    if (id.startsWith('maplibregl-ctrl-zoom')) return window.__opdMap.getZoom();
    if (id.startsWith('time-')) return Number(document.querySelector('#time-slider').value);
    if (id === 'toggle-satellite-picker') return !document.querySelector('#satellite-picker-panel').hidden;
    return element.getAttribute('aria-pressed') ?? element.getAttribute('aria-expanded') ?? element.classList.contains('active');
  }, id);
}

async function checkAction(page, row, id, touch) {
  const before = await controlState(page, id);
  await rawTap(page, id, touch, row);
  let animationSettled = true;
  if (id === 'maplibregl-ctrl-compass') {
    try { await page.waitForFunction(() => Math.abs(window.__opdMap.getBearing()) < 0.1, undefined, { timeout: 5000 }); }
    catch (error) { if (error.name !== 'TimeoutError') throw error; animationSettled = false; }
  } else if (id.startsWith('maplibregl-ctrl-zoom')) await page.waitForTimeout(500);
  const after = await controlState(page, id);
  expect(row, categoryFor(id), `${id}: actual action changes state`, before !== after && animationSettled && (id !== 'maplibregl-ctrl-compass' || Math.abs(after) < 0.1), { before, after, animationSettled });
  return { id, before, after };
}

async function checkChromeActions(page, row, touch) {
  row.actions = [];
  const initial = await geometry(page);
  for (const control of initial.controls) {
    const id = control.id;
    if (id === 'map-chrome-toggle' || id === 'map-legend-toggle' || id.startsWith('time-')) continue;
    await capture(row, categoryFor(id), `${id} interaction`, async () => {
      if (id === 'bearing-north' || id === 'bearing-iss') {
        const other = id === 'bearing-north' ? 'bearing-iss' : 'bearing-north';
        if (await controlState(page, id) === true) await rawTap(page, other, touch, row, `${id} precondition`);
      }
      if (id === 'maplibregl-ctrl-compass') {
        await rawTap(page, 'bearing-north', touch, row, 'Compass north-up precondition');
        await page.evaluate(() => window.__opdMap.jumpTo({ bearing: 37 }));
      }
      row.actions.push(await checkAction(page, row, id, touch));
      if (id === 'toggle-satellite-picker' && await controlState(page, id)) await rawTap(page, id, touch, row, 'Close satellite picker');
      if (id === 'toggle-follow-iss' && await controlState(page, id) === 'true') await rawTap(page, id, touch, row, 'Release Follow');
      if (await page.locator('.pin-add-cancel').count()) await page.locator('.pin-add-cancel').evaluate((element) => element.click());
    });
  }
  if (initial.controls.some((control) => control.id === 'time-slider')) {
    if (await page.locator('.dropped-pin-popup').count() !== 1) await dropPin(page);
    await page.locator('.maplibregl-popup-content').evaluate((element) => { element.scrollTop = 0; });
    for (const id of ['time-fwd-45', 'time-back-90', 'time-fwd-90', 'time-back-45', 'time-now']) {
      await capture(row, 'time', `${id} interaction`, async () => { row.actions.push(await checkAction(page, row, id, touch)); });
    }
    const pair = row.actions.filter(({ id }) => id === 'time-fwd-45' || id === 'time-back-90');
    expect(row, 'time', 'T+45 → T−90 returns to Now', pair.length === 2 && pair[0].after === 45 && pair[1].before === 45 && pair[1].after === 0, pair);
    await capture(row, 'time', 'slider actual interaction', async () => {
      const before = await controlState(page, 'time-slider');
      await rawTap(page, 'time-slider', touch, row);
      const after = await controlState(page, 'time-slider');
      expect(row, 'time', 'slider pointer interaction changes view time', after !== before, { before, after });
      row.actions.push({ id: 'time-slider', before, after });
      await checkClearance(page, row, 'time-strip-after-slider-wrap');
      await rawTap(page, 'time-now', touch, row);
    });
  }
  if (initial.controls.some((control) => control.id === 'map-legend-toggle')) {
    if (await page.locator('.dropped-pin-popup').count() !== 1) await dropPin(page);
    await capture(row, 'legend', 'Legend expanded and collapsed', async () => {
      row.actions.push(await checkAction(page, row, 'map-legend-toggle', touch));
      await checkClearance(page, row, 'expanded-Legend');
      await page.screenshot({ path: resolve(outputDir, `${row.name}-legend.png`) });
      row.actions.push(await checkAction(page, row, 'map-legend-toggle', touch));
      await checkClearance(page, row, 'collapsed-Legend');
    });
  }
  await capture(row, 'controls', 'Controls hide/show reacts with pin open', async () => {
    row.actions.push(await checkAction(page, row, 'map-chrome-toggle', touch));
    await checkClearance(page, row, 'Controls-toggled');
    row.actions.push(await checkAction(page, row, 'map-chrome-toggle', touch));
    await checkClearance(page, row, 'Controls-restored');
  });
}

async function checkPopupParts(page, row, touch) {
  const content = page.locator('.dropped-pin-popup').locator('..');
  await content.evaluate((element) => { element.scrollTop = 0; });
  await checkClearance(page, row, 'header-and-initial-pass-rows');
  const passes = await page.locator('.dropped-pin-popup div').evaluateAll((elements) => elements.filter((element) => getComputedStyle(element).display === 'grid').map((element, index) => ({ index, text: element.textContent })));
  expect(row, 'popup', 'fixture has actual upcoming pass rows', passes.length > 0, passes);
  for (const { index } of passes) {
    await page.locator('.dropped-pin-popup').evaluate((body, index) => {
      const rows = [...body.querySelectorAll('div')].filter((element) => getComputedStyle(element).display === 'grid');
      const content = body.closest('.maplibregl-popup-content');
      const target = rows[index];
      content.scrollTop += target.getBoundingClientRect().top - content.getBoundingClientRect().top - 8;
    }, index);
    const snapshot = await checkClearance(page, row, `scrolled-pass-row-${index}`);
    const target = snapshot.parts.find((part) => part.label === `pass-row-${index}`);
    expect(row, 'popup', `pass row ${index} fully reachable through internal scroll`, !!target && target.rect.height >= Math.min(target.rawHeight, snapshot.content.height) - 1, target);
  }
  const tapPart = async (selector) => {
    const locator = page.locator(selector);
    await locator.scrollIntoViewIfNeeded();
    const point = await locator.evaluate((element) => {
      const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, clear: hit === element || element.contains(hit) };
    });
    expect(row, 'popup', `${selector} elementFromPoint before actual action`, point.clear, point);
    if (touch) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(100);
  };
  await page.locator('.pin-add-button').scrollIntoViewIfNeeded();
  await checkClearance(page, row, 'Add');
  const tail = await page.locator('.pin-add-button').evaluate((element) => element.closest('.maplibregl-popup-content').getBoundingClientRect().bottom - element.getBoundingClientRect().bottom);
  expect(row, 'popup', 'content-sized opaque child has no empty tail', tail <= 22, { tail });
  await tapPart('.pin-add-button');
  expect(row, 'popup', 'Add opens form', await page.locator('.pin-add-name').count() === 1);
  await page.locator('.pin-add-save').scrollIntoViewIfNeeded();
  await checkClearance(page, row, 'Save-Cancel');
  await tapPart('.pin-add-cancel');
  expect(row, 'popup', 'Cancel restores Add', await page.locator('.pin-add-button').count() === 1);
  await tapPart('.pin-add-button');
  await page.locator('.pin-add-name').evaluate((element) => { element.value = 'x'.repeat(201); });
  await tapPart('.pin-add-save');
  expect(row, 'popup', 'Save executes local validation without writing API data', await page.locator('.pin-add-error').textContent() === 'Name too long (200 characters max).');
  expect(row, 'lifecycle', 'Save validation keeps pin open', await page.locator('.dropped-pin-popup').count() === 1);
  await checkClearance(page, row, 'Save-validation');
  await tapPart('.pin-add-cancel');
  await content.evaluate((element) => { element.scrollTop = 0; });
}

async function checkSuccessfulSave(page, row, touch) {
  await dropPin(page);
  const add = page.locator('.pin-add-button');
  await add.scrollIntoViewIfNeeded();
  await checkClearance(page, row, 'successful-Save-Add');
  if (touch) await add.tap(); else await add.click();
  await page.locator('.pin-add-name').fill('Local inspector save fixture');
  const save = page.locator('.pin-add-save');
  await save.scrollIntoViewIfNeeded();
  await checkClearance(page, row, 'successful-Save-button');
  if (touch) await save.tap(); else await save.click();
  await page.waitForFunction(() => !document.querySelector('.dropped-pin-popup'));
  const saved = fixtureSaves.get(page);
  expect(row, 'lifecycle', 'successful Save receives local fixture receipt', saved.length === 1 && saved[0].name === 'Local inspector save fixture', saved);
  expect(row, 'lifecycle', 'successful Save closes popup and clears pin', await page.evaluate(() => document.querySelector('#map-inspector').hidden && window.__opdMap.getSource('dropped-pin').serialize().data.features.length === 0));
  expect(row, 'lifecycle', 'successful Save persists target in isolated context', await page.evaluate((id) => Object.values(localStorage).some((value) => {
    try { return JSON.parse(value)?.additions?.some((target) => target.id === id); } catch { return false; }
  }), saved[0]?.id));
}

async function checkLifecycle(page, row) {
  const before = await page.evaluate(() => window.__opdMap.getSource('dropped-pin').serialize().data.features[0].geometry.coordinates);
  await dropPin(page, 0.25);
  const after = await page.evaluate(() => window.__opdMap.getSource('dropped-pin').serialize().data.features[0].geometry.coordinates);
  expect(row, 'lifecycle', 'replacement is one new pin', await page.locator('.dropped-pin-popup').count() === 1 && JSON.stringify(before) !== JSON.stringify(after), { before, after });
  expect(row, 'lifecycle', 'new pin focuses close X', await page.locator('.maplibregl-popup-close-button').evaluate((element) => element === document.activeElement));
  assertReadable(await inspect(page, '.dropped-pin-popup'), `${row.name}: replacement`);
  await page.locator('#tab-queue').click();
  await page.locator('#tab-map').click();
  await page.waitForTimeout(150);
  expect(row, 'lifecycle', 'tab round trip preserves one pin', await page.locator('.dropped-pin-popup').count() === 1);
  await checkClearance(page, row, 'tab-round-trip');
  await page.locator('.maplibregl-popup-content').evaluate((element) => { element.scrollTop = 0; });
  await closePopup(page);
  expect(row, 'lifecycle', 'close X hides inspector and removes popup', await page.locator('.maplibregl-popup').count() === 0 && await page.locator('#map-inspector').evaluate((element) => element.hidden));
}

try {
  for (const [device, descriptorName, width, height] of sizes.filter(([name]) => !values.device || name === values.device)) {
    for (const chromeShown of [false, true]) {
      const name = `${values.baseline ? 'baseline' : 'head'}-${device}-${chromeShown ? 'controls-shown' : 'controls-hidden'}`;
      const touch = !!descriptorName;
      const descriptor = descriptorName ? (devices[descriptorName] ?? devices['iPhone 13']) : {};
      const context = await (touch ? browser : desktopBrowser).newContext({ ...descriptor, viewport: { width, height }, screen: { width, height }, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(60000);
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      const row = { name, verifierSha256, scope: 'Real built app and browser actions; local data, account/save receipts, and deterministic NASA/Esri raster fixtures. Not production feed validation.', viewport: { width, height }, browser: touch ? 'WebKit' : 'Chrome', deviceDescriptor: descriptorName, deviceDescriptorFallback: descriptorName && !devices[descriptorName] ? 'iPhone 13 with requested dimensions' : null, chromeShown, checks: [], failures: [], geometry: [], pageErrors };
      results.push(row);
      try {
        await configure(page);
        if (chromeShown) await page.locator('#map-chrome-toggle').click();
        await dropPin(page);
        row.pin = await inspect(page, '.dropped-pin-popup');
        await page.screenshot({ path: resolve(outputDir, `${name}.png`) });
        await capture(row, 'popup', 'initial readability', async () => assertReadable(row.pin, name));
        await checkClearance(page, row, 'initial');
        await checkChromeActions(page, row, touch);
        if (chromeShown) await capture(row, 'legend', 'expand Legend for every popup part/form check', async () => rawTap(page, 'map-legend-toggle', touch, row));
        await capture(row, 'popup', 'all popup parts and form actions', async () => checkPopupParts(page, row, touch));
        if (chromeShown) await capture(row, 'legend', 'restore collapsed Legend after forms', async () => rawTap(page, 'map-legend-toggle', touch, row));
        await capture(row, 'lifecycle', 'replacement, focus, tabs, and close X', async () => checkLifecycle(page, row));
        if (!values.baseline && row.failures.length === 0) {
          await capture(row, 'lifecycle', 'successful local Save', async () => checkSuccessfulSave(page, row, touch));
          const keepPin = !chromeShown && device === 'ipad-landscape';
          if (keepPin) await dropPin(page);
          row.target = await capture(row, 'lifecycle', 'target popup uses shared inspector', async () => checkTarget(page, name, keepPin));
          if (!chromeShown && device === 'ipad-landscape') row.longPress = await capture(row, 'lifecycle', 'synthetic long press and drag cancellation', async () => checkLongPress(page, name));
        }
        expect(row, 'runtime', 'no unhandled browser errors', pageErrors.length === 0, pageErrors);
      } catch (error) {
        expect(row, 'setup', 'scenario completed', false, error.stack);
      } finally {
        if (row.failures.length) await page.screenshot({ path: resolve(outputDir, `${name}-failure.png`) }).catch(() => {});
        await context.close();
        console.log(`${name}: ${row.checks.length - row.failures.length}/${row.checks.length} passed; failures: ${[...new Set(row.failures.map((check) => check.category))].join(', ') || 'none'}`);
        writeFileSync(resolve(outputDir, values.baseline ? 'baseline-report.json' : 'report.json'), JSON.stringify(results, null, 2));
      }
    }
  }
  if (!values.baseline && !values.device && results.every((row) => row.failures.length === 0)) {
    try { await checkLegacyLaunch(); } catch (error) { results.push({ name: 'legacy-launch', failures: [{ category: 'lifecycle', label: 'Legacy shared inspector', evidence: error.message }] }); }
  }
} finally {
  writeFileSync(resolve(outputDir, values.baseline ? 'baseline-report.json' : 'report.json'), JSON.stringify(results, null, 2));
  await browser.close();
  await desktopBrowser.close();
}
const failed = results.filter((row) => row.failures?.length);
assert.equal(failed.length, 0, `${failed.length} scenarios failed. See ${resolve(outputDir, values.baseline ? 'baseline-report.json' : 'report.json')}`);
