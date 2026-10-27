import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '../../../..');

function run(args, env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => done({ code, signal, output }));
  });
}

test('stock full Map drive passes while RealEarth requests remain pending', { timeout: 900_000 }, async (t) => {
  const home = process.env.OPD_VERIFY_HANG_HOME || await mkdtemp(resolve(tmpdir(), 'opd-realearth-hang-'));
  const evidencePath = resolve(home, 'hanging-requests.json');
  const env = {
    ...process.env,
    OPD_VERIFY_HOME: home,
    OPD_VERIFY_PORT: process.env.OPD_VERIFY_HANG_PORT || '42841',
    OPD_VERIFY_SURFACE: 'iphone-17-pro',
    OPD_VERIFY_VIEWPORT: '402x874',
    OPD_VERIFY_HANG_EVIDENCE: evidencePath,
  };
  delete env.OPD_VERIFY_FIXED_SURFACE;
  const cli = resolve(scripts, 'opd-verify.mjs');
  const started = await run([cli, 'up'], env);
  assert.equal(started.code, 0, started.output);
  try {
    const result = await run(['--import', resolve(scripts, 'hanging-realearth-preload.mjs'), cli, 'drive', 'map'], env);
    await writeFile(resolve(home, 'drive.log'), result.output);
    const requests = JSON.parse(await readFile(evidencePath, 'utf8'));
    t.diagnostic(JSON.stringify({ home, ...requests, requests: requests.requests.length }));
    assert.ok(requests.intercepted > 0 && requests.peakPending > 0, 'RealEarth requests must be intercepted and held');
    assert.ok(requests.pendingAtClose.some((count) => count > 0), 'requests must still be pending before context teardown');
    assert.equal(result.signal, null, 'the drive must exit itself');
    assert.equal(result.code, 0, `stock drive must pass with hanging RealEarth tiles\n${result.output}`);
  } finally {
    const stopped = await run([cli, 'down'], env);
    assert.equal(stopped.code, 0, stopped.output);
  }
});
