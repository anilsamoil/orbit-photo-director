import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import { transformWithEsbuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildPassList } from '../src/map/overlays/pass-list';
import { tleEpochMs } from '../src/iss-sgp4';
import { findUpcomingPasses } from '../src/pin-drop';
import type { Track } from '../src/types';
import { chromiumExecutablePath } from './chromium-executable';
import fixture from './fixtures/iss-sgp4-fixture.json';
const stylesheet = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, filename: string) =>
    `url('data:font/woff2;base64,${readFileSync(resolve(__dirname, '../public/fonts', filename)).toString('base64')}')`);
// Native Menlo has a 15px text content area on macOS; other monospace fonts
// exceed the narrow row's old 14.976px line-height. Exercise a real 17px face
// as well as the platform stack so the collision cannot hide behind OS metrics.
const metricFont = readFileSync(resolve(__dirname, 'fixtures/fonts/JetBrainsMono-Regular.ttf')).toString('base64');
const metricStylesheet = `@font-face {
  font-family: "Pass row metrics";
  src: url(data:font/ttf;base64,${metricFont}) format("truetype");
}
.metric-font .pin-pass-row { font-family: "Pass row metrics", monospace; }`;
const vendorStylesheet = readFileSync(resolve(__dirname, '../node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '')
  .replace('</head>', `<style>${vendorStylesheet}\n${stylesheet}\n${metricStylesheet}</style></head>`);
const adapter = readFileSync(resolve(__dirname, '../src/map/adapters/maplibre/index.ts'), 'utf8');
// Execute the production solver and observers, not a copied algorithm or fixed sheet dimensions.
const placementSource = adapter.slice(adapter.indexOf('function mapInspector('), adapter.indexOf('function exposeForEndToEnd('));
const now = Date.parse(fixture.start);
const track: Track = { ...fixture, tle_epoch: new Date(tleEpochMs(fixture.tle)!).toISOString(), tle_age_hours: 0, tle_freshness_factor: 1 };
const passes = findUpcomingPasses(track, 40, -90, now);
const unbrokenName = 'INTERNATIONALSPACESTATIONZARYA';
const heading60 = 'INTERNATIONALSPACESTATIONZARYAEXPEDITIONINTERNATIONALSPACEST';
const variants = ['heading60', 'normal', 'long-time', 'long-name', 'long-both', 'unbroken-name', 'longer-unbroken-name', 'unbroken-both', 'unbroken-title'] as const;
type Variant = typeof variants[number];

function passMarkup(variant: Variant): string {
  const name = variant === 'heading60' ? heading60
    : variant === 'longer-unbroken-name' ? `${unbrokenName}EXPEDITION`
    : variant === 'unbroken-name' || variant === 'unbroken-both' ? unbrokenName
    : variant === 'long-name' || variant === 'long-both' ? 'INTERNATIONAL SPACE STATION (ZARYA)' : 'ISS';
  const body = buildPassList(40, -90, 1, [{
    name,
    color: '#5cd0ff',
    passes: passes.map((pass, index) => variant === 'long-time' || variant === 'long-both' || variant === 'unbroken-both' ? {
      ...pass,
      closestApproachMs: now + (23 * 60 + 59 + index) * 60_000,
      nadirKm: 1480,
      regime: 'iss-twilight',
    } : pass),
  }], now);
  if (variant === 'unbroken-title') body.querySelector('strong')!.textContent = unbrokenName;
  return body.outerHTML;
}

interface RenderedMeasure {
  sheet: { x: number; y: number; width: number; height: number };
  firstRowHeight: number;
  firstRowVisible: number;
  visibleRows: number;
  fields: string[];
  popupWidths: { element: string; clientWidth: number; scrollWidth: number }[];
  overlaps: { row: number; a: string; b: string; width: number; height: number }[];
  clips: { text: string; ancestor: string; overflow: number }[];
}

async function measure(page: Page, targetRow = 0): Promise<RenderedMeasure> {
  return page.evaluate((targetRow) => {
    const epsilon = 0.01;
    const clippingBounds = (element: Element) => {
      const bounds = [{ name: 'viewport', left: 0, top: 0, right: innerWidth, bottom: innerHeight }];
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const x = /(auto|scroll|hidden|clip)/.test(style.overflowX);
        const y = /(auto|scroll|hidden|clip)/.test(style.overflowY);
        if (!x && !y) continue;
        const rect = ancestor.getBoundingClientRect();
        const left = rect.left + Number.parseFloat(style.borderLeftWidth || '0');
        const top = rect.top + Number.parseFloat(style.borderTopWidth || '0');
        const right = rect.right - Number.parseFloat(style.borderRightWidth || '0');
        const bottom = rect.bottom - Number.parseFloat(style.borderBottomWidth || '0');
        bounds.push({
          name: ancestor.id || ancestor.className || ancestor.tagName,
          left: x ? left : -Infinity, right: x ? right : Infinity,
          top: y ? top : -Infinity, bottom: y ? bottom : Infinity,
        });
      }
      return bounds;
    };
    const visibleRect = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const bounds = clippingBounds(element);
      return {
        width: Math.max(0, Math.min(rect.right, ...bounds.map((bound) => bound.right)) - Math.max(rect.left, ...bounds.map((bound) => bound.left))),
        height: Math.max(0, Math.min(rect.bottom, ...bounds.map((bound) => bound.bottom)) - Math.max(rect.top, ...bounds.map((bound) => bound.top))),
      };
    };
    const textRects = (element: Element) => {
      const result: { rect: DOMRect; text: string; parent: Element }[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || !node.parentElement) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width && rect.height) result.push({ rect, text: node.textContent, parent: node.parentElement });
        }
      }
      return result;
    };
    const clips: RenderedMeasure['clips'] = [];
    const checkClips = (element: Element) => {
      for (const { rect, text, parent } of textRects(element)) for (const bounds of clippingBounds(parent)) {
        const overflow = Math.max(bounds.left - rect.left, rect.right - bounds.right, bounds.top - rect.top, rect.bottom - bounds.bottom);
        if (overflow > epsilon) clips.push({ text, ancestor: bounds.name, overflow });
      }
    };
    const overlaps: RenderedMeasure['overlaps'] = [];
    const rows = [...document.querySelectorAll<HTMLElement>('.pin-pass-row')];
    const first = rows[targetRow]!;
    const fields = new Set<string>();
    let visibleRows = 0;
    const rowFields = rows.map((row) => [...row.children].map((element) => {
      fields.add(element.className);
      return { name: element.className, rects: textRects(element) };
    }));
    const checkOverlap = (a: typeof rowFields[number][number], b: typeof a, row: number) => {
      for (const { rect: left } of a.rects) for (const { rect: right } of b.rects) {
        const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
        const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
        if (width > epsilon && height > epsilon) overlaps.push({ row, a: a.name, b: b.name, width, height });
      }
    };
    rows.forEach((row, index) => {
      const current = rowFields[index]!;
      // Check intrinsic text geometry even for trailing rows outside the scrollport.
      for (let a = 0; a < current.length; a += 1) for (let b = a + 1; b < current.length; b += 1) {
        checkOverlap(current[a]!, current[b]!, index);
      }
      for (const field of current) for (const next of rowFields[index + 1] ?? []) {
        checkOverlap(field, { ...next, name: `next row ${next.name}` }, index);
      }
      if (row === row.parentElement?.firstElementChild) {
        const heading = row.parentElement.previousElementSibling;
        if (heading?.matches('.pin-pass-heading')) for (const field of current) {
          checkOverlap({ name: 'pin-pass-heading', rects: textRects(heading) }, field, index);
        }
      }
      const rect = row.getBoundingClientRect();
      const visible = visibleRect(row);
      // Scrollable trailing rows may be partly outside the viewport; the target must fit in full.
      if (index !== targetRow && (visible.width < rect.width - epsilon || visible.height < rect.height - epsilon)) return;
      visibleRows += 1;
      checkClips(row);
    });
    if (targetRow === 0) for (const header of document.querySelectorAll('.dropped-pin-popup > strong, .pin-pass-heading')) checkClips(header);
    const sheet = document.querySelector('#map-inspector')!.getBoundingClientRect();
    return {
      sheet: { x: sheet.x, y: sheet.y, width: sheet.width, height: sheet.height },
      firstRowHeight: first.getBoundingClientRect().height,
      firstRowVisible: visibleRect(first).height,
      popupWidths: [...document.querySelectorAll('.maplibregl-popup-content, .dropped-pin-popup')].map((element) => ({
        element: element.className, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      })),
      visibleRows, fields: [...fields], overlaps, clips,
    };
  }, targetRow);
}

