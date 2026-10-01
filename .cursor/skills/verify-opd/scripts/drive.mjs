import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { refreshLaunchClock } from './fixtures.mjs';
import { deviceDescriptor, deviceViewport, launchWebkit, playwrightSend, proveDeniedFooter, WEBKIT_DEVICES } from './webkit-devices.mjs';

export const BROWSER_FEATURES = ['banner', 'topbar', 'queue', 'upcoming', 'map', 'iss', 'help', 'profile', 'log', 'phone', 'tracked'];

const DESKTOP = { width: 1400, height: 900, mobile: false };
const ISS_LENS_FOV_DEG = 81.2;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function chromeBin() {
  return process.env.OPD_VERIFY_CHROME || 'google-chrome';
}

export async function connectCdp(port) {
  let list = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        list = await response.json();
        if (list.some((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)) break;
      }
    } catch {
      list = [];
    }
    await sleep(200);
  }
  const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  if (!page) throw new Error(`chrome debug port ${port} has no page`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('chrome websocket timed out')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolveOpen();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      rejectOpen(new Error('chrome websocket failed'));
    });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolveMessage, rejectMessage } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectMessage(new Error(JSON.stringify(message.error)));
      else resolveMessage(message.result);
    }
  });
  function send(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolveMessage, rejectMessage) => {
      pending.set(id, { resolveMessage, rejectMessage });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    send,
    close: () => ws.close(),
  };
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'evaluate failed';
    throw new Error(text);
  }
  return result.result?.value;
}

async function waitFor(send, expression, label, timeoutMs = 20000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(send, `(() => { try { return (${expression}); } catch (error) { return { error: String(error) }; } })()`);
    if (last && typeof last === 'object' && typeof last.error === 'string') {
      throw new Error(`${label}: ${last.error}`);
    }
    if (last && typeof last === 'object' && last.ok === true) return last;
    if (last === true) return true;
    await sleep(250);
  }
  throw new Error(`${label} timed out. Last value: ${JSON.stringify(last)}`);
}

async function click(send, selector) {
  const clicked = await evaluate(send, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`missing ${selector}`);
}

async function shot(send, evidenceDir, name) {
  const image = await send('Page.captureScreenshot', { format: 'png' });
  const file = resolve(evidenceDir, `${name}.png`);
  writeFileSync(file, Buffer.from(image.data, 'base64'));
  return file;
}

async function mouseClick(send, x, y, button = 'left') {
  const buttons = button === 'right' ? 2 : 1;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
}

async function setViewport(send, width, height, mobile) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
}

async function safeAreaOverride(send, insets) {
  try {
    await send('Emulation.setSafeAreaInsetsOverride', { insets });
    return true;
  } catch {
    return false;
  }
}

async function removedCuratedIds(send) {
  const ids = await evaluate(send, `(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('opd-profile-anil') || '{}');
      return Array.isArray(parsed.removedCuratedIds) ? parsed.removedCuratedIds : [];
    } catch {
      return [];
    }
  })()`);
  return Array.isArray(ids) ? ids : [];
}

async function serverRemoved(baseUrl) {
  const response = await fetch(`${baseUrl}/api/browser/profiles/anil/targets`);
  if (!response.ok) throw new Error(`profile GET ${response.status}`);
  return response.json();
}

async function waitServerRemoved(baseUrl, includes, excludes) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 10000) {
    last = await serverRemoved(baseUrl);
    const ids = Array.isArray(last.removedCuratedIds) ? last.removedCuratedIds : [];
    const hasAll = includes.every((id) => ids.includes(id));
    const hasNone = excludes.every((id) => !ids.includes(id));
    if (hasAll && hasNone && typeof last.removedCuratedUpdatedAt === 'string') return last;
    await sleep(200);
  }
  throw new Error(`profile GET did not reach ${JSON.stringify({ includes, excludes })}. Last: ${JSON.stringify(last)}`);
}

