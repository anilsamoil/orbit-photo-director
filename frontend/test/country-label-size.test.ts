import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import countryRasterLevels from '../src/map/adapters/maplibre/country-raster-levels.json' with { type: 'json' };
import { COUNTRY_LABEL_MIN_MERCATOR, countryLabelCounts } from '../src/map/adapters/maplibre/country-label-size';

const levels = countryRasterLevels as {
  bounds: Record<string, Record<string, { box: number[] }[]>>;
};

describe('country label size', () => {
  it('keeps every audited name and drops the 36 by 8 dark scrap', () => {
    let shortest = Number.POSITIVE_INFINITY;
    for (const byTile of Object.values(levels.bounds)) {
      for (const entries of Object.values(byTile)) {
        for (const entry of entries) {
          const width = entry.box[2]! - entry.box[0]!;
          const height = entry.box[3]! - entry.box[1]!;
          shortest = Math.min(shortest, width, height);
          expect(countryLabelCounts({ width, height })).toBe(true);
        }
      }
    }
    const world = 512 * (2 ** 6.5);
    const scrap = { width: 36 / world, height: 8 / world };
    expect(countryLabelCounts(scrap)).toBe(false);
    expect(COUNTRY_LABEL_MIN_MERCATOR).toBeGreaterThan(scrap.height);
    expect(COUNTRY_LABEL_MIN_MERCATOR).toBeLessThan(shortest);
    const map = readFileSync(resolve(__dirname, '../src/map/adapters/maplibre/track-inset.ts'), 'utf8');
    const ocr = readFileSync(resolve(__dirname, '../../.cursor/skills/verify-opd/scripts/raster-ocr.mjs'), 'utf8');
    expect(map).toContain("from './country-label-size'");
    expect(ocr).toContain('country-label-size.ts');
  });
});
