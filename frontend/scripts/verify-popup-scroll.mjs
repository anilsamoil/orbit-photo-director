// Proves a long-press pass list and a score-pin popup stay inside the map
// and that the last line can be scrolled into view on iPad and iPhone sizes.
import { spawn } from 'node:child_process';

const { Window } = await import('happy-dom');
const dom = new Window();
globalThis.window = dom;
globalThis.document = dom.document;
globalThis.HTMLElement = dom.HTMLElement;
globalThis.Node = dom.Node;

const { buildPassList } = await import('../src/map/overlays/pass-list.ts');
const { buildTargetPopupContent } = await import('../src/map/features/targets/popup.ts');

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const passes = Array.from({ length: 5 }, (_, i) => ({
  closestApproachMs: NOW + (i + 1) * 3_600_000,
  nadirKm: 120 + i,
  regime: 'iss-day',
  issAltKm: 420,
  angleOffNadirDeg: 18,
  relativeBearingDeg: 80,
}));
const pin = buildPassList(12, -40, 1, [
  { name: 'ISS', color: '#125e87', passes },
  { name: 'Hubble', color: '#888888', passes },
], NOW);
const pinFooter = [...pin.querySelectorAll('div')].find((node) => node.textContent?.startsWith('Closest-approach'));
pinFooter.id = 'pin-footer';

const score = buildTargetPopupContent({
  target_name: 'Starbase',
  score: 82,
  has_pass: true,
  closest_approach: '2026-09-24T14:12:00Z',
  cloud_fraction: 12,
  pass_regime: 'iss-day',
  obstruction_class: 'clear',
  angle_off_nadir_deg: 18,
  iss_relative_bearing_deg: 80,
  shot_count: 2,
  is_personal: true,
  target_id: 'starbase',
}, NOW, () => {});
score.querySelector('button').id = 'score-edit';

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="/maplibre.css" />
<link rel="stylesheet" href="/style.css" />
<style>
  body { height: 100dvh; margin: 0; }
  .topbar { flex: 0 0 auto; height: 88px; }
  #map-pane { flex: 1 1 auto; min-height: 0; }
</style>
</head>
<body class="view-map">
  <header class="topbar">SNAP</header>
  <div id="map-pane"><div id="map" class="map maplibregl-map">
    <div class="maplibregl-canvas-container maplibregl-interactive maplibregl-touch-zoom-rotate maplibregl-touch-drag-pan"></div>
  </div></div>