async function freshProfile(baseUrl, home, run) {
  const debugPort = 19000 + Math.floor(Math.random() * 1000);
  const profile = resolve(home, `chrome-guest-${debugPort}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const child = spawn(chromeBin(), [
    '--headless=new',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--window-size=1400,900',
    '--no-first-run',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  try {
    const cdp = await connectCdp(debugPort);
    try {
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url: `${baseUrl}/?e2e` });
      await waitFor(cdp.send, `document.readyState === 'complete' ? { ok: true } : null`, 'guest page load', 30000);
      await waitFor(
        cdp.send,
        `(() => {
          const text = document.getElementById('status-banner')?.textContent || '';
          if (!text || text.includes('Loading')) return null;
          return { ok: true };
        })()`,
        'guest banner',
        30000,
      );
      await run(cdp.send);
    } finally {
      cdp.close();
    }
  } finally {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      /* guest already exited */
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(150);
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        /* Chrome can still hold the profile directory for a moment. */
      }
    }
  }
}

async function expectFreshHide(baseUrl, home, { id, name, updatedAt, visible }) {
  await freshProfile(baseUrl, home, async (send) => {
    await click(send, '#tab-upcoming');
    await waitFor(
      send,
      `(() => {
        const cards = document.getElementById('upcoming-cards');
        if (!cards) return null;
        let stored = {};
        try { stored = JSON.parse(localStorage.getItem('opd-profile-anil') || '{}'); } catch { return null; }
        const ids = Array.isArray(stored.removedCuratedIds) ? stored.removedCuratedIds : [];
        if (stored.removedCuratedUpdatedAt !== ${JSON.stringify(updatedAt)}) return null;
        const hidden = ids.includes(${JSON.stringify(id)});
        const shown = (cards.textContent || '').includes(${JSON.stringify(name)});
        if (${visible ? 'true' : 'false'}) {
          if (hidden || !shown) return null;
        } else if (!hidden || shown) return null;
        return { ok: true };
      })()`,
      visible ? 'fresh profile restored the card' : 'fresh profile hid the card',
      30000,
    );
  });
}

async function hideNamed(send, container, name) {
  const id = await evaluate(send, `(() => {
    const root = document.querySelector(${JSON.stringify(container)});
    const card = [...(root ? root.querySelectorAll('.card') : [])].find((el) => (el.innerText || '').includes(${JSON.stringify(name)}));
    const button = card && card.querySelector('.btn-hide');
    if (!card || !button) return '';
    button.click();
    return card.dataset.targetId || '';
  })()`);
  if (!id) throw new Error(`no hide button for ${name}`);
  return id;
}

async function reloadSettled(send) {
  await send('Page.reload');
  await waitFor(send, `document.readyState === 'complete' ? { ok: true } : null`, 'reload', 30000);
  await waitFor(
    send,
    `(() => {
      const banner = document.getElementById('status-banner');
      const text = banner ? banner.textContent || '' : '';
      if (!text || text.includes('Loading')) return null;
      return { ok: true };
    })()`,
    'banner after reload',
    30000,
  );
}

function touchPoint(x, y) {
  return { x: Math.round(x), y: Math.round(y), radiusX: 1, radiusY: 1, force: 1, id: 1 };
}

async function pointForLngLat(send, lng, lat) {
  return evaluate(send, `(() => {
    const map = window.__opdMap;
    if (!map) return { ok: false, reason: 'no map' };
    const canvas = map.getCanvas();
    const projected = map.project([${lng}, ${lat}]);
    const rect = canvas.getBoundingClientRect();
    return { ok: true, x: rect.left + projected.x, y: rect.top + projected.y };
  })()`);
}

async function frameLngLat(send, lng, lat, zoom) {
  await evaluate(send, `window.__opdMap.jumpTo({ center: [${lng}, ${lat}], zoom: ${zoom} }); true`);
  await sleep(400);
}

export function startChrome(home, debugPort) {
  const profile = resolve(home, 'chrome-profile');
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const child = spawn(chromeBin(), [
    '--headless=new',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    '--window-size=1400,900',
    '--no-first-run',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

const LOG_HOOK = `window.__opdLogs = [];
  window.addEventListener('error', (event) => window.__opdLogs.push(String(event.message)));
  const original = console.error;
  console.error = (...args) => { window.__opdLogs.push(args.map(String).join(' ')); return original.apply(console, args); };`;

function slideLaunch(home) {
  const until = refreshLaunchClock(resolve(home, 'fixtures'));
  const stateFile = resolve(home, 'state.json');
  if (!existsSync(stateFile)) return until;
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.launchValidUntil = until;
  writeFileSync(stateFile, JSON.stringify(state));
  return until;
}

async function resetFixtureProfile(baseUrl) {
  const response = await fetch(`${baseUrl}/api/browser/profiles/anil/targets`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets: [], removedCuratedIds: [] }),
  });
  if (!response.ok) throw new Error(`profile reset ${response.status}`);
}

async function openApp(send, baseUrl) {
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: LOG_HOOK });
  await send('Page.navigate', { url: `${baseUrl}/?e2e` });
  await waitFor(send, `document.readyState === 'complete' ? { ok: true } : null`, 'page load', 30000);
  await waitFor(
    send,
    `(() => {
      const banner = document.getElementById('status-banner');
      if (!banner) return null;
      const text = banner.textContent || '';
      if (text.includes('Loading')) return null;
      return { ok: true, text };
    })()`,
    'banner left Loading',
    30000,
  );
}

async function runFeatures(send, evidenceDir, meta, features, baseUrl, home, viewport) {
  mkdirSync(evidenceDir, { recursive: true });
  const selected = features.includes('all') ? BROWSER_FEATURES : features;
  const notes = [];
  for (const feature of selected) {
    if (feature === 'banner') notes.push(await driveBanner(send, evidenceDir, baseUrl));
    else if (feature === 'topbar') notes.push(await driveTopbar(send, evidenceDir, viewport));
    else if (feature === 'queue') notes.push(await driveQueue(send, evidenceDir, meta, baseUrl));
    else if (feature === 'upcoming') notes.push(await driveUpcoming(send, evidenceDir, meta, baseUrl, home));
    else if (feature === 'map') notes.push(await driveMap(send, evidenceDir, meta, baseUrl));
    else if (feature === 'iss') notes.push(await driveIss(send, evidenceDir, viewport));
    else if (feature === 'help') notes.push(await driveHelp(send, evidenceDir));
    else if (feature === 'profile') notes.push(await driveProfile(send, evidenceDir, meta, baseUrl, home));
    else if (feature === 'log') notes.push(await driveLog(send, evidenceDir, baseUrl));
    else if (feature === 'phone') notes.push(await drivePhone(send, evidenceDir, meta, viewport));
    else if (feature === 'tracked') notes.push(await driveTracked(send, evidenceDir, meta, viewport));
    else throw new Error(`unknown feature ${feature}`);
  }
  return notes;
}

async function driveChrome({ baseUrl, evidenceDir, meta, features, home }) {
  slideLaunch(home);
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const chromePid = startChrome(home, debugPort);
  writeFileSync(resolve(home, 'chrome.pid'), String(chromePid));
  try {
    const cdp = await connectCdp(debugPort);
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: DESKTOP.width,
        height: DESKTOP.height,
        deviceScaleFactor: 1,
        mobile: DESKTOP.mobile,
      });
      await openApp(cdp.send, baseUrl);
      const notes = await runFeatures(cdp.send, evidenceDir, meta, features, baseUrl, home, DESKTOP);
      return notes.map((note) => `desktop: ${note}`);
    } finally {
      cdp.close();
    }
  } finally {
    try {
      process.kill(chromePid, 'SIGTERM');
    } catch {
    }
  }
}

async function driveWebkitSurfaces({ baseUrl, evidenceDir, meta, features, home }) {
  const browser = await launchWebkit();
  const notes = [];
  try {
    for (const spec of WEBKIT_DEVICES) {
      const viewport = deviceViewport(spec);
      const surfaceDir = resolve(evidenceDir, spec.slug);
      slideLaunch(home);
      await resetFixtureProfile(baseUrl);
      const context = await browser.newContext({ ...deviceDescriptor(spec) });
      if (spec.standalone) {
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
        });
      }
      const page = await context.newPage();
      try {
        const send = playwrightSend(page);
        await openApp(send, baseUrl);
        const featureNotes = await runFeatures(send, surfaceDir, meta, features, baseUrl, home, viewport);
        notes.push(...featureNotes.map((note) => `${spec.slug}: ${note}`));
      } finally {
        await context.close();
      }
      notes.push(`${spec.slug}: ${await proveDeniedFooter(browser, spec, baseUrl, surfaceDir)}`);
    }
  } finally {
    await browser.close();
  }
  return notes;
}

export async function driveFeatures({ baseUrl, evidenceDir, meta, features }) {
  mkdirSync(evidenceDir, { recursive: true });
  const home = resolve(evidenceDir, '..');
  const desktop = await driveChrome({ baseUrl, evidenceDir, meta, features, home });
  const webkit = await driveWebkitSurfaces({ baseUrl, evidenceDir, meta, features, home });
  return [...desktop, ...webkit];
}

async function dismissShotlist(send) {
  const covering = await evaluate(send, `document.body.classList.contains('shotlist-bar-visible')`);
  if (!covering) return;
  await click(send, '.shotlist-clear');
  await waitFor(
    send,
    `!document.body.classList.contains('shotlist-bar-visible') ? { ok: true } : null`,
    'shot list cleared',
  );
}

async function driveBanner(send, evidenceDir, baseUrl) {
  const text = await evaluate(send, `document.getElementById('status-banner').textContent`);
  if (!text || /sign in/i.test(text) || text.includes('Could not verify') || !text.includes('Last updated')) {
    throw new Error(`banner is not a data state: ${text}`);
  }
  const pinned = await evaluate(send, `getComputedStyle(document.getElementById('status-banner')).position`);
  if (pinned !== 'fixed') throw new Error(`map banner is ${pinned}, expected fixed`);
  await shot(send, evidenceDir, 'banner');
  await click(send, '#tab-queue');
  const queueBanner = await waitFor(
    send,
    `(() => {
      const view = document.getElementById('view')?.className;
      const banner = document.getElementById('status-banner');
      if (!banner || view !== 'view-queue') return null;
      return { ok: true, position: getComputedStyle(banner).position };
    })()`,
    'queue banner',
  );
  if (queueBanner.position !== 'static') throw new Error(`queue banner ${queueBanner.position}`);
  const held = await proveHeldSignIn(send, evidenceDir, baseUrl);
  return `banner: ${text.trim()}, queue ${queueBanner.position}, held ${held}`;
}

async function setSessionCookie(send, value) {
  const assignment = value
    ? `document.cookie = ${JSON.stringify(`opd-verify-session=${value}; path=/`)}`
    : `document.cookie = 'opd-verify-session=; path=/; max-age=0'`;
  await evaluate(send, assignment);
}

async function waitForHref(send, pattern, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 8000) {
    try {
      last = await evaluate(send, `location.href`);
      if (typeof last === 'string' && pattern.test(last)) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(`${label} timed out. Last: ${last}`);
}

async function proveHeldSignIn(send, evidenceDir, baseUrl) {
  await setSessionCookie(send, 'expired');
  await send('Page.navigate', { url: `${baseUrl}/?e2e&u=anil` });
  const held = await waitFor(
    send,
    `(() => {
      const banner = document.getElementById('status-banner');
      const text = banner ? banner.textContent || '' : '';
      if (!text.startsWith('SIGN IN AGAIN') || !text.includes('Tap here.')) return null;
      if (text.includes('STALE') || text.includes('LOS') || banner.querySelector('a, button')) return null;
      return { ok: true, text };
    })()`,
    'held SIGN IN AGAIN banner',
    30000,
  );
  const before = held.text;
  await sleep(1200);
  const afterTick = await evaluate(send, `document.getElementById('status-banner').textContent`);
  if (afterTick !== before) throw new Error(`countdown replaced the held banner: ${afterTick}`);
  await evaluate(send, `(() => {
    window.__opdHoldFetches = 0;
    window.__opdHoldFetch = window.fetch;
    window.fetch = (input) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (String(url).includes('manifest.json')) window.__opdHoldFetches += 1;
      return Promise.reject(new TypeError('Failed to fetch'));
    };
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  })()`);
  const los = await waitFor(
    send,
    `(() => {
      const banner = document.getElementById('status-banner');
      const text = banner ? banner.textContent || '' : '';
      if (!window.__opdHoldFetches) return null;
      return { ok: true, text, calls: window.__opdHoldFetches };
    })()`,
    'held banner through a failed refresh',
    8000,
  );
  if (los.text !== before) throw new Error(`failed refresh replaced the held banner: ${los.text}`);
  await evaluate(send, `window.fetch = window.__opdHoldFetch`);
  await shot(send, evidenceDir, 'banner-hold');
  await click(send, '#status-banner');
  const href = await waitForHref(send, /\/api\/app/, 'held banner click');
  if (!href.includes('u=anil')) throw new Error(`held click dropped the profile: ${href}`);
  await setSessionCookie(send, '');
  await send('Page.navigate', { url: `${baseUrl}/?e2e` });
  await waitFor(
    send,
    `(() => {
      const text = document.getElementById('status-banner')?.textContent || '';
      if (!text.includes('Last updated') || /sign in/i.test(text)) return null;
      return { ok: true };
    })()`,
    'banner restored after the hold',
    30000,
  );
  return before;
}

async function driveTopbar(send, evidenceDir, home) {
  const header = await waitFor(
    send,
    `(() => {
      const bar = document.querySelector('.topbar');
      const iss = document.getElementById('iss-now');
      const kp = document.getElementById('kp-widget');
      if (!bar || !iss || !kp) return null;
      const issText = iss.textContent.trim();
      if (!/^ISS\\d/.test(issText) || /live track expired/i.test(issText)) return null;
      if (iss.getAttribute('title') !== ${JSON.stringify('Live ISS sub-point from SGP4, or the polynomial fit when SGP4 has no position')}) return null;
      if (!kp || kp.hidden) return null;
      const kpText = kp.textContent.trim();
      if (!kpText.includes('Kp 3.0')) return null;
      if (getComputedStyle(bar).position !== 'fixed') return null;
      return { ok: true, iss: iss.textContent.trim(), kp: kpText };
    })()`,
    'topbar ISS and Kp',
    20000,
  );
  const sunHidden = await evaluate(send, `document.getElementById('sun-widget')?.hidden !== false`);
  await shot(send, evidenceDir, 'topbar');
  await click(send, '#tab-queue');
  const queueBox = await evaluate(send, `(() => {
    const bar = document.querySelector('.topbar');
    const main = document.querySelector('main');
    const banner = document.getElementById('status-banner');
    return {
      className: main && main.className,
      pad: main && getComputedStyle(main).paddingTop,
      height: bar && getComputedStyle(bar).height,
      banner: banner && getComputedStyle(banner).position,
    };
  })()`);
  if (queueBox.className !== 'view-queue') throw new Error(`queue view ${JSON.stringify(queueBox)}`);
  const pad = Number.parseFloat(queueBox.pad);
  const height = Number.parseFloat(queueBox.height);
  if (!Number.isFinite(pad) || !Number.isFinite(height) || Math.abs(pad - height) > 1) {
    throw new Error(`queue pad ${JSON.stringify(queueBox)}`);
  }
  if (queueBox.banner === 'fixed') throw new Error(`queue banner still fixed ${JSON.stringify(queueBox)}`);
  await shot(send, evidenceDir, 'topbar-queue');
  const frames = [
    [402, 874, 'topbar-iphone-17-pro'],
    [874, 402, 'topbar-iphone-17-pro-land'],
    [390, 844, 'topbar-iphone-13'],
    [844, 390, 'topbar-iphone-13-land'],
    [834, 1194, 'topbar-ipad'],
  ];
  let panned = 0;
  let issPanned = 0;
  try {
    for (const [width, height, name] of frames) {
      await setViewport(send, width, height, true);
      const reach = await waitFor(send, topbarReachExpression(), `topbar reach ${width}x${height}`, 8000);
      await shot(send, evidenceDir, name);
      if (width === 402 && height === 874) {
        const pans = await panTopbarFromLeft(send);
        panned = pans.kp;
        issPanned = pans.iss;
        await shot(send, evidenceDir, 'topbar-pan-left');
        await tapTopbarControl(send, '#tab-queue');
        const queue = await evaluate(send, `document.querySelector('main')?.className`);
        if (queue !== 'view-queue') throw new Error(`queue tap landed on ${queue}`);
        await tapTopbarControl(send, '#tab-upcoming');
        const upcoming = await evaluate(send, `document.querySelector('main')?.className`);
        if (upcoming !== 'view-upcoming') throw new Error(`upcoming tap landed on ${upcoming}`);
      }
      if (reach.scrollWidth <= reach.clientWidth && width <= 402) {
        throw new Error(`topbar did not scroll at ${width}x${height}: ${JSON.stringify(reach)}`);
      }
    }
    const inset = await safeAreaOverride(send, { top: 59, left: 59, bottom: 34, right: 47 });
    if (inset) {
      await setViewport(send, 874, 402, true);
      const pad = await evaluate(send, `(() => {
        const bar = getComputedStyle(document.querySelector('.topbar'));
        return { left: bar.paddingLeft, right: bar.paddingRight, top: bar.paddingTop };
      })()`);
      const left = Number.parseFloat(pad.left);
      const right = Number.parseFloat(pad.right);
      const top = Number.parseFloat(pad.top);
      if (left < 59 || right < 47 || top < 59) throw new Error(`safe area padding ${JSON.stringify(pad)}`);
    }
  } finally {
    await safeAreaOverride(send, { top: 0, left: 0, bottom: 0, right: 0 });
    await evaluate(send, `(() => {
      const badge = document.getElementById('profile-badge');
      if (badge) badge.textContent = '👤 Anil';
    })()`);
    await setViewport(send, home.width, home.height, home.mobile);
  }
  return `topbar: ${header.iss}, ${header.kp}, sun hidden=${sunHidden}, queue padded, bar scrolls, left pan ${panned} iss pan ${issPanned}`;
}

async function panTopbarFrom(send, elementId) {
  const start = await evaluate(send, `(() => {
    const bar = document.querySelector('.topbar');
    const chip = document.getElementById(${JSON.stringify(elementId)});
    if (!bar || !chip || chip.hidden) return null;
    bar.scrollLeft = 0;
    const barBox = bar.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    const x = Math.round(chipBox.left + Math.min(chipBox.width / 2, 22));
    const y = Math.round(chipBox.top + chipBox.height / 2);
    if (x >= barBox.left + barBox.width / 2) return { side: 'right', x, mid: barBox.left + barBox.width / 2 };
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit.closest(${JSON.stringify(`#${elementId}`)}) !== chip) return { hit: hit && (hit.id || hit.className), x, y };
    return { ok: true, x, y, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth };
  })()`);
  if (!start?.ok) throw new Error(`topbar pan start ${elementId} ${JSON.stringify(start)}`);
  if (start.scrollWidth <= start.clientWidth) return 0;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x - Math.round((140 * i) / steps),
      y: start.y,
      button: 'left',
      buttons: 1,
    });
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: start.x - 140,
    y: start.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  const moved = await evaluate(send, `document.querySelector('.topbar').scrollLeft`);
  if (!(moved > 40)) throw new Error(`${elementId} drag scrolled ${moved} from ${JSON.stringify(start)}`);
  await evaluate(send, `document.querySelector('.topbar').scrollLeft = 0`);
  return moved;
}

async function panTopbarFromLeft(send) {
  return {
    kp: await panTopbarFrom(send, 'kp-widget'),
    iss: await panTopbarFrom(send, 'iss-now'),
  };
}

async function assertMapChromeHidden(send) {
  const state = await evaluate(send, `(() => {
    const toolbar = document.querySelector('.map-toolbar');
    const toggle = document.getElementById('map-chrome-toggle');
    const banner = document.getElementById('status-banner');
    const tab = document.getElementById('tab-map');
    if (!toolbar || !toggle || !banner || !tab) return null;
    const toggleBox = toggle.getBoundingClientRect();
    return {
      hidden: document.body.classList.contains('map-chrome-hidden'),
      pane: document.getElementById('map-pane')?.classList.contains('map-chrome-hidden') === true,
      toolbar: getComputedStyle(toolbar).display,
      label: (toggle.textContent || '').trim(),
      expanded: toggle.getAttribute('aria-expanded'),
      toggleW: toggleBox.width,
      toggleH: toggleBox.height,
      banner: getComputedStyle(banner).display,
      tab: getComputedStyle(tab).display,
    };
  })()`);
  if (!state?.hidden || !state.pane || state.toolbar !== 'none' || state.label !== 'Controls' || state.expanded !== 'false') {
    throw new Error(`map chrome should be hidden ${JSON.stringify(state)}`);
  }
  if (state.toggleW < 44 || state.toggleH < 44) throw new Error(`controls button ${JSON.stringify(state)}`);
  if (state.banner === 'none' || state.tab === 'none') throw new Error(`shell hidden with the map chrome ${JSON.stringify(state)}`);
}

async function showMapChrome(send) {
  await click(send, '#map-chrome-toggle');
  await waitFor(
    send,
    `(() => {
      const toolbar = document.querySelector('.map-toolbar');
      const toggle = document.getElementById('map-chrome-toggle');
      if (!toolbar || !toggle) return null;
      if (document.body.classList.contains('map-chrome-hidden')) return null;
      if (getComputedStyle(toolbar).display === 'none') return null;
      if ((toggle.textContent || '').trim() !== 'Hide') return null;
      if (toggle.getAttribute('aria-expanded') !== 'true') return null;
      return { ok: true };
    })()`,
    'map chrome shown',
  );
}

async function revealMapChrome(send, evidenceDir, shotName) {
  const hidden = await evaluate(send, `document.body.classList.contains('map-chrome-hidden')`);
  if (!hidden) {
    await click(send, '#map-chrome-toggle');
    await waitFor(
      send,
      `document.body.classList.contains('map-chrome-hidden') && (document.getElementById('map-chrome-toggle')?.textContent || '').trim() === 'Controls' ? { ok: true } : null`,
      'map chrome hidden',
    );
  }
  await assertMapChromeHidden(send);
  if (shotName) await shot(send, evidenceDir, shotName);
  await showMapChrome(send);
}

async function waitChromeChoice(send, shown) {
  const expectShown = shown ? 'true' : 'false';
  await waitFor(
    send,
    `(() => {
      const toggle = document.getElementById('map-chrome-toggle');
      if (!toggle) return null;
      const hidden = document.body.classList.contains('map-chrome-hidden');
      const key = localStorage.getItem('opd-map-chrome');
      const label = (toggle.textContent || '').trim();
      if (${expectShown}) {
        if (hidden || label !== 'Hide' || key !== 'shown') return null;
      } else if (!hidden || label !== 'Controls' || key !== 'hidden') {
        return null;
      }
      return { ok: true };
    })()`,
    shown ? 'map chrome stored shown' : 'map chrome stored hidden',
    20000,
  );
}

async function proveMapChromeMemory(send) {
  await waitChromeChoice(send, true);
  await reloadSettled(send);
  await waitChromeChoice(send, true);
  await click(send, '#map-chrome-toggle');
  await waitChromeChoice(send, false);
  await reloadSettled(send);
  await waitChromeChoice(send, false);
  await showMapChrome(send);
  await waitFor(
    send,
    `window.__opdMap && window.__opdMap.getLayer && window.__opdMap.getLayer('iss-track-layer') ? { ok: true } : null`,
    'map after chrome reload',
    45000,
  );
}

async function ensureMapChromeShown(send) {
  const hidden = await evaluate(send, `document.body.classList.contains('map-chrome-hidden')`);
  if (hidden) await showMapChrome(send);
}

function topbarReachExpression() {
  return `(() => {
    const bar = document.querySelector('.topbar');
    const badge = document.getElementById('profile-badge');
    if (!bar || !badge) return null;
    badge.hidden = false;
    badge.textContent = '👤 anilsamoilenko-astro';
    const selectors = ['#tab-queue', '#tab-upcoming', '#tab-map', '#tab-iss', '#tab-profile', '#tab-log', '#kp-widget', '#profile-badge'];
    const targets = selectors
      .map((sel) => document.querySelector(sel))
      .filter((el) => el && !el.hidden && getComputedStyle(el).display !== 'none');
    const misses = [];
    for (const el of targets) {
      bar.scrollLeft = 0;
      let rect = el.getBoundingClientRect();
      const start = bar.getBoundingClientRect();
      if (rect.left < start.left - 1 || rect.right > start.right + 1) {
        bar.scrollLeft += rect.left - start.left;
        rect = el.getBoundingClientRect();
      }
      const current = bar.getBoundingClientRect();
      const fully = rect.width >= 44 && rect.height >= 44 && rect.left >= current.left - 1 && rect.right <= current.right + 1;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 22));
      const owner = hit && hit.closest(selectors.join(','));
      if (!fully || owner !== el) {
        misses.push({ id: el.id, fully, hit: owner ? owner.id : (hit && hit.className) || null, scroll: bar.scrollLeft });
      }
    }
    const nodes = [...bar.children].filter((el) => !el.hidden && getComputedStyle(el).display !== 'none');
    const overlaps = [];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i].getBoundingClientRect();
        const b = nodes[j].getBoundingClientRect();
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ix > 1 && iy > 1) overlaps.push([nodes[i].id || nodes[i].className, nodes[j].id || nodes[j].className]);
      }
    }
    if (misses.length || overlaps.length) return { misses, overlaps };
    const scrollWidth = bar.scrollWidth;
    const clientWidth = bar.clientWidth;
    bar.scrollLeft = 0;
    return { ok: true, scrollWidth, clientWidth };
  })()`;
}

async function tapTopbarControl(send, selector) {
  const point = await evaluate(send, `(() => {
    const bar = document.querySelector('.topbar');
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!bar || !el) return null;
    bar.scrollLeft = 0;
    let rect = el.getBoundingClientRect();
    const start = bar.getBoundingClientRect();
    if (rect.left < start.left - 1 || rect.right > start.right + 1) {
      bar.scrollLeft += rect.left - start.left;
      rect = el.getBoundingClientRect();
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit.closest(${JSON.stringify(selector)}) !== el) return { hit: hit && (hit.id || hit.className) };
    return { ok: true, x, y };
  })()`);
  if (!point?.ok) throw new Error(`topbar tap ${selector} hit ${JSON.stringify(point)}`);
  await mouseClick(send, point.x, point.y);
}

async function driveQueue(send, evidenceDir, meta, baseUrl) {
  await click(send, '#tab-queue');
  await waitFor(
    send,
    `(() => {
      const text = document.getElementById('cards')?.innerText || '';
      return text.includes(${JSON.stringify(meta.names.queue[0])}) && text.includes(${JSON.stringify(meta.names.queue[1])}) ? { ok: true } : null;
    })()`,
    'queue cards',
  );
  await shot(send, evidenceDir, 'queue');
  await click(send, '#cards .card-score');
  await waitFor(
    send,
    `(() => { const panel = document.querySelector('#cards .score-breakdown'); return panel && !panel.hidden ? { ok: true } : null; })()`,
    'score breakdown',
  );
  await shot(send, evidenceDir, 'queue-score');
  await click(send, '#sort-score-queue');
  const scoreActive = await evaluate(send, `document.getElementById('sort-score-queue').classList.contains('active')`);
  if (!scoreActive) throw new Error('score sort did not become active');
  await click(send, '#cards .btn-remind');
  await waitFor(send, `document.querySelector('#cards .btn-remind')?.getAttribute('aria-pressed') === 'true' ? { ok: true } : null`, 'remind on');
  await click(send, '#cards .btn-shoot');
  await waitFor(
    send,
    `(() => {
      const toast = document.getElementById('toast');
      const text = toast && !toast.hidden ? toast.textContent : '';
      return text.includes('Shoot logged') ? { ok: true, text } : null;
    })()`,
    'shoot toast',
  );
  await shot(send, evidenceDir, 'queue-shoot');
  await click(send, '#filter-mine-queue');
  await waitFor(
    send,
    `(() => {
      const empty = document.getElementById('empty');
      return empty && !empty.hidden && empty.textContent.includes('your targets') ? { ok: true } : null;
    })()`,
    'mine filter empty',
  );
  await shot(send, evidenceDir, 'queue-mine');
  await click(send, '#filter-all-queue');
  await click(send, '#cupola-toggle');
  await waitFor(
    send,
    `(() => {
      const pane = document.getElementById('cupola-pane');
      const text = document.getElementById('cupola-cards')?.innerText || '';
      return pane && !pane.hidden && text.includes(${JSON.stringify(meta.names.keepsake)}) ? { ok: true } : null;
    })()`,
    'keepsake pane',
  );
  await shot(send, evidenceDir, 'queue-keepsake');
  const deltaId = await hideNamed(send, '#cards', meta.names.queue[1]);
  await waitFor(
    send,
    `!document.getElementById('cards')?.innerText.includes(${JSON.stringify(meta.names.queue[1])}) ? { ok: true } : null`,
    'queue hide',
  );
  const stored = await removedCuratedIds(send);
  if (!stored.includes(deltaId)) throw new Error(`queue hide missing ${deltaId} in ${JSON.stringify(stored)}`);
  await waitServerRemoved(baseUrl, [deltaId], []);
  await shot(send, evidenceDir, 'queue-hide');
  return 'queue: cards, score, remind, shoot, mine filter, keepsake, hide';
}

function upcomingListExpression(mesa, ascent, { hidden }) {
  return `(() => {
    const text = document.getElementById('upcoming-cards')?.innerText || '';
    const ascentAt = text.indexOf(${JSON.stringify(ascent)});
    const mesaAt = text.indexOf(${JSON.stringify(mesa)});
    if (ascentAt < 0) return null;
    if (${hidden ? 'true' : 'false'}) {
      if (mesaAt >= 0) return null;
    } else if (mesaAt < 0 || ascentAt > mesaAt) return null;
    return { ok: true };
  })()`;
}

async function driveUpcoming(send, evidenceDir, meta, baseUrl, home) {
  const mesa = meta.names.upcoming[0];
  const ascent = meta.names.launch;
  await click(send, '#tab-upcoming');
  await waitFor(send, upcomingListExpression(mesa, ascent, { hidden: false }), 'upcoming card');
  await shot(send, evidenceDir, 'upcoming');
  await click(send, '#sort-score-upcoming');
  const active = await evaluate(send, `document.getElementById('sort-score-upcoming').classList.contains('active')`);
  if (!active) throw new Error('upcoming score sort did not become active');
  const mesaId = await hideNamed(send, '#upcoming-cards', mesa);
  await waitFor(send, upcomingListExpression(mesa, ascent, { hidden: true }), 'upcoming hide');
  await shot(send, evidenceDir, 'upcoming-hidden');
  await click(send, '#sort-time-upcoming');
  await waitFor(send, upcomingListExpression(mesa, ascent, { hidden: true }), 'upcoming hide after re-render');
  const stored = await removedCuratedIds(send);
  if (!stored.includes(mesaId)) throw new Error(`upcoming hide missing ${mesaId} in ${JSON.stringify(stored)}`);
  await reloadSettled(send);
  await click(send, '#tab-upcoming');
  await waitFor(send, upcomingListExpression(mesa, ascent, { hidden: true }), 'upcoming hide after reload');
  const storedAfter = await removedCuratedIds(send);
  if (!storedAfter.includes(mesaId)) throw new Error(`reload dropped ${mesaId} from ${JSON.stringify(storedAfter)}`);
  await shot(send, evidenceDir, 'upcoming-reloaded');
  const server = await waitServerRemoved(baseUrl, [mesaId], []);
  await expectFreshHide(baseUrl, home, {
    id: mesaId,
    name: mesa,
    updatedAt: server.removedCuratedUpdatedAt,
    visible: false,
  });
  return `upcoming: ${ascent} above ${mesa}, score sort, hide persisted ${mesaId}, fresh profile hid it`;
}

async function driveMap(send, evidenceDir, meta, baseUrl) {
  await click(send, '#tab-map');
  const ready = await waitFor(
    send,
    `(() => {
      const map = window.__opdMap;
      const marker = document.querySelector('.iss-marker');
      const legend = document.querySelector('.map-legend');
      const badge = document.querySelector('.map-imagery-date');
      const status = {
        map: !!map,
        loaded: !!(map && map.loaded && map.loaded()),
        marker: !!marker,
        legend: !!legend,
        badge: badge ? badge.textContent : null,
        track: !!(map && map.getLayer && map.getLayer('iss-track-layer')),
        view: document.getElementById('view')?.className,
        logs: (window.__opdLogs || []).slice(-8),
        mapHtml: (document.getElementById('map')?.innerHTML || '').slice(0, 180),
      };
      if (status.map && status.marker && status.legend && status.badge && String(status.badge).trim() && status.track) {
        return { ok: true, badge: status.badge, legend: legend.innerText };
      }
      return status;
    })()`,
    'map ready',
    45000,
  );
  if (!String(ready.legend || '').includes("Anil's targets")) {
    throw new Error(`legend missing Anil's targets: ${ready.legend}`);
  }
  await revealMapChrome(send, evidenceDir, 'map-chrome-hidden');
  await proveMapChromeMemory(send);
  const anil = await evaluate(send, `(() => {
    const node = document.querySelector('.map-legend-anil');
    const swatch = node ? getComputedStyle(node).backgroundColor : '';
    const paint = window.__opdMap.getPaintProperty('targets-layer', 'circle-color');
    return { swatch, paint: JSON.stringify(paint) };
  })()`);
  if (anil.swatch !== 'rgb(139, 147, 255)') throw new Error(`anil swatch ${anil.swatch}`);
  if (!String(anil.paint).includes('anils-targets') || !String(anil.paint).includes('#8b93ff')) {
    throw new Error(`anil paint ${anil.paint}`);
  }
  await sleep(1200);
  await shot(send, evidenceDir, 'map-globe');
  await shot(send, evidenceDir, 'map-legend');
  await shot(send, evidenceDir, 'map-imagery-date');
  await dismissShotlist(send);
  const collapsed = await waitFor(
    send,
    `(() => {
      const node = document.querySelector('.maplibregl-ctrl-attrib');
      const button = document.querySelector('.maplibregl-ctrl-attrib-button');
      const help = document.querySelector('.help-fab');
      if (!node || !button || !help) return null;
      if (node.classList.contains('maplibregl-compact-show')) return null;
      const box = button.getBoundingClientRect();
      const helpBox = help.getBoundingClientRect();
      if (helpBox.width < 40 || box.width < 40 || box.width > 48 || box.height < 40 || box.height > 48) return null;
      if (helpBox.bottom > box.top + 8) return null;
      const legend = document.querySelector('.map-legend')?.getBoundingClientRect();
      return legend ? { ok: true, legendBottom: legend.bottom } : null;
    })()`,
    'credits collapsed',
    10000,
  );
  await shot(send, evidenceDir, 'map-attribution-collapsed');
  await click(send, '.maplibregl-ctrl-attrib-button');
  await waitFor(
    send,
    `(() => {
      const node = document.querySelector('.maplibregl-ctrl-attrib');
      const help = document.querySelector('.help-fab')?.getBoundingClientRect();
      const legend = document.querySelector('.map-legend')?.getBoundingClientRect();
      if (!node || !help || !legend) return null;
      if (!node.classList.contains('maplibregl-compact-show')) return null;
      const text = node.textContent || '';
      if (!/OpenStreetMap|CARTO|NASA|Earthdata/i.test(text)) return null;
      if (node.getBoundingClientRect().width < 200) return null;
      if (help.bottom > node.getBoundingClientRect().top + 8) return null;
      if (legend.bottom >= ${collapsed.legendBottom} - 4) return null;
      return { ok: true, text: text.slice(0, 200) };
    })()`,
    'credits expanded',
    10000,
  );
  await shot(send, evidenceDir, 'map-attribution');
  const before = await evaluate(send, `document.getElementById('time-slider-readout').textContent`);
  await click(send, '#time-fwd-45');
  await waitFor(
    send,
    `(() => {
      const readout = document.getElementById('time-slider-readout')?.textContent || '';
      return readout && readout !== ${JSON.stringify(before)} ? { ok: true, readout } : null;
    })()`,
    'time scrub',
  );
  await shot(send, evidenceDir, 'map-time');
  await click(send, '#time-now');
  await waitFor(
    send,
    `document.getElementById('time-slider-readout')?.textContent.trim() === 'Now' ? { ok: true } : null`,
    'time now',
  );
  await click(send, '#toggle-ir');
  await waitFor(send, `document.getElementById('toggle-ir').classList.contains('active') ? { ok: true } : null`, 'IR on');
  await click(send, '#toggle-night-lights');
  await waitFor(send, `document.getElementById('toggle-night-lights').classList.contains('active') ? { ok: true } : null`, 'night lights on');
  await click(send, '#toggle-labels');
  const labelsOn = await evaluate(send, `document.getElementById('toggle-labels').classList.contains('active')`);
  if (labelsOn) throw new Error('labels toggle did not turn off');
  await click(send, '#toggle-multi-orbit');
  await waitFor(send, `document.getElementById('toggle-multi-orbit').classList.contains('active') ? { ok: true } : null`, 'multi orbit on');
  await click(send, '#bearing-iss');
  await waitFor(send, `(() => {
    const button = document.getElementById('bearing-iss');
    if (!button || !button.classList.contains('active')) return null;
    if (button.getAttribute('title') !== 'ISS up (default). Rotate so the direction of travel points up') return null;
    return { ok: true };
  })()`, 'iss up');
  await click(send, '#toggle-follow-iss');
  await waitFor(send, `document.getElementById('toggle-follow-iss').getAttribute('aria-pressed') === 'false' ? { ok: true } : null`, 'follow released');
  await shot(send, evidenceDir, 'map-tool-rail');
  await click(send, '#toggle-satellite-picker');
  await waitFor(
    send,
    `(() => {
      const panel = document.getElementById('satellite-picker-panel');
      const text = document.getElementById('satellite-picker-list')?.innerText || '';
      return panel && !panel.hidden && text.includes('Tiangong') && text.includes('Hubble') ? { ok: true } : null;
    })()`,
    'satellite picker',
  );
  await shot(send, evidenceDir, 'map-satellites');
  await click(send, '#toggle-satellite-picker');
  await frameLngLat(send, meta.reef.lon, meta.reef.lat, 4);
  const reefPoint = await pointForLngLat(send, meta.reef.lon, meta.reef.lat);
  if (!reefPoint?.ok) throw new Error('could not project Verify Reef');
  await mouseClick(send, reefPoint.x, reefPoint.y);
  await waitFor(
    send,
    `document.querySelector('.maplibregl-popup')?.innerText.includes('Verify Reef') ? { ok: true } : null`,
    'target popup',
    10000,
  );
  await shot(send, evidenceDir, 'map-target-popup');
  const drop = await pointForLngLat(send, meta.delta.lon, meta.delta.lat);
  await mouseClick(send, drop.x, drop.y, 'right');
  await waitFor(
    send,
    `[...document.querySelectorAll('.maplibregl-popup')].some((node) => (node.innerText || '').includes('Closest')) ? { ok: true } : null`,
    'pin drop',
    10000,
  );
  await shot(send, evidenceDir, 'map-pin-drop');
  await evaluate(send, `[...document.querySelectorAll('.maplibregl-popup-close-button')].forEach((button) => button.click())`);
  await waitFor(send, `document.querySelector('.maplibregl-popup') ? null : { ok: true }`, 'popups closed before launch', 5000);
  await click(send, '#filter-launches-map');
  await waitFor(send, `document.getElementById('filter-launches-map').getAttribute('aria-pressed') === 'true' ? { ok: true } : null`, 'launch mode');
  const briefName = await evaluate(send, `!!document.querySelector('.map-launch-brief .launch-name')`);
  if (briefName) await click(send, '.map-launch-brief .launch-name');
  else {
    await frameLngLat(send, meta.pad.lon, meta.pad.lat, 4);
    const padPoint = await pointForLngLat(send, meta.pad.lon, meta.pad.lat);
    await mouseClick(send, padPoint.x, padPoint.y);
  }
  await waitFor(
    send,
    `document.querySelector('.launch-dialog')?.innerText.includes(${JSON.stringify(meta.names.launch)}) ? { ok: true } : null`,
    'launch dialog',
    10000,
  );
  await shot(send, evidenceDir, 'map-launch');
  await click(send, '.launch-dialog .btn');
  await click(send, '#filter-launches-map');
  await waitFor(
    send,
    `document.getElementById('filter-launches-map').getAttribute('aria-pressed') === 'false' ? { ok: true } : null`,
    'launch mode off',
  );
  await waitFor(
    send,
    `(() => {
      const source = window.__opdMap && window.__opdMap.getSource('targets');
      const raw = source && source._data;
      const serialized = source && source.serialize ? source.serialize().data : null;
      const data = (raw && raw.geojson) || (raw && raw.features ? raw : null) || (serialized && serialized.geojson) || serialized;
      const ids = (data && data.features ? data.features : []).map((feature) => feature.properties && feature.properties.target_id);
      return ids.includes('verify-reef') ? { ok: true } : null;
    })()`,
    'reef pin before hide',
  );
  await click(send, '#tab-queue');
  await hideNamed(send, '#cards', meta.names.queue[0]);
  await click(send, '#tab-map');
  await waitFor(
    send,
    `(() => {
      const source = window.__opdMap && window.__opdMap.getSource('targets');
      const raw = source && source._data;
      const serialized = source && source.serialize ? source.serialize().data : null;
      const data = (raw && raw.geojson) || (raw && raw.features ? raw : null) || (serialized && serialized.geojson) || serialized;
      const ids = (data && data.features ? data.features : []).map((feature) => feature.properties && feature.properties.target_id);
      return ids.includes('verify-reef') ? null : { ok: true, ids };
    })()`,
    'reef pin hidden',
    10000,
  );
  await waitServerRemoved(baseUrl, ['verify-reef'], []);
  await shot(send, evidenceDir, 'map-pin-hidden');
  return 'map: globe, legend, imagery, attribution, time, tool rail, picker, target popup, pin drop, launch dialog, hidden pin, chrome persisted';
}

