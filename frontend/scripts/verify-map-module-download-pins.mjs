#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'opd-module-download-pins-'));
mkdirSync(join(scratch, 'src'));
mkdirSync(join(scratch, 'test'));
symlinkSync(realpathSync(join(frontend, 'node_modules')), join(scratch, 'node_modules'), 'dir');
writeFileSync(join(scratch, 'package.json'), '{"type":"module"}\n');
writeFileSync(join(scratch, 'vite.config.mjs'), 'export default { cacheDir: ".vite-cache", test: { environment: "node" } };\n');
copyFileSync(join(frontend, 'test/map-module-download.test.ts'), join(scratch, 'test/map-module-download.test.ts'));
const source = readFileSync(join(frontend, 'src/map-import.ts'), 'utf8');
const sourceFile = join(scratch, 'src/map-import.ts');
const run = (name) => {
  const result = spawnSync(process.execPath, [
    join(frontend, 'node_modules/vitest/vitest.mjs'), 'run', 'test/map-module-download.test.ts',
    '--maxWorkers=2', '--minWorkers=1', '--testTimeout=60000', '--hookTimeout=60000',
  ], { cwd: scratch, encoding: 'utf8' });
  writeFileSync(join(scratch, `${name}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.ifError(result.error);
  return result;
};

writeFileSync(sourceFile, source);
assert.equal(run('baseline').status, 0, `Baseline must be green: ${scratch}/baseline.log`);
const start = source.indexOf('export async function readModuleSource(');
const end = source.indexOf('\nconst freshModuleLoads', start);
assert.ok(start >= 0 && end > start, 'Stale readModuleSource mutation anchor');
const mutant = `export async function readModuleSource(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAP_CHUNK_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new TypeError(\`Failed to fetch dynamically imported module: \${url}\`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
`;
writeFileSync(sourceFile, source.slice(0, start) + mutant + source.slice(end));
const result = run('whole-body-2s-mutant');
assert.notEqual(result.status, 0, 'UNPINNED: whole-body 2s deadline survived');
assert.match(result.stdout, /accepts a 200 dependency whose final bytes arrive after the diagnostic 2s budget/,
  'Mutant must fail the slow-tail pin, not merely fail to start');
console.log(`PASS baseline green; whole-body 2s mutant red. Evidence: ${scratch}`);
