import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const helper = process.env.OPD_CONTEXT_HELPER
  ? pathToFileURL(process.env.OPD_CONTEXT_HELPER).href : './webkit-devices.mjs';
const { WEBKIT_DEVICES, openDeviceContext, replaceDeviceContext } = await import(helper);
const require = createRequire(new URL('../../../../frontend/package.json', import.meta.url));
const { chromium, webkit } = require('playwright');
const HTML = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.bootStorage = {local: {...localStorage}, session: {...sessionStorage}};</script>';

async function serve() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

for (const engine of ['chromium', 'webkit']) {
  test(`${engine}: replacement storage is origin-scoped, available at app boot, and never replayed`, async () => {
    const first = await serve();
    const other = await serve();
    let browser;
    try {
      browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({
        ...(process.env.OPD_VERIFY_CHROME ? { executablePath: process.env.OPD_VERIFY_CHROME } : {}),
      });
      const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
      await session.page.goto(first.url);
      await session.page.evaluate(() => {
        for (const store of [localStorage, sessionStorage]) {
          store.setItem('edited', 'original');
          store.setItem('deleted', 'original');
        }
      });
      await replaceDeviceContext(session, { width: 844, height: 390 });
      const original = { edited: 'original', deleted: 'original' };
      assert.deepEqual(await session.page.evaluate(() => window.bootStorage), { local: original, session: original });
      await session.page.evaluate(() => {
        for (const store of [localStorage, sessionStorage]) {
          store.setItem('edited', 'changed');
          store.removeItem('deleted');
        }
      });
      await session.page.reload();
      const edited = { local: { edited: 'changed' }, session: { edited: 'changed' } };
      assert.deepEqual(await session.page.evaluate(() => window.bootStorage), edited);
      await session.page.goto(other.url);
      assert.deepEqual(await session.page.evaluate(() => window.bootStorage), { local: {}, session: {} });
      await session.page.goto(first.url);
      assert.deepEqual(await session.page.evaluate(() => window.bootStorage), edited);
      await session.page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await session.page.reload();
      assert.deepEqual(await session.page.evaluate(() => window.bootStorage), { local: {}, session: {} });
      // A second replacement of the cleared page must not revive the first snapshot either.
      await replaceDeviceContext(session, { width: 390, height: 664 });
      assert.deepEqual(await session.page.evaluate(() => window.bootStorage), { local: {}, session: {} });
      await session.context.close();
      assert.equal(browser.contexts().length, 0);
    } finally {
      await Promise.all([browser?.close(), first.close(), other.close()]);
    }
  });
}
