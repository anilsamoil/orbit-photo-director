import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { FIXTURE_COOKIE } from './fixtures.mjs';
import { closeFixtureBrowsers } from './fixture-session.mjs';
import { PIN_TITLE_TEXT, drivePinTitle, pinTitleFailures, pinTitlePlan } from './pin-title.mjs';

const require = createRequire(new URL('../../../../frontend/package.json', import.meta.url));
const { webkit } = require('playwright');

const fit = {
  container: 294,
  overflowWrap: 'anywhere',
  normalText: '📍 10.00°N, 20.00°E',
  normal: { lines: 1, scrollWidth: 120, clientWidth: 294, inside: true },
  title: { lines: 3, scrollWidth: 294, clientWidth: 294, inside: true },
  heading: { lines: 3, scrollWidth: 280, clientWidth: 294, inside: true },
};

test('pin-title accepts the iPad landscape and desktop WebKit sizes', () => {
  assert.equal(PIN_TITLE_TEXT.length, 60);
  assert.equal(pinTitlePlan('ipad-pro-11', '1210x834').id, 'webkit-ipad-m4-1210x834');
  assert.equal(pinTitlePlan('desktop', '1440x900').id, 'webkit-desktop-1440x900');
  assert.equal(pinTitlePlan('desktop', '1440x900').desktop, true);
  assert.throws(() => pinTitlePlan('iphone-17-pro', '402x874'), /one WebKit process per surface/);
  assert.throws(() => pinTitlePlan('ipad-pro-11', '834x1210'), /one WebKit process per surface/);
  assert.throws(() => pinTitlePlan('desktop', '1280x800'), /one WebKit process per surface/);
  assert.throws(() => pinTitlePlan('', ''), /one WebKit process per surface/);
});

test('pin-title requires a wide column and a wrapped title', () => {
  assert.deepEqual(pinTitleFailures(fit), []);
  assert.match(pinTitleFailures({ ...fit, container: 260 }).join('\n'), /container 260 wanted above 260/);
  assert.match(pinTitleFailures({ ...fit, overflowWrap: 'normal' }).join('\n'), /overflow-wrap normal/);
  assert.match(pinTitleFailures({ ...fit, normalText: PIN_TITLE_TEXT }).join('\n'), /normal title missing/);
  assert.match(pinTitleFailures({ ...fit, title: { ...fit.title, lines: 1 } }).join('\n'), /title lines 1 wanted wrap/);
  assert.match(pinTitleFailures({ ...fit, title: { ...fit.title, scrollWidth: 402, clientWidth: 294 } }).join('\n'), /title scrollWidth 402/);
  assert.match(pinTitleFailures({ ...fit, title: { ...fit.title, inside: false } }).join('\n'), /title leaves the inspector/);
  assert.match(pinTitleFailures({ ...fit, normal: { ...fit.normal, lines: 2 } }).join('\n'), /normal lines 2 wanted 1/);
  assert.match(pinTitleFailures({ ...fit, heading: { ...fit.heading, scrollWidth: 400, clientWidth: 294 } }).join('\n'), /heading scrollWidth 400/);
  assert.deepEqual(pinTitleFailures(null), ['pin title sample missing']);
});

test('drive pin-title pins its private fixture cookie before creating a page', async (t) => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'opd-pin-title-'));
  t.after(() => rmSync(evidenceDir, { recursive: true, force: true }));
  const prior = { surface: process.env.OPD_VERIFY_SURFACE, viewport: process.env.OPD_VERIFY_VIEWPORT };
  process.env.OPD_VERIFY_SURFACE = 'ipad-pro-11';
  process.env.OPD_VERIFY_VIEWPORT = '1210x834';
  t.after(() => {
    for (const [key, value] of Object.entries({ OPD_VERIFY_SURFACE: prior.surface, OPD_VERIFY_VIEWPORT: prior.viewport })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const baseUrl = 'http://127.0.0.1:12345';
  const fixtureToken = 'test-private-fixture';
  const stopped = new Error('browser boundary reached');
  const jar = [];
  const initScripts = [];
  let closed = false;
  const context = {
    async addCookies(cookies) { jar.push(...cookies); },
    async addInitScript(source) { initScripts.push(source); },
    async newPage() {
      assert.equal(jar.some((cookie) => cookie.name === FIXTURE_COOKIE && cookie.value === fixtureToken && cookie.url === baseUrl), true);
      const source = initScripts.find((entry) => entry?.content?.includes('__opdRealNow'));
      assert.ok(source, 'offset drive must seed its private page clock before navigation');
      const now = Date.now();
      const actual = runInNewContext(`${source.content}; ({ now: Date.now(), constructed: new Date().getTime() })`);
      assert.ok(Math.abs(actual.now - now - 600000) < 1000);
      assert.ok(Math.abs(actual.constructed - actual.now) < 1000);
      throw stopped;
    },
    async close() {},
  };
  const browser = { async newContext() { return context; }, async close() { closed = true; } };
  t.mock.method(webkit, 'launch', async () => browser);
  await assert.rejects(
    drivePinTitle({ baseUrl, evidenceDir, fixtureToken, startOffset: 600000 }),
    (error) => error === stopped,
  );
  assert.equal(closed, true);
  await closeFixtureBrowsers();
});
