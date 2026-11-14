import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVendorDouble, type VendorDouble } from '../../../../test/vendor-map-double';
import { liveIssPositionSGP4 } from '../../../iss-sgp4';
import { issSightWindows, sightText } from '../../../orbit-sight';
import { resolveOrbit, type OrbitLookup, type SatelliteMeta } from '../../../satellites';
import { UNPUBLISHED_TRACKED, type TrackedElements, type TrackedRecord, type TrackedUnavailable } from '../../../tracked';
import type { Track } from '../../../types';
import { createClock } from '../../map-core/clock';
import { createMapCore, type MapCore } from '../../map-core/core';
import type { LngLat } from '../../map-core/geometry';
import { PREF_KEYS } from '../../map-core/prefs';
import { applyPublishedOrbits, satellites } from './index';
import { orbitTrackFeatures } from './layers';

vi.mock('../../../satellites', async (importActual) => ({
  ...(await importActual<typeof import('../../../satellites')>()),
  resolveOrbit: vi.fn(),
}));

const real = await vi.importActual<typeof import('../../../satellites')>('../../../satellites');

const NOW = Date.parse('2026-05-04T12:10:00Z');

/** Both TLEs carry epoch 26124.5, 2026-05-04T12:00Z, ten minutes before
 *  the test clock. */
const TIANGONG = {
  line1: '1 48274U 21035A   26124.50000000  .00010000  00000-0  20000-3 0  9990',
  line2: '2 48274  41.4700  10.0000 0005000  86.0000 274.1000 15.60000000123456',
  name: 'CSS (TIANHE)',
};
const NOAA20 = {
  line1: '1 43013U 17073A   26124.50000000  .00000100  00000-0  10000-3 0  9990',
  line2: '2 43013  98.7000 100.0000 0001000  90.0000 270.0000 14.19500000123456',
  name: 'NOAA 20 (JPSS-1)',
};
const TLE_BY_CATNR: Record<number, typeof TIANGONG> = { 48274: TIANGONG, 43013: NOAA20 };

/** Epoch 26124.5 like the others. Sixteen revolutions a day is a 5,400 s orbit. */
const SHIP = {
  line1: '1 67001U 26210A   26124.50000000  .00000000  00000-0  00000-0 0  9990',
  line2: '2 67001  26.5000 270.0000 0003000  90.0000 270.0000 16.00000000    10',
  name: 'STARSHIP S41',
};
const STARSHIP_KEY = 'tracked:starship';
const FAILED_ROW = UNPUBLISHED_TRACKED[0] as TrackedUnavailable;
const NO_ORBIT_ROW: TrackedUnavailable = { ...FAILED_ROW, reason: 'no_public_orbit' };
const ELEMENTS_ROW: TrackedElements = {
  state: 'elements',
  id: 'starship',
  label: 'Starship',
  color: '#ff5c5c',
  lookup: FAILED_ROW.lookup,
  source: 'supgp',
  name: SHIP.name,
  norad: 67001,
  intldes: '26210A',
  line1: SHIP.line1,
  line2: SHIP.line2,
  epoch: '2026-05-04T12:00:00Z',
  age_hours: 0.17,
};

function orbit(lines: { line1: string; line2: string }): Track {
  return {
    tle: { line1: lines.line1, line2: lines.line2 },
    tle_epoch: '',
    tle_age_hours: 0,
    tle_freshness_factor: 1,
    iss_polynomial: { start: '', duration_seconds: 0, lat_coeffs: [], lon_coeffs: [], polynomial_order: 0 },
  } as Track;
}

function subPointAt(lines: { line1: string; line2: string }, atMs: number): LngLat {
  const track = orbit(lines);
  const pos = liveIssPositionSGP4(track, atMs);
  if (!pos) throw new Error('fixture TLE does not propagate');
  return [pos.lon, pos.lat];
}

function pickerDom(): void {
  document.body.innerHTML = `
    <button id="toggle-satellite-picker" type="button"></button>
    <div id="satellite-picker-panel" hidden>
      <div id="satellite-picker-list"></div>
      <input id="satellite-picker-input" type="text" />
      <button id="satellite-picker-add" type="button">Add</button>
      <div id="satellite-picker-status"></div>
    </div>`;
}

function rowFor(name: string): HTMLLabelElement {
  const row = [...document.querySelectorAll<HTMLLabelElement>('#satellite-picker-list label')]
    .find((label) => label.textContent?.includes(name));
  if (!row) throw new Error(`no picker row for ${name}`);
  return row;
}