const UNAVAILABLE_LEGEND = {
  aged_out: 'Starship: public orbit expired',
  lookup_failed: 'Starship: orbit lookup failed',
  missing: 'Starship: no public orbit yet',
  unavailable: 'Starship: no public orbit yet',
};

async function driveTracked(send, evidenceDir, meta, home) {
  await setViewport(send, home.width, home.height, home.mobile);
  await click(send, '#tab-map');
  const ready = await waitFor(
    send,
    `(() => {
      const map = window.__opdMap;
      const iss = document.querySelector('.iss-marker');
      const legend = document.getElementById('tracked-legend-text')?.textContent || '';
      const track = !!(map && map.getLayer && map.getLayer('iss-track-layer'));
      if (!map || !iss || !track || !legend.includes('Starship')) return null;
      return { ok: true, legend };
    })()`,
    'tracked legend',
    45000,
  );
  await ensureMapChromeShown(send);
  if (meta.trackedMode === 'elements') {
    if (!meta.standIn || !ready.legend.includes(meta.standIn)) {
      throw new Error(`stand-in legend ${ready.legend} expected ${meta.standIn}`);
    }
    const placed = await waitFor(
      send,
      `(() => {
        const marker = document.querySelector('.tracked-marker');
        const label = marker?.querySelector('.tracked-marker-label')?.textContent;
        const map = window.__opdMap;
        const layer = map && map.getLayer && map.getLayer('sat-track-layer-starship');
        const source = map && map.getSource && map.getSource('sat-track-starship');
        const raw = source && source._data;
        const serialized = source && source.serialize ? source.serialize().data : null;
        const data = (raw && raw.geojson) || (raw && raw.features ? raw : null) || (serialized && serialized.geojson) || serialized;
        const line = data && data.features && data.features[0] && data.features[0].geometry;
        const coord = line && line.coordinates && line.coordinates[0];
        if (!marker || label !== 'Starship' || !layer || !coord) return null;
        return { ok: true, lng: coord[0], lat: coord[1], title: marker.title };
      })()`,
      'starship marker and track',
      20000,
    );
    const follow = await evaluate(send, `document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed')`);
    if (follow !== 'false') {
      await click(send, '#toggle-follow-iss');
      await waitFor(
        send,
        `document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed') === 'false' ? { ok: true } : null`,
        'tracked follow off',
      );
    }
    await click(send, '#bearing-north');
    await sleep(700);
    const sizes = [
      ['desktop', 1400, 900, false],
      ['ipad', 1024, 768, true],
      ['iphone', 390, 844, false],
    ];
    for (const [name, width, height, mobile] of sizes) {
      await setViewport(send, width, height, mobile);
      await sleep(400);
      const zoom = name === 'iphone' ? 2.2 : 2.6;
      await evaluate(send, `window.__opdMap.resize(); window.__opdMap.jumpTo({ center: [${placed.lng}, ${placed.lat}], zoom: ${zoom} }); true`);
      await sleep(400);
      await evaluate(send, `(() => {
        const box = document.querySelector('.tracked-marker')?.getBoundingClientRect();
        if (!box) return false;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        window.__opdMap.panBy([cx - innerWidth / 2, cy - innerHeight / 2], { duration: 0 });
        return true;
      })()`);
      await sleep(400);
      const framed = await evaluate(send, `(() => {
        const box = document.querySelector('.tracked-marker')?.getBoundingClientRect();
        if (!box || box.width < 8) return null;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        return {
          ok: cx > 48 && cy > 48 && cx < innerWidth - 48 && cy < innerHeight - 48,
          cx, cy,
        };
      })()`);
      await shot(send, evidenceDir, `tracked-${name}`);
      if (!framed || !framed.ok) throw new Error(`starship marker off-screen on ${name}: ${JSON.stringify(framed)}`);
    }
    await setViewport(send, home.width, home.height, home.mobile);
    return `tracked: marker and ground track for ${meta.standIn} on desktop, iPad, and iPhone`;
  }
  const sentence = UNAVAILABLE_LEGEND[meta.trackedMode] || UNAVAILABLE_LEGEND.unavailable;
  if (meta.trackedMode === 'missing') {
    const published = await evaluate(send, `fetch('/manifest.json').then((response) => response.json()).then((body) => Boolean(body.artifacts && body.artifacts.tracked))`);
    if (published) throw new Error('missing tracked mode still published a tracked artifact');
  }
  if (!ready.legend.includes(sentence)) {
    throw new Error(`${meta.trackedMode || 'unavailable'} legend ${ready.legend}`);
  }
  const marker = await evaluate(send, `document.querySelector('.tracked-marker') ? 'present' : 'absent'`);
  if (marker !== 'absent') throw new Error(`${meta.trackedMode || 'unavailable'} state still drew a marker`);
  const layer = await evaluate(send, `window.__opdMap?.getLayer('sat-track-layer-starship') ? 'present' : 'absent'`);
  if (layer !== 'absent') throw new Error(`${meta.trackedMode || 'unavailable'} state still drew a starship track`);
  if ((await evaluate(send, `document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed')`)) !== 'false') {
    await click(send, '#toggle-follow-iss');
    await waitFor(
      send,
      `document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed') === 'false' ? { ok: true } : null`,
      'tracked follow off',
    );
  }
  await click(send, '#toggle-follow-iss');
  await waitFor(
    send,
    `document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed') === 'true' ? { ok: true } : null`,
    'tracked follow on',
  );
  await waitFor(
    send,
    `(() => {
      const box = document.querySelector('.iss-marker')?.getBoundingClientRect();
      if (!box) return { missing: true };
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      if (cx < 40 || cy < 40 || cx > innerWidth - 40 || cy > innerHeight - 80) {
        const map = window.__opdMap;
        const center = map.getCenter();
        const canvas = map.getCanvas().getBoundingClientRect();
        const marker = document.querySelector('.iss-marker');
        return {
          cx, cy, w: innerWidth, h: innerHeight,
          lng: center.lng, lat: center.lat, zoom: map.getZoom(),
          canvas: { x: canvas.x, y: canvas.y, w: canvas.width, h: canvas.height },
          transform: marker.style.transform,
        };
      }
      return { ok: true };
    })()`,
    'iss marker framed',
    10000,
  );
  const shotName = {
    aged_out: 'tracked-aged-out',
    missing: 'tracked-missing',
    lookup_failed: 'tracked-lookup-failed',
  }[meta.trackedMode] || 'tracked-no-orbit';
  await shot(send, evidenceDir, shotName);
  if (meta.trackedMode === 'aged_out') {
    return 'tracked: public orbit expired, no marker, ISS marker and track still up';
  }
  if (meta.trackedMode === 'lookup_failed') {
    return 'tracked: orbit lookup failed, no marker, ISS marker and track still up';
  }
  if (meta.trackedMode === 'missing') {
    return 'tracked: missing artifact falls back to no public orbit yet, ISS marker and track still up';
  }
  return 'tracked: Starship no public orbit yet, ISS marker and track still up';
}

