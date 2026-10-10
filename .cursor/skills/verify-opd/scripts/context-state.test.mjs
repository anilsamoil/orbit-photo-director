import assert from 'node:assert/strict';
import test from 'node:test';
import { WEBKIT_DEVICES, launchWebkit, openDeviceContext, replaceDeviceContext } from './webkit-devices.mjs';
import { isolateSnapRequests, serveSnap } from './context-state-fixture.mjs';

const spec = WEBKIT_DEVICES.find((entry) => entry.slug === 'iphone-17-pro');
const frames = [{ width: 874, height: 402 }, { width: 390, height: 520 }, { width: 402, height: 874 }];
const tick = (page) => page.waitForTimeout(1150);
const click = (page, selector) => page.locator(selector).first().evaluate((el) => el.click());

async function mapReady(page) {
  await page.waitForFunction(() => window.__opdMap?.getLayer('iss-track-layer')
    && document.getElementById('toggle-follow-iss')?.hasAttribute('aria-pressed'));
}

async function state(page) {
  return page.evaluate(async () => {
    const clock = await import('/src/map/features/time-scrub/index.ts');
    const camera = (map) => map ? {
      lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom(),
      bearing: map.getBearing(), pitch: map.getPitch(),
    } : null;
    return {
      tab: document.getElementById('view').className,
      hidden: document.body.classList.contains('map-chrome-hidden'),
      follow: document.getElementById('toggle-follow-iss').getAttribute('aria-pressed'),
      slider: document.getElementById('time-slider').value,
      nowActive: document.getElementById('time-now').classList.contains('active'),
      time: document.getElementById('time-slider-readout').textContent,
      viewTimeMs: clock._getViewTimeMsForTest(),
      now: Date.now(), frozen: typeof window.__opdRealNow === 'function' && Date.now !== window.__opdRealNow,
      legend: document.getElementById('map-legend-toggle').getAttribute('aria-expanded'),
      details: [...document.querySelectorAll('details')].map((el) => ({ id: el.id, class: el.className, open: el.open })),
      expanded: [...document.querySelectorAll('[id][aria-expanded][aria-controls]')].map((el) => ({ id: el.id, open: el.getAttribute('aria-expanded') === 'true' })),
      camera: camera(window.__opdMap),
      mapReady: !!window.__opdMap?.getLayer('iss-track-layer'),
      issReady: !!window.__opdIss && document.querySelector('[data-iss-scene]')?.dataset.issPhase === 'running',
      help: document.querySelector('[data-iss-aim-help]')?.getAttribute('aria-expanded'),
      telemetry: document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded'),
      fullscreen: document.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-fullscreen-active'),
      launch: document.querySelector('[data-iss-launch-picker]')?.value,
      launchName: document.querySelector('[data-iss-launch-name]')?.textContent,
      fov: window.__opdIss?.getVerticalFieldOfView(),
    };
  });
}

function assertMapState(actual, expected) {
  for (const key of ['tab', 'hidden', 'follow', 'slider', 'nowActive', 'time', 'viewTimeMs', 'now', 'frozen', 'legend', 'details', 'expanded']) {
    assert.deepEqual(actual[key], expected[key], key);
  }
  assert.equal(actual.mapReady, true);
  for (const key of Object.keys(expected.camera)) assert.ok(Math.abs(actual.camera[key] - expected.camera[key]) < 0.0001, `camera ${key}: ${actual.camera[key]} vs ${expected.camera[key]}`);
}

