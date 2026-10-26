import assert from 'node:assert/strict';
import test from 'node:test';
import { proveShortTimeRow } from './drive.mjs';
import { WEBKIT_DEVICES, launchWebkit, openDeviceContext, playwrightSend } from './webkit-devices.mjs';
import { isolateSnapRequests, serveSnap } from './context-state-fixture.mjs';

test('WebKit time-row verification restores a real SNAP context before returning', { timeout: 90000 }, async () => {
  const served = await serveSnap();
  const browser = await launchWebkit();
  try {
    isolateSnapRequests(browser, served.url);
    const spec = WEBKIT_DEVICES.find((entry) => entry.slug === 'iphone-17-pro');
    const session = await openDeviceContext(browser, spec);
    await session.page.goto(`${served.url}/?e2e`);
    await session.page.locator('#tab-map').evaluate((el) => el.click());
    await session.page.waitForFunction(() => window.__opdMap?.getLayer('iss-track-layer')
      && document.getElementById('toggle-follow-iss')?.hasAttribute('aria-pressed'));
    if (await session.page.evaluate(() => document.body.classList.contains('map-chrome-hidden'))) {
      await session.page.locator('#map-chrome-toggle').evaluate((el) => el.click());
    }
    await proveShortTimeRow(playwrightSend(session), { width: 402, height: 874, mobile: true });
    assert.deepEqual(await session.page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]), [402, 874, 3]);
    assert.equal(browser.contexts().length, 1);
  } finally {
    await browser.close();
    await served.close();
  }
});
