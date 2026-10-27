import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type BrowserType, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeBrowser, launchTracked, type TrackedBrowser } from './close-browser.mjs';

const root = resolve(__dirname, '..');
const origin = 'http://127.0.0.1:45131';
const html = readFileSync(resolve(root, 'index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '');

const shapes = ['slow', 'hung', 'no-body', 'abort-hang', 'network'] as const;
type Shape = (typeof shapes)[number];

function executable(type: BrowserType): string | undefined {
  try {
    const path = type.executablePath();
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

const engines: Array<{ name: string; type: BrowserType; path: string | undefined }> = [
  { name: 'WebKit', type: webkit, path: executable(webkit) },
  {
    name: 'Chrome',
    type: chromium,
    path: ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', executable(chromium)].find(
      (path): path is string => typeof path === 'string' && existsSync(path),
    ),
  },
];

const phoneSizes = [
  { name: 'phone', width: 402, height: 874 },
  { name: 'ipad', width: 834, height: 1210 },
];

function sizesFor(engineName: string): Array<{ name: string; width: number; height: number }> {
  if (engineName !== 'Chrome') return phoneSizes;
  return [...phoneSizes, { name: 'desktop', width: 1440, height: 900 }];
}

let assets = new Map<string, string | Uint8Array>();
let script = '';
const browsersReady = engines.some((engine) => engine.path);

function stub(shape: Shape): string {
  return `(() => {
    const shape = ${JSON.stringify(shape)};
    const orig = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/browser/session')) return orig(input, init);
      window.__coldStart = performance.now();
      const banner = document.getElementById('status-banner');
      if (banner) {
        const observer = new MutationObserver(() => {
          if (!banner.querySelector('.banner-action')) return;
          window.__coldMs = performance.now() - window.__coldStart;
          observer.disconnect();
        });
        observer.observe(banner, { childList: true, subtree: true, characterData: true });
      }
      if (shape === 'network') {
        window.__coldBannerAtTurn = false;
        window.__coldTurn = false;
        window.setTimeout(() => {
          window.__coldBannerAtTurn = !!document.querySelector('#status-banner .banner-action');
          window.__coldTurn = true;
        }, 0);
        return Promise.reject(new TypeError('Load failed'));
      }
      if (shape === 'slow') {
        return new Promise((resolve) => {
          setTimeout(() => resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })), 15000);
        });
      }
      if (shape === 'no-body') {
        return Promise.resolve(new Response(new ReadableStream({
          pull() { return new Promise(() => {}); },
          cancel() {},
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      }
      return new Promise(() => {
        if (init && init.signal) init.signal.addEventListener('abort', () => {});
      });
    };
  })();`;
}

async function install(page: Page, shape: Shape): Promise<void> {
  await page.addInitScript(stub(shape));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/app') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>recovery</title><p>recovery</p>' });
    }
    if (url.origin === origin && (url.pathname === '/' || url.pathname === '/index.html')) {
      return route.fulfill({
        contentType: 'text/html',
        body: html.replace('</body>', `<script src="/${script}"></script></body>`),
      });
    }
    const asset = assets.get(url.pathname);
    if (url.origin === origin && asset !== undefined) {
      return route.fulfill({
        contentType: 'text/javascript',
        body: typeof asset === 'string' ? asset : Buffer.from(asset),
      });
    }
    return route.abort();
  });
}

beforeAll(async () => {
  if (!browsersReady) return;
  const output = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    define: { __APP_VERSION__: JSON.stringify('cold-session-recovery') },
    build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'coldSession', formats: ['iife'] } },
  });
  const bundle = Array.isArray(output) ? output[0]! : output;
  if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
  assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  const entry = bundle.output.find((item) => item.type === 'chunk' && item.isEntry);
  if (!entry) throw new Error('missing entry');
  script = entry.fileName;
}, 120_000);

