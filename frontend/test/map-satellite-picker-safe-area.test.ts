import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixtures/iss-sgp4-fixture.json';

const root = resolve(__dirname, '..');
const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const stylesheet = readFileSync(resolve(root, 'src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve(root, 'public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const manifest = {
  version: 'repin', generated_at: fixture.start, tle_epoch: fixture.start,
  cloud_composite_hour: fixture.start, target_data_version: 'repin', build_version: 'repin',
  freshness: { tle_hours: 0, cloud_hours: 0, ok: true },
  artifacts: Object.fromEntries(['passes', 'track', 'status', 'top5', 'top_24h', 'cupola_windows'].map((key) => [key, { path: `${key}.json`, sha256: '', bytes: 0 }])),
};
const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg5+L9DwABWAEegV7pegAAAABJRU5ErkJggg==', 'base64');
const origin = 'http://picker.test';
type Insets = { top: number; right: number; bottom: number; left: number };
async function emulateInsets(page: Page, insets: Insets): Promise<void> {
  await page.addInitScript((values) => {
    const replace = (value: string) => value.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof typeof values) => `${values[side]}px`);
    const proto = CSSStyleDeclaration.prototype;
    for (const key of ['cssText', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
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

const expanded = process.env.OPD_PICKER_MATRIX === '1';
const sizes = expanded ? [[402, 874], [874, 402], [834, 1210], [1210, 834], [768, 1024], [1024, 768], [719, 521], [720, 500], [800, 600], [1440, 900]] : [[800, 600]];
const insetSets: Insets[] = expanded ? [{ top: 0, right: 0, bottom: 0, left: 0 }, { top: 24, right: 0, bottom: 34, left: 47 }, { top: 24, right: 0, bottom: 20, left: 47 }] : [{ top: 24, right: 0, bottom: 20, left: 47 }];
const actions = [
  { name: 'typed NORAD Add', key: '48274', selector: '#satellite-picker-add', query: 'CATNR=48274' },
  { name: 'X-37B label', key: 'name:USA', selector: '#satellite-picker-list label:nth-child(3)', query: 'NAME=USA' },
  { name: 'Starship label', key: 'name:STARSHIP', selector: '#satellite-picker-list label:nth-child(4)', query: 'NAME=STARSHIP' },
];

const cases = sizes.flatMap(([width, height]) => insetSets.flatMap((insets) => actions.map((action) => ({ ...action, width: width!, height: height!, insets, name: `${width}×${height} B${insets.bottom}: ${action.name}` }))));

async function geometry(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const r = element.getBoundingClientRect();
    const clipped = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(innerWidth, r.right), bottom: Math.min(innerHeight, r.bottom) };
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (/hidden|auto|scroll|clip/.test(style.overflowX)) { clipped.left = Math.max(clipped.left, box.left); clipped.right = Math.min(clipped.right, box.right); }
      if (/hidden|auto|scroll|clip/.test(style.overflowY)) { clipped.top = Math.max(clipped.top, box.top); clipped.bottom = Math.min(clipped.bottom, box.bottom); }
    }
    const points = [[r.x + r.width / 2, r.y + r.height / 2], [r.left + 2, r.y + r.height / 2], [r.right - 2, r.y + r.height / 2], [r.x + r.width / 2, r.top + 2], [r.x + r.width / 2, r.bottom - 2]].map(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return { x: x!, y: y!, owns: hit === element || !!hit && element.contains(hit), hit: hit?.id || hit?.className || hit?.tagName };
    });
    return { rect: r.toJSON(), clipped, fullyVisible: clipped.left <= r.left && clipped.top <= r.top && clipped.right >= r.right && clipped.bottom >= r.bottom, points };
  });
}

