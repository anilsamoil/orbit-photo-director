import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { driveStartMs } from './fixtures.mjs';

const script = join(import.meta.dirname, 'opd-verify.mjs');

test('OPD_VERIFY_DRIVE_START older than six hours is rejected', () => {
  const wall = Date.parse('2026-10-07T13:00:00.000Z');
  assert.throws(() => driveStartMs('2020-01-01', wall), (error) => {
    assert.match(error.message, /OPD_VERIFY_DRIVE_START/);
    assert.match(error.message, /2020-01-01/);
    assert.match(error.message, /6h/);
    return true;
  });
  assert.throws(() => driveStartMs('2026-10-07T06:59:59.000Z', wall), /6h/);
});

test('a drive start inside six hours and a future start are kept', () => {
  const wall = Date.parse('2026-10-07T13:00:00.000Z');
  assert.equal(driveStartMs('2026-10-07T07:00:00.000Z', wall), Date.parse('2026-10-07T07:00:00.000Z'));
  assert.equal(driveStartMs('2026-10-07T12:00:00.000Z', wall), Date.parse('2026-10-07T12:00:00.000Z'));
  assert.equal(driveStartMs('2026-10-08T00:00:00.000Z', wall), Date.parse('2026-10-08T00:00:00.000Z'));
  assert.equal(driveStartMs('', wall), wall);
  assert.equal(driveStartMs('   ', wall), wall);
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
  assert.match(output, /OPD_VERIFY_DRIVE_START 2020-01-01 is older than 6h/);
  assert.doesNotMatch(output, /queue cards timed out/);
  assert.doesNotMatch(output, /WebKit/);
});
