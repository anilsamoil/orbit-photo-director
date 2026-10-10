import assert from 'node:assert/strict';
import nodeChildProcess, { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { refreshLaunchClock } from './fixtures.mjs';

const fixtureModule = new URL('./fixtures.mjs', import.meta.url).href;
const NOW = Date.parse('2026-10-10T12:00:00.000Z');

function fixture(t) {
  const home = mkdtempSync('/tmp/opd-fixture-lock-');
  const dir = join(home, 'fixtures');
  const hooks = join(home, 'hooks');
  mkdirSync(dir);
  mkdirSync(hooks);
  const launch = JSON.stringify({ generated_at: new Date(NOW).toISOString(), items: [] });
  writeFileSync(join(dir, 'launch.json'), launch);
  writeFileSync(join(dir, 'launch-latest.json'), JSON.stringify({ sha256: 'initial', path: 'launch/v/verifyrev.json' }));
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill('SIGKILL');
    }
    await Promise.all([...children].map((child) => child.done));
    rmSync(home, { recursive: true, force: true });
  });
  return { home, dir, hooks, children, launch };
}

function childProcess(ctx, source, { hooks = [], timeout = 30_000, watchdog = 45_000 } = {}) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPD_VERIFY_FIXTURE_HOOK_DIR: ctx.hooks,
      OPD_VERIFY_FIXTURE_HOOKS: hooks.join(','),
      OPD_VERIFY_LOCK_TIMEOUT_MS: String(timeout),
    },
  });
  const chunks = [];
  proc.stdout.on('data', (part) => chunks.push(part));
  proc.stderr.on('data', (part) => chunks.push(part));
  const child = { proc, output: () => Buffer.concat(chunks).toString('utf8'), timedOut: false };
  child.done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.timedOut = true;
      proc.kill('SIGKILL');
    }, watchdog);
    proc.once('error', (error) => chunks.push(Buffer.from(String(error))));
    proc.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  ctx.children.add(child);
  return child;
}

function writer(ctx, options = {}) {
  return childProcess(ctx, `
    import { refreshLaunchClock } from ${JSON.stringify(fixtureModule)};
    refreshLaunchClock(${JSON.stringify(ctx.dir)}, ${NOW});
    console.log('published');
  `, options);
}

async function successful(child) {
  const result = await child.done;
  assert.equal(child.timedOut, false, `writer exceeded its watchdog: ${child.output()}`);
  assert.equal(result.code, 0, child.output());
  assert.match(child.output(), /published/);
}

function readyPath(ctx, point, child) {
  return join(ctx.hooks, `${point}.${child.proc.pid}.ready`);
}

function release(ctx, point, child) {
  writeFileSync(join(ctx.hooks, `${point}.${child.proc.pid}.continue`), 'continue');
}

function ready(ctx, point, child) {
  const file = readyPath(ctx, point, child);
  return new Promise((resolve, reject) => {
    let finished = false;
    const observer = watch(ctx.hooks, inspect);
    const timer = setTimeout(() => finish(new Error(`missing ${point} for ${child.proc.pid}: ${child.output()}`)), 15_000);
    function finish(error, payload) {
      if (finished) return;
      finished = true;
      observer.close();
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(payload);
    }
    function inspect() {
      if (!existsSync(file)) return;
      try {
        finish(null, JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        // A subsequent change event follows a ready marker still being written.
      }
    }
    void child.done.then(() => {
      inspect();
      if (!finished) finish(new Error(`writer exited before ${point}: ${child.output()}`));
    });
    inspect();
  });
}

async function deadPid(ctx) {
  const exited = childProcess(ctx, 'process.exit(0);');
  assert.equal((await exited.done).code, 0);
  return exited.proc.pid;
}

test('a throwing publication releases its lock while the throwing process is still alive', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.dir, 'launch.json'), '{invalid JSON');
  assert.throws(() => refreshLaunchClock(ctx.dir, NOW), SyntaxError);
  assert.equal(existsSync(`${ctx.dir}.writer.lock`), false, 'finally must release the still-live owner');
  writeFileSync(join(ctx.dir, 'launch.json'), ctx.launch);
  refreshLaunchClock(ctx.dir, NOW);
  assert.equal(existsSync(`${ctx.dir}.writer.lock`), false);
  assert.equal(JSON.parse(readFileSync(join(ctx.dir, 'launch.json'), 'utf8')).generated_at, new Date(NOW - 60_000).toISOString());
});