function pinMarkup(unbroken: boolean): string {
  const body = buildPassList(40, -90, 1, [{
    name: unbroken ? heading60 : 'ISS',
    color: '#5cd0ff',
    passes,
  }], now);
  if (unbroken) {
    body.querySelector('.pin-pass-heading')!.textContent = heading60;
    body.querySelector('strong')!.textContent = heading60;
  }
  return body.outerHTML;
}

interface HeadingBox {
  clientWidth: number;
  scrollWidth: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  texts: { left: number; right: number; top: number; bottom: number }[];
}

interface HeadingFit {
  container: number;
  inspector: { left: number; right: number; top: number; bottom: number };
  heading: HeadingBox;
  title: HeadingBox;
}

function expectHeadingFits(measured: HeadingFit, label: string, unbroken: boolean): void {
  const details = `${label} ${JSON.stringify(measured)}`;
  const parts = [
    ['pin-pass-heading', measured.heading],
    ['strong', measured.title],
  ] as const;
  for (const [name, part] of parts) {
    expect.soft(part.scrollWidth, `${details} ${name} scrollWidth`).toBeLessThanOrEqual(part.clientWidth);
    expect.soft(part.left, `${details} ${name} left`).toBeGreaterThanOrEqual(measured.inspector.left - 1);
    expect.soft(part.right, `${details} ${name} right`).toBeLessThanOrEqual(measured.inspector.right + 1);
    expect.soft(part.top, `${details} ${name} top`).toBeGreaterThanOrEqual(measured.inspector.top - 1);
    expect.soft(part.bottom, `${details} ${name} bottom`).toBeLessThanOrEqual(measured.inspector.bottom + 1);
    expect.soft(part.texts.length, `${details} ${name} text`).toBeGreaterThan(0);
    if (unbroken) expect.soft(part.texts.length, `${details} ${name} wraps`).toBeGreaterThan(1);
    for (const text of part.texts) {
      expect.soft(text.left, `${details} ${name} text left`).toBeGreaterThanOrEqual(measured.inspector.left - 1);
      expect.soft(text.right, `${details} ${name} text right`).toBeLessThanOrEqual(measured.inspector.right + 1);
      expect.soft(text.top, `${details} ${name} text top`).toBeGreaterThanOrEqual(measured.inspector.top - 1);
      expect.soft(text.bottom, `${details} ${name} text bottom`).toBeLessThanOrEqual(measured.inspector.bottom + 1);
    }
  }
  if (!unbroken && measured.container > 260) {
    expect.soft(measured.heading.texts.length, `${details} normal heading lines`).toBe(1);
    expect.soft(measured.title.texts.length, `${details} normal title lines`).toBe(1);
  }
}

