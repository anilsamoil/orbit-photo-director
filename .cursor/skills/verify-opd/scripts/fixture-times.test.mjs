import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildFixtures, CATALOG_NET_OFFSET_MS, QUEUE_HORIZON_MS, stampEventTimes } from './fixtures.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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
  if (typeof value === 'string' && ISO.test(value)) out.push([path, Date.parse(value)]);
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
    const snaps = [];
    for (const start of starts) {
      stampEventTimes(dir, start);
      assertQueueWindow(dir, start);
      assertCatalogNet(dir, start);
      snaps.push(snapshot(dir));
    }
    const paths = new Set(snaps.flatMap((snap) => [...snap.keys()]));
    const problems = [];
    for (const path of paths) {
      const values = snaps.map((snap) => snap.get(path));
      if (values.some((value) => value === undefined)) {
        problems.push(`${path} missing from a stamp`);
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
    assert.deepEqual(problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
