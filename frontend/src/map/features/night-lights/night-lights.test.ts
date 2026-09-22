import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVendorDouble, type VendorDouble } from '../../../../test/vendor-map-double';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';
import { PREF_KEYS } from '../../map-core/prefs';
import { CANONICAL_VIIRS_DATE } from './layers';

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('night-lights module was not loaded');
  return mod;
}

function click(id: string): void {
  const button = document.getElementById(id);
  if (!button) throw new Error(`missing #${id}`);
  button.dispatchEvent(new Event('click'));
}

function mounted(): VendorDouble {
  const vendor = createVendorDouble({
    sources: [['viirs-night-lights', { type: 'raster', tiles: ['https://v/{z}/{x}/{y}.png'], tileSize: 256 }]],
  });
  const core = createMapCore(vendor, createClock());
  api().nightLights.mount(core);
  return vendor;
}

beforeEach(async () => {
  localStorage.clear();
  document.body.innerHTML = '<button id="toggle-night-lights" type="button"></button>';
  vi.resetModules();
  loaded.mod = await import('./index');
});

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  loaded.mod = null;
});

describe('night-lights', () => {
  it('opens hidden at 95% opacity', () => {
    const vendor = mounted();
    const layer = vendor.layers.find((entry) => entry.id === 'viirs-night-lights-layer');
    expect(layer).toMatchObject({
      type: 'raster',
      source: 'viirs-night-lights',
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.95 },
    });
    expect(vendor.visibilityOf('viirs-night-lights-layer')).toBe('none');
    expect(vendor.visibilityOf('night-lights-global-dim-layer')).toBe('none');
    expect(document.getElementById('toggle-night-lights')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the raster on click and remembers that for the next visit', () => {
    const vendor = mounted();
    click('toggle-night-lights');
    expect(vendor.visibilityOf('viirs-night-lights-layer')).toBe('visible');
    expect(vendor.visibilityOf('night-lights-global-dim-layer')).toBe('none');
    expect(localStorage.getItem(PREF_KEYS.nightLightsVisible)).toBe('1');
    expect(document.getElementById('toggle-night-lights')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides on a tile error and retries the 2016 composite on the next click', () => {
    const vendor = mounted();
    click('toggle-night-lights');
    vendor.fire('error', { sourceId: 'viirs-night-lights' });
    expect(vendor.visibilityOf('viirs-night-lights-layer')).toBe('none');
    expect(localStorage.getItem(PREF_KEYS.nightLightsVisible)).toBe('0');
    click('toggle-night-lights');
    expect(vendor.tilesSetOn.get('viirs-night-lights')?.at(-1)?.[0]).toContain(CANONICAL_VIIRS_DATE);
    expect(vendor.visibilityOf('viirs-night-lights-layer')).toBe('visible');
  });
});
