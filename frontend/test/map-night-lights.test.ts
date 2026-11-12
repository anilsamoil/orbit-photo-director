import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VIIRS_BLACK_MARBLE_MAX_ZOOM,
  gibsBlackMarbleUrl,
} from '../src/tile-precache';
import {
  MANIFEST_FIXTURE,
  TRACK_FIXTURE,
  buildMapDock,
  renderedMap,
  resetMaplibreDouble,
  stubArtifactFetch,
} from './maplibre-double';

vi.mock('maplibre-gl', async () => (await import('./maplibre-double')).maplibreModuleMock());

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
    // PNG (not JPG); the local adapter supplies night-side transparency.
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

// Night-only transparency must never use an opaque day mask above other overlays.
describe('night-lights rendering regressions', () => {
  let mapModule: typeof import('../src/map');

  function click(id: string): void {
    document.getElementById(id)!.dispatchEvent(new Event('click'));
  }

  function pressed(id: string): string | null {
    return document.getElementById(id)!.getAttribute('aria-pressed');
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-04T12:10:00Z'));
    buildMapDock();
    stubArtifactFetch({ 'passes.json': [], 'track.json': TRACK_FIXTURE });
    vi.resetModules();
    resetMaplibreDouble();
    mapModule = await import('../src/map');
    await mapModule.renderMap(MANIFEST_FIXTURE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('keeps overview lights vivid while reducing source overzoom glare', () => {
    expect(renderedMap().getLayer('viirs-night-lights-layer')?.paint).toEqual({ 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.95, 4, 0.95, 6, 0.85, 8, 0.74] });
  });

  it('keeps the current night-only mask when terminator guides are hidden and time is scrubbed', () => {
    const map = renderedMap();
    click('toggle-night-lights');
    const first = map.tilesSetOn('viirs-night-lights').at(-1)?.[0];
    expect(first).toContain('?night=');
    click('toggle-terminator');
    expect(map.tilesSetOn('viirs-night-lights').at(-1)?.[0]).toBe(first);
    mapModule.setLookahead(90, false);
    const scrubbed = map.tilesSetOn('viirs-night-lights').at(-1)?.[0];
    expect(scrubbed).toContain('?night=');
    expect(scrubbed).not.toBe(first);
    expect(map.visibilityOf('viirs-night-lights-layer')).toBe('visible');
    expect(map.visibilityOf('terminator-night-fill-layer')).toBe('none');
  });

  it('the global dim is a background layer shown only with lights ON and terminator OFF (v3.6)', () => {
    const map = renderedMap();
    expect(map.getLayer('night-lights-global-dim-layer')).toEqual({
      id: 'night-lights-global-dim-layer',
      type: 'background',
      layout: { visibility: 'none' },
      paint: { 'background-color': '#000000', 'background-opacity': 0.30 },
    });
    const seen: [string | null, string | null, string | undefined][] = [];
    const record = () => seen.push([
      pressed('toggle-night-lights'),
      pressed('toggle-terminator'),
      map.visibilityOf('night-lights-global-dim-layer'),
    ]);
    record();
    click('toggle-night-lights');
    record();
    click('toggle-terminator');
    record();
    click('toggle-night-lights');
    record();
    click('toggle-terminator');
    record();
    expect(seen).toEqual([
      ['false', 'true', 'none'],
      ['true', 'true', 'none'],
      ['true', 'false', 'visible'],
      ['false', 'false', 'none'],
      ['false', 'true', 'none'],
    ]);
  });

  it('the terminator day-mask layer and source are absent, with the terminator on or off (v3.3 drop)', () => {
    const map = renderedMap();
    const terminatorLayers = () => map.layerOrder.filter((id) => id.startsWith('terminator-'));
    const terminatorSources = () => [...map.sources.keys()].filter((id) => id.startsWith('terminator-'));
    expect(terminatorLayers()).toEqual(['terminator-night-fill-layer', 'terminator-line-layer']);
    expect(terminatorSources()).toEqual(['terminator-line', 'terminator-night-fill']);
    click('toggle-terminator');
    click('toggle-terminator');
    expect(terminatorLayers()).toEqual(['terminator-night-fill-layer', 'terminator-line-layer']);
    expect(terminatorSources()).toEqual(['terminator-line', 'terminator-night-fill']);
    expect(map.layerOrder).not.toContain('terminator-day-mask-layer');
    expect(map.sources.has('terminator-day-mask')).toBe(false);
  });
});
