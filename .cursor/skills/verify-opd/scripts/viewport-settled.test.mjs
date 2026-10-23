import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceDescriptor, launchWebkit, playwrightSend, WEBKIT_DEVICES } from './webkit-devices.mjs';
import { proveShortTimeRow, whenViewportLaidOut } from './drive.mjs';

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

async function stallFrames(page, swallowPageTimer, releaseFrames = 0) {
  await page.evaluate(({ swallow, releaseFrames: release }) => {
    window.__resizes = [];
    window.addEventListener('resize', () => window.__resizes.push([window.innerWidth, window.innerHeight]));
    const realSet = window.setTimeout;
    const realClear = window.clearTimeout;
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    window.__timers = new Set();
    window.__resizeListeners = 0;
    window.__pendingFrames = new Set();
    window.__scheduledFrames = [];
    window.__cancelledFrames = [];
    let nextFrame = 1;
    let released = 0;
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
    window.requestAnimationFrame = (callback) => {
      const id = nextFrame;
      nextFrame += 1;
      window.__pendingFrames.add(id);
      window.__scheduledFrames.push(id);
      if (released < release) {
        released += 1;
        Promise.resolve().then(() => {
          if (!window.__pendingFrames.has(id)) return;
          window.__pendingFrames.delete(id);
          callback(0);
        });
      }
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      window.__cancelledFrames.push(id);
      window.__pendingFrames.delete(id);
    };
  }, { swallow: swallowPageTimer, releaseFrames });
}

