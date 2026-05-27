import { describe, expect, it } from 'vitest';

import {
  VIIRS_BLACK_MARBLE_MAX_ZOOM,
  gibsBlackMarbleUrl,
} from '../src/tile-precache';

// v2 (Chris feedback 2026-05-27): VIIRS Black Marble night-lights overlay
// + GIBS year-fallback logic. We test the URL builder and emulate the
// fallback contract (which the real map.ts wires to MapLibre's tileerror
// event). Following the existing map-basemap.test.ts inline-logic pattern
// because MapLibre doesn't run cleanly in happy-dom.

describe('gibsBlackMarbleUrl', () => {
  it('substitutes the year-iso date into the GIBS WMTS pattern', () => {
    const url = gibsBlackMarbleUrl('2024-01-01');
    expect(url).toContain('VIIRS_Black_Marble');
    expect(url).toContain('/2024-01-01/');
    expect(url).toContain('GoogleMapsCompatible_Level8');
    // PNG (not JPG) — annual product has transparent day-side pixels.
    expect(url).toMatch(/\.png$/);
  });

  it('keeps the standard GIBS host so the SW CacheFirst rule picks it up', () => {
    const url = gibsBlackMarbleUrl('2023-01-01');
    expect(url).toMatch(/^https:\/\/gibs\.earthdata\.nasa\.gov\//);
  });

  it('exposes the matching max-zoom constant for MapLibre source config', () => {
    // The GIBS catalog publishes VIIRS_Black_Marble at Level8 (z8). MapLibre
    // overzooms above that with no extra fetch.
    expect(VIIRS_BLACK_MARBLE_MAX_ZOOM).toBe(8);
  });
});

// Mirrors the fallback logic in map.ts:armNightLightsErrorFallback.
// Kept inline because the real wiring is via MapLibre's tileerror event,
// which requires a live MapLibre Map (not feasible in happy-dom).
describe('VIIRS year-fallback policy', () => {
  /**
   *  Contract:
   *    - Start with year (currentYear - 1).
   *    - On 404 / 5xx, swap to (currentYear - 2).
   *    - On further 404 / 5xx, give up, console.warn, hide the layer.
   *    - Re-toggle by the operator re-arms the fallback (resets year tracker).
   */
  function policy(initialYear: number): {
    tried: Set<number>;
    failedSilently: boolean;
    onError: () => number | null;  // returns next year to try, or null if gave up
  } {
    const tried = new Set<number>([initialYear]);
    let failedSilently = false;
    return {
      tried,
      get failedSilently() { return failedSilently; },
      onError() {
        if (failedSilently) return null;
        const oldest = Math.min(...Array.from(tried));
        if (tried.size >= 2) {
          failedSilently = true;
          return null;
        }
        const next = oldest - 1;
        tried.add(next);
        return next;
      },
    };
  }

  it('walks back one year on first error', () => {
    const p = policy(2025);
    expect(p.onError()).toBe(2024);
    expect(p.tried.has(2024)).toBe(true);
  });

  it('gives up after the second consecutive failure', () => {
    const p = policy(2025);
    p.onError();  // 2024
    expect(p.onError()).toBeNull();
    expect(p.failedSilently).toBe(true);
  });

  it('subsequent error after give-up is a no-op', () => {
    const p = policy(2025);
    p.onError();
    p.onError();
    expect(p.onError()).toBeNull();  // already null
  });
});
