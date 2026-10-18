import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWebkit, playwrightSend } from './webkit-devices.mjs';
import { whenViewportLaidOut } from './drive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(resolve(root, 'frontend/package.json'));
const { chromium } = require('playwright');

const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>';

async function launch(engine) {
  if (engine === 'WebKit') return launchWebkit();
  return chromium.launch({ channel: 'chrome', headless: true });
}

async function open(browser) {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 } });
  const page = await context.newPage();
  await page.setContent(html);
  return page;
}

async function stallFrames(page, swallowPageTimer) {
  await page.evaluate((swallow) => {
    window.__resizes = [];
    window.addEventListener('resize', () => window.__resizes.push([window.innerWidth, window.innerHeight]));
    const realSet = window.setTimeout;
    const realClear = window.clearTimeout;
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    window.__timers = new Set();
    window.__resizeListeners = 0;
    window.setTimeout = (fn, ms, ...args) => {
      if (swallow && ms >= 8000) return 0;
      const id = realSet(fn, ms, ...args);
      window.__timers.add(id);
      return id;
    };
    window.clearTimeout = (id) => {
      window.__timers.delete(id);
      return realClear(id);
    };
    window.addEventListener = (type, listener, options) => {
      if (type === 'resize') window.__resizeListeners += 1;
      return realAdd(type, listener, options);
    };
    window.removeEventListener = (type, listener, options) => {
      if (type === 'resize') window.__resizeListeners -= 1;
      return realRemove(type, listener, options);
    };
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
  }, swallowPageTimer);
}

function raceCall(pending, ms) {
  const started = Date.now();
  return Promise.race([
    pending.then(
      (value) => ({ status: 'resolved', value, elapsed: Date.now() - started }),
      (error) => ({ status: 'rejected', message: error instanceof Error ? error.message : String(error), elapsed: Date.now() - started }),
    ),
    new Promise((resolveRace) => {
      setTimeout(() => resolveRace({ status: 'pending', elapsed: Date.now() - started }), ms);
    }),
  ]);
}

for (const engine of ['Chrome', 'WebKit']) {
  test(`stalled frames after a matching resize reject on ${engine}`, { timeout: 20_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await stallFrames(page, false);
      const result = await raceCall(whenViewportLaidOut(playwrightSend(page), 390, 520), 11_000);
      const trace = await page.evaluate(() => ({
        resizes: window.__resizes,
        timers: window.__timers.size,
        listeners: window.__resizeListeners,
      }));
      assert.ok(trace.resizes.some((size) => size[0] === 390 && size[1] === 520), JSON.stringify(trace));
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.match(result.message, /390x520/);
      assert.match(result.message, /"timedOut":true/);
      assert.ok(result.elapsed >= 6_500 && result.elapsed < 11_000, String(result.elapsed));
      assert.equal(trace.timers, 0);
      assert.equal(trace.listeners, 0);
    } finally {
      await browser.close();
    }
  });

  test(`a page timer that never fires still hits the drive deadline on ${engine}`, { timeout: 20_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await stallFrames(page, true);
      const result = await raceCall(whenViewportLaidOut(playwrightSend(page), 390, 520), 15_000);
      const trace = await page.evaluate(() => ({
        resizes: window.__resizes,
        timers: window.__timers.size,
        listeners: window.__resizeListeners,
      }));
      assert.ok(trace.resizes.some((size) => size[0] === 390 && size[1] === 520), JSON.stringify(trace));
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.match(result.message, /390x520/);
      assert.match(result.message, /"deadline":true|"aborted":true/);
      assert.ok(result.elapsed >= 11_000 && result.elapsed < 15_000, String(result.elapsed));
      assert.equal(trace.timers, 0);
      assert.equal(trace.listeners, 0);
    } finally {
      await browser.close();
    }
  });

  test(`a failed viewport command cleans up on ${engine}`, { timeout: 10_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await stallFrames(page, false);
      const real = playwrightSend(page);
      const send = (method, params) => {
        if (method === 'Emulation.setDeviceMetricsOverride') throw new Error('viewport command failed');
        return real(method, params);
      };
      const started = Date.now();
      await assert.rejects(() => whenViewportLaidOut(send, 390, 520), /viewport command failed/);
      const state = await page.evaluate(() => Promise.race([
        window.__opdViewportSettled.then((value) => ({ state: 'settled', value })),
        new Promise((resolveState) => setTimeout(() => resolveState({ state: 'pending' }), 400)),
      ]));
      assert.equal(state.state, 'settled', JSON.stringify(state));
      assert.equal(state.value.aborted, true);
      assert.ok(Date.now() - started < 2_000);
      const trace = await page.evaluate(() => ({ timers: window.__timers.size, listeners: window.__resizeListeners }));
      assert.equal(trace.timers, 0);
      assert.equal(trace.listeners, 0);
    } finally {
      await browser.close();
    }
  });

  test(`a matching resize that paints resolves on ${engine}`, { timeout: 15_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      const started = Date.now();
      await whenViewportLaidOut(playwrightSend(page), 390, 520);
      assert.ok(Date.now() - started < 5_000);
      const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      assert.deepEqual(size, [390, 520]);
    } finally {
      await browser.close();
    }
  });
}
