import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVendorDouble } from '../../../../test/vendor-map-double';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';
import { PREF_KEYS } from '../../map-core/prefs';

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('terminator module was not loaded');
  return mod;
}

const NOW = Date.parse('2026-05-04T12:10:00Z');

function click(): void {
  const button = document.getElementById('toggle-terminator');
  if (!button) throw new Error('missing #toggle-terminator');
  button.dispatchEvent(new Event('click'));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  localStorage.clear();
  document.body.innerHTML = '<button id="toggle-terminator" type="button"></button>';
  vi.resetModules();
  loaded.mod = await import('./index');
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = '';
  loaded.mod = null;
});

describe('terminator', () => {
  it('opens shown, with a line, a night fill, and a subsolar point at the view instant', () => {
    const clock = createClock(() => NOW);
    api().bindTerminatorClock(clock);
    const vendor = createVendorDouble();
    api().terminator.mount(createMapCore(vendor, clock));
    expect(vendor.visibilityOf('terminator-line-layer')).toBe('visible');
    expect(vendor.visibilityOf('terminator-night-fill-layer')).toBe('visible');
    expect(vendor.visibilityOf('subsolar-point-layer')).toBe('visible');
    expect(vendor.sources.get('terminator-line')?.type).toBe('geojson');
    expect(vendor.sources.get('terminator-night-fill')?.type).toBe('geojson');
    expect(vendor.sources.get('subsolar-point')?.type).toBe('geojson');
    expect(document.getElementById('toggle-terminator')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides on click and remembers that for the next visit', () => {
    const clock = createClock(() => NOW);
    api().bindTerminatorClock(clock);
    const vendor = createVendorDouble();
    api().terminator.mount(createMapCore(vendor, clock));
    click();
    expect(vendor.visibilityOf('terminator-line-layer')).toBe('none');
    expect(vendor.visibilityOf('terminator-night-fill-layer')).toBe('none');
    expect(vendor.visibilityOf('subsolar-point-layer')).toBe('none');
    expect(localStorage.getItem(PREF_KEYS.terminatorVisible)).toBe('0');
  });

  it('rebuilds the sources when the bound clock scrubs', () => {
    const clock = createClock(() => NOW);
    api().bindTerminatorClock(clock);
    const vendor = createVendorDouble();
    api().terminator.mount(createMapCore(vendor, clock));
    const live = vendor.sources.get('terminator-line');
    clock.setViewTime({ kind: 'scrubbed', atMs: NOW + 6 * 3_600_000 });
    expect(vendor.sources.get('terminator-line')).not.toBe(live);
  });

  it('rebuilds the sources every 30 s while live', () => {
    const clock = createClock(() => NOW);
    api().bindTerminatorClock(clock);
    const vendor = createVendorDouble();
    api().terminator.mount(createMapCore(vendor, clock));
    const live = vendor.sources.get('terminator-line');
    vi.advanceTimersByTime(30_000);
    expect(vendor.sources.get('terminator-line')).not.toBe(live);
  });
});
