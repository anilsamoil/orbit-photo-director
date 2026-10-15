import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tleEpochMs } from '../src/iss-sgp4';
import fixture from './fixtures/iss-sgp4-fixture.json';

const root = resolve(process.env.OPD_INSPECTOR_SOURCE_ROOT || resolve(__dirname, '..'));
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve(root, 'public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const manifest = {
  version: 'repin', generated_at: fixture.start, tle_epoch: new Date(tleEpochMs(fixture.tle)!).toISOString(),
  cloud_composite_hour: fixture.start, target_data_version: 'repin', build_version: 'repin',
  freshness: { tle_hours: 0, cloud_hours: 0, ok: true },
  artifacts: Object.fromEntries(['passes', 'track', 'status', 'top5', 'top_24h', 'cupola_windows'].map((key) => [key, { path: `${key}.json`, sha256: '', bytes: 0 }])),
};
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const origin = 'http://inspector.test';
type Insets = { top: number; right: number; bottom: number; left: number };
async function emulateInsets(page: Page, insets: Insets): Promise<void> {
  await page.addInitScript((values) => {
    const replace = (value: string) => value.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof typeof values) => `${values[side]}px`);
    const proto = CSSStyleDeclaration.prototype;
    for (const key of ['cssText', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'width', 'height']) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (descriptor?.set) Object.defineProperty(proto, key, { ...descriptor, set(value: string) { descriptor.set!.call(this, replace(value)); } });
    }
    const set = proto.setProperty;
    proto.setProperty = function (name, value, priority) { return set.call(this, name, value === null ? value : replace(value), priority); };
    const append = Node.prototype.appendChild;
    Node.prototype.appendChild = function <T extends Node>(child: T): T {
      if (child instanceof HTMLElement && child.style.cssText.includes('safe-area-inset-')) child.style.cssText = replace(child.style.cssText);
      return append.call(this, child) as T;
    };
  }, insets);
}


const longHeading = 'INTERNATIONALSPACESTATIONZARYAEXPEDITIONINTERNATIONALSPACEST';
const insets: Insets = { top: 24, right: 0, bottom: 20, left: 47 };
let assets: Map<string, string | Uint8Array>;
let script: string;
beforeAll(async () => {
  const output = await build({
    configFile: false, root, logLevel: 'silent', define: { __APP_VERSION__: JSON.stringify('inspector-test') },
    build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'inspector', formats: ['iife'] } },
  });
  const bundle = Array.isArray(output) ? output[0]! : output;
  if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
  assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
  script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
}, 60_000);

async function inspectorGeometry(page: Page, heading: string) {
  return page.locator('.pin-pass-heading').filter({ hasText: heading }).first().evaluate((element) => {
    const popup = element.closest('.maplibregl-popup-content')!;
    const scroll = popup as HTMLElement;
    scroll.scrollTop += element.getBoundingClientRect().top - popup.getBoundingClientRect().top - parseFloat(getComputedStyle(popup).paddingTop);
    const bounds = popup.getBoundingClientRect();
    const texts = (target: Element) => {
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      const rects: ReturnType<DOMRect['toJSON']>[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        rects.push(...[...range.getClientRects()].filter((rect) => rect.width && rect.height).map((rect) => rect.toJSON()));
      }
      return rects;
    };
    const row = element.nextElementSibling!.querySelector('.pin-pass-row')!;
    const targets = [...popup.querySelectorAll('button, input, a')].flatMap((target) => {
      const rect = target.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) return [];
      return [{ name: target.className, rect: rect.toJSON() }];
    });
    return { popup: bounds.toJSON(), heading: texts(element), row: texts(row), firstRow: row.getBoundingClientRect().toJSON(), targets };
  });
}

