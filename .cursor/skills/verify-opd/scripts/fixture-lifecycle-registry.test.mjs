import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildFixtures, CATALOG_NET_OFFSET_MS, discardDriveFixtures, FIXTURE_COOKIE, publishDriveFixtures } from './fixtures.mjs';

async function proxy(t) {
  const home = mkdtempSync(join(tmpdir(), 'opd-registry-isolation-'));
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

test('private catalogs keep their own start, lease, and retained body across concurrent owners', async (t) => {
  const { origin, owners, wall } = await proxy(t);
  const samples = [];
  for (const owner of [owners[0], owners[1], { offset: 0, headers: {} }, owners[0]]) {
    const response = await fetch(`${origin}/launch/catalog/latest.json`, { headers: owner.headers });
    assert.equal(response.status, 200);
    const pointer = await response.json();
    const bodyResponse = await fetch(`${origin}/${pointer.path}`, { headers: owner.headers });
    assert.equal(bodyResponse.status, 200);
    const body = await bodyResponse.text();
    assert.equal(createHash('sha256').update(body).digest('hex'), pointer.sha256);
    const catalog = JSON.parse(body);
    assert.ok(Math.abs(Date.parse(catalog.items[0].schedule.net) - wall - owner.offset - CATALOG_NET_OFFSET_MS) < 1000,
      `catalog event must use its owner's ${owner.offset}ms start offset`);
    const now = Date.now() + owner.offset;
    assert.ok(Date.parse(catalog.generated_at) <= now && now < Date.parse(catalog.geometry_valid_until), 'catalog lease contains the owner clock');
    samples.push({ pointer, body });
  }
  assert.notEqual(samples[0].body, samples[1].body);
  assert.notEqual(samples[0].body, samples[2].body);
  assert.deepEqual(samples[0], samples[3]);
  const foreign = await fetch(`${origin}/${samples[0].pointer.path}`, { headers: owners[1].headers });
  assert.equal(foreign.status, 404, 'a private catalog body must not be readable through another drive');

  const armed = await fetch(`${origin}/api/verify/catalog-hold`, { method: 'POST', headers: owners[0].headers, body: '{}' });
  assert.equal(armed.status, 200);
  const held = await (await fetch(`${origin}/launch/catalog/latest.json`, { headers: owners[0].headers })).json();
  assert.notEqual(held.revision, samples[0].pointer.revision);
  const unaffected = await (await fetch(`${origin}/launch/catalog/latest.json`, { headers: owners[1].headers })).json();
  assert.deepEqual(unaffected, samples[1].pointer);
  const released = await fetch(`${origin}/api/verify/catalog-release`, { method: 'POST', headers: owners[0].headers, body: '{}' });
  assert.equal(released.status, 200, 'release must use the same private clock as the hold');
  const afterRelease = await fetch(`${origin}/${held.path}`, { headers: owners[0].headers });
  assert.equal(afterRelease.status, 200);
  const afterBody = await afterRelease.text();
  assert.equal(createHash('sha256').update(afterBody).digest('hex'), held.sha256);
  assert.equal(JSON.parse(afterBody).items[0].schedule.net, JSON.parse(samples[0].body).items[0].schedule.net);
});
