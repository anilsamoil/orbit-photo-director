import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { noteRequest, planBasemapVerdict } from './carto-dark-watch.mjs';
import { planLabelReaders } from './plan-label-verdict.mjs';
import { BOSTON_NADIR_EPOCH_MS, refreshLaunchClock } from './fixtures.mjs';
import { proveLaunchPlacement } from './placement-proof.mjs';
import { deviceDescriptor, deviceViewport, launchWebkit, playwrightSend, proveDeniedFooter, WEBKIT_DEVICES } from './webkit-devices.mjs';

export const BROWSER_FEATURES = ['banner', 'topbar', 'queue', 'upcoming', 'map', 'iss', 'help', 'profile', 'log', 'phone', 'tracked'];

const DESKTOP = { width: 1400, height: 900, mobile: false };
const ISS_LENS_FOV_DEG = 81.2;
const SCENE_SCROLLS = 'scene.scrollHeight !== scene.clientHeight || scene.scrollWidth !== scene.clientWidth';
const ISS_CLOCK_EXPR = `(() => {
  const root = document.querySelector('[data-iss-clock]');
  if (!root) return { step: 'missing' };
  const names = [...root.children].map((el) => {
    if (el.hasAttribute('data-iss-utc')) return 'utc';
    if (el.hasAttribute('data-iss-gmt-day')) return 'gmt-day';
    if (el.hasAttribute('data-iss-houston')) return 'houston';
    if (el.hasAttribute('data-iss-day-month')) return 'day-month';
    if (el.hasAttribute('data-iss-weekday')) return 'weekday';
    return el.tagName;
  });
  const docked = document.querySelector('[data-iss-scene]')?.getAttribute('data-iss-side-dock') === 'on';
  const side = document.querySelector('[data-iss-side]');
  if (docked) {
    if (names.join(',') !== 'utc,gmt-day') return { step: 'order', names };
    for (const sel of ['[data-iss-houston]', '[data-iss-day-month]', '[data-iss-weekday]', '[data-iss-edition]']) {
      const el = document.querySelector(sel);
      if (!side || !el || !side.contains(el)) return { step: 'side', sel };
    }
  } else if (names.join(',') !== 'utc,gmt-day,houston,day-month,weekday') {
    return { step: 'order', names };
  }
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
  const lines = ['[data-iss-gmt-day]', '[data-iss-houston]', '[data-iss-day-month]', '[data-iss-weekday]'];
  for (const sel of lines) {
    const el = document.querySelector(sel);
    if (!el || el.tagName !== 'P') return { step: 'tag', sel };
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!(box.height > 4 && box.height < 44 && box.width > 8)) return { step: 'box', sel, height: box.height, width: box.width };
    if (style.pointerEvents !== 'none') return { step: 'line-pointer', sel, pointer: style.pointerEvents };
    if (style.minHeight !== '0px') return { step: 'min', sel, minHeight: style.minHeight };
  }
  const boxes = [...root.children].map((el) => el.getBoundingClientRect());
  if (!docked) {
    for (let i = 1; i < boxes.length; i += 1) {
      if (boxes[i].top < boxes[i - 1].bottom - 0.5) return { step: 'stack', line: names[i], top: boxes[i].top, above: boxes[i - 1].bottom };
    }
  }
  const [utcBox, gmtBox] = boxes;
  if (Math.abs(gmtBox.top - utcBox.bottom) > 0.5) return { step: 'gmt-under', utcBottom: utcBox.bottom, gmtTop: gmtBox.top };
  if (Math.abs(gmtBox.bottom - utcBox.top - 44) > 1) return { step: 'band', pair: gmtBox.bottom - utcBox.top };
  const splitChrome = root.closest('[data-iss-split-chrome]');
  if (splitChrome) {
    const map = document.querySelector('[data-pip="plan"]')?.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    if (!map || map.width < 40 || box.top < map.top - 1 || box.bottom > map.bottom + 1 || box.left < map.left - 1 || box.right > map.right + 1) {
      return { step: 'split-clock', mapWidth: map && map.width, top: box.top, bottom: box.bottom };
    }
    const hit = document.elementFromPoint(box.left + Math.min(16, box.width / 2), box.top + Math.min(10, box.height / 2));
    if (!hit || !splitChrome.contains(hit)) return { step: 'split-hit', tag: hit && hit.tagName, className: hit && String(hit.className) };
  } else if (window.innerWidth > 720) {
    const horizonBox = document.querySelector('[data-iss-preset="horizon"]')?.getBoundingClientRect();
    if (!horizonBox || Math.abs(utcBox.top - horizonBox.top) > 1) return { step: 'band-row', utcTop: utcBox.top, horizonTop: horizonBox?.top };
  }
  const px = (el) => Number.parseFloat(getComputedStyle(el).fontSize);
  const dockSmall = docked
    ? ['[data-iss-houston]', '[data-iss-day-month]', '[data-iss-weekday]'].map((sel) => document.querySelector(sel))
    : null;
  if (dockSmall && dockSmall.some((el) => !el || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none')) {
    return { step: 'visible' };
  }
  const [utcPx, gmtPx, ...small] = docked
    ? [root.querySelector('[data-iss-utc]'), root.querySelector('[data-iss-gmt-day]'), ...dockSmall].map(px)
    : [...root.children].map(px);
  const rootPx = px(document.documentElement);
  if (Math.abs(gmtPx - utcPx) > 0.01) return { step: 'gmt-size', utcPx, gmtPx };
  if (small.some((size) => Math.abs(size - 0.68 * rootPx) > 0.01)) return { step: 'small-size', small, rootPx };
  if (!(utcPx > small[0])) return { step: 'size-rank', utcPx, small: small[0] };
  const clipNodes = docked ? [root, ...root.children, ...dockSmall, document.querySelector('[data-iss-edition]')] : [root, ...root.children];
  for (const el of clipNodes) {
    if (!el) return { step: 'clip-missing' };
    if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) return { step: 'clip', line: Object.keys(el.dataset).join(','), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }
  for (const sel of ['[data-iss-utc]', '[data-iss-gmt-day]', '[data-iss-edition]']) {
    const el = document.querySelector(sel);
    if (!el) return { step: 'ink', sel };
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const ink = range.getBoundingClientRect();
    if (!(ink.height > 8)) return { step: 'ink-height', sel, height: ink.height };
    if (ink.left < box.left - 0.5 || ink.right > box.right + 0.5 || ink.top < box.top - 0.5 || ink.bottom > box.bottom + 0.5) {
      return { step: 'ink', sel, inkLeft: ink.left, inkTop: ink.top, inkRight: ink.right, inkBottom: ink.bottom, boxLeft: box.left, boxTop: box.top, boxRight: box.right, boxBottom: box.bottom };
    }
  }
  return { ok: true, utc, houston, gmt, dayMonth, weekday, utcPx, smallPx: small[0] };
})()`;

function selectedSurfaceNames() {
  const raw = (process.env.OPD_VERIFY_SURFACE || 'all').trim();
  const known = ['desktop', ...WEBKIT_DEVICES.map((spec) => spec.slug)];
  if (raw === 'all') return known;
  if (!known.includes(raw)) throw new Error(`unknown OPD_VERIFY_SURFACE ${raw}. Choose ${known.join(', ')}, or all.`);
  return [raw];
}

function viewportOverride() {
  const raw = (process.env.OPD_VERIFY_VIEWPORT || '').trim();
  if (!raw) return null;
  const surface = (process.env.OPD_VERIFY_SURFACE || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(raw);
  if (!match) throw new Error(`OPD_VERIFY_VIEWPORT must be WIDTHxHEIGHT, got ${raw}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (surface === 'iphone-17-pro') return { width, height, raw };
  if (surface === 'iphone-13' && width === 844 && height === 390) return { width, height, raw };
  throw new Error('OPD_VERIFY_VIEWPORT requires OPD_VERIFY_SURFACE=iphone-17-pro, or iphone-13 with 844x390.');
}

function specForSurface(spec) {
  const override = viewportOverride();
  const surface = (process.env.OPD_VERIFY_SURFACE || '').trim();
  if (!override || spec.slug !== surface) return spec;
  return { ...spec, viewport: { width: override.width, height: override.height } };
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
  const listeners = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolveMessage, rejectMessage } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectMessage(new Error(JSON.stringify(message.error)));
      else resolveMessage(message.result);
      return;
    }
    if (!message.method) return;
    const handlers = listeners.get(message.method);
    if (!handlers) return;
    for (const handler of handlers) handler(message.params || {});
  });
  function send(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolveMessage, rejectMessage) => {
      pending.set(id, { resolveMessage, rejectMessage });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  function on(method, handler) {
    const handlers = listeners.get(method) || [];
    handlers.push(handler);
    listeners.set(method, handlers);
  }
  return {
    send,
    on,
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

function settledLayout(sample) {
  if (!sample || sample.ok !== true) return null;
  return [
    sample.stage,
    sample.frame,
    sample.canvas,
    sample.scrollHeight,
    sample.clientHeight,
    sample.controlsBottom,
    sample.sceneBottom,
  ].join(',');
}

async function waitForStable(send, expression, label, timeoutMs = 10000) {
  const started = Date.now();
  let last = null;
  let previous = null;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(send, `(() => { try { return (${expression}); } catch (error) { return { error: String(error) }; } })()`);
    if (last && typeof last === 'object' && typeof last.error === 'string') {
      throw new Error(`${label}: ${last.error}`);
    }
    const signature = settledLayout(last);
    if (signature && signature === previous) return last;
    previous = signature;
    await sleep(250);
  }
  throw new Error(`${label} timed out. Last value: ${JSON.stringify(last)}`);
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

async function shot(send, evidenceDir, name, clip) {
  const params = { format: 'png' };
  if (clip) params.clip = clip;
  const image = await send('Page.captureScreenshot', params);
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
    else if (feature === 'profile') notes.push(await driveProfile(send, evidenceDir, meta, baseUrl, home, viewport));
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
      const cartoDark = [];
      cdp.on('Network.requestWillBeSent', (params) => {
        noteRequest(cartoDark, params.request && params.request.url);
      });
      await cdp.send('Network.enable');
      cdp.send.cartoDark = cartoDark;
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
      const override = viewportOverride();
      const active = specForSurface(spec);
      const viewport = deviceViewport(active);
      const overridden = override && spec.slug === (process.env.OPD_VERIFY_SURFACE || '').trim();
      const folder = overridden ? `${spec.slug}-${override.raw}` : spec.slug;
      const label = overridden ? `${spec.slug}@${override.raw}` : spec.slug;
      const surfaceDir = resolve(evidenceDir, folder);
      slideLaunch(home);
      await resetFixtureProfile(baseUrl);
      const context = await browser.newContext({ ...deviceDescriptor(active), serviceWorkers: 'block' });
      if (spec.standalone) {
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
        });
      }
      const page = await context.newPage();
      try {
        const cartoDark = [];
        page.on('request', (request) => {
          noteRequest(cartoDark, request.url());
        });
        const send = playwrightSend(page);
        send.pointer = 'touch';
        send.cartoDark = cartoDark;
        await openApp(send, baseUrl);
        const featureNotes = await runFeatures(send, surfaceDir, meta, features, baseUrl, home, viewport);
        notes.push(...featureNotes.map((note) => `${label}: ${note}`));
      } finally {
        await context.close();
      }
      notes.push(`${label}: ${await proveDeniedFooter(browser, active, baseUrl, surfaceDir)}`);
    } finally {
      await browser.close();
    }
  }
  return notes;
}

export async function driveFeatures({ baseUrl, evidenceDir, meta, features }) {
  viewportOverride();
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

function cornerRound(value) {
  return Number.isFinite(value) ? value.toFixed(2) : 'missing';
}

const CORNER_BOX = `
  const cornerBox = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const cornerMeets = (a, b) => !!(a && b && a.width > 0 && b.width > 0 && a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5);
  const cornerOwns = (x, y, selector) => {
    const el = document.elementFromPoint(x, y);
    return !!(el && el.closest(selector));
  };
  const cornerHit = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return '';
    return el.id || String(el.className || el.tagName);
  };
  const cornerBanner = (enabled) => {
    const banner = document.getElementById('status-banner');
    if (banner) banner.querySelectorAll('.banner-actions').forEach((node) => node.remove());
    if (!enabled || !banner) return;
    const actions = document.createElement('div');
    actions.className = 'banner-actions';
    const signIn = document.createElement('a');
    signIn.className = 'banner-action';
    signIn.textContent = 'Sign in';
    const reload = document.createElement('button');
    reload.className = 'banner-action';
    reload.type = 'button';
    reload.textContent = 'Reload';
    actions.append(signIn, reload);
    banner.append(actions);
  };
`;

export async function driveMapCorner({ baseUrl, evidenceDir, home }) {
  mkdirSync(evidenceDir, { recursive: true });
  slideLaunch(home);
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const chromePid = startChrome(home, debugPort);
  writeFileSync(resolve(home, 'chrome.pid'), String(chromePid));
  const lines = [];
  const failures = [];
  try {
    const cdp = await connectCdp(debugPort);
    const send = cdp.send;
    try {
      await setViewport(send, DESKTOP.width, DESKTOP.height, DESKTOP.mobile);
      await openApp(send, baseUrl);
      const shown = await evaluate(send, `/Hide/.test(document.getElementById('map-chrome-toggle')?.textContent || '')`);
      if (!shown) {
        await click(send, '#map-chrome-toggle');
        await waitFor(
          send,
          `/Hide/.test(document.getElementById('map-chrome-toggle')?.textContent || '') ? { ok: true } : null`,
          'map chrome shown',
        );
      }
      await setViewport(send, 390, 520, true);
      await evaluate(send, `document.body.classList.remove('shotlist-bar-visible'); true`);
      await sleep(300);
      const narrow = await evaluate(send, `(() => {
        ${CORNER_BOX}
        const slider = cornerBox(document.getElementById('time-slider'));
        const compass = cornerBox(document.querySelector('.maplibregl-ctrl-compass'));
        const hit = compass ? cornerHit(compass.left + compass.width / 2, compass.top + compass.height / 2) : '';
        const owns = compass ? cornerOwns(compass.left + compass.width / 2, compass.top + compass.height / 2, '.maplibregl-ctrl-compass') : false;
        return { slider, compass, hit, owns };
      })()`);
      lines.push(`390x520 slider ${cornerRound(narrow?.slider?.width)}x${cornerRound(narrow?.slider?.height)} at ${cornerRound(narrow?.slider?.left)},${cornerRound(narrow?.slider?.top)} compass-hit ${narrow?.hit || 'missing'}`);
      if (!narrow?.slider || narrow.slider.width < 44) {
        failures.push(`390x520 #time-slider width ${cornerRound(narrow?.slider?.width)} is under 44`);
      }
      await shot(send, evidenceDir, 'map-corner-390x520');

      await setViewport(send, 430, 400, true);
      await evaluate(send, `document.body.classList.add('shotlist-bar-visible'); true`);
      await sleep(300);
      const compass = await evaluate(send, `(() => {
        ${CORNER_BOX}
        const slider = cornerBox(document.getElementById('time-slider'));
        const compass = cornerBox(document.querySelector('.maplibregl-ctrl-compass'));
        const ends = [...document.querySelectorAll('.time-slider-end')].map((el) => ({ ...cornerBox(el), text: (el.textContent || '').trim() }));
        const cx = compass ? compass.left + compass.width / 2 : 0;
        const cy = compass ? compass.top + compass.height / 2 : 0;
        return {
          slider,
          compass,
          ends,
          hit: compass ? cornerHit(cx, cy) : '',
          owns: compass ? cornerOwns(cx, cy, '.maplibregl-ctrl-compass') : false,
          overlap: ends.some((end) => cornerMeets(compass, end)),
        };
      })()`);
      const nowEnd = (compass?.ends || []).find((end) => end.text === 'Now');
      lines.push(`430x400 shotlist slider ${cornerRound(compass?.slider?.width)} compass ${cornerRound(compass?.compass?.left)},${cornerRound(compass?.compass?.top)} ${cornerRound(compass?.compass?.width)}x${cornerRound(compass?.compass?.height)} hit ${compass?.hit || 'missing'} now ${cornerRound(nowEnd?.left)}-${cornerRound(nowEnd?.right)},${cornerRound(nowEnd?.top)} overlap ${compass?.overlap === true}`);
      if (!compass?.owns || compass.overlap) {
        failures.push(`430x400 compass center hits ${compass?.hit || 'missing'} overlap ${compass?.overlap === true}`);
      }
      await shot(send, evidenceDir, 'map-corner-430x400');

      await evaluate(send, `document.body.classList.remove('shotlist-bar-visible'); true`);
      await setViewport(send, 1280, 700, false);
      const insetCleared = await safeAreaOverride(send, { top: 0, left: 0, bottom: 0, right: 0 });
      if (!insetCleared) throw new Error('map-corner needs Chrome safe-area override');
      await sleep(300);
      const dock = await evaluate(send, `(() => {
        ${CORNER_BOX}
        cornerBanner(true);
        const dock = document.querySelector('.map-control-dock');
        dock.scrollTop = dock.scrollHeight;
        const sat = cornerBox(document.getElementById('toggle-satellite-picker'));
        const hide = cornerBox(document.getElementById('map-chrome-toggle'));
        const cx = sat ? sat.left + sat.width / 2 : 0;
        const cy = sat ? sat.top + sat.height / 2 : 0;
        return {
          sat, hide,
          scrollTop: dock.scrollTop,
          overlap: cornerMeets(sat, hide),
          owns: sat ? cornerOwns(cx, cy, '#toggle-satellite-picker') : false,
          hit: sat ? cornerHit(cx, cy) : '',
          actions: !!document.querySelector('#status-banner .banner-actions'),
        };
      })()`);
      lines.push(`1280x700 banner dock scroll ${dock?.scrollTop} sat ${cornerRound(dock?.sat?.left)},${cornerRound(dock?.sat?.top)} ${cornerRound(dock?.sat?.width)}x${cornerRound(dock?.sat?.height)} hide ${cornerRound(dock?.hide?.left)},${cornerRound(dock?.hide?.top)} ${cornerRound(dock?.hide?.width)}x${cornerRound(dock?.hide?.height)} overlap ${dock?.overlap === true} hit ${dock?.hit || 'missing'}`);
      if (!dock?.actions || dock.overlap || !dock.owns) {
        failures.push(`1280x700 satellite meets Hide overlap ${dock?.overlap === true} hit ${dock?.hit || 'missing'}`);
      }
      await shot(send, evidenceDir, 'map-corner-1280x700');

      await setViewport(send, DESKTOP.width, DESKTOP.height, DESKTOP.mobile);
      await evaluate(send, `(() => {
        const ir = document.getElementById('toggle-ir');
        if (ir && ir.getAttribute('aria-pressed') !== 'true') ir.click();
        document.getElementById('time-fwd-45').click();
        const toggle = document.getElementById('map-legend-toggle');
        if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
        return true;
      })()`);
      await waitFor(
        send,
        `(() => {
          const panel = document.getElementById('map-legend-panel');
          const text = panel?.innerText || '';
          const box = panel?.getBoundingClientRect();
          if (!box || box.height < 80) return null;
          if (!text.includes('LIVE now') && !text.includes('feed unavailable')) return null;
          return { ok: true, height: box.height };
        })()`,
        'scrubbed IR legend',
        20000,
      );
      const opened = await evaluate(send, `(() => {
        const box = document.getElementById('map-legend-panel').getBoundingClientRect();
        return { width: box.width, height: box.height, text: (document.getElementById('map-legend-panel').innerText || '').replace(/\\s+/g, ' ').trim() };
      })()`);
      lines.push(`legend panel ${cornerRound(opened?.width)}x${cornerRound(opened?.height)} ${opened?.text || ''}`);

      const legendFrames = [
        { name: '844x390 banner bottom21', width: 844, height: 390, mobile: true, insets: { top: 0, left: 0, bottom: 21, right: 0 }, banner: true, pip: false, shot: 'map-corner-844x390' },
        { name: '800x600 top24 bottom20', width: 800, height: 600, mobile: false, insets: { top: 24, left: 0, bottom: 20, right: 0 }, banner: false, pip: true, shot: 'map-corner-800x600' },
        { name: '800x600 banner', width: 800, height: 600, mobile: false, insets: { top: 0, left: 0, bottom: 0, right: 0 }, banner: true, pip: true, shot: 'map-corner-800x600-banner-only' },
        { name: '800x600 top24 bottom20 banner', width: 800, height: 600, mobile: false, insets: { top: 24, left: 0, bottom: 20, right: 0 }, banner: true, pip: true, shot: 'map-corner-800x600-banner' },
      ];
      for (const frame of legendFrames) {
        await setViewport(send, frame.width, frame.height, frame.mobile);
        const applied = await safeAreaOverride(send, frame.insets);
        if (!applied) throw new Error('map-corner needs Chrome safe-area override');
        await sleep(300);
        const sample = await evaluate(send, `(() => {
          ${CORNER_BOX}
          cornerBanner(${frame.banner ? 'true' : 'false'});
          const panel = cornerBox(document.getElementById('map-legend-panel'));
          const pane = cornerBox(document.getElementById('map-pane'));
          const pipEl = document.querySelector('[data-pip="horizon"]');
          const pipStyle = pipEl ? getComputedStyle(pipEl) : null;
          const pip = cornerBox(pipEl);
          const pipShown = !!(pipEl && pipStyle && pipStyle.display !== 'none' && pip && pip.width > 0 && pip.height > 0);
          const text = (document.getElementById('map-legend-panel')?.innerText || '').replace(/\\s+/g, ' ').trim();
          return {
            panel, pane, pip, pipShown, text,
            clipAbovePane: panel && pane ? Math.max(0, pane.top - panel.top) : null,
            clipBelowPane: panel && pane ? Math.max(0, panel.bottom - pane.bottom) : null,
            clipAboveViewport: panel ? Math.max(0, -panel.top) : null,
            clipBelowViewport: panel ? Math.max(0, panel.bottom - innerHeight) : null,
            overlapPip: cornerMeets(panel, pipShown ? pip : null),
            insideX: !!(panel && pane && panel.left >= pane.left - 0.5 && panel.right <= pane.right + 0.5),
            actions: !!document.querySelector('#status-banner .banner-actions'),
          };
        })()`);
        lines.push(`${frame.name} panel ${cornerRound(sample?.panel?.left)},${cornerRound(sample?.panel?.top)} ${cornerRound(sample?.panel?.width)}x${cornerRound(sample?.panel?.height)} clip-above ${cornerRound(sample?.clipAbovePane)} pip ${cornerRound(sample?.pip?.top)}-${cornerRound(sample?.pip?.bottom)} overlap ${sample?.overlapPip === true}`);
        const clips = [sample?.clipAbovePane, sample?.clipBelowPane, sample?.clipAboveViewport, sample?.clipBelowViewport];
        const warning = /LIVE now|feed unavailable/.test(sample?.text || '');
        if (!warning || clips.some((value) => value == null || value > 0.5) || !sample?.insideX) {
          failures.push(`${frame.name} panel clipped above-pane ${cornerRound(sample?.clipAbovePane)} below-pane ${cornerRound(sample?.clipBelowPane)} above-view ${cornerRound(sample?.clipAboveViewport)} below-view ${cornerRound(sample?.clipBelowViewport)}`);
        }
        if (frame.banner && !sample?.actions) failures.push(`${frame.name} banner actions missing during the rect read`);
        if (frame.pip && !sample?.pipShown) failures.push(`${frame.name} horizon inset missing`);
        if (frame.pip && sample?.overlapPip) {
          failures.push(`${frame.name} panel meets horizon pip panel-top ${cornerRound(sample?.panel?.top)} pip-bottom ${cornerRound(sample?.pip?.bottom)}`);
        }
        await shot(send, evidenceDir, frame.shot);
      }
    } finally {
      cdp.close();
    }
  } finally {
    try {
      process.kill(chromePid, 'SIGTERM');
    } catch {
    }
  }
  writeFileSync(resolve(evidenceDir, 'map-corner.txt'), `${lines.join('\n')}\n`);
  for (const line of lines) console.log(line);
  if (failures.length) throw new Error(['map-corner fail', ...failures].join('\n'));
  return 'map-corner pass';
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
  await click(send, '#tab-iss');
  const issBanner = await waitFor(
    send,
    `(() => {
      const view = document.getElementById('view')?.className;
      const banner = document.getElementById('status-banner');
      if (!banner || view !== 'view-iss') return null;
      return { ok: true, position: getComputedStyle(banner).position };
    })()`,
    'iss banner',
  );
  if (issBanner.position !== 'static') throw new Error(`iss banner ${issBanner.position}`);
  const tle = await proveStaleTle(send, evidenceDir, baseUrl);
  const held = await proveHeldSignIn(send, evidenceDir, baseUrl);
  return `banner: ${text.trim()}, queue ${queueBanner.position}, iss ${issBanner.position}, tle ${tle}, held ${held}`;
}

async function setTleCookie(send, stale) {
  const assignment = stale
    ? `document.cookie = 'opd-verify-tle=stale; path=/'`
    : `document.cookie = 'opd-verify-tle=; path=/; max-age=0'`;
  await evaluate(send, assignment);
}

const BANNER_AGE_LABEL = /<1 min|\d+ min|\d+h \d+m/;

export function bannerAgeNormalized(text) {
  return String(text).replace(/<1 min|\d+ min|\d+h \d+m/g, 'AGE');
}

function assertBannerAgeSamples() {
  const suffix = 'TLE 72h old — live track may drift';
  const fresh = `Last updated <1 min ago · ${suffix}`;
  const minute = `Last updated 1 min ago · ${suffix}`;
  if (bannerAgeNormalized(fresh) !== bannerAgeNormalized(minute)) {
    throw new Error('banner age normalization missed <1 min to 1 min');
  }
  if (!bannerAgeNormalized(fresh).includes(suffix) || bannerAgeNormalized(fresh).includes('<1 min')) {
    throw new Error('banner age normalization changed the TLE suffix');
  }
  const held = 'SIGN IN AGAIN — session expired, data frozen 3h 20m ago. Tap here.';
  const heldNext = 'SIGN IN AGAIN — session expired, data frozen 3h 21m ago. Tap here.';
  if (bannerAgeNormalized(held) !== bannerAgeNormalized(heldNext) || bannerAgeNormalized(held).includes('3h')) {
    throw new Error('banner age normalization missed an hour-minute step');
  }
}

function bannerAgeToken(text) {
  return String(text).match(BANNER_AGE_LABEL)?.[0] ?? '';
}