<script>
const map = document.getElementById('map');
const pinHtml = ${JSON.stringify(pin.outerHTML)};
const scoreHtml = ${JSON.stringify(score.outerHTML)};
function mount(kind, pinY) {
  document.querySelectorAll('.maplibregl-popup').forEach((n) => n.remove());
  const popup = document.createElement('div');
  popup.className = 'maplibregl-popup';
  const content = document.createElement('div');
  content.className = 'maplibregl-popup-content';
  content.style.maxWidth = kind === 'pin' ? '340px' : '360px';
  content.innerHTML = kind === 'pin' ? pinHtml : scoreHtml;
  popup.appendChild(content);
  map.appendChild(popup);
  const height = popup.offsetHeight;
  const width = popup.offsetWidth;
  const mapBox = map.getBoundingClientRect();
  const anchor = pinY < height ? 'top' : 'bottom';
  popup.classList.add(anchor === 'top' ? 'maplibregl-popup-anchor-top' : 'maplibregl-popup-anchor-bottom');
  const left = Math.max(0, (mapBox.width - width) / 2);
  const top = anchor === 'top' ? pinY : pinY - height;
  popup.style.transform = 'translate(' + left + 'px,' + top + 'px)';
}
function inside(el) {
  const mapR = map.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.top >= mapR.top - 1 && r.bottom <= mapR.bottom + 1 && r.left >= mapR.left - 1 && r.right <= mapR.right + 1 && r.height > 0;
}
window.__before = (kind, fraction) => {
  const mapR = map.getBoundingClientRect();
  mount(kind, mapR.height * fraction);
};
window.__check = (kind, fraction) => {
  const mapR = map.getBoundingClientRect();
  mount(kind, mapR.height * fraction);
  const popup = document.querySelector('.maplibregl-popup');
  const content = document.querySelector('.maplibregl-popup-content');
  const footer = document.getElementById(kind === 'pin' ? 'pin-footer' : 'score-edit');
  let node = footer;
  while (node) {
    if (node.scrollHeight > node.clientHeight + 1) node.scrollTop = node.scrollHeight;
    node = node.parentElement;
  }
  return {
    popupInside: inside(popup),
    footerInside: inside(footer),
    mapTouch: getComputedStyle(map).touchAction,
    canvasTouch: getComputedStyle(document.querySelector('.maplibregl-canvas-container')).touchAction,
    popupTouch: getComputedStyle(content).touchAction,
  };
};
</script>
</body>
</html>`;

const server = Bun.serve({
  port: 8766,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (path === '/style.css') return new Response(Bun.file(new URL('../src/style.css', import.meta.url)));
    if (path === '/maplibre.css') return new Response(Bun.file(new URL('../node_modules/maplibre-gl/dist/maplibre-gl.css', import.meta.url)));
    return new Response('missing', { status: 404 });
  },
});

const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9333',
  '--user-data-dir=/tmp/chrome-popup-scroll',
  'about:blank',
], { stdio: 'ignore' });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

try {
  let version;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9333/json/version');
      if (res.ok) { version = await res.json(); break; }
    } catch { /* chrome still starting */ }
    await sleep(100);
  }
  if (!version) throw new Error('chrome debug port never came up');

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params = {}) => cdp(method, params, sessionId);
  await page('Page.enable');
  await page('Runtime.enable');

  const failures = [];
  const sizes = [
    ['ipad-landscape', 1180, 820],
    ['iphone-portrait', 390, 844],
    ['iphone-se', 320, 568],
  ];
  for (const [name, width, height] of sizes) {
    await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await page('Page.navigate', { url: 'http://127.0.0.1:8766/' });
    await sleep(300);
    for (const kind of ['pin', 'score']) {
      for (const fraction of [0.2, 0.55, 0.85]) {
        const evaled = await page('Runtime.evaluate', {
          expression: `JSON.stringify(window.__check(${JSON.stringify(kind)}, ${fraction}))`,
          returnByValue: true,
        });
        const row = JSON.parse(evaled.result.value);
        const where = `${name} ${kind} at ${fraction}`;
        if (!row.popupInside) failures.push(`${where} popup leaves the map`);
        if (!row.footerInside) failures.push(`${where} last line stays out of view`);
        if (row.mapTouch === 'none') failures.push(`${where} map touch-action is none`);
        if (row.canvasTouch !== 'none') failures.push(`${where} canvas touch-action is ${row.canvasTouch}`);
        if (row.popupTouch !== 'pan-y') failures.push(`${where} popup touch-action is ${row.popupTouch}`);
        if (process.env.SCREENSHOT === '1' && name === 'ipad-landscape' && kind === 'pin' && fraction === 0.55) {
          await page('Runtime.evaluate', { expression: 'window.__before("pin", 0.55)' });
          const before = await page('Page.captureScreenshot', { format: 'png' });
          await Bun.write('/tmp/popup-ipad-before.png', Buffer.from(before.data, 'base64'));
          await page('Runtime.evaluate', { expression: 'window.__check("pin", 0.55)' });
          const shot = await page('Page.captureScreenshot', { format: 'png' });
          await Bun.write('/tmp/popup-ipad-after.png', Buffer.from(shot.data, 'base64'));
        }
        if (process.env.SCREENSHOT === '1' && name === 'iphone-portrait' && kind === 'pin' && fraction === 0.55) {
          await page('Runtime.evaluate', { expression: 'window.__before("pin", 0.55)' });
          const before = await page('Page.captureScreenshot', { format: 'png' });
          await Bun.write('/tmp/popup-iphone-before.png', Buffer.from(before.data, 'base64'));
          await page('Runtime.evaluate', { expression: 'window.__check("pin", 0.55)' });
          const after = await page('Page.captureScreenshot', { format: 'png' });
          await Bun.write('/tmp/popup-iphone-after.png', Buffer.from(after.data, 'base64'));
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('popup scroll ok on iPad and iPhone sizes');
  }
} finally {
  chrome.kill('SIGKILL');
  server.stop();
}
