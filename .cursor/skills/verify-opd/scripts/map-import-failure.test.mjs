import assert from 'node:assert/strict';
import test from 'node:test';

import { MAP_IMPORT_HELP, MAP_IMPORT_SURFACES, mapImportFailures, mapImportPlan, stylesheetIdentity } from './map-import-failure.mjs';

const cssPath = '/assets/maplibre-vendor-abc123.css';

function passingSample(overrides = {}) {
  return {
    width: 402,
    height: 874,
    openedWidth: 402,
    openedHeight: 874,
    banner: "Map couldn't load Retry",
    retryWidth: 44,
    retryHeight: 44,
    retryTop: 800,
    retryBottom: 844,
    tabIndex: 0,
    tabbable: true,
    platform: 'linux',
    browser: 'webkit',
    documentsAtError: 2,
    documentsAfterHold: 2,
    heldBanner: "Map couldn't load Retry",
    retryFlag: '1',
    storedUrlIncludesEntry: true,
    mapChunk: true,
    recoveredCanvas: 1,
    markerInside: true,
    track: true,
    recoveredError: false,
    stylesheet: true,
    flagsCleared: true,
    recoveredWidth: 402,
    recoveredHeight: 874,
    ...overrides,
  };
}

test('map-import accepts the six created-at-size surfaces', () => {
  for (const surface of MAP_IMPORT_SURFACES) {
    const plan = mapImportPlan(surface.surface, `${surface.width}x${surface.height}`);
    assert.equal(plan.id, surface.id);
  }
  assert.throws(() => mapImportPlan('', ''), new RegExp(MAP_IMPORT_HELP.slice(0, 24)));
  assert.throws(() => mapImportPlan('ipad-pro-11', '834x1194'), /one process per surface/);
  assert.throws(() => mapImportPlan('ipad-3', '1024x768'), /one process per surface/);
  assert.throws(() => mapImportPlan('desktop', '1400x900'), /one process per surface/);
  assert.throws(() => mapImportPlan('iphone-13', '390x664'), /one process per surface/);
});

test('map-import requires the error, a 44px Retry, the hold, and recovery', () => {
  assert.deepEqual(mapImportFailures(passingSample()), []);
  assert.match(mapImportFailures(passingSample({ retryWidth: 32, retryHeight: 44 })).join('\n'), /retry 32x44/);
  assert.match(mapImportFailures(passingSample({ heldBanner: 'Last updated 1 min ago' })).join('\n'), /Last updated/);
  assert.match(mapImportFailures(passingSample({ documentsAfterHold: 3 })).join('\n'), /10s hold/);
  assert.match(mapImportFailures(passingSample({ recoveredCanvas: 0, markerInside: false })).join('\n'), /canvas 0/);
  assert.match(mapImportFailures(passingSample({ openedWidth: 390, openedHeight: 664 })).join('\n'), /opened 390x664/);
});

test('map-import treats a macOS WebKit Tab miss as platform behavior', () => {
  assert.deepEqual(mapImportFailures(passingSample({ platform: 'darwin', browser: 'webkit', tabbable: false })), []);
  assert.match(mapImportFailures(passingSample({ platform: 'linux', browser: 'webkit', tabbable: false })).join('\n'), /tab missed Retry/);
  assert.match(mapImportFailures(passingSample({ platform: 'linux', browser: 'chromium', tabbable: false })).join('\n'), /tab missed Retry/);
  assert.match(mapImportFailures(passingSample({ platform: 'darwin', browser: 'chromium', tabbable: false })).join('\n'), /tab missed Retry/);
});

test('map-import reads the stylesheet identity meta', () => {
  const html = `<head><meta name="opd-map-stylesheet" content="${cssPath}"></head>`;
  assert.equal(stylesheetIdentity(html, cssPath), null);
  assert.match(stylesheetIdentity('<meta name="opd-map-stylesheet" content="/assets/app.css">', cssPath), /stylesheet \/assets\/app.css/);
  assert.match(stylesheetIdentity(`${html}${html}`, cssPath), /count 2/);
  assert.match(stylesheetIdentity('<meta name="viewport" content="width=device-width">', cssPath), /count 0/);
});