async function proveStaleTle(send, evidenceDir, baseUrl) {
  const suffix = 'TLE 72h old — live track may drift';
  assertBannerAgeSamples();
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
  const beforeAge = bannerAgeToken(before);
  if (!beforeAge) throw new Error(`stale TLE banner has no age label: ${before}`);
  await evaluate(send, `(() => {
    window.__opdRealNow = Date.now;
    const base = Date.now();
    Date.now = () => base + 70000;
    return true;
  })()`);
  let afterTick = before;
  let afterAge = beforeAge;
  const started = Date.now();
  try {
    while (Date.now() - started < 3000) {
      afterTick = await evaluate(send, `(() => {
        const banner = document.getElementById('status-banner');
        const text = banner ? banner.textContent || '' : '';
        if (!banner || !banner.classList.contains('banner-orange')) return '';
        return text;
      })()`);
      afterAge = bannerAgeToken(afterTick);
      if (
        afterTick.includes(suffix)
        && afterTick.includes('Last updated')
        && bannerAgeNormalized(afterTick) === bannerAgeNormalized(before)
        && afterAge
        && afterAge !== beforeAge
      ) {
        break;
      }
      await sleep(100);
    }
  } finally {
    await evaluate(send, `(() => { if (window.__opdRealNow) Date.now = window.__opdRealNow; return true; })()`);
  }
  if (!afterTick.includes(suffix) || bannerAgeNormalized(afterTick) !== bannerAgeNormalized(before)) {
    throw new Error(`countdown dropped the TLE suffix: ${afterTick}`);
  }
  if (!afterAge || afterAge === beforeAge) {
    throw new Error(`age label did not move across the clock jump: ${beforeAge} -> ${afterAge} (${afterTick})`);
  }
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
  return `72h held, age ${beforeAge} to ${afterAge}`;
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

function mapLayerReadyExpression() {
  return `window.__opdMap && window.__opdMap.getLayer && window.__opdMap.getLayer('iss-track-layer') ? { ok: true } : null`;
}

async function waitMapLayer(send) {
  await waitFor(send, mapLayerReadyExpression(), 'map after chrome reload', 45000);
}

async function proveMapChromeMemory(send) {
  await waitChromeChoice(send, true);
  await reloadSettled(send);
  await waitChromeChoice(send, true);
  await waitMapLayer(send);
  await click(send, '#map-chrome-toggle');
  await waitChromeChoice(send, false);
  await reloadSettled(send);
  await waitChromeChoice(send, false);
  await showMapChrome(send);
  await waitMapLayer(send);
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
    if (text.includes('Verify Horizon') || !text.includes('Verify Likely')) return null;
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
  const upcomingSize = await evaluate(send, `({ width: innerWidth, height: innerHeight })`);
  if (upcomingSize.width === 402 && upcomingSize.height === 874) {
    await setViewport(send, 874, 402, true);
    await waitFor(send, upcomingListExpression(mesa, ascent, { hidden: false }), 'upcoming 874x402');
    await shot(send, evidenceDir, 'upcoming-874x402');
    await setViewport(send, 402, 874, true);
    await waitFor(send, upcomingListExpression(mesa, ascent, { hidden: false }), 'upcoming portrait restored');
  }
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
  return `upcoming: ${ascent} and Verify Likely above ${mesa}, Verify Horizon omitted, score sort, hide persisted ${mesaId}, fresh profile hid it`;
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

function chipBacking(color) {
  const parsed = rgbaChannels(color);
  if (!parsed) return false;
  return parsed.a >= 0.7 && parsed.r <= 20 && parsed.g <= 24 && parsed.b <= 30;
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
    const hide = document.getElementById('map-chrome-toggle')?.getBoundingClientRect();
    const legend = document.getElementById('map-legend-toggle')?.getBoundingClientRect();
    const zoom = document.querySelector('.maplibregl-ctrl-top-left')?.getBoundingClientRect();
    const hits = (a, b) => a && b && a.width > 0 && b.width > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const slider = document.getElementById('time-slider');
    const sliderBox = slider ? slider.getBoundingClientRect() : null;
    const fitting = innerWidth >= 800 && innerHeight >= 600;
    const shortRow = innerHeight <= 520 && innerWidth >= 720;
    const narrow = innerWidth <= 800 && !shortRow && !fitting;
    let reserved = null;
    if (narrow) {
      const probe = document.createElement('div');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.height = 'var(--map-command-height)';
      document.body.appendChild(probe);
      const height = probe.getBoundingClientRect().height;
      probe.remove();
      const insetProbe = document.createElement('div');
      insetProbe.style.position = 'absolute';
      insetProbe.style.visibility = 'hidden';
      insetProbe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
      document.body.appendChild(insetProbe);
      const inset = Number.parseFloat(getComputedStyle(insetProbe).paddingBottom) || 0;
      insetProbe.remove();
      reserved = { height, inset, expect: 140 + inset };
    }
    const pipNode = document.querySelector('[data-pip="horizon"]');
    const pipShown = pipNode && !pipNode.hidden && getComputedStyle(pipNode).display !== 'none';
    const pip = pipShown ? pipNode.getBoundingClientRect() : null;
    const pipHits = pip ? hits(stripBox, pip) : false;
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
      stripWidth: stripBox.width,
      stripHeight: stripBox.height,
      rightGap: paneBox.right - stripBox.right,
      slider: sliderBox ? sliderBox.height : null,
      fitting,
      narrow,
      reserved,
      paneWidth: paneBox.width,
      fullBleed: stripBox.width > paneBox.width - 80,
      hide: hits(stripBox, hide),
      legend: hits(stripBox, legend),
      zoom: hits(stripBox, zoom),
      pip: pipHits,
      events: stripStyle.pointerEvents,
    };
  })()`);
  const paddingClear = laid
    && laid.paddingTop === '0px'
    && laid.paddingRight === '0px'
    && laid.paddingBottom === '0px'
    && laid.paddingLeft === '0px';
  const gapClear = laid && laid.rowGap === '0px' && laid.columnGap === '0px';
  const geometry = laid && (!laid.fitting || (
    Math.abs(laid.stripHeight - 96) <= 2
    && Math.abs(laid.rightGap - 204) <= 2
    && Math.abs(laid.slider - 32) <= 1
  ));
  const narrowOk = laid && (!laid.narrow || (
    laid.reserved
    && Math.abs(laid.reserved.height - laid.reserved.expect) <= 2
  ));
  if (!laid || Math.abs(laid.gap) > 1 || laid.bottom !== '0px' || !gapClear || !paddingClear || !laid.covers || !paintIsClear(laid.color) || !chipBacking(laid.controls) || laid.fullBleed || laid.hide || laid.legend || laid.zoom || laid.pip || laid.events !== 'none' || !geometry || !narrowOk) {
    throw new Error(`time strip not laid on the map ${JSON.stringify(laid)}`);
  }
  return laid;
}

async function proveMapControlHits(send, label) {
  const hit = await evaluate(send, `(() => {
    const sels = ['.maplibregl-ctrl-zoom-in', '.maplibregl-ctrl-zoom-out', '.maplibregl-ctrl-compass', '#map-legend-toggle', '#map-chrome-toggle', '#time-slider', '#time-back-90', '#time-back-45', '#time-now', '#time-fwd-45', '#time-fwd-90'];
    const misses = [];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, reason: 'missing', sel };
      const box = el.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) return { ok: false, reason: 'box', sel, w: box.width, h: box.height };
      const node = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!node || (node !== el && !el.contains(node))) misses.push({ sel, hit: node ? (node.id || node.getAttribute('aria-label') || node.tagName) : null });
    }
    return misses.length ? { ok: false, reason: 'elementFromPoint', misses } : { ok: true };
  })()`);
  if (!hit?.ok) throw new Error(`map control hit ${label} ${JSON.stringify(hit)}`);
}

function insetViewportFits(width, height) {
  return width >= 800 && height >= 600;
}

const PIP_MAP_OBSTACLES = [
  '.topbar',
  '#status-banner',
  '.map-toolbar',
  '.map-group-label',
  '#filter-all-map',
  '#filter-mine-map',
  '#filter-launches-map',
  '.maplibregl-ctrl-top-left',
  '.maplibregl-ctrl-bottom-right',
  '.map-control-dock',
  '#bearing-north',
  '#bearing-iss',
  '#toggle-follow-iss',
  '#toggle-clouds',
  '#toggle-ir',
  '#toggle-terminator',
  '#toggle-night-lights',
  '#toggle-labels',
  '#toggle-multi-orbit',
  '#toggle-satellite-picker',
  '.map-command',
  '#time-slider',
  '.time-slider-end',
  '#time-slider-readout',
  '#time-back-90',
  '#time-back-45',
  '#time-now',
  '#time-fwd-45',
  '#time-fwd-90',
  '#map-chrome-toggle',
  '.map-legend',
  '#map-legend-toggle',
  '#map-legend-panel',
  '.map-legend-item',
  '.map-imagery-date',
  '#map-launch-coverage',
  '#satellite-picker-panel',
  '#help-fab',
  '#shotlist-bar',
];

const PIP_ISS_OBSTACLES = [
  '.topbar',
  '#status-banner',
  '#help-fab',
  '[data-iss-aim-help]',
  '[data-iss-fullscreen]',
  '[data-iss-preset]',
  '[data-iss-cupola]',
  '[data-iss-window]',
  '[data-iss-port]',
  '[data-iss-starboard]',
  '[data-iss-fov]',
  '[data-iss-hint]',
  '[data-iss-launch-card]',
  '[data-iss-telemetry]',
  '[data-iss-launch-picker]',
  '[data-iss-launch]',
  '.maplibregl-ctrl-attrib',
  '.iss-place',
];

function pipReadyExpression(name) {
  const label = name === 'horizon' ? 'Show the ISS view' : 'Show the map';
  return `(() => {
    const inset = document.querySelector('[data-pip="${name}"]');
    if (!inset || inset.hidden) return null;
    const style = getComputedStyle(inset);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const box = inset.getBoundingClientRect();
    if (${name === 'horizon' ? 'true' : 'false'}) {
      const pane = document.getElementById('map-pane');
      const paneBox = pane ? pane.getBoundingClientRect() : null;
      const rightGap = paneBox ? paneBox.right - box.right : null;
      if (Math.abs(box.width - 222) > 1 || Math.abs(box.height - 144) > 1) return { step: 'size', width: box.width, height: box.height };
      if (rightGap == null || Math.abs(rightGap - 12) > 2) return { step: 'place', rightGap, width: box.width, height: box.height };
      const bar = document.querySelector('.topbar')?.getBoundingClientRect();
      if (bar && box.top < bar.bottom - 1) return { step: 'topbar', pipTop: box.top, barBottom: bar.bottom };
      const dock = document.querySelector('.map-control-dock')?.getBoundingClientRect();
      if (dock && dock.height > 8 && box.bottom > dock.top + 1) return { step: 'stack', pipBottom: box.bottom, dockTop: dock.top };
      const legend = document.getElementById('map-legend-toggle')?.getBoundingClientRect();
      const hide = document.getElementById('map-chrome-toggle')?.getBoundingClientRect();
      if (legend && hide && legend.width > 8 && hide.width > 8 && legend.right > hide.left - 1) {
        return { step: 'legend', legendRight: legend.right, hideLeft: hide.left };
      }
    } else if (box.width < 44 || box.height < 44) {
      return { step: 'size', width: box.width, height: box.height };
    }
    const canvas = inset.querySelector('canvas');
    if (!canvas || canvas.clientWidth < 2 || canvas.clientHeight < 2) return { step: 'canvas' };
    if (inset.getAttribute('aria-label') !== ${JSON.stringify(label)}) return { step: 'label', aria: inset.getAttribute('aria-label') };
    if (${name === 'plan' ? 'true' : 'false'}) {
      const scene = document.querySelector('[data-iss-scene]');
      if (scene?.getAttribute('data-iss-split') !== 'on') return { step: 'split', attr: scene?.getAttribute('data-iss-split') || null };
      const host = document.getElementById('iss-host')?.getBoundingClientRect();
      const telemetry = document.querySelector('[data-iss-telemetry]')?.getBoundingClientRect();
      const picker = document.querySelector('[data-iss-launch-picker]')?.getBoundingClientRect();
      const frame = inset.querySelector('[data-pip-frame]');
      const orbit = frame && frame.__opdTrackInset;
      const glyphs = Number(frame?.getAttribute('data-inset-glyphs') || '0');
      if (!host || host.width + 1 < box.width) return { step: 'cupola', host: host && Math.round(host.width), map: Math.round(box.width) };
      if (!telemetry || telemetry.top < box.bottom - 1) return { step: 'telemetry', telemetryTop: telemetry && Math.round(telemetry.top), mapBottom: Math.round(box.bottom) };
      if (!picker || picker.top < box.bottom - 1) return { step: 'launch', pickerTop: picker && Math.round(picker.top), mapBottom: Math.round(box.bottom) };
      if (box.width * box.height < 148 * 96 * 3) return { step: 'scale', width: Math.round(box.width), height: Math.round(box.height) };
      if (!orbit || typeof orbit.project !== 'function' || typeof orbit.getCanvas !== 'function' || typeof orbit.querySourceFeatures !== 'function') {
        return { step: 'orbit', reason: 'map' };
      }
      const marker = inset.querySelector('.iss-marker');
      if (!marker) return { step: 'marker', reason: 'missing' };
      const markerBox = marker.getBoundingClientRect();
      const canvas = orbit.getCanvas();
      const canvasBox = canvas.getBoundingClientRect();
      const markerInside = markerBox.width > 8 && markerBox.height > 4
        && markerBox.left >= canvasBox.left - 1 && markerBox.right <= canvasBox.right + 1
        && markerBox.top >= canvasBox.top - 1 && markerBox.bottom <= canvasBox.bottom + 1;
      if (!markerInside) {
        return {
          step: 'marker',
          marker: [Math.round(markerBox.left), Math.round(markerBox.top), Math.round(markerBox.right), Math.round(markerBox.bottom)],
          canvas: [Math.round(canvasBox.left), Math.round(canvasBox.top), Math.round(canvasBox.right), Math.round(canvasBox.bottom)],
        };
      }
      let trackFeatures = [];
      try {
        trackFeatures = orbit.querySourceFeatures('inset-track') || [];
      } catch (error) {
        return { step: 'track', reason: 'query' };
      }
      let coords = 0;
      let outside = null;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      for (const feature of trackFeatures) {
        const geometry = feature && feature.geometry;
        if (!geometry || geometry.type !== 'LineString' || !geometry.coordinates) continue;
        for (const pair of geometry.coordinates) {
          const lon = pair[0];
          const lat = pair[1];
          if (!(lon >= -180 && lon <= 180) || !(lat >= -90 && lat <= 90)) continue;
          const point = orbit.project(pair);
          coords += 1;
          if (!(point.x >= -1 && point.y >= -1 && point.x <= width + 1 && point.y <= height + 1)) {
            outside = { x: Math.round(point.x), y: Math.round(point.y), lon, lat, width, height };
            break;
          }
        }
        if (outside) break;
      }
      if (coords < 8 || outside) return { step: 'track', coords, outside, width, height };
      ${planLabelReaders()}
      const labels = readPlanLabels(orbit, glyphs, width, height);
      if (!labels.ok) return labels;
      const pageText = document.body ? document.body.innerText || '' : '';
      if (pageText.includes('API KEY REQUIRED')) return { error: 'API KEY REQUIRED on the page' };
      const basemap = orbit.getStyle && orbit.getStyle().sources && orbit.getStyle().sources['inset-basemap'];
      const template = basemap && basemap.tiles && basemap.tiles[0] ? basemap.tiles[0] : '';
      if (!template) return { error: 'API KEY REQUIRED missing inset basemap' };
      if (/cartocdn\\.com|\\/dark_all\\//.test(template)) return { error: 'API KEY REQUIRED carto basemap ' + template };
      const cartoHits = performance.getEntriesByType('resource').filter((entry) => /basemaps\\.cartocdn\\.com\\/dark_all/.test(entry.name));
      if (cartoHits.length) return { error: 'API KEY REQUIRED fetched carto ' + cartoHits.length };
      if (frame.dataset.insetBasemapProbe === 'error') return { error: 'API KEY REQUIRED basemap probe failed' };
      if (frame.dataset.insetBasemapProbe !== 'done') {
        if (frame.dataset.insetBasemapProbe !== 'pending') {
          frame.dataset.insetBasemapProbe = 'pending';
          const url = template.split('{z}').join('2').split('{x}').join('1').split('{y}').join('1');
          fetch(url).then(async (response) => {
            const bytes = (await response.arrayBuffer()).byteLength;
            frame.dataset.insetBasemapBytes = String(bytes);
            frame.dataset.insetBasemapEtag = response.headers.get('etag') || '';
            frame.dataset.insetBasemapType = response.headers.get('content-type') || '';
            frame.dataset.insetBasemapProbe = 'done';
          }).catch(() => { frame.dataset.insetBasemapProbe = 'error'; });
        }
        return { step: 'watermark', reason: 'probe' };
      }
      const tileBytes = Number(frame.dataset.insetBasemapBytes || '0');
      const tileEtag = frame.dataset.insetBasemapEtag || '';
      const tileType = frame.dataset.insetBasemapType || '';
      if (tileEtag.includes('wm-') || tileBytes === 2513 || (tileType.includes('png') && tileBytes > 0 && tileBytes < 4000)) {
        return { error: 'API KEY REQUIRED watermark tile ' + tileBytes + ' ' + tileEtag + ' ' + tileType };
      }
    }
    return { ok: true, width: box.width, height: box.height };
  })()`;
}

function pipClearExpression(name, selectors) {
  return `(() => {
    const inset = document.querySelector('[data-pip="${name}"]');
    if (!inset || inset.hidden) return { step: 'hidden' };
    const style = getComputedStyle(inset);
    if (style.display === 'none' || style.visibility === 'hidden') return { step: 'display' };
    const box = inset.getBoundingClientRect();
    const hits = [];
    for (const sel of ${JSON.stringify(selectors)}) {
      for (const node of document.querySelectorAll(sel)) {
        if (!(node instanceof Element) || inset.contains(node) || node.contains(inset)) continue;
        if (node.hidden) continue;
        const nodeStyle = getComputedStyle(node);
        if (nodeStyle.display === 'none' || nodeStyle.visibility === 'hidden') continue;
        if (node.getClientRects().length === 0) continue;
        let other = node.getBoundingClientRect();
        let clip = node.parentElement;
        while (clip) {
          const clipStyle = getComputedStyle(clip);
          const oy = clipStyle.overflowY;
          const ox = clipStyle.overflowX;
          if (oy === 'auto' || oy === 'scroll' || oy === 'hidden' || ox === 'auto' || ox === 'scroll' || ox === 'hidden') {
            const bounds = clip.getBoundingClientRect();
            const left = Math.max(other.left, bounds.left);
            const top = Math.max(other.top, bounds.top);
            const right = Math.min(other.right, bounds.right);
            const bottom = Math.min(other.bottom, bounds.bottom);
            other = { left, top, right, bottom, width: right - left, height: bottom - top };
          }
          clip = clip.parentElement;
        }
        if (other.width < 1 || other.height < 1) continue;
        if (box.left < other.right - 0.5 && box.right > other.left + 0.5 && box.top < other.bottom - 0.5 && box.bottom > other.top + 0.5) {
          hits.push(sel);
          break;
        }
      }
    }
    if (hits.length) return { step: 'overlap', hits, box: [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)] };
    return { ok: true, width: Math.round(box.width), height: Math.round(box.height) };
  })()`;
}

function pipAbsentExpression(name) {
  return `(() => {
    const inset = document.querySelector('[data-pip="${name}"]');
    const scene = document.querySelector('[data-iss-scene]');
    const pad = scene ? parseFloat(getComputedStyle(scene).paddingBottom) : 0;
    if (${name === 'plan' ? 'true' : 'false'} && scene) {
      if (pad > 40) return { step: 'pad', pad };
      if (scene.getAttribute('data-iss-split') === 'on') return { step: 'split' };
      const clock = document.querySelector('[data-iss-clock]');
      const toolbar = document.querySelector('[data-iss-toolbar]');
      if (clock && toolbar && !toolbar.contains(clock)) return { step: 'clock-home' };
      const card = document.querySelector('[data-iss-card]');
      if (card && !scene.contains(card)) return { step: 'card-home' };
    }
    if (!inset) return { ok: true };
    const style = getComputedStyle(inset);
    const box = inset.getBoundingClientRect();
    const gone = inset.hidden || style.display === 'none' || style.visibility === 'hidden' || inset.getClientRects().length === 0;
    if (!gone) return { step: 'shown', width: box.width, height: box.height };
    return { ok: true };
  })()`;
}

function phoneInsetPanes(viewport) {
  const panes = [{ width: viewport.height, height: viewport.width }];
  if (Math.min(viewport.width, viewport.height) <= 402) {
    panes.push(
      { width: 874, height: 402 },
      { width: 844, height: 390 },
      { width: 932, height: 430 },
      { width: 390, height: 844 },
      { width: 402, height: 874 },
    );
  }
  const seen = new Set();
  return panes.filter((pane) => {
    const key = `${pane.width}x${pane.height}`;
    if (seen.has(key)) return false;
    if (pane.width === viewport.width && pane.height === viewport.height) return false;
    seen.add(key);
    return true;
  });
}

function legendCentersMissInset() {
  return `(() => {
    const inset = document.querySelector('[data-pip="horizon"]');
    if (!inset) return { step: 'inset' };
    const insetBox = inset.getBoundingClientRect();
    const nodes = [
      ['map-legend-toggle', document.getElementById('map-legend-toggle')],
      ['map-legend-panel', document.getElementById('map-legend-panel')],
      ['map-chrome-toggle', document.getElementById('map-chrome-toggle')],
      ['.maplibregl-ctrl-zoom-in', document.querySelector('.maplibregl-ctrl-zoom-in')],
      ['.maplibregl-ctrl-zoom-out', document.querySelector('.maplibregl-ctrl-zoom-out')],
      ['.maplibregl-ctrl-compass', document.querySelector('.maplibregl-ctrl-compass')],
      ['#shotlist-bar', document.getElementById('shotlist-bar')],
    ];
    for (const [id, node] of nodes) {
      if (!node) {
        if (id === '#shotlist-bar') continue;
        return { step: 'missing', id };
      }
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const box = node.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && inset.contains(hit)) return { step: 'covered', id };
      if (insetBox.left < box.right - 0.5 && insetBox.right > box.left + 0.5 && insetBox.top < box.bottom - 0.5 && insetBox.bottom > box.top + 0.5) {
        return { step: 'overlap', id };
      }
    }
    return { ok: true };
  })()`;
}

async function openMapLegend(send) {
  if (await evaluate(send, `document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'true'`)) return;
  await click(send, '#map-legend-toggle');
  await waitFor(
    send,
    `document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'true' ? { ok: true } : null`,
    'legend open for inset',
    5000,
  );
}

async function closeMapLegend(send) {
  if (await evaluate(send, `document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') !== 'true'`)) return;
  await click(send, '#map-legend-toggle');
  await waitFor(
    send,
    `document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'false' ? { ok: true } : null`,
    'legend closed after inset',
    5000,
  );
}

function assertPlanBasemap(send, label, page) {
  const verdict = planBasemapVerdict(send.cartoDark, page);
  if (!verdict.ok) {
    throw new Error(`${label}: API KEY REQUIRED carto dark_all ${verdict.url || verdict.reason}`);
  }
}

async function waitForPip(send, name, label, timeoutMs = 30000) {
  const ready = await waitFor(send, pipReadyExpression(name), label, timeoutMs);
  if (name === 'plan') assertPlanBasemap(send, label, ready);
  return ready;
}

async function holdFittingInset(send, evidenceDir, name, obstacles, shotBase, pane) {
  await setViewport(send, pane.width, pane.height, pane.mobile);
  await waitForPip(send, name, `${name} inset ${pane.width}x${pane.height}`);
  await waitFor(send, pipClearExpression(name, obstacles), `${name} inset ${pane.width}x${pane.height} clear`, 10000);
  if (name === 'horizon') await waitFor(send, legendCentersMissInset(), `${name} legend centers ${pane.width}x${pane.height}`, 10000);
  if (pane.shot) {
    await sleep(800);
    await shot(send, evidenceDir, `${shotBase}-${pane.shot}`);
  }
}

function toolbarInsetPanes(mobile) {
  if (mobile) {
    return [
      { width: 1194, height: 710, mobile: true, shot: '1194x710' },
      { width: 1194, height: 700, mobile: true, shot: '1194x700' },
    ];
  }
  return [
    { width: 1280, height: 700, mobile: false, shot: '1280x700' },
    { width: 1194, height: 710, mobile: false, shot: '1194x710' },
    { width: 1194, height: 700, mobile: false, shot: '1194x700' },
  ];
}

