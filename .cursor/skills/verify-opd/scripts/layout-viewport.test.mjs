import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: true,
      });
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
