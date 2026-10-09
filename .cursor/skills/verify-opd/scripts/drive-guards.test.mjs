import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { freshProfile } from './drive.mjs';
import { createDeviceContext } from './fixture-session.mjs';
import { publishDriveFixtures } from './fixtures.mjs';
import { deviceDescriptor, launchWebkit, WEBKIT_DEVICES } from './webkit-devices.mjs';

const script = join(import.meta.dirname, 'opd-verify.mjs');
const HOME_REEF = 'HOME-REEF-MARKER';
const SENTINEL = '2099-01-01T00:00:00.000Z';
const EXPIRED = '2000-01-01T00:00:00.000Z';

function writeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const pass = [{ target_id: 'verify-reef', target_name: 'Verify Reef', closest_approach: HOME_REEF }];
  writeFileSync(join(dir, 'passes.json'), '[]');
  writeFileSync(join(dir, 'top5.json'), JSON.stringify(pass));
  writeFileSync(join(dir, 'top_24h.json'), '[]');
  writeFileSync(join(dir, 'cupola_windows.json'), JSON.stringify({ windows: [] }));
  writeFileSync(join(dir, 'launch.json'), JSON.stringify({ items: [], generated_at: SENTINEL, valid_until: SENTINEL }));
  writeFileSync(join(dir, 'launch-latest.json'), JSON.stringify({ valid_until: SENTINEL }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    version: 'verify-test',
    generated_at: SENTINEL,
    artifacts: { passes: {}, top5: {}, top_24h: {}, cupola_windows: {} },
  }));
  writeFileSync(join(dir, 'meta.json'), '{}');
}

function canBind(port) {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once('error', () => resolveBind(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolveBind(true)));
  });
}

async function reservePort() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    if (port % 2 === 1) continue;
    if (await canBind(port) && await canBind(port + 1)) return port;
  }
  throw new Error('no free port pair');
}

function killPid(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* not a process group */ }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