async function provePipSurface(send, evidenceDir, viewport, which) {
  const name = which === 'map' ? 'horizon' : 'plan';
  const obstacles = which === 'map' ? PIP_MAP_OBSTACLES : PIP_ISS_OBSTACLES;
  const shotBase = which === 'map' ? 'pip-map' : 'pip-iss';
  if (!insetViewportFits(viewport.width, viewport.height)) {
    await waitFor(send, pipAbsentExpression(name), `${name} inset absent`, 10000);
    await shot(send, evidenceDir, `${shotBase}-absent`);
    const held = [`${viewport.width}x${viewport.height}`];
    for (const pane of phoneInsetPanes(viewport)) {
      await setViewport(send, pane.width, pane.height, true);
      await waitFor(send, pipAbsentExpression(name), `${name} inset absent ${pane.width}x${pane.height}`, 10000);
      await shot(send, evidenceDir, `${shotBase}-absent-${pane.width}x${pane.height}`);
      held.push(`${pane.width}x${pane.height}`);
    }
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
    return `absent ${held.join(' ')}`;
  }
  const ready = await waitForPip(send, name, `${name} inset`);
  if (name === 'horizon') await openMapLegend(send);
  const clear = await waitFor(send, pipClearExpression(name, obstacles), `${name} inset clear`, 10000);
  if (name === 'horizon') await waitFor(send, legendCentersMissInset(), `${name} legend centers`, 10000);
  await sleep(1200);
  await shot(send, evidenceDir, shotBase);
  const extra = [`${viewport.width}x${viewport.height}`];
  if (viewport.mobile) {
    await setViewport(send, viewport.height, viewport.width, true);
    await waitForPip(send, name, `${name} inset landscape`);
    await waitFor(send, pipClearExpression(name, obstacles), `${name} inset landscape clear`, 10000);
    if (name === 'horizon') await waitFor(send, legendCentersMissInset(), `${name} legend centers landscape`, 10000);
    await sleep(800);
    await shot(send, evidenceDir, `${shotBase}-land`);
    extra.push(`${viewport.height}x${viewport.width}`);
    for (const pane of toolbarInsetPanes(true)) {
      await holdFittingInset(send, evidenceDir, name, obstacles, shotBase, pane);
      extra.push(`${pane.width}x${pane.height}`);
    }
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  } else {
    await setViewport(send, 1280, 800, false);
    await waitForPip(send, name, `${name} inset 1280x800`);
    await waitFor(send, pipClearExpression(name, obstacles), `${name} inset 1280 clear`, 10000);
    if (name === 'horizon') await waitFor(send, legendCentersMissInset(), `${name} legend centers 1280`, 10000);
    await sleep(800);
    await shot(send, evidenceDir, `${shotBase}-1280`);
    extra.push('1280x800');
    for (const pane of toolbarInsetPanes(false)) {
      await holdFittingInset(send, evidenceDir, name, obstacles, shotBase, pane);
      extra.push(`${pane.width}x${pane.height}`);
    }
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
  if (name === 'horizon') {
    await waitFor(send, legendCentersMissInset(), `${name} legend centers restored`, 10000);
    await closeMapLegend(send);
  }
  await waitForPip(send, name, `${name} inset restored`);
  return `present ${ready.width}x${ready.height} clear ${clear.width}x${clear.height} ${extra.join(' ')}`;
}

async function pressInset(send, name, mobile) {
  const aim = await evaluate(send, `(() => {
    const button = document.querySelector('[data-pip="${name}"]');
    if (!button) return { ok: false, reason: 'missing' };
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const node = document.elementFromPoint(x, y);
    const hit = node ? (node.getAttribute('aria-label') || node.id || node.className || node.tagName) : null;
    return { ok: !!node && button.contains(node), x, y, hit };
  })()`);
  if (!aim?.ok) throw new Error(`inset ${name} hit ${JSON.stringify(aim)}`);
  if (mobile) await send('Input.tap', { x: aim.x, y: aim.y });
  else await mouseClick(send, aim.x, aim.y);
  return aim;
}

async function legendTabPoint(send) {
  return evaluate(send, `(() => {
    const button = document.getElementById('map-legend-toggle');
    const panel = document.getElementById('map-legend-panel');
    if (!(button instanceof HTMLButtonElement) || !panel) return { ok: false, reason: 'missing' };
    const rect = button.getBoundingClientRect();
    if (rect.width < 44 || rect.height < 44) return { ok: false, reason: 'hit', w: rect.width, h: rect.height };
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== button && !button.contains(hit))) {
      return { ok: false, reason: 'elementFromPoint', tag: hit && hit.tagName, id: hit && hit.id, className: hit && String(hit.className) };
    }
    return { ok: true, x, y, expanded: button.getAttribute('aria-expanded') };
  })()`);
}

async function activateLegendTab(send) {
  const point = await legendTabPoint(send);
  if (!point?.ok) throw new Error(`legend tab ${JSON.stringify(point)}`);
  if (send.pointer === 'touch') await send('Input.touchscreenTap', { x: point.x, y: point.y });
  else await mouseClick(send, point.x, point.y);
}

async function proveLegendDisclosure(send, evidenceDir, viewport, suffix = '') {
  const name = (base) => (suffix ? `${base}-${suffix}` : base);
  const closed = await evaluate(send, `(() => {
    const button = document.getElementById('map-legend-toggle');
    const panel = document.getElementById('map-legend-panel');
    const badge = document.querySelector('.map-imagery-date');
    const slider = document.getElementById('time-slider');
    if (!(button instanceof HTMLButtonElement) || !panel || !badge || !slider) return { ok: false, reason: 'missing' };
    if (button.getAttribute('aria-expanded') !== 'false' || button.getAttribute('aria-controls') !== 'map-legend-panel') {
      return { ok: false, expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls') };
    }
    const panelStyle = getComputedStyle(panel);
    const badgeRect = badge.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (panelStyle.display !== 'none' || badgeRect.width > 0 || badgeRect.height > 0) {
      return { ok: false, reason: 'visible', display: panelStyle.display, badge: { w: badgeRect.width, h: badgeRect.height } };
    }
    const dot = button.querySelector('.map-legend-warning-dot');
    const imagery = (badge.textContent || '').trim();
    const warning = imagery.includes('feed unavailable') || imagery.includes('LIVE now (not the scrubbed time)');
    if (!warning && dot && !dot.hasAttribute('hidden')) return { ok: false, reason: 'warning dot' };
    const blockers = ['.map-command', '.map-toolbar', '.map-control-dock', '#map-chrome-toggle', '#time-slider', '.maplibregl-ctrl-top-left'];
    for (const sel of blockers) {
      const node = document.querySelector(sel);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const overlaps = buttonRect.width > 0 && rect.width > 0 && buttonRect.left < rect.right && buttonRect.right > rect.left && buttonRect.top < rect.bottom && buttonRect.bottom > rect.top;
      if (overlaps) return { ok: false, reason: 'overlap', sel, button: { top: buttonRect.top, bottom: buttonRect.bottom, left: buttonRect.left, right: buttonRect.right }, other: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } };
    }
    const zoomOut = document.querySelector('.maplibregl-ctrl-zoom-out');
    if (zoomOut) {
      const zoomRect = zoomOut.getBoundingClientRect();
      if (zoomRect.width > 0 && zoomRect.height > 0) {
        const zoomHit = document.elementFromPoint(zoomRect.left + zoomRect.width / 2, zoomRect.top + zoomRect.height / 2);
        if (zoomHit === button || button.contains(zoomHit)) {
          return { ok: false, reason: 'zoom-out hit', tag: zoomHit && zoomHit.tagName, id: zoomHit && zoomHit.id };
        }
      }
    }
    return { ok: true };
  })()`);
  if (!closed?.ok) throw new Error(`legend collapsed ${suffix || 'shown'} ${JSON.stringify(closed)}`);
  await shot(send, evidenceDir, name('map-legend-collapsed'));
  if (!suffix) await shot(send, evidenceDir, 'map-legend');
  await activateLegendTab(send);
  const opened = await waitFor(
    send,
    `(() => {
      const button = document.getElementById('map-legend-toggle');
      const badge = document.querySelector('.map-imagery-date');
      const slider = document.getElementById('time-slider');
      if (!button || !badge || !slider) return null;
      if (button.getAttribute('aria-expanded') !== 'true') return null;
      const badgeRect = badge.getBoundingClientRect();
      const sliderRect = slider.getBoundingClientRect();
      if (!(badgeRect.width > 0 && badgeRect.height > 0)) return null;
      const hits = badgeRect.left < sliderRect.right && badgeRect.right > sliderRect.left && badgeRect.top < sliderRect.bottom && badgeRect.bottom > sliderRect.top;
      if (hits) return { error: 'imagery intersects slider ' + JSON.stringify({ badgeTop: badgeRect.top, badgeBottom: badgeRect.bottom, sliderTop: sliderRect.top, sliderBottom: sliderRect.bottom }) };
      const text = (badge.textContent || '').trim();
      if (!text) return null;
      return { ok: true, text };
    })()`,
    'legend expanded',
  );
  if (opened?.error) throw new Error(opened.error);
  await shot(send, evidenceDir, name('map-legend-expanded'));
  if (!suffix) await shot(send, evidenceDir, 'map-imagery-date');
  await activateLegendTab(send);
  await waitFor(
    send,
    `document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'false' ? { ok: true } : null`,
    'legend collapsed again',
  );
  const hiddenNote = await evaluate(send, `(() => {
    const badge = document.querySelector('.map-imagery-date');
    const rect = badge?.getBoundingClientRect();
    return rect && rect.width === 0 && rect.height === 0 ? { ok: true } : { w: rect?.width, h: rect?.height };
  })()`);
  if (!hiddenNote?.ok) throw new Error(`imagery still visible ${JSON.stringify(hiddenNote)}`);
  await evaluate(send, `document.getElementById('map-legend-toggle')?.focus()`);
  await pressKey(send, 'Enter');
  await waitFor(
    send,
    `document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'true' ? { ok: true } : null`,
    'legend keyboard open',
  );
  await pressKey(send, 'Escape');
  await waitFor(
    send,
    `document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'false' ? { ok: true } : null`,
    'legend escape',
  );
  const row = await evaluate(send, `(() => {
    const hide = document.getElementById('map-chrome-toggle')?.getBoundingClientRect();
    const steps = ['time-fwd-45', 'time-fwd-90'].map((id) => {
      const rect = document.getElementById(id)?.getBoundingClientRect();
      return rect ? { id, top: rect.top, height: rect.height, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width } : null;
    });
    if (!hide || steps.some((step) => !step)) return { ok: false, reason: 'missing' };
    const hideCy = hide.top + hide.height / 2;
    const compared = steps.map((step) => {
      const dy = Math.abs(hideCy - (step.top + step.height / 2));
      const heightRatio = Math.abs(hide.height - step.height) / step.height;
      return { id: step.id, dy, heightRatio, hideH: hide.height, stepH: step.height };
    });
    const clipLeft = Math.max(0, Math.min(hide.left, ...steps.map((step) => step.left)) - 8);
    const clipTop = Math.max(0, Math.min(hide.top, ...steps.map((step) => step.top)) - 8);
    const right = Math.max(hide.right, ...steps.map((step) => step.right)) + 8;
    const bottom = Math.max(hide.bottom, ...steps.map((step) => step.bottom)) + 8;
    const clip = {
      x: Math.round(clipLeft),
      y: Math.round(clipTop),
      width: Math.max(1, Math.round(right - clipLeft)),
      height: Math.max(1, Math.round(bottom - clipTop)),
      scale: 1,
    };
    return { ok: true, compared, clip, hide: { top: hide.top, height: hide.height, width: hide.width } };
  })()`);
  if (!row?.ok) throw new Error(`hide row ${JSON.stringify(row)}`);
  const ipad = viewport && viewport.width === 834 && viewport.height === 1194;
  if (ipad) {
    for (const step of row.compared) {
      if (step.dy > 2 || step.heightRatio > 0.15) {
        throw new Error(`iPad hide alignment ${JSON.stringify(step)}`);
      }
    }
  }
  await shot(send, evidenceDir, name('map-hide-skip-row'), row.clip);
  if (!suffix && viewport && ((viewport.width === 402 && viewport.height === 874) || (viewport.width === 1400 && viewport.height === 900))) {
    const inset = viewport.width === 1400
      ? await safeAreaOverride(send, { top: 0, left: 47, bottom: 21, right: 47 })
      : false;
    await proveShortLandscapeLegend(send, evidenceDir, viewport.width === 402);
    if (inset) await safeAreaOverride(send, { top: 0, left: 0, bottom: 0, right: 0 });
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
  if (!suffix && viewport && (
    (viewport.width === 1400 && viewport.height === 900)
    || (viewport.width === 390 && viewport.height === 664)
    || (viewport.width === 402 && viewport.height === 874)
    || (viewport.width === 834 && viewport.height === 1194)
  )) {
    await proveLegendShotlist(send, evidenceDir);
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
}

async function hideMapChrome(send) {
  const hidden = await evaluate(send, `document.body.classList.contains('map-chrome-hidden')`);
  if (hidden) return;
  await click(send, '#map-chrome-toggle');
  await waitFor(
    send,
    `document.body.classList.contains('map-chrome-hidden') && (document.getElementById('map-chrome-toggle')?.textContent || '').trim() === 'Controls' ? { ok: true } : null`,
    'map chrome hidden',
  );
}

async function assertLegendClearOfZoom(send, label) {
  const laid = await evaluate(send, `(() => {
    const button = document.getElementById('map-legend-toggle');
    const zoom = document.querySelector('.maplibregl-ctrl-top-left');
    if (!(button instanceof HTMLButtonElement) || !zoom) return { ok: false, reason: 'missing' };
    const buttonRect = button.getBoundingClientRect();
    const zoomRect = zoom.getBoundingClientRect();
    const shown = !document.body.classList.contains('map-chrome-hidden');
    const overlaps = buttonRect.width > 0 && zoomRect.width > 0 && buttonRect.left < zoomRect.right && buttonRect.right > zoomRect.left && buttonRect.top < zoomRect.bottom && buttonRect.bottom > zoomRect.top;
    let zoomHit = null;
    const zoomOut = document.querySelector('.maplibregl-ctrl-zoom-out');
    if (shown && zoomOut) {
      const rect = zoomOut.getBoundingClientRect();
      const node = rect.width > 0 ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
      zoomHit = node ? { id: node.id, className: String(node.className).slice(0, 80) } : null;
      if (node === button || button.contains(node)) return { ok: false, reason: 'zoom-out hit', zoomHit, button: { left: buttonRect.left, top: buttonRect.top, right: buttonRect.right, bottom: buttonRect.bottom } };
    }
    if (overlaps) {
      return { ok: false, reason: 'overlap', shown, button: { left: buttonRect.left, top: buttonRect.top, right: buttonRect.right, bottom: buttonRect.bottom }, zoom: { left: zoomRect.left, top: zoomRect.top, right: zoomRect.right, bottom: zoomRect.bottom } };
    }
    if (shown && buttonRect.width < 44) return { ok: false, reason: 'hit', w: buttonRect.width, h: buttonRect.height };
    return { ok: true, shown, zoomHit };
  })()`);
  if (!laid?.ok) throw new Error(`legend zoom ${label} ${JSON.stringify(laid)}`);
}

async function proveShortLandscapeLegend(send, evidenceDir, fullLand) {
  const sizes = [
    { width: 874, height: 402, suffix: 'land' },
    { width: 844, height: 390, suffix: '844x390' },
    { width: 932, height: 430, suffix: '932x430' },
  ];
  for (const size of sizes) {
    await setViewport(send, size.width, size.height, true);
    await sleep(400);
    if (fullLand && size.suffix === 'land') {
      await proveLegendDisclosure(send, evidenceDir, { width: size.width, height: size.height, mobile: true }, 'land');
    } else {
      await assertLegendClearOfZoom(send, `${size.suffix} shown`);
    }
    if (size.suffix === 'land') await shot(send, evidenceDir, 'map-legend-land-controls');
    await hideMapChrome(send);
    await assertLegendClearOfZoom(send, `${size.suffix} hidden`);
    await showMapChrome(send);
  }
}

async function assertControlCenters(send, label, selectors) {
  const laid = await evaluate(send, `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const misses = [];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) {
        misses.push({ selector, reason: 'missing' });
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        misses.push({ selector, reason: 'empty', w: rect.width, h: rect.height });
        continue;
      }
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (!(hit && (hit === node || node.contains(hit)))) {
        misses.push({
          selector,
          reason: 'hit',
          id: hit && hit.id ? hit.id : '',
          className: String(hit && hit.className || '').slice(0, 80),
          cx: Math.round(cx),
          cy: Math.round(cy),
        });
      }
    }
    return { ok: misses.length === 0, misses };
  })()`);
  if (!laid?.ok) throw new Error(`control centers ${label} ${JSON.stringify(laid)}`);
}

async function assertDockAndTimeClear(send, label) {
  const laid = await evaluate(send, `(() => {
    const dock = document.querySelector('.map-control-dock');
    if (dock) dock.scrollTop = dock.scrollHeight;
    const hits = (a, b) => a && b && a.width > 0 && b.width > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const picker = document.getElementById('toggle-satellite-picker');
    const hide = document.getElementById('map-chrome-toggle');
    const strip = document.querySelector('.map-command');
    const banner = document.getElementById('status-banner');
    if (!picker || !hide || !strip || !banner) return { ok: false, reason: 'missing' };
    const buttons = [...document.querySelectorAll('.map-control-dock .time-btn')];
    let bottommost = null;
    let bottom = -1;
    for (const node of buttons) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.bottom > bottom) {
        bottom = rect.bottom;
        bottommost = node;
      }
    }
    if (bottommost !== picker) return { ok: false, reason: 'bottom', id: bottommost && bottommost.id, bottom: Math.round(bottom) };
    const pickerRect = picker.getBoundingClientRect();
    const hideRect = hide.getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    const bannerRect = banner.getBoundingClientRect();
    const cx = pickerRect.left + pickerRect.width / 2;
    const cy = pickerRect.top + pickerRect.height / 2;
    const hit = pickerRect.width > 0 ? document.elementFromPoint(cx, cy) : null;
    const pickerHit = !!(hit && (hit === picker || picker.contains(hit)));
    const timeIds = ['time-now', 'time-back-45', 'time-back-90', 'time-fwd-45', 'time-fwd-90'];
    const timeOverlaps = [];
    for (const id of timeIds) {
      const rect = document.getElementById(id)?.getBoundingClientRect();
      if (!rect || rect.width < 1) {
        timeOverlaps.push({ id, reason: 'missing' });
        continue;
      }
      if (hits(rect, bannerRect)) {
        timeOverlaps.push({
          id,
          overlap: Math.round(Math.min(rect.bottom, bannerRect.bottom) - Math.max(rect.top, bannerRect.top)),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          bannerTop: Math.round(bannerRect.top),
        });
      }
    }
    const pickerOverlaps = [];
    if (hits(pickerRect, hideRect)) pickerOverlaps.push('hide');
    if (hits(pickerRect, stripRect)) pickerOverlaps.push('strip');
    const inset = document.querySelector('[data-pip="horizon"]');
    const insetStyle = inset ? getComputedStyle(inset) : null;
    const insetRect = inset ? inset.getBoundingClientRect() : null;
    const insetShown = !!(inset && !inset.hidden && insetStyle && insetStyle.display !== 'none' && insetRect && insetRect.width > 1 && insetRect.height > 1);
    const insetOverlaps = [];
    if (insetShown) {
      if (hits(insetRect, stripRect)) insetOverlaps.push('strip');
      if (hits(insetRect, hideRect)) insetOverlaps.push('hide');
      if (hits(insetRect, pickerRect)) insetOverlaps.push('picker');
      const bar = document.getElementById('shotlist-bar');
      const legend = document.querySelector('.map-legend');
      const zoom = document.querySelector('.maplibregl-ctrl-top-left');
      if (bar && !bar.hidden && hits(insetRect, bar.getBoundingClientRect())) insetOverlaps.push('shotlist');
      if (legend && hits(insetRect, legend.getBoundingClientRect())) insetOverlaps.push('legend');
      if (zoom && hits(insetRect, zoom.getBoundingClientRect())) insetOverlaps.push('zoom');
      const centers = [hide, legend, zoom, bar];
      for (const node of centers) {
        if (!node || node.hidden) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (hit && inset.contains(hit)) insetOverlaps.push('point');
      }
    }
    const ok = pickerHit && pickerOverlaps.length === 0 && timeOverlaps.length === 0 && insetOverlaps.length === 0;
    return {
      ok,
      pickerHit,
      picker: { top: Math.round(pickerRect.top), bottom: Math.round(pickerRect.bottom), hit: hit ? (hit.id || String(hit.className).slice(0, 60)) : '' },
      hide: { top: Math.round(hideRect.top), bottom: Math.round(hideRect.bottom) },
      strip: { top: Math.round(stripRect.top), bottom: Math.round(stripRect.bottom) },
      pickerOverlaps,
      timeOverlaps,
      insetShown,
      insetOverlaps,
      inset: insetShown ? { top: Math.round(insetRect.top), bottom: Math.round(insetRect.bottom), left: Math.round(insetRect.left), right: Math.round(insetRect.right) } : null,
    };
  })()`);
  if (!laid?.ok) throw new Error(`dock time ${label} ${JSON.stringify(laid)}`);
  await evaluate(send, `(() => { const dock = document.querySelector('.map-control-dock'); if (dock) dock.scrollTop = 0; return true; })()`);
}

const SHOWN_CONTROL_CENTERS = [
  '.maplibregl-ctrl-zoom-in',
  '.maplibregl-ctrl-zoom-out',
  '.maplibregl-ctrl-compass',
  '#map-legend-toggle',
  '#map-chrome-toggle',
  '#time-now',
  '#time-back-45',
  '#time-back-90',
  '#time-fwd-45',
  '#time-fwd-90',
  '#time-slider',
];

async function proveLegendShotlist(send, evidenceDir) {
  await click(send, '#tab-queue');
  await waitFor(send, `document.querySelector('.btn-remind') ? { ok: true } : null`, 'shot list remind');
  const armed = await evaluate(send, `document.body.classList.contains('shotlist-bar-visible')`);
  if (!armed) await click(send, '.btn-remind');
  await waitFor(
    send,
    `document.body.classList.contains('shotlist-bar-visible') && document.querySelector('.shotlist-add') && document.querySelector('.shotlist-clear') ? { ok: true } : null`,
    'shot list bar',
  );
  await click(send, '#tab-map');
  await waitFor(
    send,
    `document.getElementById('view')?.className === 'view-map' && document.querySelector('.maplibregl-ctrl-zoom-out') ? { ok: true } : null`,
    'map after shot list',
  );
  await ensureMapChromeShown(send);
  const sizes = [
    { width: 390, height: 664, suffix: '390x664' },
    { width: 390, height: 844, suffix: '390x844' },
    { width: 402, height: 874, suffix: '402x874' },
    { width: 874, height: 402, suffix: '874x402' },
    { width: 844, height: 390, suffix: '844x390' },
    { width: 932, height: 430, suffix: '932x430' },
    { width: 1400, height: 900, suffix: '1400x900' },
    { width: 834, height: 1194, suffix: '834x1194' },
    { width: 1194, height: 834, suffix: '1194x834' },
  ];
  const openCenters = [...SHOWN_CONTROL_CENTERS, '.shotlist-add', '.shotlist-clear'];
  try {
    for (const size of sizes) {
      await setViewport(send, size.width, size.height, size.width < 900);
      const inset = size.height <= 520
        ? await safeAreaOverride(send, { top: 0, left: 0, bottom: 21, right: 0 })
        : false;
      await sleep(300);
      await assertControlCenters(send, `shotlist ${size.suffix} shown`, openCenters);
      if (size.width >= 800 && size.height >= 600) {
        await waitFor(send, pipReadyExpression('horizon'), `horizon inset shotlist ${size.suffix}`, 20000);
        await waitFor(send, pipClearExpression('horizon', PIP_MAP_OBSTACLES), `horizon inset shotlist clear ${size.suffix}`, 10000);
        await waitFor(send, legendCentersMissInset(), `horizon legend centers shotlist ${size.suffix}`, 10000);
      }
      await assertDockAndTimeClear(send, `shotlist ${size.suffix} shown`);
      await assertLegendClearOfZoom(send, `shotlist ${size.suffix} shown`);
      const clear = await evaluate(send, `(() => {
        const button = document.getElementById('map-legend-toggle')?.getBoundingClientRect();
        const strip = document.querySelector('.map-command')?.getBoundingClientRect();
        const hide = document.getElementById('map-chrome-toggle')?.getBoundingClientRect();
        if (!button || !strip || !hide) return { ok: false, reason: 'missing' };
        const hits = (a, b) => a.width > 0 && b.width > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        if (hits(button, strip)) return { ok: false, reason: 'strip', button: { top: button.top, bottom: button.bottom }, strip: { top: strip.top, bottom: strip.bottom } };
        if (hits(button, hide)) return { ok: false, reason: 'hide', button: { left: button.left, right: button.right, top: button.top, bottom: button.bottom }, hide: { left: hide.left, right: hide.right, top: hide.top, bottom: hide.bottom } };
        return { ok: true };
      })()`);
      if (!clear?.ok) throw new Error(`legend shotlist ${size.suffix} ${JSON.stringify(clear)}`);
      if (size.width === 390 && size.height === 664) await shot(send, evidenceDir, 'map-legend-shotlist');
      if (inset) await safeAreaOverride(send, { top: 0, left: 0, bottom: 0, right: 0 });
      await hideMapChrome(send);
      await assertLegendClearOfZoom(send, `shotlist ${size.suffix} hidden`);
      await assertControlCenters(send, `shotlist ${size.suffix} hidden`, ['#map-chrome-toggle', '.shotlist-add', '.shotlist-clear']);
      await showMapChrome(send);
    }
    await click(send, '.shotlist-clear');
    await waitFor(
      send,
      `!document.body.classList.contains('shotlist-bar-visible') ? { ok: true } : null`,
      'shot list cleared',
    );
    for (const size of sizes.filter((item) => item.height <= 520)) {
      await setViewport(send, size.width, size.height, true);
      const inset = await safeAreaOverride(send, { top: 0, left: 0, bottom: 21, right: 0 });
      await sleep(300);
      await assertControlCenters(send, `shotlist ${size.suffix} closed`, SHOWN_CONTROL_CENTERS);
      await assertDockAndTimeClear(send, `shotlist ${size.suffix} closed`);
      if (inset) await safeAreaOverride(send, { top: 0, left: 0, bottom: 0, right: 0 });
    }
  } finally {
    await safeAreaOverride(send, { top: 0, left: 0, bottom: 0, right: 0 });
    const open = await evaluate(send, `document.body.classList.contains('shotlist-bar-visible')`);
    if (open) await click(send, '.shotlist-clear');
    await evaluate(send, `document.body.classList.remove('shotlist-bar-visible')`);
  }
}

async function proveLegendWarning(send, evidenceDir) {
  await click(send, '#time-fwd-45');
  await waitFor(
    send,
    `(() => {
      const badge = document.querySelector('.map-imagery-date');
      const button = document.getElementById('map-legend-toggle');
      const note = document.getElementById('map-legend-warning');
      const dot = button?.querySelector('.map-legend-warning-dot');
      const text = (badge?.textContent || '').trim();
      const live = text.includes('LIVE now (not the scrubbed time)');
      const down = text.includes('feed unavailable');
      if (!button || !badge) return { pending: 'missing' };
      if (!live && !down) return { pending: text };
      if (button.getAttribute('aria-expanded') !== 'false') return { error: 'legend open' };
      const badgeRect = badge.getBoundingClientRect();
      if (badgeRect.width !== 0 || badgeRect.height !== 0) return { error: 'imagery visible ' + text };
      if (!dot || dot.hasAttribute('hidden')) return { error: 'dot hidden ' + text };
      if (button.getAttribute('aria-describedby') !== 'map-legend-warning') return { error: 'describedby ' + button.getAttribute('aria-describedby') };
      if ((note?.textContent || '').trim() !== text) return { error: 'note ' + (note?.textContent || '') };
      const dotRect = dot.getBoundingClientRect();
      if (dotRect.width < 6 || dotRect.height < 6) return { error: 'dot size' };
      return { ok: true, text };
    })()`,
    'legend IR warning',
    15000,
  );
  await shot(send, evidenceDir, 'map-legend-warning');
  await click(send, '#time-now');
  await waitFor(
    send,
    `(() => {
      const readout = document.getElementById('time-slider-readout')?.textContent.trim();
      const text = (document.querySelector('.map-imagery-date')?.textContent || '').trim();
      const dot = document.querySelector('.map-legend-warning-dot');
      if (readout !== 'Now' || !dot) return { pending: { readout, text } };
      const warning = text.includes('LIVE now (not the scrubbed time)') || text.includes('feed unavailable');
      if (warning) return dot.hasAttribute('hidden') ? { pending: text } : { ok: true, still: text };
      return dot.hasAttribute('hidden') ? { ok: true } : { pending: text };
    })()`,
    'legend warning cleared',
  );
}

async function proveStaleReadoutClearsSkip(send, viewport) {
  const sizes = [
    [834, 1194],
    [800, 600],
  ];
  const expression = `(() => {
    const el = document.getElementById('time-slider-readout');
    const step = document.getElementById('time-back-90');
    if (!el || !step) return null;
    const text = '+1d 23:59Z · stale TLE';
    const fragment = document.createDocumentFragment();
    for (const char of text) {
      if (char >= '0' && char <= '9') {
        const cell = document.createElement('span');
        cell.className = 'digit';
        cell.textContent = char;
        fragment.append(cell);
      } else if (char === ':' || char === '.' || char === ',') {
        const cell = document.createElement('span');
        cell.className = 'digit-sep';
        cell.textContent = char;
        fragment.append(cell);
      } else {
        fragment.append(document.createTextNode(char));
      }
    }
    el.replaceChildren(fragment);
    el.classList.add('time-slider-scrubbed', 'time-slider-stale');
    const readout = el.getBoundingClientRect();
    const skip = step.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('.map-command .time-step-btn')].map((button) => {
      const box = button.getBoundingClientRect();
      return { id: button.id, width: box.width, height: box.height };
    });
    const short = buttons.filter((button) => button.width < 44 || button.height < 44);
    const overflow = el.scrollWidth - el.clientWidth;
    const inkRight = readout.left + el.scrollWidth;
    if (el.textContent !== text || overflow > 1 || inkRight > skip.left + 1 || short.length) {
      return {
        pending: true,
        text: el.textContent,
        overflow,
        client: el.clientWidth,
        scroll: el.scrollWidth,
        inkRight,
        skipLeft: skip.left,
        short,
      };
    }
    return { ok: true, client: el.clientWidth, scroll: el.scrollWidth };
  })()`;
  try {
    for (const [width, height] of sizes) {
      await setViewport(send, width, height, width < 900);
      await waitFor(send, expression, `stale readout clear of T-90 at ${width}x${height}`, 8000);
    }
  } finally {
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
  await evaluate(send, `(() => {
    const el = document.getElementById('time-slider-readout');
    if (!el) return { ok: false };
    el.textContent = 'Now';
    el.classList.remove('time-slider-scrubbed', 'time-slider-stale');
    el.removeAttribute('title');
    return { ok: true };
  })()`);
  await waitFor(
    send,
    `document.getElementById('time-slider-readout')?.textContent.trim() === 'Now' ? { ok: true } : null`,
    'readout restored after stale check',
  );
}

async function proveShortTimeRow(send, viewport) {
  const sizes = [
    { width: 390, height: 520 },
    { width: 430, height: 400 },
    { width: 664, height: 390 },
    { width: 874, height: 402 },
  ];
  try {
    for (const size of sizes) {
      await setViewport(send, size.width, size.height, true);
      await sleep(200);
      const laid = await evaluate(send, `(() => {
        const button = document.getElementById('time-fwd-90');
        const chip = document.querySelector('.map-command .map-controls-time');
        if (!button || !chip) return { ok: false, reason: 'missing' };
        const box = button.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) return { ok: false, reason: 'box', w: box.width, h: box.height };
        if (box.left < -1 || box.right > innerWidth + 1 || box.top < -1 || box.bottom > innerHeight + 1) {
          return { ok: false, reason: 'offscreen', left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom), innerWidth, innerHeight };
        }
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (!hit || (hit !== button && !button.contains(hit))) {
          return { ok: false, reason: 'hit', hit: hit ? (hit.id || hit.getAttribute('aria-label') || hit.tagName) : null };
        }
        return { ok: true, wrap: getComputedStyle(chip).flexWrap };
      })()`);
      if (!laid?.ok) throw new Error(`time skip ${size.width}x${size.height} ${JSON.stringify(laid)}`);
    }
  } finally {
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
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
        darkZoom: map && map.getSource ? (map.getSource('carto-dark') ? map.getSource('carto-dark').maxzoom : null) : null,
        view: document.getElementById('view')?.className,
        issClock: !!document.querySelector('[data-iss-clock]'),
        logs: (window.__opdLogs || []).slice(-8),
        mapHtml: (document.getElementById('map')?.innerHTML || '').slice(0, 180),
      };
      if (status.map && status.marker && status.legend && status.badge && String(status.badge).trim() && status.track && !status.issClock && status.darkZoom === 16) {
        return { ok: true, badge: status.badge, legend: legend.textContent, maxzoom: status.darkZoom };
      }
      return status;
    })()`,
    'map ready',
    45000,
  );
  const legendText = String(ready.legend || '');
  for (const word of ['launch', 'day', 'twilight', 'eclipse']) {
    if (!legendText.includes(word)) throw new Error(`legend missing ${word}: ${legendText}`);
  }
  if (legendText.includes("Anil's targets") || legendText.includes('Starship')) {
    throw new Error(`legend still names a removed row: ${legendText}`);
  }
  const collapsedOnLoad = await evaluate(send, `(() => {
    const button = document.getElementById('map-legend-toggle');
    if (!(button instanceof HTMLButtonElement)) return { ok: false, reason: 'missing' };
    const expanded = button.getAttribute('aria-expanded');
    const controls = button.getAttribute('aria-controls');
    if (expanded !== 'false' || controls !== 'map-legend-panel') return { ok: false, expanded, controls };
    return { ok: true };
  })()`);
  if (!collapsedOnLoad?.ok) throw new Error(`legend collapsed on load ${JSON.stringify(collapsedOnLoad)}`);
  await revealMapChrome(send, evidenceDir, 'map-chrome-hidden');
  await proveMapChromeMemory(send);
  const laid = await proveMapLaidOnPane(send);
  let narrowLaid = laid.narrow ? laid : null;
  if (!laid.narrow) {
    await setViewport(send, 390, 664, true);
    await sleep(200);
    try {
      narrowLaid = await proveMapLaidOnPane(send);
    } finally {
      await setViewport(send, viewport.width, viewport.height, viewport.mobile);
      await sleep(200);
    }
  }
  await proveMapControlHits(send, 'shot list closed');
  await proveShortTimeRow(send, viewport);
  await evaluate(send, `document.body.classList.add('shotlist-bar-visible')`);
  try {
    await proveMapControlHits(send, 'shot list open');
  } finally {
    await evaluate(send, `(() => {
      const bar = document.getElementById('shotlist-bar');
      if (!bar || bar.hidden) document.body.classList.remove('shotlist-bar-visible');
      return true;
    })()`);
  }
  const pip = await provePipSurface(send, evidenceDir, viewport, 'map');
  let chrome = '';
  if (insetViewportFits(viewport.width, viewport.height)) {
    await click(send, '#map-chrome-toggle');
    await waitFor(send, pipAbsentExpression('horizon'), 'horizon inset hidden with chrome', 10000);
    await shot(send, evidenceDir, 'pip-map-chrome-hidden');
    await showMapChrome(send);
    await waitFor(send, pipReadyExpression('horizon'), 'horizon inset after chrome shown', 30000);
    chrome = ' chrome hidden then shown';
  }
  if (insetViewportFits(viewport.width, viewport.height)) {
    await pressInset(send, 'horizon', viewport.mobile);
    await waitFor(
      send,
      `document.getElementById('view')?.className === 'view-iss' ? { ok: true } : null`,
      'horizon inset opens ISS view',
      20000,
    );
    await shot(send, evidenceDir, 'pip-to-iss');
    await click(send, '#tab-map');
    await waitFor(
      send,
      `(() => {
        const map = window.__opdMap;
        if (document.getElementById('view')?.className !== 'view-map') return null;
        if (!map || !map.getLayer || !map.getLayer('iss-track-layer')) return null;
        if (!document.querySelector('#map .iss-marker')) return null;
        return { ok: true };
      })()`,
      'map after horizon inset',
      45000,
    );
  }
  const anil = await evaluate(send, `(() => {
    const paint = window.__opdMap.getPaintProperty('targets-layer', 'circle-color');
    return {
      anilSwatch: !!document.querySelector('.map-legend-anil'),
      starshipSwatch: !!document.querySelector('.map-legend-starship'),
      paint: JSON.stringify(paint),
    };
  })()`);
  if (anil.anilSwatch || anil.starshipSwatch) throw new Error(`legend swatch still present ${JSON.stringify(anil)}`);
  if (!String(anil.paint).includes('anils-targets') || !String(anil.paint).includes('#8b93ff')) {
    throw new Error(`anil paint ${anil.paint}`);
  }
  await sleep(1200);
  await shot(send, evidenceDir, 'map-globe');
  await proveLegendDisclosure(send, evidenceDir, viewport);
  await dismissShotlist(send);
  await assertMapInfoControlsGone(send);
  await assertChromeToggleStationary(send);
  await proveStaleReadoutClearsSkip(send, viewport);
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
  await proveLegendWarning(send, evidenceDir);
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
  await waitFor(
    send,
    `(() => {
      const text = document.querySelector('.map-launch-brief')?.textContent || '';
      if (!text.includes(${JSON.stringify(meta.names.launch)}) || !text.includes('Verify Likely') || text.includes('Verify Horizon')) return null;
      return { ok: true };
    })()`,
    'map tier launch brief',
    10000,
  );
  await waitFor(
    send,
    `(async () => {
      const map = window.__opdMap;
      const pads = map?.getSource?.('ascent-pad');
      const lines = map?.getSource?.('ascent-trajectory');
      if (!pads?.getData || !lines?.getData) return null;
      const padData = await pads.getData();
      const lineData = await lines.getData();
      const padIds = (padData.features || []).map((feature) => feature.properties && feature.properties.event_id);
      const lineIds = (lineData.features || []).map((feature) => feature.properties && feature.properties.event_id);
      if (!padIds.includes('verify-ascent') || !padIds.includes('verify-likely') || padIds.includes('verify-horizon')) return null;
      if (!lineIds.includes('verify-ascent') || lineIds.includes('verify-likely') || lineIds.includes('verify-horizon')) return null;
      return { ok: true, pads: padIds, lines: lineIds.length };
    })()`,
    'tier launch pads and corridor',
    15000,
  );
  await evaluate(send, `(() => { const more = document.querySelector('.map-launch-more'); if (more) more.open = true; return true; })()`);
  await shot(send, evidenceDir, 'map-launch-pins');
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
  const narrowNote = narrowLaid && narrowLaid.reserved ? ` narrow command ${Math.round(narrowLaid.reserved.height)}px` : '';
  return `map: globe, legend, imagery, hide control 88x44 at 12px, Esri dark maxzoom ${ready.maxzoom}, time chip ${laid.controls} on clear strip ${Math.round(laid.stripHeight)}px right ${Math.round(laid.rightGap)}px slider ${Math.round(laid.slider)}px gap ${laid.gap}px${narrowNote}, stale readout clear 834x1194 800x600, control hits, time skip on screen, tool rail, picker, target popup, pin drop, launch dialog, hidden pin, chrome persisted, profile menu round trip, horizon inset ${pip}${chrome}`;
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
      const expected = [
        ['anil', 'Anil', true, 'true'],
        ['watkins', 'Jessica Watkins (Watty)', false, null],
        ['kutryk', 'Josh Kutryk', false, null],
        ['delaney', 'Luke Delaney', false, null],
      ];
      if (rows.length !== expected.length) return null;
      for (let i = 0; i < expected.length; i += 1) {
        const row = rows[i];
        const want = expected[i];
        if (!row || row.name !== want[0] || row.text !== want[1] || row.home !== want[2]) return null;
        if (want[3] === 'true' ? row.current !== 'true' : row.current === 'true') return null;
      }
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
  await click(send, '#tab-profile');
  await waitFor(
    send,
    `(() => {
      const heading = document.querySelector('#profile-picker-section h3')?.textContent || '';
      const names = [...document.querySelectorAll('#profile-crud-section .profile-crud-row:not(.profile-crud-chip) .profile-crud-name')].map((el) => el.textContent);
      const labels = [...document.querySelectorAll('#profile-body button')].map((el) => (el.textContent || '').trim());
      if (heading !== 'Crew roster · Jessica Watkins (Watty)') return null;
      if (document.getElementById('profile-picker-select')) return null;
      if (document.getElementById('profile-new-btn') || document.getElementById('profile-delete-btn')) return null;
      if (labels.includes('Add target') || labels.includes('Edit') || labels.includes('New profile') || labels.includes('Delete this profile')) return null;
      if (!names.includes('Lafayette, Colorado hometown') || names.length !== 12) return null;
      return { ok: true, count: names.length };
    })()`,
    'Watkins crew roster is read-only',
    20000,
  );
  await shot(send, evidenceDir, name('profile-crew-watkins'));
  await click(send, '#profile-badge');
  await waitFor(
    send,
    `(() => {
      const menu = document.getElementById('profile-menu');
      if (!menu || !menu.matches(':popover-open')) return null;
      const rows = [...menu.querySelectorAll('.profile-menu-item')].map((row) => ({
        name: row.dataset.profile,
        text: row.textContent,
        current: row.getAttribute('aria-current'),
      }));
      if (rows.map((row) => row.text).join('|') !== 'Anil|Jessica Watkins (Watty)|Josh Kutryk|Luke Delaney') return null;
      if (rows[1]?.current !== 'true' || rows[0]?.current === 'true') return null;
      if (document.getElementById('view')?.className !== 'view-profile') return null;
      return { ok: true };
    })()`,
    'profile menu open on Profile',
    10000,
  );
  await shot(send, evidenceDir, name('profile-menu-on-profile'));
  await pressKey(send, 'Escape');
  await waitFor(
    send,
    `(() => {
      const menu = document.getElementById('profile-menu');
      if (!menu || menu.matches(':popover-open')) return null;
      if (document.getElementById('view')?.className !== 'view-profile') return null;
      if (new URL(location.href).searchParams.get('u') !== 'watkins') return null;
      return { ok: true };
    })()`,
    'escape closes the profile menu',
    10000,
  );
  await click(send, '#tab-map');
  await waitFor(
    send,
    `(() => {
      if (document.getElementById('view')?.className !== 'view-map') return null;
      if (document.getElementById('personal-targets-legend')) return null;
      const names = ${myTargetNamesExpr()};
      if (!names || !names.includes('Lafayette, Colorado hometown') || names.length !== 12) return null;
      return { ok: true, count: names.length };
    })()`,
    'Watkins legend and sites',
    45000,
  );
  await ensureMapChromeShown(send);
  await waitFor(
    send,
    `(() => {
      const legend = document.querySelector('.map-legend');
      if (!legend || getComputedStyle(legend).display === 'none') return null;
      return { ok: true, text: legend.innerText };
    })()`,
    'Watkins legend visible',
    10000,
  );
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
  await waitForHref(send, /\?e2e=(?:&u=anil)?(?:#|$)/, 'anil profile url');
  await waitFor(
    send,
    `(() => {
      const banner = document.getElementById('status-banner');
      const text = banner ? banner.textContent || '' : '';
      if (!banner || text.includes('Loading')) return null;
      const u = new URL(location.href).searchParams.get('u');
      const badge = document.querySelector('#profile-badge .profile-badge-name')?.textContent || null;
      const legend = document.getElementById('personal-targets-legend');
      const names = ${myTargetNamesExpr()};
      const state = {
        href: location.href,
        u,
        tab: document.querySelector('.tabs .tab.active')?.id || null,
        view: document.getElementById('view')?.className || null,
        badge,
        legend: legend ? legend.textContent : null,
        count: names ? names.length : null,
        lafayette: !!(names && names.includes('Lafayette, Colorado hometown')),
      };
      const home = u === null || u === 'anil';
      if (!home || state.tab !== 'tab-map' || state.view !== 'view-map' || badge !== 'Anil' || legend || !names || state.lafayette) {
        return state;
      }
      return { ok: true, count: names.length, u };
    })()`,
    'map restored on Anil',
    45000,
  );
  await ensureMapChromeShown(send);
  await shot(send, evidenceDir, name('profile-legend-anil'));
  if (!shotSuffix && viewport && viewport.width === 402 && viewport.height === 874) {
    await setViewport(send, 874, 402, true);
    await proveProfileMenuRoundTrip(send, evidenceDir, { width: 874, height: 402, mobile: true }, 'land');
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
}

async function driveTracked(send, evidenceDir, meta, home) {
  await setViewport(send, home.width, home.height, home.mobile);
  await click(send, '#tab-map');
  const ready = await waitFor(
    send,
    `(() => {
      const map = window.__opdMap;
      const iss = document.querySelector('.iss-marker');
      const legendNode = document.querySelector('.map-legend');
      const legend = legendNode?.textContent || '';
      const track = !!(map && map.getLayer && map.getLayer('iss-track-layer'));
      if (!map || !iss || !track || !legendNode || legend.includes('Starship')) return null;
      return { ok: true, legend };
    })()`,
    'tracked legend',
    45000,
  );
  await ensureMapChromeShown(send);
  if (meta.trackedMode === 'elements') {
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
    if (!meta.standIn || !String(placed.title).includes(meta.standIn)) {
      throw new Error(`stand-in marker ${placed.title} expected ${meta.standIn}`);
    }
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
  if (meta.trackedMode === 'missing') {
    const published = await evaluate(send, `fetch('/manifest.json').then((response) => response.json()).then((body) => Boolean(body.artifacts && body.artifacts.tracked))`);
    if (published) throw new Error('missing tracked mode still published a tracked artifact');
  }
  if (String(ready.legend).includes('Starship')) {
    throw new Error(`${meta.trackedMode || 'unavailable'} legend still names Starship: ${ready.legend}`);
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

async function planCamera(send) {
  return evaluate(send, `(() => {
    const canvas = document.querySelector('[data-pip="plan"] canvas');
    const orbit = document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset;
    if (!canvas || !orbit?.getCenter || !orbit.getZoom) return null;
    const box = canvas.getBoundingClientRect();
    const center = orbit.getCenter();
    return {
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      canvasWidth: box.width,
      zoom: orbit.getZoom(),
      lng: center.lng,
      lat: center.lat,
      view: document.getElementById('view')?.className || '',
      width: window.innerWidth,
      height: window.innerHeight,
    };
  })()`);
}

function cameraMoved(before, after) {
  if (!before || !after) return false;
  return Math.abs(before.lng - after.lng) + Math.abs(before.lat - after.lat) > 0.02;
}

async function provePlanWheelSurvivesRebuild(send) {
  const before = await planCamera(send);
  if (!before) throw new Error('plan camera missing before the first wheel');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY: -240 });
  await waitFor(
    send,
    `(() => {
      const orbit = document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset;
      if (!orbit?.getZoom) return null;
      const zoom = orbit.getZoom();
      if (!(Math.abs(zoom - ${before.zoom}) > 0.05)) return null;
      return { ok: true, zoom };
    })()`,
    'plan first wheel zoom',
    8000,
  );
  await sleep(500);
  const settled = await planCamera(send);
  if (!settled || !(Math.abs(settled.zoom - before.zoom) > 0.05)) {
    throw new Error(`plan wheel did not settle ${JSON.stringify({ before, settled })}`);
  }
  await sleep(5600);
  const after = await planCamera(send);
  if (!after || Math.abs(after.zoom - settled.zoom) > 0.03 || !(Math.abs(after.zoom - before.zoom) > 0.05)) {
    throw new Error(`plan wheel reset by the track rebuild ${JSON.stringify({ before, settled, after })}`);
  }
  return after.zoom;
}

async function provePlanRasterNames(send) {
  const laid = await evaluate(send, `(async () => {
    const frame = document.querySelector('[data-pip="plan"] [data-pip-frame]');
    const canvas = frame?.querySelector('canvas');
    const orbit = frame?.__opdTrackInset;
    if (!canvas || !orbit?.jumpTo || !orbit.queryRenderedFeatures || !orbit.getStyle) return { ok: false, reason: 'map' };
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -1 }));
    if (orbit.stop) orbit.stop();
    const raster = orbit.getLayer('inset-labels');
    const opacity = orbit.getPaintProperty('inset-labels', 'raster-opacity');
    if (!raster || !(opacity > 0)) return { ok: false, reason: 'raster', opacity: opacity == null ? null : opacity };
    const symbolLayers = (orbit.getStyle().layers || []).filter((layer) => layer.type === 'symbol');
    const symbolIds = symbolLayers.map((layer) => layer.id);
    const samples = [];
    for (const zoom of [3.1, 8]) {
      if (orbit.stop) orbit.stop();
      orbit.jumpTo({ center: [-73, 41], zoom, bearing: 0, pitch: 0 });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1200);
        orbit.once('idle', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const active = symbolLayers.filter((layer) => {
        const min = layer.minzoom == null ? 0 : layer.minzoom;
        const max = layer.maxzoom == null ? 24 : layer.maxzoom;
        return zoom >= min && zoom < max;
      }).map((layer) => layer.id);
      let features = [];
      try {
        features = symbolIds.length ? orbit.queryRenderedFeatures(undefined, { layers: symbolIds }) : [];
      } catch (error) {
        return { ok: false, reason: 'query', zoom, error: String(error) };
      }
      const names = [];
      for (const feature of features) {
        const name = feature && feature.properties && feature.properties.name;
        if (typeof name === 'string' && !names.includes(name)) names.push(name);
      }
      const stacked = names.filter((name) => name === 'Washington D.C.' || name === 'New York' || name === 'Washington');
      samples.push({ zoom: orbit.getZoom(), stacked, names, active });
      if (stacked.length || active.length || Math.abs(orbit.getZoom() - zoom) > 0.05) {
        return { ok: false, reason: stacked.length ? 'stacked' : active.length ? 'vector' : 'zoom', samples };
      }
    }
    return { ok: true, samples, opacity };
  })()`);
  if (!laid?.ok) throw new Error(`plan raster names ${JSON.stringify(laid)}`);
}

async function dispatchPlanTouch(send, type, x, y) {
  const sent = await evaluate(send, `(() => {
    const canvas = document.querySelector('[data-pip="plan"] canvas');
    if (!canvas) return { ok: false, reason: 'canvas' };
    const kind = ${JSON.stringify(type)};
    const x = ${x};
    const y = ${y};
    const pointer = kind === 'touchStart' ? 'pointerdown' : kind === 'touchEnd' ? 'pointerup' : 'pointermove';
    canvas.dispatchEvent(new PointerEvent(pointer, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
    }));
    let touch = null;
    if (document.createTouch) {
      try {
        touch = document.createTouch(window, canvas, 7, x, y, x, y, x, y);
      } catch (error) {
        touch = null;
      }
    }
    if (!touch && typeof Touch === 'function') {
      try {
        touch = new Touch({ identifier: 7, target: canvas, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
      } catch (error) {
        touch = null;
      }
    }
    if (!touch) return { ok: false, reason: 'touch-ctor' };
    const list = document.createTouchList ? document.createTouchList(touch) : [touch];
    const empty = document.createTouchList ? document.createTouchList() : [];
    const active = kind === 'touchEnd' ? empty : list;
    const eventName = kind === 'touchStart' ? 'touchstart' : kind === 'touchEnd' ? 'touchend' : 'touchmove';
    try {
      canvas.dispatchEvent(new TouchEvent(eventName, {
        bubbles: true,
        cancelable: true,
        touches: active,
        targetTouches: active,
        changedTouches: list,
      }));
    } catch (error) {
      return { ok: false, reason: 'event', error: String(error) };
    }
    return { ok: true };
  })()`);
  if (!sent?.ok) throw new Error(`plan touch ${type} ${JSON.stringify(sent)}`);
}

async function provePlanGestureHolds(send, viewport) {
  const start = await planCamera(send);
  if (!start) throw new Error('plan camera missing before the gesture');
  const step = Math.max(16, Math.min(36, Math.floor(start.canvasWidth / 10)));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + step, y: start.y, button: 'left', buttons: 1 });
  await sleep(200);
  const panned = await planCamera(send);
  if (!cameraMoved(start, panned)) throw new Error(`plan mouse drag did not move ${JSON.stringify({ start, panned })}`);
  const nextWidth = Math.max(800, Math.round(start.width) - 40);
  await setViewport(send, nextWidth, start.height, viewport.mobile);
  await evaluate(send, `(() => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => 2 });
    return window.devicePixelRatio;
  })()`);
  let previous = panned;
  for (let tick = 1; tick <= 3; tick += 1) {
    await sleep(1100);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + step * (tick + 1),
      y: start.y,
      button: 'left',
      buttons: 1,
    });
    await sleep(150);
    const next = await planCamera(send);
    if (!cameraMoved(previous, next)) {
      throw new Error(`plan mouse froze on tick ${tick} ${JSON.stringify({ previous, next })}`);
    }
    previous = next;
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: start.x + step * 4,
    y: start.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await sleep(450);
  const released = await planCamera(send);
  if (!released || released.view !== 'view-iss') {
    throw new Error(`plan mouse release opened Map ${JSON.stringify(released)}`);
  }
  const touchStart = await planCamera(send);
  await dispatchPlanTouch(send, 'touchStart', touchStart.x, touchStart.y + 30);
  await dispatchPlanTouch(send, 'touchMove', touchStart.x, touchStart.y + 30 + step);
  await sleep(200);
  const touched = await planCamera(send);
  if (!cameraMoved(touchStart, touched)) {
    throw new Error(`plan touch drag did not move ${JSON.stringify({ touchStart, touched })}`);
  }
  await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  await evaluate(send, `(() => {
    delete window.devicePixelRatio;
    return window.devicePixelRatio;
  })()`);
  let touchPrevious = touched;
  for (let tick = 1; tick <= 3; tick += 1) {
    await sleep(1100);
    await dispatchPlanTouch(send, 'touchMove', touchStart.x, touchStart.y + 30 + step * (tick + 1));
    await sleep(150);
    const next = await planCamera(send);
    if (!cameraMoved(touchPrevious, next)) {
      throw new Error(`plan touch froze on tick ${tick} ${JSON.stringify({ touchPrevious, next })}`);
    }
    touchPrevious = next;
  }
  await dispatchPlanTouch(send, 'touchEnd', touchStart.x, touchStart.y + 30 + step * 4);
  await sleep(450);
  const ended = await planCamera(send);
  if (!ended || ended.view !== 'view-iss') {
    throw new Error(`plan touch release opened Map ${JSON.stringify(ended)}`);
  }
}

async function planFrameMetrics(send) {
  return evaluate(send, `(() => {
    const frame = document.querySelector('[data-pip="plan"] [data-pip-frame]');
    const canvas = frame && frame.querySelector('canvas');
    const orbit = frame && frame.__opdTrackInset;
    if (!frame || !canvas || !orbit || !orbit.getZoom) return null;
    const box = frame.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    let outsideX = box.right + 28;
    let outsideY = box.top + Math.min(48, Math.max(8, box.height / 3));
    if (outsideX > window.innerWidth - 6) outsideX = Math.max(6, box.left - 28);
    if (outsideY < 6) outsideY = 6;
    if (outsideY > window.innerHeight - 6) outsideY = window.innerHeight - 6;
    const host = document.elementFromPoint(outsideX, outsideY);
    const outsideFrame = !(host && (frame.contains(host) || host.closest('[data-pip="plan"]')));
    return {
      x: canvasBox.left + canvasBox.width / 2,
      y: canvasBox.top + canvasBox.height / 2,
      outsideX,
      outsideY,
      outsideFrame,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      frameWidth: frame.clientWidth,
      frameHeight: frame.clientHeight,
      dpr,
      view: (document.getElementById('view') && document.getElementById('view').className) || '',
      zoom: orbit.getZoom(),
      bearing: orbit.getBearing(),
    };
  })()`);
}

function planCanvasReady(metrics) {
  if (!metrics || metrics.frameWidth < 2 || metrics.frameHeight < 2 || !(metrics.dpr > 0)) return null;
  return {
    cssWidth: metrics.frameWidth,
    cssHeight: metrics.frameHeight,
    backingWidth: Math.round(metrics.frameWidth * metrics.dpr),
    backingHeight: Math.round(metrics.frameHeight * metrics.dpr),
  };
}

async function provePlanSmallMotion(send) {
  const start = await planCamera(send);
  if (!start) throw new Error('plan camera missing before a small move');
  for (const dx of [2, 5, 10]) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + dx, y: start.y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + dx, y: start.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(450);
    const now = await planCamera(send);
    if (!now || now.view !== 'view-iss') throw new Error(`plan ${dx}px move opened Map ${JSON.stringify(now)}`);
  }
  const second = await evaluate(send, `(() => {
    const canvas = document.querySelector('[data-pip="plan"] canvas');
    if (!canvas) return { ok: false, reason: 'canvas' };
    const box = canvas.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const point = (type, id, clientX) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: y,
      pointerId: id,
      pointerType: 'touch',
      isPrimary: id === 1,
    }));
    point('pointerdown', 1, x);
    point('pointerdown', 2, x + 36);
    point('pointerup', 1, x);
    point('pointerup', 2, x + 36);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    return { ok: true };
  })()`);
  if (!second?.ok) throw new Error(`plan second touch ${JSON.stringify(second)}`);
  await sleep(450);
  const after = await planCamera(send);
  if (!after || after.view !== 'view-iss') throw new Error(`plan second touch opened Map ${JSON.stringify(after)}`);
}

async function dispatchPlanTouches(send, name, active, changed) {
  const sent = await evaluate(send, `(() => {
    const canvas = document.querySelector('[data-pip="plan"] canvas');
    if (!canvas) return { ok: false, reason: 'canvas' };
    const name = ${JSON.stringify(name)};
    const activePoints = ${JSON.stringify(active)};
    const changedPoints = ${JSON.stringify(changed)};
    const make = (point) => {
      let touch = null;
      if (document.createTouch) {
        try {
          touch = document.createTouch(window, canvas, point.id, point.x, point.y, point.x, point.y, point.x, point.y);
        } catch (error) {
          touch = null;
        }
      }
      if (!touch && typeof Touch === 'function') {
        try {
          touch = new Touch({ identifier: point.id, target: canvas, clientX: point.x, clientY: point.y, pageX: point.x, pageY: point.y, screenX: point.x, screenY: point.y });
        } catch (error) {
          touch = null;
        }
      }
      return touch;
    };
    const changedTouches = [];
    for (const point of changedPoints) {
      const touch = make(point);
      if (!touch) return { ok: false, reason: 'touch-ctor' };
      changedTouches.push(touch);
    }
    const activeTouches = [];
    for (const point of activePoints) {
      const touch = make(point);
      if (!touch) return { ok: false, reason: 'touch-ctor' };
      activeTouches.push(touch);
    }
    const list = (points) => document.createTouchList ? document.createTouchList(...points) : points;
    try {
      canvas.dispatchEvent(new TouchEvent(name, {
        bubbles: true,
        cancelable: true,
        touches: list(activeTouches),
        targetTouches: list(activeTouches),
        changedTouches: list(changedTouches),
      }));
    } catch (error) {
      return { ok: false, reason: 'event', error: String(error) };
    }
    return { ok: true };
  })()`);
  if (!sent?.ok) throw new Error(`plan pinch ${name} ${JSON.stringify(sent)}`);
}

async function provePlanRotatingPinch(send) {
  const armed = await evaluate(send, `(() => {
    const orbit = document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset;
    if (!orbit?.jumpTo || !orbit.getZoom) return null;
    orbit.jumpTo({ zoom: 1, bearing: 0, pitch: 0 });
    return { zoom: orbit.getZoom(), bearing: orbit.getBearing() };
  })()`);
  const start = await planCamera(send);
  if (!armed || !start) throw new Error('plan camera missing before a rotating pinch');
  start.zoom = armed.zoom;
  const cx = start.x;
  const cy = start.y;
  const finger = (t) => ([
    { id: 1, x: cx - 36 * (1 - t), y: cy - 90 * t },
    { id: 2, x: cx + 36 * (1 - t), y: cy + 90 * t },
  ]);
  const first = finger(0);
  await dispatchPlanTouches(send, 'touchstart', [first[0]], [first[0]]);
  await dispatchPlanTouches(send, 'touchstart', first, [first[1]]);
  for (let step = 1; step <= 6; step += 1) {
    const next = finger(step / 6);
    await dispatchPlanTouches(send, 'touchmove', next, next);
  }
  const last = finger(1);
  await dispatchPlanTouches(send, 'touchend', [], last);
  await sleep(250);
  const after = await planFrameMetrics(send);
  if (!after || Math.abs(after.bearing) > 0.5 || !(after.zoom - start.zoom > 0.2)) {
    throw new Error(`plan rotating pinch ${JSON.stringify({ startZoom: start.zoom, after })}`);
  }
  if (after.view !== 'view-iss') throw new Error(`plan rotating pinch opened Map ${JSON.stringify(after)}`);
}

async function armPlanPointer(send) {
  const armed = await evaluate(send, `(() => {
    const frame = document.querySelector('[data-pip="plan"] [data-pip-frame]');
    if (!frame) return { ok: false };
    window.__opdPlanPointer = null;
    frame.addEventListener('pointerdown', (event) => { window.__opdPlanPointer = event.pointerId; }, { capture: true, once: true });
    return { ok: true };
  })()`);
  if (!armed?.ok) throw new Error('plan pointer arm failed');
}

async function endPlanGesture(send, kind, outside) {
  if (kind === 'up') {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: outside.outsideX,
      y: outside.outsideY,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } else {
    const ended = await evaluate(send, `(() => {
      const frame = document.querySelector('[data-pip="plan"] [data-pip-frame]');
      const id = window.__opdPlanPointer;
      const kind = ${JSON.stringify(kind)};
      if (!frame || id == null) return { ok: false, reason: 'pointer', id };
      if (kind === 'cancel') {
        window.dispatchEvent(new PointerEvent('pointercancel', {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          pointerType: 'mouse',
          clientX: ${outside.outsideX},
          clientY: ${outside.outsideY},
        }));
      } else if (kind === 'lost') {
        if (frame.hasPointerCapture && frame.hasPointerCapture(id)) frame.releasePointerCapture(id);
        else {
          window.dispatchEvent(new PointerEvent('lostpointercapture', {
            bubbles: false,
            pointerId: id,
            pointerType: 'mouse',
            clientX: ${outside.outsideX},
            clientY: ${outside.outsideY},
          }));
        }
      } else {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('data-opd-blur', '');
        iframe.src = 'about:blank';
        document.body.append(iframe);
        if (iframe.contentWindow) iframe.contentWindow.focus();
      }
      return { ok: true, id };
    })()`);
    if (!ended?.ok) throw new Error(`plan ${kind} ${JSON.stringify(ended)}`);
  }
}

async function returnToPlan(send) {
  await evaluate(send, `(() => { document.querySelector('[data-opd-blur]')?.remove(); window.focus(); return true; })()`);
  if (await evaluate(send, `document.getElementById('view')?.className === 'view-iss'`)) {
    await waitForPip(send, 'plan', 'plan inset still open', 20000);
    return;
  }
  await click(send, '#tab-iss');
  await waitFor(
    send,
    `(() => {
      const view = document.getElementById('view');
      const canvas = document.querySelector('[data-pip="plan"] canvas');
      if (!view || view.className !== 'view-iss' || !canvas) return null;
      return { ok: true };
    })()`,
    'iss after an outside plan gesture',
    45000,
  );
  await waitForPip(send, 'plan', 'plan framed after an outside gesture', 20000);
}

async function provePlanOutsideEnding(send, viewport, kind, from, to) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: from.width,
    height: from.height,
    deviceScaleFactor: from.dpr,
    mobile: viewport.mobile,
  });
  await sleep(400);
  await waitForPip(send, 'plan', `plan before ${kind}`, 20000);
  const before = await planFrameMetrics(send);
  if (!before?.outsideFrame) throw new Error(`plan ${kind} has no outside point ${JSON.stringify(before)}`);
  await armPlanPointer(send);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: before.outsideX,
    y: before.outsideY,
    button: 'left',
    buttons: 1,
  });
  await endPlanGesture(send, kind, before);
  await send('Emulation.setDeviceMetricsOverride', {
    width: to.width,
    height: to.height,
    deviceScaleFactor: to.dpr,
    mobile: viewport.mobile,
  });
  for (let tick = 0; tick < 4; tick += 1) await sleep(1000);
  const after = await planFrameMetrics(send);
  const expected = planCanvasReady(after);
  const changed = after && (after.frameWidth !== before.frameWidth || after.frameHeight !== before.frameHeight || after.dpr !== before.dpr);
  if (!after || !expected || !changed || after.view !== 'view-iss'
    || after.cssWidth !== expected.cssWidth || after.cssHeight !== expected.cssHeight
    || after.backingWidth !== expected.backingWidth || after.backingHeight !== expected.backingHeight) {
    throw new Error(`plan ${kind} canvas ${JSON.stringify({ before, after, expected })}`);
  }
  await evaluate(send, `(() => {
    const orbit = document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset;
    if (orbit?.stop) orbit.stop();
    return true;
  })()`);
  if (kind !== 'up') {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: before.outsideX,
      y: before.outsideY,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }
  await evaluate(send, `(() => { document.querySelector('[data-opd-blur]')?.remove(); window.focus(); return true; })()`);
  const clickAt = await planFrameMetrics(send);
  await mouseClick(send, clickAt.x, clickAt.y);
  await waitFor(
    send,
    `document.getElementById('view')?.className === 'view-map' ? { ok: true } : null`,
    `plan ${kind} click opens map`,
    8000,
  );
  await returnToPlan(send);
  return { css: `${after.cssWidth}x${after.cssHeight}`, backing: `${after.backingWidth}x${after.backingHeight}`, dpr: after.dpr };
}

async function provePlanOutsideRelease(send, viewport) {
  const panes = viewport.mobile
    ? [
      { from: { width: 834, height: 1194, dpr: 2 }, to: { width: 860, height: 1080, dpr: 2 } },
      { from: { width: 1194, height: 834, dpr: 2 }, to: { width: 1100, height: 760, dpr: 2 } },
    ]
    : [
      { from: { width: 1400, height: 900, dpr: 1 }, to: { width: 1320, height: 830, dpr: 2 } },
    ];
  const notes = [];
  try {
    for (const pane of panes) {
      for (const kind of ['up', 'cancel', 'lost', 'blur']) {
        const sized = await provePlanOutsideEnding(send, viewport, kind, pane.from, pane.to);
        notes.push(`${pane.from.width}x${pane.from.height} ${kind} ${sized.css} -> ${sized.backing}@${sized.dpr}`);
      }
    }
  } finally {
    await evaluate(send, `(() => { document.querySelector('[data-opd-blur]')?.remove(); window.focus(); return true; })()`);
  }
  return notes.join('; ');
}

async function provePlanMapLive(send, viewport) {
  try {
    const zoom = await provePlanWheelSurvivesRebuild(send);
    await provePlanSmallMotion(send);
    await evaluate(send, `(() => {
      const canvas = document.querySelector('[data-pip="plan"] canvas');
      if (!canvas) return false;
      canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitForPip(send, 'plan', 'plan framed before an outside release', 20000);
    const outside = await provePlanOutsideRelease(send, viewport);
    await provePlanRasterNames(send);
    await provePlanGestureHolds(send, viewport);
    await provePlanRotatingPinch(send);
    return `wheel ${zoom.toFixed(2)}; ${outside}`;
  } finally {
    await evaluate(send, `(() => { delete window.devicePixelRatio; document.querySelector('[data-opd-blur]')?.remove(); return true; })()`);
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
}

async function proveSnapHelpDuringShortcuts(send, viewport) {
  const panes = [
    { width: viewport.width, height: viewport.height },
    { width: viewport.height, height: viewport.width },
  ];
  try {
    for (const pane of panes) {
      await setViewport(send, pane.width, pane.height, true);
      await sleep(400);
      await click(send, '[data-iss-aim-help]');
      await waitFor(
        send,
        `document.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-aim-open') ? { ok: true } : null`,
        `shortcuts open ${pane.width}x${pane.height}`,
        10000,
      );
      const aim = await evaluate(send, `(() => {
        const button = document.querySelector('[data-iss-snap-help]');
        const scene = document.querySelector('[data-iss-scene]');
        if (!button || !scene?.hasAttribute('data-iss-aim-open')) return { ok: false, reason: 'closed' };
        const box = button.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) return { ok: false, reason: 'box', width: box.width, height: box.height };
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const node = document.elementFromPoint(x, y);
        const onButton = !!node && (node === button || button.contains(node));
        return { ok: onButton, x, y, hit: node ? (node.getAttribute('aria-label') || node.id || node.tagName) : null };
      })()`);
      if (!aim?.ok) throw new Error(`SNAP help under shortcuts ${pane.width}x${pane.height} ${JSON.stringify(aim)}`);
      await send('Input.tap', { x: aim.x, y: aim.y });
      await waitFor(
        send,
        `(() => {
          const dialog = document.querySelector('.help-modal');
          if (!dialog) return null;
          const label = dialog.getAttribute('aria-label') || '';
          if (!label.includes('Help')) return null;
          return { ok: true, label };
        })()`,
        `SNAP help dialog ${pane.width}x${pane.height}`,
        10000,
      );
      await click(send, '.help-close');
      await waitFor(send, `!document.querySelector('.help-modal') ? { ok: true } : null`, 'SNAP help closed', 10000);
      if (await evaluate(send, `document.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-aim-open') ? true : false`)) {
        await click(send, '[data-iss-aim-scrim]');
        await waitFor(
          send,
          `document.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-aim-open') ? null : { ok: true }`,
          'shortcuts closed after SNAP help',
          10000,
        );
      }
    }
  } finally {
    await evaluate(send, `document.querySelector('.help-close')?.click()`);
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
}

async function armIssFovWatch(send) {
  await evaluate(send, `(() => {
    const watch = { bad: null, settled: false };
    const read = () => {
      if (watch.bad || watch.settled) return;
      const label = document.querySelector('[data-iss-fov]');
      if (!label || label.getAttribute('data-iss-fov-state') !== 'live') return;
      const text = (label.textContent || '').trim();
      const shown = Number.parseFloat(text);
      const phase = document.querySelector('[data-iss-scene]')?.getAttribute('data-iss-phase') || '';
      const map = window.__opdIss;
      const fov = map && typeof map.getVerticalFieldOfView === 'function' ? map.getVerticalFieldOfView() : null;
      const roll = map && typeof map.getRoll === 'function' ? ((map.getRoll() % 360) + 360) % 360 : null;
      const matched = text.length > 0
        && phase === 'running'
        && typeof fov === 'number' && Number.isFinite(fov)
        && Number.isFinite(shown)
        && Math.abs(shown - fov) <= 0.15
        && typeof roll === 'number' && Math.abs(roll - 180) <= 0.5;
      if (matched) watch.settled = true;
      else watch.bad = { text, shown, phase, fov, roll };
    };
    new MutationObserver(read).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const pump = () => {
      read();
      if (!watch.bad && !watch.settled) requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
    window.__opdFovWatch = watch;
    return true;
  })()`);
}

async function driveIss(send, evidenceDir, viewport, baseUrl) {
  await dismissShotlist(send);
  await armIssFovWatch(send);
  await click(send, '#tab-iss');
  const horizon = await waitFor(
    send,
    `(() => {
      if (window.__opdFovWatch && window.__opdFovWatch.bad) {
        throw new Error('live fov before the camera ' + JSON.stringify(window.__opdFovWatch.bad));
      }
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
      if (${SCENE_SCROLLS}) return null;
      const within = (box) => box.left >= hostBox.left - 1 && box.right <= hostBox.right + 1 && box.top >= hostBox.top - 1 && box.bottom <= hostBox.bottom + 1;
      const splitOn = scene.getAttribute('data-iss-split') === 'on';
      const paneBox = document.getElementById('iss-pane')?.getBoundingClientRect();
      const mapBox = document.querySelector('[data-pip="plan"]')?.getBoundingClientRect();
      const cardOk = splitOn
        ? !!(paneBox && card.top >= paneBox.top - 1 && card.bottom <= paneBox.bottom + 1 && card.left >= paneBox.left - 1 && card.right <= hostBox.left + 2 && (!(mapBox && mapBox.height > 40) || card.top >= mapBox.bottom - 1))
        : within(card);
      if (!within(frame) || !cardOk || !within(portBox) || !within(starboardBox)) return null;
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
      if (${SCENE_SCROLLS}) return null;
      const within = (box) => box.width > 1 && box.height > 1 && box.left >= hostBox.left - 1 && box.right <= hostBox.right + 1 && box.top >= hostBox.top - 1 && box.bottom <= hostBox.bottom + 1;
      const splitOn = scene.getAttribute('data-iss-split') === 'on';
      const paneBox = document.getElementById('iss-pane')?.getBoundingClientRect();
      const mapBox = document.querySelector('[data-pip="plan"]')?.getBoundingClientRect();
      const cardOk = splitOn
        ? !!(paneBox && card.top >= paneBox.top - 1 && card.bottom <= paneBox.bottom + 1 && card.left >= paneBox.left - 1 && card.right <= hostBox.left + 2 && (!(mapBox && mapBox.height > 40) || card.top >= mapBox.bottom - 1))
        : within(card);
      if (!within(frame) || !cardOk || !within(port) || !within(starboard)) return null;
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
  const shortStage = viewport.width === 390 && viewport.height === 664 ? await proveIssShortStages(send) : '';
  const fullscreen = await proveIssFullscreen(send, evidenceDir, viewport);
  if (!insetViewportFits(viewport.width, viewport.height)) {
    await proveSnapHelpDuringShortcuts(send, viewport);
  }
  const pip = await provePipSurface(send, evidenceDir, viewport, 'iss');
  let planLive = '';
  if (insetViewportFits(viewport.width, viewport.height)) {
    planLive = await provePlanMapLive(send, viewport);
  }
  if (insetViewportFits(viewport.width, viewport.height)) {
    await pressInset(send, 'plan', viewport.mobile);
    await waitFor(
      send,
      `document.getElementById('view')?.className === 'view-map' ? { ok: true } : null`,
      'plan inset opens map',
      20000,
    );
    const chromeHidden = await evaluate(send, `document.body.classList.contains('map-chrome-hidden') || document.getElementById('map-pane')?.classList.contains('map-chrome-hidden')`);
    if (chromeHidden) await showMapChrome(send);
    await waitFor(send, pipReadyExpression('horizon'), 'horizon inset after plan tap', 30000);
    await shot(send, evidenceDir, 'pip-to-map');
    await click(send, '#tab-iss');
    await waitFor(
      send,
      `(() => {
        const view = document.getElementById('view');
        const pressed = document.querySelector('[data-iss-preset="horizon"]');
        if (!view || view.className !== 'view-iss') return null;
        if (!pressed || pressed.getAttribute('aria-pressed') !== 'true') return null;
        return { ok: true };
      })()`,
      'iss after plan inset',
      45000,
    );
  }
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
      if (${SCENE_SCROLLS}) return null;
      const within = (box) => box.left >= hostBox.left - 1 && box.right <= hostBox.right + 1 && box.top >= hostBox.top - 1 && box.bottom <= hostBox.bottom + 1;
      const splitOn = scene.getAttribute('data-iss-split') === 'on';
      const paneBox = document.getElementById('iss-pane')?.getBoundingClientRect();
      const mapBox = document.querySelector('[data-pip="plan"]')?.getBoundingClientRect();
      const cardOk = splitOn
        ? !!(paneBox && card.top >= paneBox.top - 1 && card.bottom <= paneBox.bottom + 1 && card.left >= paneBox.left - 1 && card.right <= hostBox.left + 2 && (!(mapBox && mapBox.height > 40) || card.top >= mapBox.bottom - 1))
        : within(card);
      if (!within(frame) || !cardOk || !within(port) || !within(starboard)) return null;
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
  const placement = viewport.width === 390 || viewport.width === 402
    ? await proveLaunchPlacement(baseUrl, evidenceDir, viewport.width)
    : '';
  await click(send, '[data-iss-preset="horizon"]');
  await waitFor(
    send,
    `document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed') === 'true' ? { ok: true } : null`,
    'iss horizon after launch look',
    10000,
  );
  const zoomed = await proveIssOpticalFov(send, evidenceDir);
  const pan = await proveIssPan(send, evidenceDir, zoomed);
  const landscape = await proveIssLandscape(send, evidenceDir);
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
  const towns = await proveIssTownRetry(send, evidenceDir, viewport);
  return `iss: horizon then straight down, map and queue still open, session kept nadir, landscape telemetry held (${landscape}), edition ${edition}, ${shortStage ? `short stage ${shortStage}, ` : ''}fullscreen ${fullscreen}, plan inset ${pip}${planLive ? ` ${planLive}` : ''}, launch look (${launchLook}), ${placement ? `placement ${placement}, ` : ''}fov ${zoomed.toFixed(1)}°, fov live, pan held, pan kept, fov held, windows 1-6 aimed, window kept, window field, aim restored, storage cleared, keyboard aim, cupola keys, preset keys, profile menu escape, keys help, letter pan, fine pan, aim link (${String(horizon.text).slice(0, 80)}), clock lines ${clock.houston} ${clock.gmt} ${clock.dayMonth} ${clock.weekday}, clock after tick, clock after aim, clock cleared, towns recovered (${towns})`;
}

async function proveIssTownRetry(send, evidenceDir, viewport) {
  try {
    const portrait = await proveIssTownsOnce(send, evidenceDir, '');
    if (!viewport || viewport.width !== 402 || viewport.height !== 874) return portrait;
    await setViewport(send, 874, 402, true);
    const landscape = await proveIssTownsOnce(send, evidenceDir, '-874x402');
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
    return `${portrait}; ${landscape}`;
  } finally {
    await evaluate(send, `(() => {
      if (window.__opdRealNow) Date.now = window.__opdRealNow;
      document.cookie = 'opd-verify-towns=; path=/; max-age=0';
      document.cookie = 'opd-verify-nadir=; path=/; max-age=0';
      return true;
    })()`);
  }
}

async function proveIssTownsOnce(send, evidenceDir, shotSuffix) {
  const aim = JSON.stringify({
    mode: 'nadir',
    azimuthDeg: 0,
    windowId: null,
    look: { rightDeg: 0, upDeg: 0 },
    opticalFovDeg: 8,
  });
  await evaluate(send, `(() => {
    const aim = ${JSON.stringify(aim)};
    sessionStorage.setItem('opd-iss-aim', aim);
    localStorage.setItem('opd-iss-aim', aim);
    document.cookie = 'opd-verify-nadir=boston; path=/';
    document.cookie = 'opd-verify-towns=block; path=/';
    return true;
  })()`);
  await reloadSettled(send);
  await evaluate(send, `(() => {
    window.__opdRealNow = Date.now;
    Date.now = () => ${BOSTON_NADIR_EPOCH_MS};
    return true;
  })()`);
  await click(send, '#tab-iss');
  const blocked = await waitFor(
    send,
    `(() => {
      const pressed = document.querySelector('[data-iss-preset="nadir"]');
      const text = document.querySelector('[data-iss-status]')?.textContent || '';
      if (!pressed || pressed.getAttribute('aria-pressed') !== 'true') return null;
      if (!text.includes('Nadir locked')) return null;
      const fov = window.__opdIss?.getVerticalFieldOfView?.();
      if (typeof fov !== 'number' || Math.abs(fov - 8) > 0.5) return null;
      const shown = (node) => {
        const box = node.getBoundingClientRect();
        return box.width > 1 && box.height > 1;
      };
      const places = [...document.querySelectorAll('.iss-place')].filter(shown);
      const towns = places.filter((node) => node.classList.contains('iss-place-town'));
      const base = places.filter((node) => !node.classList.contains('iss-place-town'));
      if (base.length < 1 || towns.length > 0) return null;
      return { ok: true, base: base.map((node) => node.textContent), fov };
    })()`,
    `iss towns blocked${shotSuffix}`,
    45000,
  );
  await shot(send, evidenceDir, `iss-towns-blocked${shotSuffix}`);
  await evaluate(send, `document.cookie = 'opd-verify-towns=; path=/; max-age=0'`);
  const recovered = await waitFor(
    send,
    `(() => {
      const shown = (node) => {
        const box = node.getBoundingClientRect();
        return box.width > 1 && box.height > 1;
      };
      const towns = [...document.querySelectorAll('.iss-place-town')].filter(shown);
      if (towns.length < 1) return null;
      return { ok: true, towns: towns.map((node) => node.textContent) };
    })()`,
    `iss towns recovered${shotSuffix}`,
    30000,
  );
  await shot(send, evidenceDir, `iss-towns-recovered${shotSuffix}`);
  return `base ${blocked.base.join(', ')}; towns ${recovered.towns.join(', ')}${shotSuffix}`;
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
        const side = document.querySelector('[data-iss-side]');
        const docked = document.querySelector('[data-iss-scene]')?.getAttribute('data-iss-side-dock') === 'on';
        if (!root) return { step: 'block' };
        const names = [...root.children].map((el) => {
          if (el.hasAttribute('data-iss-utc')) return 'utc';
          if (el.hasAttribute('data-iss-gmt-day')) return 'gmt-day';
          if (el.hasAttribute('data-iss-houston')) return 'houston';
          if (el.hasAttribute('data-iss-day-month')) return 'day-month';
          if (el.hasAttribute('data-iss-weekday')) return 'weekday';
          return el.tagName;
        });
        if (docked) {
          if (names.join(',') !== 'utc,gmt-day') return { step: 'block', names };
          for (const sel of ['[data-iss-houston]', '[data-iss-day-month]', '[data-iss-weekday]']) {
            const el = document.querySelector(sel);
            if (!side || !el || !side.contains(el)) return { step: 'side', sel };
          }
        } else if (names.join(',') !== 'utc,gmt-day,houston,day-month,weekday') {
          return { step: 'block', names };
        }
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
  const utcLine = document.querySelector('[data-iss-utc]');
  if (!(edition instanceof HTMLParagraphElement) || !help || !horizon || !frame || !toolbar || !utcLine) return null;
  if (edition.textContent !== 'Expedition 75 Beta Edition') return null;
  if (frame.contains(edition)) return null;
  if (help.getAttribute('aria-label') !== 'Keyboard shortcuts') return null;
  const style = getComputedStyle(edition);
  const editionBox = edition.getBoundingClientRect();
  const helpBox = help.getBoundingClientRect();
  const aimBox = horizon.getBoundingClientRect();
  const toolbarBox = toolbar.getBoundingClientRect();
  if (editionBox.width < 8 || editionBox.height < 8) return null;
  if (style.visibility !== 'visible') return { step: 'edition-visibility', visibility: style.visibility };
  const utcSize = getComputedStyle(utcLine).fontSize;
  if (style.fontSize !== utcSize) return { step: 'edition-size', edition: style.fontSize, utc: utcSize };
  if (edition.scrollWidth > edition.clientWidth) return { step: 'edition-clip', scrollWidth: edition.scrollWidth, clientWidth: edition.clientWidth };
  const side = edition.closest('[data-iss-side]');
  if (side && document.querySelector('[data-iss-scene]')?.getAttribute('data-iss-side-dock') === 'on') {
    const sideBox = side.getBoundingClientRect();
    if (editionBox.left < sideBox.left - 1 || editionBox.right > sideBox.right + 1 || editionBox.top < sideBox.top - 1 || editionBox.bottom > sideBox.bottom + 1) {
      return { step: 'side-edition' };
    }
    const covered = [...document.querySelectorAll('[data-iss-presets] > *, [data-iss-aim-help], [data-iss-telemetry], [data-iss-fullscreen]')]
      .map((node) => node.getBoundingClientRect())
      .find((box) => box.width > 0 && box.height > 0 && editionBox.left < box.right - 0.5 && editionBox.right > box.left + 0.5 && editionBox.top < box.bottom - 0.5 && editionBox.bottom > box.top + 0.5);
    if (covered) return { step: 'side-cover' };
    return { ok: true, place: 'side-dock', width: window.innerWidth };
  }
  const wide = window.innerWidth > 720;
  const splitChrome = edition.closest('[data-iss-split-chrome]');
  if (splitChrome) {
    const map = document.querySelector('[data-pip="plan"]')?.getBoundingClientRect();
    const clock = document.querySelector('[data-iss-clock]');
    const clockBox = clock?.getBoundingClientRect();
    if (!map || map.width < 40 || editionBox.top < map.top - 1 || editionBox.bottom > map.bottom + 1 || editionBox.left < map.left - 1) {
      return { step: 'split-edition' };
    }
    if (!clockBox || editionBox.top < clockBox.bottom - 1) return { step: 'split-under-clock', editionTop: editionBox.top, clockBottom: clockBox && clockBox.bottom };
    const hit = document.elementFromPoint(editionBox.left + Math.min(16, editionBox.width / 2), editionBox.top + Math.min(8, editionBox.height / 2));
    if (!hit || !splitChrome.contains(hit)) return { step: 'split-hit', tag: hit && hit.tagName };
    return { ok: true, place: 'map-chrome', width: window.innerWidth };
  }
  if (wide) {
    const clock = document.querySelector('[data-iss-clock]');
    if (!clock || toolbar.offsetHeight !== clock.offsetHeight) {
      return { step: 'toolbar-height', toolbar: toolbar.offsetHeight, clock: clock ? clock.offsetHeight : null, width: window.innerWidth };
    }
    if (style.position !== 'absolute') return { step: 'wide-position', position: style.position, width: window.innerWidth };
    if (editionBox.top < helpBox.bottom - 2) return { step: 'wide-below-help', editionTop: editionBox.top, helpBottom: helpBox.bottom };
    if (Math.abs(editionBox.left - helpBox.left) > 8) return { step: 'wide-left', editionLeft: editionBox.left, helpLeft: helpBox.left };
    if (editionBox.left >= aimBox.left - 1) return { step: 'wide-aim', editionLeft: editionBox.left, aimLeft: aimBox.left };
    if (editionBox.bottom > toolbarBox.bottom + 0.5) return { step: 'wide-band', editionBottom: editionBox.bottom, toolbarBottom: toolbarBox.bottom };
    const covered = [...document.querySelectorAll('[data-iss-presets] > *, [data-iss-aim-help], [data-iss-clock]')]
      .map((node) => node.getBoundingClientRect())
      .find((box) => box.width > 0 && box.height > 0 && editionBox.left < box.right - 0.5 && editionBox.right > box.left + 0.5 && editionBox.top < box.bottom - 0.5 && editionBox.bottom > box.top + 0.5);
    if (covered) return { step: 'wide-cover', edition: [editionBox.left, editionBox.top, editionBox.right, editionBox.bottom], control: [covered.left, covered.top, covered.right, covered.bottom] };
    return { ok: true, place: 'under-help', width: window.innerWidth };
  }
  if (style.position !== 'static') return { step: 'narrow-position', position: style.position, width: window.innerWidth };
  const others = [...toolbar.children].filter((node) => node !== edition && node.getBoundingClientRect().height > 0);
  if (!others.length) return { step: 'narrow-siblings' };
  const lowest = Math.max(...others.map((node) => node.getBoundingClientRect().bottom));
  if (editionBox.top < lowest - 2) return { step: 'narrow-row', editionTop: editionBox.top, lowest, width: window.innerWidth };
  if (editionBox.right > toolbarBox.right + 0.5) return { step: 'narrow-right', editionRight: editionBox.right, toolbarRight: toolbarBox.right };
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

const ISS_FULLSCREEN_HIDDEN = [
  '[data-iss-presets]',
  '[data-iss-edition]',
  '[data-iss-fov]',
  '[data-iss-hint]',
  '.maplibregl-ctrl-attrib',
  '[data-iss-aim-help]',
  '[data-iss-snap-help]',
  '[data-iss-launch-picker]',
];

const ISS_FULLSCREEN_STRIP = `(() => {
  const scene = document.querySelector('[data-iss-scene]');
  const stripped = [];
  for (let proto = Object.getPrototypeOf(scene); proto; proto = Object.getPrototypeOf(proto)) {
    for (const name of ['requestFullscreen', 'webkitRequestFullscreen']) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor && delete proto[name]) stripped.push({ proto, name, descriptor });
    }
  }
  window.__opdFullscreenStripped = stripped;
  return !('requestFullscreen' in scene) && !('webkitRequestFullscreen' in scene);
})()`;

const ISS_FULLSCREEN_RESTORE = `(() => {
  for (const { proto, name, descriptor } of window.__opdFullscreenStripped || []) Object.defineProperty(proto, name, descriptor);
  delete window.__opdFullscreenStripped;
  return true;
})()`;

const ISS_FULLSCREEN_OFF = `(() => {
  const scene = document.querySelector('[data-iss-scene]');
  const button = document.querySelector('[data-iss-fullscreen]');
  const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
  if (!scene || !button || !frame) return { step: 'missing' };
  if (scene.hasAttribute('data-iss-fullscreen-active')) return { step: 'marker' };
  if ((document.fullscreenElement ?? document.webkitFullscreenElement ?? null) !== null) return { step: 'browser-held' };
  if (button.getAttribute('aria-label') !== 'Full screen' || button.title !== 'Full screen') return { step: 'label' };
  if (document.querySelectorAll('[data-iss-fullscreen]').length !== 1) return { step: 'exit-count' };
  if (button.parentElement !== scene) return { step: 'parent' };
  const help = document.querySelector('[data-iss-snap-help]');
  const picker = document.querySelector('[data-iss-launch-picker-wrap]');
  const launches = document.querySelector('[data-iss-launches]');
  if (!(help instanceof HTMLElement) || !(picker instanceof HTMLElement) || !(launches instanceof HTMLElement)) return { step: 'help-missing' };
  if (picker.nextElementSibling !== help || help.nextElementSibling !== launches) return { step: 'help-order' };
  if (help.getAttribute('aria-label') !== 'Help — how to use SNAP' || help.textContent !== '?') return { step: 'help-label', label: help.getAttribute('aria-label') };
  if (getComputedStyle(button).position !== 'absolute') return { step: 'corner-position' };
  if (getComputedStyle(scene).position !== 'absolute') return { step: 'position' };
  if (scene.querySelector('[data-iss-presets]')?.getClientRects().length !== 1) return { step: 'presets' };
  if (${SCENE_SCROLLS}) return { step: 'scroll' };
  const box = button.getBoundingClientRect();
  if (Math.abs(box.width - 44) > 0.5 || Math.abs(box.height - 44) > 0.5) return { step: 'size', width: box.width, height: box.height };
  if (!button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))) return { step: 'hit' };
  const telemetry = document.querySelector('[data-iss-telemetry]')?.getBoundingClientRect();
  if (!telemetry || telemetry.height < 40 || Math.abs(telemetry.height - box.height) > 1) return { step: 'height', telemetry: telemetry ? telemetry.height : null, control: box.height };
  const sceneBox = scene.getBoundingClientRect();
  if (sceneBox.right - box.right > 96 || sceneBox.bottom - box.bottom > 96 || box.right > sceneBox.right + 1 || box.bottom > sceneBox.bottom + 1) {
    return { step: 'corner', scene: [sceneBox.right, sceneBox.bottom], button: [box.right, box.bottom] };
  }
  const shownPlaces = [...document.querySelectorAll('.iss-place')].filter((node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0).length;
  if (shownPlaces < 1) return { step: 'places', shown: shownPlaces };
  const covered = ['[data-iss-telemetry]', '[data-iss-launch-picker]', '[data-iss-snap-help]', '[data-iss-launch]'].find((sel) => {
    const node = document.querySelector(sel);
    if (!node) return false;
    const other = node.getBoundingClientRect();
    return other.width > 1 && box.left < other.right - 0.5 && box.right > other.left + 0.5 && box.top < other.bottom - 0.5 && box.bottom > other.top + 0.5;
  });
  if (covered) return { step: 'overlap', covered, button: [box.left, box.top, box.right, box.bottom] };
  return { ok: true, width: frame.width, height: frame.height };
})()`;

function issFullscreenHeldExpression(expected) {
  return `(() => {
    const scene = document.querySelector('[data-iss-scene]');
    const frame = document.querySelector('[data-iss-frame]');
    const button = document.querySelector('[data-iss-fullscreen]');
    const clock = document.querySelector('[data-iss-clock]');
    const map = window.__opdIss;
    if (!scene || !frame || !button || !clock || !map) return { step: 'missing' };
    if (!scene.hasAttribute('data-iss-fullscreen-active')) return { step: 'marker' };
    const planInset = document.querySelector('[data-pip="plan"]');
    if (planInset && getComputedStyle(planInset).display !== 'none' && planInset.getClientRects().length > 0) return { step: 'inset' };
    const held = document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
    if (${expected === 'element' ? 'held !== scene' : 'held !== null'}) return { step: 'mode', held: held ? held.tagName : null };
    if (button.getAttribute('aria-label') !== 'Exit full screen' || button.title !== 'Exit full screen') return { step: 'label' };
    const sceneBox = scene.getBoundingClientRect();
    const viewport = window.visualViewport;
    const view = viewport
      ? { left: viewport.offsetLeft, top: viewport.offsetTop, right: viewport.offsetLeft + viewport.width, bottom: viewport.offsetTop + viewport.height }
      : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    if (getComputedStyle(scene).position !== 'fixed') return { step: 'position', position: getComputedStyle(scene).position };
    if (sceneBox.left > view.left + 0.5 || sceneBox.top > view.top + 0.5 || sceneBox.right < view.right - 0.5 || sceneBox.bottom < view.bottom - 0.5) {
      return { step: 'cover', scene: [sceneBox.left, sceneBox.top, sceneBox.right, sceneBox.bottom], view };
    }
    const probe = document.createElement('div');
    probe.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 100dvh; visibility: hidden';
    document.body.append(probe);
    const dvh = probe.getBoundingClientRect().height;
    probe.remove();
    if (Math.abs(sceneBox.height - dvh) > 1) return { step: 'dvh', height: sceneBox.height, dvh };
    if (${SCENE_SCROLLS}) return { step: 'scroll' };
    if (getComputedStyle(document.body).overflow !== 'hidden' || getComputedStyle(document.getElementById('view')).overflow !== 'hidden') return { step: 'scroll-lock' };
    const points = [[view.left + 2, view.top + 2], [view.right - 2, view.top + 2], [view.left + 2, view.bottom - 2], [view.right - 2, view.bottom - 2]];
    const fab = document.getElementById('help-fab');
    if (fab && !fab.hidden) {
      const fabBox = fab.getBoundingClientRect();
      points.push([fabBox.left + fabBox.width / 2, fabBox.top + fabBox.height / 2]);
    }
    const uncovered = points.find(([x, y]) => !scene.contains(document.elementFromPoint(x, y)));
    if (uncovered) return { step: 'app-shows', point: uncovered, hit: document.elementFromPoint(uncovered[0], uncovered[1])?.outerHTML.slice(0, 80) };
    const buttonBox = button.getBoundingClientRect();
    if (document.querySelectorAll('[data-iss-fullscreen]').length !== 1) return { step: 'exit-count' };
    if (!button.contains(document.elementFromPoint(buttonBox.left + buttonBox.width / 2, buttonBox.top + buttonBox.height / 2))) return { step: 'button-hit' };
    const telemetryBox = document.querySelector('[data-iss-telemetry]')?.getBoundingClientRect();
    if (!telemetryBox || telemetryBox.height < 40 || Math.abs(telemetryBox.height - buttonBox.height) > 1) return { step: 'height', telemetry: telemetryBox ? telemetryBox.height : null, control: buttonBox.height };
    const outsiders = [...document.querySelectorAll('.profile-badge, .tab, .topbar button, .topbar a')].filter((node) => {
      const other = node.getBoundingClientRect();
      return other.width > 0 && other.height > 0 && buttonBox.left < other.right - 0.5 && buttonBox.right > other.left + 0.5 && buttonBox.top < other.bottom - 0.5 && buttonBox.bottom > other.top + 0.5;
    }).map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 24));
    if (outsiders.length) return { step: 'exit-overlap', outsiders };
    const shownPlaces = [...scene.querySelectorAll('.iss-place')].filter((node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0).length;
    const beforePlaces = window.__opdIssPlaceCount || 0;
    if (shownPlaces < 1 || (beforePlaces > 0 && (shownPlaces < Math.max(1, Math.floor(beforePlaces * 0.5)) || shownPlaces > beforePlaces + 30))) {
      return { step: 'places', shown: shownPlaces, before: beforePlaces };
    }
    const hiddenSet = ${JSON.stringify(ISS_FULLSCREEN_HIDDEN)}.concat(['[data-iss-launches]']).concat(scene.getAttribute('data-iss-phase') === 'error' ? [] : ['[data-iss-telemetry-body]']);
    const shown = hiddenSet.flatMap((sel) => {
      const nodes = [...scene.querySelectorAll(sel)];
      if (!nodes.length) return [sel + ' missing'];
      return nodes.some((node) => node.getClientRects().length > 0) ? [sel] : [];
    });
    if (shown.length) return { step: 'hidden', shown };
    const topmost = (el, box) => {
      el.style.pointerEvents = 'auto';
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      el.style.pointerEvents = '';
      return el.contains(hit);
    };
    const frameBox = frame.getBoundingClientRect();
    const glyphs = {};
    for (const [side, sel] of [['starboard', '[data-iss-starboard]'], ['port', '[data-iss-port]']]) {
      const label = scene.querySelector(sel);
      const range = document.createRange();
      range.selectNodeContents(label);
      const ink = range.getBoundingClientRect();
      if (!(ink.width > 2 && ink.height > 8)) return { step: 'glyph-size', side, width: ink.width, height: ink.height };
      if (ink.left < frameBox.left - 0.5 || ink.right > frameBox.right + 0.5 || ink.top < frameBox.top - 0.5 || ink.bottom > frameBox.bottom + 0.5) {
        return { step: 'glyph-frame', side, ink: [ink.left, ink.top, ink.right, ink.bottom], frame: [frameBox.left, frameBox.top, frameBox.right, frameBox.bottom] };
      }
      if (!topmost(label, ink)) return { step: 'glyph-covered', side };
      glyphs[side] = ink;
    }
    const middle = frameBox.left + frameBox.width / 2;
    if (!(glyphs.starboard.right < middle && glyphs.port.left > middle)) return { step: 'glyph-sides' };
    if (clock.children.length !== 5) return { step: 'clock-lines', count: clock.children.length };
    for (const line of clock.children) {
      const box = line.getBoundingClientRect();
      const name = Object.keys(line.dataset).join(',');
      if (!(box.width > 8 && box.height > 4)) return { step: 'clock-box', name, width: box.width, height: box.height };
      if (box.left < view.left - 0.5 || box.right > view.right + 0.5 || box.top < view.top - 0.5 || box.bottom > view.bottom + 0.5) return { step: 'clock-view', name };
      if (!(line.textContent || '').trim()) return { step: 'clock-text', name };
      if (getComputedStyle(line).visibility !== 'visible') return { step: 'clock-visibility', name };
      if (!topmost(line, box)) return { step: 'clock-covered', name };
      if (box.left < buttonBox.right && box.right > buttonBox.left && box.top < buttonBox.bottom && box.bottom > buttonBox.top) return { step: 'clock-on-button', name };
    }
    const pad = getComputedStyle(scene);
    const controlsBox = document.querySelector('[data-iss-controls]')?.getBoundingClientRect();
    const roomWidth = sceneBox.width - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
    const roomHeight = sceneBox.height - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom) - (controlsBox ? controlsBox.height : 0);
    if (Math.abs(frameBox.width - roomWidth) > 1 && Math.abs(frameBox.height - roomHeight) > 1) {
      return { step: 'frame-fit', frame: [frameBox.width, frameBox.height], room: [roomWidth, roomHeight] };
    }
    const ratio = map.getPixelRatio();
    const canvas = map.getCanvas();
    if (Math.abs(ratio - Math.min(1.5, devicePixelRatio)) > 0.001) return { step: 'ratio', ratio, device: devicePixelRatio };
    if (Math.abs(canvas.clientWidth - frameBox.width) > 1 || Math.abs(canvas.width - canvas.clientWidth * ratio) > 1.5) {
      return { step: 'backing', client: [canvas.clientWidth, canvas.clientHeight], backing: [canvas.width, canvas.height], frame: [frameBox.width, frameBox.height], ratio };
    }
    return { ok: true, width: Math.round(frameBox.width), height: Math.round(frameBox.height), ratio, places: shownPlaces, beforePlaces, telemetry: Math.round(telemetryBox.height), control: Math.round(buttonBox.height) };
  })()`;
}

async function pressIssFullscreen(send) {
  await revealInView(send, '[data-iss-fullscreen]');
  const center = await evaluate(send, `(() => {
    const box = document.querySelector('[data-iss-fullscreen]').getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  await mouseClick(send, center.x, center.y);
}

async function enterFullscreenThroughOpenSheet(send, mobile) {
  await click(send, '[data-iss-aim-help]');
  await waitFor(
    send,
    `document.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-aim-open') ? { ok: true } : null`,
    'iss shortcut sheet open before fullscreen',
    10000,
  );
  await revealInView(send, '[data-iss-fullscreen]');
  const aim = await evaluate(send, `(() => {
    const button = document.querySelector('[data-iss-fullscreen]');
    const scene = document.querySelector('[data-iss-scene]');
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const node = document.elementFromPoint(x, y);
    const onButton = !!node && (node === button || button.contains(node));
    return {
      ok: onButton && scene.hasAttribute('data-iss-aim-open'),
      x,
      y,
      hit: node ? (node.closest('[data-iss-fullscreen]') ? 'fullscreen' : (node.id || node.tagName)) : null,
    };
  })()`);
  if (!aim?.ok) throw new Error(`iss fullscreen button missed while the sheet is open ${JSON.stringify(aim)}`);
  if (mobile) await send('Input.tap', { x: aim.x, y: aim.y });
  else await mouseClick(send, aim.x, aim.y);
  await waitFor(
    send,
    `(() => {
      const scene = document.querySelector('[data-iss-scene]');
      const sheet = scene?.querySelector('[data-iss-aim-sheet]');
      if (!scene?.hasAttribute('data-iss-fullscreen-active')) return { step: 'fullscreen' };
      if (scene.hasAttribute('data-iss-aim-open') || !sheet?.hidden) return { step: 'sheet' };
      return { ok: true };
    })()`,
    'iss fullscreen from an open shortcut sheet',
    10000,
  );
}

function sameFrame(before, after) {
  return Math.abs(before.width - after.width) <= 1 && Math.abs(before.height - after.height) <= 1;
}

function issBackingExpression(ratio) {
  return `(() => {
    const map = window.__opdIss;
    const canvas = map?.getCanvas();
    if (!canvas) return { step: 'missing' };
    if (map.getPixelRatio() !== ${ratio}) return { step: 'ratio', ratio: map.getPixelRatio(), device: devicePixelRatio };
    if (Math.abs(canvas.width - canvas.clientWidth * ${ratio}) > 1.5) return { step: 'backing', backing: canvas.width, client: canvas.clientWidth };
    return { ok: true };
  })()`;
}

const ISS_SHORT_STAGE = `(() => {
  const frame = document.querySelector('[data-iss-frame]');
  const stage = document.querySelector('[data-iss-stage]');
  const telemetry = document.querySelector('[data-iss-telemetry]');
  const controls = document.querySelector('[data-iss-controls]');
  const scene = document.querySelector('[data-iss-scene]');
  if (!frame || !stage || !telemetry || !controls || !scene) return { step: 'missing' };
  if (window.innerHeight > 564) return { step: 'viewport', inner: window.innerHeight };
  const frameBox = frame.getBoundingClientRect();
  const stageBox = stage.getBoundingClientRect();
  const telemetryBox = telemetry.getBoundingClientRect();
  const controlsBox = controls.getBoundingClientRect();
  if (frameBox.width < 200 || frameBox.height < 120) {
    return { step: 'size', width: Math.round(frameBox.width), height: Math.round(frameBox.height) };
  }
  const hits = (a, b) => a.width > 0 && b.width > 0 && a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
  if (hits(stageBox, telemetryBox) || hits(stageBox, controlsBox) || hits(frameBox, telemetryBox) || hits(frameBox, controlsBox)) {
    return { step: 'overlap', frame: [Math.round(frameBox.top), Math.round(frameBox.bottom)], controls: [Math.round(controlsBox.top), Math.round(controlsBox.bottom)] };
  }
  if (!scene.hasAttribute('data-iss-short')) return { step: 'short' };
  const sels = ['[data-iss-telemetry]', '[data-iss-fullscreen]', '[data-iss-launch-picker]', '[data-iss-snap-help]', '[data-iss-aim-help]', '[data-iss-preset="horizon"]', '[data-iss-preset="nadir"]', '[data-iss-cupola]'];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el) return { step: 'control-missing', sel };
    const box = el.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return { step: 'control-box', sel, w: Math.round(box.width), h: Math.round(box.height) };
    const node = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!node || (node !== el && !el.contains(node))) return { step: 'hit', sel, hit: node ? (node.id || node.getAttribute('aria-label') || node.tagName) : null };
  }
  return { ok: true, width: Math.round(frameBox.width), height: Math.round(frameBox.height) };
})()`;

async function proveIssShortStages(send) {
  const rows = [];
  for (const size of [{ width: 390, height: 564 }, { width: 390, height: 520 }]) {
    await setViewport(send, size.width, size.height, true);
    const laid = await waitFor(send, ISS_SHORT_STAGE, `iss short stage ${size.width}x${size.height}`, 10000);
    rows.push(`${size.width}x${size.height} ${laid.width}x${laid.height}`);
  }
  await setViewport(send, 390, 664, true);
  await waitFor(
    send,
    `(() => {
      if (window.innerHeight !== 664) return null;
      const scene = document.querySelector('[data-iss-scene]');
      const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
      if (!scene || scene.hasAttribute('data-iss-short') || !frame || frame.width < 160) return null;
      if (${SCENE_SCROLLS}) return null;
      return { ok: true };
    })()`,
    'iss short stage restored 390x664',
    10000,
  );
  return rows.join(', ');
}

function issSplitFullscreenExpression() {
  return `(() => {
    const scene = document.querySelector('[data-iss-scene]');
    const card = document.querySelector('[data-iss-card]');
    const telemetry = document.querySelector('[data-iss-telemetry]');
    const button = document.querySelector('[data-iss-fullscreen]');
    if (!scene || !card || !telemetry || !button) return { step: 'missing' };
    if (!scene.hasAttribute('data-iss-fullscreen-active')) return { step: 'marker' };
    if (card.parentElement !== scene) return { step: 'park' };
    const cardBox = card.getBoundingClientRect();
    if (getComputedStyle(card).display === 'none' || card.getClientRects().length === 0) {
      return { step: 'card', display: getComputedStyle(card).display, w: Math.round(cardBox.width), h: Math.round(cardBox.height) };
    }
    const t = telemetry.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    if (t.width < 80 || t.height < 40 || t.height > 52) return { step: 'telemetry', w: Math.round(t.width), h: Math.round(t.height) };
    const tHit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
    if (!tHit || !telemetry.contains(tHit)) return { step: 'telemetry-hit', hit: tHit ? (tHit.getAttribute('aria-label') || tHit.tagName) : null };
    if (button.parentElement !== scene) return { step: 'parent' };
    if (Math.abs(b.width - 44) > 1 || Math.abs(b.height - 44) > 1) return { step: 'exit', w: Math.round(b.width), h: Math.round(b.height) };
    const sceneBox = scene.getBoundingClientRect();
    if (sceneBox.right - b.right > 96 || sceneBox.bottom - b.bottom > 96) return { step: 'corner', right: Math.round(sceneBox.right - b.right), bottom: Math.round(sceneBox.bottom - b.bottom) };
    const bHit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (!bHit || !button.contains(bHit)) return { step: 'exit-hit', hit: bHit ? (bHit.getAttribute('aria-label') || bHit.id || bHit.tagName) : null };
    if (button.getAttribute('aria-label') !== 'Exit full screen') return { step: 'label', label: button.getAttribute('aria-label') };
    const shownPlaces = [...scene.querySelectorAll('.iss-place')].filter((node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0).length;
    const beforePlaces = window.__opdIssPlaceCount || 0;
    if (shownPlaces < 1 || (beforePlaces > 0 && (shownPlaces < Math.max(1, Math.floor(beforePlaces * 0.5)) || shownPlaces > beforePlaces + 30))) {
      return { step: 'places', shown: shownPlaces, before: beforePlaces };
    }
    return {
      ok: true,
      telemetry: [Math.round(t.width), Math.round(t.height)],
      exit: [Math.round(b.width), Math.round(b.height)],
      places: shownPlaces,
      beforePlaces,
    };
  })()`;
}

function issSplitDockedExpression() {
  return `(() => {
    const scene = document.querySelector('[data-iss-scene]');
    const card = document.querySelector('[data-iss-card]');
    const dock = document.querySelector('[data-iss-split-dock]');
    const telemetry = document.querySelector('[data-iss-telemetry]');
    const button = document.querySelector('[data-iss-fullscreen]');
    if (!scene || !card || !dock || !telemetry || !button) return { step: 'missing' };
    if (scene.hasAttribute('data-iss-fullscreen-active')) return { step: 'marker' };
    if (scene.getAttribute('data-iss-split') !== 'on') return { step: 'split' };
    if (!dock.contains(card)) return { step: 'dock' };
    if (button.parentElement !== scene) return { step: 'parent' };
    const help = document.querySelector('[data-iss-snap-help]');
    const picker = document.querySelector('[data-iss-launch-picker-wrap]');
    if (picker?.nextElementSibling !== help) return { step: 'help-order' };
    if (button.getAttribute('aria-label') !== 'Full screen') return { step: 'label', label: button.getAttribute('aria-label') };
    const t = telemetry.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    if (t.width < 80 || t.height < 40) return { step: 'telemetry', w: Math.round(t.width), h: Math.round(t.height) };
    if (Math.abs(b.width - 44) > 1 || Math.abs(b.height - 44) > 1) return { step: 'exit', w: Math.round(b.width), h: Math.round(b.height) };
    if (!telemetry.contains(document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2))) return { step: 'telemetry-hit' };
    if (!button.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2))) return { step: 'exit-hit' };
    return { ok: true, telemetry: [Math.round(t.width), Math.round(t.height)], exit: [Math.round(b.width), Math.round(b.height)] };
  })()`;
}

async function proveIssSplitFullscreen(send, viewport) {
  if (!insetViewportFits(viewport.width, viewport.height)) return 'phone column';
  const sizes = [
    { width: 1400, height: 900 },
    { width: 1280, height: 700 },
    { width: 1194, height: 834 },
  ];
  const rows = [];
  const seen = new Set();
  const measure = async (width, height) => {
    const key = `${width}x${height}`;
    if (seen.has(key)) return;
    seen.add(key);
    const held = await waitFor(send, issSplitFullscreenExpression(), `iss split fullscreen ${key}`, 10000);
    const open = await proveFullscreenTelemetry(send);
    rows.push(`${key} telemetry ${held.telemetry[0]}x${held.telemetry[1]} exit ${held.exit[0]}x${held.exit[1]} body ${open} labels ${held.beforePlaces}->${held.places}`);
  };
  let current = { width: viewport.width, height: viewport.height };
  await measure(current.width, current.height);
  let holding = true;
  for (const size of sizes) {
    const key = `${size.width}x${size.height}`;
    if (seen.has(key)) continue;
    if (holding) {
      await pressIssFullscreen(send);
      await waitFor(send, ISS_FULLSCREEN_OFF, `iss split fullscreen leave ${current.width}x${current.height}`, 10000);
      const docked = await waitFor(send, issSplitDockedExpression(), `iss split dock after ${current.width}x${current.height}`, 10000);
      rows.push(`after ${current.width}x${current.height} dock telemetry ${docked.telemetry[0]}x${docked.telemetry[1]} exit ${docked.exit[0]}x${docked.exit[1]}`);
      holding = false;
    }
    await setViewport(send, size.width, size.height, viewport.mobile);
    current = size;
    await pressIssFullscreen(send);
    holding = true;
    await measure(size.width, size.height);
  }
  if (holding) {
    await pressIssFullscreen(send);
    await waitFor(send, ISS_FULLSCREEN_OFF, `iss split fullscreen leave ${current.width}x${current.height}`, 10000);
    const docked = await waitFor(send, issSplitDockedExpression(), `iss split dock after ${current.width}x${current.height}`, 10000);
    rows.push(`after ${current.width}x${current.height} dock telemetry ${docked.telemetry[0]}x${docked.telemetry[1]} exit ${docked.exit[0]}x${docked.exit[1]}`);
  }
  await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  const restored = await waitFor(send, issSplitDockedExpression(), `iss split dock restored ${viewport.width}x${viewport.height}`, 10000);
  rows.push(`restored ${viewport.width}x${viewport.height} telemetry ${restored.telemetry[0]}x${restored.telemetry[1]} exit ${restored.exit[0]}x${restored.exit[1]}`);
  await pressIssFullscreen(send);
  return rows.join('; ');
}

async function proveFullscreenTelemetry(send) {
  await click(send, '[data-iss-telemetry]');
  const open = await waitFor(send, `(() => {
    const toggle = document.querySelector('[data-iss-telemetry]');
    const body = document.querySelector('[data-iss-telemetry-body]');
    if (!toggle || !body) return null;
    const box = body.getBoundingClientRect();
    const display = getComputedStyle(body).display;
    if (toggle.getAttribute('aria-expanded') !== 'true') return { step: 'expanded', value: toggle.getAttribute('aria-expanded') };
    if (display === 'none' || box.width < 8 || box.height < 8) return { step: 'box', display, w: box.width, h: box.height };
    return { ok: true, w: Math.round(box.width), h: Math.round(box.height) };
  })()`, 'iss fullscreen telemetry open', 10000);
  await click(send, '[data-iss-telemetry]');
  await waitFor(
    send,
    `(() => {
      const toggle = document.querySelector('[data-iss-telemetry]');
      const body = document.querySelector('[data-iss-telemetry-body]');
      if (toggle?.getAttribute('aria-expanded') !== 'false') return null;
      if (body && body.getClientRects().length > 0) return null;
      return { ok: true };
    })()`,
    'iss fullscreen telemetry closed',
    10000,
  );
  return `${open.w}x${open.h}`;
}

async function proveIssFullscreen(send, evidenceDir, viewport) {
  const phone = viewport.mobile && viewport.width < 600;
  if (phone && !await evaluate(send, ISS_FULLSCREEN_STRIP)) throw new Error('iss fullscreen request methods still present');
  try {
    const expected = await evaluate(send, `(() => {
      const scene = document.querySelector('[data-iss-scene]');
      return 'requestFullscreen' in scene || 'webkitRequestFullscreen' in scene ? 'element' : 'overlay';
    })()`);
    const rememberPlaces = `window.__opdIssPlaceCount = [...document.querySelectorAll('.iss-place')].filter((node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0).length`;
    const beforePlaces = await evaluate(send, rememberPlaces);
    const idle = await waitFor(send, ISS_FULLSCREEN_OFF, 'iss fullscreen button idle', 10000);
    await enterFullscreenThroughOpenSheet(send, viewport.mobile);
    const split = await proveIssSplitFullscreen(send, viewport);
    const held = await waitFor(send, issFullscreenHeldExpression(expected), `iss fullscreen ${expected}`, 10000);
    await shot(send, evidenceDir, 'iss-fullscreen');
    const telemetryOpen = await proveFullscreenTelemetry(send);
    if (!viewport.mobile) {
      await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 2, mobile: false });
      await waitFor(send, issBackingExpression(1.5), 'iss canvas follows a 2x device at the 1.5 cap', 10000);
      await setViewport(send, viewport.width, viewport.height, viewport.mobile);
      await waitFor(send, issBackingExpression(1), 'iss canvas back at 1x', 10000);
      await waitFor(send, issFullscreenHeldExpression(expected), `iss fullscreen ${expected} after the device ratio`, 10000);
    }
    await pressIssFullscreen(send);
    const back = await waitFor(send, ISS_FULLSCREEN_OFF, 'iss fullscreen exit by button', 10000);
    if (insetViewportFits(viewport.width, viewport.height)) {
      await waitForPip(send, 'plan', 'plan inset back after fullscreen', 20000);
    }
    if (!sameFrame(idle, back)) throw new Error(`iss frame after fullscreen ${JSON.stringify(back)} is not ${JSON.stringify(idle)}`);
    await click(send, '[data-iss-preset="nadir"]');
    const stored = await waitFor(
      send,
      `(() => {
        if (document.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed') !== 'true') return null;
        const raw = sessionStorage.getItem('opd-iss-aim');
        const link = new URLSearchParams((location.hash || '').replace(/^#/, '')).get('iss');
        if (!raw || !raw.includes('"nadir"') || link !== raw || localStorage.getItem('opd-iss-aim') !== raw) return null;
        return { ok: true, raw, hash: location.hash };
      })()`,
      'iss straight down stored before fullscreen Escape',
      10000,
    );
    await evaluate(send, rememberPlaces);
    await pressIssFullscreen(send);
    await waitFor(send, issFullscreenHeldExpression(expected), `iss fullscreen ${expected} on straight down`, 10000);
    await pressKey(send, 'Escape');
    await waitFor(
      send,
      `(() => {
        const off = ${ISS_FULLSCREEN_OFF};
        const beforePlaces = window.__opdIssPlaceCount || 0;
        const dockedEmpty = !off.ok && off.step === 'places' && beforePlaces < 1 && off.shown < 1;
        if (!off.ok && !dockedEmpty) return off;
        if (document.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed') !== 'true') return { step: 'aim-reset' };
        if (location.hash !== ${JSON.stringify(stored.hash)}) return { step: 'hash', hash: location.hash };
        if (sessionStorage.getItem('opd-iss-aim') !== ${JSON.stringify(stored.raw)}) return { step: 'session' };
        if (localStorage.getItem('opd-iss-aim') !== ${JSON.stringify(stored.raw)}) return { step: 'local' };
        return dockedEmpty ? { ok: true, places: 0 } : off;
      })()`,
      'iss Escape left fullscreen and kept the aim',
      10000,
    );
    await click(send, '[data-iss-preset="horizon"]');
    await waitFor(
      send,
      `document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed') === 'true' && (document.querySelector('[data-iss-status]')?.textContent || '').includes('Horizon locked') ? { ok: true } : null`,
      'iss horizon after fullscreen',
      10000,
    );
    const followed = viewport.mobile ? '' : ', 2x device drew at 1.5x';
    return `sheet press, ${expected} ${held.width}x${held.height} at ${held.ratio}x${followed}, labels ${beforePlaces} then ${held.places}, boxes ${held.telemetry}x${held.control}, telemetry open ${telemetryOpen}, split ${split}, Escape kept aim`;
  } finally {
    if (phone) await evaluate(send, ISS_FULLSCREEN_RESTORE);
  }
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

const EARTH_AFTER_RESIZE = `
  const staleFrame = document.querySelector('[data-iss-frame]');
  if (staleFrame instanceof HTMLElement) {
    staleFrame.style.width = '109px';
    staleFrame.style.height = '72px';
  }
  window.dispatchEvent(new Event('resize'));
  const laidFrame = document.querySelector('[data-iss-frame]');
  const laidBox = laidFrame instanceof HTMLElement ? laidFrame.getBoundingClientRect() : null;
  if (!laidBox || laidBox.width < 80 || laidBox.height < 80) {
    return {
      step: 'earth',
      width: laidBox ? Math.round(laidBox.width) : 0,
      height: laidBox ? Math.round(laidBox.height) : 0,
    };
  }
`;

const LAUNCH_EARTH_CHECK = `
  const frame = document.querySelector('[data-iss-frame]');
  const card = document.querySelector('[data-iss-launch-card]');
  const button = document.querySelector('[data-iss-launch]');
  const scene = document.querySelector('[data-iss-scene]');
  if (!frame || !card || !button || !scene || card.hidden) return null;
  const frameBox = frame.getBoundingClientRect();
  const cardBox = card.getBoundingClientRect();
  const buttonBox = button.getBoundingClientRect();
  if (buttonBox.width < 44 || buttonBox.height < 44) return null;
  const place = scene.dataset.issLaunchPlace || '';
  const visibility = card.querySelector('[data-iss-launch-visibility]')?.textContent || '';
  const mark = document.querySelector('.iss-launch-pin, [data-iss-launch-edge]');
  const markBox = mark ? mark.getBoundingClientRect() : null;
  const markKind = !mark ? 'none' : (mark.classList.contains('iss-launch-pin') ? 'pin' : 'arrow');
  if (visibility === 'Site below horizon') {
    if (mark) return { step: 'mark', visibility };
  } else if (visibility === 'Site in frame' || visibility === 'Site outside frame') {
    if (!markBox || markBox.width < 8 || markBox.height < 8) return { step: 'mark', visibility, markKind };
    const covered = markBox.left >= cardBox.left - 1 && markBox.right <= cardBox.right + 1 && markBox.top >= cardBox.top - 1 && markBox.bottom <= cardBox.bottom + 1;
    if (covered) return { step: 'mark-covered', visibility, markKind, width: Math.round(frameBox.width), height: Math.round(frameBox.height) };
  } else {
    return { step: 'visibility', visibility, width: Math.round(frameBox.width), height: Math.round(frameBox.height), place };
  }
  if (frameBox.width < 80 || frameBox.height < 80) {
    return { step: 'earth', width: Math.round(frameBox.width), height: Math.round(frameBox.height), place };
  }
  const shortSide = Math.min(frameBox.width, frameBox.height);
  if ((place === 'over' || place === 'below') && shortSide < 120) {
    return { step: 'earth', width: Math.round(frameBox.width), height: Math.round(frameBox.height), place, shortSide: Math.round(shortSide) };
  }
  if (scene.scrollHeight !== scene.clientHeight || scene.scrollWidth !== scene.clientWidth) {
    return { step: 'scroll', height: [scene.scrollHeight, scene.clientHeight], width: [scene.scrollWidth, scene.clientWidth], place };
  }
  const covers = (box) => box.left < frameBox.right - 1 && box.right > frameBox.left + 1 && box.top < frameBox.bottom - 1 && box.bottom > frameBox.top + 1;
  if (covers(buttonBox) || (place !== 'over' && covers(cardBox))) {
    return { step: 'cover', place, button: covers(buttonBox), card: covers(cardBox) };
  }
  const line = card.querySelector('[data-iss-launch-visibility]');
  const lineBox = line ? line.getBoundingClientRect() : null;
  if (!lineBox || lineBox.height < 4 || lineBox.bottom <= cardBox.top + 1 || lineBox.top >= cardBox.bottom - 1) {
    return { step: 'visibility-line', visibility, place };
  }
  return {
    ok: true,
    width: Math.round(frameBox.width),
    height: Math.round(frameBox.height),
    place,
    visibility,
    mark: markKind,
    scrollHeight: scene.scrollHeight,
    clientHeight: scene.clientHeight,
    scrollWidth: scene.scrollWidth,
    clientWidth: scene.clientWidth,
  };
`;

function splitLaunchPlace(width, height) {
  if (width < 800 || height < 600) return null;
  const mapColumn = Math.max(300, width * 0.36);
  return width - mapColumn <= 720 ? 'below' : 'side';
}

const PHONE_LANDSCAPE_FLOOR = { minShort: 160, minWidth: 240, minHeight: 160 };

function phoneLandscapeFloor(width, height) {
  if ((width === 844 && height === 390) || (width === 874 && height === 402) || (width === 721 && height === 390)) return PHONE_LANDSCAPE_FLOOR;
  return null;
}

function phoneLandscapePane(width, height) {
  return {
    width,
    height,
    mobile: true,
    label: `${width}x${height}`,
    place: 'side',
    ...PHONE_LANDSCAPE_FLOOR,
  };
}

export function launchEarthPanes(width, height) {
  const native = { width, height, mobile: width < 1100, label: `${width}x${height}`, place: '', minShort: 80 };
  if (width === 390 && height === 664) {
    return [
      { ...native, place: 'over', minShort: 160 },
      { width: 390, height: 844, mobile: true, label: '390x844', place: 'below', minShort: 200 },
      phoneLandscapePane(844, 390),
      { width: 390, height: 565, mobile: true, label: '390x565', place: '', places: ['below', 'over'], minShort: 120, twoLine: true, sceneBox: true },
    ];
  }
  if (width === 402 && height === 874) {
    return [
      { ...native, place: 'below', minShort: 200 },
      phoneLandscapePane(874, 402),
      { width: 402, height: 565, mobile: true, label: '402x565', place: '', places: ['below', 'over'], minShort: 120, twoLine: true, sceneBox: true },
    ];
  }
  const freshLandscape = phoneLandscapeFloor(width, height);
  if (freshLandscape) return [{ ...native, place: 'side', ...freshLandscape }];
  if (width >= 1200) {
    const splitPlace = splitLaunchPlace(width, height);
    return [{ ...native, place: splitPlace || 'side', minShort: splitPlace ? 300 : 400 }];
  }
  if (width >= 800) return [{ ...native, place: splitLaunchPlace(width, height) || 'side', minShort: 200 }];
  return [native];
}

async function setLayoutViewport(send, width, height, mobile) {
  const current = await evaluate(send, `({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })`);
  if (current?.w === width && current?.h === height) return;
  if (current?.w === width && current?.h !== height) {
    await setViewport(send, width + 40, height, mobile);
  }
  await setViewport(send, width, height, mobile);
}

async function readIssSceneBox(send) {
  return evaluate(send, `(() => {
    window.dispatchEvent(new Event('resize'));
    const scene = document.querySelector('[data-iss-scene]');
    if (!scene) return null;
    return { sceneW: scene.clientWidth, sceneH: scene.clientHeight, docW: document.documentElement.clientWidth, docH: document.documentElement.clientHeight };
  })()`);
}

async function setIssSceneBox(send, width, height, mobile) {
  let viewW = width;
  let viewH = height;
  let laid = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await setLayoutViewport(send, viewW, viewH, mobile);
    laid = await readIssSceneBox(send);
    if (!laid) throw new Error('missing iss scene');
    if (laid.sceneW === width && laid.sceneH === height) {
      const again = await readIssSceneBox(send);
      if (again?.sceneW === width && again?.sceneH === height) return { width: viewW, height: viewH, scene: again };
      if (!again) throw new Error('missing iss scene');
      laid = again;
    }
    const nextW = viewW + (width - laid.sceneW);
    const nextH = viewH + (height - laid.sceneH);
    if (nextW === viewW && nextH === viewH) break;
    viewW = nextW;
    viewH = nextH;
  }
  throw new Error(`iss scene ${width}x${height} laid out as ${laid?.sceneW}x${laid?.sceneH} in viewport ${viewW}x${viewH}`);
}

async function proveLaunchCardHolds(send, label) {
  const held = await evaluate(send, `(() => new Promise((resolve) => {
    const read = () => document.querySelector('[data-iss-scene]')?.dataset.issLaunchPlace || '';
    const samples = [read()];
    const timer = setInterval(() => samples.push(read()), 200);
    setTimeout(() => {
      clearInterval(timer);
      samples.push(read());
      const card = document.querySelector('[data-iss-launch-card]');
      const name = card?.querySelector('[data-iss-launch-name]');
      const line = card?.querySelector('[data-iss-launch-visibility]');
      const time = card?.querySelector('[data-iss-launch-time]');
      if (time instanceof HTMLElement) time.scrollTop = time.scrollHeight;
      const cardBox = card?.getBoundingClientRect();
      const seen = (el) => {
        if (!(el instanceof HTMLElement) || !cardBox) return false;
        const box = el.getBoundingClientRect();
        return box.height >= 4 && box.top >= cardBox.top - 1 && box.bottom <= cardBox.bottom + 1;
      };
      resolve({
        samples,
        place: read(),
        nameSeen: seen(name),
        lineSeen: seen(line),
      });
    }, 3000);
  }))()`);
  const places = Array.isArray(held?.samples) ? held.samples : [];
  if (new Set(places).size !== 1) {
    throw new Error(`${label} placement flipped ${JSON.stringify(places)}`);
  }
  if (!held?.nameSeen || !held?.lineSeen) {
    throw new Error(`${label} name or visibility left the card after scroll ${JSON.stringify(held)}`);
  }
  return held;
}

export const SIDE_COLUMN_REACH = `(() => {
  const column = document.querySelector('[data-iss-side]');
  const scene = document.querySelector('[data-iss-scene]');
  const frame = document.querySelector('[data-iss-frame]');
  const details = document.querySelector('[data-iss-details]');
  const summary = details?.querySelector('summary');
  if (!column || !scene || !frame || scene.getAttribute('data-iss-side-dock') !== 'on') return { step: 'dock' };
  if (document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') !== 'true') return null;
  if (!details || details.hidden || !summary || summary.textContent !== 'Details') return null;
  const earthNow = () => frame.getBoundingClientRect();
  const frameBox = earthNow();
  if (frameBox.width < 240 || frameBox.height < 160) {
    return { step: 'earth', width: Math.round(frameBox.width), height: Math.round(frameBox.height) };
  }
  if (scene.scrollHeight !== scene.clientHeight || scene.scrollWidth !== scene.clientWidth) {
    return { step: 'scene-scroll', height: [scene.scrollHeight, scene.clientHeight], width: [scene.scrollWidth, scene.clientWidth] };
  }
  const overflowY = getComputedStyle(column).overflowY;
  const sels = ['[data-iss-launch-name]', '[data-iss-launch-visibility]', '[data-iss-houston]', '[data-iss-day-month]', '[data-iss-weekday]', '[data-iss-edition]', '[data-iss-status]', '[data-iss-details] summary'];
  const sample = (el) => {
    const box = el.getBoundingClientRect();
    const port = column.getBoundingClientRect();
    const visible = Math.max(0, Math.min(box.bottom, port.bottom) - Math.max(box.top, port.top));
    return { visible, height: box.height, top: box.top, portTop: port.top, portHeight: port.height };
  };
  const fits = (el) => {
    const reading = sample(el);
    return reading.height > 1 && reading.visible >= reading.height - 1;
  };
  const reveal = (el) => {
    if (fits(el)) return { ok: true, ...sample(el) };
    if (overflowY !== 'auto' && overflowY !== 'scroll') return { ok: false, ...sample(el), overflowY };
    const before = sample(el);
    const max = Math.max(0, column.scrollHeight - column.clientHeight);
    const alignTop = Math.max(0, Math.min(max, column.scrollTop + (before.top - before.portTop)));
    column.scrollTop = alignTop;
    if (fits(el)) return { ok: true, ...sample(el) };
    if (before.height <= before.portHeight + 1) return { ok: false, ...sample(el), overflowY };
    const mid = sample(el);
    const alignBottom = Math.max(0, Math.min(max, column.scrollTop + (mid.top + mid.height - (mid.portTop + mid.portHeight))));
    column.scrollTop = alignBottom;
    const end = sample(el);
    const bottomIn = end.visible > 1 && end.top + end.height <= end.portTop + end.portHeight + 1;
    column.scrollTop = alignTop;
    const start = sample(el);
    const topIn = start.visible > 1 && start.top >= start.portTop - 1;
    return { ok: topIn && bottomIn, ...start, overflowY };
  };
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el || !column.contains(el)) return { step: 'missing', sel };
    const reached = reveal(el);
    if (!reached.ok) {
      return {
        step: 'clipped',
        sel,
        visible: Math.round(reached.visible * 100) / 100,
        height: Math.round(reached.height * 100) / 100,
        overflowY,
      };
    }
  }
  if (!reveal(summary).ok) return { step: 'details-reach' };
  const box = summary.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + Math.min(28, box.width / 2), box.top + box.height / 2);
  if (!hit || (hit !== summary && !summary.contains(hit))) {
    return { step: 'details-hit', tag: hit ? hit.tagName : null, text: hit ? (hit.textContent || '').slice(0, 40) : null };
  }
  const after = earthNow();
  if (after.width < 240 || after.height < 160) {
    return { step: 'earth', width: Math.round(after.width), height: Math.round(after.height) };
  }
  if (scene.scrollHeight !== scene.clientHeight || scene.scrollWidth !== scene.clientWidth) {
    return { step: 'scene-scroll', height: [scene.scrollHeight, scene.clientHeight], width: [scene.scrollWidth, scene.clientWidth] };
  }
  column.scrollTop = 0;
  return { ok: true, earth: [Math.round(after.width), Math.round(after.height)], overflowY };
})()`;

async function setSimulatedInsets(send, insets) {
  await evaluate(send, `(() => {
    document.getElementById('opd-side-inset')?.remove();
    const insets = ${insets ? JSON.stringify(insets) : 'null'};
    if (insets) {
      const swap = (text) => text
        .replaceAll('env(safe-area-inset-top, 0px)', insets.top + 'px')
        .replaceAll('env(safe-area-inset-right, 0px)', insets.right + 'px')
        .replaceAll('env(safe-area-inset-bottom, 0px)', insets.bottom + 'px')
        .replaceAll('env(safe-area-inset-left, 0px)', insets.left + 'px')
        .replaceAll('env(safe-area-inset-top)', insets.top + 'px')
        .replaceAll('env(safe-area-inset-right)', insets.right + 'px')
        .replaceAll('env(safe-area-inset-bottom)', insets.bottom + 'px')
        .replaceAll('env(safe-area-inset-left)', insets.left + 'px');
      const chunks = [];
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = [...sheet.cssRules]; } catch { continue; }
        for (const rule of rules) {
          if (rule.cssText && rule.cssText.includes('safe-area-inset')) chunks.push(swap(rule.cssText));
        }
      }
      const style = document.createElement('style');
      style.id = 'opd-side-inset';
      style.textContent = chunks.join('\\n');
      document.head.append(style);
    }
    window.dispatchEvent(new Event('resize'));
    return true;
  })()`);
}

async function setLaunchNameLines(send, lines) {
  await evaluate(send, `(() => {
    const name = document.querySelector('[data-iss-launch-name]');
    if (!(name instanceof HTMLElement)) return false;
    name.style.width = '';
    name.style.maxWidth = ${lines > 1 ? "'9ch'" : "''"};
    return true;
  })()`);
  if (lines < 2) return;
  await waitFor(
    send,
    `(() => {
      const name = document.querySelector('[data-iss-launch-name]');
      if (!(name instanceof HTMLElement)) return null;
      const range = document.createRange();
      range.selectNodeContents(name);
      const count = range.getClientRects().length;
      if (count < 2) return { step: 'name-lines', count };
      return { ok: true, count };
    })()`,
    'iss side column two-line name',
    10000,
  );
}

async function proveSideColumnMatrix(send, pane) {
  const cases = [
    { lines: 1, insets: null, label: 'one line' },
    { lines: 1, insets: { top: 0, left: 59, right: 59, bottom: 21 }, label: 'one line inset 59' },
    { lines: 2, insets: null, label: 'two lines' },
    { lines: 2, insets: { top: 0, left: 59, right: 59, bottom: 21 }, label: 'two lines inset 59' },
  ];
  for (const item of cases) {
    await setSimulatedInsets(send, item.insets);
    await setLaunchNameLines(send, item.lines);
    await waitFor(send, SIDE_COLUMN_REACH, `iss side column ${pane.label} ${item.label}`, 10000);
  }
}

async function provePhoneLandscapeTelemetry(send, pane) {
  const floor = `(() => {
    const earth = (() => { ${LAUNCH_EARTH_CHECK} })();
    if (!earth || earth.ok !== true) return earth;
    if (earth.width < 240 || earth.height < 160) {
      return { step: 'earth', width: earth.width, height: earth.height, place: earth.place };
    }
    const name = document.querySelector('[data-iss-launch-name]');
    const line = document.querySelector('[data-iss-launch-visibility]');
    const nameBox = name instanceof HTMLElement ? name.getBoundingClientRect() : null;
    const lineBox = line instanceof HTMLElement ? line.getBoundingClientRect() : null;
    if (!name || !name.textContent.trim() || !nameBox || nameBox.height < 4 || nameBox.width < 8) return { step: 'name' };
    if (!line || !line.textContent.trim() || !lineBox || lineBox.height < 4 || lineBox.width < 8) return { step: 'visibility-line' };
    return earth;
  })()`;
  await click(send, '[data-iss-telemetry]');
  try {
    await waitFor(send, floor, `iss launch earth ${pane.label} telemetry open`, 10000);
    await proveSideColumnMatrix(send, pane);
  } finally {
    await setSimulatedInsets(send, null);
    await setLaunchNameLines(send, 1);
    await evaluate(send, `(() => { const column = document.querySelector('[data-iss-side]'); if (column) column.scrollTop = 0; return true; })()`);
    const expanded = await evaluate(send, `document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded')`);
    if (expanded === 'true') await click(send, '[data-iss-telemetry]');
  }
  await waitFor(
    send,
    `document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') === 'false' ? { ok: true } : null`,
    `iss launch earth ${pane.label} telemetry collapsed`,
    10000,
  );
  await waitFor(send, floor, `iss launch earth ${pane.label} telemetry closed`, 10000);
}

async function proveLaunchEarthPanes(send, evidenceDir) {
  const size = await evaluate(send, `({ width: window.innerWidth, height: window.innerHeight })`);
  const startFloor = phoneLandscapeFloor(size.width, size.height);
  const panes = launchEarthPanes(size.width, size.height);
  const mobile = size.width < 1100;
  const held = [];
  try {
    for (const pane of panes) {
      if (pane.sceneBox) await setIssSceneBox(send, pane.width, pane.height, pane.mobile);
      else await setLayoutViewport(send, pane.width, pane.height, pane.mobile);
      await evaluate(send, `(() => {
        const name = document.querySelector('[data-iss-launch-name]');
        if (!(name instanceof HTMLElement)) return false;
        if (!${pane.twoLine ? 'true' : 'false'}) {
          name.style.maxWidth = '';
          name.style.width = '';
          return true;
        }
        name.style.width = '';
        name.style.maxWidth = '9ch';
        return true;
      })()`);
      const earth = await waitFor(
        send,
        `(() => {
          const scene = document.querySelector('[data-iss-scene]');
          const laid = ${pane.sceneBox ? 'true' : 'false'}
            ? scene && scene.clientWidth === ${pane.width} && scene.clientHeight === ${pane.height}
            : document.documentElement.clientWidth === ${pane.width} && document.documentElement.clientHeight === ${pane.height};
          if (!laid) return { step: 'viewport', width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, scene: scene ? [scene.clientWidth, scene.clientHeight] : null };
          ${EARTH_AFTER_RESIZE}
          const earth = (() => { ${LAUNCH_EARTH_CHECK} })();
          if (!earth || earth.ok !== true) return earth;
          const allowed = ${JSON.stringify(pane.places || (pane.place ? [pane.place] : []))};
          if (allowed.length && !allowed.includes(earth.place)) {
            return { step: 'place', place: earth.place, width: earth.width, height: earth.height };
          }
          const shortFloor = earth.place === 'below' ? ${pane.belowMinShort ?? pane.minShort} : ${pane.minShort};
          if (Math.min(earth.width, earth.height) < shortFloor) {
            return { step: 'earth', width: earth.width, height: earth.height, place: earth.place, minShort: shortFloor };
          }
          if (${pane.minWidth || 0} > 0 && (earth.width < ${pane.minWidth || 0} || earth.height < ${pane.minHeight || 0})) {
            return { step: 'earth', width: earth.width, height: earth.height, place: earth.place, minWidth: ${pane.minWidth || 0}, minHeight: ${pane.minHeight || 0} };
          }
          if (${pane.twoLine ? 'true' : 'false'}) {
            const name = document.querySelector('[data-iss-launch-name]');
            const range = document.createRange();
            if (name) range.selectNodeContents(name);
            const lines = name ? range.getClientRects().length : 0;
            if (lines < 2) return { step: 'name-lines', lines, height: name ? Math.round(name.getBoundingClientRect().height) : 0, max: name instanceof HTMLElement ? name.style.maxWidth : '', place: earth.place };
          }
          return earth;
        })()`,
        `iss launch earth ${pane.label}`,
        10000,
      );
      const heldCard = await proveLaunchCardHolds(send, pane.label);
      if (pane.label === '844x390' || pane.label === '874x402' || pane.label === '721x390') await provePhoneLandscapeTelemetry(send, pane);
      if (pane.twoLine) {
        const wrapped = await evaluate(send, `(() => {
          const name = document.querySelector('[data-iss-launch-name]');
          const range = document.createRange();
          if (name) range.selectNodeContents(name);
          const lines = name ? range.getClientRects().length : 0;
          const box = name ? name.getBoundingClientRect() : null;
          return { lines, height: box ? Math.round(box.height) : 0, max: name instanceof HTMLElement ? name.style.maxWidth : '' };
        })()`);
        if (!wrapped || wrapped.lines < 2) {
          throw new Error(`${pane.label} name unwrapped after the hold ${JSON.stringify(wrapped)}`);
        }
      }
      if (pane.label !== `${size.width}x${size.height}` || pane.label === '390x664' || pane.twoLine) {
        await shot(send, evidenceDir, `iss-launch-earth-${pane.label}`);
      }
      held.push(`${pane.label} ${earth.width}x${earth.height} ${earth.place} ${earth.mark} held ${heldCard.place}`);
    }
  } finally {
    await evaluate(send, `(() => {
      const name = document.querySelector('[data-iss-launch-name]');
      if (name instanceof HTMLElement) {
        name.style.maxWidth = '';
        name.style.width = '';
      }
      return true;
    })()`);
    await setLayoutViewport(send, size.width, size.height, mobile);
  }
  const restored = await waitForStable(
    send,
    `(() => {
      const earth = (() => { ${LAUNCH_EARTH_CHECK} })();
      if (!earth || earth.ok !== true) return earth;
      if (${startFloor ? startFloor.minWidth : 0} > 0 && (earth.width < ${startFloor ? startFloor.minWidth : 0} || earth.height < ${startFloor ? startFloor.minHeight : 0})) {
        return { step: 'earth', width: earth.width, height: earth.height, minWidth: ${startFloor ? startFloor.minWidth : 0}, minHeight: ${startFloor ? startFloor.minHeight : 0} };
      }
      const stage = document.querySelector('[data-iss-stage]');
      const frame = document.querySelector('[data-iss-frame]');
      const canvas = frame?.querySelector('canvas');
      const controls = document.querySelector('[data-iss-controls]');
      const scene = document.querySelector('[data-iss-scene]');
      if (!stage || !frame || !canvas || !controls || !scene) return { step: 'stage' };
      const stageBox = stage.getBoundingClientRect();
      const frameBox = frame.getBoundingClientRect();
      const canvasBox = canvas.getBoundingClientRect();
      const controlsBox = controls.getBoundingClientRect();
      const sceneBox = scene.getBoundingClientRect();
      if (Math.abs(stageBox.height - frameBox.height) > 1 || Math.abs(stageBox.height - canvasBox.height) > 1) {
        return { step: 'stage', stage: Math.round(stageBox.height), frame: Math.round(frameBox.height), canvas: Math.round(canvasBox.height), inline: stage.style.height, min: getComputedStyle(stage).minHeight };
      }
      if (scene.scrollHeight > scene.clientHeight + 1) {
        return { step: 'scroll', height: [scene.scrollHeight, scene.clientHeight] };
      }
      const splitOn = scene.getAttribute('data-iss-split') === 'on';
      const paneBox = document.getElementById('iss-pane')?.getBoundingClientRect();
      const mapBox = document.querySelector('[data-pip="plan"]')?.getBoundingClientRect();
      const hostLeft = document.getElementById('iss-host')?.getBoundingClientRect().left;
      const controlsHome = !splitOn
        ? controlsBox.bottom <= sceneBox.bottom + 1
        : !!(paneBox && hostLeft != null && controlsBox.top >= paneBox.top - 1 && controlsBox.bottom <= paneBox.bottom + 1 && controlsBox.right <= hostLeft + 2 && (!(mapBox && mapBox.height > 40) || controlsBox.top >= mapBox.bottom - 1));
      if (!controlsHome) {
        return { step: 'controls', top: Math.round(controlsBox.top), bottom: Math.round(controlsBox.bottom), sceneBottom: Math.round(sceneBox.bottom), scrollTop: scene.scrollTop, scrollY: window.scrollY };
      }
      return {
        ...earth,
        stage: Math.round(stageBox.height),
        frame: Math.round(frameBox.height),
        canvas: Math.round(canvasBox.height),
        scrollHeight: scene.scrollHeight,
        clientHeight: scene.clientHeight,
        controlsBottom: Math.round(controlsBox.bottom),
        sceneBottom: Math.round(sceneBox.bottom),
      };
    })()`,
    `iss launch earth restored ${size.width}x${size.height}`,
    12000,
  );
  return `${held.join(', ')}; restored ${restored.stage}x${restored.frame} scroll ${restored.scrollHeight}/${restored.clientHeight} controls ${restored.controlsBottom} scene ${restored.sceneBottom}`;
}

function fixtureInstant(evidenceDir) {
  let dir = evidenceDir;
  for (let step = 0; step < 4; step += 1) {
    const path = resolve(dir, 'fixtures/meta.json');
    const clockPath = resolve(dir, 'fixtures/catalog-clock.json');
    if (existsSync(clockPath)) {
      const anchor = JSON.parse(readFileSync(clockPath, 'utf8')).anchor;
      if (typeof anchor === 'number' && Number.isFinite(anchor)) return anchor;
    }
    if (existsSync(path)) {
      const now = JSON.parse(readFileSync(path, 'utf8')).now;
      if (typeof now === 'number' && Number.isFinite(now)) return now;
    }
    dir = dirname(dir);
  }
  throw new Error('verify fixture meta missing');
}

async function armCatalogHold(baseUrl) {
  const armed = await fetch(`${baseUrl}/api/verify/catalog-hold`, { method: 'POST' });
  if (!armed.ok) throw new Error(`catalog hold ${armed.status}`);
  return armed.json();
}

async function nudgeUntilCatalogPending(send, baseUrl) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    await nudgeCatalogRefresh(send);
    const status = await fetch(`${baseUrl}/api/verify/catalog-hold`).then((response) => response.json());
    if (status.pending) return;
    await sleep(250);
  }
  throw new Error('iss tier pick pending catalog body timed out');
}