async function openMap(browser, served, hidden = false) {
  const session = await openDeviceContext(browser, spec);
  await session.page.goto(`${served.url}/?e2e`);
  await click(session.page, '#tab-map');
  await mapReady(session.page);
  await session.page.evaluate((now) => {
    window.__opdRealNow = Date.now;
    Date.now = () => now;
  }, served.now);
  if (await session.page.locator('#toggle-follow-iss').getAttribute('aria-pressed') === 'true') await click(session.page, '#toggle-follow-iss');
  await click(session.page, '#time-fwd-45');
  await click(session.page, '#map-legend-toggle');
  await session.page.evaluate(() => {
    window.__opdMap.stop();
    window.__opdMap.jumpTo({ center: [12, 23], zoom: 6.5, bearing: 33, pitch: 15 });
    for (const details of document.querySelectorAll('details')) details.open = true;
  });
  await click(session.page, '#live-readout-toggle');
  await click(session.page, '#cupola-toggle');
  if (await session.page.evaluate(() => document.body.classList.contains('map-chrome-hidden')) !== hidden) await click(session.page, '#map-chrome-toggle');
  await tick(session.page);
  return session;
}

test('real SNAP restores complete Map and ISS state before switching rendered contexts', { timeout: 360000 }, async (t) => {
  const served = await serveSnap();
  let browser;
  try {
    browser = await launchWebkit();
    isolateSnapRequests(browser, served.url);
    for (const hidden of [false, true]) {
      await t.test(`Map ${hidden ? 'hidden' : 'shown'} native → wide → narrow → native`, async () => {
        const session = await openMap(browser, served, hidden);
        try {
          const expected = await state(session.page);
          assert.equal(expected.hidden, hidden);
          assert.equal(expected.follow, 'false');
          assert.equal(expected.slider, '45');
          assert.equal(expected.nowActive, false);
          for (const frame of frames) {
            const oldPage = session.page;
            const oldContext = session.context;
            const transitions = [];
            const original = browser.newContext.bind(browser);
            browser.newContext = async (...args) => {
              const context = await original(...args);
              context.on('page', (page) => page.on('domcontentloaded', () => transitions.push({ oldAlive: !oldPage.isClosed(), visible: session.page === oldPage })));
              return context;
            };
            try { await replaceDeviceContext(session, { ...frame, mobile: frame.width < 800, deviceScaleFactor: 1 }); }
            finally { browser.newContext = original; }
            const restored = await state(session.page); // State is checked BEFORE any geometry read.
            assertMapState(restored, expected);
            assert.ok(transitions.length > 0);
            assert.ok(transitions.every((entry) => entry.oldAlive && entry.visible), JSON.stringify(transitions));
            assert.equal(oldPage.isClosed(), true);
            assert.equal(browser.contexts().includes(oldContext), false);
            assert.equal(browser.contexts().length, 1);
            assert.deepEqual(await session.page.evaluate(() => [innerWidth, innerHeight]), [frame.width, frame.height]);
            await tick(session.page);
            assertMapState(await state(session.page), expected);
          }
          const page = session.page;
          const context = session.context;
          let navigations = 0;
          let dcl = 0;
          page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
          page.on('domcontentloaded', () => dcl += 1);
          const origin = await page.evaluate(() => {
            window.__sameCanvas = window.__opdMap.getCanvas();
            return performance.timeOrigin;
          });
          for (const hints of [{ mobile: false }, { deviceScaleFactor: 2 }, { screenOrientation: { type: 'landscapePrimary', angle: 90 } }, ...Array.from({ length: 20 }, () => ({ mobile: false, deviceScaleFactor: 1 }))]) {
            await replaceDeviceContext(session, { width: 402, height: 874, ...hints });
          }
          assert.equal(session.page, page);
          assert.equal(session.context, context);
          assert.equal(navigations, 0);
          assert.equal(dcl, 0);
          const [sameOrigin, sameCanvas] = await page.evaluate(() => [performance.timeOrigin, window.__sameCanvas === window.__opdMap.getCanvas()]);
          assert.ok(Math.abs(sameOrigin - origin) <= 1, 'WebKit timeOrigin is stable to its 1ms precision');
          assert.equal(sameCanvas, true);
          assertMapState(await state(page), expected);
          // Live/Now and follow-on are states too, not just their false cases.
          await click(page, '#time-now');
          await click(page, '#toggle-follow-iss');
          await tick(page);
          await replaceDeviceContext(session, frames[0]);
          const live = await state(session.page);
          assert.equal(live.follow, 'true');
          assert.equal(live.slider, '0');
          assert.equal(live.viewTimeMs, null);
          assert.equal(live.nowActive, true);
          await tick(session.page);
          assert.equal((await state(session.page)).follow, 'true');
          if (!hidden) {
            const imminent = await session.page.evaluate(async () => {
              const clock = await import('/src/map/features/time-scrub/index.ts');
              const now = Date.now;
              const target = now() + 20_000;
              try {
                Date.now = () => target - 60_000;
                clock.setLookahead(1, false);
              } finally { Date.now = now; }
              clock.updateTimeStepLabels();
              return target;
            });
            assert.equal((await state(session.page)).slider, '0');
            await replaceDeviceContext(session, frames[1]);
            const imminentState = await state(session.page);
            assert.equal(imminentState.viewTimeMs, imminent);
            assert.equal(imminentState.slider, '0');
            assert.equal(imminentState.nowActive, false, 'a rounded-zero slider is still scrubbed');
          }
        } finally { await session.context.close(); }
      });
    }
    await t.test('ISS retains help, launch, telemetry, fullscreen, FOV and off-tab Map clock', async () => {
      const session = await openMap(browser, served);
      try {
        await click(session.page, '#tab-iss');
        await session.page.waitForFunction(() => window.__opdIss && document.querySelector('[data-iss-scene]')?.dataset.issPhase === 'running');
        await click(session.page, '[data-iss-preset="nadir"]');
        await click(session.page, '[data-iss-telemetry]');
        await click(session.page, '[data-iss-fullscreen]');
        await session.page.waitForFunction(() => [...document.querySelector('[data-iss-launch-picker]').options].some((entry) => entry.textContent.includes('Verify Ascent')));
        await session.page.evaluate(() => {
          const picker = document.querySelector('[data-iss-launch-picker]');
          picker.value = [...picker.options].find((entry) => entry.textContent.includes('Verify Ascent')).value;
          picker.dispatchEvent(new Event('change', { bubbles: true }));
          const current = window.__opdIss.getVerticalFieldOfView();
          document.querySelector('[data-iss-frame]').dispatchEvent(new WheelEvent('wheel', { deltaY: Math.log(12 / current) / 0.0015, bubbles: true, cancelable: true }));
        });
        await tick(session.page);
        if (await session.page.locator('[data-iss-aim-help]').getAttribute('aria-expanded') !== 'true') await click(session.page, '[data-iss-aim-help]');
        const expected = await state(session.page);
        assert.ok(Math.abs(expected.fov - 12) < 0.1, `wheel FOV ${expected.fov}`);
        for (const frame of frames) {
          await replaceDeviceContext(session, frame);
          for (const current of [await state(session.page), await tick(session.page).then(() => state(session.page))]) {
            assertMapState(current, expected);
            for (const key of ['help', 'telemetry', 'fullscreen', 'launch', 'launchName', 'issReady']) assert.equal(current[key], expected[key], key);
            assert.ok(Math.abs(current.fov - expected.fov) < 0.1);
          }
          assert.deepEqual(await session.page.evaluate(() => [innerWidth, innerHeight]), [frame.width, frame.height]);
        }
        const page = session.page;
        const context = session.context;
        let nav = 0;
        let dcl = 0;
        page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) nav += 1; });
        page.on('domcontentloaded', () => dcl += 1);
        const timeOrigin = await page.evaluate(() => {
          window.__sameIssCanvas = window.__opdIss.getCanvas();
          return performance.timeOrigin;
        });
        await replaceDeviceContext(session, { width: 402, height: 874, mobile: false, deviceScaleFactor: 1 });
        assert.equal(session.page, page);
        assert.equal(session.context, context);
        assert.equal(nav, 0);
        assert.equal(dcl, 0);
        const [sameOrigin, sameCanvas] = await page.evaluate(() => [performance.timeOrigin, window.__sameIssCanvas === window.__opdIss.getCanvas()]);
        assert.ok(Math.abs(sameOrigin - timeOrigin) <= 1, 'WebKit timeOrigin is stable to its 1ms precision');
        assert.equal(sameCanvas, true);
        await tick(page);
        assert.deepEqual(await state(page), expected, 'same-size ISS keeps help, launch, telemetry, fullscreen and 12° FOV');
      } finally { await session.context.close(); }
    });
    await t.test('a failed candidate leaves the original rendered page available', async () => {
      const session = await openMap(browser, served);
      try {
        const page = session.page;
        const original = browser.newContext.bind(browser);
        browser.newContext = async (...args) => {
          const context = await original(...args);
          await context.route(`${served.url}/**`, (route) => route.abort());
          return context;
        };
        try { await assert.rejects(replaceDeviceContext(session, frames[0])); }
        finally { browser.newContext = original; }
        assert.equal(session.page, page);
        assert.equal(page.isClosed(), false);
        assert.equal(browser.contexts().length, 1);
        assert.equal((await state(page)).mapReady, true);
      } finally { await session.context.close(); }
    });
  } finally {
    try { await browser?.close(); }
    finally { await served.close(); }
  }
});

