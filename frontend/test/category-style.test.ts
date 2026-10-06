import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ANILS_TARGET_PAINT, ANILS_TARGETS_CATEGORY, categoryPaint } from '../src/category-style';

describe('category paint', () => {
  it('returns the Anil swatch and nothing for a category without paint', () => {
    expect(categoryPaint(ANILS_TARGETS_CATEGORY)).toEqual(ANILS_TARGET_PAINT);
    expect(categoryPaint('volcano')).toBeUndefined();
    expect(categoryPaint(undefined)).toBeUndefined();
  });

  it('keeps the Anil color and the Starship swatch off the map legend', () => {
    const css = readFileSync('src/style.css', 'utf8');
    const html = readFileSync('index.html', 'utf8');
    const legend = html.slice(html.indexOf('class="map-legend"'), html.indexOf('map-chrome-toggle'));
    expect(legend).toContain('map-legend-launch');
    expect(legend).toContain('map-legend-day');
    expect(legend).toContain('map-legend-twilight');
    expect(legend).toContain('map-legend-eclipse');
    expect(legend).not.toContain('map-legend-anil');
    expect(legend).not.toContain('map-legend-starship');
    expect(legend).not.toContain(ANILS_TARGET_PAINT.label);
    expect(legend).not.toContain('Starship');
    expect(css).not.toContain('.map-legend-anil');
    expect(css).not.toContain('.map-legend-starship');
  });
});
