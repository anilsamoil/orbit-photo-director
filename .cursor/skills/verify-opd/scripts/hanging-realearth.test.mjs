import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolateSnapRequests, serveSnap } from './context-state-fixture.mjs';
import { WEBKIT_DEVICES, launchWebkit, openDeviceContext, replaceDeviceContext } from './webkit-devices.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '../../../..');

test('painted replacement completes with its own RealEarth source still pending', { timeout: 120_000 }, async (t) => {
  const served = await serveSnap();
  const contexts = [];
  const controller = new AbortController();
  let browser;
  let changing;
  let observationTimer;
  try {
    browser = await launchWebkit();
    isolateSnapRequests(browser, served.url);
    const original = browser.newContext.bind(browser);
    let candidatePage;
    const candidateCreated = new Promise((done) => { candidatePage = done; });
    browser.newContext = async (...args) => {
      const context = await original(...args);
      const evidence = { context, pending: new Set(), intercepted: 0 };
      contexts.push(evidence);
      context.on('requestfinished', (request) => evidence.pending.delete(request));
      context.on('requestfailed', (request) => evidence.pending.delete(request));
      await context.route(/^https:\/\/realearth\.ssec\.wisc\.edu\//, (route) => {
        evidence.pending.add(route.request());
        evidence.intercepted += 1;
        return new Promise(() => {});
      });
      // Observe real render events from boot, including the frame at handoff.
      // Do not stub loaded(), the source manager, or the readiness predicate.
      await context.addInitScript(() => {
        let current;
        Object.defineProperty(window, '__opdMap', {
          configurable: true,
          get: () => current,
          set(map) {
            current = map;
            map.on('render', () => {
              if (!map.getSource('geo-ir')) return;
              const gl = map.painter.context.gl;
              const rgba = new Uint8Array(4);
              gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
              window.__hangingFrame = {
                loaded: map.loaded(), sourceLoaded: map.isSourceLoaded('geo-ir'),
                tiles: map.getStyle().sources['geo-ir'].tiles,
                visible: map.getLayoutProperty('geo-ir-layer', 'visibility') !== 'none',
                painted: rgba[3] > 0, rgba: [...rgba],
              };
            });
          },
        });
      });
      if (contexts.length === 2) context.on('page', candidatePage);
      return context;
    };
    const spec = WEBKIT_DEVICES.find((entry) => entry.slug === 'iphone-17-pro');
    const session = await openDeviceContext(browser, spec);
    await session.page.goto(`${served.url}/?e2e`);
    await session.page.locator('#tab-map').evaluate((el) => el.click());
    await session.page.waitForFunction(() => window.__opdMap?.getLayer('iss-track-layer'));
    await session.page.evaluate(async () => {
      const app = await import('/src/main.ts');
      const { launchCatalog } = await import('/src/launch-catalog.ts');
      await Promise.all([app.refresh(), launchCatalog.refresh()]);
      app.rerenderCountdowns();
      const follow = document.getElementById('toggle-follow-iss');
      if (follow.getAttribute('aria-pressed') === 'true') follow.click();
      window.__opdMap.jumpTo({ center: [0, 0], zoom: 3 });
      const ir = document.getElementById('toggle-ir');
      if (ir.getAttribute('aria-pressed') !== 'true') ir.click();
    });
    const hasPendingPaint = () => {
      const frame = window.__hangingFrame;
      return frame?.painted && frame.visible && !frame.loaded && !frame.sourceLoaded
        && frame.tiles.some((url) => url.startsWith('https://realearth.ssec.wisc.edu/'));
    };
    await session.page.waitForFunction(hasPendingPaint);
    assert.ok(contexts[0].pending.size > 0, 'predecessor owns held RealEarth requests');
    const predecessor = session.page;
    changing = replaceDeviceContext(session, { width: 874, height: 402 }, controller.signal).then(
      () => ({ status: 'fulfilled' }),
      (error) => ({ status: 'rejected', message: error.message }),
    );
    const candidate = await candidateCreated;
    await candidate.waitForFunction(hasPendingPaint);
    assert.ok(contexts[1].pending.size > 0, 'candidate itself owns held RealEarth requests');
    const ready = await candidate.evaluate(() => window.__hangingFrame);
    // Both 1.2s bounded-idle gates fit here. The mutant stays blocked; fail an
    // assertion before its 30s renderer deadline, then abort/join it in finally.
    const outcome = await Promise.race([
      changing,
      new Promise((done) => { observationTimer = setTimeout(() => done({ status: 'pending' }), 10_000); }),
    ]);
    t.diagnostic(JSON.stringify({ ready, outcome, candidatePending: contexts[1].pending.size, predecessorAlive: !predecessor.isClosed(), predecessorPublic: session.page === predecessor }));
    assert.deepEqual(outcome, { status: 'fulfilled' }, 'painted candidate must replace predecessor while its own RealEarth tiles remain pending');
    assert.equal(session.page, candidate);
    assert.equal(predecessor.isClosed(), true);
    assert.ok(contexts[1].pending.size > 0, 'candidate requests remain held at handoff');
    assert.equal(await candidate.evaluate(hasPendingPaint), true, 'handoff frame is painted while the active RealEarth source remains unloaded');
  } finally {
    clearTimeout(observationTimer);
    controller.abort();
    await changing;
    try { await browser?.close(); }
    finally { await served.close(); }
  }
});

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