function checkboxFor(name: string): HTMLInputElement {
  return rowFor(name).querySelector('input')!;
}

function noteFor(name: string): Element | null {
  return [...document.querySelectorAll('#satellite-picker-notes .sat-row-note')]
    .find((note) => note.textContent?.startsWith(`${name}:`)) ?? null;
}

function rowNames(): string[] {
  return [...document.querySelectorAll('#satellite-picker-list label')].map((label) => label.textContent ?? '');
}

function openPicker(): void {
  document.getElementById('toggle-satellite-picker')!.click();
}

function statusLine(): HTMLElement {
  return document.getElementById('satellite-picker-status')!;
}

/** What the test's CelesTrak answers to every request: a body, or a refusal. */
const feed: { answer: string | 'unreachable' } = { answer: 'unreachable' };

function askedCelestrak(): string[] {
  return vi.mocked(fetch).mock.calls.map(([url]) => String(url));
}

function lookedUp(): string[] {
  return vi.mocked(resolveOrbit).mock.calls
    .filter(([meta]) => meta.resolution.kind !== 'published')
    .map(([meta]) => meta.name);
}

async function publish(...records: TrackedRecord[]): Promise<void> {
  applyPublishedOrbits(records);
  await settle();
}

function diamond(vendor: VendorDouble) {
  return vendor.markers.filter((marker) => marker.element.classList.contains('tracked-marker')).at(-1);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function toggle(name: string): Promise<void> {
  const box = checkboxFor(name);
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change'));
  await settle();
}

function mounted(): { vendor: VendorDouble; core: MapCore } {
  const vendor = createVendorDouble({
    layers: [{ id: 'esri-labels-reference-layer', type: 'raster', source: 'esri-labels-reference' }],
    sources: [['esri-labels-reference', { type: 'raster', tiles: ['https://l/{z}/{x}/{y}.png'], tileSize: 256 }]],
  });
  const core = createMapCore(vendor, createClock());
  satellites.mount(core);
  return { vendor, core };
}

async function mountedWith(...keys: string[]): Promise<{ vendor: VendorDouble; core: MapCore }> {
  localStorage.setItem(PREF_KEYS.selectedSatellites, JSON.stringify(keys));
  const result = mounted();
  await settle();
  return result;
}

function trackStart(vendor: VendorDouble, key: string): LngLat | undefined {
  const source = vendor.sources.get(`sat-track-${key}`);
  if (!source || source.type !== 'geojson') return undefined;
  const line = (source.data as GeoJSON.FeatureCollection).features[0]?.geometry as GeoJSON.LineString | undefined;
  return line?.coordinates[0] as LngLat | undefined;
}

function markerFor(vendor: VendorDouble, title: string) {
  return vendor.markers.find((marker) => marker.element.title === title);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  pickerDom();
  feed.answer = 'unreachable';
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (feed.answer === 'unreachable') throw new TypeError('Failed to fetch');
    return new Response(feed.answer, { status: 200 });
  }));
  vi.mocked(resolveOrbit).mockImplementation(async (meta: SatelliteMeta, published, mode, nowMs): Promise<OrbitLookup> => {
    if (meta.resolution.kind === 'published') return real.resolveOrbit(meta, published, mode, nowMs);
    const tle = meta.resolution.kind === 'catnr' ? TLE_BY_CATNR[meta.resolution.catnr] : undefined;
    return tle
      ? { state: 'elements', tle, match_count: 1, origin: 'gp', stale: false }
      : { state: 'failed', cause: 'network' };
  });
  applyPublishedOrbits(UNPUBLISHED_TRACKED);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(resolveOrbit).mockReset();
  localStorage.clear();
});

