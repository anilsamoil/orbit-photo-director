import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, devices, webkit } from 'playwright';

const VITE = Number(process.env.OPD_VITE_PORT ?? 43147);
const PORT = Number(process.env.OPD_BANNER_PORT ?? 43149);
const LOGIN_PORT = Number(process.env.OPD_LOGIN_PORT ?? 43150);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.OPD_BANNER_OUT ?? '/tmp/opd-auth-banner';
const ACCESS = `http://127.0.0.1:${LOGIN_PORT}/cdn-cgi/access/login/map.astroanil.dev?kid=repro`;
mkdirSync(OUT, { recursive: true });

const STALE_SW = `
self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode !== 'navigate') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi')) return;
  event.respondWith(fetch(new URL('/', self.location).href));
});
`;

const PROFILE = JSON.stringify({
  version: 1,
  name: 'anil',
  additions: [{ id: 'personal:anil:kept', name: 'Kept reef', lat: 1, lon: 2, priority: 5, createdAt: '2026-09-28T00:00:00Z' }],
  removedCuratedIds: [],
  distanceThresholdKm: 1500,
  instantBuffer: [],
});

function cookieStatus(req) {
  const hit = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith('opdstatus='));
  return hit ? decodeURIComponent(hit.slice('opdstatus='.length)) : '401';
}

function proxyToVite(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${VITE}` };
  const preq = httpRequest({ hostname: '127.0.0.1', port: VITE, path: req.url, method: req.method, headers }, (pres) => {
    res.writeHead(pres.statusCode ?? 502, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(String(error));
  });
  req.pipe(preq);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  if (url.pathname === '/sw-repro.js') {
    res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
    res.end(STALE_SW);
    return;
  }
  const status = cookieStatus(req);
  if (url.pathname === '/api/browser/session') {
    if (status === 'lan') {
      proxyToVite(req, res);
      return;
    }
    if (status === '302') {
      res.writeHead(302, { location: ACCESS, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(Number(status), { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (url.pathname === '/api/app') {
    res.writeHead(302, { location: ACCESS, 'cache-control': 'no-store' });
    res.end();
    return;
  }
  proxyToVite(req, res);
});

const loginPage = '<!doctype html><title>Sign in</title><h1>Sign in with Google</h1>';
const loginServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(loginPage);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
await new Promise((resolve) => loginServer.listen(LOGIN_PORT, '127.0.0.1', resolve));

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
  console.log(`${ok ? 'ok' : 'FAIL'} ${message}`);
}

async function prepare(context, { status, standalone }) {
  await context.addCookies([{ name: 'opdstatus', value: String(status), url: BASE }]);
  await context.addInitScript((profile) => {
    localStorage.setItem('opd-profile-anil', profile);
    localStorage.setItem('opd-calib-queue', '[{"private":"unsent"}]');
  }, PROFILE);
  if (standalone) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    });
  }
}

async function openDenied(page, sw) {
  await page.goto(`${BASE}/?u=anil`, { waitUntil: 'domcontentloaded' });
  if (sw) {
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw-repro.js');
      await navigator.serviceWorker.ready;
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await page.locator('#status-banner').getByRole('link', { name: 'Sign in' }).waitFor({ timeout: 15000 });
}

function hit(page, box) {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const control = el?.closest('a, button');
    return {
      id: el?.id || null,
      text: control?.textContent?.trim() || el?.textContent?.trim().slice(0, 80) || null,
      tag: control?.tagName || el?.tagName || null,
    };
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

async function drive(browserType, deviceName, options) {
  const device = devices[deviceName];
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...device,
    serviceWorkers: 'allow',
    recordVideo: options.video ? { dir: OUT, size: { width: device.viewport.width, height: device.viewport.height } } : undefined,
  });
  await prepare(context, options);
  const page = await context.newPage();
  const label = `${browserType.name()}-${deviceName}-${options.status}${options.sw ? '-sw' : ''}${options.standalone ? '-pwa' : ''}`;
  try {
    if (options.status === 'lan') {
      await page.goto(`${BASE}/?u=anil`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const text = await page.locator('#status-banner').innerText();
      check(!/sign in again/i.test(text) && /no shot queue/i.test(text), `${label} local shell explains the missing queue (${text.slice(0, 90)})`);
      check(await page.locator('#status-banner a').count() === 0, `${label} local shell has no sign-in control`);
      const kept = await page.evaluate(() => localStorage.getItem('opd-calib-queue'));
      check(kept === '[{"private":"unsent"}]', `${label} local shell keeps the rating queue`);
      await page.screenshot({ path: `${OUT}/${label}.png` });
      return;
    }
    await openDenied(page, options.sw);
    const signIn = page.locator('#status-banner').getByRole('link', { name: 'Sign in' });
    const reload = page.locator('#status-banner').getByRole('button', { name: 'Reload' });
    const signBox = await signIn.boundingBox();
    const reloadBox = await reload.boundingBox();
    check(Boolean(signBox && reloadBox), `${label} both controls have boxes`);
    if (signBox && reloadBox) {
      const signHit = await hit(page, signBox);
      const reloadHit = await hit(page, reloadBox);
      check(signHit.text === 'Sign in' && signHit.tag === 'A', `${label} Sign in hit ${signHit.tag} ${signHit.text}`);
      check(reloadHit.text === 'Reload' && reloadHit.tag === 'BUTTON', `${label} Reload hit ${reloadHit.tag} ${reloadHit.text}`);
    }
    const kept = await page.evaluate(() => ({
      profile: localStorage.getItem('opd-profile-anil'),
      queue: localStorage.getItem('opd-calib-queue'),
    }));
    check(kept.queue === '[{"private":"unsent"}]' && kept.profile?.includes('Kept reef'), `${label} saved data still present before the tap`);
    await page.screenshot({ path: `${OUT}/${label}.png` });
    if (options.video) await page.waitForTimeout(1000);
    const control = options.tap === 'reload' ? reload : signIn;
    await control.click();
    await page.waitForURL(/\/cdn-cgi\/access\/login\//, { timeout: 8000 });
    check(page.url().startsWith(`http://127.0.0.1:${LOGIN_PORT}/cdn-cgi/access/login/`), `${label} ${options.tap} navigated to ${page.url()}`);
    await page.getByRole('heading', { name: 'Sign in with Google' }).waitFor({ timeout: 5000 });
    if (options.video) await page.waitForTimeout(1000);
    check(true, `${label} login page is the Access target`);
  } catch (error) {
    check(false, `${label} ${error instanceof Error ? error.message.split('\n')[0] : error}`);
  } finally {
    const video = page.video();
    await context.close();
    await browser.close();
    if (video && options.video) {
      const saved = await video.path();
      console.log(`video ${saved}`);
    }
  }
}