test('a live holder produces a bounded lock timeout without removing its staging', async (t) => {
  const ctx = fixture(t);
  const stage = `${ctx.dir}.gen-${process.pid}-aabbcc`;
  mkdirSync(stage);
  writeFileSync(join(stage, 'keep'), 'live stage');
  for (const owner of [
    String(process.pid),
    JSON.stringify({ pid: process.pid, started: 'a different start-time representation', token: 'another claim' }),
  ]) {
    writeFileSync(`${ctx.dir}.writer.lock`, owner);
    const child = writer(ctx, { timeout: 180, watchdog: 20_000 });
    const result = await child.done;
    assert.equal(child.timedOut, false, 'removing the timeout must fail here, not hang the test runner');
    assert.equal(result.code, 1, child.output());
    assert.match(child.output(), /fixture writer lock.*(?:held|timeout)/i);
    assert.equal(readFileSync(`${ctx.dir}.writer.lock`, 'utf8'), owner, 'a live PID is not stale merely because start metadata differs');
    assert.equal(readFileSync(join(stage, 'keep'), 'utf8'), 'live stage');
  }
});

test('a dead writer is recovered instead of timing out', async (t) => {
  const ctx = fixture(t);
  writeFileSync(`${ctx.dir}.writer.lock`, String(await deadPid(ctx)));
  await successful(writer(ctx, { timeout: 300, watchdog: 20_000 }));
  assert.equal(existsSync(`${ctx.dir}.writer.lock`), false);
  assert.equal(JSON.parse(readFileSync(join(ctx.dir, 'launch.json'), 'utf8')).generated_at, new Date(NOW - 60_000).toISOString());
});

test('three acquire/recover/acquire contenders finish without exposing a free lock or removing live staging', async (t) => {
  const ctx = fixture(t);
  const stale = String(await deadPid(ctx));
  writeFileSync(`${ctx.dir}.writer.lock`, stale);
  const first = writer(ctx, { hooks: ['writer-lock-observed', 'generation-staged'] });
  await ready(ctx, 'writer-lock-observed', first);
  const second = writer(ctx, { hooks: ['writer-lock-waiting', 'writer-lock-observed', 'generation-staged'] });
  const third = writer(ctx, { hooks: ['writer-lock-waiting', 'writer-lock-observed', 'generation-staged'] });
  await Promise.all([ready(ctx, 'writer-lock-waiting', second), ready(ctx, 'writer-lock-waiting', third)]);
  assert.equal(readFileSync(`${ctx.dir}.writer.lock`, 'utf8'), stale, 'owner validation must not rename the lock away');
  assert.equal(existsSync(readyPath(ctx, 'generation-staged', second)), false);
  assert.equal(existsSync(readyPath(ctx, 'generation-staged', third)), false);
  release(ctx, 'writer-lock-observed', first);
  const firstStage = await ready(ctx, 'generation-staged', first);
  const sentinel = join(firstStage.next, 'live-stage-sentinel');
  writeFileSync(sentinel, 'first writer owns this');
  release(ctx, 'writer-lock-waiting', second);
  release(ctx, 'writer-lock-waiting', third);
  const checked = await Promise.race([
    ready(ctx, 'writer-lock-observed', second).then((data) => ({ child: second, data })),
    ready(ctx, 'writer-lock-observed', third).then((data) => ({ child: third, data })),
  ]);
  assert.equal(checked.data.owner.pid, first.proc.pid);
  assert.equal(readFileSync(sentinel, 'utf8'), 'first writer owns this');
  release(ctx, 'writer-lock-observed', checked.child);
  const otherChecker = checked.child === second ? third : second;
  const otherOwner = await ready(ctx, 'writer-lock-observed', otherChecker);
  assert.equal(otherOwner.owner.pid, first.proc.pid);
  assert.equal(readFileSync(sentinel, 'utf8'), 'first writer owns this');
  release(ctx, 'writer-lock-observed', otherChecker);
  release(ctx, 'generation-staged', first);
  await successful(first);
  const staged = await Promise.race([
    ready(ctx, 'generation-staged', second).then((data) => ({ child: second, data })),
    ready(ctx, 'generation-staged', third).then((data) => ({ child: third, data })),
  ]);
  assert.equal(existsSync(staged.data.next), true);
  release(ctx, 'generation-staged', staged.child);
  await successful(staged.child);
  const last = staged.child === second ? third : second;
  const lastStage = await ready(ctx, 'generation-staged', last);
  assert.equal(existsSync(lastStage.next), true);
  release(ctx, 'generation-staged', last);
  await successful(last);
  assert.equal(existsSync(`${ctx.dir}.writer.lock`), false);
});

test('release leaves a replacement live owner lock intact', async (t) => {
  const firstFixture = fixture(t);
  const otherFixture = fixture(t);
  const first = writer(firstFixture, { hooks: ['generation-staged'] });
  await ready(firstFixture, 'generation-staged', first);
  const other = writer(otherFixture, { hooks: ['writer-lock-acquired'] });
  await ready(otherFixture, 'writer-lock-acquired', other);
  const replacement = readFileSync(`${otherFixture.dir}.writer.lock`, 'utf8');
  writeFileSync(`${firstFixture.dir}.writer.lock`, replacement);
  release(firstFixture, 'generation-staged', first);
  await successful(first);
  assert.equal(other.proc.exitCode, null, 'replacement owner must remain alive during release');
  assert.equal(readFileSync(`${firstFixture.dir}.writer.lock`, 'utf8'), replacement);
  release(otherFixture, 'writer-lock-acquired', other);
  await successful(other);
  await successful(writer(firstFixture));
  assert.equal(existsSync(`${firstFixture.dir}.writer.lock`), false);
});

