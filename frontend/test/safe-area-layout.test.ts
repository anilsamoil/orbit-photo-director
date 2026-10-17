import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser } from 'playwright';
import { transformWithEsbuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paintEqualDigits } from '../src/digits';
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
for (const engine of [
  { name: 'Chrome', type: chromium, executablePath: chromePath ?? chromium.executablePath() },
  { name: 'WebKit', type: webkit, executablePath: webkit.executablePath() },
]) describe.skipIf(!existsSync(engine.executablePath))(`safe-area painted layout ${engine.name}`, () => {
  let browser: Browser;
  let ownerScript: string;
  beforeAll(async () => {
    ownerScript = (await transformWithEsbuild(source, 'chrome-owner.ts', { loader: 'ts', target: 'es2022' })).code;
    browser = await engine.type.launch({ headless: true, executablePath: engine.executablePath });
  });
  afterAll(async () => { await browser?.close(); });
  it.each([
    { width: 402, height: 874, insets: { top: 62, right: 0, bottom: 34, left: 0 } },
    { width: 874, height: 402, insets: { top: 0, right: 62, bottom: 21, left: 62 } },
    { width: 834, height: 1210, insets: { top: 24, right: 0, bottom: 20, left: 0 } },
    { width: 1210, height: 834, insets: { top: 24, right: 0, bottom: 20, left: 0 } },
    { width: 1440, height: 900, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
    { width: 1280, height: 800, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
  ])('keeps corner controls inset-safe and the time slider tappable at $width×$height', async ({ width, height, insets }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => route.abort());
      const insetCss = stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof typeof insets) => `${insets[side]}px`);
      await page.setContent(html.replace('</head>', `<style>${vendor}\n${insetCss}</style></head>`));
      await page.evaluate(() => {
        document.querySelector('#view')!.className = 'view-map';
        document.querySelector('#map-pane')!.classList.add('active');
        document.querySelector<HTMLElement>('#live-readout')!.hidden = true;
        document.querySelector('#map')!.innerHTML = '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-top-left"><div class="maplibregl-ctrl maplibregl-ctrl-group"><button class="maplibregl-ctrl-zoom-in"></button><button class="maplibregl-ctrl-zoom-out"></button><button class="maplibregl-ctrl-compass"></button></div></div></div>';
        document.querySelector('#status-banner')!.textContent = 'Track ready';
        for (const element of document.querySelectorAll('[data-time-utc]')) element.textContent = '12:34Z';
      });
      const probes = ownerScript.replace('const value = Number.parseFloat(getComputedStyle(probe)[prop]) || 0;', `const value = (${JSON.stringify(insets)})[side];`);
      await page.addScriptTag({ content: `${probes}\nbindMapChrome();` });
      await page.evaluate(() => document.fonts.ready);
      for (const shown of [false, true]) {
        await page.evaluate((shown) => {
          const toggle = document.querySelector<HTMLButtonElement>('#map-chrome-toggle')!;
          if (toggle.getAttribute('aria-expanded') === String(!shown)) toggle.click();
        }, shown);
        await page.waitForTimeout(100);
        for (const selector of shown ? ['#map-chrome-toggle', '#map-legend-toggle', '.map-control-dock', '#bearing-north', '#time-slider'] : ['#map-chrome-toggle']) {
          const result = await page.locator(selector).evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const points = [[rect.x + rect.width / 2, rect.y + rect.height / 2], [rect.left + 2, rect.y + rect.height / 2], [rect.right - 2, rect.y + rect.height / 2], [rect.x + rect.width / 2, rect.top + 2], [rect.x + rect.width / 2, rect.bottom - 2]];
            return { rect: rect.toJSON(), owns: points.map(([x, y]) => { const hit = document.elementFromPoint(x!, y!); return hit === element || !!hit && element.contains(hit); }) };
          });
          expect(result.rect.left, selector).toBeGreaterThanOrEqual(insets.left);
          expect(result.rect.right, selector).toBeLessThanOrEqual(width - insets.right);
          expect(result.rect.top, selector).toBeGreaterThanOrEqual(insets.top);
          expect(result.rect.bottom, selector).toBeLessThanOrEqual(height - insets.bottom);
          expect(result.rect.width, selector).toBeGreaterThanOrEqual(44);
          expect(result.rect.height, selector).toBeGreaterThanOrEqual(44);
          if (selector !== '.map-control-dock') expect(result.owns, selector).toEqual([true, true, true, true, true]);
        }
        if (shown) {
          const controls = await page.evaluate(async () => {
            const dock = document.querySelector<HTMLElement>('.map-control-dock')!;
            const results = [];
            for (const button of [...dock.querySelectorAll('button')].filter((button) => button.getClientRects().length)) {
              const before = button.getBoundingClientRect();
              const bounds = dock.getBoundingClientRect();
              dock.scrollTop += before.top - bounds.top - (bounds.height - before.height) / 2;
              await new Promise(requestAnimationFrame);
              await new Promise(requestAnimationFrame);
              const rect = button.getBoundingClientRect();
              const points = [[rect.x + rect.width / 2, rect.y + rect.height / 2], [rect.left + 2, rect.y + rect.height / 2], [rect.right - 2, rect.y + rect.height / 2], [rect.x + rect.width / 2, rect.top + 2], [rect.x + rect.width / 2, rect.bottom - 2]];
              results.push({ id: button.id, clipped: rect.top < bounds.top || rect.bottom > bounds.bottom, owns: points.map(([x, y]) => { const hit = document.elementFromPoint(x!, y!); return hit === button || !!hit && button.contains(hit); }) });
            }
            return results;
          });
          expect(controls.length).toBeGreaterThan(0);
          for (const control of controls) {
            expect(control.clipped, control.id).toBe(false);
            expect(control.owns, control.id).toEqual([true, true, true, true, true]);
          }
        }
      }
    } finally { await context.close(); }
  }, 30_000);
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
  it.each([
    { top: 0, bottom: 0, left: 0, legend: false },
    { top: 0, bottom: 0, left: 0, legend: true },
    { top: 24, bottom: 34, left: 47, legend: false },
    { top: 24, bottom: 34, left: 47, legend: true },
  ])('keeps a 719px launch action clear below time: bottom=$bottom Legend=$legend', async ({ top, bottom, left, legend }) => {
    const context = await browser.newContext({ viewport: { width: 719, height: 521 } });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => route.abort());
      const insets = { top, right: 0, bottom, left };
      const insetCss = stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof typeof insets) => `${insets[side]}px`);
      await page.setContent(html.replace('</head>', `<style>${vendor}\n${insetCss}</style></head>`));
      await page.evaluate(({ markup, legend, long }) => {
        document.querySelector('#view')!.className = 'view-map';
        document.querySelector('#map-pane')!.classList.add('active');
        document.body.classList.add('shotlist-bar-visible');
        document.querySelector('#map')!.innerHTML = '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-top-left"><div class="maplibregl-ctrl maplibregl-ctrl-group"><button class="maplibregl-ctrl-zoom-in"></button><button class="maplibregl-ctrl-zoom-out"></button><button class="maplibregl-ctrl-compass"></button></div></div></div>';
        for (const e of document.querySelectorAll('[data-time-utc]')) e.textContent = '12:34Z';
        const brief = document.createElement('div');
        brief.id = 'map-launch-coverage'; brief.className = 'map-launch-brief'; brief.innerHTML = markup;
        document.querySelector('#map-pane')!.appendChild(brief);
        brief.querySelector<HTMLButtonElement>('.launch-brief-actions .btn')!.onclick = (e) => (e.currentTarget as HTMLElement).dataset.pressed = 'yes';
        const bar = document.createElement('div');
        bar.id = 'shotlist-bar'; bar.innerHTML = '<span class="shotlist-count">1 queued</span><button class="btn">Export</button><button class="btn">Clear</button>';
        document.body.appendChild(bar);
        const banner = document.querySelector('#status-banner')!;
        banner.className = 'banner banner-red';
        banner.innerHTML = `<p class="banner-copy">${long ? 'SIGN IN AGAIN. The session ended while disconnected. Reconnect to restore the latest orbit predictions, then sign in again to synchronize your selected photography targets and shot list.' : 'Orbit data ready'}</p><div class="banner-actions"><button class="banner-action">Sign in</button><button class="banner-action">Reload</button></div>`;
        document.querySelector('#map-legend-toggle')!.setAttribute('aria-expanded', String(legend));
        document.querySelector('#map-legend')!.classList.toggle('map-legend-open', legend);
      }, { markup: launchMarkup(), legend, long: bottom > 0 });
      const probes = ownerScript.replace('const value = Number.parseFloat(getComputedStyle(probe)[prop]) || 0;', `const value = (${JSON.stringify(insets)})[side];`);
      await page.addScriptTag({ content: `${probes}\nbindMapChrome(); applyMapChrome(true); window.__opdSyncMapChrome();` });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const collisions = await page.evaluate(() => {
        const brief = document.querySelector('#map-launch-coverage')!.getBoundingClientRect();
        return ['.map-toolbar', '.maplibregl-ctrl-group', '.map-command', '.map-control-dock', '#map-legend-panel', '#map-legend-toggle', '#map-chrome-toggle', '#status-banner', '#shotlist-bar'].filter((selector) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && brief.left < r.right - .5 && brief.right > r.left + .5 && brief.top < r.bottom - .5 && brief.bottom > r.top + .5;
        });
      });
      expect(collisions).toEqual([]);
      const action = page.locator('#map-launch-coverage .launch-brief-actions .btn');
      await action.evaluate((e) => {
        const scroller = document.querySelector('#map-launch-coverage')!;
        const r = e.getBoundingClientRect(), s = scroller.getBoundingClientRect();
        scroller.scrollTop += r.top - s.top - (s.height - r.height) / 2;
      });
      const target = await action.evaluate((e) => {
        const r = e.getBoundingClientRect(), scroll = document.querySelector('#map-launch-coverage')!.getBoundingClientRect();
        const points = [[r.x + r.width / 2, r.y + r.height / 2], [r.x + 2, r.y + r.height / 2], [r.right - 2, r.y + r.height / 2], [r.x + r.width / 2, r.y + 2], [r.x + r.width / 2, r.bottom - 2]];
        return { h: r.height, complete: r.top >= scroll.top && r.bottom <= scroll.bottom, hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x!, y!); return hit === e || !!hit && e.contains(hit); }) };
      });
      expect(target.h).toBeGreaterThanOrEqual(44);
      expect(target.complete).toBe(true);
      expect(target.hits).toEqual([true, true, true, true, true]);
      await action.click();
      expect(await action.getAttribute('data-pressed')).toBe('yes');
    } finally { await context.close(); }
  }, 30_000);

  it.each([{ width: 719, height: 521 }, { width: 402, height: 521 }, { width: 402, height: 600 }])('keeps all five slider hit points clear of numeric labels at $width×$height', async ({ width, height }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => route.abort());
      const insets = { top: 24, right: 0, bottom: 34, left: 47 };
      const css = stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: keyof typeof insets) => `${insets[side]}px`);
      await page.setContent(html.replace('</head>', `<style>${vendor}\n${css}</style></head>`));
      const end = document.createElement('span');
      paintEqualDigits(end, '+36h');
      await page.evaluate((digits) => {
        document.querySelector('#view')!.className = 'view-map';
        document.querySelector('#map-pane')!.classList.add('active');
        document.querySelector('#map')!.innerHTML = '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-top-left"><div class="maplibregl-ctrl maplibregl-ctrl-group"><button class="maplibregl-ctrl-zoom-in"></button><button class="maplibregl-ctrl-zoom-out"></button><button class="maplibregl-ctrl-compass"></button></div></div></div>';
        document.querySelectorAll('.time-slider-end')[1]!.innerHTML = digits;
        for (const e of document.querySelectorAll('[data-time-utc]')) e.textContent = '12:34Z';
        const banner = document.querySelector('#status-banner')!;
        banner.className = 'banner banner-red';
        banner.innerHTML = '<p class="banner-copy">Orbit data ready · verify fixture</p><div class="banner-actions"><button class="banner-action">Sign in</button><button class="banner-action">Reload</button></div>';
        document.querySelector('#time-slider')!.addEventListener('input', (event) => (event.target as HTMLElement).dataset.trustedInput = String(event.isTrusted));
      }, end.innerHTML);
      const probes = ownerScript.replace('const value = Number.parseFloat(getComputedStyle(probe)[prop]) || 0;', `const value = (${JSON.stringify(insets)})[side];`);
      await page.addScriptTag({ content: `${probes}\nbindMapChrome(); applyMapChrome(true); window.__opdSyncMapChrome();` });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const slider = page.locator('#time-slider');
      await slider.evaluate((element) => {
        const scroll = document.querySelector('.map-command')!;
        const r = element.getBoundingClientRect(), s = scroll.getBoundingClientRect();
        scroll.scrollLeft += Math.ceil(r.left - s.left - (s.width - r.width) / 2);
      });
      const geometry = await slider.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const points = [[r.x + r.width / 2, r.y + r.height / 2], [r.x + 2, r.y + r.height / 2], [r.right - 2, r.y + r.height / 2], [r.x + r.width / 2, r.y + 2], [r.x + r.width / 2, r.bottom - 2]];
        return { compact: document.body.classList.contains('map-slot-time-line'), width: r.width, height: r.height, points, hits: points.map(([x, y]) => document.elementFromPoint(x!, y!) === element) };
      });
      if (width === 719) expect(geometry.compact).toBe(true);
      expect(geometry.width).toBeGreaterThanOrEqual(44);
      expect(geometry.height).toBe(44);
      expect.soft(geometry.hits).toEqual([true, true, true, true, true]);
      const [x, y] = geometry.points[2]!;
      await page.mouse.click(x!, y!);
      expect(Number(await slider.inputValue())).toBeGreaterThan(0);
      expect(await slider.getAttribute('data-trusted-input')).toBe('true');
    } finally { await context.close(); }
  }, 30_000);

});
