import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const mode of ['primary', 'guest']) {
  test(`${mode} Chrome spawn failure reaches the caller's private fixture cleanup`, (t) => {
    const home = mkdtempSync(join(tmpdir(), 'opd-spawn-error-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const source = join(home, 'fixtures');
    const scratch = join(home, 'tmp');
    mkdirSync(source);
    mkdirSync(scratch);
    const files = {
      'passes.json': [],
      'top5.json': [{ target_id: 'verify-reef', target_name: 'Verify Reef', closest_approach: '2000-01-01T00:00:00Z' }],
      'top_24h.json': [],
      'cupola_windows.json': { windows: [] },
      'launch.json': { items: [] },
      'manifest.json': { artifacts: { passes: {}, top5: {}, top_24h: {}, cupola_windows: {} } },
      'launch-latest.json': {},
    };
    for (const [name, data] of Object.entries(files)) writeFileSync(join(source, name), JSON.stringify(data));
    const executable = join(home, 'chrome-with-missing-interpreter');
    writeFileSync(executable, '#!/definitely-missing-opd-chrome-interpreter\n');
    chmodSync(executable, 0o755);
    const marker = join(home, 'cleanup-complete');
    const driver = new URL('./drive.mjs', import.meta.url).href;
    const fixtures = new URL('./fixtures.mjs', import.meta.url).href;
    const program = `
      import { writeFileSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      import { startChrome, freshProfile } from ${JSON.stringify(driver)};
      import { publishDriveFixtures, discardDriveFixtures } from ${JSON.stringify(fixtures)};
      const published = publishDriveFixtures(${JSON.stringify(source)}, Date.now());
      try {
        if (${JSON.stringify(mode)} === 'primary') {
          startChrome(${JSON.stringify(home)}, 1);
          await setTimeout(50);
        } else {
          await freshProfile('http://127.0.0.1:1', ${JSON.stringify(home)}, undefined, async () => {});
        }
      } finally {
        discardDriveFixtures(published.dir);
        writeFileSync(${JSON.stringify(marker)}, 'cleaned');
      }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      env: { ...process.env, TMPDIR: scratch, OPD_VERIFY_CHROME: executable, OPD_VERIFY_GUEST_CDP_PORT: '1', OPD_VERIFY_CDP_PORT: '2' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 1, 'invalid Chrome must fail the drive');
    assert.equal(existsSync(marker), true, 'spawn error must unwind through caller cleanup, not terminate as an unhandled event');
    assert.deepEqual(readdirSync(scratch).filter((name) => name.startsWith('opd-drive-fixtures-')), []);
    assert.doesNotMatch(child.stderr, /Unhandled 'error' event/);
    assert.match(child.stderr, /Chrome failed to start/);
    assert.equal(existsSync(join(home, mode === 'primary' ? 'chrome-profile' : 'chrome-guest-1')), false);
  });
}
