import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVendorDouble, type VendorDouble } from '../../../../test/vendor-map-double';
import type { Track } from '../../../types';
import { createClock } from '../../map-core/clock';
import { createMapCore, type MapCore } from '../../map-core/core';
import { pinDrop } from './index';

vi.mock('../../../profile-crud', () => ({ handleAdd: vi.fn(async () => 'ok') }));

const ISS_TRACK: Track = {
  iss_polynomial: { start: '2026-06-10T12:00:00Z', duration_seconds: 0, lat_coeffs: [], lon_coeffs: [], polynomial_order: 0 },
  tle: {
    line1: '1 25544U 98067A   26161.50000000  .00016717  00000-0  30771-3 0  9991',
    line2: '2 25544  51.6400  10.0000 0003000  86.0000 274.1000 15.50000000123456',
  },
  tle_epoch: '2026-06-10T12:00:00Z',
  tle_age_hours: 0,
  tle_freshness_factor: 1,
};

const PARIS = { lngLat: [2.35, 48.85] as [number, number], point: { x: 100, y: 100 } };

function mounted(track: Track | null = ISS_TRACK): { vendor: VendorDouble; core: MapCore } {
  const vendor = createVendorDouble({
    layers: [{ id: 'carto-dark-layer', type: 'raster', source: 'carto-dark' }],
    sources: [['carto-dark', { type: 'raster', tiles: ['https://c/{z}/{x}/{y}.png'], tileSize: 256 }]],
  });
  const core = createMapCore(vendor, createClock());
  core.setTrack(track);
  pinDrop.mount(core);
  return { vendor, core };
}

function openPopup(vendor: VendorDouble) {
  return vendor.popups.filter((popup) => !popup.removed).at(-1);
}

function headingElements(vendor: VendorDouble): HTMLElement[] {
  return Array.from(openPopup(vendor)?.content.children ?? [])
    .filter((el): el is HTMLElement => /— next \d+ pass/.test(el.textContent ?? ''));
}

function headings(vendor: VendorDouble): string[] {
  return headingElements(vendor).map((el) => el.textContent ?? '');
}

function pinSource(vendor: VendorDouble): GeoJSON.FeatureCollection | undefined {
  const source = vendor.sources.get('dropped-pin');
  return source?.type === 'geojson' ? (source.data as GeoJSON.FeatureCollection) : undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-10T12:10:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sections', () => {
  it('lists the ISS first and then every selected satellite, in selection order', () => {
    const { vendor, core } = mounted();
    core.setSatellites([
      { name: 'Tiangong', color: '#ffb000', track: ISS_TRACK },
      { name: 'Hubble', color: '#8fd3ff', track: ISS_TRACK },
    ]);
    vendor.fire('contextmenu', PARIS);
    expect(headings(vendor)).toEqual(['ISS — next 5 passes', 'Tiangong — next 5 passes', 'Hubble — next 5 passes']);
  });

  it('colours each section heading with the satellite colour', () => {
    const { vendor, core } = mounted();
    core.setSatellites([{ name: 'Tiangong', color: '#ffb000', track: ISS_TRACK }]);
    vendor.fire('contextmenu', PARIS);
    const [iss, tiangong] = headingElements(vendor);
    expect(iss?.style.color).toBe('#5cd0ff');
    expect(tiangong?.style.color).toBe('#ffb000');
  });

  it('renders a satellite name as text, never as markup', () => {
    const { vendor, core } = mounted();
    core.setSatellites([{ name: '<b>Tiangong</b>', color: '#ffb000', track: ISS_TRACK }]);
    vendor.fire('contextmenu', PARIS);
    expect(headings(vendor)[1]).toBe('<b>Tiangong</b> — next 5 passes');
    expect(openPopup(vendor)!.content.querySelector('b')).toBeNull();
  });

  it('reads the satellites at drop time, so a later selection change shows on the next drop only', () => {
    const { vendor, core } = mounted();
    vendor.fire('contextmenu', PARIS);
    expect(headings(vendor)).toEqual(['ISS — next 5 passes']);
    core.setSatellites([{ name: 'Tiangong', color: '#ffb000', track: ISS_TRACK }]);
    expect(headings(vendor)).toEqual(['ISS — next 5 passes']);
    vendor.fire('contextmenu', PARIS);
    expect(headings(vendor)).toEqual(['ISS — next 5 passes', 'Tiangong — next 5 passes']);
  });
});

describe('saving the pin as a target', () => {
  it('closes the popup and clears the pin once the target is saved', async () => {
    const { vendor } = mounted();
    vendor.fire('contextmenu', PARIS);
    const body = openPopup(vendor)!.content;
    body.querySelector<HTMLButtonElement>('.pin-add-button')!.click();
    body.querySelector<HTMLButtonElement>('.pin-add-save')!.click();
    await vi.runAllTimersAsync();

    expect(vendor.popups.map((popup) => popup.removed)).toEqual([true]);
    expect(pinSource(vendor)).toEqual({ type: 'FeatureCollection', features: [] });
  });
});

describe('mounting', () => {
  it('answers its layer events from mount, before the first pin exists', () => {
    const { vendor } = mounted();
    vendor.fireLayer('mouseenter', 'dropped-pin-layer', undefined);
    expect(vendor.cursor).toBe('pointer');
    vendor.fireLayer('mouseleave', 'dropped-pin-layer', undefined);
    expect(vendor.cursor).toBe('');
  });

  it('drops nothing while the map has no ISS track', () => {
    const { vendor } = mounted(null);
    vendor.fire('contextmenu', PARIS);
    expect(pinSource(vendor)).toBeUndefined();
    expect(vendor.popups).toHaveLength(0);
  });

  it('paints the pin layer at its catalog position over whatever is on the map', () => {
    const { vendor } = mounted();
    vendor.fire('contextmenu', PARIS);
    expect(vendor.paintedLayers()).toEqual(['carto-dark-layer', 'dropped-pin-layer']);
  });
});