for (const [point, field, prefix] of [
  ['next-link-created', 'link', '.next-'],
  ['lock-temp-created', 'tmp', '.writer.lock.'],
]) {
  test(`a writer terminated at ${point} leaves no orphan after the next publication`, async (t) => {
    const ctx = fixture(t);
    // Begin with a published symlink so the next publication reaches the next-link boundary.
    refreshLaunchClock(ctx.dir, NOW);
    const child = writer(ctx, { hooks: [point] });
    const artifact = await ready(ctx, point, child);
    assert.equal(existsSync(artifact[field]), true);
    if (artifact.tmp) writeFileSync(artifact.tmp, '{partial owner metadata');
    child.proc.kill('SIGKILL');
    assert.equal((await child.done).signal, 'SIGKILL');
    await successful(writer(ctx, { timeout: 1_000, watchdog: 20_000 }));
    const leftovers = readdirSync(ctx.home).filter((name) => name.startsWith(`${basename(ctx.dir)}${prefix}`));
    assert.deepEqual(leftovers, []);
    if (artifact.next) assert.equal(existsSync(artifact.next), false, 'the terminated writer stage must also be reclaimed');
    assert.equal(existsSync(`${ctx.dir}.writer.lock`), false);
  });
}

test('cleanup preserves stage, next-link and lock-temp artifacts whose owner is still alive', async (t) => {
  const ctx = fixture(t);
  const owner = childProcess(ctx, 'setInterval(() => {}, 1_000);');
  const stage = `${ctx.dir}.gen-${owner.proc.pid}-aabbcc`;
  const next = `${ctx.dir}.next-${owner.proc.pid}-ddeeff`;
  const temp = `${ctx.dir}.writer.lock.${owner.proc.pid}.aabbcc`;
  // Old rename/recovery claims were named for the recoverer, not necessarily
  // the actual owner stored inside. Never infer their ownership from the name.
  const legacyClaim = `${ctx.dir}.writer.lock.claim-${await deadPid(ctx)}-aabbcc`;
  mkdirSync(stage);
  writeFileSync(join(stage, 'sentinel'), 'live owner');
  symlinkSync(stage, next);
  writeFileSync(temp, String(owner.proc.pid));
  writeFileSync(legacyClaim, String(owner.proc.pid));
  await successful(writer(ctx));
  assert.equal(readFileSync(join(stage, 'sentinel'), 'utf8'), 'live owner');
  assert.equal(readFileSync(join(next, 'sentinel'), 'utf8'), 'live owner');
  assert.equal(readFileSync(temp, 'utf8'), String(owner.proc.pid));
  assert.equal(readFileSync(legacyClaim, 'utf8'), String(owner.proc.pid));
  owner.proc.kill('SIGKILL');
  await owner.done;
  await successful(writer(ctx));
  assert.equal(existsSync(stage), false);
  assert.equal(readdirSync(ctx.home).includes(basename(next)), false, 'a dangling next symlink is still an orphan');
  assert.equal(existsSync(temp), false);
});

test('a lost acquisition acknowledgement releases the live caller claim and allows retry', (t) => {
  const ctx = fixture(t);
  const spawnSync = nodeChildProcess.spawnSync;
  let injected = false;
  t.mock.method(nodeChildProcess, 'spawnSync', (command, args, options) => {
    const result = spawnSync(command, args, options);
    if (!injected && command === 'python3' && JSON.parse(args[2]).action === 'acquire'
      && result.status === 0 && JSON.parse(result.stdout).status === 'acquired') {
      injected = true;
      assert.equal(existsSync(`${ctx.dir}.writer.lock`), true, 'real helper must acquire before its reply is lost');
      return { ...result, stdout: '{truncated acquisition acknowledgement' };
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => refreshLaunchClock(ctx.dir, NOW), SyntaxError);
    assert.equal(injected, true);
    assert.equal(existsSync(`${ctx.dir}.writer.lock`), false, 'the still-live caller must not strand its unacknowledged claim');
    refreshLaunchClock(ctx.dir, NOW);
    assert.equal(existsSync(`${ctx.dir}.writer.lock`), false);
    assert.equal(JSON.parse(readFileSync(join(ctx.dir, 'launch.json'), 'utf8')).generated_at, new Date(NOW - 60_000).toISOString());
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
