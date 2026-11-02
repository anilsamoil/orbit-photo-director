import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { bodyForRequestPath, buildFixtures, CATALOG_NET_OFFSET_MS, effectiveNowMs, QUEUE_DELTA_OFFSET_MS, QUEUE_HORIZON_MS, QUEUE_REEF_OFFSET_MS, readDriveClock, stampEventTimes, writeTextAtomic } from './fixtures.mjs';

const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ZONELESS_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

const KNOWN_FILES = new Set([
  'catalog-clock.json',
  'catalog.json',
  'cupola_windows.json',
  'drive-clock.json',
  'launch-latest.json',
  'launch.json',
  'manifest.json',
  'meta.json',
  'passes.json',
  'status.json',
  'targets.json',
  'top5.json',
  'top_24h.json',
  'track.json',
  'tracked.json',
]);

const STATIC_PATHS = new Set([
  'catalog.json/generated_at',
  'catalog.json/schedule_valid_until',
  'catalog.json/geometry_valid_until',
  'catalog.json/coverage/from',
  'catalog.json/coverage/until',
  'cupola_windows.json/generated_at',
  'launch-latest.json/generated_at',
  'launch-latest.json/valid_until',
  'launch.json/generated_at',
  'launch.json/valid_until',
  'launch.json/coverage/from',
  'launch.json/coverage/until',
  'launch.json/coverage/fetched_at',
  'launch.json/items/0/sources/0/fetched_at',
  'launch.json/items/0/assessment/checked_at',
  'launch.json/items/0/assessment/valid_until',
  'launch.json/items/0/assessment/tle_epoch',
  'launch.json/items/1/sources/0/fetched_at',
  'manifest.json/generated_at',
  'manifest.json/tle_epoch',
  'manifest.json/cloud_composite_hour',
  'meta.json/now',
  'meta.json/lookupTimestamp',
  'meta.json/launchValidUntil',
  'status.json/last_run',
  'status.json/cloud_composite_hour',
  'status.json/launches_last_successful_fetch',
  'track.json/iss_polynomial/start',
  'track.json/tle_epoch',
]);

function walkTimes(value, path, out) {
  if (typeof value === 'string' && ZONED_TIME.test(value)) out.push([path, Date.parse(value)]);
  else if (typeof value === 'string' && ZONELESS_TIME.test(value)) out.push([path, Number.NaN]);
  else if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) >= 1e12) out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => walkTimes(item, `${path}/${index}`, out));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) walkTimes(child, `${path}/${key}`, out);
  }
}

function snapshot(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  const unknown = files.filter((name) => !KNOWN_FILES.has(name));
  assert.deepEqual(unknown, [], `unclassified fixture file ${unknown.join(', ')}`);
  const rows = [];
  for (const file of files) walkTimes(JSON.parse(readFileSync(join(dir, file), 'utf8')), file, rows);
  return new Map(rows);
}

function assertQueueWindow(dir, start) {
  const top5 = JSON.parse(readFileSync(join(dir, 'top5.json'), 'utf8'));
  assert.equal(top5.length, 2);
  const late = top5.filter((pass) => {
    const ms = Date.parse(pass.closest_approach);
    return !(ms > start && ms < start + QUEUE_HORIZON_MS);
  });
  assert.deepEqual(late.map((pass) => `${pass.target_name} ${pass.closest_approach}`), []);
}

function assertCatalogNet(dir, start) {
  const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
  const net = Date.parse(catalog.items[0].schedule.net);
  assert.equal(net - start, CATALOG_NET_OFFSET_MS);
}

function assertSampleAndNet(dir, start) {
  const files = ['passes.json', 'top5.json', 'top_24h.json'];
  for (const name of files) {
    for (const pass of JSON.parse(readFileSync(join(dir, name), 'utf8'))) {
      assert.equal(Date.parse(pass.sample_time) - start, -30_000, `${name} ${pass.target_name} sample_time`);
    }
  }
  const cupola = JSON.parse(readFileSync(join(dir, 'cupola_windows.json'), 'utf8'));
  assert.equal(Date.parse(cupola.windows[0].sample_time) - start, -30_000);
  assertCatalogNet(dir, start);
}

function problemsFor(snaps, starts) {
  const paths = new Set(snaps.flatMap((snap) => [...snap.keys()]));
  const problems = [];
  for (const path of paths) {
    const values = snaps.map((snap) => snap.get(path));
    if (values.some((value) => value === undefined || !Number.isFinite(value))) {
      problems.push(`${path} is unclassified`);
      continue;
    }
    const frozen = values.every((value) => value === values[0]);
    const moved = values.every((value, index) => value - values[0] === starts[index] - starts[0]);
    if (STATIC_PATHS.has(path)) {
      if (!frozen) problems.push(`${path} is static but moved`);
    } else if (!moved) {
      problems.push(`${path} is unclassified`);
    }
  }
  const unused = [...STATIC_PATHS].filter((path) => !paths.has(path));
  if (unused.length) problems.push(`static path missing ${unused.join(', ')}`);
  return problems;
}

