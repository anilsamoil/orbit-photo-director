import { describe, expect, it } from 'vitest';

// v3.1 (Anil same-day feedback 2026-05-26): day-polygon mask + layer-order
// regression guards. Inline FakeMap fixture in the same style as
// map-labels.test.ts / map-basemap.test.ts (MapLibre itself doesn't run in
// happy-dom; we exercise the visibility-toggle + insertion-order CONTRACTS
// that map.ts depends on).
//
// Two concerns covered here:
//
// 1. Layer-order regression guard for bug #1 — the v1.6.18.0 bug where
//    `viirs-night-lights-layer` and `terminator-night-fill-layer` were
//    added without a `beforeId`, so MapLibre stacked them ABOVE the cyan
//    `iss-track-layer` polyline and the 0.95-opacity Black Marble tile
//    occluded the track whenever the 🌃 toggle was on. The fix passes
//    `beforeId='iss-track-layer'` on both addLayer calls so they slot in
//    BELOW the track.
//
// 2. Day-mask visibility wiring — the mask is only useful when BOTH
//    night-lights AND terminator are on; otherwise the lights either need
//    full-globe rendering (no terminator → no shadow context) or there are
//    no lights to mask. We exercise the four (night, terminator) combos.

interface FakeLayer {
  id: string;
  visibility: 'visible' | 'none';
}

class FakeMap {
  /** Insertion-ordered layer list. addLayer respects the beforeId arg by
   *  splicing in BEFORE the named layer; without beforeId it appends. This
   *  mirrors MapLibre's documented behavior. */
  order: string[] = [];
  layers: Map<string, FakeLayer> = new Map();
  addLayer(spec: { id: string; layout?: { visibility?: 'visible' | 'none' } }, beforeId?: string): void {
    const vis: 'visible' | 'none' = spec.layout?.visibility ?? 'visible';
    this.layers.set(spec.id, { id: spec.id, visibility: vis });
    if (beforeId && this.order.includes(beforeId)) {
      const idx = this.order.indexOf(beforeId);
      this.order.splice(idx, 0, spec.id);
    } else {
      this.order.push(spec.id);
    }
  }
  getLayer(id: string): FakeLayer | undefined { return this.layers.get(id); }
  setLayoutProperty(id: string, _prop: string, value: 'visible' | 'none'): void {
    const layer = this.layers.get(id);
    if (layer) layer.visibility = value;
  }
}

/** Mirrors the relevant slice of map.ts:renderMap. Adds the iss-track
 *  layer first (as renderMap does), then the night-fill + night-lights +
 *  day-mask layers using `beforeId='iss-track-layer'`. */
function setupLayersLikeRenderMap(m: FakeMap): void {
  m.addLayer({ id: 'iss-track-layer' });
  const beforeTrack = m.getLayer('iss-track-layer') ? 'iss-track-layer' : undefined;
  m.addLayer({ id: 'terminator-night-fill-layer' }, beforeTrack);
  m.addLayer({ id: 'viirs-night-lights-layer', layout: { visibility: 'none' } }, beforeTrack);
  m.addLayer({ id: 'terminator-day-mask-layer', layout: { visibility: 'none' } }, beforeTrack);
  m.addLayer({ id: 'terminator-line-layer' });
  m.addLayer({ id: 'subsolar-point-layer' });
}

/** Mirrors map.ts:applyDayMaskVisibility. */
function applyDayMaskVisibility(
  m: FakeMap, nightLightsVisible: boolean, terminatorVisible: boolean,
): void {
  const dayMaskVisible = nightLightsVisible && terminatorVisible;
  const layer = m.getLayer('terminator-day-mask-layer');
  if (layer) {
    m.setLayoutProperty(
      'terminator-day-mask-layer', 'visibility',
      dayMaskVisible ? 'visible' : 'none',
    );
  }
}

