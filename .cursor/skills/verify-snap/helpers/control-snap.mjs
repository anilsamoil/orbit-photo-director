#!/usr/bin/env bun
/**
 * control-snap — launch / doctor / browser / cleanup for SNAP verification.
 *
 * Usage (from repo root or any cwd):
 *   .cursor/skills/verify-snap/helpers/control-snap.mjs launch
 *   .cursor/skills/verify-snap/helpers/control-snap.mjs doctor
 *   .cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id tab-queue
 *   .cursor/skills/verify-snap/helpers/control-snap.mjs browser snapshot --aria --path ...
 *   .cursor/skills/verify-snap/helpers/control-snap.mjs browser screenshot --path ...
 *   .cursor/skills/verify-snap/helpers/control-snap.mjs cleanup
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, '..');
const repoRoot = resolve(skillRoot, '../../..');
const frontendRoot = resolve(repoRoot, 'frontend');
const statePath = resolve(skillRoot, '.run-state.json');
const defaultPort = Number(process.env.SNAP_VERIFY_PORT || 43147);
const defaultHost = process.env.SNAP_VERIFY_HOST || '127.0.0.1';
const evidenceRoot = resolve(skillRoot, 'artifacts');

function loadState() {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function baseUrl(state) {
  const s = state || loadState();
  if (!s) throw new Error('no run state — run launch first');
  return `http://${s.host}:${s.port}`;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitReady(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status > 0 && r.status < 500) return true;
    } catch {
      // retry
    }
    await sleep(400);
  }
  return false;
}

async function cmdLaunch(argv) {
  const existing = loadState();
  if (existing && pidAlive(existing.pid)) {
    console.log(JSON.stringify({ ok: true, reused: true, url: baseUrl(existing), pid: existing.pid }));
    return;
  }
  if (existing && !pidAlive(existing.pid) && existsSync(statePath)) {
    unlinkSync(statePath);
  }

  const port = Number(process.env.SNAP_VERIFY_PORT || defaultPort);
  const host = process.env.SNAP_VERIFY_HOST || defaultHost;
  const logPath = resolve(skillRoot, '.vite-verify.log');

  if (!existsSync(resolve(frontendRoot, 'node_modules/vite'))) {
    throw new Error(`frontend deps missing — run: cd frontend && bun install`);
  }

  mkdirSync(evidenceRoot, { recursive: true });

  const configPath = resolve(here, 'vite.config.verify.mjs');
  const child = spawn(
    'bun',
    ['x', 'vite', '--config', configPath, '--host', host, '--port', String(port), '--strictPort'],
    {
      cwd: frontendRoot,
      env: { ...process.env, BROWSER: 'none' },
      detached: true,
      stdio: 'ignore',
    },
  );

  const url = `http://${host}:${port}`;
  const ready = await waitReady(url, 45_000);
  writeFileSync(logPath, `launch pid=${child.pid} url=${url} ready=${ready}\n`);

  if (!ready || !pidAlive(child.pid)) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ignore */ }
    throw new Error(`vite failed to become ready at ${url}; see ${logPath}`);
  }

  const man = await fetch(`${url}/manifest.json`);
  if (!man.ok) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ignore */ }
    throw new Error(`fixture manifest not served (${man.status})`);
  }
  const manifest = await man.json();
  if (manifest.version !== 'VERIFY') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ignore */ }
    throw new Error(`unexpected fixture version: ${manifest.version}`);
  }
  const session = await fetch(`${url}/api/browser/session`);
  if (!session.ok) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ignore */ }
    throw new Error(`session stub not served (${session.status})`);
  }

  writeState({
    pid: child.pid,
    host,
    port,
    url,
    startedAt: new Date().toISOString(),
    fixtureVersion: manifest.version,
    logPath,
  });
  child.unref();
  console.log(JSON.stringify({ ok: true, url, pid: child.pid, fixtureVersion: manifest.version }));
}

