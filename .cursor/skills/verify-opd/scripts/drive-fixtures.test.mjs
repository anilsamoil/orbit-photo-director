import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discardDriveFixtures, publishDriveFixtures, stampEventTimes } from './fixtures.mjs';

function writeSharedFixtures(dir) {
  const pass = [{ target_id: 'verify-reef', target_name: 'Verify Reef', closest_approach: '2000-01-01T00:00:00Z' }];
  writeFileSync(join(dir, 'passes.json'), '[]');
  writeFileSync(join(dir, 'top5.json'), JSON.stringify(pass));
  writeFileSync(join(dir, 'top_24h.json'), '[]');
  writeFileSync(join(dir, 'cupola_windows.json'), JSON.stringify({ windows: [] }));
  writeFileSync(join(dir, 'launch.json'), JSON.stringify({ items: [] }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ artifacts: { passes: {}, top5: {}, top_24h: {}, cupola_windows: {} } }));
  writeFileSync(join(dir, 'launch-latest.json'), '{}');
}

function reef(dir) {
  return JSON.parse(readFileSync(join(dir, 'top5.json'), 'utf8'))[0].closest_approach;
}

test('two drives stamp private fixture copies', async () => {
  const source = mkdtempSync(join(tmpdir(), 'opd-drive-source-'));
  const published = [];
  try {
    writeSharedFixtures(source);
    const wall = Date.parse('2026-10-07T13:00:00.000Z');
    const firstStart = Date.parse('2026-10-07T12:00:00.000Z');
    const secondStart = Date.parse('2026-10-07T13:00:00.000Z');
    const [first, second] = await Promise.all([
      Promise.resolve(publishDriveFixtures(source, firstStart, wall)),
      Promise.resolve(publishDriveFixtures(source, secondStart, wall)),
    ]);
    published.push(first.dir, second.dir);
    assert.equal(reef(source), '2000-01-01T00:00:00Z');
    assert.equal(reef(first.dir), '2026-10-07T12:20:00Z');
    assert.equal(reef(second.dir), '2026-10-07T13:20:00Z');
    assert.notEqual(first.dir, second.dir);
  } finally {
    rmSync(source, { recursive: true, force: true });
    for (const dir of published) discardDriveFixtures(dir);
  }
});

test('a private copy follows a generation symlink', () => {
  const source = mkdtempSync(join(tmpdir(), 'opd-drive-source-'));
  writeSharedFixtures(source);
  const wall = Date.parse('2026-10-07T13:00:00.000Z');
  stampEventTimes(source, Date.parse('2026-10-07T12:00:00.000Z'), wall);
  assert.equal(lstatSync(source).isSymbolicLink(), true);
  const sourceRoot = realpathSync(source);
  const copy = publishDriveFixtures(source, Date.parse('2026-10-07T13:00:00.000Z'), wall);
  try {
    assert.equal(reef(source), '2026-10-07T12:20:00Z');
    assert.equal(reef(copy.dir), '2026-10-07T13:20:00Z');
    assert.notEqual(realpathSync(copy.dir), sourceRoot);
    assert.equal(lstatSync(copy.dir).isSymbolicLink(), true);
  } finally {
    discardDriveFixtures(copy.dir);
    discardDriveFixtures(source);
  }
});
