import assert from 'node:assert/strict';
import test from 'node:test';
import { auditContextBoundary } from './context-boundary.mjs';
import { DESKTOP_CHROME_SPEC, launchChrome } from './webkit-devices.mjs';

const descriptor = DESKTOP_CHROME_SPEC.descriptor;
const resizePage = ['set', 'Viewport', 'Size'].join('');

test('real browser boundary rejects resize aliases, raw CDP, extra contexts and partial descriptors', async (t) => {
  const browser = await launchChrome();
  const audit = auditContextBoundary(browser);
  try {
    audit.expect(descriptor);
    const context = await browser.newContext({ ...descriptor, serviceWorkers: 'block' });
    const page = await context.newPage();
    await t.test('direct and computed page method calls fail before changing geometry', async () => {
      const before = page.viewportSize();
      const alias = page;
      await assert.rejects(page[resizePage]({ width: 800, height: 600 }), /forbidden page viewport resize/);
      await assert.rejects(alias[['set', 'ViewportSize'].join('')]({ width: 800, height: 600 }), /forbidden page viewport resize/);
      const imported = await import('data:text/javascript,' + encodeURIComponent(`export default (page) => page[['set', 'Viewport', 'Size'].join('')]({ width: 800, height: 600 });`));
      await assert.rejects(imported.default(page), /forbidden page viewport resize/);
      assert.deepEqual(page.viewportSize(), before);
    });
    await t.test('raw CDP metrics cannot bypass the context factory', async () => {
      const cdp = await context.newCDPSession(page);
      try {
        await assert.rejects(cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 800, height: 600, deviceScaleFactor: 1, mobile: false,
        }), /forbidden raw CDP resize/);
        await assert.rejects(cdp.send('Emulation.setVisibleSize', { width: 800, height: 600 }), /forbidden raw CDP resize/);
      } finally {
        await cdp.detach();
      }
    });
    await t.test('an unplanned complete context and default-context shortcut both fail', async () => {
      await assert.rejects(browser.newContext(descriptor), /unexpected extra browser.newContext/);
      await assert.rejects(browser.newPage(), /context factory required/);
      audit.assertCounts({ opened: 1, closed: 0, live: 1 });
    });
    await t.test('every immutable descriptor field must reach the browser', async () => {
      for (const key of ['deviceScaleFactor', 'isMobile', 'hasTouch', 'screen', 'userAgent', 'defaultBrowserType']) {
        assert.ok(Object.hasOwn(descriptor, key), `fixture provides ${key}`);
        const partial = { ...descriptor };
        delete partial[key];
        audit.expect(descriptor);
        await assert.rejects(browser.newContext(partial), /complete immutable device descriptor/);
      }
      audit.assertCounts({ opened: 1, closed: 0, live: 1 });
    });
    await context.close();
    audit.assertCounts({ opened: 1, closed: 1, live: 0 });
  } finally {
    audit.restore();
    await browser.close();
  }
});
