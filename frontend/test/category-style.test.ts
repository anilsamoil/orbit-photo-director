import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ANILS_TARGET_PAINT, ANILS_TARGETS_CATEGORY, categoryPaint } from '../src/category-style';

describe('category paint', () => {
  it('returns the Anil swatch and nothing for a category without paint', () => {
    expect(categoryPaint(ANILS_TARGETS_CATEGORY)).toEqual(ANILS_TARGET_PAINT);
    expect(categoryPaint('volcano')).toBeUndefined();
    expect(categoryPaint(undefined)).toBeUndefined();
  });

  it('uses that same color on the map legend', () => {
    const css = readFileSync('src/style.css', 'utf8');
    const html = readFileSync('index.html', 'utf8');
    expect(css).toContain(`.map-legend-anil { background: ${ANILS_TARGET_PAINT.color};`);
    expect(html).toContain('map-legend-anil');
    expect(html).toContain(ANILS_TARGET_PAINT.label);
  });
});
