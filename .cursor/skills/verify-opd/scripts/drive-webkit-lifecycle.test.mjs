import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { webkit } from '../../../../frontend/node_modules/playwright/index.mjs';
import { driveFeatures } from './drive.mjs';

test('WebKit drive reaches setup and closes a standard Browser without process()', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'opd-webkit-lifecycle-'));
  const surface = process.env.OPD_VERIFY_SURFACE;
  const viewport = process.env.OPD_VERIFY_VIEWPORT;
  let closed = 0;
  const setupFailure = new Error('intentional profile reset failure');
  t.mock.method(webkit, 'launch', async () => ({ close: async () => { closed += 1; } }));
  t.mock.method(globalThis, 'fetch', async () => { throw setupFailure; });
  process.env.OPD_VERIFY_SURFACE = 'iphone-17-pro';
  delete process.env.OPD_VERIFY_VIEWPORT;
  try {
    await assert.rejects(driveFeatures({ baseUrl: 'http://opd.invalid', evidenceDir: join(home, 'evidence'), meta: {}, features: [] }), (error) => error === setupFailure);
    assert.equal(closed, 1, 'browser closes even when setup rejects');
  } finally {
    if (surface === undefined) delete process.env.OPD_VERIFY_SURFACE;
    else process.env.OPD_VERIFY_SURFACE = surface;
    if (viewport === undefined) delete process.env.OPD_VERIFY_VIEWPORT;
    else process.env.OPD_VERIFY_VIEWPORT = viewport;
    rmSync(home, { recursive: true, force: true });
  }
});
