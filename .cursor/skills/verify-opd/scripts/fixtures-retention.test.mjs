import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { bodyForRequestPath, buildFixtures, generationRoots, refreshLaunchClock, stampEventTimes } from './fixtures.mjs';

const start = Date.parse('2026-10-10T12:00:00Z');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

async function fixture(t) {
  // Deliberately use the Mac's /tmp alias, not os.tmpdir() or a canonical TMPDIR.
  const home = mkdtempSync('/tmp/opd-retention-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'fixtures');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline fixture test'); });
  await buildFixtures(dir, start, start);
  t.mock.restoreAll();
  return { home, dir };
}

function policy(t, retention, count) {
  for (const [key, value] of Object.entries({
    OPD_VERIFY_FIXTURE_RETENTION_MS: retention,
    OPD_VERIFY_FIXTURE_MAX_GENERATIONS: count,
  })) {
    const old = process.env[key];
    process.env[key] = String(value);
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}

async function proxy(t, home) {
  writeFileSync(join(home, 'state.json'), JSON.stringify({ port: 0 }));
  // Observe the kernel-selected port without modifying the production proxy.
  const preload = join(home, 'listen.mjs');
  writeFileSync(preload, `import { Server } from 'node:http';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (...args) {
      this.once('listening', () => process.send({ port: this.address().port }));
      return listen.apply(this, args);
    };`);
  const child = spawn(process.execPath, ['--import', preload, new URL('./opd-verify.mjs', import.meta.url).pathname, 'serve'], {
    env: { ...process.env, OPD_VERIFY_HOME: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const done = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await done; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy startup timed out: ${output}`)), 60_000);
    child.once('message', ({ port }) => { clearTimeout(timer); resolve(port); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
  });
  return `http://127.0.0.1:${port}`;
}

test('held /tmp manifest and immutable launch URL survive many publications through the proxy', async (t) => {
  const { home, dir } = await fixture(t);
  const origin = await proxy(t, home);
  const get = async (path) => {
    const response = await fetch(`${origin}/${path}`);
    assert.equal(response.status, 200, path);
    return Buffer.from(await response.arrayBuffer());
  };
  const manifest = JSON.parse(await get('manifest.json'));
  const pointer = JSON.parse(await get('launch/latest.json'));
  const top5 = await get(manifest.artifacts.top5.path);
  const launch = await get(pointer.path);
  assert.match(pointer.path, /^launch\/v\/[a-f0-9]{64}\.json$/);
  assert.equal(JSON.parse(launch).revision, pointer.revision);
  assert.equal(pointer.path, `launch/v/${pointer.revision}.json`);
  assert.equal(digest(launch), pointer.sha256);
  const originalRoot = realpathSync(dir);
  for (let n = 1; n <= 24; n += 1) {
    stampEventTimes(dir, start + n * 1000, start);
    refreshLaunchClock(dir, start + n * 1000);
  }
  const current = json(dir, 'launch-latest.json');
  const partial = `${dir}.gen-${process.pid}-000000000000`;
  mkdirSync(partial);
  writeFileSync(join(partial, 'launch.json'), '{partial staging write');
  assert.notEqual(current.path, pointer.path);
  assert.notEqual(current.sha256, pointer.sha256);
  assert.deepEqual(await get(manifest.artifacts.top5.path), top5);
  assert.deepEqual(await get(pointer.path), launch);
  assert.equal(digest(await get(current.path)), current.sha256);
  assert.equal(digest(top5), manifest.artifacts.top5.sha256);
  assert.ok(generationRoots(dir).includes(originalRoot));
  assert.deepEqual(generationRoots(dir), generationRoots(realpathSync(home) + '/fixtures'));
  assert.equal(new Set(generationRoots(dir)).size, generationRoots(dir).length);
  assert.equal((await fetch(`${origin}/launch/v/${'0'.repeat(64)}.json`)).status, 404);
});

test('a slow link switch does not consume the held manifest reader window', async (t) => {
  const { dir } = await fixture(t);
  policy(t, 100, 4);
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const held = json(dir, 'manifest.json').artifacts.top5;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === dir) now += 1000;
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    stampEventTimes(dir, start + 1000);
    assert.equal(digest(bodyForRequestPath(dir, `/${held.path}`)), held.sha256);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('interrupted retirement metadata restarts a conservative reader window', async (t) => {
  const { dir } = await fixture(t);
  policy(t, 100, 8);
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const held = json(dir, 'manifest.json').artifacts.top5;
  const oldRoot = realpathSync(dir);
  stampEventTimes(dir, start + 1000);
  for (const partial of ['', '{"retiredAt":179', '179']) {
    writeFileSync(join(oldRoot, '.retired-at'), partial);
    now += 1000;
    stampEventTimes(dir, now);
    assert.equal(digest(bodyForRequestPath(dir, `/${held.path}`)), held.sha256);
  }
});

test('retention expires by retirement time, reclaims generations, and applies bounded backpressure', async (t) => {
  const { home, dir } = await fixture(t);
  policy(t, 100, 4);
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const original = json(dir, 'manifest.json').artifacts.top5;
  const bytes = bodyForRequestPath(dir, `/${original.path}`);
  for (let n = 1; n <= 3; n += 1) stampEventTimes(dir, start + n * 1000);
  const current = realpathSync(dir);
  assert.equal(generationRoots(dir).length, 4);
  for (let n = 0; n < 3; n += 1) {
    assert.throws(() => stampEventTimes(dir, start + 5000), /retention capacity/);
    assert.equal(realpathSync(dir), current);
    assert.deepEqual(bodyForRequestPath(dir, `/${original.path}`), bytes);
    assert.equal(generationRoots(dir).length, 4);
  }
  now += 99;
  assert.throws(() => stampEventTimes(dir, start + 5000), /retention capacity/);
  now += 1;
  stampEventTimes(dir, start + 5000);
  assert.equal(generationRoots(dir).length, 2);
  assert.equal(bodyForRequestPath(dir, `/${original.path}`), null);

  // A long-idle current manifest starts its reader window only when retired.
  const idle = json(dir, 'manifest.json').artifacts.top5;
  now += 1_000_000;
  stampEventTimes(dir, start + 6000);
  assert.equal(digest(bodyForRequestPath(dir, `/${idle.path}`)), idle.sha256);
  now += 99;
  stampEventTimes(dir, start + 7000);
  assert.equal(digest(bodyForRequestPath(dir, `/${idle.path}`)), idle.sha256);
  now += 1;
  stampEventTimes(dir, start + 8000);
  assert.equal(bodyForRequestPath(dir, `/${idle.path}`), null);
  assert.ok(generationRoots(dir).length <= 4);
  assert.equal(readdirSync(home).filter((name) => name.startsWith('fixtures.gen-')).length, generationRoots(dir).length);
});
