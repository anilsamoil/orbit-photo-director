import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { FIXTURE_COOKIE } from './fixtures.mjs';
import { WEBKIT_DEVICES, launchWebkit, openDeviceContext, replaceDeviceContext } from './webkit-devices.mjs';

test('concurrent WebKit context replacements retain private fixtures, viewport, and storage', async () => {
  const tokens = [randomBytes(8).toString('hex'), randomBytes(8).toString('hex')];
  const bodies = ['first-private-generation', 'second-private-generation'];
  const server = createServer((req, res) => {
    const index = tokens.findIndex((token) => (req.headers.cookie || '').split(';').some((part) => part.trim() === `${FIXTURE_COOKIE}=${token}`));
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.fixture=${JSON.stringify(bodies[index] || 'shared-home')};window.bootStorage={local:localStorage.getItem('drive'),session:sessionStorage.getItem('drive')};</script>`);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const sessions = [];
  const read = (session) => session.page.evaluate(() => ({
    fixture: window.fixture,
    storage: window.bootStorage,
    width: innerWidth,
    height: innerHeight,
  }));
  try {
    browser = await launchWebkit();
    for (const [index, spec] of [WEBKIT_DEVICES[0], WEBKIT_DEVICES[1]].entries()) {
      sessions.push(await openDeviceContext(browser, spec, { baseUrl, fixtureToken: tokens[index] }));
    }
    await Promise.all(sessions.map(async (session, index) => {
      await session.page.goto(baseUrl);
      assert.equal((await read(session)).fixture, bodies[index], 'first navigation must read its private fixture');
      await session.page.evaluate((drive) => {
        localStorage.setItem('drive', drive);
        sessionStorage.setItem('drive', drive);
      }, String(index));
    }));
    bodies[0] = 'first-private-restamped';
    const replacementSizes = [{ width: 390, height: 520 }, { width: 1194, height: 834 }];
    await Promise.all(sessions.map((session, index) => replaceDeviceContext(session, replacementSizes[index])));
    for (let index = 0; index < sessions.length; index += 1) {
      assert.deepEqual(await read(sessions[index]), {
        fixture: bodies[index], storage: { local: String(index), session: String(index) }, ...replacementSizes[index],
      });
    }
    const originalSizes = [{ width: 390, height: 664 }, { width: 834, height: 1194 }];
    await Promise.all(sessions.map((session, index) => replaceDeviceContext(session, originalSizes[index])));
    for (let index = 0; index < sessions.length; index += 1) {
      assert.deepEqual(await read(sessions[index]), {
        fixture: bodies[index], storage: { local: String(index), session: String(index) }, ...originalSizes[index],
      });
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
