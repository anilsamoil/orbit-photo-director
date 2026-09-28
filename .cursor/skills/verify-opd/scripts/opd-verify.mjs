#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BROWSER_FEATURES, driveFeatures } from './drive.mjs';
import { buildFixtures, refreshLaunchClock } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const frontendDir = resolve(repoRoot, 'frontend');
const featureDir = resolve(here, '../features');
const FEATURE_FILES = ['banner', 'topbar', 'queue', 'upcoming', 'map', 'help', 'profile', 'log', 'phone', 'tracked', 'service-worker'];

function homeDir() {
  return process.env.OPD_VERIFY_HOME || '/tmp/opd-verify/default';
}

function statePath(home = homeDir()) {
  return resolve(home, 'state.json');
}

function readState(home = homeDir()) {
  const file = statePath(home);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeState(state) {
  mkdirSync(state.home, { recursive: true });
  writeFileSync(statePath(state.home), JSON.stringify(state, null, 2));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
  }
  }
}

function bunBin() {
  if (process.env.OPD_VERIFY_BUN && existsSync(process.env.OPD_VERIFY_BUN)) return process.env.OPD_VERIFY_BUN;
  const homeBun = resolve(process.env.HOME || '', '.bun/bin/bun');
  if (existsSync(homeBun)) return homeBun;
  return 'bun';
}

function spawnDetached(command, args, cwd, logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  const log = openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  return child.pid;
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  let last = 'no response';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
  }
  throw new Error(`${url} not ready: ${last}`);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

function proxyRequest(state, req, res) {
  return new Promise((resolveProxy) => {
    const outbound = httpRequest({
      hostname: '127.0.0.1',
      port: state.vitePort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${state.vitePort}` },
    }, (incoming) => {
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(res);
      resolveProxy();
    });
    outbound.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('vite unavailable');
      }
      resolveProxy();
    });
    req.pipe(outbound);
  });
}

function startProxy(home) {
  const state = readState(home);
  const fixtureDir = resolve(home, 'fixtures');
  const meta = JSON.parse(readFileSync(resolve(fixtureDir, 'meta.json'), 'utf8'));
  const logEntries = [];
  const personalTargets = [];
  let removedCuratedIds = null;
  let removedCuratedUpdatedAt = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${state.port}`);
    const path = url.pathname;
    const sendFile = (name) => {
      const file = resolve(fixtureDir, name);
      if (!existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('missing');
        return;
      }
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    if (path === '/manifest.json') return sendFile('manifest.json');
    const artifact = {
      '/v/verify/passes.json': 'passes.json',
      '/v/verify/top5.json': 'top5.json',
      '/v/verify/top_24h.json': 'top_24h.json',
      '/v/verify/track.json': 'track.json',
      '/v/verify/status.json': 'status.json',
      '/v/verify/targets.json': 'targets.json',
      '/v/verify/cupola_windows.json': 'cupola_windows.json',
      '/v/verify/tracked.json': 'tracked.json',
    }[path];
    if (artifact) return sendFile(artifact);
    if (path === '/launch/latest.json') return sendFile('launch-latest.json');
    if (path === '/launch/v/verifyrev.json') return sendFile('launch.json');
    if (path === '/api/browser/session') {
      const denied = (req.headers.cookie ?? '').split(';').some((part) => part.trim() === 'opd-verify-session=deny');
      if (denied) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      json(res, 200, { ok: true, profile: { name: 'anil', displayName: 'Anil' } });
      return;
    }
    if (path === '/api/kp') {
      json(res, 200, { kp: 3, timestamp: new Date(meta.now).toISOString(), age_min: 5 });
      return;
    }
    if (path === '/api/log' && req.method === 'GET') {
      json(res, 200, { entries: logEntries });
      return;
    }
    if (path === '/api/log' && req.method === 'POST') {
      const payload = JSON.parse(await readBody(req) || '{}');
      if (payload.action !== 'shoot' && payload.action !== 'skip' && payload.action !== 'rate') {
        json(res, 400, { ok: false, error: 'invalid_action' });
        return;
      }
      const entry = {
        target_id: payload.target_id,
        pass_time: payload.pass_time,
        action: payload.action,
        score_at_time: payload.score_at_time,
        rating: payload.rating,
        received_at: new Date().toISOString(),
      };
      if (typeof payload.target_name === 'string' && payload.target_name.length > 0 && payload.target_name.length <= 200) {
        entry.target_name = payload.target_name;
      }
      logEntries.push(entry);
      json(res, 200, { ok: true });
      return;
    }
    const targetRoute = path.match(/^\/api\/browser\/profiles\/([^/]+)\/targets(?:\/([^/]+))?$/);
    if (targetRoute && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        targets: personalTargets,
        removedCuratedIds,
        removedCuratedUpdatedAt,
      });
      return;
    }
    if (targetRoute && req.method === 'POST') {
      personalTargets.push(JSON.parse(await readBody(req) || '{}'));
      json(res, 200, { ok: true, count: personalTargets.length });
      return;
    }
    if (targetRoute && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req) || '{}');
      const hasTargets = Array.isArray(body.targets);
      const hasRemoved = Array.isArray(body.removedCuratedIds);
      if (!hasTargets && !hasRemoved) {
        json(res, 400, { error: 'targets_must_be_array' });
        return;
      }
      if (hasTargets) personalTargets.splice(0, personalTargets.length, ...body.targets);
      if (hasRemoved) {
        removedCuratedIds = body.removedCuratedIds.filter((id) => typeof id === 'string');
        removedCuratedUpdatedAt = typeof body.removedCuratedUpdatedAt === 'string'
          ? body.removedCuratedUpdatedAt
          : new Date().toISOString();
      }
      json(res, 200, { ok: true, count: hasRemoved && !hasTargets ? removedCuratedIds.length : personalTargets.length });
      return;
    }
    if (targetRoute && req.method === 'DELETE') {
      const id = decodeURIComponent(targetRoute[2] || '');
      const index = personalTargets.findIndex((target) => target.id === id);
      if (index >= 0) personalTargets.splice(index, 1);
      json(res, 200, { ok: true });
      return;
    }
    await proxyRequest(state, req, res);
  });
  server.listen(state.port, '127.0.0.1');
  console.log(`proxy listening ${state.port}`);
}

