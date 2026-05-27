import { describe, expect, it } from 'vitest';

// v2 (Chris feedback 2026-05-27): Esri Reference labels overlay toggle.
// Test the visibility-toggle contract and the localStorage persistence
// pattern. Same inline-logic style as map-basemap.test.ts because MapLibre
// doesn't run in happy-dom.

interface FakeLayer {
  id: string;
  visibility: 'visible' | 'none';
}

class FakeMap {
  layers: Map<string, FakeLayer>;
  constructor() {
    this.layers = new Map([
      ['esri-labels-reference-layer', { id: 'esri-labels-reference-layer', visibility: 'visible' }],
    ]);
  }
  getLayer(id: string): FakeLayer | undefined { return this.layers.get(id); }
  setLayoutProperty(id: string, _prop: string, value: 'visible' | 'none'): void {
    const layer = this.layers.get(id);
    if (layer) layer.visibility = value;
  }
}

/** Mirrors map.ts:applyLabelsVisibility. */
function applyVis(map: FakeMap, labelsVisible: boolean): void {
  if (map.getLayer('esri-labels-reference-layer')) {
    map.setLayoutProperty(
      'esri-labels-reference-layer', 'visibility', labelsVisible ? 'visible' : 'none',
    );
  }
}

describe('Esri labels visibility toggle', () => {
  it('shows the labels layer when labelsVisible=true', () => {
    const m = new FakeMap();
    applyVis(m, true);
    expect(m.getLayer('esri-labels-reference-layer')!.visibility).toBe('visible');
  });

  it('hides the labels layer when labelsVisible=false', () => {
    const m = new FakeMap();
    applyVis(m, false);
    expect(m.getLayer('esri-labels-reference-layer')!.visibility).toBe('none');
  });

  it('is idempotent — calling twice does not crash', () => {
    const m = new FakeMap();
    applyVis(m, true);
    applyVis(m, true);
    expect(m.getLayer('esri-labels-reference-layer')!.visibility).toBe('visible');
  });
});

// Persistence — default ON, persists via localStorage with same convention
// as the cloud and terminator toggles.
describe('labels visibility preference persistence', () => {
  const LABELS_PREF_KEY = 'opd-map-labels-visible';

  function readLabelsVisible(): boolean {
    try {
      const v = localStorage.getItem(LABELS_PREF_KEY);
      return v === null ? true : v === '1';
    } catch {
      return true;
    }
  }

  it('defaults to ON when no preference is stored', () => {
    localStorage.removeItem(LABELS_PREF_KEY);
    expect(readLabelsVisible()).toBe(true);
  });

  it('reads ON when stored as "1"', () => {
    localStorage.setItem(LABELS_PREF_KEY, '1');
    expect(readLabelsVisible()).toBe(true);
  });

  it('reads OFF when stored as "0"', () => {
    localStorage.setItem(LABELS_PREF_KEY, '0');
    expect(readLabelsVisible()).toBe(false);
  });
});