function expectReadable(measured: RenderedMeasure, label: string): void {
  const details = `${label}: ${JSON.stringify(measured)}`;
  expect.soft(measured.sheet.width, details).toBeGreaterThan(0);
  expect.soft(measured.visibleRows, details).toBeGreaterThan(0);
  expect.soft(measured.fields, details).toEqual(expect.arrayContaining(['pin-pass-rel', 'pin-pass-utc', 'pin-pass-nadir', 'pin-pass-regime', 'pin-pass-shoot']));
  expect.soft(measured.overlaps, details).toEqual([]);
  expect.soft(measured.clips, details).toEqual([]);
  for (const popup of measured.popupWidths) expect.soft(popup.scrollWidth, details).toBeLessThanOrEqual(popup.clientWidth);
  expect.soft(measured.firstRowVisible, details).toBeGreaterThanOrEqual(measured.firstRowHeight - 0.01);
}

for (const engine of [
  { name: 'Chromium', browserType: chromium, executablePath: chromiumExecutablePath(), optional: false },
  { name: 'WebKit', browserType: webkit, executablePath: webkit.executablePath(), optional: true },
]) {
  describe.skipIf(engine.optional && !existsSync(engine.executablePath))(`${engine.name} rendered pin pass row`, () => {
    let browser: Browser | undefined;
    let placementScript = '';

    beforeAll(async () => {
      expect(passes).toHaveLength(5);
      expect(heading60).toHaveLength(60);
      expect(placementSource).toContain('function inspectorSync(');
      placementScript = (await transformWithEsbuild(placementSource, 'inspector-placement.ts', { target: 'es2022' })).code;
      browser = await engine.browserType.launch({
        executablePath: engine.executablePath,
        ...(engine.name === 'Chromium' ? { args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run'] } : {}),
      });
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
    }, 60_000);

    it.each([
      { width: 568, height: 320 }, { width: 667, height: 375 }, { width: 740, height: 360 }, { width: 844, height: 390 },
      { width: 874, height: 280 }, { width: 874, height: 402 }, { width: 874, height: 541 },
      { width: 874, height: 550 }, { width: 932, height: 430 }, { width: 1440, height: 900 },
      { width: 402, height: 874 }, { width: 834, height: 1210 }, { width: 1210, height: 834 },
      { width: 768, height: 1024 }, { width: 1024, height: 768 },
    ].flatMap((size) => [1, 3].flatMap((deviceScaleFactor) => (size.width <= 932 ? ['native', 'metric'] : ['native']).map((font) => ({ ...size, deviceScaleFactor, font })))))('fits every painted field at $width×$height DPR$deviceScaleFactor $font font with real placement', async ({ width, height, deviceScaleFactor, font }) => {
      if (!browser) throw new Error(`${engine.name} was not opened`);
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, isMobile: deviceScaleFactor === 3 && width < 1440, hasTouch: deviceScaleFactor === 3 && width < 1440 });
      try {
        const page = await context.newPage();
        await page.route('**/*', (route) => route.abort());
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate((font) => {
          document.body.classList.toggle('metric-font', font === 'metric');
          document.querySelector('#view')!.classList.add('view-map');
          document.querySelector('#map-pane')!.classList.add('active');
          document.querySelector('#map')!.innerHTML = '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-top-left"><div class="maplibregl-ctrl maplibregl-ctrl-group"><button></button><button></button><button></button></div></div></div>';
        }, font);
        await page.addScriptTag({ content: `${placementScript}\nwindow.placeInspector = inspectorSync({ getContainer: () => document.querySelector('#map'), resize() {} });` });
        for (const shown of [false, true]) for (const variant of variants) {
          await page.evaluate(({ markup, shown }) => {
            document.body.classList.toggle('map-chrome-hidden', !shown);
            document.querySelector('#map-pane')!.classList.toggle('map-chrome-hidden', !shown);
            const toggle = document.querySelector('#map-chrome-toggle')!;
            toggle.textContent = shown ? 'Hide' : 'Controls';
            toggle.setAttribute('aria-expanded', String(shown));
            document.querySelector('#map-inspector')!.innerHTML = `<div class="maplibregl-popup"><div class="maplibregl-popup-content">${markup}<button class="maplibregl-popup-close-button" type="button">×</button></div></div>`;
            (window as unknown as { placeInspector: () => void }).placeInspector();
          }, { markup: passMarkup(variant), shown });
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const measured = await measure(page);
          const label = `${engine.name} ${width}×${height} DPR${deviceScaleFactor} ${font} ${shown ? 'shown' : 'hidden'} ${variant}`;
          expectReadable(measured, `${label} scrollTop=0`);
          for (let row = 1; row < passes.length; row += 1) {
            await page.evaluate((index) => {
              const scroller = document.querySelector<HTMLElement>('.maplibregl-popup-content')!;
              const target = document.querySelectorAll('.pin-pass-row')[index]!;
              scroller.scrollTop = Math.floor(scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop) - 2;
            }, row);
            expectReadable(await measure(page, row), `${label} scrolled row ${row + 1}`);
          }
        }
      } finally {
        await context.close();
      }
    }, 120_000);

    it('keeps a 60-character unbroken heading inside the inspector', async () => {
      if (!browser) throw new Error(`${engine.name} was not opened`);
      const layouts = [
        { width: 402, height: 874 },
        { width: 568, height: 320 },
        { width: 1024, height: 768 },
        { width: 1210, height: 834 },
      ];
      const containers: number[] = [];
      for (const size of layouts) for (const shown of [false, true]) for (const unbroken of [true, false]) {
        const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
        try {
          const page = await context.newPage();
          await page.route('**/*', (route) => route.abort());
          await page.setContent(html, { waitUntil: 'domcontentloaded' });
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate((chromeShown) => {
            document.body.classList.toggle('map-chrome-hidden', !chromeShown);
            document.querySelector('#view')!.classList.add('view-map');
            document.querySelector('#map-pane')!.classList.add('active');
            document.querySelector('#map-pane')!.classList.toggle('map-chrome-hidden', !chromeShown);
            document.querySelector('#map')!.innerHTML = '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-top-left"><div class="maplibregl-ctrl maplibregl-ctrl-group"><button></button><button></button><button></button></div></div></div>';
            const toggle = document.querySelector('#map-chrome-toggle')!;
            toggle.textContent = chromeShown ? 'Hide' : 'Controls';
            toggle.setAttribute('aria-expanded', String(chromeShown));
          }, shown);
          await page.addScriptTag({ content: `${placementScript}\nwindow.placeInspector = inspectorSync({ getContainer: () => document.querySelector('#map'), resize() {} });` });
          await page.evaluate((markup) => {
            document.querySelector('#map-inspector')!.innerHTML = `<div class="maplibregl-popup"><div class="maplibregl-popup-content">${markup}<button class="maplibregl-popup-close-button" type="button">×</button></div></div>`;
            (window as unknown as { placeInspector: () => void }).placeInspector();
          }, pinMarkup(unbroken));
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const measured = await page.evaluate(() => {
            const inspector = document.querySelector('#map-inspector')!;
            const popup = document.querySelector<HTMLElement>('.dropped-pin-popup')!;
            const bounds = inspector.getBoundingClientRect();
            const read = (element: HTMLElement) => {
              const rect = element.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(element);
              return {
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                texts: [...range.getClientRects()].filter((text) => text.width > 0 && text.height > 0).map((text) => ({
                  left: text.left, right: text.right, top: text.top, bottom: text.bottom,
                })),
              };
            };
            return {
              container: popup.clientWidth,
              inspector: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
              heading: read(document.querySelector<HTMLElement>('.pin-pass-heading')!),
              title: read(document.querySelector<HTMLElement>('.dropped-pin-popup > strong')!),
            };
          });
          containers.push(measured.container);
          const label = `${engine.name} ${size.width}×${size.height} ${shown ? 'shown' : 'hidden'} ${unbroken ? 'heading60' : 'normal'} container ${measured.container}`;
          expectHeadingFits(measured, label, unbroken);
        } finally {
          await context.close();
        }
      }
      expect.soft(containers.some((width) => width <= 260), `${engine.name} containers ${containers.join(',')}`).toBe(true);
      expect.soft(containers.some((width) => width > 260), `${engine.name} containers ${containers.join(',')}`).toBe(true);
    }, 120_000);
  });
}
