import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

import { buildPassList } from '../src/map/overlays/pass-list';

const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((path) => existsSync(path));
const stylesheet = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8');

function passMarkup(): string {
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  const pass = {
    closestApproachMs: now + (23 * 60 + 59) * 60_000,
    nadirKm: 1480,
    regime: 'iss-twilight' as const,
    issAltKm: 420,
    angleOffNadirDeg: 42,
    relativeBearingDeg: 96,
  };
  return buildPassList(24.5, -81.4, 1, [{
    name: 'ISS',
    color: '#5cd0ff',
    passes: [pass, pass, pass, pass, pass],
  }], now).outerHTML;
}

interface RowMeasure {
  rowHeight: number;
  visible: number;
  rowBottom: number;
  sheetHeight: number;
  relUtcOverlap: number;
  relRegimeOverlap: number;
}

async function measureSheet(width: number, height: number): Promise<RowMeasure> {
  const browser = await chromium.launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(`<!doctype html><style>${stylesheet}</style>
      <div id="map-pane" class="map-inspector-open" style="position:relative;width:${width}px;height:${height}px">
        <aside id="map-inspector" class="map-inspector" style="display:block;position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden">
          <div class="maplibregl-popup"><div class="maplibregl-popup-content">${passMarkup()}<button class="maplibregl-popup-close-button" type="button">×</button></div></div>
        </aside>
      </div>`);
    return await page.evaluate(() => {
      const sheet = document.querySelector('#map-inspector')!.getBoundingClientRect();
      const row = document.querySelector('.pin-pass-row')!.getBoundingClientRect();
      const rel = document.querySelector('.pin-pass-rel')!.getBoundingClientRect();
      const utc = document.querySelector('.pin-pass-utc')!.getBoundingClientRect();
      const regime = document.querySelector('.pin-pass-regime')!.getBoundingClientRect();
      const overlap = (a: DOMRect, b: DOMRect) => {
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return width > 0 && height > 0 ? Math.min(width, height) : 0;
      };
      const visible = Math.max(0, Math.min(row.bottom, sheet.bottom) - Math.max(row.top, sheet.top));
      return {
        rowHeight: row.height,
        visible,
        rowBottom: row.bottom - sheet.top,
        sheetHeight: sheet.height,
        relUtcOverlap: overlap(rel, utc),
        relRegimeOverlap: overlap(rel, regime),
      };
    });
  } finally {
    await browser.close();
  }
}

describe.skipIf(!chromePath)('rendered pin pass row', () => {
  it.each([
    { label: '568×320', width: 102.8, height: 176 },
    { label: '667×375', width: 121.8, height: 260 },
    { label: '874×280', width: 154.2, height: 216 },
    { label: 'wide side column', width: 240, height: 260 },
  ])('shows the full first row without overlapping times at $label', async ({ width, height }) => {
    const measured = await measureSheet(width, height);
    expect(measured.relUtcOverlap, `${width}×${height} relative/UTC overlap`).toBe(0);
    expect(measured.relRegimeOverlap, `${width}×${height} relative/regime overlap`).toBe(0);
    expect(measured.visible, `${width}×${height} shows ${measured.visible} of ${measured.rowHeight}, row ends at ${measured.rowBottom}`).toBeCloseTo(measured.rowHeight, 0);
    expect(measured.rowBottom).toBeLessThanOrEqual(measured.sheetHeight + 0.5);
  });
});