for (const engine of engines) {
  describe.skipIf(!engine.path)(`cold session recovery ${engine.name}`, () => {
    let session: TrackedBrowser | undefined;
    beforeAll(async () => {
      session = await launchTracked(engine.type, { headless: true, executablePath: engine.path });
    }, 60_000);
    afterAll(async () => {
      await closeBrowser(session, engine.name);
    });

    for (const size of sizesFor(engine.name)) {
      for (const shape of shapes) {
        it(`${shape} at ${size.width}x${size.height} leaves a working recovery control`, async () => {
          const context = await session!.browser.newContext({ viewport: { width: size.width, height: size.height } });
          const page = await context.newPage();
          try {
            await install(page, shape);
            if (shape !== 'network') {
              await page.clock.install();
              await page.clock.pauseAt(Date.now());
            }
            await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
            expect(page.viewportSize()).toEqual({ width: size.width, height: size.height });
            await page.waitForFunction(() => typeof (window as unknown as { __coldStart?: number }).__coldStart === 'number');
            if (shape === 'network') {
              await page.waitForFunction(() => (window as unknown as { __coldTurn?: boolean }).__coldTurn === true);
            } else {
              const early = await page.locator('#status-banner').innerText();
              expect(await page.locator('#status-banner .banner-action').count(), early).toBe(0);
              const frozen = await page.evaluate(() => performance.now());
              await new Promise((resolve) => setTimeout(resolve, 200));
              expect(await page.evaluate(() => performance.now())).toBe(frozen);
              await page.clock.fastForward(10_000);
            }
            const state = await page.evaluate(() => {
              const banner = document.getElementById('status-banner');
              return {
                text: banner?.innerText ?? '',
                signIn: banner?.querySelector('a.banner-action')?.textContent ?? '',
                reload: banner?.querySelector('button.banner-action')?.textContent ?? '',
                cards: document.querySelectorAll('#cards > *').length,
                elapsed: (window as unknown as { __coldMs?: number }).__coldMs ?? -1,
                bannerAtTurn: (window as unknown as { __coldBannerAtTurn?: boolean }).__coldBannerAtTurn === true,
              };
            });
            const banner = state.text;
            const elapsed = state.elapsed;
            if (shape === 'network') {
              expect(banner).toMatch(/Load failed|Failed to fetch/);
              expect(elapsed).toBeGreaterThanOrEqual(0);
              expect(state.bannerAtTurn).toBe(true);
            } else {
              expect(banner).toContain('The session request timed out');
              expect(elapsed).toBeGreaterThanOrEqual(9_000);
              expect(elapsed).toBeLessThan(15_000);
            }
            expect(state.signIn).toBe('Sign in');
            expect(state.reload).toBe('Reload');
            expect(state.cards).toBe(0);
            const control = shape === 'network' ? 'button.banner-action' : 'a.banner-action';
            await Promise.all([
              page.waitForURL(/\/api\/app/),
              page.evaluate((selector) => {
                const node = document.querySelector(`#status-banner ${selector}`);
                if (node instanceof HTMLElement) node.click();
              }, control),
            ]);
            expect(await page.locator('body').innerText()).toContain('recovery');
            console.log(`COLD ${engine.name} ${size.width}x${size.height} ${shape} ${elapsed}ms`);
          } finally {
            await context.close();
          }
        }, 30_000);
      }
    }

    if (engine.name === 'WebKit') {
      it('the first Reload after a stalled session clears Loading', async () => {
        const sessionJson = JSON.stringify({
          ok: true,
          profile: { name: 'anil', displayName: 'Anil' },
        });
        let stalled = false;
        let released = false;
        const server: Server = createServer((req, res) => {
          const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
          if (path === '/api/browser/session') {
            if (!stalled) {
              stalled = true;
              res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              res.write('');
              res.on('close', () => { released = true; });
              return;
            }
            res.writeHead(200, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(sessionJson),
            });
            res.end(sessionJson);
            return;
          }
          if (path === '/' || path === '/api/app') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(html.replace('</body>', `<script src="/${script}"></script></body>`));
            return;
          }
          const asset = assets.get(path);
          if (asset !== undefined) {
            res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
            res.end(typeof asset === 'string' ? asset : Buffer.from(asset));
            return;
          }
          res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
          res.end('missing');
        });
        server.maxConnections = 1;
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('session server did not bind');
        const context = await session!.browser.newContext({ viewport: { width: 402, height: 874 } });
        const page = await context.newPage();
        try {
          await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
          await page.locator('#status-banner button.banner-action').waitFor({ timeout: 15_000 });
          expect(released).toBe(true);
          const started = Date.now();
          await page.locator('#status-banner button.banner-action').click();
          await page.waitForURL(/\/api\/app/, { timeout: 5_000 });
          await page.waitForFunction(() => {
            const text = document.getElementById('status-banner')?.textContent ?? '';
            return text.length > 0 && !text.includes('Loading');
          }, { timeout: 5_000 });
          expect(Date.now() - started).toBeLessThan(5_000);
          expect(await page.locator('#status-banner').innerText()).not.toContain('Loading');
        } finally {
          await context.close();
          await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
      }, 30_000);
    }
  });
}
