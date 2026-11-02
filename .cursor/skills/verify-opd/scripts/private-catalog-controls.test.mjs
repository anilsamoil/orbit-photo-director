import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureInstant, withHeldCatalog } from './drive.mjs';

test('catalog fallback clock reads the private drive, not the shared home', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'opd-private-clock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evidence = join(root, 'home', 'evidence');
  const shared = join(root, 'home', 'fixtures');
  const privateDir = join(root, 'private');
  for (const dir of [evidence, shared, privateDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(shared, 'catalog-clock.json'), JSON.stringify({ anchor: 100 }));
  writeFileSync(join(privateDir, 'catalog-clock.json'), JSON.stringify({ anchor: 200 }));
  assert.equal(fixtureInstant(evidence, privateDir), 200);
  assert.equal(fixtureInstant(evidence), 100, 'tokenless callers retain the home fallback');
});

test('catalog hold, status and release use the drive cookie even if the body fails', async (t) => {
  const calls = [];
  const send = async () => ({ result: { value: true } });
  send.fixtureToken = 'synthetic-drive-cookie';
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ path: new URL(url).pathname, options });
    return { ok: true, json: async () => ({ pending: true }) };
  });
  const failure = new Error('body failed');
  await assert.rejects(withHeldCatalog(send, 'http://opd.invalid', async () => { throw failure; }), failure);
  assert.deepEqual(calls.map((call) => call.path), ['/api/verify/catalog-hold', '/api/verify/catalog-hold', '/api/verify/catalog-release']);
  for (const call of calls) assert.equal(call.options.headers?.cookie, 'opd-verify-fixtures=synthetic-drive-cookie');
});
