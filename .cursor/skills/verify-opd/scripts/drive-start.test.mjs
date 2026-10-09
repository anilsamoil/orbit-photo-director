import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { driveStartMs } from './fixtures.mjs';

const wall = Date.parse('2026-10-09T13:00:00.000Z');
const script = join(import.meta.dirname, 'opd-verify.mjs');

test('an empty drive start is the wall clock', () => {
  assert.equal(driveStartMs('', wall), wall);
  assert.equal(driveStartMs(undefined, wall), wall);
  assert.equal(driveStartMs('   ', wall), wall);
});

test('a naive drive start is rejected', () => {
  assert.throws(() => driveStartMs('2026-10-09T13:00:00', wall), /OPD_VERIFY_DRIVE_START must be a zoned timestamp/);
  assert.throws(() => driveStartMs('2026-10-09T13:00:00.000', wall), /OPD_VERIFY_DRIVE_START must be a zoned timestamp/);
  assert.throws(() => driveStartMs('2020-01-01', wall), /OPD_VERIFY_DRIVE_START must be a zoned timestamp: 2020-01-01/);
});

test('an expired drive start is rejected', () => {
  const expired = new Date(wall - 21 * 60_000).toISOString();
  assert.throws(() => driveStartMs(expired, wall), /OPD_VERIFY_DRIVE_START .* is expired/);
  assert.throws(() => driveStartMs('2020-01-01T00:00:00Z', wall), /OPD_VERIFY_DRIVE_START .* is expired/);
});

test('a drive start outside the 90-minute horizon is rejected', () => {
  const ahead = new Date(wall + 41 * 60_000).toISOString();
  assert.throws(() => driveStartMs(ahead, wall), /OPD_VERIFY_DRIVE_START .* is outside the 90-minute horizon/);
  assert.throws(() => driveStartMs('2099-01-01T00:00:00.000Z', wall), /OPD_VERIFY_DRIVE_START .* is outside the 90-minute horizon/);
});

test('a zoned start inside the horizon is kept', () => {
  const past = wall - 10 * 60_000;
  assert.equal(driveStartMs(new Date(past).toISOString(), wall), past);
  assert.equal(driveStartMs('2026-10-09T12:50:00Z', wall), Date.parse('2026-10-09T12:50:00Z'));
  assert.equal(driveStartMs('2026-10-09T07:50:00-05:00', wall), Date.parse('2026-10-09T07:50:00-05:00'));
});

test('drive checks the origin before a browser', () => {
  const source = readFileSync(new URL('./opd-verify.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function drive(');
  const end = source.indexOf('\nfunction ', start + 1);
  const body = source.slice(start, end);
  const guard = body.indexOf('driveStartMs(');
  const browser = ['driveFeatures(', 'driveMapCorner(', 'startChrome(', 'launchWebkit(']
    .map((name) => body.indexOf(name))
    .filter((index) => index >= 0);
  assert.ok(guard >= 0);
  assert.ok(browser.length >= 2);
  assert.ok(Math.min(...browser) > guard);
});

test('drive rejects 2020-01-01 before a browser starts', () => {
  const home = mkdtempSync(join(tmpdir(), 'opd-drive-start-'));
  const result = spawnSync(process.execPath, [script, 'drive', 'queue'], {
    env: { ...process.env, OPD_VERIFY_DRIVE_START: '2020-01-01', OPD_VERIFY_HOME: home },
    encoding: 'utf8',
    timeout: 20000,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /OPD_VERIFY_DRIVE_START must be a zoned timestamp: 2020-01-01/);
  assert.doesNotMatch(output, /queue cards timed out/);
  assert.doesNotMatch(output, /WebKit/);
});
