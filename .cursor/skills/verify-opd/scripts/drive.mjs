import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const BROWSER_FEATURES = ['banner', 'topbar', 'queue', 'upcoming', 'map', 'help', 'profile', 'log', 'phone'];

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
  await evaluate(send, `window.__opdMap.easeTo({ center: [${lng}, ${lat}], zoom: ${zoom}, duration: 0 }); true`);
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

export async function driveFeatures({ baseUrl, evidenceDir, meta, features }) {
  mkdirSync(evidenceDir, { recursive: true });
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const home = resolve(evidenceDir, '..');
  const chromePid = startChrome(home, debugPort);
  writeFileSync(resolve(home, 'chrome.pid'), String(chromePid));
  const notes = [];
  try {
    const cdp = await connectCdp(debugPort);
    try {
      await cdp.send('Page.enable');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__opdLogs = [];
          window.addEventListener('error', (event) => window.__opdLogs.push(String(event.message)));
          const original = console.error;
          console.error = (...args) => { window.__opdLogs.push(args.map(String).join(' ')); return original.apply(console, args); };`,
      });
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1400,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send('Page.navigate', { url: `${baseUrl}/?e2e` });
      await waitFor(cdp.send, `document.readyState === 'complete' ? { ok: true } : null`, 'page load', 30000);
      await waitFor(
        cdp.send,
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
      const selected = features.includes('all') ? BROWSER_FEATURES : features;
      for (const feature of selected) {
        if (feature === 'banner') notes.push(await driveBanner(cdp.send, evidenceDir));
        else if (feature === 'topbar') notes.push(await driveTopbar(cdp.send, evidenceDir));
        else if (feature === 'queue') notes.push(await driveQueue(cdp.send, evidenceDir, meta, baseUrl));
        else if (feature === 'upcoming') notes.push(await driveUpcoming(cdp.send, evidenceDir, meta, baseUrl, home));
        else if (feature === 'map') notes.push(await driveMap(cdp.send, evidenceDir, meta, baseUrl));
        else if (feature === 'help') notes.push(await driveHelp(cdp.send, evidenceDir));
        else if (feature === 'profile') notes.push(await driveProfile(cdp.send, evidenceDir, meta, baseUrl, home));
        else if (feature === 'log') notes.push(await driveLog(cdp.send, evidenceDir));
        else if (feature === 'phone') notes.push(await drivePhone(cdp.send, evidenceDir, meta));
        else throw new Error(`unknown feature ${feature}`);
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

async function driveBanner(send, evidenceDir) {
  const text = await evaluate(send, `document.getElementById('status-banner').textContent`);
  if (!text || /sign in/i.test(text) || text.includes('Could not verify') || !text.includes('Last updated')) {
    throw new Error(`banner is not a data state: ${text}`);
  }
  const pinned = await evaluate(send, `getComputedStyle(document.getElementById('status-banner')).position`);
  if (pinned !== 'fixed') throw new Error(`map banner is ${pinned}, expected fixed`);
  await shot(send, evidenceDir, 'banner');
  return `banner: ${text.trim()}`;
}

async function driveTopbar(send, evidenceDir) {
  const header = await waitFor(
    send,
    `(() => {
      const bar = document.querySelector('.topbar');
      const iss = document.getElementById('iss-now');
      const kp = document.getElementById('kp-widget');
      if (!bar || !iss || !kp) return null;
      const issText = iss.textContent.trim();
      if (!/^ISS\\d/.test(issText) || /live track expired/i.test(issText)) return null;
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 800,
    deviceScaleFactor: 1,
    mobile: true,
  });
  try {
    await waitFor(
      send,
      `(() => {
        const tabs = document.querySelector('.tabs');
        if (!tabs || tabs.scrollWidth <= tabs.clientWidth + 1) return null;
        return { ok: true, scrollWidth: tabs.scrollWidth, clientWidth: tabs.clientWidth };
      })()`,
      'tab strip scrolls',
      5000,
    );
    await shot(send, evidenceDir, 'topbar-narrow');
  } finally {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  return `topbar: ${header.iss}, ${header.kp}, sun hidden=${sunHidden}, queue padded, tabs scroll`;
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

async function driveUpcoming(send, evidenceDir, meta, baseUrl, home) {
  await click(send, '#tab-upcoming');
  await waitFor(
    send,
    `document.getElementById('upcoming-cards')?.innerText.includes(${JSON.stringify(meta.names.upcoming[0])}) ? { ok: true } : null`,
    'upcoming card',
  );
  await shot(send, evidenceDir, 'upcoming');
  await click(send, '#sort-score-upcoming');
  const active = await evaluate(send, `document.getElementById('sort-score-upcoming').classList.contains('active')`);
  if (!active) throw new Error('upcoming score sort did not become active');
  const mesaId = await hideNamed(send, '#upcoming-cards', meta.names.upcoming[0]);
  await waitFor(
    send,
    `!document.getElementById('upcoming-cards')?.innerText.includes(${JSON.stringify(meta.names.upcoming[0])}) ? { ok: true } : null`,
    'upcoming hide',
  );
  await shot(send, evidenceDir, 'upcoming-hidden');
  await click(send, '#sort-time-upcoming');
  await waitFor(
    send,
    `!document.getElementById('upcoming-cards')?.innerText.includes(${JSON.stringify(meta.names.upcoming[0])}) ? { ok: true } : null`,
    'upcoming hide after re-render',
  );
  const stored = await removedCuratedIds(send);
  if (!stored.includes(mesaId)) throw new Error(`upcoming hide missing ${mesaId} in ${JSON.stringify(stored)}`);
  await reloadSettled(send);
  await click(send, '#tab-upcoming');
  await waitFor(
    send,
    `document.getElementById('upcoming-cards') && !document.getElementById('upcoming-cards').innerText.includes(${JSON.stringify(meta.names.upcoming[0])}) ? { ok: true } : null`,
    'upcoming hide after reload',
  );
  const storedAfter = await removedCuratedIds(send);
  if (!storedAfter.includes(mesaId)) throw new Error(`reload dropped ${mesaId} from ${JSON.stringify(storedAfter)}`);
  await shot(send, evidenceDir, 'upcoming-reloaded');
  const server = await waitServerRemoved(baseUrl, [mesaId], []);
  await expectFreshHide(baseUrl, home, {
    id: mesaId,
    name: meta.names.upcoming[0],
    updatedAt: server.removedCuratedUpdatedAt,
    visible: false,
  });
  return `upcoming: card, score sort, hide persisted ${mesaId}, fresh profile hid it`;
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
  await waitFor(send, `document.getElementById('bearing-iss').classList.contains('active') ? { ok: true } : null`, 'iss up');
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
  await click(send, '#filter-launches-map');
  await waitFor(send, `document.getElementById('filter-launches-map').getAttribute('aria-pressed') === 'true' ? { ok: true } : null`, 'launch mode');
  await frameLngLat(send, meta.pad.lon, meta.pad.lat, 4);
  const padPoint = await pointForLngLat(send, meta.pad.lon, meta.pad.lat);
  await mouseClick(send, padPoint.x, padPoint.y);
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
      const data = source && (source._data || (source.serialize ? source.serialize().data : null));
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
      const data = source && (source._data || (source.serialize ? source.serialize().data : null));
      const ids = (data && data.features ? data.features : []).map((feature) => feature.properties && feature.properties.target_id);
      return ids.includes('verify-reef') ? null : { ok: true, ids };
    })()`,
    'reef pin hidden',
    10000,
  );
  await waitServerRemoved(baseUrl, ['verify-reef'], []);
  await shot(send, evidenceDir, 'map-pin-hidden');
  return 'map: globe, legend, imagery, attribution, time, tool rail, picker, target popup, pin drop, launch dialog, hidden pin';
}

async function driveHelp(send, evidenceDir) {
  await dismissShotlist(send);
  await click(send, '#tab-map');
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
  await waitFor(
    send,
    `(() => {
      const text = document.querySelector('#lookup-result .lookup-error')?.textContent || '';
      return text === 'orbit data is out of date, reconnect to refresh' ? { ok: true, text } : null;
    })()`,
    'stale orbit message',
    45000,
  );
  await click(send, '#tab-profile');
  await shot(send, evidenceDir, 'profile-lookup-stale');
  return `profile: threshold, add target, hidden curated restore, photo lookup, last-good ${lastGood.text.includes('TLE age 0.0 h')}, stale orbit message`;
}

async function driveLog(send, evidenceDir) {
  await click(send, '#tab-log');
  await waitFor(
    send,
    `(() => {
      const text = document.getElementById('log-list')?.innerText || '';
      return text.includes('Verify Reef') && /\\bshoot\\b/i.test(text) ? { ok: true, text } : null;
    })()`,
    'log row',
  );
  await shot(send, evidenceDir, 'log');
  return 'log: shoot row visible';
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

async function drivePhone(send, evidenceDir, meta) {
  await dismissShotlist(send);
  await click(send, '#tab-map');
  await waitFor(
    send,
    `window.__opdMap && document.querySelector('.iss-marker') && document.querySelector('.map-legend') ? { ok: true } : null`,
    'phone map',
    45000,
  );
  await setViewport(send, 390, 844, true);
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
  await sleep(560);
  const held = await evaluate(send, `document.querySelector('.maplibregl-popup')?.innerText.includes('Closest') ? true : document.body.innerText.slice(0, 80)`);
  if (held !== true) throw new Error(`long press did not open a pass popup: ${JSON.stringify(held)}`);
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
  await setViewport(send, 1400, 900, false);
  return `phone: 44px targets, dock clear with credits collapsed and expanded, long-press held, safe-area ${inset ? 'applied' : 'unsupported'}`;
}
