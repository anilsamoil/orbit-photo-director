import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { refreshLaunchClock } from './fixtures.mjs';
import { deviceDescriptor, deviceViewport, launchWebkit, playwrightSend, proveDeniedFooter, WEBKIT_DEVICES } from './webkit-devices.mjs';

export const BROWSER_FEATURES = ['banner', 'topbar', 'queue', 'upcoming', 'map', 'iss', 'help', 'profile', 'log', 'phone', 'tracked'];

const DESKTOP = { width: 1400, height: 900, mobile: false };
const ISS_LENS_FOV_DEG = 81.2;
const ISS_CLOCK_EXPR = `(() => {
  const root = document.querySelector('[data-iss-clock]');
  if (!root) return { step: 'missing' };
  const names = [...root.children].map((el) => {
    if (el.hasAttribute('data-iss-utc')) return 'utc';
    if (el.hasAttribute('data-iss-houston')) return 'houston';
    if (el.hasAttribute('data-iss-gmt-day')) return 'gmt-day';
    if (el.hasAttribute('data-iss-day-month')) return 'day-month';
    if (el.hasAttribute('data-iss-weekday')) return 'weekday';
    return el.tagName;
  });
  if (names.join(',') !== 'utc,houston,gmt-day,day-month,weekday') return { step: 'order', names };
  const text = (sel) => document.querySelector(sel)?.textContent || '';
  const utc = text('[data-iss-utc]');
  const status = document.querySelector('[data-iss-status]')?.textContent || '';
  const stamp = /(\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}:\\d{2}) UTC/.exec(status);
  if (!stamp) return { step: 'stamp', utc, status: status.slice(0, 180) };
  if (utc !== stamp[2] + ' UTC') return { step: 'utc', utc, stamp: stamp[2] };
  const when = Date.parse(stamp[1] + 'T' + stamp[2] + 'Z');
  const date = new Date(when);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value || '';
  let hour = part('hour').padStart(2, '0');
  if (hour === '24') hour = '00';
  const zone = part('timeZoneName');
  if (zone !== 'CDT' && zone !== 'CST') return { step: 'zone', zone };
  const houston = hour + ':' + part('minute').padStart(2, '0') + ':' + part('second').padStart(2, '0') + ' ' + zone;
  const houstonText = text('[data-iss-houston]');
  if (houstonText !== houston) return { step: 'houston', houstonText, houston };
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - yearStart) / 86400000) + 1;
  const gmt = 'GMT' + String(day).padStart(3, '0');
  const gmtText = text('[data-iss-gmt-day]');
  if (gmtText !== gmt) return { step: 'gmt', gmtText, gmt };
  if (!/^GMT\\d{3}$/.test(gmtText)) return { step: 'gmt-form', gmtText };
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const dayMonth = String(date.getUTCDate()) + ' ' + months[date.getUTCMonth()];
  const dayMonthText = text('[data-iss-day-month]');
  if (dayMonthText !== dayMonth) return { step: 'day', dayMonthText, dayMonth };
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekday = weekdays[date.getUTCDay()];
  const weekdayText = text('[data-iss-weekday]');
  if (weekdayText !== weekday) return { step: 'weekday', weekdayText, weekday };
  if (getComputedStyle(root).pointerEvents !== 'none') return { step: 'pointer' };
  const lines = ['[data-iss-houston]', '[data-iss-gmt-day]', '[data-iss-day-month]', '[data-iss-weekday]'];
  for (const sel of lines) {
    const el = document.querySelector(sel);
    if (!el || el.tagName !== 'P') return { step: 'tag', sel };
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!(box.height > 4 && box.height < 44 && box.width > 8)) return { step: 'box', sel, height: box.height, width: box.width };
    if (style.pointerEvents !== 'none') return { step: 'line-pointer', sel, pointer: style.pointerEvents };
    if (style.minHeight !== '0px') return { step: 'min', sel, minHeight: style.minHeight };
  }
  const utcBox = document.querySelector('[data-iss-utc]').getBoundingClientRect();
  const under = document.querySelector('[data-iss-houston]').getBoundingClientRect();
  if (under.top + 1 < utcBox.top) return { step: 'under', utcTop: utcBox.top, lineTop: under.top };
  return { ok: true, utc, houston, gmt, dayMonth, weekday };
})()`;

function selectedSurfaceNames() {
  const raw = (process.env.OPD_VERIFY_SURFACE || 'all').trim();
  const known = ['desktop', ...WEBKIT_DEVICES.map((spec) => spec.slug)];
  if (raw === 'all') return known;
  if (!known.includes(raw)) throw new Error(`unknown OPD_VERIFY_SURFACE ${raw}. Choose ${known.join(', ')}, or all.`);
  return [raw];
}

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

