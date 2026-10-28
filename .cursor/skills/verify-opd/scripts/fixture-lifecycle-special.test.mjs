import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { driveMapBearingCommit } from './bearing-commit.mjs';
import { driveMapBearing } from './bearing-retarget.mjs';
import { driveMapPagehide } from './corner-pagehide.mjs';
import { FIXTURE_COOKIE } from './fixtures.mjs';
import { closeFixtureBrowsers, createDeviceContext } from './fixture-session.mjs';
import { driveMapHold } from './map-hold.mjs';
import { drivePinFit } from './pin-fit.mjs';
import { driveMapSafeArea } from './safe-area-chrome.mjs';
import { driveSessionLock } from './session-lock.mjs';

const require = createRequire(new URL('../../../../frontend/package.json', import.meta.url));
const { chromium, webkit } = require('playwright');

for (const [name, drive] of Object.entries({ driveMapBearingCommit, driveMapBearing, driveMapPagehide, driveMapHold, drivePinFit, driveMapSafeArea, driveSessionLock })) {
  test(`${name} pins its private fixture cookie and clock before creating any page`, async (t) => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'opd-special-context-'));
    t.after(() => rmSync(evidenceDir, { recursive: true, force: true }));
    const prior = { surface: process.env.OPD_VERIFY_SURFACE, viewport: process.env.OPD_VERIFY_VIEWPORT, lock: process.env.OPD_VERIFY_LOCK };
    Object.assign(process.env, { OPD_VERIFY_SURFACE: 'iphone-17-pro', OPD_VERIFY_VIEWPORT: '402x874', OPD_VERIFY_LOCK: 'queue' });
    t.after(() => {
      for (const [key, value] of Object.entries({ OPD_VERIFY_SURFACE: prior.surface, OPD_VERIFY_VIEWPORT: prior.viewport, OPD_VERIFY_LOCK: prior.lock })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const baseUrl = 'http://127.0.0.1:12345';
    const fixtureToken = 'test-private-fixture';
    const stopped = new Error('browser boundary reached');
    const jar = [];
    const initScripts = [];
    let pages = 0;
    let closed = false;
    const context = {
      async addCookies(cookies) { jar.push(...cookies); },
      async addInitScript(source) { initScripts.push(source); },
      async newPage() {
        pages += 1;
        assert.equal(jar.some((cookie) => cookie.name === FIXTURE_COOKIE && cookie.value === fixtureToken && cookie.url === baseUrl), true,
          'fixture cookie is missing before the first page');
        if (name !== 'driveMapBearing') {
          const source = initScripts.find((entry) => entry?.content?.includes('__opdRealNow'));
          assert.ok(source, 'offset drive must seed its private page clock before navigation');
          const now = Date.now();
          const actual = runInNewContext(`${source.content}; ({ now: Date.now(), constructed: new Date().getTime() })`);
          assert.ok(Math.abs(actual.now - now - 600000) < 1000);
          assert.ok(Math.abs(actual.constructed - actual.now) < 1000);
        }
        throw stopped;
      },
      async close() {},
    };
    const browser = { async newContext() { return context; }, async close() { closed = true; } };
    t.mock.method(chromium, 'launch', async () => browser);
    t.mock.method(webkit, 'launch', async () => browser);
    await assert.rejects(drive({ baseUrl, evidenceDir, fixtureToken, startOffset: 600000 }), (error) => error === stopped);
    assert.equal(pages, 1);
    assert.equal(closed, true);
    await closeFixtureBrowsers();
  });
}

test('concurrent shutdown callers await the same context browser close', async () => {
  let resolveClose;
  const closed = new Promise((resolve) => { resolveClose = resolve; });
  let calls = 0;
  const browser = {
    async newContext() { return {}; },
    async close() { calls += 1; await closed; },
  };
  await createDeviceContext(browser, {});
  let firstDone = false;
  let secondDone = false;
  const first = closeFixtureBrowsers().then(() => { firstDone = true; });
  const second = closeFixtureBrowsers().then(() => { secondDone = true; });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(firstDone, false);
  assert.equal(secondDone, false);
  resolveClose();
  await Promise.all([first, second]);
  assert.equal(firstDone, true);
  assert.equal(secondDone, true);
});

test('a browser close rejection cannot skip the remaining fixture cleanup', async () => {
  const browser = {
    async newContext() { return {}; },
    async close() { throw new Error('browser already disconnected'); },
  };
  await createDeviceContext(browser, {});
  await assert.doesNotReject(closeFixtureBrowsers());
  assert.deepEqual(await closeFixtureBrowsers(), []);
});