async function driveIss(send, evidenceDir, viewport) {
  await dismissShotlist(send);
  await click(send, '#tab-iss');
  const horizon = await waitFor(
    send,
    `(() => {
      const view = document.getElementById('view');
      const pressed = document.querySelector('[data-iss-preset="horizon"]');
      const text = document.querySelector('[data-iss-status]')?.textContent || '';
      if (!view || view.className !== 'view-iss') return null;
      if (!pressed || pressed.getAttribute('aria-pressed') !== 'true') return null;
      if (!text.includes('Horizon locked')) return null;
      if (!text.includes('14 mm')) return null;
      if (document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') !== 'false') return null;
      const body = document.querySelector('[data-iss-telemetry-body]');
      if (!body?.hasAttribute('hidden')) return null;
      const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
      const card = document.querySelector('[data-iss-card]')?.getBoundingClientRect();
      if (!frame || !card || frame.width < 40 || frame.height < 40) return null;
      const covers = card.left < frame.right - 1 && card.right > frame.left + 1 && card.top < frame.bottom - 1 && card.bottom > frame.top + 1;
      if (covers) return null;
      const buttons = document.querySelectorAll('[data-iss-scene] .maplibregl-ctrl-attrib-button');
      const attrib = document.querySelector('[data-iss-scene] .maplibregl-ctrl-attrib');
      if (buttons.length !== 1 || !attrib || attrib.classList.contains('maplibregl-compact-show')) return null;
      const layers = document.querySelector('[data-iss-place-layers]')?.getAttribute('data-iss-place-layers') || '';
      if (!layers.includes('country') || !layers.includes('city') || !layers.includes('water')) return null;
      const cupola = document.querySelector('[data-iss-cupola]');
      if (!cupola) return null;
      const side = [...cupola.querySelectorAll('option')].filter((option) => /^Window [1-6]/.test(option.textContent || ''));
      const window7 = cupola.querySelector('option[value="7"]');
      if (side.length !== 6 || side.some((option) => option.disabled || /Coming soon/.test(option.textContent || ''))) return null;
      if (!window7 || window7.disabled) return null;
      if (!/Port/.test(side[0].textContent || '') || !/Starboard/.test(side[3].textContent || '')) return null;
      if (window7.textContent !== 'Window 7 · Nadir') return null;
      const hint = document.querySelector('[data-iss-hint]');
      if ((hint?.textContent || '') !== 'Pinch or scroll the field · double-tap to reset') return null;
      if (document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('title') !== 'Horizon aim') return null;
      if (document.querySelector('[data-iss-preset="nadir"]')?.getAttribute('title') !== 'Aim straight down') return null;
      if (cupola.getAttribute('title') !== 'Window field of view') return null;
      if (!/double-tap/i.test(document.querySelector('[data-iss-reset]')?.getAttribute('title') || '')) return null;
      const port = document.querySelector('[data-iss-port]');
      const starboard = document.querySelector('[data-iss-starboard]');
      if (port?.textContent !== 'Port' || starboard?.textContent !== 'Starboard') return null;
      const portBox = port.getBoundingClientRect();
      const starboardBox = starboard.getBoundingClientRect();
      if (portBox.width < 4 || starboardBox.width < 4) return null;
      if (starboardBox.right > frame.left + 2 || portBox.left < frame.right - 2) return null;
      const roll = window.__opdIss?.getRoll?.();
      if (typeof roll !== 'number' || Math.abs((((roll % 360) + 360) % 360) - 180) > 0.5) return null;
      const globeMid = frame.top + frame.height / 2;
      const starboardHitsGlobe = starboardBox.bottom > frame.top + 8 && starboardBox.top < frame.bottom - 8 && starboardBox.right > frame.left + 8;
      const portHitsGlobe = portBox.bottom > frame.top + 8 && portBox.top < frame.bottom - 8 && portBox.left < frame.right - 8;
      if (portHitsGlobe || starboardHitsGlobe) return null;
      if (Math.abs((portBox.top + portBox.height / 2) - globeMid) > frame.height / 2) return null;
      const hostBox = document.getElementById('iss-host')?.getBoundingClientRect();
      const scene = document.querySelector('[data-iss-scene]');
      if (!hostBox || !scene) return null;
      if (scene.scrollHeight > scene.clientHeight + 2 || scene.scrollWidth > scene.clientWidth + 2) return null;
      const within = (box) => box.left >= hostBox.left - 1 && box.right <= hostBox.right + 1 && box.top >= hostBox.top - 1 && box.bottom <= hostBox.bottom + 1;
      if (!within(frame) || !within(card) || !within(portBox) || !within(starboardBox)) return null;
      const places = [...document.querySelectorAll('.iss-place')].map((node) => node.getBoundingClientRect()).filter((box) => box.width > 1 && box.height > 1);
      for (let i = 0; i < places.length; i += 1) {
        for (let j = i + 1; j < places.length; j += 1) {
          const a = places[i];
          const b = places[j];
          if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) return null;
        }
      }
      return { ok: true, text };
    })()`,
    'iss horizon',
    45000,
  );
  await shot(send, evidenceDir, 'iss-horizon');
  await sleep(1100);
  await waitFor(
    send,
    `(() => {
      const hostBox = document.getElementById('iss-host')?.getBoundingClientRect();
      const scene = document.querySelector('[data-iss-scene]');
      const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
      const card = document.querySelector('[data-iss-card]')?.getBoundingClientRect();
      const port = document.querySelector('[data-iss-port]')?.getBoundingClientRect();
      const starboard = document.querySelector('[data-iss-starboard]')?.getBoundingClientRect();
      if (!hostBox || !scene || !frame || !card || !port || !starboard) return null;
      if (scene.scrollHeight > scene.clientHeight + 2 || scene.scrollWidth > scene.clientWidth + 2) return null;
      const within = (box) => box.width > 1 && box.height > 1 && box.left >= hostBox.left - 1 && box.right <= hostBox.right + 1 && box.top >= hostBox.top - 1 && box.bottom <= hostBox.bottom + 1;
      if (!within(frame) || !within(card) || !within(port) || !within(starboard)) return null;
      const places = [...document.querySelectorAll('.iss-place')].map((node) => node.getBoundingClientRect()).filter((box) => box.width > 1 && box.height > 1);
      if (places.length < 1) return null;
      for (let i = 0; i < places.length; i += 1) {
        for (let j = i + 1; j < places.length; j += 1) {
          const a = places[i];
          const b = places[j];
          if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) return null;
        }
      }
      return { ok: true, labels: places.length };
    })()`,
    'iss contained after render ticks',
    10000,
  );
  await click(send, '[data-iss-telemetry]');
  await waitFor(
    send,
    `(() => {
      const toggle = document.querySelector('[data-iss-telemetry]');
      const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
      const card = document.querySelector('[data-iss-card]')?.getBoundingClientRect();
      if (toggle?.getAttribute('aria-expanded') !== 'true' || !frame || !card) return null;
      const covers = card.left < frame.right - 1 && card.right > frame.left + 1 && card.top < frame.bottom - 1 && card.bottom > frame.top + 1;
      if (covers) return null;
      const hostBox = document.getElementById('iss-host')?.getBoundingClientRect();
      const scene = document.querySelector('[data-iss-scene]');
      const port = document.querySelector('[data-iss-port]')?.getBoundingClientRect();
      const starboard = document.querySelector('[data-iss-starboard]')?.getBoundingClientRect();
      if (!hostBox || !scene || !port || !starboard) return null;
      if (scene.scrollHeight > scene.clientHeight + 2 || scene.scrollWidth > scene.clientWidth + 2) return null;
      const within = (box) => box.left >= hostBox.left - 1 && box.right <= hostBox.right + 1 && box.top >= hostBox.top - 1 && box.bottom <= hostBox.bottom + 1;
      if (!within(frame) || !within(card) || !within(port) || !within(starboard)) return null;
      return { ok: true };
    })()`,
    'iss telemetry open stays off the earth',
    10000,
  );
  await shot(send, evidenceDir, 'iss-telemetry-open');
  await click(send, '[data-iss-telemetry]');
  await waitFor(
    send,
    `document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') === 'false' ? { ok: true } : null`,
    'iss telemetry collapsed again',
    10000,
  );
  const zoomed = await proveIssOpticalFov(send, evidenceDir);
  const pan = await proveIssPan(send, evidenceDir, zoomed);
  await proveIssLandscape(send, evidenceDir);
  const fovAfterLandscape = await evaluate(send, `window.__opdIss?.getVerticalFieldOfView?.()`);
  if (typeof fovAfterLandscape !== 'number' || Math.abs(fovAfterLandscape - zoomed) > 0.5) {
    throw new Error(`iss fov changed across landscape telemetry ${zoomed} -> ${fovAfterLandscape}`);
  }
  await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  await proveIssPanSession(send, evidenceDir, pan);
  await proveIssWindows(send, evidenceDir);
  await proveIssWindowSession(send, evidenceDir);
  await proveIssAimReset(send, evidenceDir);
  await click(send, '[data-iss-preset="nadir"]');
  await waitFor(
    send,
    `(() => {
      const pressed = document.querySelector('[data-iss-preset="nadir"]');
      const text = document.querySelector('[data-iss-status]')?.textContent || '';
      if (!pressed || pressed.getAttribute('aria-pressed') !== 'true') return null;
      if (!text.includes('Nadir locked')) return null;
      const chip = document.querySelector('[data-iss-window]');
      if (!chip || !chip.hidden) return null;
      const map = window.__opdIss;
      if (!map?.getRoll || !map.project || !map.getCenter || !map.getBearing) return null;
      const roll = ((map.getRoll() % 360) + 360) % 360;
      if (Math.abs(roll - 180) > 0.5) return null;
      const center = map.getCenter();
      const bearing = map.getBearing() * Math.PI / 180;
      const lat = center.lat + Math.cos(bearing) * 0.35;
      const lng = center.lng + (Math.sin(bearing) * 0.35) / Math.max(0.2, Math.cos(center.lat * Math.PI / 180));
      const here = map.project(center);
      const ahead = map.project([lng, lat]);
      if (!(ahead.y > here.y + 4)) return null;
      const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
      const port = document.querySelector('[data-iss-port]')?.getBoundingClientRect();
      const starboard = document.querySelector('[data-iss-starboard]')?.getBoundingClientRect();
      if (!frame || !port || !starboard) return null;
      if (starboard.right > frame.left + 2 || port.left < frame.right - 2) return null;
      return { ok: true, roll, aheadY: ahead.y, hereY: here.y };
    })()`,
    'iss straight down',
    20000,
  );
  await shot(send, evidenceDir, 'iss-nadir');
  await click(send, '#tab-map');
  await waitFor(
    send,
    `document.getElementById('view')?.className === 'view-map' && !document.querySelector('[data-iss-scene]') ? { ok: true } : null`,
    'map after iss',
    20000,
  );
  await click(send, '#tab-queue');
  await waitFor(
    send,
    `document.getElementById('view')?.className === 'view-queue' ? { ok: true } : null`,
    'queue after iss',
  );
  await click(send, '#tab-iss');
  await waitFor(
    send,
    `document.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-iss-scene]') ? { ok: true } : null`,
    'iss remembers straight down',
    45000,
  );
  await shot(send, evidenceDir, 'iss-return');
  await proveIssAimReload(send, evidenceDir);
  return `iss: horizon then straight down, map and queue still open, session kept nadir, landscape telemetry held, fov ${zoomed.toFixed(1)}°, fov live, pan held, pan kept, fov held, windows 1-6 aimed, window kept, window field, aim reset, double tap, aim restored, storage cleared, keyboard aim, cupola keys (${String(horizon.text).slice(0, 80)})`;
}

