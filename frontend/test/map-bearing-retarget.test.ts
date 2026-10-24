import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tleEpochMs } from '../src/iss-sgp4';
import { closeBrowser, launchTracked, type TrackedBrowser } from './close-browser.mjs';
import { freezeDate } from './freeze-date';
import fixture from './fixtures/iss-sgp4-fixture.json';

const root = resolve(__dirname, '..');
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve(root, 'public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const origin = 'http://bearing-retarget.test';
const manifest = {
  version: 'bearing', generated_at: fixture.start, tle_epoch: new Date(tleEpochMs(fixture.tle)!).toISOString(),
  cloud_composite_hour: fixture.start, target_data_version: 'bearing', build_version: 'bearing',
  freshness: { tle_hours: 0, cloud_hours: 0, ok: true },
  artifacts: Object.fromEntries(['passes', 'track', 'status', 'top5', 'top_24h', 'cupola_windows'].map((key) => [key, { path: `${key}.json`, sha256: '', bytes: 0 }])),
};
const REPS = Number(process.env.BEARING_REPS ?? '12');

let assets: Map<string, string | Uint8Array>;
let script: string;

beforeAll(async () => {
  const output = await build({
    configFile: false, root, logLevel: 'silent', define: { __APP_VERSION__: JSON.stringify('bearing-retarget') },
    build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'bearingRetarget', formats: ['iife'] } },
  });
  const bundle = Array.isArray(output) ? output[0]! : output;
  if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
  assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
}, 60_000);

async function install(page: Page): Promise<void> {
  await freezeDate(page, fixture.start);
  await page.addInitScript(() => {
    localStorage.setItem('opd-map-chrome', 'shown');
    localStorage.removeItem('opd-map-bearing-mode');
  });
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).hostname === 'celestrak.org') {
      return route.fulfill({ contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: `ISS (ZARYA)\n${fixture.tle.line1}\n${fixture.tle.line2}` });
    }
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: html.replace('</head>', `<style>${vendor}\n${stylesheet}</style></head>`).replace('</body>', `<script src="/${script}"></script></body>`),
      });
    }
    const asset = assets.get(url.pathname);
    if (url.origin === origin && asset !== undefined) {
      return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: typeof asset === 'string' ? asset : Buffer.from(asset) });
    }
    if (url.pathname === '/manifest.json') return route.fulfill({ json: manifest });
    if (['/passes.json', '/top5.json', '/top_24h.json', '/cupola_windows.json'].includes(url.pathname)) return route.fulfill({ json: [] });
    if (url.pathname === '/status.json') return route.fulfill({ json: { last_run: fixture.start, tick_minutes: 30, tle_age_hours: 0, tle_freshness_factor: 1, cloud_source: 'gibs', cloud_composite_hour: fixture.start, target_count: 0, pass_count: 0, version: 'bearing', build_version: 'bearing' } });
    if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'bearing', displayName: 'Local fixture' } } });
    if (url.pathname.startsWith('/api/browser/profiles/')) return route.fulfill({ json: { ok: true, count: 0, targets: [] } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
    if (url.pathname === '/track.json') return route.fulfill({ json: { ...fixture, tle_epoch: manifest.tle_epoch, tle_age_hours: 0, tle_freshness_factor: 1 } });
    if (/\.(png|jpe?g)$/.test(url.pathname) || url.pathname.includes('/MapServer/tile/')) return route.fulfill({ contentType: 'image/png', body: raster });
    return route.abort();
  });
}

async function openMap(page: Page): Promise<void> {
  await page.goto(`${origin}/?e2e&u=bearing`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const map = (window as unknown as { __opdMap?: { getSource(id: string): unknown } }).__opdMap;
    return !!map?.getSource('iss-track') && !!document.getElementById('bearing-north') && !!document.getElementById('toggle-follow-iss');
  });
}

async function settled(page: Page): Promise<{ bearing: number; moving: boolean }> {
  await page.waitForFunction(() => {
    const map = (window as unknown as { __opdMap: { isMoving(): boolean } }).__opdMap;
    return !map.isMoving();
  }, undefined, { timeout: 4000 });
  await page.waitForTimeout(50);
  return page.evaluate(() => {
    const map = (window as unknown as { __opdMap: { getBearing(): number; isMoving(): boolean } }).__opdMap;
    return { bearing: map.getBearing(), moving: map.isMoving() };
  });
}

async function retargetOnce(page: Page): Promise<{ north: number; northMoving: boolean; iss: number; heading: number; issMoving: boolean }> {
  await page.evaluate(() => {
    document.getElementById('toggle-follow-iss')!.click();
    document.getElementById('bearing-north')!.click();
    document.getElementById('bearing-iss')!.click();
    document.getElementById('bearing-north')!.click();
  });
  const north = await settled(page);
  await page.evaluate(() => document.getElementById('bearing-iss')!.click());
  const headed = await settled(page);
  await page.evaluate(() => {
    document.getElementById('bearing-north')!.click();
    document.getElementById('bearing-iss')!.click();
  });
  const iss = await settled(page);
  return { north: north.bearing, northMoving: north.moving, iss: iss.bearing, heading: headed.bearing, issMoving: iss.moving };
}

function northOk(sample: { bearing: number; moving: boolean }): boolean {
  return !sample.moving && Math.abs(sample.bearing) < 0.01;
}

for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
]) describe.skipIf(!existsSync(engine.executablePath))(`bearing retarget ${engine.name}`, () => {
  let browser: Browser;
  let session: TrackedBrowser | undefined;
  beforeAll(async () => {
    session = await launchTracked(engine.type, { headless: true, executablePath: engine.executablePath });
    browser = session.browser;
  }, 60_000);
  afterAll(async () => { await closeBrowser(session, engine.name); }, 60_000);

  it(`settles North at 0 and ISS-up on the heading for ${REPS} real-clock reps`, async () => {
    const reps: { north: number; northMoving: boolean; iss: number; heading: number; issMoving: boolean; error?: string }[] = [];
    for (let rep = 0; rep < REPS; rep += 1) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      try {
        await install(page);
        await openMap(page);
        reps.push(await retargetOnce(page));
      } catch (error) {
        reps.push({ north: Number.NaN, northMoving: true, iss: Number.NaN, heading: Number.NaN, issMoving: true, error: String(error) });
      } finally {
        await context.close();
      }
    }
    const northPass = reps.filter((rep) => northOk({ bearing: rep.north, moving: rep.northMoving })).length;
    const issPass = reps.filter((rep) => !rep.issMoving && Math.abs((((rep.iss - rep.heading) % 360) + 540) % 360 - 180) < 0.01).length;
    const summary = { engine: engine.name, northPass, issPass, reps };
    console.log(`BEARING_REPS ${JSON.stringify(summary)}`);
    expect(summary, JSON.stringify(summary, null, 2)).toEqual({ ...summary, northPass: REPS, issPass: REPS });
  }, Math.max(180_000, REPS * 30_000));

  it('settles North when no animation frame arrives', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    try {
      await install(page);
      await openMap(page);
      await page.evaluate(() => {
        window.requestAnimationFrame = () => 0;
      });
      const sample = await retargetOnce(page);
      expect(northOk({ bearing: sample.north, moving: sample.northMoving }), JSON.stringify(sample)).toBe(true);
      expect(!sample.issMoving && Math.abs((((sample.iss - sample.heading) % 360) + 540) % 360 - 180) < 0.01, JSON.stringify(sample)).toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);
});
