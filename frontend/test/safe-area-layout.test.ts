import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser } from 'playwright';
import { transformWithEsbuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMapLaunchBrief } from '../src/launch-map-brief';
import { assessment, iso, launch, NOW, state } from './launch-fixtures';

const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const stylesheet = readFileSync(resolve('src/style.css'), 'utf8').replace(/url\('\/fonts\/([^']+)'\)/g, (_, name: string) => `url('data:font/woff2;base64,${readFileSync(resolve('public/fonts', name)).toString('base64')}')`);
const vendor = readFileSync(resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve('index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const source = `${readFileSync(resolve('src/chrome-slots.ts'), 'utf8')}\n${readFileSync(resolve('src/map-chrome.ts'), 'utf8').replace(/^import[^\n]+\n/, '')}`.replace(/\bexport /g, '');
function launchMarkup(): string {
  const container = document.createElement('div');
  renderMapLaunchBrief(container, state([launch({ launch_window: { net: iso(10), start: iso(10), end: iso(11), precision: 'Minute' }, assessment: assessment() })]), NOW, () => {});
  container.querySelector('details')!.open = true;
  return container.innerHTML;
}
for (const engine of [{ name: 'Chrome', type: chromium }, { name: 'WebKit', type: webkit }]) describe(`safe-area painted layout ${engine.name}`, () => {
  let browser: Browser;
  let ownerScript: string;
  beforeAll(async () => {
    ownerScript = (await transformWithEsbuild(source, 'chrome-owner.ts', { loader: 'ts', target: 'es2022' })).code;
    browser = await engine.type.launch({ headless: true, ...(engine.name === 'Chrome' && chromePath ? { executablePath: chromePath } : {}) });
  });
  afterAll(async () => { await browser?.close(); });
  it.each(['plain', 'actions', 'long'].flatMap((banner) => [false, true].map((legend) => ({ banner, legend }))))('keeps the numeric 720px row and launch action reachable: $banner Legend=$legend', async ({ banner, legend }) => {
    const context = await browser.newContext({ viewport: { width: 720, height: 500 } });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => route.abort());
      const insets = { top: 24, right: 0, bottom: 34, left: 47 };
      const insetCss = stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof typeof insets) => `${insets[side]}px`);
      await page.setContent(html.replace('</head>', `<style>${vendor}\n${insetCss}</style></head>`));
      await page.evaluate(({ markup, banner, legend }) => {
        document.querySelector('#view')!.className = 'view-map';
        document.querySelector('#map-pane')!.classList.add('active');
        document.querySelector('#map')!.innerHTML = '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-top-left"><div class="maplibregl-ctrl maplibregl-ctrl-group"><button class="maplibregl-ctrl-zoom-in"></button><button class="maplibregl-ctrl-zoom-out"></button><button class="maplibregl-ctrl-compass"></button></div></div></div>';
        for (const e of document.querySelectorAll('[data-time-utc]')) e.textContent = '12:34Z';
        const brief = document.createElement('div');
        brief.id = 'map-launch-coverage'; brief.className = 'map-launch-brief'; brief.innerHTML = markup;
        document.querySelector('#map-pane')!.appendChild(brief);
        document.querySelector('#status-banner')!.innerHTML = banner === 'plain' ? 'Track ready' : `<p class="banner-copy">${banner === 'long' ? 'Stale orbit data; reconnect to refresh the current track. '.repeat(3) : 'Sign in to refresh'}</p><div class="banner-actions"><button class="banner-action">Sign in</button><button class="banner-action">Reload</button></div>`;
        document.querySelector('#map-legend-toggle')!.setAttribute('aria-expanded', String(legend));
        document.querySelector('#map-legend')!.classList.toggle('map-legend-open', legend);
        brief.querySelector<HTMLButtonElement>('.launch-brief-actions .btn')!.onclick = (e) => (e.currentTarget as HTMLElement).dataset.pressed = 'yes';
      }, { markup: launchMarkup(), banner, legend });
      const probes = ownerScript.replace('const value = Number.parseFloat(getComputedStyle(probe)[prop]) || 0;', 'const value = ({top:24,right:0,bottom:34,left:47})[side];');
      await page.addScriptTag({ content: `${probes}\nbindMapChrome(); applyMapChrome(true); window.__opdSyncMapChrome();` });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(100);
      const geometry = await page.evaluate(() => {
        const chip = document.querySelector('.map-controls-time')!.getBoundingClientRect();
        const row = document.querySelector('.map-command')!.getBoundingClientRect();
        const buttons = [...document.querySelectorAll('.map-command .time-step-btn')].map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });
        return { chip: { top: chip.top, bottom: chip.bottom, h: chip.height, left: chip.left }, row: { top: row.top, bottom: row.bottom }, buttons };
      });
      expect(geometry.chip.left).toBeGreaterThanOrEqual(47);
      expect(geometry.chip.h).toBeLessThanOrEqual(52);
      expect(geometry.chip.top).toBeGreaterThanOrEqual(geometry.row.top - .5);
      expect(geometry.chip.bottom).toBeLessThanOrEqual(geometry.row.bottom + .5);
      expect(geometry.buttons.every((b) => b.w >= 44 && b.h >= 44 && b.h <= 44.5)).toBe(true);
      const action = page.locator('#map-launch-coverage .launch-brief-actions .btn');
      await action.evaluate((e) => {
        const scroller = document.querySelector('#map-launch-coverage')!;
        const r = e.getBoundingClientRect(), s = scroller.getBoundingClientRect();
        scroller.scrollTop += r.top - s.top - (s.height - r.height) / 2;
      });
      const hits = await action.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return [[r.x + r.width / 2, r.y + r.height / 2], [r.x + 2, r.y + r.height / 2], [r.right - 2, r.y + r.height / 2], [r.x + r.width / 2, r.y + 2], [r.x + r.width / 2, r.bottom - 2]].map(([x, y]) => { const hit = document.elementFromPoint(x!, y!); return hit === e || !!hit && e.contains(hit); });
      });
      expect(hits).toEqual([true, true, true, true, true]);
      await action.click();
      expect(await action.getAttribute('data-pressed')).toBe('yes');
    } finally { await context.close(); }
  }, 30_000);
  it('keeps fractional footer clearance stable during repeated idle layout syncs', async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => route.abort());
      const insets = { top: 24, right: 0, bottom: 34, left: 47 };
      const insetCss = stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof typeof insets) => `${insets[side]}px`);
      await page.setContent(html.replace('</head>', `<style>${vendor}\n${insetCss}</style></head>`));
      await page.evaluate((markup) => {
        document.querySelector('#view')!.className = 'view-map';
        document.querySelector('#map-pane')!.classList.add('active');
        document.body.classList.add('shotlist-bar-visible');
        document.querySelector('#map')!.innerHTML = '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-top-left"><div class="maplibregl-ctrl maplibregl-ctrl-group"><button class="maplibregl-ctrl-zoom-in"></button><button class="maplibregl-ctrl-zoom-out"></button><button class="maplibregl-ctrl-compass"></button></div></div></div>';
        for (const e of document.querySelectorAll('[data-time-utc]')) e.textContent = '12:34Z';
        const brief = document.createElement('div');
        brief.id = 'map-launch-coverage'; brief.className = 'map-launch-brief'; brief.innerHTML = markup;
        document.querySelector('#map-pane')!.appendChild(brief);
        const bar = document.createElement('div');
        bar.id = 'shotlist-bar'; bar.innerHTML = '<span class="shotlist-count">1 queued</span><button class="btn">Export</button><button class="btn">Clear</button>';
        document.body.appendChild(bar);
        const banner = document.querySelector('#status-banner')!;
        banner.className = 'banner banner-red';
        banner.innerHTML = '<p class="banner-copy">SIGN IN AGAIN. The session ended while disconnected. Reconnect to restore the latest orbit predictions, then sign in again to synchronize your selected photography targets and shot list.</p><div class="banner-actions"><button class="banner-action">Sign in</button><button class="banner-action">Reload</button></div>';
        document.querySelector('#map-legend-toggle')!.setAttribute('aria-expanded', 'true');
        document.querySelector('#map-legend')!.classList.add('map-legend-open');
        document.querySelector<HTMLElement>('[data-pip="horizon"]')!.hidden = false;
      }, launchMarkup());
      const probes = ownerScript.replace('const value = Number.parseFloat(getComputedStyle(probe)[prop]) || 0;', 'const value = ({top:24,right:0,bottom:34,left:47})[side];');
      await page.addScriptTag({ content: `${probes}\nbindMapChrome(); applyMapChrome(true); window.__opdSyncMapChrome();` });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const result = await page.evaluate(async () => {
        const sync = (window as unknown as Window & { __opdSyncMapChrome: () => void }).__opdSyncMapChrome;
        const writes: Array<string | null> = [];
        const observer = new MutationObserver((records) => writes.push(...records.map((record) => record.oldValue)));
        observer.observe(document.body, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
        const initial = document.body.style.cssText;
        for (let i = 0; i < 24; i++) {
          sync();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        observer.disconnect();
        return { writes, initial, final: document.body.style.cssText, lift: Number.parseFloat(document.body.style.getPropertyValue('--map-time-lift')) };
      });
      expect(result.lift).toBeGreaterThan(0);
      expect(result.writes).toEqual([]);
      expect(result.final).toBe(result.initial);
    } finally { await context.close(); }
  }, 30_000);

});