describe('restoring a selection', () => {
  it('fetches each persisted satellite and paints its track above the labels, in the persisted order', async () => {
    const { vendor } = await mountedWith('48274', '43013');

    expect(lookedUp()).toEqual(['Tiangong (CSS)', 'NORAD 43013']);
    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer', 'sat-track-layer-48274', 'sat-track-layer-43013']);
    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, NOW));
    expect(markerFor(vendor, '🛰 NORAD 43013')?.at).toEqual(subPointAt(NOAA20, NOW));
  });

  it('publishes every tracked satellite to the shared view, with the topbar label and an SGP4 track', async () => {
    const { core } = await mountedWith('48274');

    expect(core.view().satellites).toEqual([
      {
        name: 'Tiangong (CSS)',
        label: 'Tg',
        color: '#ff9e2c',
        track: expect.objectContaining({ tle: { line1: TIANGONG.line1, line2: TIANGONG.line2 } }),
      },
    ]);
  });

  it('drops a persisted key it cannot resolve, and keeps wanting a satellite whose lookup failed without drawing it', async () => {
    const { vendor, core } = await mountedWith('not-a-key', '99999', '48274');
    openPicker();

    expect(lookedUp()).toEqual(['NORAD 99999', 'Tiangong (CSS)']);
    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer', 'sat-track-layer-48274']);
    expect(core.view().satellites.map((sat) => sat.name)).toEqual(['Tiangong (CSS)']);
    expect(checkboxFor('NORAD 99999').checked).toBe(true);
    expect(noteFor('NORAD 99999')?.textContent)
      .toBe('NORAD 99999: orbit lookup failed, CelesTrak could not be reached from this browser. No orbit is drawn.');
    expect(localStorage.getItem(PREF_KEYS.selectedSatellites)).toBe('["not-a-key","99999","48274"]');
  });

  it('forgets the name search Starship used before it was published', async () => {
    await mountedWith('name:STARSHIP');

    expect(lookedUp()).toEqual([]);
    expect(askedCelestrak()).toEqual([]);
  });
});

describe('the picker', () => {
  it('checking a curated satellite tracks it and unchecking removes its track, source, marker and view entry', async () => {
    const { vendor, core } = mounted();
    document.getElementById('toggle-satellite-picker')!.click();

    await toggle('Tiangong');
    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer', 'sat-track-layer-48274']);
    expect(core.view().satellites.map((sat) => sat.label)).toEqual(['Tg']);
    expect(localStorage.getItem(PREF_KEYS.selectedSatellites)).toBe('["48274"]');

    await toggle('Tiangong');
    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer']);
    expect(vendor.sources.has('sat-track-48274')).toBe(false);
    expect(markerFor(vendor, '🇨🇳 Tiangong (CSS)')?.removed).toBe(true);
    expect(core.view().satellites).toEqual([]);
    expect(localStorage.getItem(PREF_KEYS.selectedSatellites)).toBe('[]');
  });

  it('a checked row keeps its place in the list', async () => {
    mounted();
    openPicker();
    const before = rowNames().map((name) => name.replace('no orbit', ''));

    await toggle('Tiangong');
    await toggle('Hubble');

    expect(rowNames().map((name) => name.replace('no orbit', ''))).toEqual(before);
    expect(before).toEqual(['🇨🇳Tiangong (CSS)', '🔭Hubble (HST)', '🪐X-37B', '🚀Starship']);
  });

  it('typing the NORAD number of a satellite already tracked says so without fetching again', async () => {
    const { core } = await mountedWith('48274');
    document.getElementById('toggle-satellite-picker')!.click();
    expect(checkboxFor('Tiangong').checked).toBe(true);

    document.querySelector<HTMLInputElement>('#satellite-picker-input')!.value = '48274';
    document.getElementById('satellite-picker-add')!.click();
    await settle();

    expect(document.getElementById('satellite-picker-status')!.textContent).toBe('Already tracking');
    expect(lookedUp()).toEqual(['Tiangong (CSS)']);
    expect(core.view().satellites).toHaveLength(1);
  });
});

