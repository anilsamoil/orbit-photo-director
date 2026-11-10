import assert from 'node:assert/strict';
import test from 'node:test';
import { provePlanGestureHolds, provePlanOutsideEnding } from './drive.mjs';
import { serveSnap, isolateSnapRequests } from './context-state-fixture.mjs';
import { launchChrome, launchWebkit, DESKTOP_CHROME_SPEC, WEBKIT_DEVICES, openDeviceContext, playwrightSend } from './webkit-devices.mjs';

for (const [engine, launch, spec] of [
  ['webkit', launchWebkit, WEBKIT_DEVICES.find((entry) => entry.slug === 'ipad-pro-11')],
  ['chrome', launchChrome, DESKTOP_CHROME_SPEC],
]) {
  test(`${engine}: plan gestures and outside endings resize the same renderer`, { timeout: 180000 }, async () => {
    const served = await serveSnap();
    let browser;
    try {
      browser = await launch();
      const imageContext = await browser.newContext();
      const imagePage = await imageContext.newPage();
      await imagePage.setContent('<canvas width="128" height="128"></canvas>');
      await imagePage.evaluate(() => {
        const context = document.querySelector('canvas').getContext('2d');
        const pixels = context.createImageData(128, 128);
        let seed = 275;
        for (let index = 0; index < pixels.data.length; index += 4) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          pixels.data[index] = seed & 255;
          pixels.data[index + 1] = (seed >>> 8) & 255;
          pixels.data[index + 2] = (seed >>> 16) & 255;
          pixels.data[index + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
      });
      const tile = await imagePage.locator('canvas').screenshot();
      assert.ok(tile.length > 4000);
      await imageContext.close();
      isolateSnapRequests(browser, served.url);
      const cartoDark = [];
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...args) => {
        const context = await newContext(...args);
        context.on('request', (request) => {
          if (/basemaps\.cartocdn\.com\/dark_all/.test(request.url())) cartoDark.push(request.url());
        });
        await context.route(/\/tile\//, (route) => route.fulfill({ contentType: 'image/png', body: tile }));
        return context;
      };
      const session = await openDeviceContext(browser, spec);
      await session.page.goto(`${served.url}/?e2e`);
      await session.page.locator('#tab-iss').evaluate((element) => element.click());
      await session.page.waitForFunction(() => document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset?.getZoom);
      await session.page.waitForTimeout(1500);
      const send = playwrightSend(session);
      send.cartoDark = cartoDark;
      const viewport = { ...session.descriptor.viewport, mobile: Boolean(session.descriptor.isMobile) };
      const originalPage = session.page;
      const originalDpr = await session.page.evaluate(() => window.devicePixelRatio);
      for (const kind of ['up', 'cancel', 'lost', 'blur']) {
        const result = await provePlanOutsideEnding(send, viewport, kind,
          { ...viewport, dpr: originalDpr },
          { width: viewport.width - 40, height: viewport.height - 40, dpr: originalDpr === 2 ? 1 : 2 });
        assert.equal(session.page, originalPage);
        assert.equal(await session.page.evaluate(() => window.devicePixelRatio), originalDpr);
        assert.equal(await session.page.evaluate(() => '__opdPlanLayout' in window), false);
        assert.equal(result.dpr, originalDpr === 2 ? 1 : 2);
      }
      await provePlanGestureHolds(send);
      assert.equal(session.page, originalPage);
      assert.equal(await session.page.evaluate(() => window.devicePixelRatio), originalDpr);
      assert.equal(await session.page.evaluate(() => '__opdPlanLayout' in window), false);
    } finally {
      await browser?.close();
      await served.close();
    }
  });
}