async function startHarness(launchValidUntil = SENTINEL) {
  const home = join(tmpdir(), `opd-guards-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
  mkdirSync(home, { recursive: true });
  const port = await reservePort();
  writeFixtures(join(home, 'fixtures'));
  mkdirSync(join(home, 'evidence'), { recursive: true });
  const viteLog = openSync(join(home, 'vite-stub.log'), 'a');
  const vite = spawn(process.execPath, ['-e', `
    const { createServer } = require('node:http');
    const port = Number(process.env.PORT);
    const page = '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>SNAP</title><div id="status-banner">Ready</div>SNAP';
    createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      let body = page;
      let type = 'text/html; charset=utf-8';
      if (path === '/src/main.ts') { body = 'export const snapMain = true;\\n'; type = 'text/javascript; charset=utf-8'; }
      if (path === '/sw.js') { body = '/* snap sw */\\n'; type = 'text/javascript; charset=utf-8'; }
      res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
      res.end(body);
    }).listen(port, '127.0.0.1');
  `], {
    env: { ...process.env, PORT: String(port + 1) },
    detached: true,
    stdio: ['ignore', viteLog, viteLog],
  });
  vite.unref();
  const state = {
    home,
    port,
    vitePort: port + 1,
    url: `http://127.0.0.1:${port}`,
    evidence: join(home, 'evidence'),
    proxyPid: 0,
    vitePid: vite.pid,
    manifestVersion: 'verify-test',
    launchValidUntil,
    tleSource: 'test',
  };
  writeFileSync(join(home, 'state.json'), JSON.stringify(state));
  const proxyLog = openSync(join(home, 'proxy.log'), 'a');
  const proxy = spawn(process.execPath, [script, 'serve'], {
    env: { ...process.env, OPD_VERIFY_HOME: home },
    detached: true,
    stdio: ['ignore', proxyLog, proxyLog],
  });
  proxy.unref();
  const proxyExit = { code: null, signal: null };
  proxy.on('exit', (code, signal) => {
    proxyExit.code = code;
    proxyExit.signal = signal;
  });
  state.proxyPid = proxy.pid;
  writeFileSync(join(home, 'state.json'), JSON.stringify(state));
  const url = state.url;
  const ready = Date.now();
  let last = 'no response';
  while (Date.now() - ready < 10000) {
    try {
      const response = await fetch(`${url}/manifest.json`);
      if (response.ok) break;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  const manifest = await fetch(`${url}/manifest.json`);
  if (!manifest.ok) {
    const log = existsSync(join(home, 'proxy.log')) ? readFileSync(join(home, 'proxy.log'), 'utf8') : '';
    throw new Error(`harness manifest ${last} exit ${proxyExit.code} ${proxyExit.signal} ${log}`);
  }
  return {
    home,
    url,
    port,
    proxyExit,
    async stop() {
      let latest = state;
      try { latest = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')); } catch { /* home already removed */ }
      killPid(latest.proxyPid);
      killPid(latest.vitePid);
      killPid(proxy.pid);
      killPid(vite.pid);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function driveEnv(home, extra = {}) {
  return { ...process.env, OPD_VERIFY_HOME: home, ...extra };
}

async function registrations(url) {
  let last = 'no response';
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/verify/fixtures`);
      const body = await response.json();
      assert.equal(response.status, 200);
      return body;
    } catch (error) {
      last = error instanceof Error ? `${error.message} ${error.cause || ''}` : String(error);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 40));
    }
  }
  throw new Error(last);
}

async function poll(read, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (value) return value;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 40));
  }
  return null;
}

function sliceBetween(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start, `missing slice ${startMark}`);
  return source.slice(start, end);
}

test('failing map-corner drive exits 1', { timeout: 40000 }, async () => {
  const harness = await startHarness();
  try {
    const result = spawnSync(process.execPath, [script, 'drive', 'map-corner'], {
      env: driveEnv(harness.home, { OPD_VERIFY_CHROME: '/bin/false' }),
      encoding: 'utf8',
      timeout: 30000,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /chrome debug port/);
    const state = JSON.parse(readFileSync(join(harness.home, 'state.json'), 'utf8'));
    assert.equal(state.launchValidUntil, SENTINEL);
    const listed = await registrations(harness.url);
    assert.equal(listed.count, 0, `proxy exit ${harness.proxyExit.code} ${harness.proxyExit.signal}`);
  } finally {
    await harness.stop();
  }
});

test('unknown drive exits 2', { timeout: 20000 }, async () => {
  const harness = await startHarness();
  try {
    const result = spawnSync(process.execPath, [script, 'drive', 'nonsense'], {
      env: driveEnv(harness.home),
      encoding: 'utf8',
      timeout: 15000,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.status, 2, output);
    assert.match(output, /unknown feature nonsense/);
    assert.equal((await registrations(harness.url)).count, 0);
  } finally {
    await harness.stop();
  }
});

test('SIGINT removes the private fixture copy and its registration', { timeout: 30000 }, async () => {
  const harness = await startHarness();
  const child = spawn(process.execPath, [script, 'drive', 'map'], {
    env: driveEnv(harness.home, { OPD_VERIFY_SURFACE: 'iphone-13' }),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const listed = await poll(async () => {
      const body = await registrations(harness.url);
      return body.count > 0 ? body : null;
    }, 15000);
    assert.ok(listed, `drive never registered\n${output}`);
    const entry = listed.entries[0];
    assert.equal(existsSync(entry.dir), true);
    child.kill('SIGINT');
    const status = await new Promise((resolveStatus) => child.once('exit', (code) => resolveStatus(code)));
    assert.equal(status, 130, output);
    assert.equal(existsSync(entry.dir), false);
    const after = await registrations(harness.url);
    assert.equal(after.entries.some((item) => item.token === entry.token), false);
    assert.equal(after.count, 0);
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group already gone */ }
    await harness.stop();
  }
});

test('proxy drops a registration whose copy or owner is gone', { timeout: 20000 }, async () => {
  const harness = await startHarness();
  const published = [];
  try {
    const wall = Date.parse('2026-10-07T13:00:00.000Z');
    const first = publishDriveFixtures(join(harness.home, 'fixtures'), Date.parse('2026-10-07T12:00:00.000Z'), wall);
    const second = publishDriveFixtures(join(harness.home, 'fixtures'), Date.parse('2026-10-07T12:00:00.000Z'), wall);
    published.push(first.dir, second.dir);
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(dead.status, 0);
    const missingDir = await fetch(`${harness.url}/api/verify/fixtures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'aaaaaaaaaaaaaaaa', dir: first.dir, pid: process.pid }),
    });
    assert.equal(missingDir.status, 200);
    rmSync(first.dir, { recursive: true, force: true });
    const missingResponse = await fetch(`${harness.url}/v/verify/top5.json`, {
      headers: { cookie: 'opd-verify-fixtures=aaaaaaaaaaaaaaaa' },
    });
    const missingBody = await missingResponse.text();
    assert.equal(missingResponse.status, 404);
    assert.match(missingBody, /unknown opd-verify-fixtures/);
    assert.doesNotMatch(missingBody, new RegExp(HOME_REEF));
    const deadOwner = await fetch(`${harness.url}/api/verify/fixtures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'bbbbbbbbbbbbbbbb', dir: second.dir, pid: dead.pid }),
    });
    assert.equal(deadOwner.status, 200);
    const deadResponse = await fetch(`${harness.url}/v/verify/top5.json`, {
      headers: { cookie: 'opd-verify-fixtures=bbbbbbbbbbbbbbbb' },
    });
    const deadBody = await deadResponse.text();
    assert.equal(deadResponse.status, 404);
    assert.match(deadBody, /unknown opd-verify-fixtures/);
    assert.doesNotMatch(deadBody, /2026-10-07T18:20:00Z/);
    const left = await registrations(harness.url);
    assert.equal(left.count, 0);
  } finally {
    for (const dir of published) rmSync(dir, { recursive: true, force: true });
    await harness.stop();
  }
});

test('unknown fixture cookie 404s fixture routes and still serves the app', { timeout: 20000 }, async () => {
  const harness = await startHarness();
  try {
    const cookie = { cookie: 'opd-verify-fixtures=cccccccccccccccc' };
    const top5 = await fetch(`${harness.url}/v/verify/top5.json`, { headers: cookie });
    const top5Body = await top5.text();
    assert.equal(top5.status, 404);
    assert.match(top5Body, /unknown opd-verify-fixtures/);
    assert.doesNotMatch(top5Body, new RegExp(HOME_REEF));
    const manifest = await fetch(`${harness.url}/manifest.json`, { headers: cookie });
    assert.equal(manifest.status, 404);
    const home = await fetch(`${harness.url}/v/verify/top5.json`);
    const homeBody = await home.text();
    assert.equal(home.status, 200);
    assert.match(homeBody, new RegExp(HOME_REEF));
    const page = await fetch(`${harness.url}/`, { headers: cookie });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /SNAP/);
    const main = await fetch(`${harness.url}/src/main.ts`, { headers: cookie });
    assert.equal(main.status, 200);
    assert.match(await main.text(), /snapMain/);
    const worker = await fetch(`${harness.url}/sw.js`, { headers: cookie });
    assert.equal(worker.status, 200);
    assert.match(await worker.text(), /snap sw/);
    const session = await fetch(`${harness.url}/api/browser/session`, { headers: cookie });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).ok, true);
  } finally {
    await harness.stop();
  }
});

test('private drive leaves an expired home launch pointer', { timeout: 30000 }, async () => {
  const harness = await startHarness(EXPIRED);
  try {
    const result = spawnSync(process.execPath, [script, 'drive', 'nonsense'], {
      env: driveEnv(harness.home),
      encoding: 'utf8',
      timeout: 15000,
    });
    const state = JSON.parse(readFileSync(join(harness.home, 'state.json'), 'utf8'));
    assert.equal(state.launchValidUntil, EXPIRED, `${result.stdout}\n${result.stderr}`);
    const doctor = spawnSync(process.execPath, [script, 'doctor'], {
      env: driveEnv(harness.home),
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(doctor.status, 1, `${doctor.stdout}\n${doctor.stderr}`);
    assert.match(`${doctor.stdout}\n${doctor.stderr}`, /launch fixture expired/);
  } finally {
    await harness.stop();
  }
});

test('up rebuilds when the home launch pointer is expired', { timeout: 120000 }, async () => {
  const harness = await startHarness(EXPIRED);
  try {
    const before = JSON.parse(readFileSync(join(harness.home, 'state.json'), 'utf8'));
    const result = spawnSync(process.execPath, [script, 'up'], {
      env: driveEnv(harness.home, { OPD_VERIFY_PORT: String(harness.port) }),
      encoding: 'utf8',
      timeout: 90000,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const after = JSON.parse(readFileSync(join(harness.home, 'state.json'), 'utf8'));
    assert.notEqual(after.proxyPid, before.proxyPid);
    assert.ok(Date.parse(after.launchValidUntil) > Date.now(), after.launchValidUntil);
  } finally {
    await harness.stop();
  }
});

test('twenty finished drives leave the registration map at baseline', { timeout: 120000 }, async () => {
  const harness = await startHarness();
  try {
    const before = await registrations(harness.url);
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const result = spawnSync(process.execPath, [script, 'drive', 'nonsense'], {
        env: driveEnv(harness.home),
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(result.status, 2, `${cycle}\n${result.stdout}\n${result.stderr}`);
    }
    const after = await registrations(harness.url);
    assert.equal(after.count, before.count, `proxy exit ${harness.proxyExit.code} ${harness.proxyExit.signal}`);
  } finally {
    await harness.stop();
  }
});

test('fresh Chrome profile sends the fixture cookie', { timeout: 60000 }, async () => {
  const harness = await startHarness();
  const published = [];
  try {
    const copy = publishDriveFixtures(join(harness.home, 'fixtures'), Date.parse('2026-10-07T12:00:00.000Z'), Date.parse('2026-10-07T13:00:00.000Z'));
    published.push(copy.dir);
    const registered = await fetch(`${harness.url}/api/verify/fixtures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'dddddddddddddddd', dir: copy.dir, pid: process.pid }),
    });
    assert.equal(registered.status, 200);
    let seen = null;
    await freshProfile(harness.url, harness.home, 'dddddddddddddddd', async (send) => {
      const evaluated = await send('Runtime.evaluate', {
        expression: `fetch('/v/verify/top5.json').then(async (response) => ({ status: response.status, text: await response.text() }))`,
        awaitPromise: true,
        returnByValue: true,
      });
      seen = evaluated.result.value;
    });
    assert.equal(seen.status, 200);
    assert.match(seen.text, /2026-10-07T18:20:00Z/);
    assert.doesNotMatch(seen.text, new RegExp(HOME_REEF));
  } finally {
    for (const dir of published) rmSync(dir, { recursive: true, force: true });
    await harness.stop();
  }
});