async function proveIssOpticalFov(send, evidenceDir) {
  const before = await evaluate(send, `(() => {
    const map = window.__opdIss;
    const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
    if (!map?.getVerticalFieldOfView || !map.getZoom || !map.getRoll || !frame) return null;
    return {
      x: frame.left + frame.width / 2,
      y: frame.top + frame.height / 2,
      fov: map.getVerticalFieldOfView(),
      zoom: map.getZoom(),
      roll: ((map.getRoll() % 360) + 360) % 360,
    };
  })()`);
  if (!before) throw new Error('iss fov baseline missing');
  await shot(send, evidenceDir, 'iss-fov-before');
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: before.x,
    y: before.y,
    deltaX: 0,
    deltaY: -480,
  });
  const live = await evaluate(send, `(() => {
    const node = document.querySelector('[data-iss-fov]');
    if (!node || node.getAttribute('data-iss-fov-state') !== 'live') return null;
    const shown = Number.parseFloat(node.textContent || '');
    if (!Number.isFinite(shown)) return null;
    return { ok: true, shown };
  })()`);
  if (!live) throw new Error('iss fov readout missing');
  await shot(send, evidenceDir, 'iss-fov-live');
  const narrowed = await waitFor(
    send,
    `(() => {
      const map = window.__opdIss;
      if (!map?.getVerticalFieldOfView || !map.getZoom || !map.getRoll) return null;
      const fov = map.getVerticalFieldOfView();
      const zoom = map.getZoom();
      const roll = ((map.getRoll() % 360) + 360) % 360;
      if (!(fov < ${before.fov} - 4)) return null;
      if (!(zoom > ${before.zoom} + 0.2)) return null;
      if (Math.abs(roll - 180) > 0.5) return null;
      return { ok: true, fov, zoom, roll };
    })()`,
    'iss optical fov narrowed',
    10000,
  );
  await sleep(1200);
  const held = await evaluate(send, `(() => {
    const map = window.__opdIss;
    if (!map?.getVerticalFieldOfView || !map.getZoom || !map.getRoll) return null;
    return {
      fov: map.getVerticalFieldOfView(),
      zoom: map.getZoom(),
      roll: ((map.getRoll() % 360) + 360) % 360,
    };
  })()`);
  if (!held || !(held.fov < before.fov - 4) || Math.abs(held.fov - narrowed.fov) > 0.5) {
    throw new Error(`iss fov reset after tick ${JSON.stringify({ before, narrowed, held })}`);
  }
  if (Math.abs(held.roll - 180) > 0.5) throw new Error(`iss roll after fov ${held.roll}`);
  if (Math.abs(live.shown - held.fov) > 0.2) {
    throw new Error(`iss fov readout ${live.shown} vs field ${held.fov}`);
  }
  await waitFor(
    send,
    `document.querySelector('[data-iss-fov]')?.textContent ? null : { ok: true }`,
    'iss fov readout idle',
    3000,
  );
  await shot(send, evidenceDir, 'iss-fov-after');
  return held.fov;
}

