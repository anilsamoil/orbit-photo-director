import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveIssPositionSGP4, tleEpochMs } from '../src/iss-sgp4';
import fixture from './fixtures/iss-sgp4-fixture.json';

const root = resolve(__dirname, '..');
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(existsSync);
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8');
const vendorCss = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');

function tleAt(line1: string, epochMs: number): string {
  const year = new Date(epochMs).getUTCFullYear();
  const day = (epochMs - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  const whole = Math.floor(day);
  const fraction = (day - whole).toFixed(8).slice(1);
  const epoch = `${String(year % 100).padStart(2, '0')}${String(whole).padStart(3, '0')}${fraction}`;
  const body = `${line1.slice(0, 18)}${epoch}${line1.slice(32, 68)}`;
  const checksum = [...body].reduce((sum, ch) => sum + (ch === '-' ? 1 : ch >= '0' && ch <= '9' ? Number(ch) : 0), 0) % 10;
  return `${body}${checksum}`;
}

const tle = { line1: tleAt(fixture.tle.line1, Date.now() - 60_000), line2: fixture.tle.line2 };
const tleEpoch = new Date(tleEpochMs(tle)!).toISOString();
const live = liveIssPositionSGP4({ ...fixture, tle, tle_epoch: tleEpoch, tle_age_hours: 0, tle_freshness_factor: 1 }, Date.now());
if (!live) throw new Error('retargeted TLE does not propagate on the real clock');

const manifest = {
  version: 'north', generated_at: fixture.start, tle_epoch: tleEpoch,
  cloud_composite_hour: fixture.start, target_data_version: 'north', build_version: 'north',
  freshness: { tle_hours: 0, cloud_hours: 0, ok: true },
  artifacts: Object.fromEntries(['passes', 'track', 'status', 'top5', 'top_24h', 'cupola_windows'].map((key) => [key, { path: `${key}.json`, sha256: '', bytes: 0 }])),
};
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const origin = 'http://north.test';

type MapHandle = {
  isStyleLoaded(): boolean;
  getSource(id: string): unknown;
  getBearing(): number;
  isMoving(): boolean;
  setCenter(center: [number, number]): unknown;
  jumpTo(camera: { bearing: number }): void;
  on(event: 'move', handler: () => void): void;
  __centerAt?: number[];
  __samples?: number[];
};

let assets: Map<string, string | Uint8Array>;
let script: string;

beforeAll(async () => {
  const output = await build({
    configFile: false, root, logLevel: 'silent', define: { __APP_VERSION__: JSON.stringify('north-test') },
    build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'north', formats: ['iife'] } },
  });
  const bundle = Array.isArray(output) ? output[0]! : output;
  if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
  assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
}, 60_000);

async function openMap(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).hostname === 'celestrak.org') {
      return route.fulfill({ contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: `ISS\n${tle.line1}\n${tle.line2}` });
    }
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: html.replace('</head>', `<style>${vendorCss}\n${stylesheet}</style></head>`).replace('</body>', `<script src="/${script}"></script></body>`) });
    }
    const asset = assets.get(url.pathname);
    if (url.origin === origin && asset !== undefined) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: typeof asset === 'string' ? asset : Buffer.from(asset) });
    if (url.pathname === '/manifest.json') return route.fulfill({ json: manifest });
    if (['/passes.json', '/top5.json', '/top_24h.json', '/cupola_windows.json'].includes(url.pathname)) return route.fulfill({ json: [] });
    if (url.pathname === '/status.json') return route.fulfill({ json: { last_run: fixture.start, tick_minutes: 30, tle_age_hours: 0, tle_freshness_factor: 1, cloud_source: 'gibs', cloud_composite_hour: fixture.start, target_count: 0, pass_count: 0, version: 'north', build_version: 'north' } });
    if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'north', displayName: 'Local fixture' } } });
    if (url.pathname.startsWith('/api/browser/profiles/')) return route.fulfill({ json: { ok: true, count: 0, targets: [] } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
    if (url.pathname === '/track.json') return route.fulfill({ json: { ...fixture, tle, tle_epoch: tleEpoch, tle_age_hours: 0, tle_freshness_factor: 1 } });
    if (/\.(png|jpe?g)$/.test(url.pathname) || url.pathname.includes('/MapServer/tile/')) return route.fulfill({ contentType: 'image/png', body: raster });
    return route.abort();
  });
  await page.addInitScript(() => {
    localStorage.setItem('opd-map-chrome', 'shown');
  });
  await page.goto(`${origin}/?e2e&u=north`, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-map').click();
  await page.waitForFunction(() => {
    const map = (window as unknown as { __opdMap?: MapHandle }).__opdMap;
    return !!map?.isStyleLoaded() && !!map.getSource('iss-track');
  });
  await page.waitForFunction(() => document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed') === 'true');
}

async function watchBearing(page: Page): Promise<void> {
  await page.evaluate(() => {
    const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
    const samples: number[] = [];
    map.__samples = samples;
    map.on('move', () => { samples.push(map.getBearing()); });
  });
}

async function samplesOf(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __opdMap: MapHandle }).__opdMap.__samples ?? []);
}

