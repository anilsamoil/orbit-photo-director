import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { transformWithEsbuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildPassList } from '../src/map/overlays/pass-list';
import { tleEpochMs } from '../src/iss-sgp4';
import { findUpcomingPasses } from '../src/pin-drop';
import type { Track } from '../src/types';
import fixture from './fixtures/iss-sgp4-fixture.json';

const chromePath = [
  '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((path) => existsSync(path));
const stylesheet = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8')
  .replace(/url\('\/fonts\/([^']+)'\)/g, (_, filename: string) =>
    `url('data:font/woff2;base64,${readFileSync(resolve(__dirname, '../public/fonts', filename)).toString('base64')}')`);
const vendorStylesheet = readFileSync(resolve(__dirname, '../node_modules/maplibre-gl/dist/maplibre-gl.css'), 'utf8');
const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '')
  .replace('</head>', `<style>${vendorStylesheet}\n${stylesheet}</style></head>`);
const adapter = readFileSync(resolve(__dirname, '../src/map/adapters/maplibre/index.ts'), 'utf8');
// Execute the production solver and observers, not a copied algorithm or fixed sheet dimensions.
const placementSource = adapter.slice(adapter.indexOf('function mapInspector('), adapter.indexOf('function exposeForEndToEnd('));
const now = Date.parse(fixture.start);
const track: Track = { ...fixture, tle_epoch: new Date(tleEpochMs(fixture.tle)!).toISOString(), tle_age_hours: 0, tle_freshness_factor: 1 };
const passes = findUpcomingPasses(track, 40, -90, now);
const unbrokenName = 'INTERNATIONALSPACESTATIONZARYA';
const variants = ['normal', 'long-time', 'long-name', 'long-both', 'unbroken-name', 'longer-unbroken-name', 'unbroken-both', 'unbroken-title'] as const;
type Variant = typeof variants[number];

function passMarkup(variant: Variant): string {
  const name = variant === 'longer-unbroken-name' ? `${unbrokenName}EXPEDITION`
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
    const epsilon = 0.1;
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
    rows.forEach((row, index) => {
      const rect = row.getBoundingClientRect();
      const visible = visibleRect(row);
      // Scrollable trailing rows may be partly outside the viewport; the first must fit in full.
      if (index !== targetRow && (visible.width < rect.width - epsilon || visible.height < rect.height - epsilon)) return;
      visibleRows += 1;
      checkClips(row);
      const rowFields = [...row.children].map((element) => {
        fields.add(element.className);
        return { name: element.className, rects: textRects(element) };
      });
      for (let a = 0; a < rowFields.length; a += 1) for (let b = a + 1; b < rowFields.length; b += 1) {
        for (const { rect: left } of rowFields[a]!.rects) for (const { rect: right } of rowFields[b]!.rects) {
          const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
          const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
          if (width > epsilon && height > epsilon) overlaps.push({ row: index, a: rowFields[a]!.name, b: rowFields[b]!.name, width, height });
        }
      }
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

function expectReadable(measured: RenderedMeasure, label: string): void {
  const details = `${label}: ${JSON.stringify(measured)}`;
  expect.soft(measured.sheet.width, details).toBeGreaterThan(0);
  expect.soft(measured.visibleRows, details).toBeGreaterThan(0);
  expect.soft(measured.fields, details).toEqual(expect.arrayContaining(['pin-pass-rel', 'pin-pass-utc', 'pin-pass-nadir', 'pin-pass-regime', 'pin-pass-shoot']));
  expect.soft(measured.overlaps, details).toEqual([]);
  expect.soft(measured.clips, details).toEqual([]);
  for (const popup of measured.popupWidths) expect.soft(popup.scrollWidth, details).toBeLessThanOrEqual(popup.clientWidth);
  expect.soft(measured.firstRowVisible, details).toBeGreaterThanOrEqual(measured.firstRowHeight - 0.1);
}

let browser: Browser | undefined;
let placementScript = '';

describe.skipIf(!chromePath)('rendered pin pass row', () => {
  beforeAll(async () => {
    expect(passes).toHaveLength(5);
    expect(placementSource).toContain('function inspectorSync(');
    placementScript = (await transformWithEsbuild(placementSource, 'inspector-placement.ts', { target: 'es2022' })).code;
    browser = await chromium.launch({
      executablePath: chromePath,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run'],
    });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  it.each([
    { width: 568, height: 320 }, { width: 667, height: 375 }, { width: 740, height: 360 }, { width: 844, height: 390 },
    { width: 874, height: 280 }, { width: 874, height: 402 }, { width: 874, height: 541 },
    { width: 874, height: 550 }, { width: 932, height: 430 }, { width: 1440, height: 900 },
  ])('fits every painted field at $width×$height with real placement', async ({ width, height }) => {
    if (!browser) throw new Error('Chrome was not opened');
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 3, isMobile: width < 1000, hasTouch: width < 1000 });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => {
        document.querySelector('#map-pane')!.classList.add('active');
        document.querySelector('#map')!.innerHTML = '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-top-left"><div class="maplibregl-ctrl maplibregl-ctrl-group"><button></button><button></button><button></button></div></div></div>';
      });
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
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        const measured = await measure(page);
        const label = `${width}×${height} ${shown ? 'shown' : 'hidden'} ${variant}`;
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
  }, 30_000);
});
