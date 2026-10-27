import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { WEBKIT_DEVICES, launchChrome, launchWebkit, openDeviceContext, replaceDeviceContext } from './webkit-devices.mjs';
import { freezeFixtureClock, restoreFixtureClock } from './fixture-clock.mjs';
import { BOSTON_NADIR_EPOCH_MS, bostonTrackText } from './fixtures.mjs';
import { isolateSnapRequests, serveSnap } from './context-state-fixture.mjs';

const spec = WEBKIT_DEVICES.find((entry) => entry.slug === 'iphone-17-pro');
const landscape = { width: 874, height: 402 };
const portrait = { width: 402, height: 874 };
const click = (page, selector) => page.locator(selector).first().evaluate((node) => node.click());

async function readyMap(page) {
  await page.waitForFunction(() => window.__opdMap?.getLayer('iss-track-layer')
    && document.getElementById('toggle-follow-iss')?.hasAttribute('aria-pressed'), undefined, { timeout: 45000 });
}

async function readyIss(page) {
  await click(page, '#tab-iss');
  await page.waitForFunction(() => window.__opdIss
    && document.querySelector('[data-iss-scene]')?.dataset.issPhase === 'running', undefined, { timeout: 45000 });
}

async function openSnap(browser, served) {
  const session = await openDeviceContext(browser, spec);
  await session.page.goto(`${served.url}/?e2e`);
  await readyMap(session.page);
  await readyIss(session.page);
  return session;
}

async function assertLive(page) {
  const sample = () => page.evaluate(() => ({ now: Date.now(), constructed: +new Date(), called: Date(), monotonic: performance.now() }));
  const before = await sample();
  await page.waitForTimeout(70);
  const after = await sample();
  assert.ok(after.now > before.now, `Date.now advances: ${JSON.stringify({ before, after })}`);
  assert.ok(after.constructed > before.constructed, 'new Date advances after restoring live time');
  assert.ok(Math.abs(after.constructed - after.now) < 20, 'Date.now and construction remain coherent');
  assert.ok(Math.abs(Date.parse(after.called) - after.now) < 1000, 'Date() uses the same live second');
  assert.ok(after.monotonic > before.monotonic, 'rendering timers continue to advance');
}

async function assertFrozenBoot(page, frozen) {
  assert.deepEqual(await page.evaluate(() => window.__clockAtMainModule), {
    now: frozen, constructed: frozen, called: new Date(frozen).toString(),
  }, 'the real SNAP main module starts with a coherent fixture clock');
  assert.deepEqual(await page.evaluate(() => [Date.now(), +new Date()]), [frozen, frozen]);
}

function observeSnapBoot(browser, served) {
  const origin = served.url;
  const original = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await original(...args);
    await context.route(`${origin}/manifest.json`, async (route) => {
      if (!(await route.request().headerValue('cookie') || '').includes('opd-verify-nadir=boston')) return route.fallback();
      const response = await route.fetch();
      const manifest = await response.json();
      const body = bostonTrackText(served.fixtureDir);
      manifest.artifacts.track = { path: 'v/verify/track-boston.json', sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body) };
      await route.fulfill({ response, json: manifest });
    });
    await context.route(`${origin}/v/verify/track-boston.json`, (route) => route.fulfill({ contentType: 'application/json', body: bostonTrackText(served.fixtureDir) }));
    await context.route(`${origin}/src/main.ts`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `window.__clockAtMainModule = { now: Date.now(), constructed: +new Date(), called: Date() };\n${await response.text()}` });
    });
    await context.addInitScript(() => {
      let map;
      Object.defineProperty(window, '__opdMap', {
        configurable: true,
        get: () => map,
        set(value) {
          map = value;
          map.on('render', () => {
            const gl = map.painter?.context?.gl;
            if (!gl) return;
            const pixels = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75]].map(([x, y]) => {
              const rgba = new Uint8Array(4);
              gl.readPixels(Math.floor(gl.drawingBufferWidth * x), Math.floor(gl.drawingBufferHeight * y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
              return [...rgba];
            });
            window.__clockRasterFrame = { loaded: map.loaded(), pixels };
          });
        },
      });
    });
    return context;
  };
}

