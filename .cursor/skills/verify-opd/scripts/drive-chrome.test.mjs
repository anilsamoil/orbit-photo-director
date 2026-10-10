import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { driveFeatures } from './drive.mjs';

test('desktop drive applies the effective offset to its page clock and keeps it ticking', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'opd-chrome-offset-'));
  const fixtureDir = join(home, 'fixtures');
  mkdirSync(fixtureDir);
  writeFileSync(join(fixtureDir, 'launch.json'), JSON.stringify({ items: [] }));
  writeFileSync(join(fixtureDir, 'launch-latest.json'), JSON.stringify({}));

  const originalSurface = process.env.OPD_VERIFY_SURFACE;
  const originalViewport = process.env.OPD_VERIFY_VIEWPORT;
  const originalWebSocket = globalThis.WebSocket;
  const originalKill = process.kill;
  const wall = Date.parse('2026-10-09T13:00:00.000Z');
  const fakeChromePid = 1_073_741_823;
  const launched = [];
  const stopped = [];
  const pages = [];
  let browser;

  // Only transport/process boundaries are doubled: the real desktop driver,
  // openApp, generated init scripts, and their page-clock effects execute.
  class BrowserSocket {
    constructor() {
      this.listeners = new Map();
      this.initScripts = [];
      this.closed = false;
      browser = this;
      queueMicrotask(() => this.emit('open', {}));
    }

    addEventListener(name, listener) {
      const entries = this.listeners.get(name) || [];
      entries.push(listener);
      this.listeners.set(name, entries);
    }

    emit(name, event) {
      for (const listener of this.listeners.get(name) || []) listener(event);
    }

    send(text) {
      const { id, method, params } = JSON.parse(text);
      let result = {};
      if (method === 'Page.addScriptToEvaluateOnNewDocument') this.initScripts.push(params.source);
      else if (method === 'Page.navigate') {
        assert.equal(params.url, 'http://opd.invalid/?e2e');
        this.page = createContext({
          wallNow: wall,
          console: { error() {} },
          document: {
            readyState: 'complete',
            getElementById: () => ({ textContent: 'Fixture ready' }),
          },
        });
        runInContext('Date.now = () => wallNow; globalThis.window = globalThis; window.addEventListener = () => {};', this.page);
        for (const source of this.initScripts) runInContext(source, this.page);
        pages.push(this.page);
      } else if (method === 'Runtime.evaluate') {
        result = { result: { value: runInContext(params.expression, this.page) } };
      } else {
        assert.ok(['Page.enable', 'Network.enable', 'Emulation.setDeviceMetricsOverride'].includes(method), method);
      }
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id, result }) }));
    }

    close() {
      this.closed = true;
    }
  }

  process.env.OPD_VERIFY_SURFACE = 'desktop';
  delete process.env.OPD_VERIFY_VIEWPORT;
  globalThis.WebSocket = BrowserSocket;
  t.mock.method(childProcess, 'spawn', (command, args) => {
    launched.push({ command, args });
    return { pid: fakeChromePid, unref() {} };
  });
  syncBuiltinESMExports();
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal === 0) return originalKill(pid, signal);
    assert.equal(pid, fakeChromePid);
    assert.equal(signal, 'SIGTERM');
    stopped.push(pid);
    return true;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).pathname, '/json/list');
    return {
      ok: true,
      json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://opd.invalid/browser' }],
    };
  });

  try {
    for (const offset of [-19 * 60_000, 39 * 60_000 + 250, 0]) {
      writeFileSync(join(fixtureDir, 'drive-clock.json'), JSON.stringify({ startOffset: offset }));
      const notes = await driveFeatures({
        baseUrl: 'http://opd.invalid',
        evidenceDir: join(home, 'evidence'),
        meta: {},
        features: [],
        startOffset: offset,
      });
      assert.deepEqual(notes, []);
      assert.equal(runInContext('Date.now()', browser.page), wall + offset, `desktop offset ${offset}`);
      browser.page.wallNow += 1234;
      assert.equal(runInContext('Date.now()', browser.page), wall + offset + 1234, 'effective clock advances with wall time');
      assert.equal(browser.closed, true);
    }
    assert.equal(pages.length, 3);
    assert.equal(launched.length, 3);
    assert.equal(stopped.length, 3);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    globalThis.WebSocket = originalWebSocket;
    if (originalSurface === undefined) delete process.env.OPD_VERIFY_SURFACE;
    else process.env.OPD_VERIFY_SURFACE = originalSurface;
    if (originalViewport === undefined) delete process.env.OPD_VERIFY_VIEWPORT;
    else process.env.OPD_VERIFY_VIEWPORT = originalViewport;
    rmSync(home, { recursive: true, force: true });
  }
});
