import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { chromium, devices, webkit } from 'playwright';
import { RASTER_TILE_PNG } from './raster-tile-fixture.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const surfaces = [
  { name: 'Chromium', type: chromium, launch: existsSync(chromePath) ? { executablePath: chromePath } : {}, context: { viewport: { width: 1400, height: 900 } } },
  { name: 'iPhone 13 WebKit', type: webkit, launch: {}, context: devices['iPhone 13'] },
  { name: 'iPad WebKit', type: webkit, launch: {}, context: devices['iPad Pro 11'] },
];

for (const surface of surfaces) {
  test(`external raster fixture decodes through MapLibre createImageBitmap path on ${surface.name}`, async () => {
    const browser = await surface.type.launch(surface.launch);
    try {
      const context = await browser.newContext(surface.context);
      try {
        const page = await context.newPage();
        const dimensions = await page.evaluate(async (base64) => {
          const response = await fetch(`data:image/png;base64,${base64}`);
          const bitmap = await createImageBitmap(await response.blob());
          try { return { width: bitmap.width, height: bitmap.height }; }
          finally { bitmap.close(); }
        }, RASTER_TILE_PNG.toString('base64'));
        assert.deepEqual(dimensions, { width: 1, height: 1 });
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
}