function fastestDegPerMs(samples: { bearing: number; at: number }[]): number {
  let rate = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = Math.max(1, samples[i]!.at - samples[i - 1]!.at);
    rate = Math.max(rate, Math.abs(samples[i]!.bearing - samples[i - 1]!.bearing) / dt);
  }
  return rate;
}

function snappedNorth(samples: number[]): boolean {
  let left = false;
  for (const bearing of samples) {
    if (Math.abs(bearing) > 15) left = true;
    if (left && Math.abs(bearing) < 1) return true;
  }
  return false;
}

for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
]) describe.skipIf(!existsSync(engine.executablePath))(`north follow ${engine.name}`, () => {
  let browser: Browser;
  beforeAll(async () => { browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath }); }, 30_000);
  afterAll(async () => { await browser?.close(); });

  it('eases to north while follow stays on', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      page.setDefaultTimeout(15_000);
      await openMap(page);
      await page.evaluate(() => {
        const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
        const orig = map.setCenter.bind(map);
        map.__centerAt = [];
        map.setCenter = (center) => {
          map.__centerAt!.push(performance.now());
          return orig(center);
        };
      });
      await page.waitForFunction(() => {
        const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
        const at = map.__centerAt ?? [];
        if (at.length === 0) return false;
        const age = performance.now() - at[at.length - 1]!;
        if (age < 780 || age > 900) return false;
        map.jumpTo({ bearing: 80 });
        document.getElementById('bearing-north')!.click();
        const samples: { bearing: number; at: number }[] = [];
        map.__samples = samples as unknown as number[];
        map.on('move', () => { samples.push({ bearing: map.getBearing(), at: performance.now() }); });
        return true;
      });
      await page.waitForTimeout(1100);
      const end = await page.evaluate(() => {
        const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
        return {
          bearing: map.getBearing(),
          moving: map.isMoving(),
          samples: (map.__samples ?? []) as unknown as { bearing: number; at: number }[],
        };
      });
      const pressed = await page.locator('#toggle-follow-iss').getAttribute('aria-pressed');
      const rate = fastestDegPerMs(end.samples);
      expect(Math.abs(end.samples[0]?.bearing ?? 0), `first ${end.samples[0]?.bearing}`).toBeGreaterThan(20);
      expect(Math.abs(end.bearing), `end ${end.bearing} rate ${rate}`).toBeLessThan(0.01);
      expect(end.moving).toBe(false);
      expect(rate, `rate ${rate} over ${end.samples.length} moves`).toBeLessThan(0.5);
      expect(pressed).toBe('true');
    } finally {
      await page.close();
    }
  }, 30_000);

  it('a right-drag across a follow tick does not snap north', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      page.setDefaultTimeout(15_000);
      await openMap(page);
      await page.locator('#bearing-north').click();
      await page.waitForFunction(() => {
        const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
        return !map.isMoving() && Math.abs(map.getBearing()) < 0.01;
      });
      await watchBearing(page);
      const canvas = page.locator('#map .maplibregl-canvas');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('map canvas has no box');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down({ button: 'right' });
      for (let i = 1; i <= 14; i++) {
        await page.mouse.move(x + i * 16, y, { steps: 2 });
        await page.waitForTimeout(90);
      }
      await page.mouse.up({ button: 'right' });
      const samples = await samplesOf(page);
      const pressed = await page.locator('#toggle-follow-iss').getAttribute('aria-pressed');
      const end = Math.abs(samples[samples.length - 1] ?? 0);
      expect(snappedNorth(samples), `min after leaving north ${Math.min(...samples.map(Math.abs))} end ${end}`).toBe(false);
      expect(pressed).toBe('false');
      expect(end).toBeGreaterThan(20);
    } finally {
      await page.close();
    }
  }, 30_000);

  it('a keyboard rotate across a follow tick does not snap north', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      page.setDefaultTimeout(15_000);
      await openMap(page);
      await page.locator('#bearing-north').click();
      await page.waitForFunction(() => {
        const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
        return !map.isMoving() && Math.abs(map.getBearing()) < 0.01;
      });
      await watchBearing(page);
      await page.locator('#map .maplibregl-canvas').focus();
      await page.keyboard.down('Shift');
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(160);
      }
      await page.keyboard.up('Shift');
      await page.waitForTimeout(400);
      const samples = await samplesOf(page);
      const pressed = await page.locator('#toggle-follow-iss').getAttribute('aria-pressed');
      const end = Math.abs(samples[samples.length - 1] ?? 0);
      expect(snappedNorth(samples), `end ${end} n ${samples.length}`).toBe(false);
      expect(pressed).toBe('false');
      expect(end).toBeGreaterThan(5);
    } finally {
      await page.close();
    }
  }, 30_000);

  it('keeps a smooth north retarget when a follow tick lands inside it', async () => {
    const reps: { end: number; moving: boolean; rate: number; pressed: string | null; first: number; error?: string }[] = [];
    for (let rep = 0; rep < 12; rep += 1) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        page.setDefaultTimeout(15_000);
        await openMap(page);
        await page.waitForFunction(() => {
          const map = (window as unknown as { __opdMap?: MapHandle }).__opdMap;
          return !!map && !map.isMoving();
        });
        await page.evaluate(() => {
          const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
          const orig = map.setCenter.bind(map);
          map.__centerAt = [];
          map.setCenter = (center) => {
            map.__centerAt!.push(performance.now());
            return orig(center);
          };
        });
        await page.waitForFunction(() => {
          const map = (window as unknown as { __opdMap: MapHandle & { __retargeted?: boolean } }).__opdMap;
          if (map.__retargeted) return true;
          const at = map.__centerAt ?? [];
          if (at.length === 0) return false;
          const age = performance.now() - at[at.length - 1]!;
          if (age < 400 || age > 560) return false;
          map.__retargeted = true;
          map.jumpTo({ bearing: map.getBearing() + 90 });
          document.getElementById('bearing-iss')!.click();
          document.getElementById('bearing-north')!.click();
          const samples: { bearing: number; at: number }[] = [];
          map.__samples = samples as unknown as number[];
          map.on('move', () => { samples.push({ bearing: map.getBearing(), at: performance.now() }); });
          return true;
        });
        await page.waitForTimeout(1100);
        const end = await page.evaluate(() => {
          const map = (window as unknown as { __opdMap: MapHandle }).__opdMap;
          return {
            bearing: map.getBearing(),
            moving: map.isMoving(),
            samples: (map.__samples ?? []) as unknown as { bearing: number; at: number }[],
          };
        });
        const pressed = await page.locator('#toggle-follow-iss').getAttribute('aria-pressed');
        reps.push({
          end: end.bearing,
          moving: end.moving,
          rate: fastestDegPerMs(end.samples),
          pressed,
          first: end.samples[0]?.bearing ?? 0,
        });
      } catch (error) {
        reps.push({ end: Number.NaN, moving: true, rate: 99, pressed: null, first: 0, error: String(error) });
      } finally {
        await page.close();
      }
    }
    const pass = reps.filter((rep) => !rep.error && Math.abs(rep.first) > 20 && Math.abs(rep.end) < 0.01 && !rep.moving && rep.rate < 0.5 && rep.pressed === 'true').length;
    console.log(`NORTH_RETARGET_REPS ${engine.name} ${pass}/12 ${JSON.stringify(reps)}`);
    expect(pass, JSON.stringify(reps, null, 2)).toBe(12);
  }, 300_000);
});