async function cmdDoctor() {
  const state = loadState();
  if (!state) {
    console.log(JSON.stringify({ ok: false, error: 'no run state' }));
    process.exitCode = 1;
    return;
  }
  const alive = pidAlive(state.pid);
  let htmlOk = false;
  let brand = null;
  let manifestOk = false;
  let title = null;
  try {
    const r = await fetch(state.url);
    htmlOk = r.ok;
    const html = await r.text();
    title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || null;
    brand = html.includes('brand-name">SNAP') || html.includes('SNAP');
  } catch (e) {
    htmlOk = false;
  }
  try {
    const m = await fetch(`${state.url}/manifest.json`);
    manifestOk = m.ok && (await m.json()).version === 'VERIFY';
  } catch {
    manifestOk = false;
  }

  const ok = alive && htmlOk && brand && manifestOk;
  const report = {
    ok,
    url: state.url,
    pid: state.pid,
    pidAlive: alive,
    htmlOk,
    brandOk: !!brand,
    title,
    fixtureManifestOk: manifestOk,
    fixtureVersion: state.fixtureVersion,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
}

function parseBrowserArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id' || a === '--path' || a === '--value' || a === '--name' || a === '--role' || a === '--key' || a === '--selector' || a === '--wait-for') {
      out[a.slice(2)] = argv[++i];
    } else if (a === '--aria') {
      out.aria = true;
    } else if (a.startsWith('--')) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function getPlaywright() {
  const require = createRequire(resolve(skillRoot, 'helpers/package.json'));
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'playwright not installed for verify-snap — run: cd .cursor/skills/verify-snap/helpers && bun install',
    );
  }
}

async function withPage(fn) {
  const state = loadState();
  if (!state || !pidAlive(state.pid)) {
    throw new Error('instance not healthy — run launch + doctor first');
  }
  const { chromium } = await getPlaywright();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // Wait for fixture-driven UI: banner leaves Loading… or cards populate
  await page.waitForFunction(
    () => {
      const banner = document.getElementById('status-banner');
      const cards = document.getElementById('cards');
      const text = banner?.textContent || '';
      const hasCards = (cards?.children?.length || 0) > 0;
      return hasCards || (text && !text.includes('Loading'));
    },
    { timeout: 20_000 },
  ).catch(() => {});
  try {
    return await fn(page, state);
  } finally {
    await browser.close();
  }
}