describe('a published vehicle', () => {
  it('is drawn from the publisher element set without a tap: diamond, dotted one-orbit track, and a place in the shared view', async () => {
    const { vendor, core } = mounted();
    await publish(ELEMENTS_ROW);

    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer', `sat-track-layer-${STARSHIP_KEY}`]);
    expect(vendor.layers.find((layer) => layer.id === `sat-track-layer-${STARSHIP_KEY}`)?.paint).toMatchObject({
      'line-color': '#ff5c5c',
      'line-dasharray': [1, 1.4],
    });
    expect(diamond(vendor)?.at).toEqual(subPointAt(SHIP, NOW));
    expect(diamond(vendor)?.element.title).toBe('Starship: STARSHIP S41');
    expect(diamond(vendor)?.element.querySelector('.tracked-marker-label')?.textContent).toBe('Starship');
    expect(trackStart(vendor, STARSHIP_KEY)).toEqual(subPointAt(SHIP, NOW));
    expect(core.view().satellites).toEqual([
      { name: 'Starship', label: 'SS', color: '#ff5c5c', track: expect.objectContaining({ tle: { line1: SHIP.line1, line2: SHIP.line2 } }) },
    ]);
    expect(askedCelestrak()).toEqual([]);
  });

  it('with no public orbit draws nothing, stays checked, and says so beside the row', async () => {
    const { vendor, core } = mounted();
    await publish(NO_ORBIT_ROW);
    openPicker();

    expect(vendor.markers).toEqual([]);
    expect(vendor.sources.has(`sat-track-${STARSHIP_KEY}`)).toBe(false);
    expect(core.view().satellites).toEqual([]);
    expect(checkboxFor('Starship').checked).toBe(true);
    expect(rowFor('Starship').querySelector('.sat-stale')?.textContent).toBe('no orbit');
    expect(noteFor('Starship')?.textContent)
      .toBe('Starship: no public orbit yet. CelesTrak GP and Supplemental GP list no element set for it.');
    expect(askedCelestrak()).toEqual([]);
  });

  it('with a failed publisher lookup says failed, not missing, and still does not ask CelesTrak on its own', async () => {
    mounted();
    await publish(FAILED_ROW);
    openPicker();

    expect(noteFor('Starship')?.textContent)
      .toBe('Starship: orbit lookup failed, the publisher could not reach CelesTrak. No orbit is drawn.');
    expect(noteFor('Starship')?.className).toBe('sat-row-note error');
    expect(askedCelestrak()).toEqual([]);
  });

  it('a tap asks CelesTrak, and a refused connection leaves the box checked with the cause shown', async () => {
    const { vendor } = mounted();
    await publish(FAILED_ROW);
    openPicker();
    await toggle('Starship');
    await toggle('Starship');

    expect(askedCelestrak()).toHaveLength(4);
    expect(checkboxFor('Starship').checked).toBe(true);
    const failed = 'Starship: orbit lookup failed, CelesTrak could not be reached from this browser. No orbit is drawn.';
    expect(statusLine().textContent).toBe(failed);
    expect(statusLine().className).toBe('satellite-picker-status error');
    expect(noteFor('Starship')?.textContent).toBe(failed);
    expect(vendor.markers).toEqual([]);
  });

  it('a tap that CelesTrak answers with no element set reads as no public orbit, not as a failure', async () => {
    mounted();
    await publish(FAILED_ROW);
    openPicker();
    await toggle('Starship');
    feed.answer = 'No GP data found';
    await toggle('Starship');

    expect(statusLine().textContent)
      .toBe('Starship: no public orbit yet. CelesTrak GP and Supplemental GP list no element set for it.');
    expect(checkboxFor('Starship').checked).toBe(true);
  });

  it('a tap that finds the ship in CelesTrak draws it, and the next failed publisher run keeps it as the last good orbit', async () => {
    const { vendor } = mounted();
    await publish(FAILED_ROW);
    openPicker();
    await toggle('Starship');
    feed.answer = `SHIP 41\n${SHIP.line1}\n${SHIP.line2}\n`;
    await toggle('Starship');

    expect(statusLine().textContent).toBe('Starship: drawing SHIP 41');
    expect(statusLine().className).toBe('satellite-picker-status success');
    expect(diamond(vendor)?.element.title).toBe('Starship: SHIP 41');

    await publish(FAILED_ROW);
    expect(diamond(vendor)?.removed).toBe(false);
    expect(rowFor('Starship').querySelector('.sat-stale')?.textContent).toBe('last good');
  });

  it('is erased once the publisher says the orbit aged out and the last good set is past its limit', async () => {
    const { vendor, core } = mounted();
    await publish(ELEMENTS_ROW);
    await publish({ ...FAILED_ROW, reason: 'aged_out' });
    expect(diamond(vendor)?.removed).toBe(false);

    vi.setSystemTime(NOW + 12 * 3_600_000);
    await publish({ ...FAILED_ROW, reason: 'aged_out' });

    expect(diamond(vendor)?.removed).toBe(true);
    expect(vendor.sources.has(`sat-track-${STARSHIP_KEY}`)).toBe(false);
    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer']);
    expect(core.view().satellites).toEqual([]);
  });

  it('a newer published element set replaces the marker title and the track', async () => {
    const { vendor } = mounted();
    await publish(ELEMENTS_ROW);
    await publish({ ...ELEMENTS_ROW, name: 'STARSHIP S41 R2', line2: NOAA20.line2.replace('43013', '67001') });

    expect(diamond(vendor)?.element.title).toBe('Starship: STARSHIP S41 R2');
    expect(vendor.markers.filter((marker) => !marker.removed)).toHaveLength(1);
  });

  it('unchecked, it stays off through later publisher runs and the next visit, until checked again', async () => {
    const { vendor } = mounted();
    await publish(ELEMENTS_ROW);
    openPicker();
    await toggle('Starship');

    expect(diamond(vendor)?.removed).toBe(true);
    expect(localStorage.getItem(PREF_KEYS.hiddenPublishedSatellites)).toBe(`["${STARSHIP_KEY}"]`);
    await publish(ELEMENTS_ROW);
    expect(vendor.markers.filter((marker) => !marker.removed)).toEqual([]);

    const next = mounted();
    await settle();
    expect(next.vendor.markers).toEqual([]);

    openPicker();
    await toggle('Starship');
    expect(diamond(next.vendor)?.at).toEqual(subPointAt(SHIP, NOW));
    expect(localStorage.getItem(PREF_KEYS.hiddenPublishedSatellites)).toBe('[]');
  });

  it('never enters the persisted selection, so the selection list means what it meant', async () => {
    mounted();
    await publish(ELEMENTS_ROW);
    openPicker();
    await toggle('Tiangong');

    expect(localStorage.getItem(PREF_KEYS.selectedSatellites)).toBe('["48274"]');
  });

  it('an object the operator added to the publisher gets its own row and orbit, and leaves with its row', async () => {
    const { vendor, core } = mounted();
    const added: TrackedElements = { ...ELEMENTS_ROW, id: 'ship-40', label: 'Ship 40', color: '#33ddaa', name: 'OBJECT A' };
    await publish(NO_ORBIT_ROW, added);
    openPicker();

    expect(rowNames()).toEqual(['🇨🇳Tiangong (CSS)', '🔭Hubble (HST)', '🪐X-37B', '🚀Starshipno orbit', '🚀Ship 40']);
    expect(checkboxFor('Ship 40').checked).toBe(true);
    expect(diamond(vendor)?.element.title).toBe('Ship 40: OBJECT A');
    expect(vendor.layers.find((layer) => layer.id === 'sat-track-layer-tracked:ship-40')?.paint).toMatchObject({ 'line-color': '#33ddaa' });

    await publish(NO_ORBIT_ROW);
    expect(diamond(vendor)?.removed).toBe(true);
    expect(vendor.sources.has('sat-track-tracked:ship-40')).toBe(false);
    expect(core.view().satellites).toEqual([]);
    expect(rowNames()).not.toContain('🚀Ship 40');
  });

  it('a publisher row for a curated satellite feeds that row instead of adding a second one', async () => {
    mounted();
    await publish(NO_ORBIT_ROW, { ...ELEMENTS_ROW, id: 'tiangong', label: 'Tiangong', norad: 48274 });
    openPicker();

    expect(rowNames().filter((name) => name.includes('Tiangong'))).toEqual(['🇨🇳Tiangong (CSS)']);
  });
});

