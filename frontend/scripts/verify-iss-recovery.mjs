#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tests = ['test/iss-view-aim-session.test.ts', 'test/iss-view-recovery.test.ts', 'test/iss-view-lifecycle.test.ts', 'test/iss-inset-labels.test.ts'];
const mutations = [
  {
    "name": "fu174-no-retirement",
    "file": "src/iss-view/index.ts",
    "before": "          generation += 1;\n          contextLost = true;\n          rendererReady = false;\n          dropRenderer(renderer);\n          fail('WebGL context lost');",
    "after": "          fail('WebGL context lost');"
  },
  {
    "name": "fu174-lost-wheel-mutates",
    "file": "src/iss-view/index.ts",
    "before": "    if (contextLost) return;\n",
    "after": ""
  },
  {
    "name": "r2-retry-keeps-old-live-fov",
    "file": "src/iss-view/index.ts",
    "before": "  async function boot(token: number): Promise<void> {\n    appliedFovDeg = null;\n    paintFov();",
    "after": "  async function boot(token: number): Promise<void> {"
  },
  {
    "name": "r2-stale-camera-generation",
    "file": "src/iss-view/index.ts",
    "before": "        onCamera(applied, epoch, rollDeg) {\n          if (token !== generation) return;\n          confirmAppliedFov(applied, epoch, rollDeg);\n        },",
    "after": "        onCamera(applied, epoch, rollDeg) {\n          confirmAppliedFov(applied, epoch, rollDeg);\n        },"
  },
  {
    "name": "r2-nonfinite-fov-accepted",
    "file": "src/iss-view/index.ts",
    "before": "    if (token !== fovEpoch || phase !== 'running' || !Number.isFinite(applied)) return;",
    "after": "    if (token !== fovEpoch || phase !== 'running') return;"
  },
  {
    "name": "r2-unapplied-roll-accepted",
    "file": "src/iss-view/index.ts",
    "before": "    if (!Number.isFinite(wrapped) || Math.abs(wrapped - EARTH_VIEW_ROLL_DEG) > 0.5) return;\n",
    "after": ""
  },
  {
    "name": "r2-no-timer-after-retry",
    "file": "src/iss-view/index.ts",
    "before": "    if (next === 'running' && options.drive !== 'manual') startTimer();",
    "after": "    if (next === 'running' && generation === 1 && options.drive !== 'manual') startTimer();"
  },
  {
    "name": "r2-suspended-boot-stays-loading",
    "file": "src/iss-view/index.ts",
    "before": "      const next = held === 'loading' && rendererReady && snapshot ? 'running'\n        : held === 'error' || held === 'loading' || held === 'running' ? held : 'running';",
    "after": "      const next = held === 'error' || held === 'loading' || held === 'running' ? held : 'running';"
  },
  {
    "name": "retained-renderer-hooks-expire",
    "file": "src/iss-view/index.ts",
    "before": "    const ownsRenderer = (): boolean => created === null ? token === generation : renderer === created;",
    "after": "    const ownsRenderer = (): boolean => token === generation;"
  },
  {
    "name": "retired-renderer-destroyed-twice",
    "file": "src/iss-view/index.ts",
    "before": "    if (!created || retiredRenderers.has(created)) return;",
    "after": "    if (!created) return;"
  },
  {
    "name": "stale-ready-destroys-new-renderer",
    "file": "src/iss-view/index.ts",
    "before": "    if (token !== generation) {\n      dropRenderer(created);\n      return;\n    }\n    rendererReady = true;",
    "after": "    if (token !== generation) {\n      dropRenderer(renderer);\n      return;\n    }\n    rendererReady = true;"
  },
  {
    "name": "adapter-confirms-unapplied-roll",
    "file": "src/map/adapters/maplibre/iss-view.ts",
    "before": "  if (!Number.isFinite(applied) || !Number.isFinite(wrapped) || Math.abs(wrapped - EARTH_VIEW_ROLL_DEG) > 0.5) return false;\n",
    "after": ""
  },
  {
    "name": "adapter-drops-delayed-camera",
    "file": "src/map/adapters/maplibre/iss-view.ts",
    "before": "      if (!sawCamera) publishAppliedCamera(map, aim);\n",
    "after": ""
  },
  {
    "name": "cupola-lost-fov-bypasses-gate",
    "file": "src/iss-view/index.ts",
    "before": "    if (windowId !== null && !contextLost) opticalFovDeg = lensFovDeg;\n",
    "after": "    if (windowId !== null) opticalFovDeg = lensFovDeg;\n"
  },
  {
    "name": "persisted-finite-guard",
    "file": "src/iss-view/index.ts",
    "before": "  if (typeof aim.azimuthDeg !== 'number' || !Number.isFinite(aim.azimuthDeg)) return null;\n  const windowId = storedWindowId(aim.windowId);\n  if (windowId === undefined) return null;\n  if (!aim.look || typeof aim.look !== 'object') return null;\n  const look = aim.look as { rightDeg?: unknown; upDeg?: unknown };\n  if (typeof look.rightDeg !== 'number' || typeof look.upDeg !== 'number') return null;\n  if (!Number.isFinite(look.rightDeg) || !Number.isFinite(look.upDeg)) return null;\n  if (typeof aim.opticalFovDeg !== 'number' || !Number.isFinite(aim.opticalFovDeg)) return null;\n",
    "after": "  if (typeof aim.azimuthDeg !== 'number') return null;\n  const windowId = storedWindowId(aim.windowId);\n  if (windowId === undefined) return null;\n  if (!aim.look || typeof aim.look !== 'object') return null;\n  const look = aim.look as { rightDeg?: unknown; upDeg?: unknown };\n  if (typeof look.rightDeg !== 'number' || typeof look.upDeg !== 'number') return null;\n  if (typeof aim.opticalFovDeg !== 'number') return null;\n"
  }
];
const originals = new Map(mutations.map(({ file }) => [file, readFileSync(resolve(root, file), 'utf8')]));
const restore = () => {
  for (const [file, content] of originals) writeFileSync(resolve(root, file), content);
};
const run = () => spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...tests], {
  cwd: root,
  encoding: 'utf8',
});
process.once('SIGINT', () => { restore(); process.exit(130); });
process.once('SIGTERM', () => { restore(); process.exit(143); });
const baseline = run();
if (baseline.status !== 0) {
  process.stderr.write(baseline.stdout + baseline.stderr);
  throw new Error('ISS pins must pass before mutation');
}
const baselineCounts = baseline.stdout.match(/^\s*Tests\s+(.+)$/m)?.[1] ?? 'passed';
console.log(`Baseline: ${baselineCounts}.`);
let killed = 0;
try {
  for (const { name, file, before, after } of mutations) {
    const original = originals.get(file);
    if (original.split(before).length !== 2) throw new Error(`${name}: mutation anchor must occur exactly once`);
    try {
      writeFileSync(resolve(root, file), original.replace(before, after));
      const result = run();
      const output = result.stdout + result.stderr;
      const counts = output.match(/^\s*Tests\s+(.+)$/m)?.[1];
      if (result.status !== 1 || !counts?.includes('failed')) {
        process.stderr.write(output);
        throw new Error(`${name}: expected assertion failures, got exit ${result.status}`);
      }
      killed += 1;
      console.log(`${name}: RED (exit 1; ${counts})`);
    } finally {
      restore();
    }
  }
} finally {
  restore();
}
console.log(`${killed}/${mutations.length} mutants killed; source restored.`);