for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
]) describe.skipIf(!existsSync(engine.executablePath))(`picker inspector safe insets ${engine.name}`, () => {
  let browser: Browser;
  beforeAll(async () => { browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  it.each(['ISS', longHeading])('keeps rendered %s heading, first pass and exposed targets inside safe insets after native picker click', async (heading) => {
    const context = await browser.newContext({ viewport: { width: 719, height: 521 }, serviceWorkers: 'block', hasTouch: true });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const cdp = engine.name === 'Chrome' ? await context.newCDPSession(page) : null;
      if (cdp) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
      else await emulateInsets(page, insets);
      await page.clock.setFixedTime(new Date(fixture.start));
      const css = cdp ? stylesheet : stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof Insets) => `${insets[side]}px`);
      await page.route('**/*', async (route) => {
        if (new URL(route.request().url()).hostname === 'celestrak.org') {

          return route.fulfill({ contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: `${heading}\n${fixture.tle.line1}\n${fixture.tle.line2}` });
        }
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html.replace('</head>', `<style>${vendor}\n${css}</style></head>`).replace('</body>', `<script src="/${script}"></script></body>`) });
        const asset = assets.get(url.pathname);
        if (url.origin === origin && asset !== undefined) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: typeof asset === 'string' ? asset : Buffer.from(asset) });
        if (url.pathname === '/manifest.json') return route.fulfill({ json: manifest });
        if (['/passes.json', '/top5.json', '/top_24h.json', '/cupola_windows.json'].includes(url.pathname)) return route.fulfill({ json: [] });
        if (url.pathname === '/status.json') return route.fulfill({ json: { last_run: fixture.start, tick_minutes: 30, tle_age_hours: 0, tle_freshness_factor: 1, cloud_source: 'gibs', cloud_composite_hour: fixture.start, target_count: 0, pass_count: 0, version: 'repin', build_version: 'repin' } });
        if (url.pathname === '/api/browser/session') return route.fulfill({ json: { ok: true, profile: { name: 'repin', displayName: 'Local fixture' } } });
        if (url.pathname.startsWith('/api/browser/profiles/')) return route.fulfill({ json: { ok: true, count: 0, targets: [] } });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
        if (url.pathname === '/track.json') return route.fulfill({ json: { ...fixture, tle_epoch: manifest.tle_epoch, tle_age_hours: 0, tle_freshness_factor: 1 } });
        if (/\.(png|jpe?g)$/.test(url.pathname) || url.pathname.includes('/MapServer/tile/')) return route.fulfill({ contentType: 'image/png', body: raster });
        return route.abort();
      });
      await page.addInitScript((name) => {
        localStorage.setItem('opd-map-chrome', 'hidden');
        if (name !== 'ISS') localStorage.setItem('opd-selected-satellites', JSON.stringify([`name:${name}`]));
        Object.defineProperty(navigator, 'standalone', { get: () => true });
        const events: { type: string; trusted: boolean; target: string }[] = [];
        (window as unknown as { __inspectorEvents: typeof events }).__inspectorEvents = events;
        for (const type of ['pointerdown', 'pointerup', 'click', 'contextmenu']) document.addEventListener(type, (event) => {
          const element = event.target as Element;
          events.push({ type, trusted: event.isTrusted, target: element.id || element.className || element.tagName });
        }, true);
      }, heading);
      await page.goto(`${origin}/?e2e&u=repin`, { waitUntil: 'domcontentloaded' });
      await page.locator('#tab-map').click();
      await page.waitForFunction(() => {
        const map = (window as unknown as { __opdMap?: import('maplibre-gl').Map }).__opdMap;
        return map?.isStyleLoaded() && !!map.getSource('iss-track');
      });
      await page.evaluate(() => document.fonts.ready);
      const appliedInsets = await page.evaluate(() => {
        const probe = document.createElement('div');
        for (const side of ['top', 'right', 'bottom', 'left']) probe.style.setProperty(`padding-${side}`, `env(safe-area-inset-${side}, 0px)`);
        document.body.appendChild(probe);
        const css = getComputedStyle(probe);
        const values = { top: parseFloat(css.paddingTop), right: parseFloat(css.paddingRight), bottom: parseFloat(css.paddingBottom), left: parseFloat(css.paddingLeft) };
        probe.remove(); return values;
      });
      expect(appliedInsets).toEqual(insets);
      await page.locator('#map-chrome-toggle').click();
      if (await page.locator('#toggle-follow-iss').getAttribute('aria-pressed') === 'true') await page.locator('#toggle-follow-iss').click();
      await page.locator('#bearing-north').click();
      await page.locator('#map-chrome-toggle').click();
      await page.waitForFunction(() => {
        const map = (window as unknown as { __opdMap: import('maplibre-gl').Map }).__opdMap;
        return !map.isMoving() && Math.abs(map.getBearing()) < .01;
      });
      if (heading !== 'ISS') await page.waitForFunction((name) => {
        const map = (window as unknown as { __opdMap: import('maplibre-gl').Map }).__opdMap;
        return Object.keys(map.getStyle().sources).some((key) => key.endsWith(`name:${name}`));
      }, heading);
      await page.evaluate(() => (window as unknown as { __opdMap: import('maplibre-gl').Map }).__opdMap.jumpTo({ center: [-90, 40], zoom: 3 }));
      await page.waitForTimeout(400);
      const seed = await page.locator('.maplibregl-canvas').evaluate((canvas) => {
        const r = canvas.getBoundingClientRect();
        for (const fx of [.5, .3, .6]) for (const fy of [.5, .35, .65]) {
          const x = r.x + r.width * fx, y = r.y + r.height * fy;
          if (document.elementFromPoint(x, y) === canvas) return { x, y };
        }
        throw new Error('No owned canvas seed point');
      });
      await page.mouse.click(seed.x, seed.y, { button: 'right' });
      await page.locator('.dropped-pin-popup').waitFor({ state: 'attached' });
      await page.locator('#map-chrome-toggle').click();
      await page.locator('#map-legend-toggle').click();
      await page.waitForTimeout(500);
      const before = await inspectorGeometry(page, heading);
      await page.locator('#toggle-satellite-picker').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const opener = await page.locator('#toggle-satellite-picker').evaluate((element) => {
        const r = element.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, owns: hit === element || !!hit && element.contains(hit) };
      });
      expect(opener.owns).toBe(true);
      await page.mouse.click(opener.x, opener.y);
      await page.locator('#satellite-picker-panel:not([hidden])').waitFor();
      await page.waitForTimeout(500);
      const after = await inspectorGeometry(page, heading);
      const events = await page.evaluate(() => (window as unknown as { __inspectorEvents: { type: string; trusted: boolean; target: string }[] }).__inspectorEvents);
      const evidence = { engine: engine.name, heading, viewport: { width: 719, height: 521 }, insets, appliedInsets, before, opener, after, events };
      if (process.env.OPD_INSPECTOR_EVIDENCE_DIR) {
        mkdirSync(process.env.OPD_INSPECTOR_EVIDENCE_DIR, { recursive: true });
        const path = resolve(process.env.OPD_INSPECTOR_EVIDENCE_DIR, `${engine.name.toLowerCase()}-${heading === 'ISS' ? 'ordinary' : 'long'}`);
        writeFileSync(`${path}.json`, JSON.stringify(evidence, null, 2));
        await page.screenshot({ path: `${path}.png` });
      }
      expect.soft(events.every((event) => event.trusted), JSON.stringify(events)).toBe(true);
      expect.soft(events.some((event) => event.type === 'contextmenu' && event.target === 'maplibregl-canvas')).toBe(true);
      expect.soft(events.some((event) => event.type === 'click' && event.target === 'toggle-satellite-picker')).toBe(true);
      for (const phase of [before, after]) {
        expect.soft(phase.heading.length).toBeGreaterThan(0);
        expect.soft(phase.row.length).toBeGreaterThan(0);
        const content = [...phase.heading, ...phase.row];
        const exposed = [...content, ...phase.targets.map((target) => target.rect)];
        expect.soft(exposed.filter((rect) => rect.left < insets.left || rect.right > 719 - insets.right)).toEqual([]);
        expect.soft(content.filter((rect) => rect.top < insets.top || rect.bottom > 521 - insets.bottom)).toEqual([]);
        expect.soft(phase.firstRow.bottom, JSON.stringify(evidence)).toBeLessThanOrEqual(phase.popup.bottom);
      }
    } finally { await context.close(); }
  }, 30_000);
});
