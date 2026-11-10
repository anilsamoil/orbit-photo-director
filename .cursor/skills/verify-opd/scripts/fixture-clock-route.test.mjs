import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { installOneShotClock } from './fixture-clock.mjs';
import { WEBKIT_DEVICES, launchWebkit, openDeviceContext } from './webkit-devices.mjs';

const FROZEN = 1700000000000;

test('webkit: retiring the clock preserves a held local context route until fulfillment', { timeout: 60000 }, async (t) => {
  const events = [];
  const server = createServer((req, res) => {
    if (req.url === '/src/main.ts') {
      res.setHeader('content-type', 'text/javascript');
      res.end('window.__moduleBooted = true;');
    } else {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><head><script type="module" src="/src/main.ts"></script></head><body>ok</body>');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchWebkit();
  try {
    const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
    const pending = [];
    let entered;
    const intercepted = new Promise((done) => { entered = done; });
    await session.context.route(`${origin}/src/main.ts`, (route) => {
      pending.push(route);
      events.push(`context-handler-${pending.length}`);
      entered();
    });
    const remove = await installOneShotClock(session.page, `${origin}/snap?e2e`, FROZEN);
    await session.page.goto(`${origin}/other`, { waitUntil: 'commit' });
    await intercepted;
    const response = await pending[0].fetch();
    const body = await response.text();
    events.push('context-fetch-complete');
    await remove();
    events.push('clock-retired');
    t.diagnostic(JSON.stringify(events));
    assert.equal(pending.length, 1, 'retiring the clock must not hand a held context request to the context again');
    await pending[0].fulfill({ response, body });
    events.push('context-fulfilled');
    await session.page.waitForFunction(() => window.__moduleBooted === true);
    assert.equal(pending.length, 1, 'the context route keeps exclusive ownership through fulfillment');
    assert.notEqual(await session.page.evaluate(() => Date.now()), FROZEN);
    t.diagnostic(JSON.stringify(events));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

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