for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
].filter((engine) => !process.env.OPD_PICKER_ENGINE || engine.name === process.env.OPD_PICKER_ENGINE)) describe.skipIf(!existsSync(engine.executablePath))(`trusted satellite picker ${engine.name}`, () => {
  let browser: Browser;
  let assets: Map<string, string | Uint8Array>;
  let script: string;
  beforeAll(async () => {
    const output = await build({
      configFile: false, root, logLevel: 'silent', define: { __APP_VERSION__: JSON.stringify('repin-test') },
      build: { write: false, minify: false, lib: { entry: resolve(root, 'src/main.ts'), name: 'repin', formats: ['iife'] } },
    });
    const bundle = Array.isArray(output) ? output[0]! : output;
    if (!('output' in bundle)) throw new Error('Expected one in-memory browser bundle');
    assets = new Map(bundle.output.map((item) => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]));
    script = bundle.output.find((item) => item.type === 'chunk' && item.isEntry)!.fileName;
    browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath });
  }, 60_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  it.each(cases)('keeps $name reachable by native input', async ({ name, key, selector, query, width, height, insets }) => {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const cdp = engine.name === 'Chrome' ? await context.newCDPSession(page) : null;
      if (cdp) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
      else await emulateInsets(page, insets);
      await page.clock.setFixedTime(new Date(fixture.start));
      const css = cdp ? stylesheet : stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof Insets) => `${insets[side]}px`);
      const requests: string[] = [];
      await page.route('**/*', async (route) => {
        if (new URL(route.request().url()).hostname === 'celestrak.org') {
          requests.push(route.request().url());
          return route.fulfill({ contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: `LOCAL FIXTURE\n${fixture.tle.line1}\n${fixture.tle.line2}` });
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
        if (url.pathname === '/track.json') return route.fulfill({ json: { ...fixture, tle_epoch: fixture.start, tle_age_hours: 0, tle_freshness_factor: 1 } });
        if (/\.(png|jpe?g)$/.test(url.pathname) || url.pathname.includes('/MapServer/tile/')) return route.fulfill({ contentType: 'image/png', body: raster });
        return route.abort();
      });
      await page.addInitScript((start) => {
        localStorage.setItem('opd-map-chrome', 'shown');
        const at = new Date(Date.parse(start) + 60 * 60 * 1000).toISOString();
        const shot = JSON.stringify([{ key: `picker|${at}`, target_id: 'picker', target_name: 'Picker fixture', closest_approach: at }]);
        localStorage.setItem('opd_shotlist_v1:repin', shot);
        localStorage.setItem('opd_shotlist_v1', shot);
        Object.defineProperty(navigator, 'standalone', { get: () => true });
      }, fixture.start);
      await page.goto(`${origin}/?e2e&u=repin`, { waitUntil: 'domcontentloaded' });
      await page.locator('#tab-map').click();
      await page.waitForFunction(() => {
        const map = (window as unknown as { __opdMap?: import('maplibre-gl').Map }).__opdMap;
        return map?.isStyleLoaded() && !!map.getSource('iss-track');
      });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.body.classList.contains('shotlist-bar-visible'));
      await page.evaluate(() => {
        const banner = document.querySelector('#status-banner')!;
        banner.className = 'banner banner-red';
        const copy = '<p class="banner-copy">Orbit data ready · verify fixture</p><div class="banner-actions"><a class="banner-action" role="button" tabindex="0">Sign in</a><button class="banner-action">Reload</button></div>';
        const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;
        const apply = () => { banner.innerHTML = copy; };
        Object.defineProperty(banner, 'textContent', { configurable: true, get() { return descriptor.get!.call(this); }, set() { apply(); } });
        apply();
        const legend = document.querySelector<HTMLButtonElement>('#map-legend-toggle')!;
        if (legend.getAttribute('aria-expanded') !== 'true') legend.click();
        const launch = document.querySelector<HTMLButtonElement>('#filter-launches-map')!;
        if (launch.getAttribute('aria-pressed') === 'true') launch.click();
      });
      await page.waitForFunction(() => /\d{2}:\d{2}Z/.test(document.querySelector('#time-back-90 [data-time-utc]')?.textContent || ''));
      await page.evaluate(() => (window as unknown as { __opdSyncMapChrome: () => void }).__opdSyncMapChrome());
      await page.waitForTimeout(500);
      const appliedInsets = await page.evaluate(() => {
        const probe = document.createElement('div');
        for (const side of ['top', 'right', 'bottom', 'left']) probe.style.setProperty(`padding-${side}`, `env(safe-area-inset-${side}, 0px)`);
        document.body.appendChild(probe);
        const style = getComputedStyle(probe);
        const values = { top: parseFloat(style.paddingTop), right: parseFloat(style.paddingRight), bottom: parseFloat(style.paddingBottom), left: parseFloat(style.paddingLeft) };
        probe.remove(); return values;
      });
      expect(appliedInsets).toEqual(insets);
      await page.locator('#toggle-satellite-picker').evaluate((element) => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (!/auto|scroll/.test(style.overflowX + style.overflowY)) continue;
          const r = element.getBoundingClientRect(), box = parent.getBoundingClientRect();
          if (r.left < box.left) parent.scrollLeft -= Math.ceil(box.left - r.left);
          if (r.right > box.right) parent.scrollLeft += Math.ceil(r.right - box.right);
          if (r.top < box.top) parent.scrollTop -= Math.ceil(box.top - r.top);
          if (r.bottom > box.bottom) parent.scrollTop += Math.ceil(r.bottom - box.bottom);
        }
      });
      await page.waitForTimeout(2800);
      await page.evaluate(() => {
        const events: { type: string; target: string; trusted: boolean }[] = [];
        (window as unknown as { __pickerEvents: typeof events }).__pickerEvents = events;
        for (const type of ['click', 'input', 'change']) document.addEventListener(type, (event) => events.push({ type, target: (event.target as HTMLElement).id || (event.target as HTMLElement).tagName, trusted: event.isTrusted }), true);
      });
      const opener = await geometry(page, '#toggle-satellite-picker');
      expect(opener.points[4]!.owns, JSON.stringify(opener)).toBe(true);
      await page.mouse.click(opener.points[4]!.x, opener.points[4]!.y);
      await page.waitForSelector('#satellite-picker-panel:not([hidden])');
      await page.waitForTimeout(400);
      const noPickerScroll = width === 800 && height === 600 && insets.bottom === 20;
      const expose = async (selector: string) => {
        if (noPickerScroll) return;
        const changed = await page.locator(selector).evaluate((element) => {
          const panel = document.querySelector('#satellite-picker-panel')!;
          const r = element.getBoundingClientRect(), box = panel.getBoundingClientRect(), before = panel.scrollTop;
          if (r.top < box.top + 2) panel.scrollTop -= Math.ceil(box.top + 2 - r.top);
          if (r.bottom > box.bottom - 2) panel.scrollTop += Math.ceil(r.bottom - box.bottom + 2);
          return before !== panel.scrollTop;
        });
        if (changed) await page.waitForTimeout(2800);
      };
      if (key === '48274') {
        await expose('#satellite-picker-input');
        const input = await geometry(page, '#satellite-picker-input');
        await page.mouse.click(input.points[0]!.x, input.points[0]!.y);
        await page.keyboard.type('48274');
      }
      await expose(selector);
      const target = await geometry(page, selector);
      const before = await page.evaluate(() => ({
        scrollTop: document.querySelector('#satellite-picker-panel')!.scrollTop,
        selected: localStorage.getItem('opd-selected-satellites'),
        time: (document.querySelector('#time-slider') as HTMLInputElement).value,
        boxes: Object.fromEntries(['#satellite-picker-panel', '.map-control-dock', '.map-controls-time', '#map-legend-panel', '#status-banner', '#shotlist-bar'].map((selector) => {
          const element = document.querySelector(selector)!;
          return [selector, { rect: element.getBoundingClientRect().toJSON(), scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }];
        })),
      }));
      await page.mouse.click(target.points[0]!.x, target.points[0]!.y);
      await page.waitForTimeout(600);
      const after = await page.evaluate((selector) => ({
        hidden: (document.querySelector('#satellite-picker-panel') as HTMLElement).hidden,
        selected: localStorage.getItem('opd-selected-satellites'),
        value: (document.querySelector('#satellite-picker-input') as HTMLInputElement).value,
        checked: document.querySelector<HTMLInputElement>(`${selector} input`)?.checked,
        status: document.querySelector('#satellite-picker-status')!.textContent,
        time: (document.querySelector('#time-slider') as HTMLInputElement).value,
        events: (window as unknown as { __pickerEvents: { type: string; target: string; trusted: boolean }[] }).__pickerEvents,
      }), selector);
      const evidence = { engine: engine.name, name, viewport: { width, height }, insets, opener, target, before, after, requests };
      if (process.env.OPD_PICKER_EVIDENCE_DIR) {
        mkdirSync(process.env.OPD_PICKER_EVIDENCE_DIR, { recursive: true });
        const path = resolve(process.env.OPD_PICKER_EVIDENCE_DIR, `${engine.name.toLowerCase()}-${width}x${height}-b${insets.bottom}-${key.replace(/[^a-zA-Z0-9-]/g, '_')}`);
        writeFileSync(`${path}.json`, JSON.stringify(evidence, null, 2));
        await page.screenshot({ path: `${path}.png` });
      }
      if (noPickerScroll) expect.soft(before.scrollTop).toBe(0);
      expect.soft(before.selected).toBeNull();
      expect.soft(target.fullyVisible, JSON.stringify(target)).toBe(true);
      expect.soft(target.points.map((point) => point.owns), JSON.stringify(evidence)).toEqual([true, true, true, true, true]);
      expect.soft(requests).toHaveLength(1);
      expect.soft(requests[0]).toContain(query);
      expect.soft(after.selected).toBe(JSON.stringify([key]));
      expect.soft(after.hidden).toBe(false);
      expect.soft(after.status).toBe('Tracking added');
      expect.soft(after.time).toBe(before.time);
      expect.soft(after.events.every((event) => event.trusted)).toBe(true);
      expect.soft(after.events.filter((event) => event.type === 'click').length).toBeGreaterThanOrEqual(key === '48274' ? 3 : 2);
      if (key === '48274') expect.soft(after.value).toBe('');
      else expect.soft(after.checked).toBe(true);
      if (process.env.OPD_PICKER_IDLE === '1' && after.selected === JSON.stringify([key])) {
        const idle = async () => page.evaluate(async () => {
          const records: { name: string | null; value: string | null }[] = [];
          const observer = new MutationObserver((batch) => records.push(...batch.map((record) => ({ name: record.attributeName, value: document.body.getAttribute(record.attributeName!) }))));
          observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          observer.disconnect();
          return { records, classes: document.body.className };
        });
        const open = await idle();
        const closeTarget = await geometry(page, '#map-legend-toggle');
        expect(closeTarget.points[4]!.owns).toBe(true);
        await page.mouse.click(closeTarget.points[4]!.x, closeTarget.points[4]!.y);
        await page.waitForTimeout(500);
        const closed = await idle();
        expect.soft(open.records).toEqual([]);
        expect.soft(closed.records).toEqual([]);
        expect.soft(closed.classes).not.toContain('map-slot-picker');
        expect.soft(await page.locator('#satellite-picker-panel').getAttribute('hidden')).not.toBeNull();
        if (process.env.OPD_PICKER_EVIDENCE_DIR) writeFileSync(resolve(process.env.OPD_PICKER_EVIDENCE_DIR, `${engine.name.toLowerCase()}-${key.replace(/[^a-zA-Z0-9-]/g, '_')}-idle.json`), JSON.stringify({ open, closed }, null, 2));
      }
    } finally { await context.close(); }
  }, process.env.OPD_PICKER_IDLE === '1' ? 60_000 : 30_000);
});
