import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { driveStartMs, fixtureClockMs, refreshLaunchClock } from './fixtures.mjs';

function rmFixtureTree(dir) {
  const parent = dirname(dir);
  const base = basename(dir);
  for (const name of readdirSync(parent)) {
    if (name === base || name.startsWith(`${base}.`)) rmSync(join(parent, name), { recursive: true, force: true });
  }
}

const wall = Date.parse('2026-10-09T13:00:00.000Z');

test('an empty drive start is the wall clock', () => {
  assert.equal(driveStartMs('', wall), wall);
  assert.equal(driveStartMs(undefined, wall), wall);
});

test('a naive drive start is rejected', () => {
  assert.throws(() => driveStartMs('2026-10-09T13:00:00', wall), /OPD_VERIFY_DRIVE_START must be a zoned timestamp/);
  assert.throws(() => driveStartMs('2026-10-09T13:00:00.000', wall), /OPD_VERIFY_DRIVE_START must be a zoned timestamp/);
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
  assert.match(body, /refreshLaunchClock\(resolve\(home, 'fixtures'\), eventStart\)/);
});

test('an invalid calendar date is rejected', () => {
  const wall = Date.parse('2026-03-02T00:10:00.000Z');
  const overflow = Date.parse('2026-02-30T00:00:00Z');
  assert.equal(overflow, Date.parse('2026-03-02T00:00:00.000Z'));
  assert.equal(driveStartMs(new Date(overflow).toISOString(), wall), overflow);
  assert.throws(
    () => driveStartMs('2026-02-30T00:00:00Z', wall),
    /OPD_VERIFY_DRIVE_START is not a valid date/,
  );
  assert.throws(
    () => driveStartMs('2026-02-30T00:00:00.000Z', wall),
    /OPD_VERIFY_DRIVE_START is not a valid date/,
  );

  const nonLeapWall = Date.parse('2025-03-01T00:10:00.000Z');
  const nonLeapOverflow = Date.parse('2025-02-29T00:00:00Z');
  assert.equal(nonLeapOverflow, Date.parse('2025-03-01T00:00:00.000Z'));
  assert.equal(driveStartMs(new Date(nonLeapOverflow).toISOString(), nonLeapWall), nonLeapOverflow);
  assert.throws(
    () => driveStartMs('2025-02-29T00:00:00Z', nonLeapWall),
    /OPD_VERIFY_DRIVE_START is not a valid date/,
  );

  const leapWall = Date.parse('2024-02-29T00:10:00.000Z');
  assert.equal(driveStartMs('2024-02-29T00:00:00Z', leapWall), Date.parse('2024-02-29T00:00:00Z'));
});

test('launch leases follow the drive-start override', () => {
  const wall = Date.parse('2026-10-09T13:00:00.000Z');
  const start = wall - 19 * 60_000;
  const dir = mkdtempSync(join(tmpdir(), 'opd-lease-'));
  const generatedWall = new Date(wall - 60_000).toISOString();
  const launch = {
    generated_at: generatedWall,
    valid_until: new Date(wall - 60_000 + 14 * 60_000).toISOString(),
    coverage: { fetched_at: generatedWall },
    items: [{
      sources: [{ fetched_at: generatedWall }],
      assessment: {
        checked_at: generatedWall,
        valid_until: new Date(wall + 60 * 60_000).toISOString(),
        tle_epoch: generatedWall,
      },
    }],
  };
  writeFileSync(join(dir, 'launch.json'), JSON.stringify(launch));
  writeFileSync(join(dir, 'launch-latest.json'), JSON.stringify({
    generated_at: launch.generated_at,
    valid_until: launch.valid_until,
    sha256: 'old',
  }));
  writeFileSync(join(dir, 'drive-clock.json'), JSON.stringify({ start }));
  try {
    assert.equal(fixtureClockMs(dir, wall), start);
    const until = refreshLaunchClock(dir, fixtureClockMs(dir, wall));
    const next = JSON.parse(readFileSync(join(dir, 'launch.json'), 'utf8'));
    const pointer = JSON.parse(readFileSync(join(dir, 'launch-latest.json'), 'utf8'));
    const generated = new Date(start - 60_000).toISOString();
    const expectedUntil = new Date(start - 60_000 + 14 * 60_000).toISOString();
    assert.equal(next.generated_at, generated);
    assert.equal(next.valid_until, expectedUntil);
    assert.equal(next.coverage.fetched_at, generated);
    assert.equal(next.items[0].sources[0].fetched_at, generated);
    assert.equal(next.items[0].assessment.checked_at, generated);
    assert.equal(next.items[0].assessment.tle_epoch, generated);
    assert.equal(next.items[0].assessment.valid_until, new Date(start - 60_000 + 2 * 60 * 60_000).toISOString());
    assert.equal(pointer.generated_at, generated);
    assert.equal(pointer.valid_until, expectedUntil);
    assert.notEqual(pointer.sha256, 'old');
    assert.equal(until, expectedUntil);
    assert.ok(Date.parse(until) > start);
    assert.ok(Date.parse(until) <= wall);
    assert.notEqual(next.generated_at, generatedWall);
    assert.equal(fixtureClockMs(dir, wall), start);
  } finally {
    rmFixtureTree(dir);
  }
});

test('slideLaunch and the doctor use the override clock', () => {
  const verify = readFileSync(new URL('./opd-verify.mjs', import.meta.url), 'utf8');
  const doctorStart = verify.indexOf('async function doctor(');
  const doctorEnd = verify.indexOf('async function up(', doctorStart);
  const doctor = verify.slice(doctorStart, doctorEnd);
  assert.match(doctor, /fixtureClockMs\(resolve\(home, 'fixtures'\)\)/);
  assert.equal(doctor.includes('Date.now()'), false);

  const drive = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8');
  const slideStart = drive.indexOf('function slideLaunch(');
  const slideEnd = drive.indexOf('\nfunction ', slideStart + 1);
  const slide = drive.slice(slideStart, slideEnd);
  assert.match(slide, /refreshLaunchClock\(dir, fixtureClockMs\(dir\)\)/);
  assert.equal(slide.includes('Date.now()'), false);
});
