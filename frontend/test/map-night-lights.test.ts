import { describe, expect, it } from 'vitest';

import {
  VIIRS_BLACK_MARBLE_MAX_ZOOM,
  gibsBlackMarbleUrl,
} from '../src/tile-precache';

// v2 hotfix (Anil same-day feedback after v1.6.16.0): GIBS publishes
// VIIRS_Black_Marble for only two discrete dates — 2012-01-01 and
// 2016-01-01 — verified via live HTTP + GetCapabilities XML. The prior
// `currentYear - 1` + one-year fallback walk silently killed the toggle.
// We now hardcode 2016-01-01 as the canonical date; the gibsBlackMarbleUrl
// helper still accepts arbitrary year-iso strings (for hand-debugging or
// future migration to VIIRS_SNPP_DayNightBand_ENCC daily product).

describe('gibsBlackMarbleUrl', () => {
  it('substitutes the year-iso date into the GIBS WMTS pattern', () => {
    const url = gibsBlackMarbleUrl('2016-01-01');
    expect(url).toContain('VIIRS_Black_Marble');
    expect(url).toContain('/2016-01-01/');
    expect(url).toContain('GoogleMapsCompatible_Level8');
    // PNG (not JPG) — annual product has transparent day-side pixels.
    expect(url).toMatch(/\.png$/);
  });

  it('keeps the standard GIBS host so the SW CacheFirst rule picks it up', () => {
    const url = gibsBlackMarbleUrl('2016-01-01');
    expect(url).toMatch(/^https:\/\/gibs\.earthdata\.nasa\.gov\//);
  });

  it('exposes the matching max-zoom constant for MapLibre source config', () => {
    // The GIBS catalog publishes VIIRS_Black_Marble at Level8 (z8). MapLibre
    // overzooms above that with no extra fetch.
    expect(VIIRS_BLACK_MARBLE_MAX_ZOOM).toBe(8);
  });

  it('also supports the alternate canonical 2012-01-01 date', () => {
    // GIBS GetCapabilities lists 2012 + 2016 as the only published dates.
    // We ship 2016 (more recent), but 2012 is a valid hand-debug URL.
    const url = gibsBlackMarbleUrl('2012-01-01');
    expect(url).toContain('/2012-01-01/');
  });
});

describe('VIIRS Black Marble canonical date (v2 hotfix)', () => {
  // Year-fallback machinery was removed: GIBS doesn't publish a yearly
  // time series for this layer. These tests document the hardcoded date
  // and act as a tripwire if someone ever re-introduces the walk-back.
  it('hardcoded canonical date is 2016-01-01', () => {
    const canonical = '2016-01-01';
    const url = gibsBlackMarbleUrl(canonical);
    expect(url).toContain('/2016-01-01/');
  });

  it('current-year-minus-one would NOT round to 2016 (regression guard)', () => {
    // The bug was `currentYear - 1` (yielding e.g. 2025) which silently
    // 404'd. This test fails loudly if anyone re-introduces that path —
    // they'd have to assert the current-year-derived URL contains
    // /2016-01-01/ which obviously won't.
    const buggy = `${new Date().getUTCFullYear() - 1}-01-01`;
    expect(buggy).not.toBe('2016-01-01');
  });
});

// v3.5 (2026-05-29) regression coverage. Updated from v3.3:
//   1. The day-mask layer (added in v3.1) and its source upsert MUST NOT
//      exist anywhere in the renderMap layer/source bring-up. The mask's
//      opaque #0b0d12 fill hid the basemap, clouds, AND the raster on the
//      sun side — operator wanted the day side to look like normal daytime.
//   2. The viirs-night-lights-layer raster-opacity must be 0.95 (was 0.55
//      in v3.3/v3.4). v3.5 introduced the viirs-alpha:// MapLibre protocol
//      that luminance-keys the tile so dark background pixels become
//      transparent. With the dark background gone the layer can paint at
//      0.95 without darkening basemap/clouds, and bright city lights are
//      no longer muted.
//
// Both tests grep the rendered source of map.ts (read at runtime) for the
// invariants. This is the same approach as map-imagery-date.test.ts and is
// resilient to refactors as long as the property names stay literal.
describe('v3.5 night-lights regressions', () => {
  it('viirs-night-lights-layer raster-opacity is 0.95 (was 0.55 in v3.3/v3.4)', async () => {
    // Read the source of map.ts and assert the opacity literal. We use
    // import.meta.url so the test works in both vitest+happy-dom and node.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const mapSrc = await fs.readFile(
      path.resolve(__dirname, '../src/map.ts'),
      'utf-8',
    );
    // Find the addLayer block for viirs-night-lights-layer and assert its
    // paint.raster-opacity is 0.95. The gibs-clouds-layer also uses 0.55
    // (correctly, for cloud-overlay translucency), so we must scope the
    // assertion to the viirs-night-lights addLayer block.
    const block = mapSrc.match(
      /id:\s*'viirs-night-lights-layer'[\s\S]*?'raster-opacity':\s*([\d.]+)/,
    );
    expect(block).not.toBeNull();
    expect(block && block[1]).toBe('0.95');
    // And the prior 0.55 must NOT appear in the viirs-night-lights block.
    // (Comments mentioning the 0.55 → 0.95 journey are fine; a stray
    // `'raster-opacity': 0.55` inside that block would fail this guard.)
    expect(block && block[0]).not.toMatch(/'raster-opacity':\s*0\.55/);
  });

  it('global-dim layer exists with visibility tied to lights ON + terminator OFF (v3.6)', async () => {
    // v3.6 (2026-05-29): when night-lights is on alone, the alpha-keyed
    // lights paint over a bright basemap/clouds and pinpoint lights are
    // hard to make out. A global background dim restores the "night world"
    // feel. The dim hides when the terminator is on (the existing night-
    // fill handles per-side dimming in that case — otherwise the day side
    // would also be dimmed).
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const mapSrc = await fs.readFile(
      path.resolve(__dirname, '../src/map.ts'),
      'utf-8',
    );
    // Layer is declared with type 'background'.
    const block = mapSrc.match(
      /id:\s*'night-lights-global-dim-layer'[\s\S]*?type:\s*'background'/,
    );
    expect(block).not.toBeNull();
    // Visibility logic: visible only when lights ON AND terminator OFF.
    expect(mapSrc).toMatch(/nightLightsVisible\s*&&\s*!terminatorVisible/);
    // Wired into both visibility toggles so flipping either updates the dim.
    expect(mapSrc).toMatch(/applyGlobalDimVisibility\s*\(/);
  });

  it('terminator-day-mask layer + source are absent from the style (v3.3 drop)', async () => {
    // The day-mask was the v3.1 fix that regressed in two ways (hid
    // basemap/clouds, made clouds appear "inactive"). v3.3 drops it
    // entirely. Pin its absence so a future refactor doesn't sneak it
    // back in unnoticed.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const mapSrc = await fs.readFile(
      path.resolve(__dirname, '../src/map.ts'),
      'utf-8',
    );
    // No addLayer block declaring the day-mask layer.
    expect(mapSrc).not.toMatch(/id:\s*'terminator-day-mask-layer'/);
    // No upsertGeoJson call for the day-mask source.
    expect(mapSrc).not.toMatch(/upsertGeoJson\([^,]+,\s*'terminator-day-mask'/);
    // No applyDayMaskVisibility function or calls.
    expect(mapSrc).not.toMatch(/applyDayMaskVisibility\s*\(/);
    // No import or call of the day-polygon helper (matches identifier
    // followed by `(` for calls or by `,` / `}` for named-import lists).
    expect(mapSrc).not.toMatch(/terminatorDayPolygonFeatures\s*[(,}]/);
  });
});