function listenerPids(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return (result.stdout || '').trim().split(/\s+/).filter(Boolean).map((value) => Number(value));
}

function ownedBy(rootPid, pid) {
  let current = pid;
  for (let hop = 0; hop < 6 && current; hop += 1) {
    if (current === rootPid) return true;
    const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(current)], { encoding: 'utf8' });
    const parent = Number((result.stdout || '').trim());
    if (!parent || parent === current) return false;
    current = parent;
  }
  return false;
}

async function doctor(home = homeDir()) {
  const state = readState(home);
  const problems = [];
  if (!state) problems.push('no state file');
  else {
    if (!alive(state.proxyPid)) problems.push(`proxy pid ${state.proxyPid} is not running`);
    if (!alive(state.vitePid)) problems.push(`vite pid ${state.vitePid} is not running`);
    const proxyListeners = listenerPids(state.port);
    const viteListeners = listenerPids(state.vitePort);
    if (!proxyListeners.some((pid) => ownedBy(state.proxyPid, pid))) problems.push(`port ${state.port} is not owned by proxy pid ${state.proxyPid}`);
    if (!viteListeners.some((pid) => ownedBy(state.vitePid, pid))) problems.push(`port ${state.vitePort} is not owned by vite pid ${state.vitePid}`);
    if (problems.length === 0) {
      try {
        const page = await fetch(`http://127.0.0.1:${state.port}/`);
        const html = await page.text();
        if (!page.ok || !html.includes('SNAP')) problems.push('index html is not SNAP');
        const manifestResponse = await fetch(`http://127.0.0.1:${state.port}/manifest.json`);
        const manifest = await manifestResponse.json();
        if (!manifest.version || !manifest.generated_at) problems.push('manifest missing version');
        if (Date.parse(state.launchValidUntil) <= Date.now()) problems.push('launch fixture expired. Run down, then up.');
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (problems.length) throw new Error(problems.join('\n'));
  console.log(`ok ${state.url}`);
  console.log(`proxy ${state.proxyPid} vite ${state.vitePid}`);
  console.log(`manifest ${state.manifestVersion}`);
  console.log(`launch valid until ${state.launchValidUntil}`);
  console.log(`evidence ${state.evidence}`);
}

async function up() {
  const home = homeDir();
  const existing = readState(home);
  if (existing && alive(existing.proxyPid) && alive(existing.vitePid)) {
    try {
      await doctor(home);
      return;
    } catch {
    }
  }
  if (existing) {
    killGroup(existing.proxyPid);
    killGroup(existing.vitePid);
  }
  mkdirSync(home, { recursive: true });
  mkdirSync(resolve(home, 'evidence'), { recursive: true });
  const port = Number(process.env.OPD_VERIFY_PORT || 41731);
  const vitePort = port + 1;
  const portOwners = listenerPids(port).concat(listenerPids(vitePort));
  if (portOwners.length) {
    console.error(`ports ${port} and ${vitePort} must be free. Listening pids: ${portOwners.join(', ')}`);
    process.exit(1);
  }
  const built = await buildFixtures(resolve(home, 'fixtures'));
  const schemaCheck = spawnSync(bunBin(), ['-e', `
    import { readFileSync } from 'node:fs';
    import { parseLaunchArtifact, parseLaunchPointer } from ${JSON.stringify(resolve(frontendDir, 'src/launch-schema.ts'))};
    const dir = ${JSON.stringify(resolve(home, 'fixtures'))};
    parseLaunchPointer(JSON.parse(readFileSync(dir + '/launch-latest.json', 'utf8')));
    parseLaunchArtifact(JSON.parse(readFileSync(dir + '/launch.json', 'utf8')));
  `], { cwd: frontendDir, encoding: 'utf8' });
  if (schemaCheck.status !== 0) {
    console.error(schemaCheck.stderr || schemaCheck.stdout);
    process.exit(1);
  }
  const state = {
    home,
    port,
    vitePort,
    url: `http://127.0.0.1:${port}`,
    evidence: resolve(home, 'evidence'),
    proxyPid: 0,
    vitePid: 0,
    manifestVersion: built.manifest.version,
    launchValidUntil: built.meta.launchValidUntil,
    tleSource: built.meta.tleSource,
  };
  writeState(state);
  state.proxyPid = spawnDetached(process.execPath, [fileURLToPath(import.meta.url), 'serve'], repoRoot, resolve(home, 'proxy.log'));
  state.vitePid = spawnDetached(bunBin(), ['run', 'dev', '--', '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], frontendDir, resolve(home, 'vite.log'));
  writeState(state);
  try {
    await waitForHttp(`http://127.0.0.1:${vitePort}/`);
    await waitForHttp(`http://127.0.0.1:${port}/manifest.json`);
    await doctor(home);
  } catch (error) {
    killGroup(state.proxyPid);
    killGroup(state.vitePid);
    console.error(readFileSync(resolve(home, 'vite.log'), 'utf8').slice(-2000));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function down() {
  const home = homeDir();
  const state = readState(home);
  const chromePidFile = resolve(home, 'chrome.pid');
  if (existsSync(chromePidFile)) {
    const chromePid = Number(readFileSync(chromePidFile, 'utf8'));
    if (alive(chromePid)) killGroup(chromePid);
  }
  if (state) {
    killGroup(state.proxyPid);
    killGroup(state.vitePid);
    const previewPid = state.previewPid;
    if (previewPid) killGroup(previewPid);
  }
  const evidence = state?.evidence || resolve(home, 'evidence');
  rmSync(resolve(home, 'chrome-profile'), { recursive: true, force: true });
  if (existsSync(statePath(home))) rmSync(statePath(home));
  console.log(`stopped. evidence remains at ${evidence}`);
}

async function drive(feature) {
  const home = homeDir();
  const until = refreshLaunchClock(resolve(home, 'fixtures'));
  const early = readState(home);
  if (early) {
    early.launchValidUntil = until;
    writeState(early);
  }
  await doctor(home);
  const state = readState(home);
  const meta = JSON.parse(readFileSync(resolve(home, 'fixtures/meta.json'), 'utf8'));
  const features = feature === 'all' ? ['all'] : [feature];
  if (feature !== 'all' && !BROWSER_FEATURES.includes(feature)) {
    console.error(`unknown feature ${feature}. Choose ${BROWSER_FEATURES.join(', ')}, or all.`);
    process.exit(2);
  }
  const notes = await driveFeatures({
    baseUrl: state.url,
    evidenceDir: state.evidence,
    meta,
    features,
  });
  for (const note of notes) console.log(note);
  console.log(`evidence ${state.evidence}`);
}

function staticType(file) {
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.json') || file.endsWith('.map')) return 'application/json';
  if (file.endsWith('.webmanifest')) return 'application/manifest+json';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function startStatic(outDir, port) {
  const root = resolve(outDir);
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = resolve(root, relative);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': staticType(file), 'content-length': body.length });
    res.end(body);
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => resolveListen(server));
  });
}

async function sw() {
  const home = homeDir();
  mkdirSync(home, { recursive: true });
  const evidence = resolve(home, 'evidence');
  mkdirSync(evidence, { recursive: true });
  const proof = resolve(evidence, 'service-worker.txt');
  if (existsSync(proof)) rmSync(proof);
  const outDir = resolve(home, 'preview-dist');
  const previewPort = Number(process.env.OPD_VERIFY_PREVIEW_PORT || 41733);
  const build = spawnSync(bunBin(), ['run', 'build', '--', '--outDir', outDir, '--emptyOutDir'], {
    cwd: frontendDir,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status || 1);
  const server = await startStatic(outDir, previewPort);
  let status = 0;
  try {
    await waitForHttp(`http://127.0.0.1:${previewPort}/sw.js`, 60000);
    status = await new Promise((resolveStatus) => {
      const child = spawn(resolve(repoRoot, 'scripts/verify-sw-upgrade.sh'), [`http://127.0.0.1:${previewPort}`], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
      child.on('error', () => resolveStatus(1));
      child.on('exit', (code) => resolveStatus(code ?? 1));
    });
    if (status === 0) {
      writeFileSync(proof, `verify-sw-upgrade.sh passed against http://127.0.0.1:${previewPort}\n${new Date().toISOString()}\n`);
      console.log(`service worker checks passed. log ${proof}`);
    }
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  }
  if (status !== 0) process.exit(status);
}

function checkMap() {
  const readme = readFileSync(resolve(featureDir, 'README.md'), 'utf8');
  const skill = readFileSync(resolve(here, '../SKILL.md'), 'utf8');
  const problems = [];
  for (const id of FEATURE_FILES) {
    const file = resolve(featureDir, `${id}.md`);
    if (!existsSync(file)) problems.push(`missing features/${id}.md`);
    if (!readme.includes(`./${id}.md`)) problems.push(`README missing ./${id}.md`);
    const body = existsSync(file) ? readFileSync(file, 'utf8') : '';
    for (const heading of ['## Sub-features', '## How to get to it (user POV)', '## Driving it with opd-verify', '## Gotchas']) {
      if (!body.includes(heading)) problems.push(`${id}.md missing ${heading}`);
    }
    if (!body.includes('iPhone') || !body.includes('iPad')) problems.push(`${id}.md has no iPhone/iPad coverage`);
  }
  if (!skill.includes('name: verify-opd')) problems.push('SKILL.md missing name');
  if (!skill.includes('opd-verify.mjs up')) problems.push('SKILL.md missing up');
  if (!skill.includes('opd-verify.mjs doctor')) problems.push('SKILL.md missing doctor');
  if (!skill.includes('opd-verify.mjs drive all')) problems.push('SKILL.md missing drive all');
  if (!skill.includes('opd-verify.mjs sw')) problems.push('SKILL.md missing sw');
  if (!skill.includes('opd-verify.mjs down')) problems.push('SKILL.md missing down');
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`feature map ok (${FEATURE_FILES.length} features)`);
}

const command = process.argv[2];
if (command === 'serve') startProxy(homeDir());
else if (command === 'up') await up();
else if (command === 'doctor') {
  try {
    await doctor();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
else if (command === 'down') down();
else if (command === 'drive') await drive(process.argv[3] || 'all');
else if (command === 'sw') await sw();
else if (command === 'check') checkMap();
else {
  console.error('usage: opd-verify.mjs up|doctor|drive <feature|all>|sw|down|check|serve');
  process.exit(2);
}
