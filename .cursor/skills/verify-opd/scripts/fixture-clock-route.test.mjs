import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { installOneShotClock } from './fixture-clock.mjs';
import { WEBKIT_DEVICES, launchWebkit, openDeviceContext } from './webkit-devices.mjs';

const FROZEN = 1700000000000;

test('webkit: a reordered query still freezes the same document path', { timeout: 60000 }, async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><head></head><body>ok</body>');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchWebkit();
  try {
    const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
    const page = session.page;
    const remove = await installOneShotClock(page, `${origin}/snap?b=1&a=2`, FROZEN);
    await page.goto(`${origin}/other`, { waitUntil: 'domcontentloaded' });
    const live = await page.evaluate(() => Date.now());
    assert.notEqual(live, FROZEN);
    assert.ok(Math.abs(live - Date.now()) < 60_000, `other document stayed live: ${live}`);
    await page.goto(`${origin}/snap?a=2&b=1#kept`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => Date.now()), FROZEN);
    await remove();
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