async function proveIssPan(send, evidenceDir, fovDeg) {
  const start = await evaluate(send, `(() => {
    const map = window.__opdIss;
    const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
    if (!map?.getCenter || !map.getVerticalFieldOfView || !frame || frame.width < 40) return null;
    const center = map.getCenter();
    return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2, dx: Math.max(36, frame.width * 0.22), lat: center.lat, lng: center.lng, fov: map.getVerticalFieldOfView() };
  })()`);
  if (!start) throw new Error('iss pan baseline missing');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x - start.dx, y: start.y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x - start.dx, y: start.y, button: 'left', buttons: 0, clickCount: 1 });
  const panned = await waitFor(
    send,
    `(() => {
      const map = window.__opdIss;
      if (!map?.getCenter || !map.getVerticalFieldOfView || !map.getRoll) return null;
      const center = map.getCenter();
      const fov = map.getVerticalFieldOfView();
      const roll = ((map.getRoll() % 360) + 360) % 360;
      const shift = Math.abs(center.lat - ${start.lat}) + Math.abs(center.lng - ${start.lng});
      if (shift < 0.4) return null;
      if (Math.abs(fov - ${fovDeg}) > 0.5) return null;
      if (Math.abs(roll - 180) > 0.5) return null;
      return { ok: true, lat: center.lat, lng: center.lng, fov, shift };
    })()`,
    'iss pan',
    10000,
  );
  await shot(send, evidenceDir, 'iss-pan');
  await sleep(1200);
  const held = await evaluate(send, `(() => {
    const map = window.__opdIss;
    if (!map?.getCenter || !map.getVerticalFieldOfView || !map.getRoll) return null;
    const center = map.getCenter();
    const fov = map.getVerticalFieldOfView();
    const roll = ((map.getRoll() % 360) + 360) % 360;
    return {
      fromStart: Math.abs(center.lat - ${start.lat}) + Math.abs(center.lng - ${start.lng}),
      fromPan: Math.abs(center.lat - ${panned.lat}) + Math.abs(center.lng - ${panned.lng}),
      fov,
      roll,
    };
  })()`);
  if (!held || held.fromStart < 0.3 || Math.abs(held.fov - fovDeg) > 0.5 || Math.abs(held.roll - 180) > 0.5) {
    throw new Error(`iss pan yanked ${JSON.stringify(held)}`);
  }
  if (held.fromPan > held.fromStart) throw new Error(`iss pan jumped farther than the drag ${JSON.stringify(held)}`);
  return { lat: start.lat, lng: start.lng, panLat: panned.lat, panLng: panned.lng, fov: held.fov };
}

async function proveIssPanSession(send, evidenceDir, pan) {
  await click(send, '#tab-map');
  await waitFor(
    send,
    `document.getElementById('view')?.className === 'view-map' && !document.querySelector('[data-iss-scene]') ? { ok: true } : null`,
    'map before pan return',
    20000,
  );
  await click(send, '#tab-iss');
  await waitFor(
    send,
    `(() => {
      const pressed = document.querySelector('[data-iss-preset="horizon"]');
      if (pressed?.getAttribute('aria-pressed') !== 'true') return null;
      const map = window.__opdIss;
      if (!map?.getCenter || !map.getVerticalFieldOfView || !map.getRoll) return null;
      const roll = ((map.getRoll() % 360) + 360) % 360;
      if (Math.abs(roll - 180) > 0.5) return null;
      const center = map.getCenter();
      const fov = map.getVerticalFieldOfView();
      const fromStart = Math.abs(center.lat - ${pan.lat}) + Math.abs(center.lng - ${pan.lng});
      const fromPan = Math.abs(center.lat - ${pan.panLat}) + Math.abs(center.lng - ${pan.panLng});
      if (fromStart < 0.3 || fromPan > fromStart) return null;
      if (Math.abs(fov - ${pan.fov}) > 0.5) return null;
      const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
      const port = document.querySelector('[data-iss-port]')?.getBoundingClientRect();
      const starboard = document.querySelector('[data-iss-starboard]')?.getBoundingClientRect();
      if (!frame || !port || !starboard) return null;
      if (starboard.right > frame.left + 2 || port.left < frame.right - 2) return null;
      return { ok: true, fov, fromStart, fromPan };
    })()`,
    'iss pan kept and fov held',
    45000,
  );
  await shot(send, evidenceDir, 'iss-pan-return');
}

const CUPOLA_AIMS = [
  [1, 'Window 1 · Port'],
  [2, 'Window 2 · Forward port'],
  [3, 'Window 3 · Forward starboard'],
  [4, 'Window 4 · Starboard'],
  [5, 'Window 5 · Aft starboard'],
  [6, 'Window 6 · Aft port'],
];

