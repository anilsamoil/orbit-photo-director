import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { devices, webkit } from 'playwright';

const OUT = '/opt/cursor/artifacts/safari-shell-update.log';
mkdirSync('/opt/cursor/artifacts', { recursive: true });
const lines = [];
const log = (line) => {
  lines.push(line);
  console.log(line);
};

const REVALIDATE = 'no-cache, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const HTML_STICKY = 'public, max-age=60';

function policyHeader(policy, pathname) {
  const shell = pathname === '/' || pathname === '/index.html' || pathname === '/sw.js' || pathname === '/registerSW.js';
  if (policy === 'revalidate' && shell) return REVALIDATE;
  if (pathname === '/sw.js' || pathname === '/registerSW.js') return IMMUTABLE;
  if (pathname === '/' || pathname === '/index.html') return HTML_STICKY;
  return IMMUTABLE;
}

function freshMs(cacheControl) {
  if (!cacheControl) return 0;
  if (/no-cache|no-store|max-age=0/.test(cacheControl)) return 0;
  if (/immutable/.test(cacheControl)) return Number.POSITIVE_INFINITY;
  const match = /max-age=(\d+)/.exec(cacheControl);
  return match ? Number(match[1]) * 1000 : 0;
}

function pageHtml(build) {
  const register = build === '1'
    ? "navigator.serviceWorker.register('/sw.js')"
    : "navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(function (registration) { registration.update(); })";
  return `<!doctype html><html><head><meta charset="utf-8"><title>SNAP</title></head><body><p id="build">BUILD ${build}</p><script>if ('serviceWorker' in navigator) { ${register}; }</script></body></html>`;
}

function workerScript(build) {
  if (build === '1') {
    const html = pageHtml('1').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    return `
const html = \`${html}\`;
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open('shell').then((cache) => cache.put('/', new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(caches.match('/').then((cached) => cached || fetch(event.request)));
});
`;
  }
  return `
self.addEventListener('install', (event) => {
  const seed = fetch(new Request('/', { cache: 'reload' })).catch(() => null);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 8000));
  event.waitUntil(Promise.race([seed, timeout]).then((response) => {
    if (!response || !response.ok) return undefined;
    return caches.open('opd-shell').then((cache) => cache.put('/', response));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim().then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true })).then((clients) => {
    setTimeout(() => {
      for (const client of clients) {
        if (!client.url) continue;
        client.navigate(client.url).catch(() => undefined);
      }
    }, 0);
  }));
});
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(new Request('/', { cache: 'reload' }));
      if (response && response.ok) {
        const cache = await caches.open('opd-shell');
        await cache.put('/', response.clone());
        return response;
      }
    } catch { /* offline */ }
    const cached = await caches.match('/');
    if (cached) return cached;
    return fetch(event.request);
  })());
});
`;
}

function startOrigin({ policy, replay }) {
  const state = { build: '1', policy };
  const safari = new Map();
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname === '/index.html' ? '/' : url.pathname;
    const cacheControl = policyHeader(state.policy, pathname);
    const type = pathname === '/sw.js' ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    const current = pathname === '/sw.js' ? workerScript(state.build) : pageHtml(state.build);
    const cached = safari.get(pathname);
    const age = cached ? Date.now() - cached.storedAt : Number.POSITIVE_INFINITY;
    const replayHit = Boolean(replay && cached && age < freshMs(cached.cacheControl));
    const body = replayHit && cached ? cached.body : current;
    const servedControl = replayHit && cached ? cached.cacheControl : cacheControl;
    const servedBuild = replayHit && cached ? cached.build : state.build;
    if (!replayHit) safari.set(pathname, { body: current, cacheControl, storedAt: Date.now(), build: state.build });
    requests.push({ pathname, build: servedBuild, replayHit, cacheControl: servedControl });
    res.writeHead(200, {
      'content-type': type,
      'cache-control': servedControl,
      'x-opd-build': servedBuild,
      'x-opd-replay': replayHit ? '1' : '0',
    });
    res.end(body);
  });
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolveListen({
        server,
        requests,
        origin: `http://127.0.0.1:${port}`,
        deploy(nextPolicy = state.policy) {
          state.build = '2';
          state.policy = nextPolicy;
        },
      });
    });
  });
}

async function readBuild(page) {
  return page.locator('#build').innerText();
}

async function runCase(browser, name, options) {
  const origin = await startOrigin(options);
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  try {
    await page.goto(`${origin.origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });
    const before = await readBuild(page);
    origin.deploy(options.nextPolicy);
    await page.reload({ waitUntil: 'domcontentloaded' });
    if (options.expect === '2') {
      await page.waitForFunction(() => document.querySelector('#build')?.textContent?.includes('BUILD 2'), null, { timeout: 15000 });
    } else {
      await page.waitForTimeout(3000);
    }
    const after = await readBuild(page);
    const swFetches = origin.requests.filter((entry) => entry.pathname === '/sw.js');
    const replayed = swFetches.filter((entry) => entry.replayHit).length;
    log(`${name}: before=${before.trim()} after=${after.trim()} swFetches=${swFetches.length} replayed=${replayed}`);
    const ok = options.expect === '2' ? after.includes('BUILD 2') : after.includes('BUILD 1') && !after.includes('BUILD 2');
    if (!ok) log(`${name}: FAIL expected BUILD ${options.expect}`);
    return ok;
  } finally {
    await context.close();
    await new Promise((resolveClose) => origin.server.close(() => resolveClose()));
  }
}

const browser = await webkit.launch();
const results = [];
const only = process.env.OPD_SW_CASE;
try {
  if (!only || only === 'sticky-replay') results.push(['sticky-replay', await runCase(browser, 'sticky immutable sw.js replayed', { policy: 'sticky', replay: true, expect: '1' })]);
  if (!only || only === 'revalidate-replay') results.push(['revalidate-replay', await runCase(browser, 'revalidate headers, Safari freshness model', { policy: 'revalidate', replay: true, expect: '2' })]);
  if (!only || only === 'revalidate-webkit') results.push(['revalidate-webkit', await runCase(browser, 'revalidate headers, WebKit iPhone cache', { policy: 'revalidate', replay: false, expect: '2' })]);
  if (!only || only === 'cached-immutable') results.push(['cached-immutable', await runCase(browser, 'WebKit cached immutable sw.js, then the server revalidates', { policy: 'sticky', replay: false, nextPolicy: 'revalidate', expect: '2' })]);
} finally {
  await browser.close();
}
const failed = results.filter(([, ok]) => !ok);
log(failed.length === 0 ? 'PASS safari shell update' : `FAIL ${failed.map(([name]) => name).join(', ')}`);
writeFileSync(OUT, `${lines.join('\n')}\n`);
if (failed.length) process.exit(1);
