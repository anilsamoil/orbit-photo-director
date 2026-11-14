/**
 * Standalone verification Vite config (does not import frontend/vite.config.ts).
 * Serves VERIFY fixtures + stubs Cloudflare Worker /api routes as JSON.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, '..');
const fixturesDir = resolve(skillRoot, 'fixtures');
const frontendRoot = resolve(skillRoot, '../../../frontend');
const viteMod = await import(pathToFileURL(resolve(frontendRoot, 'node_modules/vite/dist/node/index.js')).href);
const { defineConfig } = viteMod;

const SESSION = {
  ok: true,
  profile: { name: 'verify', displayName: 'Verify Operator' },
  profiles: [{ name: 'verify', displayName: 'Verify Operator' }],
};

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function verifyPlugin() {
  return {
    name: 'verify-snap-fixtures-and-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = (req.url || '').split('?')[0] || '';

        if (raw === '/manifest.json' || raw.startsWith('/v/')) {
          const rel = raw.replace(/^\//, '');
          const filePath = normalize(join(fixturesDir, rel));
          if (!filePath.startsWith(fixturesDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
            res.statusCode = 404;
            res.end(`fixture missing: ${rel}`);
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          createReadStream(filePath).pipe(res);
          return;
        }

        if (raw === '/api/browser/session') {
          sendJson(res, 200, SESSION);
          return;
        }
        if (raw === '/api/log' || raw.startsWith('/api/log?')) {
          sendJson(res, 200, { entries: [] });
          return;
        }
        if (raw.startsWith('/api/browser/profiles')) {
          if (req.method === 'GET') {
            sendJson(res, 200, { targets: [] });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (raw.startsWith('/api/')) {
          sendJson(res, 200, { ok: true });
          return;
        }

        next();
      });
    },
  };
}

const version = existsSync(resolve(frontendRoot, '../VERSION'))
  ? readFileSync(resolve(frontendRoot, '../VERSION'), 'utf8').trim()
  : 'verify';

export default defineConfig({
  root: frontendRoot,
  cacheDir: resolve(frontendRoot, '.vite-cache-verify'),
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [verifyPlugin()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
});
