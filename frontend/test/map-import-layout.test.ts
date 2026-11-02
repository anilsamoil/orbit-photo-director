import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { transformWithEsbuild } from 'vite';
import { describe, expect, it } from 'vitest';
import { chromiumExecutablePath } from './chromium-executable';

const stylesheet = readFileSync(resolve('src/style.css'), 'utf8');
const html = readFileSync(resolve('index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const source = `${readFileSync(resolve('src/chrome-slots.ts'), 'utf8')}\n${readFileSync(resolve('src/map-chrome.ts'), 'utf8').replace(/^import[^\n]+\n/, '')}`.replace(/\bexport /g, '');

for (const engine of [{ name: 'Chromium', type: chromium }, { name: 'WebKit', type: webkit }]) describe(`map recovery footer ${engine.name}`, () => {
  it.each([
    { width: 402, height: 874, bottom: 34 },
    { width: 874, height: 402, bottom: 21 },
    { width: 834, height: 1210, bottom: 20 },
  ])('keeps Retry and saved-shot actions reachable at $width×$height', async ({ width, height, bottom }) => {
    const browser = await engine.type.launch({ headless: true, ...(engine.name === 'Chromium' ? { executablePath: chromiumExecutablePath() } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.route('**/*', (route) => route.abort());
      const css = stylesheet.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g, (_, side: string) => `${side === 'bottom' ? bottom : 0}px`);
      await page.setContent(html.replace('</head>', `<style>${css}</style></head>`));
      await page.evaluate(() => {
        document.querySelector('#view')!.className = 'view-map';
        document.querySelector('#map-pane')!.classList.add('active');
        document.querySelector('#status-banner')!.innerHTML = '<p class="banner-copy">Map couldn\'t load</p><div class="banner-actions"><button class="banner-action" id="retry-map">Retry</button></div>';
        document.body.insertAdjacentHTML('beforeend', '<div id="shotlist-bar"><span class="shotlist-count">1 saved shot</span><button class="btn shotlist-add">Add to calendar</button><button class="btn shotlist-clear">Clear</button></div>');
        document.body.classList.add('shotlist-bar-visible');
        const bar = document.querySelector('#shotlist-bar')!;
        document.body.style.setProperty('--recovery-shotlist-height', `${bar.getBoundingClientRect().height}px`);
      });
      const owner = (await transformWithEsbuild(source, 'chrome-owner.ts', { loader: 'ts', target: 'es2022' })).code;
      await page.addScriptTag({ content: `${owner}\nbindMapChrome();` });
      await page.waitForTimeout(100);
      for (const shots of [true, false]) {
        if (!shots) await page.evaluate(() => {
          document.querySelector<HTMLElement>('#shotlist-bar')!.hidden = true;
          document.body.classList.remove('shotlist-bar-visible');
          document.body.style.setProperty('--recovery-shotlist-height', '0px');
        });
        await page.waitForTimeout(100);
        const boxes = await page.evaluate((shots) => {
          const footer = document.querySelector('#status-banner')!.getBoundingClientRect();
          const bar = document.querySelector('#shotlist-bar')!.getBoundingClientRect();
          const buttons = ['#retry-map', '#map-chrome-toggle', ...(shots ? ['.shotlist-add', '.shotlist-clear'] : [])].map((selector) => {
            const element = document.querySelector(selector)!;
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return { selector, rect: rect.toJSON(), hit: hit === element || !!hit && element.contains(hit) };
          });
          return { footer: footer.toJSON(), bar: bar.toJSON(), buttons };
        }, shots);
        if (shots) expect(boxes.footer.bottom).toBeLessThanOrEqual(boxes.bar.top + 1);
        for (const { selector, rect, hit } of boxes.buttons) {
          expect(rect.width, selector).toBeGreaterThanOrEqual(44);
          expect(rect.height, selector).toBeGreaterThanOrEqual(44);
          expect(rect.top, selector).toBeGreaterThanOrEqual(0);
          expect(rect.bottom, selector).toBeLessThanOrEqual(height - bottom + 1);
          expect(hit, selector).toBe(true);
        }
      }
    } finally { await browser.close(); }
  }, 30_000);
});