function assertInstant(actual, expected, label) {
  assert.equal(Date.parse(actual), expected, label);
}

function assertEventInstants(dir, start) {
  const approach = {
    'verify-reef': QUEUE_REEF_OFFSET_MS,
    'verify-delta': QUEUE_DELTA_OFFSET_MS,
    'verify-mesa': 8 * 60 * 60_000,
    'cupola:verify-window': 35 * 60_000,
  };
  for (const name of ['passes.json', 'top5.json', 'top_24h.json']) {
    for (const pass of JSON.parse(readFileSync(join(dir, name), 'utf8'))) {
      assertInstant(pass.closest_approach, start + approach[pass.target_id], `${name} ${pass.target_id} closest_approach`);
      assertInstant(pass.sample_time, start - 30_000, `${name} ${pass.target_id} sample_time`);
    }
  }
  const cupola = JSON.parse(readFileSync(join(dir, 'cupola_windows.json'), 'utf8')).windows[0];
  assertInstant(cupola.closest_approach, start + 35 * 60_000, 'cupola closest_approach');
  assertInstant(cupola.sample_time, start - 30_000, 'cupola sample_time');
  assertInstant(cupola.window_start, start + 30 * 60_000, 'cupola window_start');
  assertInstant(cupola.window_end, start + 40 * 60_000, 'cupola window_end');
  const launch = JSON.parse(readFileSync(join(dir, 'launch.json'), 'utf8'));
  const net = start + CATALOG_NET_OFFSET_MS;
  for (const item of launch.items) {
    assertInstant(item.launch_window.net, net, `${item.event_id} net`);
    assertInstant(item.launch_window.start, net, `${item.event_id} start`);
    assertInstant(item.launch_window.end, net + 9 * 60_000, `${item.event_id} end`);
  }
  const capture = launch.items[0].capture_intervals[0];
  assertInstant(capture.start, net + 60_000, 'capture start');
  assertInstant(capture.peak, net + 4 * 60_000, 'capture peak');
  assertInstant(capture.end, net + 8 * 60_000, 'capture end');
  assertInstant(capture.liftoff_start, net, 'liftoff start');
  assertInstant(capture.liftoff_end, net + 60_000, 'liftoff end');
  assertInstant(launch.items[0].assessment.net.at, net, 'assessment net');
  const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
  const schedule = catalog.items[0].schedule;
  assertInstant(schedule.net, net, 'catalog net');
  assertInstant(schedule.window_start, net, 'catalog window start');
  assertInstant(schedule.window_end, net + 9 * 60_000, 'catalog window end');
  const shot = catalog.items[0].shots[0];
  assertInstant(shot.liftoff, net, 'shot liftoff');
  assertInstant(shot.start, net, 'shot start');
  assertInstant(shot.best, net + 60_000, 'shot best');
  assertInstant(shot.end, net + 8 * 60_000, 'shot end');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  for (const [key, name] of [['passes', 'passes.json'], ['top5', 'top5.json'], ['top_24h', 'top_24h.json'], ['cupola_windows', 'cupola_windows.json'], ['catalog', null]]) {
    if (!name) continue;
    const entry = manifest.artifacts[key];
    assert.equal(entry.path, `v/verify/${entry.sha256}/${name}`, key);
  }
}

function generationBytes(root) {
  const bytes = new Map();
  for (const name of readdirSync(root)) {
    if (name.endsWith('.json')) bytes.set(name, readFileSync(join(root, name), 'utf8'));
  }
  return bytes;
}

function rmFixtureTree(dir) {
  const parent = dirname(dir);
  const base = basename(dir);
  for (const name of readdirSync(parent)) {
    if (name === base || name.startsWith(`${base}.`)) rmSync(join(parent, name), { recursive: true, force: true });
  }
}