const cases = [
  [webkit, 'iPhone 13', { status: 401, sw: false, standalone: false, tap: 'sign-in', video: true }],
  [webkit, 'iPhone 13', { status: 302, sw: false, standalone: false, tap: 'reload' }],
  [webkit, 'iPhone 13', { status: 403, sw: true, standalone: false, tap: 'sign-in' }],
  [webkit, 'iPhone 13', { status: 401, sw: true, standalone: true, tap: 'sign-in' }],
  [webkit, 'iPhone 13', { status: 'lan', sw: false, standalone: false }],
  [webkit, 'iPhone 15', { status: 401, sw: false, standalone: true, tap: 'reload' }],
  [webkit, 'iPad Pro 11', { status: 401, sw: false, standalone: false, tap: 'sign-in' }],
  [webkit, 'iPad Pro 11', { status: 302, sw: true, standalone: false, tap: 'reload' }],
  [webkit, 'iPad Pro 11', { status: 'lan', sw: false, standalone: false }],
  [webkit, 'iPad (gen 7)', { status: 403, sw: false, standalone: true, tap: 'sign-in' }],
  [chromium, 'iPhone 13', { status: 401, sw: false, standalone: false, tap: 'reload' }],
];

for (const [engine, deviceName, options] of cases) {
  await drive(engine, deviceName, options);
}

writeFileSync(`${OUT}/report.json`, JSON.stringify({ failures }, null, 2));
server.close();
loginServer.close();
if (failures.length) {
  console.error(`${failures.length} failure(s)`);
  process.exit(1);
}
console.log('auth banner webkit drive passed');
