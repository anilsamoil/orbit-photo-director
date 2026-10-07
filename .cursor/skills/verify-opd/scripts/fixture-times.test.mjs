import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildFixtures } from './fixtures.mjs';

const SESSION_MARGIN_MS = 6 * 60 * 60 * 1000;

function pushTime(out, label, iso) {
  if (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso))) {
    throw new Error(`${label} is not a time`);
  }
  out.push({ label, iso, ms: Date.parse(iso) });
}

function eventTimes(dir) {
  const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const times = [];
  for (const pass of read('top5.json')) pushTime(times, `top5 ${pass.target_name} closest_approach`, pass.closest_approach);
  for (const pass of read('top_24h.json')) pushTime(times, `top_24h ${pass.target_name} closest_approach`, pass.closest_approach);
  for (const pass of read('passes.json')) pushTime(times, `passes ${pass.target_name} closest_approach`, pass.closest_approach);
  for (const pass of read('cupola_windows.json').windows) {
    pushTime(times, `cupola ${pass.target_name} closest_approach`, pass.closest_approach);
    pushTime(times, `cupola ${pass.target_name} window_start`, pass.window_start);
    pushTime(times, `cupola ${pass.target_name} window_end`, pass.window_end);
  }
  for (const item of read('launch.json').items) {
    pushTime(times, `${item.name} net`, item.launch_window.net);
    pushTime(times, `${item.name} window start`, item.launch_window.start);
    pushTime(times, `${item.name} window end`, item.launch_window.end);
    for (const interval of item.capture_intervals) {
      pushTime(times, `${item.name} capture start`, interval.start);
      pushTime(times, `${item.name} capture peak`, interval.peak);
      pushTime(times, `${item.name} capture end`, interval.end);
      pushTime(times, `${item.name} liftoff start`, interval.liftoff_start);
      pushTime(times, `${item.name} liftoff end`, interval.liftoff_end);
    }
    if (item.assessment) pushTime(times, `${item.name} net at`, item.assessment.net.at);
  }
  return times;
}

test('fixture event times stay ahead of a six-hour session', async () => {
  const start = Date.parse('2026-10-07T11:26:45.000Z');
  const dir = mkdtempSync(join(tmpdir(), 'opd-fixture-times-'));
  try {
    await buildFixtures(dir, start);
    const floor = start + SESSION_MARGIN_MS;
    const late = eventTimes(dir).filter((row) => !(row.ms > floor));
    assert.deepEqual(
      late.map((row) => `${row.label} ${row.iso}`),
      [],
      'a closest_approach of 11:46:45Z is already past once the clock moves',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