describe('the row note', () => {
  it('says when the ISS has a line of sight to a drawn satellite', async () => {
    const { core } = mounted();
    const iss = orbit(TIANGONG);
    core.setTrack(iss);
    await publish(ELEMENTS_ROW);
    openPicker();

    const want = sightText(issSightWindows(iss, orbit(SHIP), NOW), NOW);
    expect(want).toMatch(/ISS line of sight/);
    expect(noteFor('Starship')?.textContent).toBe(`Starship: ${want}`);
    expect(noteFor('Starship')?.className).toBe('sat-row-note');
  });

  it('is absent for a drawn satellite when the ISS track is not loaded', async () => {
    mounted();
    await publish(ELEMENTS_ROW);
    openPicker();

    expect(noteFor('Starship')).toBeNull();
  });
});

describe('a typed satellite', () => {
  async function typeAndAdd(query: string): Promise<void> {
    document.querySelector<HTMLInputElement>('#satellite-picker-input')!.value = query;
    document.getElementById('satellite-picker-add')!.click();
    await settle();
  }

  it('that cannot be looked up is reported and not kept', async () => {
    const { core } = mounted();
    openPicker();
    await typeAndAdd('99999');

    expect(statusLine().textContent)
      .toBe('NORAD 99999: orbit lookup failed, CelesTrak could not be reached from this browser. No orbit is drawn.');
    expect(statusLine().className).toBe('satellite-picker-status error');
    expect(rowNames().some((name) => name.includes('99999'))).toBe(false);
    expect(core.view().satellites).toEqual([]);
    expect(localStorage.getItem(PREF_KEYS.selectedSatellites)).toBe('[]');
  });

  it('that resolves gets a row it can be unchecked from', async () => {
    const { vendor } = mounted();
    openPicker();
    await typeAndAdd('43013');
    expect(checkboxFor('NORAD 43013').checked).toBe(true);

    await toggle('NORAD 43013');

    expect(vendor.sources.has('sat-track-43013')).toBe(false);
    expect(rowNames().some((name) => name.includes('43013'))).toBe(false);
  });
});

