import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFixtures } from './fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(resolve(root, 'frontend/package.json'));

// The real SNAP modules and renderer, with the normal verify manifest/launch
// fixtures. Only disposable fixture/cache files are written; Vite binds port 0.
export async function serveSnap() {
  const home = await mkdtemp(resolve(tmpdir(), 'opd-context-state-'));
  const fixtureDir = resolve(home, 'fixtures');
  const realFetch = globalThis.fetch;
  let built;
  try {
    // Deliberately use the verification fixture's bundled fallback TLE. The
    // regression suite must not depend on a live CelesTrak request succeeding.
    globalThis.fetch = async () => { throw new Error('deterministic offline fixture'); };
    built = await buildFixtures(fixtureDir);
  } finally {
    globalThis.fetch = realFetch;
  }
  const { createServer } = await import(pathToFileURL(resolve(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')));
  const server = createHttpServer();
  const vite = await createServer({
    configFile: false,
    root: resolve(root, 'frontend'),
    cacheDir: resolve(home, 'vite-cache'),
    define: { __APP_VERSION__: JSON.stringify((await readFile(resolve(root, 'VERSION'), 'utf8')).trim()) },
    server: { middlewareMode: true, hmr: { server } },
    logLevel: 'error',
  });
  server.on('request', async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const json = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    const file = path === '/manifest.json' ? 'manifest.json'
      : path === '/launch/latest.json' ? 'launch-latest.json'
        : path === '/launch/v/verifyrev.json' ? 'launch.json'
          : /^\/v\/verify\/[a-z0-9_]+\.json$/.test(path) ? path.split('/').at(-1) : null;
    if (file) {
      try { json(await readFile(resolve(fixtureDir, file), 'utf8')); } catch { json({}, 404); }
    } else if (path === '/api/browser/session') json({ ok: true, profile: { name: 'anil', displayName: 'Anil' } });
    else if (path === '/api/kp') json({ kp: 3, timestamp: new Date(built.meta.now).toISOString(), age_min: 5 });
    else if (path === '/api/log') json({ entries: [] });
    else if (path.startsWith('/api/browser/profiles/')) json({ targets: [], removedCuratedIds: [] });
    // The v2 Verify Ascent fixture intentionally owns this state regression.
    else if (path.startsWith('/launch/catalog/')) json({}, 404);
    else if (path.startsWith('/api/')) json({}, 404);
    else vite.middlewares(req, res);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, now: built.meta.now,
    async close() { await vite.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(home, { recursive: true, force: true }); },
  };
}

export function isolateSnapRequests(browser, origin) {
  const original = browser.newContext.bind(browser);
  // A deterministic opaque blue tile. Raster fetching is isolated, but all
  // application code, MapLibre workers, WebGL drawing and controls are real.
  const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQzlv1HwAELgI7OfS9ngAAAABJRU5ErkJggg==', 'base64');
  browser.newContext = async (...args) => {
    const context = await original(...args);
    await context.route(/^https?:\/\//, async (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      if (route.request().resourceType() === 'image' || /\/tile\/|\/wmts\//.test(route.request().url())) {
        return route.fulfill({ contentType: 'image/png', body: tile });
      }
      return route.abort();
    });
    return context;
  };
}
