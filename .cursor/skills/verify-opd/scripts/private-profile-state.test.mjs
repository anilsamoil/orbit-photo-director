import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildFixtures, CATALOG_NET_OFFSET_MS, discardDriveFixtures, FIXTURE_COOKIE, publishDriveFixtures } from './fixtures.mjs';

async function proxy(t) {
  const home = mkdtempSync(join(tmpdir(), 'opd-profile-isolation-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const wall = Date.now();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline fixture test'); });
  await buildFixtures(join(home, 'fixtures'), wall);
  t.mock.restoreAll();
  const registrySecret = randomBytes(16).toString('hex');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ home, port: 0, registrySecret }));
  const preload = join(home, 'listen.mjs');
  writeFileSync(preload, `import { Server } from 'node:http';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (...args) {
      this.once('listening', () => process.send({ port: this.address().port }));
      return listen.apply(this, args);
    };`);
  const child = spawn(process.execPath, ['--import', preload, new URL('./opd-verify.mjs', import.meta.url).pathname, 'serve'], {
    env: { ...process.env, OPD_VERIFY_HOME: home }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const done = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await done; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy startup timed out')), 20000);
    child.once('message', ({ port }) => { clearTimeout(timer); resolve(port); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`proxy startup exit ${code}`)); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const owners = [];
  for (const offset of [-10 * 60_000, 30 * 60_000]) {
    const { dir } = publishDriveFixtures(join(home, 'fixtures'), wall + offset, wall);
    t.after(() => discardDriveFixtures(dir));
    const token = randomBytes(8).toString('hex');
    const registered = await fetch(`${origin}/api/verify/fixtures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opd-verify-registry': registrySecret },
      body: JSON.stringify({ token, dir, pid: process.pid }),
    });
    assert.equal(registered.status, 200);
    owners.push({ offset, headers: { cookie: `${FIXTURE_COOKIE}=${token}` } });
  }
  return { origin, owners, wall };
}


test('parallel drive hides and profile resets cannot mutate another drive or the home', async (t) => {
  const { origin, owners } = await proxy(t);
  const endpoint = `${origin}/api/browser/profiles/anil/targets`;
  const read = async (owner) => (await fetch(endpoint, { headers: owner?.headers || {} })).json();
  const put = async (owner, body) => {
    const response = await fetch(endpoint, { method: 'PUT', headers: { ...owner?.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
  };
  const initialB = await read(owners[1]);
  const initialHome = await read();
  await put(owners[0], { targets: [{ id: 'private-site' }], removedCuratedIds: ['verify-reef'], removedCuratedUpdatedAt: '2026-10-28T00:00:00Z' });
  assert.deepEqual((await read(owners[0])).removedCuratedIds, ['verify-reef'], 'same-drive fresh profiles inherit the hide');
  assert.deepEqual(await read(owners[1]), initialB, 'phone hide must not remove the iPad reef pin');
  assert.deepEqual(await read(), initialHome, 'private drive must not mutate home profiles');
  await put(owners[1], { targets: [], removedCuratedIds: [] });
  assert.deepEqual((await read(owners[0])).removedCuratedIds, ['verify-reef'], 'another drive reset must not undo an in-flight hide');
  assert.deepEqual((await read(owners[0])).targets, [{ id: 'private-site' }]);
});

test('private logs and stale profile cookies cannot affect another fixture owner', async (t) => {
  const { origin, owners } = await proxy(t);
  const log = `${origin}/api/log`;
  const posted = await fetch(log, { method: 'POST', headers: { ...owners[0].headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'shoot', target_id: 'private-site' }) });
  assert.equal(posted.status, 200);
  const entries = async (headers) => (await (await fetch(log, { headers })).json()).entries;
  assert.equal((await entries(owners[0].headers)).length, 1);
  assert.deepEqual(await entries(owners[1].headers), []);
  assert.deepEqual(await entries({}), []);
  const stale = { cookie: `${FIXTURE_COOKIE}=expired-test-cookie` };
  for (const path of ['/api/log', '/api/browser/profiles/anil/targets']) {
    assert.equal((await fetch(`${origin}${path}`, { headers: stale })).status, 404);
  }
  assert.equal((await fetch(`${origin}/api/browser/session`, { headers: stale })).status, 200);
});