describe('the clock', () => {
  it('a scrub moves the track window and the marker to the view instant', async () => {
    const { vendor, core } = await mountedWith('48274');
    const at = NOW + 6 * 3_600_000;

    core.clock.setViewTime({ kind: 'scrubbed', atMs: at });

    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, at));
    expect(markerFor(vendor, '🇨🇳 Tiangong (CSS)')?.at).toEqual(subPointAt(TIANGONG, at));
  });

  it('live, the marker moves every second and the window every minute', async () => {
    const { vendor } = await mountedWith('48274');

    vi.advanceTimersByTime(1_000);
    expect(markerFor(vendor, '🇨🇳 Tiangong (CSS)')?.at).toEqual(subPointAt(TIANGONG, NOW + 1_000));
    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, NOW));

    vi.advanceTimersByTime(59_000);
    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, NOW + 60_000));
  });

  it('scrubbed, the tickers leave both where the scrub put them', async () => {
    const { vendor, core } = await mountedWith('48274');
    const at = NOW + 6 * 3_600_000;
    core.clock.setViewTime({ kind: 'scrubbed', atMs: at });

    vi.advanceTimersByTime(60_000);

    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, at));
    expect(markerFor(vendor, '🇨🇳 Tiangong (CSS)')?.at).toEqual(subPointAt(TIANGONG, at));
  });

  it('back at live, both return to the wall clock', async () => {
    const { vendor, core } = await mountedWith('48274');
    core.clock.setViewTime({ kind: 'scrubbed', atMs: NOW + 6 * 3_600_000 });
    vi.setSystemTime(NOW + 30_000);

    core.clock.setViewTime({ kind: 'live' });

    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, NOW + 30_000));
    expect(markerFor(vendor, '🇨🇳 Tiangong (CSS)')?.at).toEqual(subPointAt(TIANGONG, NOW + 30_000));
  });
});

describe('orbitTrackFeatures', () => {
  const first = (features: GeoJSON.Feature[]): number[] =>
    (features[0]!.geometry as GeoJSON.LineString).coordinates[0]!;

  it('is a pure function of the TLE and the window start', () => {
    expect(orbitTrackFeatures(TIANGONG, NOW)).toEqual(orbitTrackFeatures(TIANGONG, NOW));
    expect(first(orbitTrackFeatures(TIANGONG, NOW))).toEqual(subPointAt(TIANGONG, NOW));
  });

  it('covers one orbit of that satellite, by its own period, in 30 s samples', () => {
    const points = (tle: typeof SHIP): number =>
      orbitTrackFeatures(tle, NOW)
        .filter((_feature, index) => index % 3 === 0)
        .reduce((sum, feature) => sum + (feature.geometry as GeoJSON.LineString).coordinates.length, 0);

    expect(points(SHIP)).toBe(5_400 / 30 + 1);
    expect(points(NOAA20)).toBe(Math.floor(86_400 / 14.195 / 30) + 1);
  });

  it('draws no line when the mean motion does not read', () => {
    expect(orbitTrackFeatures({ ...SHIP, line2: '2 67001 short' }, NOW)).toEqual([]);
  });

  it('starts the window at the instant asked for, not the wall clock', () => {
    const later = NOW + 6 * 3_600_000;
    expect(first(orbitTrackFeatures(TIANGONG, later))).toEqual(subPointAt(TIANGONG, later));
    expect(first(orbitTrackFeatures(TIANGONG, later))).not.toEqual(first(orbitTrackFeatures(TIANGONG, NOW)));
  });
});
