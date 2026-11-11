import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8');
const testFile = fileURLToPath(new URL('./iss-restore-checks.test.mjs', import.meta.url));
const mutations = [
  ['keyboard-roll-finite', "      if (!Number.isFinite(roll)) throw new Error('iss roll is NaN');\n", ''],
  ['optical-roll-finite', ' || !Number.isFinite(roll)', ''],
  ['restore-error-phase', "      if (phase === 'error') throw new Error('iss aim restore is in error');\n", ''],
  ['restore-running-phase', "      if (phase !== 'running') return null;\n", ''],
  ['restore-pending-readout', "      if (state === 'pending' || state === '') return null;\n", ''],
  ['restore-live-readout', "      if (state !== 'live') throw new Error('iss aim restore fov state ' + state);\n", ''],
  ['restore-finite-center', "      if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {\n        throw new Error('iss aim restore center is NaN');\n      }\n", ''],
  ['restore-finite-field', "      if (!Number.isFinite(fov)) throw new Error('iss aim restore field is NaN');\n", ''],
  ['restore-invalid-label-diagnostic', "if (!Number.isFinite(shown)) throw new Error('iss aim restore label is NaN');", 'if (!Number.isFinite(shown)) return null;'],
];

const dir = mkdtempSync(join(tmpdir(), 'opd-backlog-278-restore-mutants-'));
function run(name, body, expectedStatus) {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, body);
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], {
    env: { ...process.env, OPD_VERIFY_RESTORE_SOURCE: path }, encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `${name}: process launch failed`);
  const tests = Number(result.stdout.match(/^# tests (\d+)$/m)?.[1]);
  const pass = Number(result.stdout.match(/^# pass (\d+)$/m)?.[1]);
  const fail = Number(result.stdout.match(/^# fail (\d+)$/m)?.[1]);
  assert.ok(tests > 0 && pass + fail === tests, `${name}: test runner did not complete`);
  assert.equal(result.status, expectedStatus, `${name}: unexpected test exit (${pass} passed, ${fail} failed)`);
  if (expectedStatus === 1) assert.ok(fail > 0 && pass > 0, `${name}: mutation must fail assertions, not test loading`);
  console.log(`${name}: tests=${tests} pass=${pass} fail=${fail} exit=${result.status}`);
}

try {
  run('fixed', source, 0);
  for (const [name, before, after] of mutations) {
    assert.equal(source.split(before).length - 1, 1, `${name}: mutation must match exactly once`);
    run(name, source.replace(before, after), 1);
  }
  console.log(`All ${mutations.length} restore-check mutants rejected.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
