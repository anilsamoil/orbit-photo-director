import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchWebkit } from './webkit-devices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(resolve(root, 'frontend/package.json'));
const { devices } = require('playwright');

function productViewport() {
  const html = readFileSync(resolve(root, 'frontend/index.html'), 'utf8');
  const content = html.match(/name="viewport" content="([^"]+)"/);
  if (!content) throw new Error('product viewport meta missing');
  return content[1];
}

test('fresh portrait and landscape contexts preserve the product viewport meta', async () => {
  const product = productViewport();
  const html = `<!doctype html><html><head><meta name="viewport" content="${product}"></head><body></body></html>`;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const browser = await launchWebkit();
  try {
    const port = server.address();
    if (!port || typeof port === 'string') throw new Error('viewport test server has no port');
    const sizes = [
      [390, 844],
      [844, 390],
      [390, 844],
      [844, 390],
    ];
    for (const [width, height] of sizes) {
      const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width, height } });
      try {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${port.port}/`);
        const laid = await page.evaluate(() => ({
          meta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '',
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        }));
        assert.equal(laid.width, width);
        assert.equal(laid.height, height);
        assert.equal(laid.meta, product);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
});
