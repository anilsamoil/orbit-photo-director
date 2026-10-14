import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixtures/iss-sgp4-fixture.json';

const root = resolve(process.env.OPD_TIME_SOURCE_ROOT ?? resolve(__dirname, '..'));
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
const origin = 'http://repin.test';
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


const sizes = process.env.OPD_TIME_SIZES ? process.env.OPD_TIME_SIZES.split(',').map((size) => size.split('x').map(Number)) : process.env.OPD_TIME_MATRIX === '1'
  ? [[390, 520], [402, 874], [874, 402], [834, 1210], [1210, 834], [768, 1024], [1024, 768], [568, 320], [719, 521], [720, 500], [800, 600], [1440, 900]]
  : [[390, 520], [568, 320], [800, 600]];
const insetSets: Insets[] = [
  { top: 0, right: 0, bottom: 0, left: 0 },
  { top: 24, right: 0, bottom: 34, left: 47 },
  { top: 24, right: 0, bottom: 20, left: 47 },
];
const cases = sizes.flatMap(([width, height]) => insetSets.map((insets) => ({ width: width!, height: height!, insets, name: `${width}x${height} B${insets.bottom}` })));
const selectors = ['#time-back-90', '#time-back-45', '#time-now', '#time-fwd-45', '#time-fwd-90'];
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
]) describe.skipIf(!existsSync(engine.executablePath))(`trusted time controls ${engine.name}`, () => {
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


  it.each(cases)('keeps every time step onscreen and out of the banner at $name', async ({ name, width, height, insets }) => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const cdp = engine.name === 'Chrome' ? await context.newCDPSession(page) : null;
      if (cdp) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
      else await emulateInsets(page, insets);
      await page.clock.setFixedTime(new Date(fixture.start));
      const css = cdp ? stylesheet : stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof Insets) => `${insets[side]}px`);
      await page.route('**/*', async (route) => {
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
      await page.addInitScript(() => localStorage.setItem('opd-map-chrome', 'shown'));
      await page.goto(`${origin}/?e2e&u=repin`, { waitUntil: 'domcontentloaded' });
      await page.locator('#tab-map').click();
      await page.waitForFunction(() => {
        const map = (window as unknown as { __opdMap?: import('maplibre-gl').Map }).__opdMap;
        return map?.isStyleLoaded() && !!map.getSource('iss-track');
      });
      await page.evaluate(() => document.fonts.ready);
      const appliedInsets = await page.evaluate(() => {
        const probe = document.createElement('div');
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) probe.style.setProperty(`padding-${side.toLowerCase()}`, `env(safe-area-inset-${side.toLowerCase()}, 0px)`);
        document.body.appendChild(probe);
        const css = getComputedStyle(probe);
        const values = { top: parseFloat(css.paddingTop), right: parseFloat(css.paddingRight), bottom: parseFloat(css.paddingBottom), left: parseFloat(css.paddingLeft) };
        probe.remove(); return values;
      });
      expect(appliedInsets).toEqual(insets);

      if (process.env.OPD_TIME_LEGEND === '1') await page.locator('#map-legend-toggle').click();
      await page.waitForTimeout(250);
      for (const banner of ['initial', 'plain', 'actions', 'long']) {
        if (banner !== 'initial') await page.evaluate((variant) => {
          const state = window as unknown as { __timeBannerObserver?: MutationObserver };
          state.__timeBannerObserver?.disconnect();
          const element = document.querySelector('#status-banner')!;
          const content = variant === 'plain' ? 'Orbit data ready' : `<p class="banner-copy">${variant === 'long' ? 'SIGN IN AGAIN. The session ended while disconnected. Reconnect to restore the latest orbit predictions, then sign in again to synchronize your selected photography targets and shot list.' : 'Sign in to refresh'}</p><div class="banner-actions"><button class="banner-action">Sign in</button><button class="banner-action">Reload</button></div>`;
          const apply = () => {
            if (element.className !== 'banner banner-red') element.className = 'banner banner-red';
            if (element.innerHTML !== content) element.innerHTML = content;
          };
          apply();
          state.__timeBannerObserver = new MutationObserver(apply);
          state.__timeBannerObserver.observe(element, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
        }, banner);
        await page.waitForTimeout(150);
        const buttons = await Promise.all(selectors.map(async (selector) => ({ selector, ...await geometry(page, selector) })));
        const boxes = await page.evaluate(() => {
          const time = document.querySelector('.map-controls-time')!.getBoundingClientRect();
          const strip = document.querySelector('.map-command')!.getBoundingClientRect();
          const banner = document.querySelector('#status-banner')!.getBoundingClientRect();
          return {
            time: time.toJSON(), strip: strip.toJSON(), banner: banner.toJSON(), bannerText: document.querySelector('#status-banner')!.textContent,
            stripOverlap: Math.max(0, Math.min(strip.right, banner.right) - Math.max(strip.left, banner.left)) * Math.max(0, Math.min(strip.bottom, banner.bottom) - Math.max(strip.top, banner.top)),
            overlap: Math.max(0, Math.min(time.right, banner.right) - Math.max(time.left, banner.left)) * Math.max(0, Math.min(time.bottom, banner.bottom) - Math.max(time.top, banner.top)),
            scrollLeft: document.querySelector('.map-command')!.scrollLeft,
            classes: document.body.className,
            style: document.body.style.cssText,
            chrome: Object.fromEntries(['#map', '.map-toolbar', '.maplibregl-ctrl-top-left', '.map-control-dock', '#map-chrome-toggle', '#map-legend-toggle', '#map-legend-panel', '.time-slider-row', '#time-slider'].map((selector) => [selector, document.querySelector(selector)!.getBoundingClientRect().toJSON()])),
          };
        });
        await page.evaluate(() => {
          const events: { target: string; trusted: boolean }[] = [];
          (window as unknown as { __timeEvents: typeof events }).__timeEvents = events;
          document.addEventListener('click', (event) => {
            const target = (event.target as Element).closest('.time-step-btn');
            if (target) events.push({ target: target.id, trusted: event.isTrusted });
          }, true);
        });
        const actions = [];
        for (const [selector, expected] of [['#time-fwd-90', 90], ['#time-fwd-45', 135], ['#time-back-45', 90], ['#time-back-90', 0], ['#time-fwd-90', 90], ['#time-now', 0]] as const) {
          const target = await geometry(page, selector);
          await page.mouse.click(target.points[0]!.x, target.points[0]!.y);
          await page.waitForTimeout(40);
          const actual = Number(await page.locator('#time-slider').inputValue());
          actions.push({ selector, expected, actual, target });
          expect.soft(actual, `${name} ${banner} native ${selector}`).toBe(expected);
        }
        const events = await page.evaluate(() => (window as unknown as { __timeEvents: { target: string; trusted: boolean }[] }).__timeEvents);
        let idle = null;
        if (width === 568 && height === 320 && insets.bottom === 34 && banner === 'initial') {
          await page.waitForTimeout(300);
          idle = await page.evaluate(async () => {
            const records: { attribute: string | null; value: string | null }[] = [];
            const observer = new MutationObserver((batch) => records.push(...batch.map((record) => ({ attribute: record.attributeName, value: document.body.getAttribute(record.attributeName!) }))));
            observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
            const compact = document.body.classList.contains('map-slot-time-compact');
            await new Promise((resolve) => setTimeout(resolve, 10_000));
            observer.disconnect();
            return { compact, records };
          });
          expect.soft(idle.compact).toBe(true);
          expect.soft(idle.records).toEqual([]);
        }
        const sample = { banner, boxes, buttons, actions, events, idle };
        expect.soft(boxes.overlap, `${name} ${banner}: ${JSON.stringify(boxes)}`).toBe(0);
        expect.soft(boxes.stripOverlap, `${name} ${banner}: ${JSON.stringify(boxes)}`).toBe(0);
        expect.soft(boxes.scrollLeft).toBe(0);
        for (const button of buttons) {
          expect.soft(button.rect.width, `${name} ${banner} ${button.selector} width`).toBeGreaterThanOrEqual(44);
          expect.soft(button.rect.height, `${name} ${banner} ${button.selector} height`).toBeGreaterThanOrEqual(44);
          expect.soft(button.rect.left, `${name} ${banner} ${button.selector} safe left`).toBeGreaterThanOrEqual(insets.left);
          expect.soft(button.rect.right, `${name} ${banner} ${button.selector} safe right`).toBeLessThanOrEqual(width - insets.right);
          expect.soft(button.rect.top, `${name} ${banner} ${button.selector} safe top`).toBeGreaterThanOrEqual(insets.top);
          expect.soft(button.rect.bottom, `${name} ${banner} ${button.selector} safe bottom`).toBeLessThanOrEqual(height - insets.bottom);
          expect.soft(button.fullyVisible, `${name} ${banner} ${button.selector}: ${JSON.stringify(button)}`).toBe(true);
          expect.soft(button.points.map((point) => point.owns), `${name} ${banner} ${button.selector}: ${JSON.stringify(button)}`).toEqual([true, true, true, true, true]);
        }
        expect.soft(events).toHaveLength(6);
        expect.soft(events.every((event) => event.trusted)).toBe(true);
        if (process.env.OPD_TIME_EVIDENCE_DIR) {
          mkdirSync(process.env.OPD_TIME_EVIDENCE_DIR, { recursive: true });
          const path = resolve(process.env.OPD_TIME_EVIDENCE_DIR, `${engine.name.toLowerCase()}-${name.replaceAll(' ', '-')}-${banner}`);
          writeFileSync(`${path}.json`, JSON.stringify({ engine: engine.name, name, width, height, insets, sample }, null, 2));
          if (banner === 'initial' || boxes.overlap > 0 || boxes.stripOverlap > 0 || buttons.some((button) => !button.fullyVisible)) await page.screenshot({ path: `${path}.png` });
        }
      }
    } finally { await context.close(); }
  }, 45_000);
});