async function releaseCatalogHold(baseUrl) {
  const released = await fetch(`${baseUrl}/api/verify/catalog-release`, { method: 'POST' });
  if (!released.ok) throw new Error(`catalog release ${released.status}`);
}

async function nudgeCatalogRefresh(send) {
  await evaluate(send, `(() => {
    const picker = document.querySelector('[data-iss-launch-picker]');
    if (picker instanceof HTMLSelectElement) picker.focus();
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  })()`);
}

async function withHeldCatalog(send, baseUrl, body) {
  await armCatalogHold(baseUrl);
  try {
    await nudgeUntilCatalogPending(send, baseUrl);
    await body();
  } finally {
    await releaseCatalogHold(baseUrl);
  }
}

async function chooseIssLaunch(send, value) {
  await evaluate(send, `(() => {
    const picker = document.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) return false;
    picker.focus();
    picker.value = ${JSON.stringify(value)};
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    return picker.value;
  })()`);
}

const pendingNone = `(() => {
  const picker = document.querySelector('[data-iss-launch-picker]');
  const card = document.querySelector('[data-iss-launch-card]');
  const frame = document.querySelector('[data-iss-frame]');
  if (!(picker instanceof HTMLSelectElement) || !card || !frame) return null;
  if (picker.value !== '') return null;
  if (!card.hidden) return null;
  if (frame.getAttribute('data-iss-launch-corridor') === 'on') return null;
  const shot = [...picker.querySelectorAll('optgroup')].find((entry) => entry.label === 'Shot');
  if (!shot || ![...shot.querySelectorAll('option')].some((entry) => entry.value === 'verify-ascent')) return null;
  if (document.activeElement !== picker) return null;
  return { ok: true };
})()`;

