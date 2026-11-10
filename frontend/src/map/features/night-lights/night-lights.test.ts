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

function mounted(clock = createClock()): VendorDouble {
  const vendor = createVendorDouble({
    sources: [['viirs-night-lights', { type: 'raster', tiles: ['https://v/{z}/{x}/{y}.png'], tileSize: 256 }]],
  });
  const core = createMapCore(vendor, clock);
  api().nightLights.mount(core);
  return vendor;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T11:45:00Z'));
  localStorage.clear();
  document.body.innerHTML = '<button id="toggle-night-lights" type="button"></button>';
  vi.resetModules();
  loaded.mod = await import('./index');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = '';
  loaded.mod = null;
});

describe('night-lights', () => {
  it('opens hidden, preserving overview intensity and restraining high-zoom glare', () => {
    const vendor = mounted();
    const layer = vendor.layers.find((entry) => entry.id === 'viirs-night-lights-layer');
    expect(layer).toMatchObject({
      type: 'raster',
      source: 'viirs-night-lights',
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.95, 4, 0.95, 6, 0.85, 8, 0.74] },
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

  it('updates the mask on a live minute, not each repaint, and follows scrubs in both directions', () => {
    const clock = createClock();
    const vendor = mounted(clock);
    click('toggle-night-lights');
    const changes = () => vendor.tilesSetOn.get('viirs-night-lights') ?? [];
    const initial = changes().at(-1)?.[0];
    expect(initial).toContain(`night=${Date.parse('2026-11-10T11:45:00Z')}`);
    vi.advanceTimersByTime(30_000);
    expect(changes()).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(changes()).toHaveLength(2);
    expect(changes().at(-1)?.[0]).not.toBe(initial);
    const future = Date.parse('2026-11-10T20:00:00Z');
    clock.setViewTime({ kind: 'scrubbed', atMs: future });
    expect(changes().at(-1)?.[0]).toContain(`night=${future}`);
    const count = changes().length;
    vi.advanceTimersByTime(120_000);
    expect(changes()).toHaveLength(count);
    clock.setViewTime({ kind: 'scrubbed', atMs: Date.parse('2026-11-10T11:45:00Z') });
    expect(changes().at(-1)?.[0]).toBe(initial);
    clock.setViewTime({ kind: 'live' });
    expect(changes().at(-1)?.[0]).toContain(`night=${Date.parse('2026-11-10T11:48:00Z')}`);
  });

  it('does not reload while hidden and resumes with the current view instant', () => {
    const clock = createClock();
    const vendor = mounted(clock);
    clock.setViewTime({ kind: 'scrubbed', atMs: 180_000 });
    expect(vendor.tilesSetOn.has('viirs-night-lights')).toBe(false);
    click('toggle-night-lights');
    expect(vendor.tilesSetOn.get('viirs-night-lights')?.at(-1)?.[0]).toContain('night=180000');
    expect(document.getElementById('toggle-night-lights')?.title).toContain('static 2016');
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
