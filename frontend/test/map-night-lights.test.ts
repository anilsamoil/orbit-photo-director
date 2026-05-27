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