test('candidate is painted before context switch', { timeout: 90000 }, async () => {
  const served = await serveSnap();
  let browser;
  let releaseTiles = () => {};
  let changing;
  try {
    browser = await launchWebkit();
    isolateSnapRequests(browser, served.url);
    const session = await openMap(browser, served);
    const oldPage = session.page;
    let candidate;
    let heldRequests = 0;
    const gate = new Promise((resolveGate) => { releaseTiles = resolveGate; });
    const original = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await original(...args);
      await context.addInitScript(() => {
        let heldMap;
        Object.defineProperty(window, '__opdMap', {
          configurable: true,
          get: () => heldMap,
          set(map) {
            heldMap = map;
            map.on('render', () => {
              const gl = map.painter?.context?.gl;
              if (!gl) return;
              const pixels = [];
              for (const [x, y] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75]]) {
                const rgba = new Uint8Array(4);
                gl.readPixels(Math.floor(gl.drawingBufferWidth * x), Math.floor(gl.drawingBufferHeight * y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
                pixels.push([...rgba]);
              }
              window.__lastRasterFrame = { loaded: map.loaded(), pixels };
            });
          },
        });
      });
      // Default boot zoom can finish. Hold the new high-zoom raster demanded
      // by replaying the captured camera, after the real renderer is running.
      await context.route(/\/tile\/(?:[5-9]|\d{2})\//, async (route) => {
        heldRequests += 1;
        await gate;
        await route.fallback();
      });
      context.on('page', (page) => { candidate = page; });
      return context;
    };
    let completed = false;
    changing = replaceDeviceContext(session, frames[0]).then(() => { completed = true; });
    while (!candidate) await new Promise((done) => setTimeout(done, 10));
    await candidate.waitForFunction(() => window.__opdMap?.getZoom() > 6 && window.__opdMap.getLayer('iss-track-layer'));
    await new Promise((done) => setTimeout(done, 4000));
    const beforeRelease = { completed, oldAlive: !oldPage.isClosed(), publicPage: session.page === oldPage };
    releaseTiles();
    await changing;
    assert.ok(heldRequests > 0, 'the replacement camera requested held high-zoom raster tiles');
    assert.deepEqual(beforeRelease, { completed: false, oldAlive: true, publicPage: true }, 'a clear-only render must not replace the visible page');
    // Inspect the frame already drawn at handoff, without waiting for a later
    // pixel/color condition that could hide an early switch to a dark canvas.
    const painted = await session.page.evaluate(() => window.__lastRasterFrame);
    assert.equal(painted.loaded, true);
    assert.ok(painted.pixels.some(([r, g, b, a]) => a > 0 && b > 40 && b > r + 20 && g > r + 10), JSON.stringify(painted));
  } finally {
    releaseTiles();
    await changing?.catch(() => {});
    try { await browser?.close(); }
    finally { await served.close(); }
  }
});