for (const [engine, launch] of [['Chrome', launchChrome], ['WebKit', launchWebkit]]) {
  test(`${engine} fixture clocks are coherent, one-shot and reload-safe in real SNAP`, { timeout: 240000 }, async (t) => {
    const served = await serveSnap();
    let browser;
    let tileRequests = 0;
    try {
      browser = await launch();
      isolateSnapRequests(browser, served.url, {
        tileHeaders: { 'cache-control': 'public, max-age=3600', expires: new Date(Date.now() + 3600000).toUTCString() },
        onTile: () => { tileRequests += 1; },
      });
      observeSnapBoot(browser, served);

      await t.test('explicit freezes preserve native references, Date API and rendering timers', async () => {
        const session = await openDeviceContext(browser, spec);
        try {
          await session.page.evaluate(() => {
            window.__originalDate = Date;
            window.__originalNow = Date.now;
            window.__originalParse = Date.parse;
            window.__originalUTC = Date.UTC;
            window.__oldDate = new Date(0);
          });
          await session.page.evaluate(freezeFixtureClock, BOSTON_NADIR_EPOCH_MS);
          await session.page.evaluate(freezeFixtureClock, BOSTON_NADIR_EPOCH_MS + 1000);
          const result = await session.page.evaluate(() => {
            class DerivedDate extends Date {}
            const now = new Date();
            return {
              now: Date.now(), constructed: +now, called: Date(), calledWithArgs: Date(0),
              zero: +new Date(0), iso: +new Date('2000-01-02T03:04:05Z'),
              parts: +new Date(2000, 0, 2, 3, 4, 5, 6), nativeParts: +new window.__originalDate(2000, 0, 2, 3, 4, 5, 6),
              undefinedInvalid: Number.isNaN(+new Date(undefined)),
              instance: now instanceof Date && now instanceof window.__originalDate && window.__oldDate instanceof Date,
              subclass: new DerivedDate() instanceof DerivedDate && +new DerivedDate() === Date.now(),
              native: window.__opdNativeDate === window.__originalDate && window.__opdRealNow === window.__originalNow,
              statics: Date.parse === window.__originalParse && Date.UTC === window.__originalUTC,
            };
          });
          assert.equal(result.now, BOSTON_NADIR_EPOCH_MS + 1000);
          assert.equal(result.constructed, result.now);
          assert.equal(result.called, new Date(result.now).toString());
          assert.equal(result.calledWithArgs, result.called);
          assert.equal(result.zero, 0);
          assert.equal(result.iso, Date.parse('2000-01-02T03:04:05Z'));
          assert.equal(result.parts, result.nativeParts);
          for (const key of ['undefinedInvalid', 'instance', 'subclass', 'native', 'statics']) assert.equal(result[key], true, key);
          await session.page.evaluate(() => { Date.now = window.__opdRealNow; });
          await assertLive(session.page);
          await session.page.evaluate(restoreFixtureClock);
          assert.equal(await session.page.evaluate(() => Date === window.__originalDate && Date.now === window.__originalNow), true);
        } finally { await session.context.close(); }
      });

      await t.test('freeze → replace before module init → legacy unfreeze → reload stays live', async () => {
        const session = await openSnap(browser, served);
        try {
          await session.page.evaluate((frozen) => { window.__opdRealNow = Date.now; Date.now = () => frozen; }, served.now);
          await replaceDeviceContext(session, landscape);
          assert.equal(await session.page.evaluate(() => window.__clockAtMainModule.now), served.now, 'the captured clock precedes the real SNAP module initialization');
          await session.page.evaluate(() => { Date.now = window.__opdRealNow; });
          await assertLive(session.page);
          await session.page.reload();
          await assertLive(session.page);
          assert.equal(await session.page.evaluate(() => typeof window.__opdRealNow), 'undefined', 'no stale clock seed runs on a later document');
        } finally { await session.context.close(); }
      });

      await t.test('portrait → landscape → towns reload → portrait → unfreeze → reload; cacheable raster is painted', async () => {
        const session = await openSnap(browser, served);
        try {
          await session.page.evaluate(() => {
            const aim = JSON.stringify({ mode: 'nadir', azimuthDeg: 0, windowId: null, look: { rightDeg: 0, upDeg: 0 }, opticalFovDeg: 8 });
            sessionStorage.setItem('opd-iss-aim', aim);
            localStorage.setItem('opd-iss-aim', aim);
            document.cookie = 'opd-verify-nadir=boston; path=/';
            document.cookie = 'opd-verify-towns=block; path=/';
          });
          await session.page.reload();
          await readyMap(session.page);
          await session.page.evaluate(freezeFixtureClock, BOSTON_NADIR_EPOCH_MS);
          await readyIss(session.page);
          const before = tileRequests;
          await replaceDeviceContext(session, landscape);
          await assertFrozenBoot(session.page, BOSTON_NADIR_EPOCH_MS);
          assert.ok(tileRequests > before, 'the fresh context fetched cacheable raster tiles');
          const painted = await session.page.evaluate(() => ({
            frame: window.__clockRasterFrame,
            sources: Object.keys(window.__opdMap.getStyle().sources).every((id) => window.__opdMap.isSourceLoaded(id)),
            iss: document.querySelector('[data-iss-scene]')?.dataset.issPhase,
          }));
          assert.equal(painted.sources, true, 'all MapLibre sources loaded despite a clock days behind real time');
          assert.equal(painted.frame.loaded, true);
          assert.ok(painted.frame.pixels.some(([r, g, b, a]) => a > 0 && b > 40 && b > r + 20 && g > r + 10), JSON.stringify(painted));
          assert.equal(painted.iss, 'running');
          await session.page.reload();
          await assertLive(session.page);
          await readyMap(session.page);
          await session.page.evaluate(() => { window.__beforeTownsFreeze = Date.now; });
          await session.page.evaluate(freezeFixtureClock, BOSTON_NADIR_EPOCH_MS);
          await session.page.evaluate(freezeFixtureClock, BOSTON_NADIR_EPOCH_MS);
          assert.equal(await session.page.evaluate(() => window.__opdRealNow === window.__beforeTownsFreeze), true);
          await readyIss(session.page);
          await replaceDeviceContext(session, portrait);
          await assertFrozenBoot(session.page, BOSTON_NADIR_EPOCH_MS);
          await session.page.evaluate(restoreFixtureClock);
          await assertLive(session.page);
          await session.page.reload();
          await assertLive(session.page);
          assert.equal(await session.page.evaluate(() => typeof window.__opdRealNow), 'undefined');
        } finally { await session.context.close(); }
      });
    } finally {
      try { await browser?.close(); }
      finally { await served.close(); }
    }
  });
}