async function proveIssWindows(send, evidenceDir) {
  const centers = [];
  for (const [id, label] of CUPOLA_AIMS) {
    await evaluate(send, `(() => {
      const cupola = document.querySelector('[data-iss-cupola]');
      if (!cupola) return;
      cupola.value = '${id}';
      cupola.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const aim = await waitFor(
      send,
      `(() => {
        const text = document.querySelector('[data-iss-status]')?.textContent || '';
        if (!text.includes(${JSON.stringify(label)}) || text.includes('Coming soon')) return null;
        const chip = document.querySelector('[data-iss-window]');
        if (!chip || chip.hidden || (chip.textContent || '').trim() !== 'W${id}') return null;
        const map = window.__opdIss;
        if (!map?.getCenter || !map.getRoll) return null;
        const roll = ((map.getRoll() % 360) + 360) % 360;
        if (Math.abs(roll - 180) > 0.5) return null;
        const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
        const port = document.querySelector('[data-iss-port]')?.getBoundingClientRect();
        const starboard = document.querySelector('[data-iss-starboard]')?.getBoundingClientRect();
        if (!frame || !port || !starboard) return null;
        if (starboard.right > frame.left + 2 || port.left < frame.right - 2) return null;
        const center = map.getCenter();
        return { ok: true, lat: center.lat, lng: center.lng };
      })()`,
      `iss window ${id}`,
      15000,
    );
    centers.push(aim);
    await shot(send, evidenceDir, `iss-w${id}`);
  }
  const port = centers[0];
  const starboard = centers[3];
  if (Math.abs(port.lat - starboard.lat) + Math.abs(port.lng - starboard.lng) < 1) {
    throw new Error(`iss port and starboard share an aim ${JSON.stringify({ port, starboard })}`);
  }
}

async function proveIssWindowSession(send, evidenceDir) {
  await click(send, '#tab-map');
  await waitFor(
    send,
    `document.getElementById('view')?.className === 'view-map' && !document.querySelector('[data-iss-scene]') ? { ok: true } : null`,
    'map before window return',
    20000,
  );
  await click(send, '#tab-iss');
  await waitFor(
    send,
    `(() => {
      const chip = document.querySelector('[data-iss-window]');
      const cupola = document.querySelector('[data-iss-cupola]');
      if (!chip || chip.hidden || (chip.textContent || '').trim() !== 'W6') return null;
      if (!cupola || cupola.value !== '6') return null;
      if (document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed') === 'true') return null;
      const text = document.querySelector('[data-iss-status]')?.textContent || '';
      if (!text.includes('Window 6 · Aft port')) return null;
      return { ok: true };
    })()`,
    'iss window kept',
    45000,
  );
  await shot(send, evidenceDir, 'iss-window-return');
}

async function proveIssAimReset(send, evidenceDir) {
  const baseline = await evaluate(send, `(() => {
    const map = window.__opdIss;
    const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
    const reset = document.querySelector('[data-iss-reset]');
    if (!map?.getCenter || !map.getVerticalFieldOfView || !frame || frame.width < 40 || !reset) return null;
    if ((reset.textContent || '').trim() !== 'Reset') return null;
    if (!/double-tap/i.test(reset.getAttribute('title') || '')) return null;
    const suffix = getComputedStyle(reset, '::after').content || '';
    if (!/double-tap/i.test(suffix)) return null;
    const center = map.getCenter();
    return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2, fov: map.getVerticalFieldOfView(), lat: center.lat, lng: center.lng };
  })()`);
  if (!baseline) throw new Error('iss reset baseline missing');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: baseline.x, y: baseline.y, deltaX: 0, deltaY: -480 });
  await waitFor(
    send,
    `(() => {
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || !(fov < ${baseline.fov} - 4)) return null;
      return { ok: true, fov };
    })()`,
    'iss pinch before window',
    10000,
  );
  await evaluate(send, `(() => {
    const cupola = document.querySelector('[data-iss-cupola]');
    if (!cupola) return;
    cupola.value = '1';
    cupola.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const windowed = await waitFor(
    send,
    `(() => {
      const text = document.querySelector('[data-iss-status]')?.textContent || '';
      if (!text.includes('Window 1 · Port')) return null;
      const map = window.__opdIss;
      if (!map?.getCenter || !map.getVerticalFieldOfView) return null;
      const fov = map.getVerticalFieldOfView();
      if (Math.abs(fov - ${baseline.fov}) > 0.5) return null;
      const center = map.getCenter();
      const shift = Math.abs(center.lat - ${baseline.lat}) + Math.abs(center.lng - ${baseline.lng});
      if (shift < 0.5) return null;
      return { ok: true, lat: center.lat, lng: center.lng, fov };
    })()`,
    'iss window restores field',
    15000,
  );
  await shot(send, evidenceDir, 'iss-window-fov');
  const beforeReset = await nudgeIssAim(send);
  await click(send, '[data-iss-reset]');
  await waitFor(
    send,
    issHorizonRestored(null, null, beforeReset.fov),
    'iss reset button',
    10000,
  );
  await shot(send, evidenceDir, 'iss-reset');
  const beforeTap = await nudgeIssAim(send);
  const spot = await evaluate(send, `(() => {
    const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
    if (!frame || frame.width < 40) return null;
    return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 };
  })()`);
  if (!spot) throw new Error('iss double tap target missing');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', buttons: 0, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', buttons: 0, clickCount: 2 });
  await waitFor(
    send,
    issHorizonRestored(beforeTap.lat, beforeTap.lng, beforeTap.fov),
    'iss double tap reset',
    10000,
  );
  await shot(send, evidenceDir, 'iss-double-tap');
}

function issLensFovExpression() {
  return `(() => {
    const fov = window.__opdIss?.getVerticalFieldOfView?.();
    if (typeof fov !== 'number' || Math.abs(fov - ${ISS_LENS_FOV_DEG}) > 0.5) return null;
    return { ok: true, fov };
  })()`;
}

async function readIssLensFov(send, label, timeoutMs = 45000) {
  const ready = await waitFor(send, issLensFovExpression(), label, timeoutMs);
  return ready.fov;
}

async function proveIssAimReload(send, evidenceDir) {
  const lens = await readIssLensFov(send, 'iss lens fov');
  await evaluate(send, `(() => {
    const cupola = document.querySelector('[data-iss-cupola]');
    if (!cupola) return;
    cupola.value = '3';
    cupola.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(
    send,
    `(() => {
      const chip = document.querySelector('[data-iss-window]');
      const cupola = document.querySelector('[data-iss-cupola]');
      const text = document.querySelector('[data-iss-status]')?.textContent || '';
      if (!chip || chip.hidden || (chip.textContent || '').trim() !== 'W3') return null;
      if (!cupola || cupola.value !== '3') return null;
      if (!text.includes('Window 3 · Forward starboard')) return null;
      return { ok: true };
    })()`,
    'iss window 3 before reload',
    15000,
  );
  const spot = await evaluate(send, `(() => {
    const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
    if (!frame || frame.width < 40) return null;
    return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 };
  })()`);
  if (!spot) throw new Error('iss reload fov target missing');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: spot.x, y: spot.y, deltaX: 0, deltaY: -480 });
  const narrowed = await waitFor(
    send,
    `(() => {
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || !(fov < ${lens} - 4)) return null;
      const raw = sessionStorage.getItem('opd-iss-aim');
      if (!raw) return null;
      const aim = JSON.parse(raw);
      if (aim.windowId !== 3 || aim.mode !== 'horizon') return null;
      if (Math.abs(aim.opticalFovDeg - fov) > 0.5) return null;
      return { ok: true, fov };
    })()`,
    'iss aim stored before reload',
    10000,
  );
  await reloadSettled(send);
  await click(send, '#tab-iss');
  await waitFor(
    send,
    `(() => {
      const view = document.getElementById('view');
      if (!view || view.className !== 'view-iss') return null;
      const chip = document.querySelector('[data-iss-window]');
      const cupola = document.querySelector('[data-iss-cupola]');
      const horizon = document.querySelector('[data-iss-preset="horizon"]');
      if (!chip || chip.hidden || (chip.textContent || '').trim() !== 'W3') return null;
      if (!cupola || cupola.value !== '3') return null;
      if (horizon?.getAttribute('aria-pressed') === 'true') return null;
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || Math.abs(fov - ${narrowed.fov}) > 0.5) return null;
      const raw = sessionStorage.getItem('opd-iss-aim');
      if (!raw) return null;
      return { ok: true, fov };
    })()`,
    'iss aim restored after reload',
    45000,
  );
  await shot(send, evidenceDir, 'iss-aim-restored');
  await click(send, '[data-iss-reset]');
  await waitFor(
    send,
    `(() => {
      const horizon = document.querySelector('[data-iss-preset="horizon"]');
      const cupola = document.querySelector('[data-iss-cupola]');
      const chip = document.querySelector('[data-iss-window]');
      if (horizon?.getAttribute('aria-pressed') !== 'true') return null;
      if (cupola?.value !== '') return null;
      if (!chip || !chip.hidden) return null;
      if (sessionStorage.getItem('opd-iss-aim') !== null) return null;
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || Math.abs(fov - ${ISS_LENS_FOV_DEG}) > 0.5 || Math.abs(fov - ${lens}) > 0.5) return null;
      return { ok: true, fov };
    })()`,
    'iss reset clears stored aim',
    10000,
  );
  await shot(send, evidenceDir, 'iss-aim-reset');
  await reloadSettled(send);
  await click(send, '#tab-iss');
  await waitFor(
    send,
    `(() => {
      const view = document.getElementById('view');
      if (!view || view.className !== 'view-iss') return null;
      const horizon = document.querySelector('[data-iss-preset="horizon"]');
      const cupola = document.querySelector('[data-iss-cupola]');
      const chip = document.querySelector('[data-iss-window]');
      const text = document.querySelector('[data-iss-status]')?.textContent || '';
      if (horizon?.getAttribute('aria-pressed') !== 'true') return null;
      if (!cupola || cupola.value !== '') return null;
      if (!chip || !chip.hidden) return null;
      if (!text.includes('Horizon locked')) return null;
      if (sessionStorage.getItem('opd-iss-aim') !== null) return null;
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || Math.abs(fov - ${ISS_LENS_FOV_DEG}) > 0.5 || Math.abs(fov - ${lens}) > 0.5) return null;
      return { ok: true, fov };
    })()`,
    'iss horizon after cleared reload',
    45000,
  );
  await shot(send, evidenceDir, 'iss-aim-horizon');
  await proveIssKeyboard(send);
}

function issHorizonRestored(lat, lng, fov) {
  const centerCheck = lat === null ? 'true' : `(() => {
    const center = map.getCenter();
    return Math.abs(center.lat - ${lat}) + Math.abs(center.lng - ${lng}) <= 0.35;
  })()`;
  return `(() => {
    const map = window.__opdIss;
    const cupola = document.querySelector('[data-iss-cupola]');
    const horizon = document.querySelector('[data-iss-preset="horizon"]');
    if (!map?.getCenter || !map.getVerticalFieldOfView || cupola?.value !== '') return null;
    if (horizon?.getAttribute('aria-pressed') !== 'true') return null;
    const chip = document.querySelector('[data-iss-window]');
    if (!chip || !chip.hidden) return null;
    if (sessionStorage.getItem('opd-iss-aim') !== null) return null;
    if (!(${centerCheck})) return null;
    const fovNow = map.getVerticalFieldOfView();
    if (Math.abs(fovNow - ${fov}) > 0.5) return null;
    return { ok: true, fov: fovNow };
  })()`;
}

async function pressKey(send, key) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
}

async function proveIssKeyboard(send) {
  const before = await evaluate(send, `(() => {
    const map = window.__opdIss;
    if (!map?.getCenter || !map.getVerticalFieldOfView) return null;
    const center = map.getCenter();
    const fov = map.getVerticalFieldOfView();
    if (typeof fov !== 'number') return null;
    return { lat: center.lat, lng: center.lng, fov };
  })()`);
  if (!before) throw new Error('iss keyboard baseline missing');
  await evaluate(send, `document.querySelector('[data-iss-frame]')?.focus()`);
  await pressKey(send, '=');
  const narrowed = await waitFor(
    send,
    `(() => {
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || !(fov < ${before.fov} - 2)) return null;
      return { ok: true, fov };
    })()`,
    'iss keyboard field narrowed',
    10000,
  );
  await pressKey(send, '-');
  await waitFor(
    send,
    `(() => {
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || Math.abs(fov - ${before.fov}) > 0.5) return null;
      return { ok: true, fov };
    })()`,
    'iss keyboard field widened',
    10000,
  );
  for (let step = 0; step < 6; step += 1) await pressKey(send, 'ArrowRight');
  await waitFor(
    send,
    `(() => {
      const map = window.__opdIss;
      if (!map?.getCenter) return null;
      const center = map.getCenter();
      const shift = Math.abs(center.lat - ${before.lat}) + Math.abs(center.lng - ${before.lng});
      if (shift < 0.2) return null;
      const raw = sessionStorage.getItem('opd-iss-aim');
      if (!raw) return null;
      const aim = JSON.parse(raw);
      if (!aim.look || !(aim.look.rightDeg > 0)) return null;
      return { ok: true, shift };
    })()`,
    'iss keyboard pan',
    10000,
  );
  await pressKey(send, '=');
  await waitFor(
    send,
    `(() => {
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || !(fov < ${before.fov} - 2)) return null;
      return { ok: true, fov };
    })()`,
    'iss keyboard field narrowed before a window',
    10000,
  );
  await pressKey(send, '3');
  await waitFor(
    send,
    `(() => {
      const map = window.__opdIss;
      const cupola = document.querySelector('[data-iss-cupola]');
      const chip = document.querySelector('[data-iss-window]');
      const horizon = document.querySelector('[data-iss-preset="horizon"]');
      if (!map?.getCenter || !map.getVerticalFieldOfView || !cupola || !chip) return null;
      if (cupola.value !== '3') return null;
      if (chip.textContent !== 'W3' || chip.hidden) return null;
      if (chip.getAttribute('aria-label') !== 'Window 3 · Forward starboard') return null;
      if (horizon?.getAttribute('aria-pressed') !== 'false') return null;
      const fov = map.getVerticalFieldOfView();
      if (Math.abs(fov - ${before.fov}) > 0.5) return null;
      const raw = sessionStorage.getItem('opd-iss-aim');
      if (!raw) return null;
      const aim = JSON.parse(raw);
      if (aim.windowId !== 3 || aim.mode !== 'horizon' || aim.azimuthDeg !== 30) return null;
      if (!aim.look || aim.look.rightDeg !== 0 || aim.look.upDeg !== 0) return null;
      const center = map.getCenter();
      const shift = Math.abs(center.lat - ${before.lat}) + Math.abs(center.lng - ${before.lng});
      if (shift < 0.5) return null;
      return { ok: true, fov, shift };
    })()`,
    'iss keyboard cupola window',
    10000,
  );
  await pressKey(send, '7');
  await waitFor(
    send,
    `(() => {
      const map = window.__opdIss;
      const cupola = document.querySelector('[data-iss-cupola]');
      const chip = document.querySelector('[data-iss-window]');
      const nadir = document.querySelector('[data-iss-preset="nadir"]');
      if (!map?.getVerticalFieldOfView || !cupola || !chip) return null;
      if (cupola.value !== '7' || chip.textContent !== 'W7' || chip.hidden) return null;
      if (nadir?.getAttribute('aria-pressed') !== 'true') return null;
      const fov = map.getVerticalFieldOfView();
      if (Math.abs(fov - ${before.fov}) > 0.5) return null;
      const raw = sessionStorage.getItem('opd-iss-aim');
      if (!raw) return null;
      const aim = JSON.parse(raw);
      if (aim.windowId !== 7 || aim.mode !== 'nadir' || aim.azimuthDeg !== 0) return null;
      if (!aim.look || aim.look.rightDeg !== 0 || aim.look.upDeg !== 0) return null;
      return { ok: true };
    })()`,
    'iss keyboard nadir window',
    10000,
  );
  await pressKey(send, 'r');
  await waitFor(
    send,
    `(() => {
      const map = window.__opdIss;
      const horizon = document.querySelector('[data-iss-preset="horizon"]');
      if (!map?.getCenter || !map.getVerticalFieldOfView) return null;
      if (horizon?.getAttribute('aria-pressed') !== 'true') return null;
      if (sessionStorage.getItem('opd-iss-aim') !== null) return null;
      const center = map.getCenter();
      const fov = map.getVerticalFieldOfView();
      const back = Math.abs(center.lat - ${before.lat}) + Math.abs(center.lng - ${before.lng});
      if (back > 0.35) return null;
      if (Math.abs(fov - ${before.fov}) > 0.5) return null;
      return { ok: true, fov };
    })()`,
    'iss keyboard reset',
    10000,
  );
  if (!(narrowed.fov < before.fov - 2)) throw new Error('iss keyboard field did not narrow');
}

async function nudgeIssAim(send) {
  const home = await evaluate(send, `(() => {
    const map = window.__opdIss;
    const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
    if (!map?.getCenter || !map.getVerticalFieldOfView || !frame || frame.width < 40) return null;
    const center = map.getCenter();
    return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2, dx: Math.max(36, frame.width * 0.22), lat: center.lat, lng: center.lng, fov: map.getVerticalFieldOfView() };
  })()`);
  if (!home) throw new Error('iss nudge baseline missing');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: home.x, y: home.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: home.x - home.dx, y: home.y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: home.x - home.dx, y: home.y, button: 'left', buttons: 0, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: home.x, y: home.y, deltaX: 0, deltaY: -480 });
  await waitFor(
    send,
    `(() => {
      const map = window.__opdIss;
      if (!map?.getCenter || !map.getVerticalFieldOfView) return null;
      const center = map.getCenter();
      const fov = map.getVerticalFieldOfView();
      const shift = Math.abs(center.lat - ${home.lat}) + Math.abs(center.lng - ${home.lng});
      if (shift < 0.4) return null;
      if (!(fov < ${home.fov} - 4)) return null;
      return { ok: true, shift, fov };
    })()`,
    'iss pan and pinch',
    10000,
  );
  return home;
}

async function proveIssLandscape(send, evidenceDir) {
  await setViewport(send, 874, 402, true);
  const contained = `(() => {
    const hostBox = document.getElementById('iss-host')?.getBoundingClientRect();
    const scene = document.querySelector('[data-iss-scene]');
    const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
    const card = document.querySelector('[data-iss-card]')?.getBoundingClientRect();
    const port = document.querySelector('[data-iss-port]')?.getBoundingClientRect();
    const starboard = document.querySelector('[data-iss-starboard]')?.getBoundingClientRect();
    if (!hostBox || !scene || !frame || !card || !port || !starboard) return null;
    if (frame.width < 80 || frame.height < 72) return null;
    if (scene.scrollHeight > scene.clientHeight + 2 || scene.scrollWidth > scene.clientWidth + 2) return null;
    const within = (box) => box.width > 1 && box.height > 1 && box.left >= hostBox.left - 1 && box.right <= hostBox.right + 1 && box.top >= hostBox.top - 1 && box.bottom <= hostBox.bottom + 1;
    if (!within(frame) || !within(card) || !within(port) || !within(starboard)) return null;
    const places = [...document.querySelectorAll('.iss-place')].map((node) => node.getBoundingClientRect()).filter((box) => box.width > 1 && box.height > 1);
    for (let i = 0; i < places.length; i += 1) {
      for (let j = i + 1; j < places.length; j += 1) {
        const a = places[i];
        const b = places[j];
        if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) return null;
      }
    }
    return { ok: true, width: frame.width, height: frame.height, labels: places.length };
  })()`;
  await waitFor(send, contained, 'iss landscape collapsed', 10000);
  await click(send, '[data-iss-telemetry]');
  const open = await waitFor(send, contained, 'iss landscape telemetry open', 10000);
  await sleep(1200);
  const held = await waitFor(send, contained, 'iss landscape telemetry after ticks', 10000);
  await shot(send, evidenceDir, 'iss-landscape-telemetry');
  await click(send, '[data-iss-telemetry]');
  await waitFor(
    send,
    `document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') === 'false' ? { ok: true } : null`,
    'iss landscape telemetry collapsed',
    10000,
  );
  if (open.height < 72 || held.height < 72) throw new Error(`iss landscape frame ${open.height} then ${held.height}`);
}

async function driveHelp(send, evidenceDir) {
  await dismissShotlist(send);
  await click(send, '#tab-map');
  await ensureMapChromeShown(send);
  const creditsOpen = await evaluate(send, `document.querySelector('.maplibregl-ctrl-attrib')?.classList.contains('maplibregl-compact-show') === true`);
  if (creditsOpen) await click(send, '.maplibregl-ctrl-attrib-button');
  await waitFor(
    send,
    `(() => {
      const node = document.querySelector('.maplibregl-ctrl-attrib');
      const help = document.querySelector('.help-fab')?.getBoundingClientRect();
      const button = document.querySelector('.maplibregl-ctrl-attrib-button')?.getBoundingClientRect();
      if (!node || node.classList.contains('maplibregl-compact-show')) return null;
      if (!help || !button || help.width < 40) return null;
      if (help.bottom > button.top + 8) return null;
      return { ok: true };
    })()`,
    'help above collapsed credits',
    20000,
  );
  await shot(send, evidenceDir, 'help-placement');
  await click(send, '#help-fab');
  await waitFor(send, `document.querySelector('.help-modal') ? { ok: true } : null`, 'help dialog');
  const label = await evaluate(send, `document.querySelector('.help-modal')?.getAttribute('aria-label') || ''`);
  if (!String(label).includes('Help')) throw new Error(`help dialog label missing: ${label}`);
  await shot(send, evidenceDir, 'help');
  await click(send, '.help-close');
  await waitFor(send, `!document.querySelector('.help-modal') ? { ok: true } : null`, 'help closed');
  await click(send, '#tab-queue');
  await waitFor(
    send,
    `(() => {
      const help = document.querySelector('.help-fab')?.getBoundingClientRect();
      if (!help || help.width < 40) return null;
      const rightGap = window.innerWidth - help.right;
      const bottomGap = window.innerHeight - help.bottom;
      if (rightGap < 0 || rightGap > 24 || bottomGap < 0 || bottomGap > 24) return null;
      return { ok: true, rightGap, bottomGap };
    })()`,
    'help corner on queue',
    10000,
  );
  await shot(send, evidenceDir, 'help-queue');
  return 'help: opened, closed, queue corner';
}

const LAST_GOOD_TLE = {
  line1: '1 25544U 98067A   26272.17419514  .00009528  00000+0  18291-3 0  9998',
  line2: '2 25544  51.6315 155.3455 0007168 193.0559 167.0244 15.48664528587569',
  at: '2026-09-29T04:10:50.460Z',
};

