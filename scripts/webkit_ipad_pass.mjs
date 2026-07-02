/**
 * Real-WebKit (Safari) iPad pass for the map tap-target feature.
 *
 * Checks on actual WebKit at iPad viewport: app boot, map init, a seeded
 * personal-target ring + real scored pins, a genuine touch tap opening the
 * target popup, honest Shape-B content (never "score 0"), the Edit affordance,
 * and the Edit deep-link opening the inline form. Serves the LOCAL vite-preview
 * bundle but proxies data (manifest / v/<ts> artifacts / api) from prod so the
 * map truly initializes. Relies on the runtime ?e2e map hook in src/map.ts to
 * project a known lng/lat to screen coords and tap the exact pin.
 *
 * Prereqs:
 *   1. npx playwright install webkit                  # one-time browser download
 *   2. cd frontend && bun run build && bun run preview --port 4318
 *   3. node scripts/webkit_ipad_pass.mjs              # exits 0 on pass, 1 on fail
 *
 * The playwright import below points at the local npx-cached install; if it
 * moves, find it with:  find ~/.npm/_npx -name playwright -type d
 */
import pw from '/Users/astroanil/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
const { webkit } = pw;

const BASE = 'http://localhost:4318';
const ipad = { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };

// Seeded personal target → a deterministic my-targets ring at [0,10] to tap.
const PROFILE = {
  version: 1, name: 'jack',
  additions: [{ id: 'personal:jack:reef01', name: 'My favorite reef', lat: 10, lon: 0, priority: 7, createdAt: '2026-05-26T12:00:00Z' }],
  removedCuratedIds: [], distanceThresholdKm: 1500, instantBuffer: [],
};

const fails = [];
const log = (ok, msg) => { console.log(`${ok ? '✅' : '❌'} ${msg}`); if (!ok) fails.push(msg); };

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...ipad });

// Serve the LOCAL bundle but proxy DATA (manifest / artifacts / api) from prod
// so the map truly initializes. External basemap tiles continue direct.
await ctx.route('**', async (route) => {
  const u = new URL(route.request().url());
  const isData = u.host === 'localhost:4318' && (u.pathname === '/manifest.json' || u.pathname.startsWith('/v/') || u.pathname.startsWith('/api/'));
  if (isData) {
    try {
      const r = await fetch('https://map.astroanil.dev' + u.pathname + u.search);
      const body = Buffer.from(await r.arrayBuffer());
      const headers = {};
      r.headers.forEach((v, k) => { const lk = k.toLowerCase(); if (lk !== 'content-encoding' && lk !== 'content-length') headers[k] = v; });
      await route.fulfill({ status: r.status, headers, body });
    } catch { await route.abort(); }
    return;
  }
  return route.continue();
});

await ctx.addInitScript(({ profile }) => {
  try {
    localStorage.setItem('opd-profile-jack', JSON.stringify(profile));
    localStorage.setItem('opd-profile-names', JSON.stringify(['jack']));
    localStorage.setItem('opd-calib-token', 'demo-token');
  } catch {}
}, { profile: PROFILE });

const page = await ctx.newPage();
const rawErrors = [];
page.on('pageerror', (e) => rawErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') rawErrors.push(`console.error: ${m.text()}`); });

// 1) Boot on WebKit; let the proxied manifest land.
await page.goto(`${BASE}/?u=jack&e2e=1`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
log((await page.evaluate(() => navigator.userAgent)).includes('Safari'), 'WebKit (Safari engine) booted the app');

// 2) Map tab → wait for the gated map hook + style.
await page.click('#tab-map').catch(() => {});
let mapReady = false;
try { await page.waitForFunction(() => !!window.__opdMap && window.__opdMap.isStyleLoaded?.(), { timeout: 15000 }); mapReady = true; } catch {}
log(mapReady, 'Map instance created + style loaded on WebKit');
await page.waitForTimeout(1500);

// 3) Seeded personal target + real scored pins are present in the sources.
const counts = mapReady ? await page.evaluate(() => {
  const m = window.__opdMap;
  const mt = m.getSource('my-targets')?._data?.features?.length ?? -1;
  const t = m.getSource('targets')?._data?.features?.length ?? -1;
  return { mt, t };
}) : { mt: -1, t: -1 };
log(counts.mt >= 1, `my-targets ring rendered (features=${counts.mt})`);
log(counts.t >= 1, `real scored pins loaded via proxy (targets features=${counts.t})`);

// 4) Real WebKit finger tap on the pin → popup. project() is CONTAINER-relative,
//    so add the canvas viewport offset to tap the right screen pixel.
let popupText = '';
if (mapReady) {
  const xy = await page.evaluate(() => {
    const m = window.__opdMap;
    const p = m.project([0, 10]);
    const r = m.getCanvas().getBoundingClientRect();
    return { x: Math.round(r.left + p.x), y: Math.round(r.top + p.y) };
  });
  await page.touchscreen.tap(xy.x, xy.y);
  try {
    await page.waitForSelector('.maplibregl-popup .map-target-popup', { timeout: 5000 });
    popupText = ((await page.locator('.maplibregl-popup .map-target-popup').first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
  } catch {}
}
log(/My favorite reef/.test(popupText), 'WebKit touch tap opened the target popup');
log(/No upcoming pass/.test(popupText), `Shape-B honest content shown: "${popupText.slice(0, 70)}"`);
log(!/score 0/.test(popupText), 'popup never shows "score 0"');
log(/Edit target/.test(popupText), 'Edit affordance present (personal target)');
await page.screenshot({ path: '/tmp/webkit-popup.png' });

// 5) Edit deep-link from the popup → inline form on WebKit.
let editFormOk = false;
if (popupText) {
  await page.locator('.maplibregl-popup .map-popup-edit').click().catch(() => {});
  try { await page.waitForSelector('[data-kind="personal-edit"]', { timeout: 6000 }); editFormOk = true; } catch {}
}
log(editFormOk, 'popup "Edit target" deep-links to the inline edit form on WebKit');
if (editFormOk) await page.locator('[data-kind="personal-edit"]').screenshot({ path: '/tmp/webkit-edit-form.png' });

// 6) No REAL app errors (ignore environmental proxy/CORS/fake-token noise).
const envNoise = /Failed to load resource|Access-Control-Allow-Origin|cannot load|\b40[14]\b|\b502\b|gibs\.earthdata|net::|CORS|due to access control/i;
const realErrors = rawErrors.filter((e) => !envNoise.test(e));
log(realErrors.length === 0, `no real app errors on WebKit ${realErrors.length ? '→ ' + realErrors.slice(0, 3).join(' | ') : '(env CORS/404 noise filtered)'}`);

await browser.close();
console.log(`\n${fails.length === 0 ? 'WEBKIT PASS ✅ all checks green' : `WEBKIT FAIL ❌ ${fails.length} issue(s)`}`);
process.exit(fails.length === 0 ? 0 : 1);