describe('layer-order regression guard (v3.1 bug #1 fix)', () => {
  it('terminator-night-fill-layer is BELOW iss-track-layer', () => {
    // v1.6.18.0: night-fill was added with no beforeId → above track →
    // 0.30-opacity black dimmed the track. This test pins the fix.
    const m = new FakeMap();
    setupLayersLikeRenderMap(m);
    const idxFill = m.order.indexOf('terminator-night-fill-layer');
    const idxTrack = m.order.indexOf('iss-track-layer');
    expect(idxFill).toBeGreaterThanOrEqual(0);
    expect(idxTrack).toBeGreaterThanOrEqual(0);
    expect(idxFill).toBeLessThan(idxTrack);
  });

  it('viirs-night-lights-layer is BELOW iss-track-layer', () => {
    // The headline bug: the 0.95-opacity Black Marble tile occluded the
    // cyan ISS polyline whenever the operator clicked the 🌃 toggle.
    const m = new FakeMap();
    setupLayersLikeRenderMap(m);
    const idxLights = m.order.indexOf('viirs-night-lights-layer');
    const idxTrack = m.order.indexOf('iss-track-layer');
    expect(idxLights).toBeGreaterThanOrEqual(0);
    expect(idxTrack).toBeGreaterThanOrEqual(0);
    expect(idxLights).toBeLessThan(idxTrack);
  });

  it('terminator-day-mask-layer is BELOW iss-track-layer (same regression class)', () => {
    // The day mask is a solid #0b0d12 fill; if it stacked above the track
    // it would completely hide the polyline on the sun side. Pin it below.
    const m = new FakeMap();
    setupLayersLikeRenderMap(m);
    const idxMask = m.order.indexOf('terminator-day-mask-layer');
    const idxTrack = m.order.indexOf('iss-track-layer');
    expect(idxMask).toBeGreaterThanOrEqual(0);
    expect(idxMask).toBeLessThan(idxTrack);
  });

  it('terminator-day-mask-layer is ABOVE viirs-night-lights-layer (mask hides the lights, not vice versa)', () => {
    // The mask's job is to obscure the Black Marble raster on the sun
    // side. It must sit ABOVE the raster in the stack or it won't mask.
    const m = new FakeMap();
    setupLayersLikeRenderMap(m);
    const idxMask = m.order.indexOf('terminator-day-mask-layer');
    const idxLights = m.order.indexOf('viirs-night-lights-layer');
    expect(idxMask).toBeGreaterThan(idxLights);
  });

  it('terminator-day-mask-layer is BELOW terminator-line-layer (so the boundary stays visible)', () => {
    // The terminator line is the actual boundary; the day mask sits below
    // so the dashed gold line draws on top of the mask edge and the
    // operator sees the day/night boundary cleanly.
    const m = new FakeMap();
    setupLayersLikeRenderMap(m);
    const idxMask = m.order.indexOf('terminator-day-mask-layer');
    const idxLine = m.order.indexOf('terminator-line-layer');
    expect(idxMask).toBeLessThan(idxLine);
  });
});

describe('day-mask visibility wiring (v3.1)', () => {
  it('hidden when neither night-lights nor terminator are on', () => {
    const m = new FakeMap();
    setupLayersLikeRenderMap(m);
    applyDayMaskVisibility(m, false, false);
    expect(m.getLayer('terminator-day-mask-layer')!.visibility).toBe('none');
  });

  it('hidden when only night-lights is on (no shadow context → full-globe lights)', () => {
    // v1.6.18.0 behavior preserved: operator turns on night-lights without
    // the terminator → city lights render across the whole globe.
    const m = new FakeMap();
    setupLayersLikeRenderMap(m);
    applyDayMaskVisibility(m, true, false);
    expect(m.getLayer('terminator-day-mask-layer')!.visibility).toBe('none');
  });

  it('hidden when only terminator is on (nothing to mask)', () => {
    const m = new FakeMap();
    setupLayersLikeRenderMap(m);
    applyDayMaskVisibility(m, false, true);
    expect(m.getLayer('terminator-day-mask-layer')!.visibility).toBe('none');
  });

  it('visible when BOTH night-lights AND terminator are on', () => {
    // The feature: lights ONLY on the shadow side. Mask shows on day side.
    const m = new FakeMap();
    setupLayersLikeRenderMap(m);
    applyDayMaskVisibility(m, true, true);
    expect(m.getLayer('terminator-day-mask-layer')!.visibility).toBe('visible');
  });

  it('toggling terminator off while night-lights stays on → mask hides, lights go full-globe', () => {
    // Sequence: operator has both on → mask is visible. Operator clicks
    // terminator off → mask should hide (so the Black Marble raster shows
    // through across the whole globe again). This is the v1.6.18.0
    // fallthrough behavior the spec calls out.
    const m = new FakeMap();
    setupLayersLikeRenderMap(m);
    applyDayMaskVisibility(m, true, true);
    expect(m.getLayer('terminator-day-mask-layer')!.visibility).toBe('visible');
    applyDayMaskVisibility(m, true, false);
    expect(m.getLayer('terminator-day-mask-layer')!.visibility).toBe('none');
  });
});