async function driveProfile(send, evidenceDir, meta, baseUrl, home) {
  await click(send, '#tab-profile');
  await waitFor(
    send,
    `(() => {
      const body = document.getElementById('profile-body')?.innerText || '';
      const slider = document.getElementById('profile-threshold-slider');
      return body.includes('Anil') && slider ? { ok: true } : null;
    })()`,
    'profile pane',
  );
  await evaluate(send, `(() => {
    const slider = document.getElementById('profile-threshold-slider');
    slider.value = '800';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(
    send,
    `document.getElementById('profile-threshold-display')?.textContent === '800 km' ? { ok: true } : null`,
    'threshold display',
  );
  await shot(send, evidenceDir, 'profile');
  await evaluate(send, `(() => {
    document.getElementById('profile-add-name').value = 'Verify Harbor';
    document.getElementById('profile-add-lat').value = ${JSON.stringify(String(meta.reef.lat.toFixed(4)))};
    document.getElementById('profile-add-lon').value = ${JSON.stringify(String(meta.reef.lon.toFixed(4)))};
  })()`);
  await click(send, '#profile-add-btn');
  await waitFor(
    send,
    `document.getElementById('profile-body')?.innerText.includes('Verify Harbor') ? { ok: true } : null`,
    'added target',
  );
  await shot(send, evidenceDir, 'profile-target');
  const heading = await evaluate(send, `[...document.querySelectorAll('#profile-body .profile-crud-subhead')].some((node) => node.textContent === 'Hidden curated targets')`);
  if (!heading) throw new Error('profile has no hidden curated section');
  const mesaChip = await evaluate(send, `!!document.querySelector('[data-curated-id="verify-mesa"]')`);
  if (!mesaChip) {
    await evaluate(send, `(() => {
      const details = document.getElementById('profile-curated-paste-fallback');
      if (details) details.open = true;
      const input = document.getElementById('profile-curated-input');
      if (input) input.value = 'verify-mesa';
    })()`);
    await click(send, '#profile-curated-hide-btn');
    await waitFor(send, `document.querySelector('[data-curated-id="verify-mesa"]') ? { ok: true } : null`, 'hidden mesa chip');
  }
  await shot(send, evidenceDir, 'profile-hidden');
  await evaluate(send, `document.querySelector('[data-curated-id="verify-mesa"] button')?.click()`);
  await waitFor(send, `!document.querySelector('[data-curated-id="verify-mesa"]') ? { ok: true } : null`, 'mesa restored');
  const restored = await waitServerRemoved(baseUrl, [], ['verify-mesa']);
  await expectFreshHide(baseUrl, home, {
    id: 'verify-mesa',
    name: meta.names.upcoming[0],
    updatedAt: restored.removedCuratedUpdatedAt,
    visible: true,
  });
  const lookupValue = JSON.stringify(meta.lookupTimestamp);
  await waitFor(
    send,
    `(() => {
      const input = document.getElementById('lookup-input');
      const result = document.getElementById('lookup-result');
      if (!input) return null;
      if (input.value !== ${lookupValue}) input.value = ${lookupValue};
      const text = result && !result.hidden ? (result.innerText || '') : '';
      if (text.includes('ISS at')) return { ok: true, text };
      if (text.trim()) return { error: text.slice(0, 400) };
      document.getElementById('lookup-resolve')?.click();
      return null;
    })()`,
    'photo lookup',
  );
  await shot(send, evidenceDir, 'profile-lookup');
  await click(send, '#lookup-result .lookup-btn');
  await waitFor(
    send,
    `(() => {
      const onMap = document.getElementById('view')?.className === 'view-map';
      const layer = window.__opdMap?.getLayer('lookup-pin-layer');
      return onMap && layer ? { ok: true } : null;
    })()`,
    'lookup pin on map',
    20000,
  );
  await shot(send, evidenceDir, 'profile-lookup-map');
  await click(send, '#tab-profile');
  await evaluate(send, `localStorage.setItem('opd-iss-tle-last-good', ${JSON.stringify(JSON.stringify({ line1: LAST_GOOD_TLE.line1, line2: LAST_GOOD_TLE.line2 }))})`);
  await evaluate(send, `(() => {
    const input = document.getElementById('lookup-input');
    input.value = ${JSON.stringify(LAST_GOOD_TLE.at)};
    document.getElementById('lookup-resolve').click();
  })()`);
  const lastGood = await waitFor(
    send,
    `(() => {
      const text = document.getElementById('lookup-result')?.textContent || '';
      if (text.includes('TLE age 0.0 h') && text.includes('ISS at')) return { ok: true, text };
      if (text.includes('orbit data is out of date')) return { error: text.slice(0, 300) };
      return null;
    })()`,
    'last-good lookup',
    30000,
  );
  await click(send, '#tab-profile');
  await shot(send, evidenceDir, 'profile-lookup-last-good');
  await evaluate(send, `(() => {
    const input = document.getElementById('lookup-input');
    input.value = '2035-06-01T00:00:00.000Z';
    document.getElementById('lookup-resolve').click();
  })()`);
  const far = await waitFor(
    send,
    `(() => {
      const text = document.getElementById('lookup-result')?.innerText || '';
      const error = document.querySelector('#lookup-result .lookup-error')?.textContent || '';
      if (error === 'orbit data is out of date, reconnect to refresh') return { ok: true, kind: 'stale', text: error };
      if (text.includes('low confidence') && text.includes('TLE age') && text.includes('ISS at')) return { ok: true, kind: 'low', text };
      return null;
    })()`,
    '2035 lookup',
    45000,
  );
  await click(send, '#tab-profile');
  await shot(send, evidenceDir, 'profile-lookup-2035');
  return `profile: threshold, add target, hidden curated restore, photo lookup, last-good ${lastGood.text.includes('TLE age 0.0 h')}, 2035 ${far.kind}`;
}

async function driveLog(send, evidenceDir, baseUrl) {
  await click(send, '#tab-log');
  await waitFor(
    send,
    `(() => {
      const text = document.getElementById('log-list')?.innerText || '';
      return text.includes('Verify Reef') && /\\bshoot\\b/i.test(text) ? { ok: true, text } : null;
    })()`,
    'log row',
  );
  const listed = await fetch(`${baseUrl}/api/log`).then((response) => response.json());
  const shoot = Array.isArray(listed.entries)
    ? listed.entries.find((entry) => entry.action === 'shoot' && entry.target_id === 'verify-reef')
    : null;
  if (!shoot || shoot.target_name !== 'Verify Reef') throw new Error(`log stored name ${JSON.stringify(shoot)}`);
  await shot(send, evidenceDir, 'log');
  return 'log: shoot row visible, stored target name Verify Reef';
}

async function setCredits(send, open) {
  const isOpen = await evaluate(send, `document.querySelector('.maplibregl-ctrl-attrib')?.classList.contains('maplibregl-compact-show') === true`);
  if (isOpen !== open) await click(send, '.maplibregl-ctrl-attrib-button');
  await waitFor(
    send,
    `document.querySelector('.maplibregl-ctrl-attrib')?.classList.contains('maplibregl-compact-show') === ${open ? 'true' : 'false'} ? { ok: true } : null`,
    open ? 'credits expanded' : 'credits collapsed',
    10000,
  );
}

async function assertDockClearsCredits(send, label) {
  const boxes = await evaluate(send, `(() => {
    const dock = document.querySelector('.map-control-dock');
    const help = document.querySelector('.help-fab');
    const credits = document.querySelector('.maplibregl-ctrl-attrib');
    const button = document.querySelector('.map-control-dock .time-btn');
    if (!dock || !help || !credits || !button) return null;
    const dockBox = dock.getBoundingClientRect();
    const helpBox = help.getBoundingClientRect();
    const creditsBox = credits.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    const overlaps = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    return {
      ok: dockBox.bottom <= helpBox.top + 1
        && dockBox.bottom <= creditsBox.top + 1
        && !overlaps(dockBox, helpBox)
        && !overlaps(dockBox, creditsBox)
        && helpBox.width >= 44
        && helpBox.height >= 44
        && buttonBox.width >= 44
        && buttonBox.height >= 44,
      dockBottom: dockBox.bottom,
      helpTop: helpBox.top,
      creditsTop: creditsBox.top,
      help: { width: helpBox.width, height: helpBox.height },
      button: { width: buttonBox.width, height: buttonBox.height },
    };
  })()`);
  if (!boxes?.ok) throw new Error(`${label} ${JSON.stringify(boxes)}`);
}

async function drivePhone(send, evidenceDir, meta, home) {
  await dismissShotlist(send);
  await click(send, '#tab-map');
  await waitFor(
    send,
    `window.__opdMap && document.querySelector('.iss-marker') && document.querySelector('.map-legend') ? { ok: true } : null`,
    'phone map',
    45000,
  );
  await setViewport(send, 390, 844, true);
  await revealMapChrome(send, evidenceDir, 'phone-chrome-hidden');
  const inset = await safeAreaOverride(send, { top: 47, left: 0, bottom: 34, right: 0 });
  await sleep(300);
  const portrait = await evaluate(send, `(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    const tab = box('.tab');
    const kp = box('#kp-widget');
    const help = box('.help-fab');
    const info = box('.maplibregl-ctrl-attrib-button');
    const pad = getComputedStyle(document.querySelector('.topbar')).paddingTop;
    return { tab, kp, help, info, pad };
  })()`);
  const tall = (box, label) => {
    if (!box || box.width < 44 || box.height < 44) throw new Error(`${label} is ${JSON.stringify(box)}`);
  };
  tall(portrait.tab, 'tab');
  tall(portrait.kp, 'kp');
  tall(portrait.help, 'help');
  tall(portrait.info, 'credits button');
  if (inset) {
    const pad = Number.parseFloat(portrait.pad);
    if (!Number.isFinite(pad) || pad < 47) throw new Error(`top bar padding ${portrait.pad} with safe area`);
  }
  await shot(send, evidenceDir, 'phone-portrait');
  await setCredits(send, true);
  await assertDockClearsCredits(send, 'phone portrait credits expanded');
  await shot(send, evidenceDir, 'phone-portrait-credits');
  await setViewport(send, 844, 390, true);
  await sleep(300);
  await setCredits(send, false);
  const landscape = await evaluate(send, `(() => {
    const dock = document.querySelector('.map-control-dock');
    const help = document.querySelector('.help-fab');
    const info = document.querySelector('.maplibregl-ctrl-attrib-button');
    const button = document.querySelector('.map-control-dock .time-btn');
    if (!dock || !help || !info || !button) return null;
    const dockBox = dock.getBoundingClientRect();
    const helpBox = help.getBoundingClientRect();
    const infoBox = info.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    return {
      ok: dockBox.bottom <= helpBox.top + 1
        && dockBox.bottom <= infoBox.top + 1
        && dock.scrollHeight > dock.clientHeight + 1
        && buttonBox.width >= 44
        && buttonBox.height >= 44,
      dockBottom: dockBox.bottom,
      helpTop: helpBox.top,
      infoTop: infoBox.top,
      scrollHeight: dock.scrollHeight,
      clientHeight: dock.clientHeight,
      button: { width: buttonBox.width, height: buttonBox.height },
    };
  })()`);
  if (!landscape?.ok) throw new Error(`phone dock ${JSON.stringify(landscape)}`);
  await shot(send, evidenceDir, 'phone-landscape');
  await setCredits(send, true);
  await assertDockClearsCredits(send, 'phone landscape credits expanded');
  await shot(send, evidenceDir, 'phone-landscape-credits');
  await setCredits(send, false);
  const pressed = await evaluate(send, `document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed')`);
  if (pressed !== 'false') {
    await click(send, '#toggle-follow-iss');
    await waitFor(
      send,
      `document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed') === 'false' ? { ok: true } : null`,
      'phone follow off',
    );
  }
  await evaluate(send, `[...document.querySelectorAll('.maplibregl-popup-close-button')].forEach((button) => button.click())`);
  let lon = Math.round(meta.reef.lon + 30);
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  const lat = Math.round(meta.reef.lat);
  await frameLngLat(send, lon, lat, 4);
  const point = await pointForLngLat(send, lon, lat);
  if (!point?.ok) throw new Error('could not project the long-press point');
  try {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  } catch {
  }
  const finger = touchPoint(point.x, point.y);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger] });
  await waitFor(
    send,
    `(() => {
      const popup = document.querySelector('.maplibregl-popup');
      const text = popup?.innerText || '';
      if (text.includes('Closest')) return { ok: true };
      const hit = document.elementFromPoint(${finger.x}, ${finger.y});
      return {
        popup: text.slice(0, 120),
        hit: hit ? (hit.id || String(hit.className) || hit.tagName) : null,
        popups: document.querySelectorAll('.maplibregl-popup').length,
      };
    })()`,
    'long press popup',
    5000,
  );
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [finger] });
  await sleep(80);
  await mouseClick(send, finger.x, finger.y);
  const stayed = await evaluate(send, `document.querySelector('.maplibregl-popup')?.innerText.includes('Closest') === true`);
  if (!stayed) throw new Error('pin popup closed on the click that follows the long press');
  await shot(send, evidenceDir, 'phone-long-press');
  await sleep(750);
  await mouseClick(send, finger.x, finger.y);
  await waitFor(
    send,
    `document.querySelector('.maplibregl-popup')?.innerText.includes('Closest') ? null : { ok: true }`,
    'pin popup dismissed',
    5000,
  );
  await safeAreaOverride(send, { top: 0, left: 0, bottom: 0, right: 0 });
  await setViewport(send, home.width, home.height, home.mobile);
  return `phone: 44px targets, dock clear with credits collapsed and expanded, long-press held, safe-area ${inset ? 'applied' : 'unsupported'}`;
}