test('queue passes stay inside 90 minutes and every temporal path is classified', async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const starts = [
    now,
    now + 30 * 24 * 60 * 60_000,
    now - 10 * 60_000,
    Date.parse('2099-06-15T00:00:00.000Z'),
  ];
  const dir = mkdtempSync(join(tmpdir(), 'opd-fixture-times-'));
  try {
    await buildFixtures(dir, now, now);
    assertEventInstants(dir, now);
    const snaps = [];
    let previousPasses = null;
    for (const start of starts) {
      const beforeRoot = realpathSync(dir);
      const beforeBytes = generationBytes(beforeRoot);
      stampEventTimes(dir, start, start);
      assert.notEqual(realpathSync(dir), beforeRoot);
      for (const [name, text] of beforeBytes) {
        assert.equal(readFileSync(join(beforeRoot, name), 'utf8'), text, name);
      }
      const clock = readDriveClock(dir);
      assert.equal(clock.start, start);
      assert.equal(clock.startOffset, 0);
      assert.equal(effectiveNowMs(dir, start + 5 * 60_000), start + 5 * 60_000);
      assertQueueWindow(dir, start);
      assertEventInstants(dir, start);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      const passesText = readFileSync(join(dir, 'passes.json'), 'utf8');
      if (previousPasses && previousPasses.text !== passesText) {
        const oldBody = bodyForRequestPath(dir, `/${previousPasses.path}`);
        assert.equal(oldBody.toString('utf8'), previousPasses.text);
        assert.notEqual(oldBody.toString('utf8'), passesText);
      }
      previousPasses = { path: manifest.artifacts.passes.path, text: passesText };
      snaps.push(snapshot(dir));
    }
    assert.deepEqual(problemsFor(snaps, starts), []);
    const root = realpathSync(dir);
    const before = generationBytes(root);
    const previousPath = previousPasses.path;
    stampEventTimes(dir, now + 60 * 60_000, now);
    assert.notEqual(realpathSync(dir), root);
    for (const [name, text] of before) assert.equal(readFileSync(join(root, name), 'utf8'), text, name);
    assert.notEqual(readFileSync(join(dir, 'passes.json'), 'utf8'), before.get('passes.json'));
    assert.notEqual(readFileSync(join(dir, 'top5.json'), 'utf8'), before.get('top5.json'));
    assert.notEqual(readFileSync(join(dir, 'catalog.json'), 'utf8'), before.get('catalog.json'));
    const oldBody = bodyForRequestPath(dir, `/${previousPath}`);
    assert.equal(oldBody.toString('utf8'), previousPasses.text);
    assert.equal(readDriveClock(dir).startOffset, now + 60 * 60_000 - now);
    assert.equal(effectiveNowMs(dir, now + 14 * 60_000), now + 60 * 60_000 + 14 * 60_000);
    const live = realpathSync(dir);
    const status = JSON.parse(readFileSync(join(live, 'status.json'), 'utf8'));
    status.rotted_at = '2020-01-01T00:00:00';
    writeFileSync(join(live, 'status.json'), JSON.stringify(status));
    const torn = snapshot(dir);
    const zoneProblems = problemsFor([torn, torn], [now, now]);
    assert.ok(zoneProblems.some((problem) => problem.includes('status.json/rotted_at')));
  } finally {
    rmFixtureTree(dir);
  }
});

test('a failed temp write removes the temp file and leaves the target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opd-atomic-'));
  const dest = join(dir, 'passes.json');
  writeFileSync(dest, 'old');
  assert.throws(() => writeTextAtomic(dest, 'new', (tmp) => {
    writeFileSync(tmp, 'partial');
    throw new Error('disk full');
  }), /disk full/);
  assert.equal(readFileSync(dest, 'utf8'), 'old');
  assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('concurrent restamps publish one whole version', async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const dir = mkdtempSync(join(tmpdir(), 'opd-restamp-'));
  try {
    await buildFixtures(dir, now, now);
    stampEventTimes(dir, now);
    const moduleUrl = pathToFileURL(join(import.meta.dirname, 'fixtures.mjs')).href;
    const child = (start) => {
      const chunks = [];
      const proc = spawn(process.execPath, ['--input-type=module', '-e', `
        import { stampEventTimes } from ${JSON.stringify(moduleUrl)};
        for (let i = 0; i < 12; i += 1) stampEventTimes(${JSON.stringify(dir)}, ${start} + i * 1000);
      `], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // This is a publication-integrity stress test; the short bounded wait
        // is independently pinned in fixtures-lock.test.mjs.
        env: { ...process.env, OPD_VERIFY_LOCK_TIMEOUT_MS: '60000' },
      });
      proc.stdout.on('data', (buf) => chunks.push(buf));
      proc.stderr.on('data', (buf) => chunks.push(buf));
      proc.output = () => Buffer.concat(chunks).toString('utf8');
      proc.done = new Promise((resolve) => proc.on('close', resolve));
      return proc;
    };
    const left = child(now);
    const right = child(now + 30 * 24 * 60 * 60_000);
    try {
      let reads = 0;
      const stop = Date.now() + 1500;
      while (Date.now() < stop) {
        let root;
        try {
          root = realpathSync(dir);
        } catch {
          continue;
        }
        let top5;
        let passes;
        let catalog;
        try {
          top5 = JSON.parse(readFileSync(join(root, 'top5.json'), 'utf8'));
          passes = JSON.parse(readFileSync(join(root, 'passes.json'), 'utf8'));
          catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'));
        } catch {
          continue;
        }
        const reef = Date.parse(top5.find((pass) => pass.target_id === 'verify-reef').closest_approach);
        const passReef = Date.parse(passes.find((pass) => pass.target_id === 'verify-reef').closest_approach);
        const net = Date.parse(catalog.items[0].schedule.net);
        assert.equal(reef, passReef);
        assert.equal(net - reef, CATALOG_NET_OFFSET_MS - QUEUE_REEF_OFFSET_MS);
        reads += 1;
      }
      const [leftCode, rightCode] = await Promise.all([left.done, right.done]);
      assert.equal(leftCode, 0, left.output());
      assert.equal(rightCode, 0, right.output());
      assert.ok(reads > 0);
    } finally {
      if (left.exitCode === null) left.kill();
      if (right.exitCode === null) right.kill();
      await Promise.all([left.done, right.done]);
    }
  } finally {
    rmFixtureTree(dir);
  }
});