async function revealInView(send, selector) {
  const seen = await evaluate(send, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'missing' };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = el.getBoundingClientRect();
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    const style = getComputedStyle(el);
    const inView = !el.hidden && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 8 && rect.height > 8 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
    return { ok: inView, top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewport: window.innerHeight, text };
  })()`);
  if (!seen?.ok) throw new Error(`${selector} is not in view ${JSON.stringify(seen)}`);
  return seen;
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

async function assertCanvasHit(send, x, y, label) {
  const hit = await evaluate(send, `(() => {
    const node = document.elementFromPoint(${x}, ${y});
    const canvas = document.querySelector('#map .maplibregl-canvas');
    if (!node || !canvas) return { ok: false, hit: node ? (node.id || String(node.className) || node.tagName) : null };
    const blocked = node.closest('.maplibregl-ctrl-attrib, .maplibregl-ctrl-bottom-right, .map-command, .map-inspector, .maplibregl-popup, .map-toolbar, .map-control-dock, .help-fab, .map-legend, .map-imagery-date, .map-chrome-toggle');
    const onCanvas = node === canvas || canvas.contains(node);
    return {
      ok: onCanvas && !blocked,
      hit: node.id || String(node.className) || node.tagName,
      blocked: blocked ? (blocked.id || String(blocked.className) || blocked.tagName) : null,
    };
  })()`);
  if (!hit?.ok) throw new Error(`${label} missed the canvas ${JSON.stringify(hit)}`);
}

async function pointForLngLat(send, lng, lat) {
  return evaluate(send, `(() => {
    const map = window.__opdMap;
    if (!map) return { ok: false, reason: 'no map' };
    const canvas = map.getCanvas();
    const center = map.getCenter();
    let lng = ${lng};
    if (center && Number.isFinite(center.lng)) {
      while (lng - center.lng > 180) lng -= 360;
      while (center.lng - lng > 180) lng += 360;
    }
    const projected = map.project([lng, ${lat}]);
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
    else if (feature === 'map') notes.push(await driveMap(send, evidenceDir, meta, baseUrl, viewport));
    else if (feature === 'iss') notes.push(await driveIss(send, evidenceDir, viewport, baseUrl));
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
  const names = new Set(selectedSurfaceNames());
  const notes = [];
  for (const spec of WEBKIT_DEVICES.filter((entry) => names.has(entry.slug))) {
    const browser = await launchWebkit();
    try {
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
    } finally {
      await browser.close();
    }
  }
  return notes;
}

export async function driveFeatures({ baseUrl, evidenceDir, meta, features }) {
  mkdirSync(evidenceDir, { recursive: true });
  const home = resolve(evidenceDir, '..');
  const names = new Set(selectedSurfaceNames());
  const notes = [];
  if (names.has('desktop')) notes.push(...await driveChrome({ baseUrl, evidenceDir, meta, features, home }));
  if (WEBKIT_DEVICES.some((spec) => names.has(spec.slug))) {
    notes.push(...await driveWebkitSurfaces({ baseUrl, evidenceDir, meta, features, home }));
  }
  return notes;
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
  const tle = await proveStaleTle(send, evidenceDir, baseUrl);
  const held = await proveHeldSignIn(send, evidenceDir, baseUrl);
  return `banner: ${text.trim()}, queue ${queueBanner.position}, tle ${tle}, held ${held}`;
}

async function setTleCookie(send, stale) {
  const assignment = stale
    ? `document.cookie = 'opd-verify-tle=stale; path=/'`
    : `document.cookie = 'opd-verify-tle=; path=/; max-age=0'`;
  await evaluate(send, assignment);
}

async function proveStaleTle(send, evidenceDir, baseUrl) {
  const suffix = 'TLE 72h old — live track may drift';
  await setTleCookie(send, true);
  await send('Page.navigate', { url: `${baseUrl}/?e2e&u=anil` });
  const shown = await waitFor(
    send,
    `(() => {
      const banner = document.getElementById('status-banner');
      const text = banner ? banner.textContent || '' : '';
      if (!text.includes('Last updated') || !text.includes(${JSON.stringify(suffix)})) return null;
      if (!banner.classList.contains('banner-orange')) return null;
      return { ok: true, text };
    })()`,
    'stale TLE banner',
    30000,
  );
  const before = shown.text;
  await sleep(1200);
  const afterTick = await evaluate(send, `document.getElementById('status-banner').textContent`);
  if (afterTick !== before) throw new Error(`countdown dropped the TLE suffix: ${afterTick}`);
  await shot(send, evidenceDir, 'banner-tle');
  await setTleCookie(send, false);
  await send('Page.navigate', { url: `${baseUrl}/?e2e&u=anil` });
  await waitFor(
    send,
    `(() => {
      const text = document.getElementById('status-banner')?.textContent || '';
      if (!text.includes('Last updated') || text.includes('TLE 72h old')) return null;
      return { ok: true };
    })()`,
    'banner after stale TLE',
    30000,
  );
  return '72h held';
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
      if (width === 834 && height === 1194) {
        const pans = await panTopbarFromLeft(send);
        panned = pans.kp;
        issPanned = pans.iss;
        await shot(send, evidenceDir, 'topbar-pan-left');
        if (!(panned > 40) || !(issPanned > 40)) {
          throw new Error(`wide bar did not pan from the left chips: ${JSON.stringify(pans)}`);
        }
      }
      if (width === 402 && height === 874) {
        const tabPan = await panScrollerFrom(send, '.tabs', '#tab-queue');
        if (!(tabPan > 8)) throw new Error(`phone tab row did not pan: ${tabPan}`);
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
      if (width === 834 && reach.barScrollWidth <= reach.barClientWidth) {
        throw new Error(`wide topbar did not scroll at ${width}x${height}: ${JSON.stringify(reach)}`);
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
    const timeStrip = document.querySelector('.map-command');
    const toggle = document.getElementById('map-chrome-toggle');
    const banner = document.getElementById('status-banner');
    const tab = document.getElementById('tab-map');
    if (!toolbar || !timeStrip || !toggle || !banner || !tab) return null;
    const toggleBox = toggle.getBoundingClientRect();
    return {
      hidden: document.body.classList.contains('map-chrome-hidden'),
      pane: document.getElementById('map-pane')?.classList.contains('map-chrome-hidden') === true,
      toolbar: getComputedStyle(toolbar).display,
      timeStrip: getComputedStyle(timeStrip).display,
      label: (toggle.textContent || '').trim(),
      expanded: toggle.getAttribute('aria-expanded'),
      toggleW: toggleBox.width,
      toggleH: toggleBox.height,
      right: getComputedStyle(toggle).right,
      minWidth: getComputedStyle(toggle).minWidth,
      minHeight: getComputedStyle(toggle).minHeight,
      rightGap: document.getElementById('map-pane').getBoundingClientRect().right - toggleBox.right,
      banner: getComputedStyle(banner).display,
      tab: getComputedStyle(tab).display,
    };
  })()`);
  if (!state?.hidden || !state.pane || state.toolbar !== 'none' || state.timeStrip !== 'none' || state.label !== 'Controls' || state.expanded !== 'false') {
    throw new Error(`map chrome should be hidden ${JSON.stringify(state)}`);
  }
  assertHideControlBox(state, 'hidden');
  if (state.banner === 'none' || state.tab === 'none') throw new Error(`shell hidden with the map chrome ${JSON.stringify(state)}`);
}

function assertHideControlBox(box, label) {
  if (!box || box.minWidth !== '88px' || box.minHeight !== '44px' || box.right !== '12px') {
    throw new Error(`hide control box ${label} ${JSON.stringify(box)}`);
  }
  const width = box.width ?? box.toggleW;
  const height = box.height ?? box.toggleH;
  if (width < 88 || height < 44) throw new Error(`hide control size ${label} ${JSON.stringify(box)}`);
  if (Math.abs(box.rightGap - 12) > 1) throw new Error(`hide control offset ${label} ${JSON.stringify(box)}`);
}

async function showMapChrome(send) {
  await click(send, '#map-chrome-toggle');
  await waitFor(
    send,
    `(() => {
      const toolbar = document.querySelector('.map-toolbar');
      const timeStrip = document.querySelector('.map-command');
      const toggle = document.getElementById('map-chrome-toggle');
      if (!toolbar || !timeStrip || !toggle) return null;
      if (document.body.classList.contains('map-chrome-hidden')) return null;
      if (getComputedStyle(toolbar).display === 'none') return null;
      if (getComputedStyle(timeStrip).display === 'none') return null;
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
    const tabs = document.querySelector('.tabs');
    const badge = document.getElementById('profile-badge');
    const readout = document.getElementById('live-readout');
    if (!bar || !tabs || !badge || !readout) return null;
    badge.hidden = false;
    badge.textContent = '👤 anilsamoilenko-astro';
    const narrow = window.innerWidth <= 700 && window.innerHeight > 520;
    if (narrow) {
      const toggle = document.getElementById('live-readout-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      if (readout.hidden) return null;
    }
    const shown = (el) => {
      let node = el;
      while (node && node !== document.documentElement) {
        if (node.hidden) return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        node = node.parentElement;
      }
      return true;
    };
    const selectors = ['#tab-queue', '#tab-upcoming', '#tab-map', '#tab-iss', '#tab-profile', '#tab-log', '#kp-widget', '#profile-badge'];
    const targets = selectors
      .map((sel) => document.querySelector(sel))
      .filter((el) => el && shown(el));
    const tabsScroll = getComputedStyle(tabs).overflowX === 'auto' || getComputedStyle(tabs).overflowX === 'scroll';
    const scrollerFor = (el) => {
      if (tabs.contains(el) && tabsScroll) return tabs;
      if (narrow && readout.contains(el)) return readout;
      return bar;
    };
    const misses = [];
    for (const el of targets) {
      const scroller = scrollerFor(el);
      scroller.scrollLeft = 0;
      let rect = el.getBoundingClientRect();
      const start = scroller.getBoundingClientRect();
      if (rect.left < start.left - 1 || rect.right > start.right + 1) {
        scroller.scrollLeft += rect.left - start.left;
        rect = el.getBoundingClientRect();
      }
      const current = scroller.getBoundingClientRect();
      const fully = rect.width >= 44 && rect.height >= 44 && rect.left >= current.left - 1 && rect.right <= current.right + 1 && rect.top >= current.top - 1 && rect.bottom <= current.bottom + 8;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 22));
      const owner = hit && hit.closest(selectors.join(','));
      if (!fully || owner !== el) {
        misses.push({ id: el.id, fully, hit: owner ? owner.id : (hit && hit.className) || null, scroll: scroller.scrollLeft });
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
    const phoneNav = narrow;
    const scrollWidth = phoneNav ? tabs.scrollWidth : bar.scrollWidth;
    const clientWidth = phoneNav ? tabs.clientWidth : bar.clientWidth;
    bar.scrollLeft = 0;
    tabs.scrollLeft = 0;
    return { ok: true, scrollWidth, clientWidth, barScrollWidth: bar.scrollWidth, barClientWidth: bar.clientWidth };
  })()`;
}

async function tapTopbarControl(send, selector) {
  const point = await evaluate(send, `(() => {
    const bar = document.querySelector('.topbar');
    const tabs = document.querySelector('.tabs');
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!bar || !el) return null;
    const scroller = tabs && tabs.contains(el) ? tabs : bar;
    scroller.scrollLeft = 0;
    let rect = el.getBoundingClientRect();
    const start = scroller.getBoundingClientRect();
    if (rect.left < start.left - 1 || rect.right > start.right + 1) {
      scroller.scrollLeft += rect.left - start.left;
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

async function panScrollerFrom(send, scrollerSelector, elementId) {
  const start = await evaluate(send, `(() => {
    const bar = document.querySelector(${JSON.stringify(scrollerSelector)});
    const chip = document.querySelector(${JSON.stringify(elementId)});
    if (!bar || !chip || chip.hidden) return null;
    bar.scrollLeft = 0;
    const barBox = bar.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    const x = Math.round(chipBox.left + Math.min(chipBox.width / 2, 22));
    const y = Math.round(chipBox.top + chipBox.height / 2);
    if (x >= barBox.left + barBox.width / 2) return { side: 'right', x, mid: barBox.left + barBox.width / 2 };
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit.closest(${JSON.stringify(elementId)}) !== chip) return { hit: hit && (hit.id || hit.className), x, y };
    return { ok: true, x, y, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth };
  })()`);
  if (!start?.ok) throw new Error(`pan start ${elementId} ${JSON.stringify(start)}`);
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
  const moved = await evaluate(send, `document.querySelector(${JSON.stringify(scrollerSelector)}).scrollLeft`);
  const room = start.scrollWidth - start.clientWidth;
  const need = Math.min(40, Math.max(8, room - 2));
  if (!(moved >= need)) throw new Error(`${elementId} drag scrolled ${moved} of ${room} from ${JSON.stringify(start)}`);
  await evaluate(send, `document.querySelector(${JSON.stringify(scrollerSelector)}).scrollLeft = 0`);
  return moved;
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
      const shared = localStorage.getItem('opd_target_filter_v1');
      const queue = localStorage.getItem('opd_queue_filter_v1');
      if (!empty || empty.hidden || !empty.textContent.includes('your targets')) return null;
      if (shared !== 'mine' || queue !== 'mine') return { shared, queue };
      return { ok: true };
    })()`,
    'mine filter empty',
  );
  await shot(send, evidenceDir, 'queue-mine');
  await click(send, '#filter-launches-queue');
  await waitFor(
    send,
    `(() => {
      const cards = document.getElementById('cards')?.innerText || '';
      const empty = document.getElementById('empty');
      const active = [...document.querySelectorAll('#queue-pane .filter-btn.active')].map((button) => button.id);
      if (cards.includes(${JSON.stringify(meta.names.queue[0])}) || cards.includes(${JSON.stringify(meta.names.queue[1])})) return null;
      if (active.length !== 1 || active[0] !== 'filter-launches-queue') return null;
      const shared = localStorage.getItem('opd_target_filter_v1');
      const queue = localStorage.getItem('opd_queue_filter_v1');
      if (queue !== 'launches' || shared !== 'mine') return { shared, queue };
      const emptyOk = empty && !empty.hidden && /launch/i.test(empty.textContent || '');
      const launchOk = cards.includes(${JSON.stringify(meta.names.launch)});
      return emptyOk || launchOk ? { ok: true } : null;
    })()`,
    'launches filter',
  );
  await shot(send, evidenceDir, 'queue-launches');
  await click(send, '#filter-all-queue');
  await waitFor(
    send,
    `(() => {
      const text = document.getElementById('cards')?.innerText || '';
      const active = [...document.querySelectorAll('#queue-pane .filter-btn.active')].map((button) => button.id);
      const shared = localStorage.getItem('opd_target_filter_v1');
      const queue = localStorage.getItem('opd_queue_filter_v1');
      const cardsBack = text.includes(${JSON.stringify(meta.names.queue[0])}) && text.includes(${JSON.stringify(meta.names.queue[1])});
      if (!cardsBack || active.length !== 1 || active[0] !== 'filter-all-queue' || shared !== 'all' || queue !== 'all') return null;
      return { ok: true };
    })()`,
    'all filter',
  );
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
  const reefName = meta.names.queue[0];
  const partial = await evaluate(send, `(() => {
    const empty = document.getElementById('empty');
    const cards = document.getElementById('cards');
    const text = cards?.innerText || '';
    return {
      ok: !!empty && empty.hidden === true && !!cards && cards.childElementCount > 0 && text.includes(${JSON.stringify(reefName)}) && !text.includes(${JSON.stringify(meta.names.queue[1])}),
      hidden: empty ? empty.hidden : null,
      count: cards ? cards.childElementCount : null,
    };
  })()`);
  if (!partial?.ok) throw new Error(`hiding one queue card showed #empty ${JSON.stringify(partial)}`);
  await shot(send, evidenceDir, 'queue-hide');
  const reefId = await hideNamed(send, '#cards', reefName);
  const emptied = await waitFor(
    send,
    `(() => {
      const empty = document.getElementById('empty');
      const cards = document.getElementById('cards');
      if (!empty || empty.hidden || !cards || cards.childElementCount !== 0) return null;
      const text = (empty.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text !== 'No passes in the next 90 minutes.') return null;
      return { ok: true, text };
    })()`,
    'queue empty on last hide',
  );
  await click(send, '#tab-queue');
  const visibleEmpty = await waitFor(
    send,
    `(() => {
      const view = document.getElementById('view');
      const empty = document.getElementById('empty');
      if (!view || !empty) return { view: view ? view.className : null };
      if (view.className !== 'view-queue' || empty.hidden) return { view: view.className, hidden: empty.hidden };
      empty.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = empty.getBoundingClientRect();
      const text = (empty.textContent || '').replace(/\\s+/g, ' ').trim();
      const inView = text === 'No passes in the next 90 minutes.' && rect.height >= 8 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
      return inView ? { ok: true, text, top: Math.round(rect.top), bottom: Math.round(rect.bottom) } : { view: view.className, hidden: empty.hidden, h: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom), text };
    })()`,
    'queue empty in view',
    10000,
  );
  await shot(send, evidenceDir, 'queue-empty');
  await waitServerRemoved(baseUrl, [deltaId, reefId], []);
  const restoredAt = new Date().toISOString();
  const restoredIds = await evaluate(send, `(() => {
    const key = 'opd-profile-anil';
    const profile = JSON.parse(localStorage.getItem(key) || '{}');
    const ids = Array.isArray(profile.removedCuratedIds) ? profile.removedCuratedIds : [];
    profile.removedCuratedIds = ids.filter((id) => id !== ${JSON.stringify(reefId)});
    profile.removedCuratedUpdatedAt = ${JSON.stringify(restoredAt)};
    localStorage.setItem(key, JSON.stringify(profile));
    return profile.removedCuratedIds;
  })()`);
  if (!Array.isArray(restoredIds) || restoredIds.includes(reefId) || !restoredIds.includes(deltaId)) {
    throw new Error(`queue restore ids ${JSON.stringify(restoredIds)}`);
  }
  const put = await fetch(`${baseUrl}/api/browser/profiles/anil/targets`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ removedCuratedIds: restoredIds, removedCuratedUpdatedAt: restoredAt }),
  });
  if (!put.ok) throw new Error(`queue restore PUT ${put.status}`);
  await waitServerRemoved(baseUrl, [deltaId], [reefId]);
  await reloadSettled(send);
  await waitFor(
    send,
    `(() => {
      const empty = document.getElementById('empty');
      const text = document.getElementById('cards')?.innerText || '';
      if (!empty || !empty.hidden) return null;
      if (!text.includes(${JSON.stringify(reefName)}) || text.includes(${JSON.stringify(meta.names.queue[1])})) return null;
      return { ok: true };
    })()`,
    'queue restored Verify Reef',
    30000,
  );
  return `queue: cards, score, remind, shoot, mine writes opd_target_filter_v1, launches leaves it, keepsake, hide, empty (${emptied.text})`;
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

function rgbaChannels(color) {
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(String(color || ''));
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function timeStripShowsGround(color) {
  const parsed = rgbaChannels(color);
  if (!parsed) return false;
  return parsed.r === 16 && parsed.g === 22 && parsed.b === 28 && parsed.a < 1 && Math.abs(parsed.a - 0.55) <= 0.02;
}

function paintIsClear(color) {
  if (color === 'transparent') return true;
  const parsed = rgbaChannels(color);
  return !!parsed && parsed.a === 0;
}

async function proveMapLaidOnPane(send) {
  const laid = await evaluate(send, `(() => {
    const pane = document.getElementById('map-pane');
    const map = document.getElementById('map');
    const canvas = map && map.querySelector('canvas.maplibregl-canvas');
    const strip = document.querySelector('.map-command');
    const controls = document.querySelector('.map-command .map-controls-time');
    if (!pane || !map || !canvas || !strip || !controls) return null;
    const paneStyle = getComputedStyle(pane);
    const mapStyle = getComputedStyle(map);
    const stripStyle = getComputedStyle(strip);
    const controlsStyle = getComputedStyle(controls);
    if (stripStyle.display === 'none' || controlsStyle.display === 'none') return null;
    const paneBox = pane.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    const gap = paneBox.bottom - canvasBox.bottom;
    const covers = canvasBox.top <= stripBox.top + 1
      && canvasBox.bottom + 1 >= stripBox.bottom
      && canvasBox.left <= stripBox.left + 1
      && canvasBox.right + 1 >= stripBox.right;
    return {
      gap,
      bottom: mapStyle.bottom,
      rowGap: paneStyle.rowGap,
      columnGap: paneStyle.columnGap,
      paddingTop: paneStyle.paddingTop,
      paddingRight: paneStyle.paddingRight,
      paddingBottom: paneStyle.paddingBottom,
      paddingLeft: paneStyle.paddingLeft,
      color: stripStyle.backgroundColor,
      controls: controlsStyle.backgroundColor,
      covers,
      canvasBottom: canvasBox.bottom,
      paneBottom: paneBox.bottom,
      stripTop: stripBox.top,
      stripBottom: stripBox.bottom,
    };
  })()`);
  const paddingClear = laid
    && laid.paddingTop === '0px'
    && laid.paddingRight === '0px'
    && laid.paddingBottom === '0px'
    && laid.paddingLeft === '0px';
  const gapClear = laid && laid.rowGap === '0px' && laid.columnGap === '0px';
  if (!laid || Math.abs(laid.gap) > 1 || laid.bottom !== '0px' || !gapClear || !paddingClear || !laid.covers || !timeStripShowsGround(laid.color) || !paintIsClear(laid.controls)) {
    throw new Error(`time strip not laid on the map ${JSON.stringify(laid)}`);
  }
  return laid;
}

async function driveMap(send, evidenceDir, meta, baseUrl, viewport) {
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
        issClock: !!document.querySelector('[data-iss-clock]'),
        logs: (window.__opdLogs || []).slice(-8),
        mapHtml: (document.getElementById('map')?.innerHTML || '').slice(0, 180),
      };
      if (status.map && status.marker && status.legend && status.badge && String(status.badge).trim() && status.track && !status.issClock) {
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
  const laid = await proveMapLaidOnPane(send);
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
  await assertMapInfoControlsGone(send);
  await assertChromeToggleStationary(send);
  await shot(send, evidenceDir, 'map-controls');
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
  await waitFor(
    send,
    `(() => {
      const panel = document.getElementById('satellite-picker-panel');
      return !panel || panel.hidden ? { ok: true } : null;
    })()`,
    'satellite picker closed',
  );
  await frameLngLat(send, meta.reef.lon, meta.reef.lat, 4);
  await waitFor(
    send,
    `(() => {
      const map = window.__opdMap;
      if (!map || !map.project || !map.queryRenderedFeatures) return null;
      const projected = map.project([${meta.reef.lon}, ${meta.reef.lat}]);
      const canvas = map.getCanvas();
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = rect.left + projected.x;
      const y = rect.top + projected.y;
      const node = document.elementFromPoint(x, y);
      const onCanvas = node === canvas || canvas.contains(node);
      const layers = ['targets-layer', 'my-targets-layer'].filter((id) => map.getLayer(id));
      const pad = 7;
      const hits = layers.length
        ? map.queryRenderedFeatures([[projected.x - pad, projected.y - pad], [projected.x + pad, projected.y + pad]], { layers })
        : [];
      const reef = hits.some((feature) => feature.properties && feature.properties.target_id === 'verify-reef');
      if (!onCanvas || !reef) {
        return {
          hit: node ? (node.id || String(node.className) || node.tagName) : null,
          onCanvas,
          reef,
          hits: hits.length,
        };
      }
      return { ok: true };
    })()`,
    'reef pin ready',
    15000,
  );
  const reefPoint = await pointForLngLat(send, meta.reef.lon, meta.reef.lat);
  if (!reefPoint?.ok) throw new Error('could not project Verify Reef');
  await assertCanvasHit(send, reefPoint.x, reefPoint.y, 'target popup');
  await mouseClick(send, reefPoint.x, reefPoint.y);
  await waitFor(
    send,
    `document.querySelector('.maplibregl-popup')?.innerText.includes('Verify Reef') ? { ok: true } : null`,
    'target popup',
    10000,
  );
  await shot(send, evidenceDir, 'map-target-popup');
  const drop = await pointForLngLat(send, meta.delta.lon, meta.delta.lat);
  if (!drop?.ok) throw new Error('could not project the pin-drop point');
  await assertCanvasHit(send, drop.x, drop.y, 'pin drop');
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
  await proveMapShowLaunches(send, evidenceDir);
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
  await proveProfileMenuRoundTrip(send, evidenceDir, viewport);
  return `map: globe, legend, imagery, hide control 88x44 at 12px, time strip ${laid.color} gap ${laid.gap}px, tool rail, picker, target popup, pin drop, launch dialog, hidden pin, chrome persisted, profile menu round trip`;
}

function myTargetNamesExpr() {
  return `(() => {
    const source = window.__opdMap && window.__opdMap.getSource && window.__opdMap.getSource('my-targets');
    const serialized = source && source.serialize ? source.serialize().data : null;
    const features = serialized && serialized.features ? serialized.features : null;
    if (!features) return null;
    return features.map((feature) => feature.properties && feature.properties.target_name).filter(Boolean);
  })()`;
}

async function proveProfileMenuRoundTrip(send, evidenceDir, viewport, shotSuffix = '') {
  const name = (base) => (shotSuffix ? `${base}-${shotSuffix}` : base);
  await click(send, '#tab-queue');
  await waitFor(
    send,
    `document.getElementById('tab-queue')?.classList.contains('active') && document.getElementById('view')?.className === 'view-queue' ? { ok: true } : null`,
    'queue before profile menu',
    20000,
  );
  await click(send, '#profile-badge');
  await waitFor(
    send,
    `(() => {
      const menu = document.getElementById('profile-menu');
      if (!menu || !menu.matches(':popover-open')) return null;
      const rows = [...menu.querySelectorAll('.profile-menu-item')].map((row) => ({
        name: row.dataset.profile,
        text: row.textContent,
        home: row.hasAttribute('data-profile-home'),
        current: row.getAttribute('aria-current'),
      }));
      const home = rows[0];
      if (!home || !home.home || home.text !== 'Anil' || home.current === 'true') return null;
      if (!rows.some((row) => row.name === 'watkins' && row.text === 'Jessica Watkins (Watty)')) return null;
      return { ok: true, count: rows.length };
    })()`,
    'profile menu lists Anil above the crew',
    10000,
  );
  await shot(send, evidenceDir, name('profile-menu-anil'));
  await click(send, '#profile-menu [data-profile="watkins"]');
  await waitForHref(send, /[?&]u=watkins(?:&|#|$)/, 'watkins profile url');
  await waitFor(
    send,
    `(() => {
      const banner = document.getElementById('status-banner');
      const text = banner ? banner.textContent || '' : '';
      if (!banner || text.includes('Loading')) return null;
      if (!document.getElementById('tab-queue')?.classList.contains('active')) return null;
      if (document.getElementById('view')?.className !== 'view-queue') return null;
      const badge = document.querySelector('#profile-badge .profile-badge-name')?.textContent;
      if (badge !== 'Jessica Watkins (Watty)') return null;
      if (new URL(location.href).searchParams.get('u') !== 'watkins') return null;
      return { ok: true };
    })()`,
    'queue restored on Watkins',
    30000,
  );
  await click(send, '#tab-map');
  await waitFor(
    send,
    `(() => {
      if (document.getElementById('view')?.className !== 'view-map') return null;
      const legend = document.getElementById('personal-targets-legend')?.textContent;
      if (legend !== "Jessica Watkins (Watty)'s targets") return null;
      const names = ${myTargetNamesExpr()};
      if (!names || !names.includes('Lafayette, Colorado hometown') || names.length !== 12) return null;
      return { ok: true, legend, count: names.length };
    })()`,
    'Watkins legend and sites',
    45000,
  );
  await evaluate(send, `(() => { const toggle = document.getElementById('map-chrome-toggle'); if (toggle && (toggle.textContent || '').trim() === 'Controls') toggle.click(); })()`);
  await shot(send, evidenceDir, name('profile-legend-watkins'));
  await click(send, '#profile-badge');
  await waitFor(
    send,
    `(() => {
      const menu = document.getElementById('profile-menu');
      if (!menu || !menu.matches(':popover-open')) return null;
      const home = menu.querySelector('[data-profile-home]');
      const watkins = menu.querySelector('[data-profile="watkins"]');
      if (!home || home.textContent !== 'Anil' || home.getAttribute('aria-current') === 'true') return null;
      if (watkins?.getAttribute('aria-current') !== 'true') return null;
      return { ok: true };
    })()`,
    'profile menu marks Watkins',
    10000,
  );
  await shot(send, evidenceDir, name('profile-menu-watkins'));
  await click(send, '#profile-menu [data-profile-home]');
  await waitForHref(send, /\?e2e=(?:#|$)/, 'anil profile url');
  await waitFor(
    send,
    `(() => {
      const banner = document.getElementById('status-banner');
      const text = banner ? banner.textContent || '' : '';
      if (!banner || text.includes('Loading')) return null;
      if (new URL(location.href).searchParams.has('u')) return null;
      if (!document.getElementById('tab-map')?.classList.contains('active')) return null;
      if (document.getElementById('view')?.className !== 'view-map') return null;
      const badge = document.querySelector('#profile-badge .profile-badge-name')?.textContent;
      if (badge !== 'Anil') return null;
      const legend = document.getElementById('personal-targets-legend')?.textContent;
      if (legend !== "Anil's targets") return null;
      const names = ${myTargetNamesExpr()};
      if (!names || names.includes('Lafayette, Colorado hometown')) return null;
      return { ok: true, legend, count: names.length };
    })()`,
    'map restored on Anil',
    45000,
  );
  await shot(send, evidenceDir, name('profile-legend-anil'));
  if (!shotSuffix && viewport && viewport.width === 402 && viewport.height === 874) {
    await setViewport(send, 874, 402, true);
    await proveProfileMenuRoundTrip(send, evidenceDir, { width: 874, height: 402, mobile: true }, 'land');
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
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

async function driveIss(send, evidenceDir, viewport, baseUrl) {
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
      if ((hint?.textContent || '') !== 'Pinch or scroll the field') return null;
      if (document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('title') !== 'Horizon aim') return null;
      if (document.querySelector('[data-iss-preset="nadir"]')?.getAttribute('title') !== 'Aim straight down') return null;
      if (cupola.getAttribute('title') !== 'Window field of view') return null;
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
  const clock = await proveIssClock(send);
  const edition = await proveIssEdition(send, evidenceDir);
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
  const launchLook = await proveIssLaunchLook(send, evidenceDir, baseUrl);
  await click(send, '[data-iss-preset="horizon"]');
  await waitFor(
    send,
    `document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed') === 'true' ? { ok: true } : null`,
    'iss horizon after launch look',
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
  await proveIssWindowField(send, evidenceDir);
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
  await proveIssClock(send);
  await shot(send, evidenceDir, 'iss-nadir');
  await click(send, '#tab-map');
  await waitFor(
    send,
    `document.getElementById('view')?.className === 'view-map' && !document.querySelector('[data-iss-scene]') && !document.querySelector('[data-iss-clock]') ? { ok: true } : null`,
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
  await proveIssClockCleared(send, evidenceDir);
  return `iss: horizon then straight down, map and queue still open, session kept nadir, landscape telemetry held, edition ${edition}, launch look (${launchLook}), fov ${zoomed.toFixed(1)}°, fov live, pan held, pan kept, fov held, windows 1-6 aimed, window kept, window field, aim restored, storage cleared, keyboard aim, cupola keys, preset keys, profile menu escape, keys help, letter pan, fine pan, aim link (${String(horizon.text).slice(0, 80)}), clock lines ${clock.houston} ${clock.gmt} ${clock.dayMonth} ${clock.weekday}, clock after tick, clock after aim, clock cleared`;
}

async function proveIssClock(send) {
  return waitFor(send, ISS_CLOCK_EXPR, 'iss clock lines', 15000);
}

async function proveIssClockCleared(send, evidenceDir) {
  await evaluate(send, `document.cookie = 'opd-verify-tle=missing; path=/'`);
  try {
    await reloadSettled(send);
    await click(send, '#tab-iss');
    await waitFor(
      send,
      `(() => {
        const status = document.querySelector('[data-iss-status]')?.textContent || '';
        if (!status.includes('Orbit unavailable')) return null;
        const root = document.querySelector('[data-iss-clock]');
        if (!root || root.children.length !== 5) return { step: 'block' };
        const sels = ['[data-iss-utc]', '[data-iss-houston]', '[data-iss-gmt-day]', '[data-iss-day-month]', '[data-iss-weekday]'];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (!el || (el.textContent || '') !== '') return { step: 'text', sel, text: el ? el.textContent : null };
        }
        if (document.querySelector('[data-iss-houston]')?.getBoundingClientRect().height > 0) return { step: 'painted' };
        return { ok: true, status: status.slice(0, 80) };
      })()`,
      'iss clock cleared',
      45000,
    );
    await shot(send, evidenceDir, 'iss-clock-cleared');
  } finally {
    await evaluate(send, `document.cookie = 'opd-verify-tle=; path=/; max-age=0'`);
  }
  await reloadSettled(send);
}

const ISS_EDITION_EXPR = `(() => {
  const edition = document.querySelector('[data-iss-edition]');
  const help = document.querySelector('[data-iss-aim-help]');
  const horizon = document.querySelector('[data-iss-preset="horizon"]');
  const frame = document.querySelector('[data-iss-frame]');
  const toolbar = document.querySelector('[data-iss-toolbar]');
  if (!(edition instanceof HTMLParagraphElement) || !help || !horizon || !frame || !toolbar) return null;
  if (edition.textContent !== 'Expedition 75 Beta Edition') return null;
  if (frame.contains(edition)) return null;
  if (help.getAttribute('aria-label') !== 'Keyboard shortcuts') return null;
  const style = getComputedStyle(edition);
  const editionBox = edition.getBoundingClientRect();
  const helpBox = help.getBoundingClientRect();
  const aimBox = horizon.getBoundingClientRect();
  if (editionBox.width < 8 || editionBox.height < 8) return null;
  const wide = window.innerWidth > 720;
  if (wide) {
    if (style.position !== 'absolute') return { step: 'wide-position', position: style.position, width: window.innerWidth };
    if (editionBox.top < helpBox.bottom - 2) return { step: 'wide-below-help', editionTop: editionBox.top, helpBottom: helpBox.bottom };
    if (Math.abs(editionBox.left - helpBox.left) > 8) return { step: 'wide-left', editionLeft: editionBox.left, helpLeft: helpBox.left };
    if (editionBox.left >= aimBox.left - 1) return { step: 'wide-aim', editionLeft: editionBox.left, aimLeft: aimBox.left };
    return { ok: true, place: 'under-help', width: window.innerWidth };
  }
  if (style.position !== 'static') return { step: 'narrow-position', position: style.position, width: window.innerWidth };
  const others = [...toolbar.children].filter((node) => node !== edition && node.getBoundingClientRect().height > 0);
  if (!others.length) return { step: 'narrow-siblings' };
  const lowest = Math.max(...others.map((node) => node.getBoundingClientRect().bottom));
  if (editionBox.top < lowest - 2) return { step: 'narrow-row', editionTop: editionBox.top, lowest, width: window.innerWidth };
  return { ok: true, place: 'last-row', width: window.innerWidth };
})()`;

async function proveIssEdition(send, evidenceDir) {
  const placed = await waitFor(send, ISS_EDITION_EXPR, 'iss edition line', 10000);
  const seen = await revealInView(send, '[data-iss-edition]');
  if (!seen.text.includes('Expedition 75 Beta Edition')) {
    throw new Error(`edition shot would miss the line ${JSON.stringify(seen)}`);
  }
  await shot(send, evidenceDir, 'iss-edition');
  return placed.place;
}

async function proveMapShowLaunches(send, evidenceDir) {
  await revealInView(send, '#filter-launches-map');
  await waitFor(
    send,
    `(() => {
      const group = document.querySelector('.map-controls-filter');
      const label = group && group.querySelector('.map-group-label');
      const button = document.getElementById('filter-launches-map');
      if (!group || !label || !button || !group.contains(button)) return null;
      if ((label.textContent || '').trim() !== 'Show') return { step: 'label', text: label.textContent };
      if ((button.textContent || '').trim() !== 'Launches') return { step: 'button', text: button.textContent };
      const style = getComputedStyle(button);
      if (style.whiteSpace !== 'nowrap' || Number(style.flexShrink) !== 0) {
        return { step: 'style', whiteSpace: style.whiteSpace, flexShrink: style.flexShrink };
      }
      if (button.scrollWidth > button.clientWidth + 1) {
        return { step: 'overflow', scrollWidth: button.scrollWidth, clientWidth: button.clientWidth };
      }
      const box = button.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(button);
      const text = range.getBoundingClientRect();
      if (text.width < 8 || text.height < 4) return null;
      if (text.left < box.left - 1 || text.right > box.right + 1 || text.top < box.top - 1 || text.bottom > box.bottom + 1) {
        return {
          step: 'text-box',
          textLeft: text.left,
          textRight: text.right,
          boxLeft: box.left,
          boxRight: box.right,
        };
      }
      return { ok: true };
    })()`,
    'launches label inside show button',
    10000,
  );
  await shot(send, evidenceDir, 'map-show-launches');
}

async function proveIssLaunchLook(send, evidenceDir, baseUrl) {
  const before = await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      const telemetry = document.querySelector('[data-iss-telemetry]');
      const frame = document.querySelector('[data-iss-frame]');
      if (!(picker instanceof HTMLSelectElement) || !telemetry || !frame) return null;
      const option = [...picker.options].find((entry) => entry.textContent?.includes('Verify Pad'));
      if (!option || picker.value) return null;
      if (document.querySelector('[data-iss-launch], .iss-launch-pin, [data-iss-launch-edge]')) return null;
      if (frame.getAttribute('data-iss-launch-corridor') === 'on') return null;
      const box = picker.getBoundingClientRect();
      const t = telemetry.getBoundingClientRect();
      if (box.width < 44 || box.height < 44 || t.width < 44) return null;
      const controls = picker.closest('[data-iss-controls]');
      if (!controls || !controls.contains(telemetry)) return null;
      const center = window.__opdIss?.getCenter?.();
      if (!center) return null;
      return { ok: true, lng: center.lng, lat: center.lat, value: option.value };
    })()`,
    'iss launch picker',
    15000,
  );
  await evaluate(send, `(() => {
    const picker = document.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) return false;
    picker.value = ${JSON.stringify(before.value)};
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    return picker.value;
  })()`);
  const selected = await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      const button = document.querySelector('[data-iss-launch]');
      const frame = document.querySelector('[data-iss-frame]');
      const card = document.querySelector('[data-iss-launch-card]');
      if (!(picker instanceof HTMLSelectElement) || !button || !frame || !card) return null;
      if (picker.value !== ${JSON.stringify(before.value)}) return null;
      if (button.querySelector('[data-iss-launch-label]')?.textContent !== 'Look toward Verify Pad') return null;
      if (!button.textContent.includes('Verify Pad')) return null;
      const scene = button.closest('[data-iss-scene]');
      if (scene && scene.scrollWidth > scene.clientWidth + 1) return null;
      if (card.hasAttribute('hidden')) return null;
      const name = card.querySelector('[data-iss-launch-name]')?.textContent || '';
      const site = card.querySelector('[data-iss-launch-site]')?.textContent || '';
      const timeLabel = card.querySelector('[data-iss-launch-time-label]')?.textContent || '';
      const timeValue = card.querySelector('[data-iss-launch-time-value]')?.textContent || '';
      if (name !== 'Verify Ascent' || site !== 'Verify Pad') return null;
      if (timeLabel !== 'Launch window' && timeLabel !== 'NET, tentative') return null;
      if (!timeValue) return null;
      const arrow = button.querySelector('[data-iss-launch-arrow]');
      const aim = arrow instanceof HTMLElement ? arrow.style.getPropertyValue('--iss-launch-aim') : '';
      if (!/^-?\\d+\\.\\d+deg$/.test(aim)) return null;
      if (frame.getAttribute('data-iss-launch-corridor') !== 'on') return null;
      const visibility = card.querySelector('[data-iss-launch-visibility]')?.textContent || '';
      const mark = document.querySelector('.iss-launch-pin, [data-iss-launch-edge]');
      if (visibility === 'Site below horizon') {
        if (mark) return null;
      } else if (visibility === 'Site in frame' || visibility === 'Site outside frame') {
        if (!mark) return null;
      } else {
        return null;
      }
      const b = button.getBoundingClientRect();
      const frameBox = frame.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      if (b.width < 44 || b.height < 44) return null;
      const covers = (box) => box.left < frameBox.right - 1 && box.right > frameBox.left + 1 && box.top < frameBox.bottom - 1 && box.bottom > frameBox.top + 1;
      if (covers(b) || covers(cardBox)) return null;
      const center = window.__opdIss?.getCenter?.();
      if (!center) return null;
      const moved = Math.hypot(center.lng - ${Number(before.lng)}, center.lat - ${Number(before.lat)});
      if (!(moved < 0.15)) return null;
      return { ok: true, lng: center.lng, lat: center.lat, name, site, timeLabel, timeValue, visibility, held: moved };
    })()`,
    'iss launch selected',
    15000,
  );
  const siteShot = await revealInView(send, '[data-iss-launch]');
  if (!siteShot.text.includes('Look toward Verify Pad')) {
    throw new Error(`site button shot would miss the label ${JSON.stringify(siteShot)}`);
  }
  await shot(send, evidenceDir, 'iss-launch-site');
  const cardShot = await revealInView(send, '[data-iss-launch-card]');
  if (!cardShot.text.includes(selected.name) || !cardShot.text.includes(selected.site) || !cardShot.text.includes(selected.visibility) || !cardShot.text.includes(selected.timeLabel)) {
    throw new Error(`launch card shot would miss the facts ${JSON.stringify(cardShot)}`);
  }
  await shot(send, evidenceDir, 'iss-launch-look');
  const pickerBox = await evaluate(send, `(() => {
    const picker = document.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) return null;
    const option = picker.selectedOptions[0];
    if (option) option.dataset.opdVerifyOption = 'held';
    window.__opdPickerWatch = null;
    const menuOpen = () => {
      try { return picker.matches(':open') === true; } catch { return false; }
    };
    const arm = () => {
      if (window.__opdPickerWatch) return;
      let error = '';
      try {
        if (!menuOpen()) picker.showPicker();
      } catch (thrown) {
        error = String(thrown);
      }
      const samples = [];
      const started = performance.now();
      const utc = () => document.querySelector('[data-iss-utc]')?.textContent || '';
      const sample = (kind) => samples.push({
        kind,
        t: Math.round(performance.now() - started),
        open: menuOpen(),
        value: picker.value,
        held: picker.selectedOptions[0]?.dataset.opdVerifyOption || '',
        utc: utc(),
      });
      sample('start');
      window.__opdPickerWatch = new Promise((resolve) => {
        const timer = setInterval(() => sample('tick'), 200);
        setTimeout(() => {
          clearInterval(timer);
          sample('end');
          resolve({ samples, error });
        }, 1600);
      });
    };
    window.__opdArmLaunchPicker = arm;
    picker.addEventListener('pointerdown', arm, { once: true });
    picker.addEventListener('mousedown', arm, { once: true });
    const rect = picker.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!pickerBox) throw new Error('launch picker missing before open');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pickerBox.x, y: pickerBox.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(100);
  const armedByMouse = await evaluate(send, `Boolean(window.__opdPickerWatch)`);
  if (!armedByMouse) await evaluate(send, `window.__opdArmLaunchPicker && window.__opdArmLaunchPicker()`);
  const watched = await evaluate(send, `window.__opdPickerWatch || { missing: true }`);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pickerBox.x, y: pickerBox.y, button: 'left', buttons: 0, clickCount: 1 });
  const samples = Array.isArray(watched?.samples) ? watched.samples : [];
  const sawOpen = samples.some((sample) => sample.open === true);
  const afterTick = samples.find((sample) => sample.utc && sample.utc !== samples[0]?.utc);
  if (!afterTick || afterTick.value !== before.value || afterTick.held !== 'held' || (!sawOpen && !watched?.error)) {
    throw new Error(`launch picker did not hold the selection across a clock tick ${JSON.stringify(watched)}`);
  }
  const menuNote = sawOpen ? 'menu opened' : 'menu :open not observed';
  await evaluate(send, `document.querySelector('[data-iss-launch-picker]')?.blur()`);
  await proveIssClock(send);
  await click(send, '[data-iss-launch]');
  await waitFor(
    send,
    `(() => {
      const center = window.__opdIss?.getCenter?.();
      if (!center) return null;
      const moved = Math.hypot(center.lng - ${Number(selected.lng)}, center.lat - ${Number(selected.lat)});
      if (!(moved > 0.15)) return null;
      return { ok: true, moved };
    })()`,
    'iss launch look moved',
    10000,
  );
  const aimed = await evaluate(send, `(() => {
    const center = window.__opdIss?.getCenter?.();
    return center ? { lng: center.lng, lat: center.lat } : null;
  })()`);
  if (!aimed) throw new Error('missing aim before launch loss');
  await fetch(`${baseUrl}/api/verify/launch-release`, { method: 'POST' });
  await evaluate(send, `document.cookie = 'opd-verify-launch=hold; path=/'; document.dispatchEvent(new Event('visibilitychange')); true`);
  const heldDuringDownload = `(() => {
    const picker = document.querySelector('[data-iss-launch-picker]');
    const button = document.querySelector('[data-iss-launch]');
    if (!(picker instanceof HTMLSelectElement) || !button) return null;
    if (picker.value !== ${JSON.stringify(before.value)}) return null;
    if (button.querySelector('[data-iss-launch-label]')?.textContent !== 'Look toward Verify Pad') return null;
    if (document.querySelector('[data-iss-launch-missing]')) return null;
    const card = document.querySelector('[data-iss-launch-card]');
    if (!card || card.hidden) return null;
    if ((card.textContent || '').includes('Selected launch is no longer available')) return null;
    return { ok: true, value: picker.value };
  })()`;
  const holdStarted = Date.now();
  let holdNoted = null;
  while (Date.now() - holdStarted < 15000) {
    const status = await fetch(`${baseUrl}/api/verify/launch-hold`).then((response) => response.json());
    holdNoted = await evaluate(send, heldDuringDownload);
    if (status.pending && holdNoted?.ok) {
      await sleep(500);
      const still = await fetch(`${baseUrl}/api/verify/launch-hold`).then((response) => response.json());
      const again = await evaluate(send, heldDuringDownload);
      if (still.pending && again?.ok) break;
      holdNoted = again;
    } else if (!status.pending) {
      await evaluate(send, `document.dispatchEvent(new Event('visibilitychange')); true`);
    }
    await sleep(250);
  }
  const parked = await fetch(`${baseUrl}/api/verify/launch-hold`).then((response) => response.json());
  if (!parked.pending || !holdNoted?.ok) {
    throw new Error(`launch choice moved while the newer pointer was still downloading ${JSON.stringify({ parked, holdNoted })}`);
  }
  const released = await fetch(`${baseUrl}/api/verify/launch-release`, { method: 'POST' });
  if (!released.ok) throw new Error(`launch hold release ${released.status}`);
  await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      const card = document.querySelector('[data-iss-launch-card]');
      const missing = document.querySelector('[data-iss-launch-missing]');
      if (!(picker instanceof HTMLSelectElement) || !card || card.hidden) return null;
      if (picker.value !== '' || (picker.selectedOptions[0]?.textContent || '') !== 'Choose launch') return null;
      if (missing?.textContent !== 'Selected launch is no longer available') return null;
      if ([...picker.options].some((entry) => entry.textContent === 'Selected launch is no longer available')) return null;
      if (document.querySelector('[data-iss-launch], .iss-launch-pin, [data-iss-launch-edge]')) return null;
      const frame = document.querySelector('[data-iss-frame]');
      if (!frame || frame.contains(missing) || frame.contains(card)) return null;
      const frameBox = frame.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const covers = cardBox.left < frameBox.right - 1 && cardBox.right > frameBox.left + 1 && cardBox.top < frameBox.bottom - 1 && cardBox.bottom > frameBox.top + 1;
      if (covers) return null;
      if (frame.getAttribute('data-iss-launch-corridor') === 'on') return null;
      const center = window.__opdIss?.getCenter?.();
      if (!center) return null;
      const drifted = Math.hypot(center.lng - ${Number(aimed.lng)}, center.lat - ${Number(aimed.lat)});
      if (!(drifted < 0.15)) return null;
      return { ok: true };
    })()`,
    'iss launch lost',
    20000,
  );
  const lostShot = await revealInView(send, '[data-iss-launch-missing]');
  if (!lostShot.text.includes('Selected launch is no longer available')) {
    throw new Error(`launch loss shot would miss the sentence ${JSON.stringify(lostShot)}`);
  }
  await shot(send, evidenceDir, 'iss-launch-lost');
  await evaluate(send, `document.cookie = 'opd-verify-launch=back; path=/'`);
  await waitFor(
    send,
    `(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      const picker = document.querySelector('[data-iss-launch-picker]');
      const missing = document.querySelector('[data-iss-launch-missing]');
      if (!(picker instanceof HTMLSelectElement)) return null;
      const ascent = [...picker.options].find((entry) => (entry.textContent || '').includes('Verify Ascent'));
      if (!ascent || ascent.selected) return null;
      if (picker.value !== '' || (picker.selectedOptions[0]?.textContent || '') !== 'Choose launch') return null;
      if (missing?.textContent !== 'Selected launch is no longer available') return null;
      if (document.querySelector('[data-iss-launch]')) return null;
      const frame = document.querySelector('[data-iss-frame]');
      if (frame?.getAttribute('data-iss-launch-corridor') === 'on') return null;
      return { ok: true };
    })()`,
    'iss launch returned',
    20000,
  );
  await evaluate(send, `(() => {
    const picker = document.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) return false;
    picker.value = 'none';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    return picker.value;
  })()`);
  await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      if (!(picker instanceof HTMLSelectElement) || picker.value !== '') return null;
      if ((picker.selectedOptions[0]?.textContent || '') !== 'Choose launch') return null;
      if (document.querySelector('[data-iss-launch]')) return null;
      const card = document.querySelector('[data-iss-launch-card]');
      if (card && !card.hidden) return null;
      if (document.querySelector('.iss-launch-pin, [data-iss-launch-edge]')) return null;
      const frame = document.querySelector('[data-iss-frame]');
      if (frame?.getAttribute('data-iss-launch-corridor') === 'on') return null;
      return { ok: true };
    })()`,
    'launch None cleared',
    10000,
  );
  await revealInView(send, '[data-iss-launch-picker]');
  await shot(send, evidenceDir, 'iss-launch-none');
  await reloadSettled(send);
  await click(send, '#tab-iss');
  await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      const scene = document.querySelector('[data-iss-scene]');
      if (!(picker instanceof HTMLSelectElement) || !scene) return null;
      if (picker.value !== '' || (picker.selectedOptions[0]?.textContent || '') !== 'Choose launch') return null;
      if (document.querySelector('[data-iss-launch]')) return null;
      const card = document.querySelector('[data-iss-launch-card]');
      if (card && !card.hidden) return null;
      return { ok: true };
    })()`,
    'launch choice cleared on reload',
    45000,
  );
  const choose = await revealInView(send, '[data-iss-launch-picker]');
  const chooseLabel = await evaluate(send, `document.querySelector('[data-iss-launch-picker]')?.selectedOptions?.[0]?.textContent || ''`);
  if (chooseLabel !== 'Choose launch') throw new Error(`reload shot missed Choose launch ${JSON.stringify({ choose, chooseLabel })}`);
  await shot(send, evidenceDir, 'iss-launch-reloaded');
  return `${selected.name} / ${selected.site} / ${selected.timeLabel} ${selected.timeValue} / ${selected.visibility} / aim held ${Number(selected.held).toFixed(3)}° / ${menuNote}; selection held across a UTC tick / launch held while verifyrev-hold downloaded / launch lost when that body arrived, Choose launch, notice outside the frame / launch returned on verifyrev-back, not restored / None / reload Choose launch`;
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
  const openLabel = await readFovLabel(send);
  if (!openLabel || Math.abs(openLabel.shown - before.fov) > 0.15) {
    throw new Error(`iss fov readout missing on open ${JSON.stringify({ before, openLabel })}`);
  }
  await shot(send, evidenceDir, 'iss-fov-before');
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: before.x,
    y: before.y,
    deltaX: 0,
    deltaY: -480,
  });
  const live = await readFovLabel(send);
  if (!live || !(live.shown < before.fov - 1)) throw new Error('iss fov readout missing');
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
  const stayed = await readFovLabel(send);
  if (!stayed || Math.abs(stayed.shown - held.fov) > 0.2) {
    throw new Error(`iss fov readout cleared ${JSON.stringify({ held, stayed })}`);
  }
  await shot(send, evidenceDir, 'iss-fov-after');
  return held.fov;
}

async function readFovLabel(send) {
  return evaluate(send, `(() => {
    const node = document.querySelector('[data-iss-fov]');
    if (!node || node.getAttribute('data-iss-fov-state') !== 'live') return null;
    const text = (node.textContent || '').trim();
    const shown = Number.parseFloat(text);
    if (!Number.isFinite(shown) || !text.endsWith('°')) return null;
    return { ok: true, shown, text };
  })()`);
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
    `document.getElementById('view')?.className === 'view-map' && !document.querySelector('[data-iss-scene]') && !document.querySelector('[data-iss-clock]') ? { ok: true } : null`,
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
    `document.getElementById('view')?.className === 'view-map' && !document.querySelector('[data-iss-scene]') && !document.querySelector('[data-iss-clock]') ? { ok: true } : null`,
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

async function proveIssWindowField(send, evidenceDir) {
  const baseline = await evaluate(send, `(() => {
    const map = window.__opdIss;
    const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
    if (!map?.getCenter || !map.getVerticalFieldOfView || !frame || frame.width < 40) return null;
    const center = map.getCenter();
    return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2, fov: map.getVerticalFieldOfView(), lat: center.lat, lng: center.lng };
  })()`);
  if (!baseline) throw new Error('iss window field baseline missing');
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
      if (localStorage.getItem('opd-iss-aim') !== raw) return null;
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
      if (localStorage.getItem('opd-iss-aim') !== raw) return null;
      return { ok: true, fov };
    })()`,
    'iss aim restored after reload',
    45000,
  );
  await shot(send, evidenceDir, 'iss-aim-restored');
  await evaluate(send, `document.querySelector('[data-iss-frame]')?.focus()`);
  await pressKey(send, 'r');
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
      if (localStorage.getItem('opd-iss-aim') !== null) return null;
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || Math.abs(fov - ${ISS_LENS_FOV_DEG}) > 0.5 || Math.abs(fov - ${lens}) > 0.5) return null;
      return { ok: true, fov };
    })()`,
    'iss r key clears stored aim',
    10000,
  );
  await shot(send, evidenceDir, 'iss-aim-cleared');
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
      if (localStorage.getItem('opd-iss-aim') !== null) return null;
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || Math.abs(fov - ${ISS_LENS_FOV_DEG}) > 0.5 || Math.abs(fov - ${lens}) > 0.5) return null;
      return { ok: true, fov };
    })()`,
    'iss horizon after cleared reload',
    45000,
  );
  await shot(send, evidenceDir, 'iss-aim-horizon');
  await proveIssKeyboard(send, evidenceDir);
}

async function pressKey(send, key) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
}

async function pressShifted(send, key) {
  const code = /^[a-zA-Z]$/.test(key) ? `Key${key.toUpperCase()}` : key;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: 8 });
}

async function proveIssKeyboard(send, evidenceDir) {
  const before = await evaluate(send, `(() => {
    const map = window.__opdIss;
    if (!map?.getCenter || !map.getVerticalFieldOfView) return null;
    const center = map.getCenter();
    const fov = map.getVerticalFieldOfView();
    if (typeof fov !== 'number') return null;
    return { lat: center.lat, lng: center.lng, fov };
  })()`);
  if (!before) throw new Error('iss keyboard baseline missing');
  const labelBefore = await readFovLabel(send);
  if (!labelBefore || Math.abs(labelBefore.shown - before.fov) > 0.2) {
    throw new Error(`iss fov label missing before key ${JSON.stringify({ before, labelBefore })}`);
  }
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
  const labelAfter = await readFovLabel(send);
  if (!labelAfter || Math.abs(labelAfter.shown - narrowed.fov) > 0.2 || !(labelAfter.shown < labelBefore.shown - 1)) {
    throw new Error(`iss fov label did not follow the key ${JSON.stringify({ narrowed, labelBefore, labelAfter })}`);
  }
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
      if (localStorage.getItem('opd-iss-aim') !== raw) return null;
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
      if (localStorage.getItem('opd-iss-aim') !== raw) return null;
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
      if (localStorage.getItem('opd-iss-aim') !== raw) return null;
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
      if (localStorage.getItem('opd-iss-aim') !== null) return null;
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
  await pressKey(send, '=');
  const presetField = await waitFor(
    send,
    `(() => {
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || !(fov < ${before.fov} - 2)) return null;
      return { ok: true, fov };
    })()`,
    'iss keyboard field narrowed before a preset',
    10000,
  );
  await pressKey(send, 'n');
  await waitFor(
    send,
    `(() => {
      const map = window.__opdIss;
      const cupola = document.querySelector('[data-iss-cupola]');
      const chip = document.querySelector('[data-iss-window]');
      const nadir = document.querySelector('[data-iss-preset="nadir"]');
      const horizon = document.querySelector('[data-iss-preset="horizon"]');
      if (!map?.getCenter || !map.getVerticalFieldOfView || !cupola || !chip) return null;
      if (nadir?.getAttribute('aria-pressed') !== 'true') return null;
      if (horizon?.getAttribute('aria-pressed') !== 'false') return null;
      if (cupola.value !== '') return null;
      if (!chip.hidden) return null;
      const fov = map.getVerticalFieldOfView();
      if (Math.abs(fov - ${presetField.fov}) > 0.5) return null;
      if (!(fov < ${before.fov} - 2)) return null;
      const raw = sessionStorage.getItem('opd-iss-aim');
      if (!raw) return null;
      if (localStorage.getItem('opd-iss-aim') !== raw) return null;
      const aim = JSON.parse(raw);
      if (aim.mode !== 'nadir' || aim.windowId !== null || aim.azimuthDeg !== 0) return null;
      if (!aim.look || aim.look.rightDeg !== 0 || aim.look.upDeg !== 0) return null;
      if (typeof aim.opticalFovDeg !== 'number' || Math.abs(aim.opticalFovDeg - fov) > 0.5) return null;
      const center = map.getCenter();
      const shift = Math.abs(center.lat - ${before.lat}) + Math.abs(center.lng - ${before.lng});
      if (shift < 0.5) return null;
      return { ok: true, fov, shift };
    })()`,
    'iss keyboard straight down',
    10000,
  );
  await proveIssProfileMenuEscape(send, evidenceDir);
  await pressKey(send, 'H');
  await waitFor(
    send,
    `(() => {
      const map = window.__opdIss;
      const cupola = document.querySelector('[data-iss-cupola]');
      const chip = document.querySelector('[data-iss-window]');
      const nadir = document.querySelector('[data-iss-preset="nadir"]');
      const horizon = document.querySelector('[data-iss-preset="horizon"]');
      if (!map?.getCenter || !map.getVerticalFieldOfView || !cupola || !chip) return null;
      if (horizon?.getAttribute('aria-pressed') !== 'true') return null;
      if (nadir?.getAttribute('aria-pressed') !== 'false') return null;
      if (cupola.value !== '') return null;
      if (!chip.hidden) return null;
      const fov = map.getVerticalFieldOfView();
      if (Math.abs(fov - ${presetField.fov}) > 0.5) return null;
      const raw = sessionStorage.getItem('opd-iss-aim');
      if (!raw) return null;
      if (localStorage.getItem('opd-iss-aim') !== raw) return null;
      const aim = JSON.parse(raw);
      if (aim.mode !== 'horizon' || aim.windowId !== null || aim.azimuthDeg !== 0) return null;
      if (!aim.look || aim.look.rightDeg !== 0 || aim.look.upDeg !== 0) return null;
      const center = map.getCenter();
      const back = Math.abs(center.lat - ${before.lat}) + Math.abs(center.lng - ${before.lng});
      if (back > 0.35) return null;
      return { ok: true, fov };
    })()`,
    'iss keyboard horizon',
    10000,
  );
  await proveIssKeyHelp(send, evidenceDir);
  await proveIssLetterPan(send, evidenceDir);
  await proveIssAimLink(send);
}

async function proveIssLetterPan(send, evidenceDir) {
  await evaluate(send, `document.querySelector('[data-iss-frame]')?.focus()`);
  const origin = await readIssLook(send);
  if (!origin || Math.abs(origin.right) > 0.05 || Math.abs(origin.up) > 0.05) {
    throw new Error(`iss letter pan origin missing ${JSON.stringify(origin)}`);
  }
  await pressKey(send, 'd');
  const coarseRight = await waitFor(send, issLookShifted(origin, 'right', 0.4), 'iss letter pan right', 10000);
  await shot(send, evidenceDir, 'iss-letter-pan');
  await pressKey(send, 'a');
  await waitFor(send, issLookNear(origin, 0.08), 'iss letter pan left', 10000);
  await pressKey(send, 'w');
  const coarseUp = await waitFor(send, issLookShifted(origin, 'up', 0.4), 'iss letter pan up', 10000);
  await pressKey(send, 'ArrowDown');
  await waitFor(send, issLookNear(origin, 0.08), 'iss letter pan down stays on the arrow', 10000);
  await pressKey(send, 's');
  const coarseDown = await waitFor(send, issLookShifted(origin, 'up', -0.4), 'iss letter pan down', 10000);
  await pressKey(send, 'w');
  await waitFor(send, issLookNear(origin, 0.08), 'iss letter pan down returns', 10000);
  await pressShifted(send, 'd');
  await waitFor(send, issLookQuarter(origin, 'right', coarseRight.right), 'iss fine letter pan right', 10000);
  await pressShifted(send, 'a');
  await waitFor(send, issLookNear(origin, 0.08), 'iss fine letter pan left', 10000);
  await pressShifted(send, 'ArrowRight');
  await waitFor(send, issLookQuarter(origin, 'right', coarseRight.right), 'iss fine arrow pan right', 10000);
  await pressShifted(send, 'ArrowLeft');
  await waitFor(send, issLookNear(origin, 0.08), 'iss fine arrow pan left', 10000);
  await pressShifted(send, 'w');
  await waitFor(send, issLookQuarter(origin, 'up', coarseUp.up), 'iss fine letter pan up', 10000);
  await pressShifted(send, 'ArrowDown');
  await waitFor(send, issLookNear(origin, 0.08), 'iss fine arrow pan down', 10000);
  await pressShifted(send, 's');
  await waitFor(send, issLookQuarter(origin, 'up', coarseDown.up), 'iss fine letter pan down', 10000);
  await pressShifted(send, 'w');
  await waitFor(send, issLookNear(origin, 0.08), 'iss fine letter pan down returns', 10000);
}

async function proveIssAimLink(send) {
  await evaluate(send, `document.querySelector('[data-iss-frame]')?.focus()`);
  const origin = await evaluate(send, `(() => {
    const map = window.__opdIss;
    if (!map?.getCenter) return null;
    const center = map.getCenter();
    return { ok: true, lat: center.lat, lng: center.lng };
  })()`);
  if (!origin) throw new Error('iss link origin missing');
  for (let step = 0; step < 6; step += 1) await pressKey(send, 'd');
  const stored = await waitFor(
    send,
    `(() => {
      const raw = sessionStorage.getItem('opd-iss-aim');
      const map = window.__opdIss;
      if (!raw || localStorage.getItem('opd-iss-aim') !== raw || !map?.getCenter) return null;
      const aim = JSON.parse(raw);
      if (aim.mode !== 'horizon' || aim.windowId !== null || aim.azimuthDeg !== 0) return null;
      if (!aim.look || !(aim.look.rightDeg > 0.4) || Math.abs(aim.look.upDeg) > 0.08) return null;
      if (typeof aim.opticalFovDeg !== 'number') return null;
      if (!location.search.includes('e2e')) return null;
      const center = map.getCenter();
      const shift = Math.abs(center.lat - ${origin.lat}) + Math.abs(center.lng - ${origin.lng});
      if (shift < 0.2) return null;
      return { ok: true, raw, lat: center.lat, lng: center.lng };
    })()`,
    'iss aim stored before the link',
    10000,
  );
  await sleep(1200);
  const linked = await evaluate(send, `(() => {
    const raw = sessionStorage.getItem('opd-iss-aim');
    const hash = new URLSearchParams((location.hash || '').replace(/^#/, '')).get('iss');
    if (!raw || hash !== raw) return null;
    if (localStorage.getItem('opd-iss-aim') !== raw) return null;
    if (!location.search.includes('e2e')) return null;
    return { ok: true, raw };
  })()`);
  if (!linked || linked.raw !== stored.raw) {
    throw new Error(`iss hash did not match the stored aim ${JSON.stringify(linked)}`);
  }
  const aim = JSON.parse(stored.raw);
  await evaluate(send, `(() => {
    const raw = ${JSON.stringify(stored.raw)};
    sessionStorage.removeItem('opd-iss-aim');
    localStorage.removeItem('opd-iss-aim');
    const params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    params.set('iss', raw);
    const hash = params.toString();
    history.replaceState(history.state, '', location.pathname + location.search + '#' + hash);
    return true;
  })()`);
  await reloadSettled(send);
  await click(send, '#tab-iss');
  const windowMismatch = aim.windowId === null
    ? `cupola.value !== '' || !chip.hidden`
    : `cupola.value !== ${JSON.stringify(String(aim.windowId))} || chip.hidden || (chip.textContent || '').trim() !== ${JSON.stringify(`W${aim.windowId}`)}`;
  await waitFor(
    send,
    `(() => {
      const view = document.getElementById('view');
      if (!view || view.className !== 'view-iss') return null;
      if (!location.search.includes('e2e')) return null;
      const hash = new URLSearchParams((location.hash || '').replace(/^#/, '')).get('iss');
      if (hash !== ${JSON.stringify(stored.raw)}) return null;
      const horizon = document.querySelector('[data-iss-preset="horizon"]');
      const nadir = document.querySelector('[data-iss-preset="nadir"]');
      const cupola = document.querySelector('[data-iss-cupola]');
      const chip = document.querySelector('[data-iss-window]');
      const map = window.__opdIss;
      if (!cupola || !chip || !map?.getVerticalFieldOfView || !map.getCenter) return null;
      if (horizon?.getAttribute('aria-pressed') !== ${JSON.stringify(aim.mode === 'horizon' ? 'true' : 'false')}) return null;
      if (nadir?.getAttribute('aria-pressed') !== ${JSON.stringify(aim.mode === 'nadir' ? 'true' : 'false')}) return null;
      if (${windowMismatch}) return null;
      const center = map.getCenter();
      const back = Math.abs(center.lat - ${stored.lat}) + Math.abs(center.lng - ${stored.lng});
      const fromOrigin = Math.abs(center.lat - ${origin.lat}) + Math.abs(center.lng - ${origin.lng});
      if (back > 0.35 || fromOrigin < 0.2) return null;
      const fov = map.getVerticalFieldOfView();
      if (Math.abs(fov - ${aim.opticalFovDeg}) > 0.5) return null;
      const label = document.querySelector('[data-iss-fov]');
      if (!label || Math.abs(Number.parseFloat(label.textContent || '') - ${aim.opticalFovDeg}) > 0.2) return null;
      const decoded = JSON.parse(hash);
      if (decoded.mode !== ${JSON.stringify(aim.mode)}) return null;
      if (decoded.azimuthDeg !== ${aim.azimuthDeg}) return null;
      if (decoded.windowId !== ${aim.windowId === null ? 'null' : aim.windowId}) return null;
      if (!decoded.look || decoded.look.rightDeg !== ${aim.look.rightDeg} || decoded.look.upDeg !== ${aim.look.upDeg}) return null;
      if (decoded.opticalFovDeg !== ${aim.opticalFovDeg}) return null;
      return { ok: true, fov };
    })()`,
    'iss aim restored from the link',
    45000,
  );
}

async function readIssLook(send) {
  return evaluate(send, `(() => {
    const raw = sessionStorage.getItem('opd-iss-aim');
    const map = window.__opdIss;
    if (!raw || localStorage.getItem('opd-iss-aim') !== raw || !map?.getVerticalFieldOfView || !map.getCenter) return null;
    const aim = JSON.parse(raw);
    if (!aim.look || typeof aim.look.rightDeg !== 'number' || typeof aim.look.upDeg !== 'number') return null;
    const center = map.getCenter();
    return { right: aim.look.rightDeg, up: aim.look.upDeg, fov: map.getVerticalFieldOfView(), lat: center.lat, lng: center.lng };
  })()`);
}

function issLookShifted(origin, axis, minStep) {
  const field = axis === 'right' ? 'rightDeg' : 'upDeg';
  const other = axis === 'right' ? 'upDeg' : 'rightDeg';
  const stepCheck = minStep < 0 ? `!(step < ${minStep})` : `!(step > ${minStep})`;
  return `(() => {
    const raw = sessionStorage.getItem('opd-iss-aim');
    const map = window.__opdIss;
    if (!raw || localStorage.getItem('opd-iss-aim') !== raw || !map?.getVerticalFieldOfView) return null;
    const aim = JSON.parse(raw);
    if (!aim.look) return null;
    const step = aim.look.${field};
    if (${stepCheck}) return null;
    if (Math.abs(aim.look.${other}) > 0.08) return null;
    if (Math.abs(map.getVerticalFieldOfView() - ${origin.fov}) > 0.5) return null;
    if (document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed') !== 'true') return null;
    return { ok: true, right: aim.look.rightDeg, up: aim.look.upDeg, fov: map.getVerticalFieldOfView() };
  })()`;
}

function issLookQuarter(origin, axis, coarse) {
  const field = axis === 'right' ? 'rightDeg' : 'upDeg';
  const other = axis === 'right' ? 'upDeg' : 'rightDeg';
  const low = coarse * 0.18;
  const high = coarse * 0.32;
  const boundLow = Math.min(low, high);
  const boundHigh = Math.max(low, high);
  return `(() => {
    const raw = sessionStorage.getItem('opd-iss-aim');
    const map = window.__opdIss;
    if (!raw || localStorage.getItem('opd-iss-aim') !== raw || !map?.getVerticalFieldOfView) return null;
    const aim = JSON.parse(raw);
    if (!aim.look) return null;
    const step = aim.look.${field};
    if (!(step > ${boundLow}) || !(step < ${boundHigh})) return null;
    if (Math.abs(aim.look.${other}) > 0.08) return null;
    if (Math.abs(map.getVerticalFieldOfView() - ${origin.fov}) > 0.5) return null;
    if (document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed') !== 'true') return null;
    return { ok: true, right: aim.look.rightDeg, up: aim.look.upDeg, fov: map.getVerticalFieldOfView() };
  })()`;
}

function issLookNear(origin, tolerance) {
  return `(() => {
    const raw = sessionStorage.getItem('opd-iss-aim');
    const map = window.__opdIss;
    if (!raw || localStorage.getItem('opd-iss-aim') !== raw || !map?.getVerticalFieldOfView) return null;
    const aim = JSON.parse(raw);
    if (!aim.look) return null;
    if (Math.abs(aim.look.rightDeg) > ${tolerance}) return null;
    if (Math.abs(aim.look.upDeg) > ${tolerance}) return null;
    if (Math.abs(map.getVerticalFieldOfView() - ${origin.fov}) > 0.5) return null;
    if (document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed') !== 'true') return null;
    return { ok: true, right: aim.look.rightDeg, up: aim.look.upDeg, fov: map.getVerticalFieldOfView() };
  })()`;
}

async function releaseKey(send, key) {
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
}

async function proveIssProfileMenuEscape(send, evidenceDir) {
  const before = await evaluate(send, `(() => {
    const raw = sessionStorage.getItem('opd-iss-aim');
    if (!raw || localStorage.getItem('opd-iss-aim') !== raw) return null;
    const aim = JSON.parse(raw);
    if (aim.mode !== 'nadir') return null;
    const nadir = document.querySelector('[data-iss-preset="nadir"]');
    const horizon = document.querySelector('[data-iss-preset="horizon"]');
    if (nadir?.getAttribute('aria-pressed') !== 'true') return null;
    if (horizon?.getAttribute('aria-pressed') !== 'false') return null;
    const fov = window.__opdIss?.getVerticalFieldOfView?.();
    if (typeof fov !== 'number') return null;
    return { raw, fov };
  })()`);
  if (!before) throw new Error('iss profile menu escape baseline missing');
  await click(send, '#profile-badge');
  await waitFor(
    send,
    `(() => {
      const menu = document.getElementById('profile-menu');
      if (!menu || !menu.matches(':popover-open')) return null;
      const rows = [...menu.querySelectorAll('.profile-menu-item')].map((row) => row.textContent);
      if (rows[0] !== 'Anil' || !rows.includes('Jessica Watkins (Watty)') || rows.length !== 4) return null;
      return { ok: true };
    })()`,
    'iss profile menu open',
    10000,
  );
  await evaluate(send, `document.querySelector('[data-iss-frame]')?.focus()`);
  await waitFor(
    send,
    `(() => {
      const menu = document.getElementById('profile-menu');
      const frame = document.querySelector('[data-iss-frame]');
      if (!menu || !menu.matches(':popover-open')) return null;
      if (document.activeElement !== frame) return null;
      return { ok: true };
    })()`,
    'iss profile menu stays open with the view focused',
    10000,
  );
  await shot(send, evidenceDir, 'iss-profile-menu');
  await pressKey(send, 'Escape');
  await waitFor(
    send,
    `(() => {
      const menu = document.getElementById('profile-menu');
      if (!menu || menu.matches(':popover-open')) return null;
      if (sessionStorage.getItem('opd-iss-aim') !== ${JSON.stringify(before.raw)}) return null;
      if (localStorage.getItem('opd-iss-aim') !== ${JSON.stringify(before.raw)}) return null;
      const nadir = document.querySelector('[data-iss-preset="nadir"]');
      const horizon = document.querySelector('[data-iss-preset="horizon"]');
      if (nadir?.getAttribute('aria-pressed') !== 'true') return null;
      if (horizon?.getAttribute('aria-pressed') !== 'false') return null;
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || Math.abs(fov - ${before.fov}) > 0.5) return null;
      return { ok: true, fov };
    })()`,
    'iss profile menu escape keeps aim',
    10000,
  );
  await shot(send, evidenceDir, 'iss-profile-menu-escape');
}

async function proveIssKeyHelp(send, evidenceDir) {
  const before = await evaluate(send, `(() => {
    const map = window.__opdIss;
    if (!map?.getCenter || !map.getVerticalFieldOfView) return null;
    const center = map.getCenter();
    const fov = map.getVerticalFieldOfView();
    if (typeof fov !== 'number') return null;
    return { lat: center.lat, lng: center.lng, fov, stored: sessionStorage.getItem('opd-iss-aim') };
  })()`);
  if (!before) throw new Error('iss key help baseline missing');
  await click(send, '[data-iss-aim-help]');
  await waitFor(
    send,
    `(() => {
      const sheet = document.querySelector('[data-iss-aim-sheet]');
      const button = document.querySelector('[data-iss-aim-help]');
      if (!sheet || sheet.hidden) return null;
      if (button?.getAttribute('aria-expanded') !== 'true') return null;
      const text = sheet.textContent || '';
      if (!text.includes('Narrow FOV') || !text.includes('1\u20137')) return null;
      const rows = [...sheet.querySelectorAll('li')].map((li) => [
        li.querySelector('[data-iss-aim-keys]')?.textContent,
        li.querySelector('[data-iss-aim-effect]')?.textContent,
      ]);
      const want = [
        ['Arrows', 'Pan'],
        ['W/A/S/D', 'Pan'],
        ['Shift+arrows', 'Fine pan'],
        ['Shift+W/A/S/D', 'Fine pan'],
        ['n', 'Straight down'],
      ];
      if (!want.every(([keys, effect]) => rows.some((row) => row[0] === keys && row[1] === effect))) return null;
      return { ok: true, rows: rows.length };
    })()`,
    'iss key help open',
    10000,
  );
  await shot(send, evidenceDir, 'iss-key-help');
  await click(send, '[data-iss-aim-scrim]');
  await waitFor(
    send,
    issKeyHelpHeld(before),
    'iss key help tap close',
    10000,
  );
  await click(send, '[data-iss-aim-help]');
  await waitFor(
    send,
    `(() => {
      const sheet = document.querySelector('[data-iss-aim-sheet]');
      if (!sheet || sheet.hidden) return null;
      return { ok: true };
    })()`,
    'iss key help open again',
    10000,
  );
  await pressKey(send, 'ArrowRight');
  await pressKey(send, 'Escape');
  await releaseKey(send, 'Escape');
  await waitFor(
    send,
    issKeyHelpHeld(before),
    'iss key help escape close',
    10000,
  );
}

function issKeyHelpHeld(before) {
  return `(() => {
    const map = window.__opdIss;
    const sheet = document.querySelector('[data-iss-aim-sheet]');
    const button = document.querySelector('[data-iss-aim-help]');
    if (!map?.getCenter || !map.getVerticalFieldOfView || !sheet || !button) return null;
    if (!sheet.hidden) return null;
    if (button.getAttribute('aria-expanded') !== 'false') return null;
    const center = map.getCenter();
    const shift = Math.abs(center.lat - ${before.lat}) + Math.abs(center.lng - ${before.lng});
    if (shift > 0.35) return null;
    const fov = map.getVerticalFieldOfView();
    if (Math.abs(fov - ${before.fov}) > 0.5) return null;
    if (sessionStorage.getItem('opd-iss-aim') !== ${JSON.stringify(before.stored)}) return null;
    if (localStorage.getItem('opd-iss-aim') !== ${JSON.stringify(before.stored)}) return null;
    return { ok: true, fov };
  })()`;
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
  await waitFor(send, ISS_EDITION_EXPR, 'iss edition in short landscape', 10000);
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
  await assertMapInfoControlsGone(send);
  await shot(send, evidenceDir, 'help-placement');
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
  await click(send, '#help-fab');
  await waitFor(send, `document.querySelector('.help-modal') ? { ok: true } : null`, 'help dialog');
  const label = await evaluate(send, `document.querySelector('.help-modal')?.getAttribute('aria-label') || ''`);
  if (!String(label).includes('Help')) throw new Error(`help dialog label missing: ${label}`);
  const helpText = await evaluate(send, `document.querySelector('.help-body')?.textContent || ''`);
  const aimingStart = String(helpText).indexOf('Aiming the ISS view');
  const aimingEnd = String(helpText).indexOf('Reading a pass card');
  const aiming = aimingStart >= 0 && aimingEnd > aimingStart ? String(helpText).slice(aimingStart, aimingEnd) : '';
  const aimingPhrases = [
    'Horizon',
    'keep a pinched field',
    'n / N',
    'W, A, S, and D',
    'Hold Shift',
    '#iss=',
    'The Launch menu sits beside Telemetry',
    'None clears it.',
    'beside Telemetry',
    'about 18°',
    'gold pin',
    'arrow on the edge',
    'only when that launch includes a trajectory',
  ];
  const missing = aimingPhrases.filter((phrase) => !aiming.includes(phrase));
  if (missing.length) throw new Error(`help aiming missing ${missing.join(', ')}`);
  if (/Reset/.test(String(helpText)) || String(helpText).toLowerCase().includes('double-tap') || String(helpText).includes('Horizon opens first')) {
    throw new Error('help dialog brought back removed aiming copy');
  }
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
  return 'help: opened, aiming, launch line, closed, queue corner';
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

async function assertMapInfoControlsGone(send) {
  await waitFor(
    send,
    `(() => {
      const help = document.querySelector('.help-fab');
      const info = document.querySelector('#map .maplibregl-ctrl-bottom-right');
      if (!help || getComputedStyle(help).display !== 'none') return null;
      if (info && getComputedStyle(info).display !== 'none') return null;
      return { ok: true };
    })()`,
    'map info controls hidden',
    10000,
  );
}

async function assertChromeToggleStationary(send) {
  const read = `(() => {
    const toggle = document.getElementById('map-chrome-toggle');
    const pane = document.getElementById('map-pane');
    if (!toggle || !pane) return null;
    const box = toggle.getBoundingClientRect();
    const style = getComputedStyle(toggle);
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      right: style.right,
      minWidth: style.minWidth,
      minHeight: style.minHeight,
      rightGap: pane.getBoundingClientRect().right - box.right,
    };
  })()`;
  const before = await evaluate(send, read);
  await click(send, '#map-chrome-toggle');
  await waitFor(
    send,
    `document.body.classList.contains('map-chrome-hidden') && (document.getElementById('map-chrome-toggle')?.textContent || '').trim() === 'Controls' ? { ok: true } : null`,
    'map chrome hidden for toggle place',
  );
  const hidden = await evaluate(send, read);
  await showMapChrome(send);
  const after = await evaluate(send, read);
  const same = (a, b) => Math.abs((a.left + a.width) - (b.left + b.width)) <= 1
    && Math.abs(a.left - b.left) <= 1
    && Math.abs(a.top - b.top) <= 1
    && Math.abs(a.width - b.width) <= 1
    && Math.abs(a.height - b.height) <= 1;
  if (!before || !hidden || !after || !same(before, hidden) || !same(before, after)) {
    throw new Error(`hide control moved ${JSON.stringify({ before, hidden, after })}`);
  }
  assertHideControlBox(before, 'shown');
  assertHideControlBox(hidden, 'controls');
  assertHideControlBox(after, 'shown again');
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
  await evaluate(send, `(() => {
    const toggle = document.getElementById('live-readout-toggle');
    if (!toggle || getComputedStyle(toggle).display === 'none') return;
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  })()`);
  await waitFor(
    send,
    `(() => {
      const kp = document.getElementById('kp-widget');
      if (!kp || kp.hidden || getComputedStyle(kp).display === 'none') return null;
      const rect = kp.getBoundingClientRect();
      if (rect.width < 44 || rect.height < 44) return null;
      return { ok: true };
    })()`,
    'phone status readout',
    8000,
  );
  const portrait = await evaluate(send, `(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    const tab = box('.tab');
    const kp = box('#kp-widget');
    const help = document.querySelector('.help-fab');
    const info = document.querySelector('#map .maplibregl-ctrl-bottom-right');
    const pad = getComputedStyle(document.querySelector('.topbar')).paddingTop;
    return {
      tab,
      kp,
      helpHidden: !help || getComputedStyle(help).display === 'none',
      infoHidden: !info || getComputedStyle(info).display === 'none',
      pad,
    };
  })()`);
  const tall = (box, label) => {
    if (!box || box.width < 44 || box.height < 44) throw new Error(`${label} is ${JSON.stringify(box)}`);
  };
  tall(portrait.tab, 'tab');
  tall(portrait.kp, 'kp');
  if (!portrait.helpHidden || !portrait.infoHidden) throw new Error(`map info controls still shown ${JSON.stringify(portrait)}`);
  if (inset) {
    const pad = Number.parseFloat(portrait.pad);
    if (!Number.isFinite(pad) || pad < 47) throw new Error(`top bar padding ${portrait.pad} with safe area`);
  }
  await shot(send, evidenceDir, 'phone-portrait');
  await assertChromeToggleStationary(send);
  await setViewport(send, 844, 390, true);
  await sleep(300);
  const landscape = await evaluate(send, `(() => {
    const dock = document.querySelector('.map-control-dock');
    const help = document.querySelector('.help-fab');
    const info = document.querySelector('#map .maplibregl-ctrl-bottom-right');
    const button = document.querySelector('.map-control-dock .time-btn');
    if (!dock || !button) return null;
    const buttonBox = button.getBoundingClientRect();
    return {
      ok: (!help || getComputedStyle(help).display === 'none')
        && (!info || getComputedStyle(info).display === 'none')
        && dock.scrollHeight > dock.clientHeight + 1
        && buttonBox.width >= 44
        && buttonBox.height >= 44,
      scrollHeight: dock.scrollHeight,
      clientHeight: dock.clientHeight,
      button: { width: buttonBox.width, height: buttonBox.height },
    };
  })()`);
  if (!landscape?.ok) throw new Error(`phone dock ${JSON.stringify(landscape)}`);
  await shot(send, evidenceDir, 'phone-landscape');
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
  const dismiss = await evaluate(send, `(() => {
    const map = window.__opdMap;
    const source = map && map.getSource && map.getSource('dropped-pin');
    const data = source && source.serialize ? source.serialize().data : null;
    const coords = data && data.features && data.features[0] && data.features[0].geometry && data.features[0].geometry.coordinates;
    const canvas = map && map.getCanvas && map.getCanvas();
    if (!coords || !canvas || !map.project) return null;
    const projected = map.project(coords);
    const rect = canvas.getBoundingClientRect();
    return { ok: true, x: rect.left + projected.x, y: rect.top + projected.y };
  })()`);
  if (!dismiss?.ok) throw new Error('could not project the dropped pin');
  await assertCanvasHit(send, dismiss.x, dismiss.y, 'pin dismiss');
  await mouseClick(send, dismiss.x, dismiss.y);
  await waitFor(
    send,
    `document.querySelector('.maplibregl-popup')?.innerText.includes('Closest') ? null : { ok: true }`,
    'pin popup dismissed',
    5000,
  );
  await safeAreaOverride(send, { top: 0, left: 0, bottom: 0, right: 0 });
  await setViewport(send, home.width, home.height, home.mobile);
  return `phone: 44px targets, map info controls hidden, hide control 88x44 at 12px, long-press held, safe-area ${inset ? 'applied' : 'unsupported'}`;
}
