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
  ['restore-error-phase', "      const phase = document.querySelector('[data-iss-scene]')?.getAttribute('data-iss-phase') || '';\n      if (phase === 'error') throw new Error('iss aim restore is in error');\n", "      const phase = document.querySelector('[data-iss-scene]')?.getAttribute('data-iss-phase') || '';\n"],
  ['restore-running-phase', "      const phase = document.querySelector('[data-iss-scene]')?.getAttribute('data-iss-phase') || '';\n      if (phase === 'error') throw new Error('iss aim restore is in error');\n      if (phase !== 'running') return null;\n", "      const phase = document.querySelector('[data-iss-scene]')?.getAttribute('data-iss-phase') || '';\n      if (phase === 'error') throw new Error('iss aim restore is in error');\n"],
  ['restore-pending-readout', "      const state = label?.getAttribute('data-iss-fov-state') || '';\n      if (state === 'pending' || state === '') return null;\n", "      const state = label?.getAttribute('data-iss-fov-state') || '';\n"],
  ['restore-live-readout', "      const state = label?.getAttribute('data-iss-fov-state') || '';\n      if (state === 'pending' || state === '') return null;\n      if (state !== 'live') throw new Error('iss aim restore fov state ' + state);\n", "      const state = label?.getAttribute('data-iss-fov-state') || '';\n      if (state === 'pending' || state === '') return null;\n"],
  ['restore-finite-center', "      if (state !== 'live') throw new Error('iss aim restore fov state ' + state);\n      const center = map.getCenter();\n      if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {\n        throw new Error('iss aim restore center is NaN');\n      }\n", "      if (state !== 'live') throw new Error('iss aim restore fov state ' + state);\n      const center = map.getCenter();\n"],
  ['restore-finite-field', "      const fov = map.getVerticalFieldOfView();\n      const roll = ((map.getRoll() % 360) + 360) % 360;\n      if (!Number.isFinite(fov)) throw new Error('iss aim restore field is NaN');\n", "      const fov = map.getVerticalFieldOfView();\n      const roll = ((map.getRoll() % 360) + 360) % 360;\n"],
  ['restore-invalid-label-diagnostic', "if (!Number.isFinite(shown)) throw new Error('iss aim restore label is NaN');\n      if (Math.abs(shown - ${aim.opticalFovDeg}) > 0.2) return null;", "if (!Number.isFinite(shown)) return null;\n      if (Math.abs(shown - ${aim.opticalFovDeg}) > 0.2) return null;"],
  ['reload-phase', "      const phase = scene?.getAttribute('data-iss-phase') || '';\n      if (phase === 'error') throw new Error('iss aim restore is in error');\n      if (phase !== 'running') return null;\n", "      const phase = scene?.getAttribute('data-iss-phase') || '';\n"],
  ['reload-readout', "      const state = label.getAttribute('data-iss-fov-state') || '';\n      if (state === 'pending' || state === '') return null;\n      if (state !== 'live') throw new Error('iss aim restore fov state ' + state);\n", "      const state = label.getAttribute('data-iss-fov-state') || '';\n"],
  ['reload-center', "      if (!map?.getVerticalFieldOfView || !map.getCenter || !map.getRoll) return null;\n      const center = map.getCenter();\n      if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {\n        throw new Error('iss aim restore center is NaN');\n      }\n", "      if (!map?.getVerticalFieldOfView || !map.getCenter || !map.getRoll) return null;\n"],
  ['reload-finite-field', "      if (typeof fov !== 'number') return null;\n      if (!Number.isFinite(fov)) throw new Error('iss aim restore field is NaN');\n      if (Math.abs(fov - ${narrowed.fov}) > 0.5) return null;\n", "      if (typeof fov !== 'number') return null;\n      if (Math.abs(fov - ${narrowed.fov}) > 0.5) return null;\n"],
  ['reload-roll', "      const roll = ((map.getRoll() % 360) + 360) % 360;\n      if (!Number.isFinite(roll)) throw new Error('iss aim restore roll is NaN');\n      if (Math.abs(roll - 180) > 0.5) return null;\n      const text = (label.textContent || '').trim();\n", "      const text = (label.textContent || '').trim();\n"],
  ['reload-label', "      if (!Number.isFinite(shown)) throw new Error('iss aim restore label is NaN');\n      if (Math.abs(shown - fov) > 0.2) return null;\n", "      if (Math.abs(shown - fov) > 0.2) return null;\n"],
  ['restore-current-roll', "      if (!Number.isFinite(roll)) throw new Error('iss aim restore roll is NaN');\n      if (Math.abs(fov - ${aim.opticalFovDeg}) > 0.5) return null;\n      if (Math.abs(roll - 180) > 0.5) return null;\n", "      if (Math.abs(fov - ${aim.opticalFovDeg}) > 0.5) return null;\n"],
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