function frameTrace(page) {
  return page.evaluate(() => ({
    resizes: window.__resizes,
    timers: window.__timers.size,
    listeners: window.__resizeListeners,
    pendingFrames: [...window.__pendingFrames],
    scheduledFrames: window.__scheduledFrames,
    cancelledFrames: window.__cancelledFrames,
  }));
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

function hungSend(abortHangs) {
  return (method, params) => {
    if (method === 'Emulation.setDeviceMetricsOverride') {
      if (!abortHangs) throw new Error('viewport command failed');
      return {};
    }
    if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
    const expression = params?.expression ?? '';
    if (expression === 'window.__opdViewportSettled' || expression.includes('__opdAbortViewportLayout?.()')) {
      return new Promise(() => {});
    }
    return { result: { value: true } };
  };
}

function hangSend(which) {
  return (method, params) => {
    if (method === 'Emulation.setDeviceMetricsOverride') {
      if (which === 'viewport') return new Promise(() => {});
      return {};
    }
    if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
    const expression = params?.expression ?? '';
    if (which === 'install' && expression.includes('__opdViewportSettled = new Promise')) {
      return new Promise(() => {});
    }
    if (expression === 'window.__opdViewportSettled' || expression.includes('__opdAbortViewportLayout?.()')) {
      return new Promise(() => {});
    }
    return { result: { value: true } };
  };
}

test('a stalled abort still rejects at the drive deadline', { timeout: 20_000 }, async () => {
  const result = await raceCall(whenViewportLaidOut(hungSend(true), 390, 520), 13_000);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.match(result.message, /"deadline":true/);
  assert.ok(result.elapsed >= 11_000 && result.elapsed < 13_000, String(result.elapsed));
});

test('a failed viewport command rejects while abort is still pending', { timeout: 5_000 }, async () => {
  const result = await raceCall(whenViewportLaidOut(hungSend(false), 390, 520), 3_000);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.match(result.message, /viewport command failed/);
  assert.ok(result.elapsed < 2_000, String(result.elapsed));
});

test('a hung install evaluate rejects at the drive deadline', { timeout: 20_000 }, async () => {
  const result = await raceCall(whenViewportLaidOut(hangSend('install'), 390, 520), 13_000);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.match(result.message, /"deadline":true/);
  assert.ok(result.elapsed >= 11_000 && result.elapsed < 13_000, String(result.elapsed));
});

test('a hung setViewport rejects at the drive deadline', { timeout: 20_000 }, async () => {
  const result = await raceCall(whenViewportLaidOut(hangSend('viewport'), 390, 520), 13_000);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.match(result.message, /"deadline":true/);
  assert.ok(result.elapsed >= 11_000 && result.elapsed < 13_000, String(result.elapsed));
});

function pacedSend() {
  return (method, params) => {
    const expression = params?.expression ?? '';
    if (method === 'Emulation.setDeviceMetricsOverride') {
      return new Promise((resolve) => setTimeout(() => resolve({}), 4_500));
    }
    if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
    if (expression.includes('__opdViewportSettled = new Promise')) {
      return new Promise((resolve) => setTimeout(() => resolve({ result: { value: true } }), 4_500));
    }
    if (expression === 'window.__opdViewportSettled' || expression.includes('__opdAbortViewportLayout?.()')) {
      return new Promise(() => {});
    }
    return { result: { value: true } };
  };
}

test('a 4.5s install and 4.5s viewport share one 12s deadline', { timeout: 20_000 }, async () => {
  const result = await raceCall(whenViewportLaidOut(pacedSend(), 390, 520), 16_000);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.match(result.message, /"deadline":true/);
  assert.ok(result.elapsed >= 11_000 && result.elapsed < 14_000, String(result.elapsed));
});

function stallRestoreSend() {
  let metrics = 0;
  return (method, params) => {
    if (method === 'Emulation.setDeviceMetricsOverride') {
      metrics += 1;
      if (metrics > 1) return new Promise(() => {});
      return {};
    }
    if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
    const expression = params?.expression ?? '';
    if (expression === 'window.__opdViewportSettled' || expression.includes('__opdAbortViewportLayout?.()')) {
      return new Promise(() => {});
    }
    return { result: { value: true } };
  };
}

test('a stalled viewport restore settles the caller near the drive deadline', { timeout: 20_000 }, async () => {
  const result = await raceCall(proveShortTimeRow(stallRestoreSend(), { width: 402, height: 874, mobile: true }), 16_000);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.match(result.message, /"deadline":true/);
  assert.doesNotMatch(result.message, /restore unsettled/);
  assert.ok(result.elapsed >= 11_000 && result.elapsed < 15_000, String(result.elapsed));
});

for (const engine of ['Chrome', 'WebKit']) {
  test(`stalled frames after a matching resize reject on ${engine}`, { timeout: 20_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await stallFrames(page, false);
      const result = await raceCall(whenViewportLaidOut(playwrightSend(page), 390, 520), 13_000);
      const trace = await frameTrace(page);
      assert.ok(trace.resizes.some((size) => size[0] === 390 && size[1] === 520), JSON.stringify(trace));
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.match(result.message, /390x520/);
      assert.match(result.message, /"timedOut":true/);
      assert.ok(result.elapsed >= 7_000 && result.elapsed < 11_500, String(result.elapsed));
      assert.equal(trace.timers, 0);
      assert.equal(trace.listeners, 0);
      assert.deepEqual(trace.scheduledFrames, [1]);
      assert.deepEqual(trace.pendingFrames, []);
      assert.deepEqual(trace.cancelledFrames, [1]);
    } finally {
      await browser.close();
    }
  });

  test(`a second stalled frame is cancelled on ${engine}`, { timeout: 20_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await stallFrames(page, false, 1);
      const result = await raceCall(whenViewportLaidOut(playwrightSend(page), 390, 520), 13_000);
      const trace = await frameTrace(page);
      assert.ok(trace.resizes.some((size) => size[0] === 390 && size[1] === 520), JSON.stringify(trace));
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.match(result.message, /"timedOut":true/);
      assert.ok(result.elapsed >= 7_000 && result.elapsed < 11_500, String(result.elapsed));
      assert.deepEqual(trace.scheduledFrames, [1, 2]);
      assert.deepEqual(trace.pendingFrames, []);
      assert.deepEqual(trace.cancelledFrames, [2]);
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
      const state = await Promise.race([
        page.evaluate(() => window.__opdViewportSettled.then((value) => ({ state: 'settled', value }))),
        new Promise((resolveState) => setTimeout(() => resolveState({ state: 'pending' }), 400)),
      ]);
      const trace = await page.evaluate(() => ({ timers: window.__timers.size, listeners: window.__resizeListeners }));
      assert.equal(state.state, 'settled', JSON.stringify(state));
      assert.equal(state.value.aborted, true);
      assert.ok(Date.now() - started < 2_000);
      assert.equal(trace.timers, 0);
      assert.equal(trace.listeners, 0);
    } finally {
      await browser.close();
    }
  });

  test(`an already matching viewport resolves after two frames on ${engine}`, { timeout: 15_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      const send = playwrightSend(page);
      await whenViewportLaidOut(send, 390, 520);
      await stallFrames(page, false, 2);
      const started = Date.now();
      await whenViewportLaidOut(send, 390, 520);
      const elapsed = Date.now() - started;
      const trace = await frameTrace(page);
      assert.ok(elapsed < 2_000, String(elapsed));
      assert.deepEqual(trace.resizes, []);
      assert.deepEqual(trace.scheduledFrames, [1, 2]);
      assert.deepEqual(trace.pendingFrames, []);
      assert.equal(trace.timers, 0);
      assert.equal(trace.listeners, 0);
      const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      assert.deepEqual(size, [390, 520]);
    } finally {
      await browser.close();
    }
  });

  test(`a thrown final settle read aborts without waiting on ${engine}`, { timeout: 10_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await stallFrames(page, false);
      const real = playwrightSend(page);
      const boom = new Error('settle read failed');
      boom.settleRead = true;
      const send = (method, params) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'window.__opdViewportSettled') throw boom;
        return real(method, params);
      };
      const started = Date.now();
      await assert.rejects(() => whenViewportLaidOut(send, 390, 520), (error) => {
        assert.equal(error, boom);
        return true;
      });
      const state = await Promise.race([
        page.evaluate(() => window.__opdViewportSettled.then((value) => ({ state: 'settled', value }))),
        new Promise((resolveState) => setTimeout(() => resolveState({ state: 'pending' }), 1_500)),
      ]);
      const trace = await page.evaluate(() => ({ timers: window.__timers.size, listeners: window.__resizeListeners }));
      assert.equal(state.state, 'settled', JSON.stringify(state));
      assert.equal(state.value.aborted, true);
      assert.ok(Date.now() - started < 3_000, String(Date.now() - started));
      assert.equal(trace.listeners, 0);
      assert.equal(trace.timers, 0);
    } finally {
      await browser.close();
    }
  });

  test(`a delayed command that leaves a different live size rejects on ${engine}`, { timeout: 20_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await page.setViewportSize({ width: 390, height: 520 });
      const real = playwrightSend(page);
      const send = async (method, params) => {
        if (method !== 'Emulation.setDeviceMetricsOverride') return real(method, params);
        await new Promise((resolve) => setTimeout(resolve, 60));
        await page.setViewportSize({ width: 430, height: 700 });
        return {};
      };
      const result = await raceCall(whenViewportLaidOut(send, 390, 520), 15_000);
      const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.match(result.message, /390x520/);
      assert.match(result.message, /"timedOut":true/);
      assert.match(result.message, /"w":430/);
      assert.match(result.message, /"h":700/);
      assert.ok(result.elapsed >= 7_000 && result.elapsed < 12_000, String(result.elapsed));
      assert.deepEqual(size, [430, 700]);
    } finally {
      await browser.close();
    }
  });

  test(`a delayed viewport command settles only after it applies on ${engine}`, { timeout: 15_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await page.setViewportSize({ width: 390, height: 520 });
      await page.evaluate(() => {
        const real = window.requestAnimationFrame;
        window.__frameAt = [];
        window.requestAnimationFrame = (callback) => real((time) => {
          window.__frameAt.push(performance.now());
          return callback(time);
        });
      });
      const real = playwrightSend(page);
      const send = async (method, params) => {
        if (method !== 'Emulation.setDeviceMetricsOverride') return real(method, params);
        await new Promise((resolve) => setTimeout(resolve, 60));
        await page.evaluate(() => { window.__commandAt = performance.now(); });
        return real(method, params);
      };
      await whenViewportLaidOut(send, 390, 520);
      const trace = await page.evaluate(() => ({ frameAt: window.__frameAt, commandAt: window.__commandAt }));
      const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      assert.ok(trace.frameAt.length >= 2, JSON.stringify(trace));
      assert.ok(trace.frameAt.every((time) => time >= trace.commandAt), JSON.stringify(trace));
      assert.deepEqual(size, [390, 520]);
    } finally {
      await browser.close();
    }
  });

  test(`a DPR change from 3 to 1 settles only after the command on ${engine}`, { timeout: 15_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await page.setViewportSize({ width: 390, height: 520 });
      await page.evaluate(() => {
        let dpr = 3;
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => dpr });
        window.__setDpr = (value) => { dpr = value; };
        const real = window.requestAnimationFrame;
        window.__frameDpr = [];
        window.requestAnimationFrame = (callback) => real((time) => {
          window.__frameDpr.push(window.devicePixelRatio);
          return callback(time);
        });
      });
      const real = playwrightSend(page);
      const send = async (method, params) => {
        if (method !== 'Emulation.setDeviceMetricsOverride') return real(method, params);
        await new Promise((resolve) => setTimeout(resolve, 60));
        await page.evaluate(() => window.__setDpr(1));
        return real(method, params);
      };
      await whenViewportLaidOut(send, 390, 520);
      const dprs = await page.evaluate(() => window.__frameDpr);
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      assert.ok(dprs.length >= 2, JSON.stringify(dprs));
      assert.ok(dprs.every((value) => value === 1), JSON.stringify(dprs));
      assert.equal(dpr, 1);
    } finally {
      await browser.close();
    }
  });

  test(`a resize during the settle frames restarts and still matches on ${engine}`, { timeout: 15_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await page.evaluate(() => {
        window.__held = [];
        window.__scheduledFrames = [];
        window.__cancelledFrames = [];
        window.__pendingFrames = new Set();
        let next = 1;
        window.requestAnimationFrame = (callback) => {
          const id = next;
          next += 1;
          window.__scheduledFrames.push(id);
          window.__pendingFrames.add(id);
          window.__held.push({ id, callback });
          return id;
        };
        window.cancelAnimationFrame = (id) => {
          window.__cancelledFrames.push(id);
          window.__pendingFrames.delete(id);
        };
        window.__releaseFrames = () => {
          const batch = window.__held.splice(0);
          for (const item of batch) {
            if (!window.__pendingFrames.has(item.id)) continue;
            window.__pendingFrames.delete(item.id);
            item.callback(0);
          }
        };
      });
      const pending = whenViewportLaidOut(playwrightSend(page), 390, 520);
      pending.catch(() => {});
      let inflight = [];
      for (let i = 0; i < 60; i += 1) {
        inflight = await page.evaluate(() => (
          window.innerWidth === 390 && window.innerHeight === 520 ? [...window.__pendingFrames] : []
        ));
        if (inflight.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(inflight.length >= 1, JSON.stringify(inflight));
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      const during = await page.evaluate(() => ({
        cancelled: window.__cancelledFrames.slice(),
        pending: [...window.__pendingFrames],
      }));
      assert.ok(inflight.every((id) => during.cancelled.includes(id)), JSON.stringify({ inflight, during }));
      assert.ok(during.pending.length >= 1, JSON.stringify(during));
      assert.ok(during.pending.every((id) => !inflight.includes(id)), JSON.stringify({ inflight, during }));
      const early = await raceCall(pending, 500);
      assert.equal(early.status, 'pending', JSON.stringify(early));
      await page.evaluate(() => window.__releaseFrames());
      await page.evaluate(() => window.__releaseFrames());
      await pending;
      const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      assert.deepEqual(size, [390, 520]);
    } finally {
      await browser.close();
    }
  });

  test(`an arm failure clears the listener and the page promise on ${engine}`, { timeout: 10_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await stallFrames(page, false);
      const real = playwrightSend(page);
      const send = (method, params) => {
        if (method === 'Runtime.evaluate' && String(params?.expression || '').includes('__opdArmViewportLayout?.')) {
          throw new Error('arm failed');
        }
        return real(method, params);
      };
      const started = Date.now();
      await assert.rejects(() => whenViewportLaidOut(send, 390, 520), /arm failed/);
      const state = await Promise.race([
        page.evaluate(() => window.__opdViewportSettled.then((value) => ({ state: 'settled', value }))),
        new Promise((resolveState) => setTimeout(() => resolveState({ state: 'pending' }), 1_500)),
      ]);
      const trace = await page.evaluate(() => ({ timers: window.__timers.size, listeners: window.__resizeListeners }));
      assert.equal(state.state, 'settled', JSON.stringify(state));
      assert.equal(state.value.aborted, true);
      assert.ok(Date.now() - started < 3_000, String(Date.now() - started));
      assert.equal(trace.listeners, 0);
      assert.equal(trace.timers, 0);
    } finally {
      await browser.close();
    }
  });

  test(`a command from 980x1307 settles the live size on ${engine}`, { timeout: 15_000 }, async () => {
    const browser = await launch(engine);
    const page = await open(browser);
    try {
      await page.setViewportSize({ width: 980, height: 1307 });
      const real = playwrightSend(page);
      let liveAtRead = null;
      const send = async (method, params) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'window.__opdViewportSettled') {
          liveAtRead = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
        }
        return real(method, params);
      };
      await whenViewportLaidOut(send, 390, 520);
      const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      assert.deepEqual(size, [390, 520], JSON.stringify({ liveAtRead, size }));
      assert.deepEqual(liveAtRead, [390, 520], JSON.stringify({ liveAtRead, size }));
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

const timeHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<div class="map-command"><div class="map-controls-time">
<button id="time-fwd-90" style="position:fixed;left:8px;top:8px;width:44px;height:44px">+90</button>
</div></div>
</body></html>`;

const deviceCases = [
  {
    label: 'iPhone 17 Pro',
    spec: WEBKIT_DEVICES.find((entry) => entry.slug === 'iphone-17-pro'),
    dpr: 3,
    width: 402,
    height: 874,
  },
  {
    label: 'iPad Pro 11',
    spec: { name: 'iPad Pro 11', slug: 'ipad-pro-11', viewport: { width: 834, height: 1210 } },
    dpr: 2,
    width: 834,
    height: 1210,
  },
];

for (const engine of ['Chrome', 'WebKit']) {
  for (const device of deviceCases) {
    test(`proveShortTimeRow keeps ${device.label} at DPR ${device.dpr} on ${engine}`, { timeout: 40_000 }, async () => {
      const browser = await launch(engine);
      const descriptor = deviceDescriptor(device.spec);
      const context = await browser.newContext(descriptor);
      const page = await context.newPage();
      try {
        await page.setContent(timeHtml);
        const before = await page.evaluate(() => window.devicePixelRatio);
        assert.equal(before, device.dpr, JSON.stringify(descriptor.viewport));
        await proveShortTimeRow(playwrightSend(page), {
          width: descriptor.viewport.width,
          height: descriptor.viewport.height,
          mobile: true,
        });
        const after = await page.evaluate(() => ({
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio,
        }));
        assert.equal(after.dpr, device.dpr);
        assert.deepEqual([after.w, after.h], [device.width, device.height]);
      } finally {
        await browser.close();
      }
    });
  }
}