const acceptedLikely = `(() => {
  const picker = document.querySelector('[data-iss-launch-picker]');
  const card = document.querySelector('[data-iss-launch-card]');
  const frame = document.querySelector('[data-iss-frame]');
  if (!(picker instanceof HTMLSelectElement) || !card || !frame) return null;
  if (picker.value !== 'verify-likely') return null;
  if (card.hidden) return null;
  if (card.querySelector('[data-iss-launch-name]')?.textContent !== 'Verify Likely') return null;
  if (frame.getAttribute('data-iss-launch-corridor') === 'on') return null;
  if (document.activeElement !== picker) return null;
  return { ok: true };
})()`;

async function proveCatalogTierIntent(send, baseUrl) {
  await withHeldCatalog(send, baseUrl, async () => {
    await waitFor(
      send,
      `(() => {
        const picker = document.querySelector('[data-iss-launch-picker]');
        const card = document.querySelector('[data-iss-launch-card]');
        const frame = document.querySelector('[data-iss-frame]');
        if (!(picker instanceof HTMLSelectElement) || !card || !frame) return null;
        if (picker.value !== 'verify-ascent') return null;
        if (!card.hidden) return null;
        if (frame.getAttribute('data-iss-launch-corridor') === 'on') return null;
        if (document.activeElement !== picker) return null;
        return { ok: true };
      })()`,
      'iss tier pick pending catalog body',
      15000,
    );
  });
  await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      const card = document.querySelector('[data-iss-launch-card]');
      const frame = document.querySelector('[data-iss-frame]');
      if (!(picker instanceof HTMLSelectElement) || !card || !frame) return null;
      if (picker.value !== 'verify-ascent') return null;
      if (card.hidden) return null;
      if (card.querySelector('[data-iss-launch-name]')?.textContent !== 'Verify Ascent') return null;
      if (frame.getAttribute('data-iss-launch-corridor') !== 'on') return null;
      if (document.activeElement !== picker) return null;
      return { ok: true };
    })()`,
    'iss tier pick restored after catalog body',
    20000,
  );
  await withHeldCatalog(send, baseUrl, async () => {
    await chooseIssLaunch(send, 'none');
    await waitFor(send, pendingNone, 'iss pending none replaces tier intent', 15000);
  });
  await waitFor(send, pendingNone, 'iss none kept after catalog body', 20000);
  await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      if (!(picker instanceof HTMLSelectElement)) return null;
      const shot = [...picker.querySelectorAll('optgroup')].find((entry) => entry.label === 'Shot');
      const option = shot && [...shot.querySelectorAll('option')].find((entry) => entry.value === 'verify-ascent');
      if (!option) return null;
      return { ok: true };
    })()`,
    'iss tier menu after pending none',
    15000,
  );
  await evaluate(send, `(() => {
    const picker = document.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) return false;
    picker.value = 'verify-ascent';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    picker.focus();
    return picker.value;
  })()`);
  await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      const card = document.querySelector('[data-iss-launch-card]');
      const frame = document.querySelector('[data-iss-frame]');
      if (!(picker instanceof HTMLSelectElement) || !card || !frame) return null;
      if (picker.value !== 'verify-ascent' || card.hidden) return null;
      if (frame.getAttribute('data-iss-launch-corridor') !== 'on') return null;
      return { ok: true };
    })()`,
    'iss tier pick rearmed',
    15000,
  );
  await withHeldCatalog(send, baseUrl, async () => {
    await chooseIssLaunch(send, 'verify-likely');
    await waitFor(
      send,
      `(() => {
        const picker = document.querySelector('[data-iss-launch-picker]');
        const card = document.querySelector('[data-iss-launch-card]');
        const frame = document.querySelector('[data-iss-frame]');
        if (!(picker instanceof HTMLSelectElement) || !card || !frame) return null;
        if (picker.value !== 'verify-likely') return null;
        if (!card.hidden) return null;
        if (frame.getAttribute('data-iss-launch-corridor') === 'on') return null;
        if (document.activeElement !== picker) return null;
        return { ok: true };
      })()`,
      'iss pending other launch replaces tier intent',
      15000,
    );
  });
  await waitFor(send, acceptedLikely, 'iss other launch kept after catalog body', 20000);
  await chooseIssLaunch(send, 'verify-ascent');
  await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      const card = document.querySelector('[data-iss-launch-card]');
      const frame = document.querySelector('[data-iss-frame]');
      if (!(picker instanceof HTMLSelectElement) || !card || !frame) return null;
      if (picker.value !== 'verify-ascent' || card.hidden) return null;
      if (frame.getAttribute('data-iss-launch-corridor') !== 'on') return null;
      return { ok: true };
    })()`,
    'iss tier pick rearmed before none then later',
    15000,
  );
  await withHeldCatalog(send, baseUrl, async () => {
    await chooseIssLaunch(send, 'none');
    await waitFor(send, pendingNone, 'iss pending none before later launch', 15000);
    await chooseIssLaunch(send, 'verify-likely');
    await waitFor(
      send,
      `(() => {
        const picker = document.querySelector('[data-iss-launch-picker]');
        const card = document.querySelector('[data-iss-launch-card]');
        const frame = document.querySelector('[data-iss-frame]');
        if (!(picker instanceof HTMLSelectElement) || !card || !frame) return null;
        if (picker.value !== 'verify-likely') return null;
        if (!card.hidden) return null;
        if (frame.getAttribute('data-iss-launch-corridor') === 'on') return null;
        if (document.activeElement !== picker) return null;
        return { ok: true };
      })()`,
      'iss pending none then later launch',
      15000,
    );
  });
  await waitFor(send, acceptedLikely, 'iss later launch kept after pending none', 20000);
}

