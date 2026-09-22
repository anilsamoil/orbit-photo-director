import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVendorDouble, type VendorDouble } from '../../../../test/vendor-map-double';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';
import { PREF_KEYS } from '../../map-core/prefs';

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('labels module was not loaded');
  return mod;
}

function click(): void {
  const button = document.getElementById('toggle-labels');
  if (!button) throw new Error('missing #toggle-labels');
  button.dispatchEvent(new Event('click'));
}

function mounted(): VendorDouble {
  const vendor = createVendorDouble({
    sources: [['esri-labels-reference', { type: 'raster', tiles: ['https://l/{z}/{x}/{y}.png'], tileSize: 256 }]],
  });
  const core = createMapCore(vendor, createClock());
  api().labels.mount(core);
  return vendor;
}

beforeEach(async () => {
  localStorage.clear();
  document.body.innerHTML = '<button id="toggle-labels" type="button"></button>';
  vi.resetModules();
  loaded.mod = await import('./index');
});

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  loaded.mod = null;
});

describe('labels', () => {
  it('opens shown, at 85% opacity, above an empty map', () => {
    const vendor = mounted();
    const layer = vendor.layers.find((entry) => entry.id === 'esri-labels-reference-layer');
    expect(layer).toMatchObject({
      type: 'raster',
      source: 'esri-labels-reference',
      paint: { 'raster-opacity': 0.85 },
    });
    expect(vendor.visibilityOf('esri-labels-reference-layer')).toBe('visible');
    expect(document.getElementById('toggle-labels')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('toggle-labels')?.title).toBe('Country/city labels shown — click to hide');
  });

  it('hides on click and remembers that for the next visit', () => {
    const vendor = mounted();
    click();
    expect(vendor.visibilityOf('esri-labels-reference-layer')).toBe('none');
    expect(document.getElementById('toggle-labels')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.getElementById('toggle-labels')?.title).toBe('Country/city labels hidden — click to show');
    expect(localStorage.getItem(PREF_KEYS.labelsVisible)).toBe('0');
    click();
    expect(vendor.visibilityOf('esri-labels-reference-layer')).toBe('visible');
    expect(localStorage.getItem(PREF_KEYS.labelsVisible)).toBe('1');
  });

  it('stays hidden when the stored preference is off', async () => {
    localStorage.setItem(PREF_KEYS.labelsVisible, '0');
    vi.resetModules();
    loaded.mod = await import('./index');
    const vendor = mounted();
    expect(vendor.visibilityOf('esri-labels-reference-layer')).toBe('none');
    expect(document.getElementById('toggle-labels')?.getAttribute('aria-pressed')).toBe('false');
    expect(api().readLabelsVisible()).toBe(false);
  });
});