async function cmdBrowser(argv) {
  const action = argv[0];
  const args = parseBrowserArgs(argv.slice(1));
  if (!action) throw new Error('browser requires an action');

  if (action === 'goto') {
    await withPage(async (page) => {
      const path = args.path || args._[0] || '/';
      await page.goto(new URL(path, baseUrl()).toString(), { waitUntil: 'domcontentloaded' });
      console.log(JSON.stringify({ ok: true, action: 'goto', path }));
    });
    return;
  }

  if (action === 'click') {
    await withPage(async (page) => {
      if (args.id) {
        await page.locator(`#${args.id}`).click();
      } else if (args.role && args.name) {
        await page.getByRole(args.role, { name: args.name }).click();
      } else if (args.selector) {
        await page.locator(args.selector).click();
      } else {
        throw new Error('click needs --id, --role/--name, or --selector');
      }
      if (args['wait-for']) {
        await page.waitForSelector(args['wait-for'], { timeout: 10_000 });
      }
      console.log(JSON.stringify({ ok: true, action: 'click', id: args.id || null, name: args.name || null }));
    });
    return;
  }

  if (action === 'fill') {
    await withPage(async (page) => {
      if (!args.value) throw new Error('fill needs --value');
      if (args.id) {
        await page.locator(`#${args.id}`).fill(args.value);
      } else if (args.role && args.name) {
        await page.getByRole(args.role, { name: args.name }).fill(args.value);
      } else {
        throw new Error('fill needs --id or --role/--name');
      }
      console.log(JSON.stringify({ ok: true, action: 'fill', value: args.value }));
    });
    return;
  }

  if (action === 'press') {
    await withPage(async (page) => {
      await page.keyboard.press(args.key || args._[0] || 'Enter');
      console.log(JSON.stringify({ ok: true, action: 'press', key: args.key }));
    });
    return;
  }

  if (action === 'eval') {
    await withPage(async (page) => {
      const expr = args._.join(' ') || args.value;
      if (!expr) throw new Error('eval needs an expression');
      const result = await page.evaluate(expr);
      console.log(JSON.stringify({ ok: true, action: 'eval', result }, null, 2));
    });
    return;
  }

  if (action === 'snapshot') {
    await withPage(async (page) => {
      const path = args.path;
      if (!path) throw new Error('snapshot needs --path');
      mkdirSync(dirname(resolve(path)), { recursive: true });
      let body;
      if (args.aria) {
        // Lightweight ARIA-ish text dump of key SNAP regions
        body = await page.evaluate(() => {
          const pick = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            return {
              id: el.id || null,
              role: el.getAttribute('role'),
              ariaLabel: el.getAttribute('aria-label'),
              className: el.className,
              text: (el.innerText || '').trim().slice(0, 2000),
              childCount: el.children.length,
            };
          };
          return {
            title: document.title,
            brand: document.querySelector('.brand-name')?.textContent || null,
            viewClass: document.getElementById('view')?.className || null,
            activeTab: document.querySelector('.tab.active')?.id || null,
            banner: pick('#status-banner'),
            queueCards: pick('#cards'),
            upcomingCards: pick('#upcoming-cards'),
            map: pick('#map'),
            timeSlider: pick('#time-slider'),
            profileBody: pick('#profile-body'),
            logList: pick('#log-list'),
            toast: pick('#toast'),
          };
        });
        writeFileSync(resolve(path), JSON.stringify(body, null, 2));
      } else {
        body = await page.content();
        writeFileSync(resolve(path), body);
      }
      console.log(JSON.stringify({ ok: true, action: 'snapshot', path: resolve(path) }));
    });
    return;
  }

  if (action === 'screenshot') {
    await withPage(async (page) => {
      const path = args.path;
      if (!path) throw new Error('screenshot needs --path');
      mkdirSync(dirname(resolve(path)), { recursive: true });
      // Optional pre-click
      if (args.id) {
        await page.locator(`#${args.id}`).click();
        await sleep(800);
      }
      await page.screenshot({ path: resolve(path), fullPage: false });
      console.log(JSON.stringify({ ok: true, action: 'screenshot', path: resolve(path) }));
    });
    return;
  }

  if (action === 'prove-queue') {
    // One-shot recipe used by the skill proof: open Queue, assert fixture cards, capture evidence.
    const outDir = resolve(args.path || join(evidenceRoot, 'queue'));
    mkdirSync(outDir, { recursive: true });
    await withPage(async (page) => {
      await page.locator('#tab-queue').click();
      await page.waitForFunction(
        () => document.getElementById('view')?.className === 'view-queue',
        { timeout: 5_000 },
      );
      await page.waitForFunction(
        () => (document.getElementById('cards')?.children.length || 0) >= 1,
        { timeout: 15_000 },
      );
      const proof = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#cards .card, #cards [data-target-id], #cards > *')];
        const names = cards.map((c) => (c.textContent || '').trim()).filter(Boolean);
        return {
          title: document.title,
          brand: document.querySelector('.brand-name')?.textContent || null,
          viewClass: document.getElementById('view')?.className,
          activeTab: document.querySelector('.tab.active')?.id || null,
          cardCount: document.getElementById('cards')?.children.length || 0,
          cardTextSample: names.slice(0, 5).map((t) => t.slice(0, 200)),
          banner: (document.getElementById('status-banner')?.innerText || '').trim(),
          hasVerifyTokyo: (document.getElementById('cards')?.innerText || '').includes('Verify Tokyo'),
        };
      });
      writeFileSync(join(outDir, 'queue.aria.json'), JSON.stringify(proof, null, 2));
      await page.screenshot({ path: join(outDir, 'queue.png') });
      if (!proof.hasVerifyTokyo || proof.cardCount < 1) {
        console.error(JSON.stringify({ ok: false, proof }, null, 2));
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ok: true, action: 'prove-queue', outDir, proof }, null, 2));
    });
    return;
  }

  throw new Error(`unknown browser action: ${action}`);
}

async function cmdCleanup() {
  const state = loadState();
  if (!state) {
    console.log(JSON.stringify({ ok: true, cleaned: false, reason: 'no state' }));
    return;
  }
  if (pidAlive(state.pid)) {
    try {
      process.kill(-state.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
    await sleep(500);
    if (pidAlive(state.pid)) {
      try {
        process.kill(-state.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(state.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (existsSync(statePath)) unlinkSync(statePath);
  if (state.logPath && existsSync(state.logPath)) {
    try { unlinkSync(state.logPath); } catch { /* ignore */ }
  }
  console.log(JSON.stringify({ ok: true, cleaned: true, evidenceKept: evidenceRoot, killedPid: state.pid }));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`control-snap commands: launch | doctor | browser | cleanup`);
    return;
  }
  if (cmd === 'launch') await cmdLaunch(rest);
  else if (cmd === 'doctor') await cmdDoctor();
  else if (cmd === 'browser') await cmdBrowser(rest);
  else if (cmd === 'cleanup') await cmdCleanup();
  else throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exitCode = 1;
});