async function proveIssLaunchLook(send, evidenceDir, baseUrl) {
  await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      if (!(picker instanceof HTMLSelectElement) || picker.value !== '') return null;
      const groups = [...picker.querySelectorAll('optgroup')].map((entry) => entry.label);
      for (const name of ['Shot', 'Likely', 'Watch', 'All launches']) {
        if (!groups.includes(name)) return null;
      }
      const closed = picker.selectedOptions[0]?.textContent || '';
      if (!/^Verify Ascent · Shot · [A-Z][a-z]{2} \\d{1,2}$/.test(closed)) return null;
      return { ok: true, closed };
    })()`,
    'iss tier groups',
    20000,
  );
  const horizon = await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      if (!(picker instanceof HTMLSelectElement)) return null;
      const group = [...picker.querySelectorAll('optgroup')].find((entry) => entry.label === 'All launches');
      const option = group && [...group.querySelectorAll('option')].find((entry) => entry.textContent?.includes('Verify Horizon'));
      if (!option) return null;
      return { ok: true, value: option.value };
    })()`,
    'iss all launches group',
    15000,
  );
  await evaluate(send, `(() => {
    const picker = document.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) return false;
    picker.value = ${JSON.stringify(horizon.value)};
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    return picker.value;
  })()`);
  await waitFor(
    send,
    `(() => {
      const card = document.querySelector('[data-iss-launch-card]');
      const frame = document.querySelector('[data-iss-frame]');
      if (!card || card.hasAttribute('hidden') || !frame) return null;
      if (card.dataset.issLaunchGroup !== 'all') return null;
      if (card.querySelector('[data-iss-launch-name]')?.textContent !== 'Verify Horizon') return null;
      const text = card.textContent || '';
      if (/possible|chance/i.test(text)) return null;
      if (frame.getAttribute('data-iss-launch-corridor') === 'on') return null;
      return { ok: true };
    })()`,
    'iss all launches schedule only',
    15000,
  );
  await shot(send, evidenceDir, 'iss-all-launches');
  const frozen = fixtureInstant(evidenceDir);
  await evaluate(send, `(() => {
    window.__opdRealNow = Date.now;
    const frozen = ${frozen};
    Date.now = () => frozen;
    return true;
  })()`);
  try {
  await click(send, '[data-iss-preset="nadir"]');
  await waitFor(
    send,
    `(() => {
      const pressed = document.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed') === 'true';
      const card = document.querySelector('[data-iss-launch-card]');
      const name = card?.querySelector('[data-iss-launch-name]')?.textContent ?? null;
      const visibility = card?.querySelector('[data-iss-launch-visibility]')?.textContent ?? null;
      const pin = !!document.querySelector('.iss-launch-pin');
      const edge = !!document.querySelector('[data-iss-launch-edge]');
      const look = document.querySelector('[data-iss-launch-label]')?.textContent ?? null;
      const status = document.querySelector('[data-iss-status]')?.textContent ?? null;
      if (!pressed || name !== 'Verify Horizon' || !pin) {
        return { pressed, name, visibility, pin, edge, look, status: status && status.slice(0, 180) };
      }
      return { ok: true };
    })()`,
    'iss all launches pin in frame',
    15000,
  );
  const aimBeforePin = await evaluate(send, `(() => {
    const center = window.__opdIss?.getCenter?.();
    return center ? { ok: true, lat: center.lat, lng: center.lng } : null;
  })()`);
  if (!aimBeforePin?.lat && aimBeforePin?.lat !== 0) throw new Error('iss all launches pin has no center');
  await click(send, '.iss-launch-pin');
  await waitFor(
    send,
    `(() => {
      const card = document.querySelector('[data-iss-launch-card]');
      const center = window.__opdIss?.getCenter?.();
      if (!card || card.dataset.issLaunchGroup !== 'all') return null;
      if (card.querySelector('[data-iss-launch-name]')?.textContent !== 'Verify Horizon') return null;
      if (!center) return null;
      const moved = Math.abs(center.lat - ${aimBeforePin.lat}) + Math.abs(center.lng - ${aimBeforePin.lng});
      if (moved < 0.15) return null;
      return { ok: true };
    })()`,
    'iss all launches pin',
    15000,
  );
  await shot(send, evidenceDir, 'iss-all-launches-pin');
  } finally {
    await evaluate(send, `(() => { if (window.__opdRealNow) Date.now = window.__opdRealNow; return true; })()`);
  }
  await evaluate(send, `(() => {
    const picker = document.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) return false;
    picker.value = 'none';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    return picker.value;
  })()`);
  const before = await waitFor(
    send,
    `(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      const telemetry = document.querySelector('[data-iss-telemetry]');
      const frame = document.querySelector('[data-iss-frame]');
      if (!(picker instanceof HTMLSelectElement) || !telemetry || !frame) return null;
      const shotGroup = [...picker.querySelectorAll('optgroup')].find((entry) => entry.label === 'Shot');
      const option = shotGroup && [...shotGroup.querySelectorAll('option')].find((entry) => entry.textContent?.includes('Verify Ascent'));
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
      const scene = document.querySelector('[data-iss-scene]');
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
      if (scene?.getAttribute('data-iss-split') === 'on' && window.innerWidth === 834 && window.innerHeight === 1194) {
        const pickerBox = picker.getBoundingClientRect();
        const helpBox = document.querySelector('[data-iss-snap-help]')?.getBoundingClientRect();
        const siteBox = button.getBoundingClientRect();
        const mid = (box) => (box.top + box.bottom) / 2;
        if (!helpBox || Math.abs(mid(pickerBox) - mid(helpBox)) > 4 || Math.abs(mid(pickerBox) - mid(siteBox)) > 4) {
          return { step: 'launch-row', width: window.innerWidth, height: window.innerHeight, picker: pickerBox.top, help: helpBox ? helpBox.top : null, site: siteBox.top };
        }
      }
      const earth = (() => { ${LAUNCH_EARTH_CHECK} })();
      if (!earth || earth.ok !== true) return earth;
      const visibility = earth.visibility;
      const center = window.__opdIss?.getCenter?.();
      if (!center) return null;
      const moved = Math.hypot(center.lng - ${Number(before.lng)}, center.lat - ${Number(before.lat)});
      if (!(moved < 0.15)) return null;
      return { ok: true, lng: center.lng, lat: center.lat, name, site, timeLabel, timeValue, visibility, held: moved };
    })()`,
    'iss launch selected',
    15000,
  );
  const earthPanes = await proveLaunchEarthPanes(send, evidenceDir);
  const siteShot = await revealInView(send, '[data-iss-launch]');
  if (!siteShot.text.includes('Look toward Verify Pad')) {
    throw new Error(`site button shot would miss the label ${JSON.stringify(siteShot)}`);
  }
  await shot(send, evidenceDir, 'iss-launch-site');
  const cardShot = await revealInView(send, '[data-iss-launch-card]');
  const visibilityNow = ['Site in frame', 'Site outside frame', 'Site below horizon'].find((line) => cardShot.text.includes(line));
  if (!cardShot.text.includes(selected.name) || !cardShot.text.includes(selected.site) || !visibilityNow || !cardShot.text.includes(selected.timeLabel)) {
    throw new Error(`launch card shot would miss the facts ${JSON.stringify({ ...cardShot, visibilityNow: visibilityNow || null })}`);
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
      const button = document.querySelector('[data-iss-launch]');
      if (!(picker instanceof HTMLSelectElement) || !card || card.hidden || !button) return null;
      if (picker.value !== ${JSON.stringify(before.value)}) return null;
      if (card.querySelector('[data-iss-launch-name]')?.textContent !== 'Verify Ascent') return null;
      if ((card.textContent || '').includes('Selected launch is no longer available')) return null;
      if (button.querySelector('[data-iss-launch-label]')?.textContent !== 'Look toward Verify Pad') return null;
      const frame = document.querySelector('[data-iss-frame]');
      if (frame?.getAttribute('data-iss-launch-corridor') !== 'on') return null;
      const center = window.__opdIss?.getCenter?.();
      if (!center) return null;
      const drifted = Math.hypot(center.lng - ${Number(aimed.lng)}, center.lat - ${Number(aimed.lat)});
      if (!(drifted < 0.15)) return null;
      return { ok: true };
    })()`,
    'iss tier pick kept through empty v2 body',
    20000,
  );
  const keptShot = await revealInView(send, '[data-iss-launch-card]');
  if (!keptShot.text.includes('Verify Ascent') || keptShot.text.includes('Selected launch is no longer available')) {
    throw new Error(`tier pick should stay after the empty v2 body ${JSON.stringify(keptShot)}`);
  }
  await shot(send, evidenceDir, 'iss-launch-lost');
  await evaluate(send, `document.cookie = 'opd-verify-launch=back; path=/'`);
  await waitFor(
    send,
    `(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      const picker = document.querySelector('[data-iss-launch-picker]');
      const card = document.querySelector('[data-iss-launch-card]');
      if (!(picker instanceof HTMLSelectElement) || !card || card.hidden) return null;
      const ascent = [...picker.querySelectorAll('optgroup')].find((entry) => entry.label === 'Shot');
      const option = ascent && [...ascent.querySelectorAll('option')].find((entry) => entry.textContent?.includes('Verify Ascent'));
      if (!option || !option.selected) return null;
      if (picker.value !== ${JSON.stringify(before.value)}) return null;
      if ((card.textContent || '').includes('Selected launch is no longer available')) return null;
      const frame = document.querySelector('[data-iss-frame]');
      if (frame?.getAttribute('data-iss-launch-corridor') !== 'on') return null;
      return { ok: true };
    })()`,
    'iss launch returned',
    20000,
  );
  await proveCatalogTierIntent(send, baseUrl);
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
      const closed = picker.selectedOptions[0]?.textContent || '';
      if (!/^Verify Ascent · Shot · [A-Z][a-z]{2} \\d{1,2}$/.test(closed)) return null;
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
      const closed = picker.selectedOptions[0]?.textContent || '';
      if (picker.value !== '' || !/^Verify Ascent · Shot · [A-Z][a-z]{2} \\d{1,2}$/.test(closed)) return null;
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
  if (!/^Verify Ascent · Shot · [A-Z][a-z]{2} \d{1,2}$/.test(chooseLabel)) throw new Error(`reload shot missed the tier label ${JSON.stringify({ choose, chooseLabel })}`);
  await shot(send, evidenceDir, 'iss-launch-reloaded');
  return `${selected.name} / ${selected.site} / ${selected.timeLabel} ${selected.timeValue} / ${selected.visibility} / aim held ${Number(selected.held).toFixed(3)}° / earth ${earthPanes} / ${menuNote}; selection held across a UTC tick / launch held while verifyrev-hold downloaded / tier pick kept through the empty v2 body / v2 republish left the Shot selected / catalog body restored the Shot / pending none kept / pending likely replaced the Shot / pending none then likely kept / None / reload ${chooseLabel}`;
}

async function proveIssOpticalFov(send, evidenceDir) {
  const before = await waitFor(
    send,
    `(() => {
      if (window.__opdFovWatch && window.__opdFovWatch.bad) {
        throw new Error('live fov before the camera ' + JSON.stringify(window.__opdFovWatch.bad));
      }
      const scene = document.querySelector('[data-iss-scene]');
      const label = document.querySelector('[data-iss-fov]');
      const map = window.__opdIss;
      const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
      if (!scene || !label || !map?.getVerticalFieldOfView || !map.getZoom || !map.getRoll || !frame || frame.width < 40) return null;
      const fov = map.getVerticalFieldOfView();
      const zoom = map.getZoom();
      const roll = ((map.getRoll() % 360) + 360) % 360;
      const text = (label.textContent || '').trim();
      const shown = Number.parseFloat(text);
      if (scene.getAttribute('data-iss-phase') !== 'running') return null;
      if (label.getAttribute('data-iss-fov-state') === 'live') {
        if (!text || !Number.isFinite(fov) || !Number.isFinite(shown) || Math.abs(shown - fov) > 0.15 || Math.abs(roll - 180) > 0.5) {
          throw new Error('live fov does not match the camera ' + JSON.stringify({ text, fov, shown, roll }));
        }
      }
      if (label.getAttribute('data-iss-fov-state') !== 'live') return null;
      if (!Number.isFinite(fov) || !Number.isFinite(shown)) return null;
      if (Math.abs(shown - fov) > 0.15) return null;
      if (Math.abs(roll - 180) > 0.5) return null;
      return {
        ok: true,
        x: frame.left + frame.width / 2,
        y: frame.top + frame.height / 2,
        fov,
        zoom,
        roll,
        shown,
      };
    })()`,
    'iss fov ready',
    15000,
  );
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
  await armIssFovWatch(send);
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
  const before = await waitFor(
    send,
    `(() => {
      if (window.__opdFovWatch && window.__opdFovWatch.bad) {
        throw new Error('live fov before the camera ' + JSON.stringify(window.__opdFovWatch.bad));
      }
      const scene = document.querySelector('[data-iss-scene]');
      const map = window.__opdIss;
      const label = document.querySelector('[data-iss-fov]');
      if (!scene || !map?.getCenter || !map.getVerticalFieldOfView || !map.getRoll || !label) return null;
      if (scene.getAttribute('data-iss-phase') !== 'running') return null;
      if (label.getAttribute('data-iss-fov-state') !== 'live') return null;
      const text = (label.textContent || '').trim();
      if (!text) return null;
      const center = map.getCenter();
      const fov = map.getVerticalFieldOfView();
      const roll = ((map.getRoll() % 360) + 360) % 360;
      const shown = Number.parseFloat(text);
      if (!Number.isFinite(fov) || !Number.isFinite(shown)) return null;
      if (Math.abs(shown - fov) > 0.15) return null;
      if (Math.abs(roll - 180) > 0.5) return null;
      return { ok: true, lat: center.lat, lng: center.lng, fov, shown, roll };
    })()`,
    'iss fov label before key',
    15000,
  );
  const labelBefore = { shown: before.shown };
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
  await armIssFovWatch(send);
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
      if (window.__opdFovWatch && window.__opdFovWatch.bad) {
        throw new Error('live fov before the camera ' + JSON.stringify(window.__opdFovWatch.bad));
      }
      const label = document.querySelector('[data-iss-fov]');
      const text = (label?.textContent || '').trim();
      if (!label || text.length === 0) return null;
      const shown = Number.parseFloat(text);
      if (!Number.isFinite(shown) || Math.abs(shown - ${aim.opticalFovDeg}) > 0.2) return null;
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
      const rows = [...menu.querySelectorAll('.profile-menu-item')].map((row) => ({
        text: row.textContent,
        current: row.getAttribute('aria-current'),
      }));
      if (rows.map((row) => row.text).join('|') !== 'Anil|Jessica Watkins (Watty)|Josh Kutryk|Luke Delaney') return null;
      if (rows[0]?.current !== 'true') return null;
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
      const edition = document.querySelector('[data-iss-edition]');
      if (!edition) return null;
      const editionVisibility = getComputedStyle(edition).visibility;
      if (editionVisibility !== 'hidden') return { step: 'edition-under-sheet', visibility: editionVisibility };
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
    const edition = document.querySelector('[data-iss-edition]');
    if (!edition || getComputedStyle(edition).visibility !== 'visible') return null;
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

const ISS_LANDSCAPE_PANES = [
  { width: 874, height: 402, insets: { top: 0, left: 62, bottom: 21, right: 62 }, shot: 'iss-landscape-telemetry' },
  { width: 844, height: 390, insets: { top: 0, left: 47, bottom: 21, right: 47 }, shot: 'iss-landscape-844x390-telemetry' },
];

const ISS_WIDE_TOOLBAR_EXPR = `(() => {
  if (window.innerWidth <= 720) return { ok: true, width: window.innerWidth };
  const toolbar = document.querySelector('[data-iss-toolbar]');
  const clock = document.querySelector('[data-iss-clock]');
  if (!toolbar || !clock) return null;
  if (toolbar.offsetHeight !== clock.offsetHeight) {
    return { step: 'toolbar-height', toolbar: toolbar.offsetHeight, clock: clock.offsetHeight, width: window.innerWidth };
  }
  return { ok: true, height: toolbar.offsetHeight, width: window.innerWidth };
})()`;

async function proveIssLandscape(send, evidenceDir) {
  const contained = `(() => {
    const hostBox = document.getElementById('iss-host')?.getBoundingClientRect();
    const scene = document.querySelector('[data-iss-scene]');
    const frame = document.querySelector('[data-iss-frame]')?.getBoundingClientRect();
    const card = document.querySelector('[data-iss-card]')?.getBoundingClientRect();
    const port = document.querySelector('[data-iss-port]')?.getBoundingClientRect();
    const starboard = document.querySelector('[data-iss-starboard]')?.getBoundingClientRect();
    if (!hostBox || !scene || !frame || !card || !port || !starboard) return null;
    if (frame.width < 240 || frame.height < 160) return { step: 'earth', width: frame.width, height: frame.height };
    if (${SCENE_SCROLLS}) return { step: 'scroll', height: [scene.scrollHeight, scene.clientHeight], width: [scene.scrollWidth, scene.clientWidth] };
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
  const held = [];
  try {
    for (const pane of ISS_LANDSCAPE_PANES) {
      await setViewport(send, pane.width, pane.height, true);
      for (const inset of [null, pane.insets]) {
        if (inset && !(await safeAreaOverride(send, inset))) {
          held.push(`${pane.width}x${pane.height} inset unsupported`);
          continue;
        }
        const label = `${pane.width}x${pane.height}${inset ? ' home inset' : ''}`;
        await waitFor(send, pipAbsentExpression('plan'), `plan inset absent in landscape ${label}`, 10000);
        await waitFor(send, contained, `iss landscape ${label} collapsed`, 10000);
        await waitFor(send, ISS_CLOCK_EXPR, `iss clock in landscape ${label}`, 10000);
        await waitFor(send, ISS_EDITION_EXPR, `iss edition in landscape ${label}`, 10000);
        await waitFor(send, ISS_WIDE_TOOLBAR_EXPR, `iss toolbar height in landscape ${label}`, 10000);
        await click(send, '[data-iss-telemetry]');
        const open = await waitFor(send, contained, `iss landscape ${label} telemetry open`, 10000);
        await waitFor(send, ISS_CLOCK_EXPR, `iss clock in landscape ${label} with telemetry open`, 10000);
        await waitFor(send, ISS_WIDE_TOOLBAR_EXPR, `iss toolbar height in landscape ${label} with telemetry open`, 10000);
        await sleep(1200);
        const after = await waitFor(send, contained, `iss landscape ${label} telemetry after ticks`, 10000);
        if (!inset) await shot(send, evidenceDir, pane.shot);
        await click(send, '[data-iss-telemetry]');
        await waitFor(
          send,
          `document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') === 'false' ? { ok: true } : null`,
          `iss landscape ${label} telemetry collapsed`,
          10000,
        );
        if (open.width < 240 || open.height < 160 || after.width < 240 || after.height < 160) {
          throw new Error(`iss landscape ${label} frame ${open.width}x${open.height} then ${after.width}x${after.height}`);
        }
        held.push(label);
      }
      await safeAreaOverride(send, { top: 0, left: 0, bottom: 0, right: 0 });
    }
  } finally {
    await safeAreaOverride(send, { top: 0, left: 0, bottom: 0, right: 0 });
  }
  return held.join(', ');
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
    'Chances for the next seven days come first',
    'All launches',
    '14 days',
    'That list is not limited to chances.',
    'Map and Upcoming list chances only',
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
  const legendPhrases = [
    'launch, day, twilight, and eclipse',
    "The ISS marker, Anil's targets, Starship, and your white rings are not rows.",
    'Starship is not a legend row',
  ];
  const legendMissing = legendPhrases.filter((phrase) => !String(helpText).includes(phrase));
  if (legendMissing.length) throw new Error(`help legend missing ${legendMissing.join(', ')}`);
  for (const gone of ['Starship: no public orbit yet', 'Starship: public orbit expired', 'Starship: orbit lookup failed']) {
    if (String(helpText).includes(gone)) throw new Error(`help legend brought back ${gone}`);
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

async function driveProfile(send, evidenceDir, meta, baseUrl, home, viewport) {
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
  await proveProfilePicker(send, evidenceDir, viewport, baseUrl);
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
  await waitFor(
    send,
    `(() => {
      const onMap = document.getElementById('view')?.className === 'view-map';
      const layer = window.__opdMap?.getLayer('lookup-pin-layer');
      if (onMap && layer) return { ok: true };
      document.querySelector('#lookup-result .lookup-btn')?.click();
      return null;
    })()`,
    'lookup pin on map',
    30000,
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
  return `profile: picker, threshold, add target, hidden curated restore, photo lookup, last-good ${lastGood.text.includes('TLE age 0.0 h')}, 2035 ${far.kind}`;
}

const SIGNED_IN_PICKER = `(() => {
  const select = document.getElementById('profile-picker-select');
  const info = document.querySelector('#profile-picker-section p')?.textContent || '';
  const count = select ? select.options.length : 0;
  if (document.getElementById('profile-new-btn') || document.getElementById('profile-delete-btn')) return null;
  if (!info.includes('Google account')) return null;
  if (count === 1 || (select && count < 2)) return null;
  return { ok: true, count, info };
})()`;

async function proveProfilePicker(send, evidenceDir, viewport, baseUrl) {
  await waitFor(send, SIGNED_IN_PICKER, 'signed-in profile picker', 20000);
  await evaluate(send, `document.getElementById('profile-picker-section')?.scrollIntoView({ block: 'start' })`);
  await shot(send, evidenceDir, 'profile-picker');
  if (viewport && viewport.width === 402 && viewport.height === 874) {
    await setViewport(send, 874, 402, true);
    await waitFor(send, SIGNED_IN_PICKER, 'signed-in profile picker landscape', 20000);
    await evaluate(send, `document.getElementById('profile-picker-section')?.scrollIntoView({ block: 'start' })`);
    await shot(send, evidenceDir, 'profile-picker-land');
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
  await proveLocalProfilePicker(send, evidenceDir, viewport, baseUrl);
}

async function proveLocalProfilePicker(send, evidenceDir, viewport, baseUrl) {
  await setSessionCookie(send, 'local');
  await send('Page.navigate', { url: `${baseUrl}/?e2e` });
  await waitFor(
    send,
    `(() => {
      const text = document.getElementById('status-banner')?.textContent || '';
      return text.includes('Last updated') ? { ok: true } : null;
    })()`,
    'local profile app',
    30000,
  );
  await click(send, '#tab-profile');
  await waitFor(
    send,
    `(() => {
      const select = document.getElementById('profile-picker-select');
      if (!select || select.options.length < 1) return null;
      if (document.getElementById('profile-new-btn')?.textContent !== 'New profile') return null;
      if (document.getElementById('profile-delete-btn')?.textContent !== 'Delete this profile') return null;
      return { ok: true };
    })()`,
    'local profile picker',
    20000,
  );
  await evaluate(send, `(() => {
    const input = document.getElementById('profile-new-input');
    if (input) input.value = 'watkins';
    document.getElementById('profile-new-btn')?.click();
    return true;
  })()`);
  await waitFor(
    send,
    `(() => {
      const errorText = document.getElementById('profile-new-error')?.textContent || '';
      const names = [...document.querySelectorAll('#profile-picker-select option')].map((opt) => opt.value);
      const u = new URL(location.href).searchParams.get('u');
      const rosterUrl = u === 'watkins' || u === 'kutryk' || u === 'delaney';
      const rosterOption = names.some((name) => name === 'watkins' || name === 'kutryk' || name === 'delaney');
      if (errorText === 'Crew roster profiles come with the app.' && !rosterOption && !rosterUrl) return { ok: true, u };
      return { errorText, names, u };
    })()`,
    'local picker refuses roster names',
    10000,
  );
  await evaluate(send, `document.getElementById('profile-picker-section')?.scrollIntoView({ block: 'start' })`);
  await shot(send, evidenceDir, 'profile-picker-local');
  if (viewport && viewport.width === 402 && viewport.height === 874) {
    await setViewport(send, 874, 402, true);
    await shot(send, evidenceDir, 'profile-picker-local-land');
    await setViewport(send, viewport.width, viewport.height, viewport.mobile);
  }
  await setSessionCookie(send, '');
  await send('Page.navigate', { url: `${baseUrl}/?e2e` });
  await waitFor(
    send,
    `(() => {
      const text = document.getElementById('status-banner')?.textContent || '';
      return text.includes('Last updated') ? { ok: true } : null;
    })()`,
    'signed-in profile app',
    30000,
  );
  await click(send, '#tab-profile');
  await waitFor(send, SIGNED_IN_PICKER, 'signed-in profile picker restored', 20000);
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
  await evaluate(send, `(() => {
    const box = window.__opdMap.getCanvas().parentElement;
    if (!box || box.dataset.opdLongPress) return true;
    box.dataset.opdLongPress = '1';
    box.addEventListener('touchstart', (event) => event.preventDefault(), { capture: true });
    return true;
  })()`);
  const longPressSeen = `(() => {
    const popup = document.querySelector('.maplibregl-popup');
    const text = popup?.innerText || '';
    if (text.includes('Closest')) return { ok: true };
    const hit = document.elementFromPoint(${finger.x}, ${finger.y});
    return {
      popup: text.slice(0, 120),
      hit: hit ? (hit.id || String(hit.className) || hit.tagName) : null,
      popups: document.querySelectorAll('.maplibregl-popup').length,
    };
  })()`;
  let held = false;
  let lastPressError = null;
  for (let attempt = 0; attempt < 2 && !held; attempt += 1) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger] });
    try {
      await waitFor(send, longPressSeen, 'long press popup', 5000);
      held = true;
    } catch (error) {
      lastPressError = error;
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [finger] });
      try {
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: finger.x, y: finger.y, button: 'left', buttons: 0, clickCount: 1 });
      } catch {
      }
      await sleep(250);
    }
  }
  if (!held) throw lastPressError;
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
