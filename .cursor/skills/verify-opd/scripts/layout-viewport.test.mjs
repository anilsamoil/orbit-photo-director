import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { whenViewportLaidOut } from './drive.mjs';
import { launchWebkit, openDeviceContext, playwrightSend } from './webkit-devices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function productViewport() {
  const html = readFileSync(resolve(root, 'frontend/index.html'), 'utf8');
  const content = html.match(/name="viewport" content="([^"]+)"/);
  if (!content) throw new Error('product viewport meta missing');
  return content[1];
}

test('landscape, portrait, then landscape keeps the product viewport meta', async () => {
  const product = productViewport();
  const html = `<!doctype html><html><head><meta name="viewport" content="${product}"></head><body><div id="status-banner">Ready</div></body></html>`;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const browser = await launchWebkit();
  const session = await openDeviceContext(browser, { name: 'iPhone 13', standalone: true });
  try {
    const port = server.address();
    if (!port || typeof port === 'string') throw new Error('viewport test server has no port');
    await session.page.goto(`http://127.0.0.1:${port.port}/`);
    const send = playwrightSend(session);
    const rotate = [
      [390, 844],
      [844, 390],
      [390, 844],
      [844, 390],
    ];
    for (const [width, height] of rotate) {
      await whenViewportLaidOut(send, width, height);
    }
    const laid = await session.page.evaluate(() => ({
      meta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '',
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    }));
    assert.equal(laid.width, 844);
    assert.equal(laid.height, 390);
    assert.equal(laid.devicePixelRatio, 3);
    assert.equal(laid.meta, product);
    assert.equal(browser.contexts().length, 1);
  } finally {
    await session.context.close();
    await browser.close();
    server.close();
  }
});

test('a timed-out replacement cannot commit after navigation resumes', { timeout: 20000 }, async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><meta name="viewport" content="${productViewport()}"><div id="status-banner">Ready</div>`);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const browser = await launchWebkit();
  let release;
  const gate = new Promise((done) => { release = done; });
  try {
    const session = await openDeviceContext(browser, { name: 'iPhone 13', standalone: true });
    const url = `http://127.0.0.1:${server.address().port}/`;
    await session.page.goto(url);
    const predecessor = session.page;
    const original = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await original(...args);
      await context.route(url, async (route) => {
        await gate;
        await route.continue().catch(() => {});
      });
      return context;
    };
    const real = playwrightSend(session);
    let replacing;
    const send = Object.assign((method, params) => {
      const pending = real(method, params);
      if (method === 'Emulation.setDeviceMetricsOverride') replacing = pending;
      return pending;
    }, real);
    await assert.rejects(whenViewportLaidOut(send, 844, 390), /"deadline":true/);
    release();
    await replacing.catch(() => {});
    assert.equal(session.page === predecessor, true, 'a timed-out candidate must never replace the live predecessor');
    assert.equal(predecessor.isClosed(), false);
    assert.equal(browser.contexts().length, 1, 'the timed-out candidate is closed');
    await whenViewportLaidOut(send, 844, 390);
    assert.equal(session.page === predecessor, false, 'a later request can replace the retained predecessor');
  } finally {
    release();
    await browser.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