test('webkit device context sends the fixture cookie', { timeout: 60000 }, async () => {
  const harness = await startHarness();
  const published = [];
  let browser = null;
  try {
    const copy = publishDriveFixtures(join(harness.home, 'fixtures'), Date.parse('2026-10-07T12:00:00.000Z'), Date.parse('2026-10-07T13:00:00.000Z'));
    published.push(copy.dir);
    const registered = await fetch(`${harness.url}/api/verify/fixtures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'eeeeeeeeeeeeeeee', dir: copy.dir, pid: process.pid }),
    });
    assert.equal(registered.status, 200);
    const spec = WEBKIT_DEVICES.find((entry) => entry.slug === 'iphone-13');
    browser = await launchWebkit();
    const context = await createDeviceContext(browser, deviceDescriptor(spec), {
      baseUrl: harness.url,
      token: 'eeeeeeeeeeeeeeee',
    });
    const page = await context.newPage();
    await page.goto(`${harness.url}/?e2e`, { waitUntil: 'domcontentloaded' });
    const seen = await page.evaluate(async () => {
      const response = await fetch('/v/verify/top5.json');
      return { status: response.status, text: await response.text() };
    });
    assert.equal(seen.status, 200);
    assert.match(seen.text, /2026-10-07T18:20:00Z/);
    assert.doesNotMatch(seen.text, new RegExp(HOME_REEF));
    const box = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }));
    assert.deepEqual(box, { width: 390, height: 664 });
  } finally {
    if (browser) await browser.close();
    for (const dir of published) rmSync(dir, { recursive: true, force: true });
    await harness.stop();
  }
});

test('chrome and webkit contexts open through the fixture cookie helper', () => {
  const drive = readFileSync(join(import.meta.dirname, 'drive.mjs'), 'utf8');
  const webkit = readFileSync(join(import.meta.dirname, 'webkit-devices.mjs'), 'utf8');
  assert.equal(drive.includes('.newContext('), false);
  assert.equal(webkit.includes('.newContext('), false);
  const fresh = sliceBetween(drive, 'export async function freshProfile', 'async function expectFreshHide');
  assert.match(fresh, /pinFixtureCookie\(cdp\.send, baseUrl, fixtureToken\)/);
  const guest = sliceBetween(drive, 'async function expectFreshHide', 'async function hideNamed');
  assert.match(guest, /freshProfile\(baseUrl, home, fixtureToken,/);
  const chrome = sliceBetween(drive, 'async function driveChrome', 'async function driveWebkitSurfaces');
  assert.match(chrome, /pinFixtureCookie\(cdp\.send, baseUrl, fixtureToken\)/);
  const devices = sliceBetween(drive, 'async function driveWebkitSurfaces', 'export async function driveFeatures');
  assert.match(devices, /createDeviceContext\(browser, deviceDescriptor\(active\), \{ baseUrl, token: fixtureToken \}\)/);
  const corner = sliceBetween(drive, 'export async function driveMapCorner', 'async function dismissShotlist');
  assert.match(corner, /pinFixtureCookie\(send, baseUrl, fixtureToken\)/);
  const denied = sliceBetween(webkit, 'export async function proveDeniedFooter', 'finally {');
  assert.match(denied, /createDeviceContext\(browser, device, \{[\s\S]*token: fixtureToken/);
});
