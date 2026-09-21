import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Manifest } from '../../../types';
import { createVendorDouble, type VendorDouble } from '../../../../test/vendor-map-double';
import type { LayerId } from '../../map-core/catalog';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';
import type { LayerSpec } from '../../map-core/layer-spec';
import { PREF_KEYS } from '../../map-core/prefs';

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('basemap module was not loaded');
  return mod;
}

const LAYERS: LayerSpec[] = [
  { id: 'carto-dark-layer', type: 'raster', source: 'carto-dark' },
  { id: 'esri-imagery-layer', type: 'raster', source: 'esri-imagery' },
  { id: 'gibs-clouds-layer', type: 'raster', source: 'gibs-clouds' },
  { id: 'fcst-clouds-layer', type: 'raster', source: 'fcst-clouds' },
  { id: 'geo-ir-layer', type: 'raster', source: 'geo-ir' },
];

const MANIFEST: Manifest = {
  version: '20260504T120000Z',
  generated_at: '2026-05-04T12:00:00Z',
  tle_epoch: '2026-05-04T00:00:00Z',
  cloud_composite_hour: '2026-05-04T11:00:00Z',
  target_data_version: 'v1',
  build_version: '2.0.0.0',
  freshness: { tle_hours: 12, cloud_hours: 1, ok: true },
  artifacts: {},
};

function click(id: string): void {
  const button = document.getElementById(id);
  if (!button) throw new Error(`missing #${id}`);
  button.dispatchEvent(new Event('click'));
}

function shown(vendor: VendorDouble, id: LayerId): string | undefined {
  return vendor.visibilityOf(id);
}

function mounted(): VendorDouble {
  const vendor = createVendorDouble({
    layers: LAYERS,
    sources: [
      ['carto-dark', { type: 'raster', tiles: ['https://c/{z}/{x}/{y}.png'], tileSize: 256 }],
      ['esri-imagery', { type: 'raster', tiles: ['https://e/{z}/{x}/{y}.png'], tileSize: 256 }],
      ['gibs-clouds', { type: 'raster', tiles: ['https://g/{z}/{x}/{y}.png'], tileSize: 256 }],
      ['fcst-clouds', { type: 'raster', tiles: ['https://f/{z}/{x}/{y}.png'], tileSize: 256 }],
      ['geo-ir', { type: 'raster', tiles: ['https://ir/{z}/{x}/{y}.png'], tileSize: 256 }],
    ],
  });
  const clock = createClock();
  const { attachBasemap, basemap, bindBasemapClock, refreshBasemap } = api();
  bindBasemapClock(clock);
  const core = createMapCore(vendor, clock);
  attachBasemap(core);
  basemap.mount(core);
  refreshBasemap();
  return vendor;
}

beforeEach(async () => {
  vi.useFakeTimers();
  localStorage.clear();
  document.body.innerHTML = '<button id="toggle-clouds" type="button"></button><button id="toggle-ir" type="button"></button>';
  vi.resetModules();
  loaded.mod = await import('./index');
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = '';
  loaded.mod = null;
});

describe('basemap', () => {
  it('opens with clouds on the dark basemap', () => {
    const vendor = mounted();
    expect(shown(vendor, 'gibs-clouds-layer')).toBe('visible');
    expect(shown(vendor, 'carto-dark-layer')).toBe('visible');
    expect(shown(vendor, 'esri-imagery-layer')).toBe('none');
    expect(shown(vendor, 'geo-ir-layer')).toBe('none');
    expect(document.getElementById('toggle-clouds')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides clouds and shows Esri imagery', () => {
    const vendor = mounted();
    click('toggle-clouds');
    expect(shown(vendor, 'gibs-clouds-layer')).toBe('none');
    expect(shown(vendor, 'esri-imagery-layer')).toBe('visible');
    expect(shown(vendor, 'carto-dark-layer')).toBe('none');
    expect(document.getElementById('toggle-clouds')?.getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(PREF_KEYS.cloudsVisible)).toBe('0');
  });

  it('turns clouds off when IR turns on', () => {
    const vendor = mounted();
    click('toggle-ir');
    expect(document.getElementById('toggle-ir')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('toggle-clouds')?.getAttribute('aria-pressed')).toBe('false');
    expect(shown(vendor, 'geo-ir-layer')).toBe('visible');
    expect(shown(vendor, 'gibs-clouds-layer')).toBe('none');
    expect(shown(vendor, 'carto-dark-layer')).toBe('visible');
    expect(shown(vendor, 'esri-imagery-layer')).toBe('none');
    expect(localStorage.getItem(PREF_KEYS.irVisible)).toBe('1');
    expect(localStorage.getItem(PREF_KEYS.cloudsVisible)).toBe('0');
  });

  it('keeps Carto for the session after an Esri tile error', () => {
    const vendor = mounted();
    click('toggle-clouds');
    vendor.fire('error', { sourceId: 'esri-imagery' });
    expect(shown(vendor, 'esri-imagery-layer')).toBe('none');
    expect(shown(vendor, 'carto-dark-layer')).toBe('visible');
    click('toggle-clouds');
    click('toggle-clouds');
    expect(shown(vendor, 'esri-imagery-layer')).toBe('none');
    expect(shown(vendor, 'carto-dark-layer')).toBe('visible');
  });

  it('rewrites the imagery badge when the bound clock scrubs', () => {
    const clock = createClock(() => Date.parse('2026-05-04T12:10:00Z'));
    api().bindBasemapClock(clock);
    const host = document.createElement('div');
    api().ensureImageryDateBadge(host, MANIFEST);
    expect(host.querySelector('.map-imagery-date')?.textContent).toContain('Imagery:');
    clock.setViewTime({ kind: 'scrubbed', atMs: clock.now() + 6 * 3_600_000 });
    expect(host.querySelector('.map-imagery-date')?.textContent).toBe('Clouds: observed 2026-05-04 — not forecast');
  });
});
