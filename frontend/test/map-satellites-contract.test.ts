import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { liveIssPositionSGP4 } from '../src/iss-sgp4';
import type { Track } from '../src/types';
import {
  MANIFEST_FIXTURE,
  TRACK_FIXTURE,
  buildMapDock,
  currentMaplibreDouble,
  renderedMap,
  resetMaplibreDouble,
  stubArtifactFetch,
} from './maplibre-double';

vi.mock('maplibre-gl', async () => (await import('./maplibre-double')).maplibreModuleMock());

let mapModule: typeof import('../src/map');
let launchMode: typeof import('../src/map-launch-mode');

const NOW = Date.parse('2026-05-04T12:10:00Z');

// Epoch 26124.5 = 2026-05-04T12:00Z, ten minutes before the test clock.
const TIANGONG = {
  line1: '1 48274U 21035A   26124.50000000  .00010000  00000-0  20000-3 0  9990',
  line2: '2 48274  41.4700  10.0000 0005000  86.0000 274.1000 15.60000000123456',
};
const NOAA20 = {
  line1: '1 43013U 17073A   26124.50000000  .00000100  00000-0  10000-3 0  9990',
  line2: '2 43013  98.7000 100.0000 0001000  90.0000 270.0000 14.19500000123456',
};
const USA_SEARCH = [
  ['USA 245', '1 39232U 13043A   26124.50000000  .00000100  00000-0  10000-3 0  9990', '2 39232  97.9000 200.0000 0001000  90.0000 270.0000 14.80000000123456'],
  ['USA 290', '1 44420U 19044A   26124.50000000  .00000100  00000-0  10000-3 0  9990', '2 44420  97.9000 210.0000 0001000  90.0000 270.0000 14.80000000123456'],
  ['USA 326', '1 51445U 22007A   26124.50000000  .00000100  00000-0  10000-3 0  9990', '2 51445  97.9000 220.0000 0001000  90.0000 270.0000 14.80000000123456'],
];

const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';
let celestrak: Record<string, string | null>;

function celestrakStub(): void {
  const artifacts = vi.mocked(fetch);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(CELESTRAK)) return artifacts(input as string, init);
    const query = url.slice(CELESTRAK.length + 1).replace('&FORMAT=TLE', '');
    const body = celestrak[query];
    if (body === undefined) throw new TypeError('network down');
    if (body === null) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  }));
}

function tle(lines: { line1: string; line2: string }, name?: string): string {
  return `${name ? `${name}\n` : ''}${lines.line1}\n${lines.line2}\n`;
}

function orbitOf(lines: { line1: string; line2: string }): Track {
  return {
    tle: lines,
    tle_epoch: '',
    tle_age_hours: 0,
    tle_freshness_factor: 1,
    iss_polynomial: { start: '', duration_seconds: 0, lat_coeffs: [], lon_coeffs: [], polynomial_order: 0 },
  } as Track;
}

function subPointAt(lines: { line1: string; line2: string }, atMs: number): [number, number] {
  const pos = liveIssPositionSGP4(orbitOf(lines), atMs);
  if (!pos) throw new Error('fixture TLE does not propagate');
  return [pos.lon, pos.lat];
}

function pickerDom(): void {
  const panel = document.createElement('div');
  panel.id = 'satellite-picker-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div id="satellite-picker-list"></div>
    <input id="satellite-picker-input" type="text" />
    <button id="satellite-picker-add" type="button">Add</button>
    <div id="satellite-picker-status" class="satellite-picker-status"></div>`;
  document.body.append(panel);
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const panel = (): HTMLElement => el('satellite-picker-panel');
const pickerButton = (): HTMLButtonElement => el('toggle-satellite-picker');
const status = (): HTMLElement => el('satellite-picker-status');
const rows = (): HTMLLabelElement[] => [...el('satellite-picker-list').querySelectorAll('label')];
const rowFor = (name: string): HTMLLabelElement => {
  const row = rows().find((label) => label.textContent?.includes(name));
  if (!row) throw new Error(`no picker row for ${name}`);
  return row;
};
const checkboxFor = (name: string): HTMLInputElement => rowFor(name).querySelector('input')!;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function check(name: string): Promise<void> {
  const box = checkboxFor(name);
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change'));
  return settle();
}

async function typeAndAdd(query: string): Promise<void> {
  el<HTMLInputElement>('satellite-picker-input').value = query;
  el('satellite-picker-add').click();
  await settle();
}

function trackData(key: string): GeoJSON.FeatureCollection | undefined {
  const source = renderedMap().getSource(`sat-track-${key}`);
  if (!source) return undefined;
  const last = vi.mocked(source.setData).mock.calls.at(-1);
  return (last ? last[0] : source.spec.data) as GeoJSON.FeatureCollection;
}

function trackStart(key: string): [number, number] | undefined {
  const line = trackData(key)?.features[0]?.geometry as GeoJSON.LineString | undefined;
  return line?.coordinates[0] as [number, number] | undefined;
}

function markerFor(title: string) {
  return currentMaplibreDouble().markers.find((m) => m.options.element?.title === title);
}

const persisted = (): string | null => localStorage.getItem('opd-selected-satellites');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  buildMapDock();
  pickerDom();
  stubArtifactFetch({ 'passes.json': [], 'track.json': TRACK_FIXTURE });
  celestrak = {
    'CATNR=48274': tle(TIANGONG, 'CSS (TIANHE)'),
    'CATNR=43013': tle(NOAA20, 'NOAA 20 (JPSS-1)'),
    'CATNR=99999': null,
    'NAME=USA': USA_SEARCH.map(([name, l1, l2]) => `${name}\n${l1}\n${l2}`).join('\n') + '\n',
    'NAME=NOSUCHBIRD': '',
  };
  celestrakStub();
  vi.resetModules();
  resetMaplibreDouble();
  launchMode = await import('../src/map-launch-mode');
  mapModule = await import('../src/map');
  await mapModule.renderMap(MANIFEST_FIXTURE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the picker', () => {
  it('opens from the dock button, lists the curated satellites other than the ISS, and closes again', () => {
    expect(panel().hidden).toBe(true);
    pickerButton().click();
    expect(panel().hidden).toBe(false);
    expect(pickerButton().classList.contains('active')).toBe(true);
    expect(rows().map((row) => row.textContent)).toEqual([
      '🇨🇳Tiangong (CSS)',
      '🔭Hubble (HST)',
      '🪐X-37B',
      '🚀Starship',
    ]);
    expect(rows().map((row) => row.querySelector('input')!.checked)).toEqual([false, false, false, false]);
    pickerButton().click();
    expect(panel().hidden).toBe(true);
    expect(pickerButton().classList.contains('active')).toBe(false);
  });

  it('closes on a click outside the panel, and stays open for a click inside it', () => {
    pickerButton().click();
    el('satellite-picker-list').click();
    expect(panel().hidden).toBe(false);
    document.body.click();
    expect(panel().hidden).toBe(true);
  });

  it('opening it leaves launch mode', () => {
    launchMode.setMapLaunchMode(true);
    pickerButton().click();
    expect(launchMode.getMapLaunchMode()).toBe(false);
  });
});

describe('tracking a satellite', () => {
  beforeEach(() => {
    pickerButton().click();
  });

  it('checking Tiangong fetches its TLE and paints a dashed track in its colour, above the labels', async () => {
    await check('Tiangong');

    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toContain(`${CELESTRAK}?CATNR=48274&FORMAT=TLE`);
    expect(renderedMap().getLayer('sat-track-layer-48274')).toEqual({
      id: 'sat-track-layer-48274',
      type: 'line',
      source: 'sat-track-48274',
      paint: {
        'line-color': '#ff9e2c',
        'line-width': 1.6,
        'line-opacity': 0.7,
        'line-dasharray': [3, 2],
      },
    });
    expect(renderedMap().layerOrder.slice(-2)).toEqual(['esri-labels-reference-layer', 'sat-track-layer-48274']);
    expect(trackStart('48274')).toEqual(subPointAt(TIANGONG, NOW));
    expect(status().textContent).toBe('Tracking added');
    expect(status().className).toBe('satellite-picker-status success');
    expect(checkboxFor('Tiangong').checked).toBe(true);
    expect(persisted()).toBe('["48274"]');
  });

  it('the track is one orbit of 30 s samples, split at the antimeridian and copied into both neighbouring worlds', async () => {
    await check('Tiangong');

    const features = trackData('48274')!.features;
    expect(features.length % 3).toBe(0);
    const [home, east, west] = features as GeoJSON.Feature<GeoJSON.LineString>[];
    const lons = (f: GeoJSON.Feature<GeoJSON.LineString>): number[] => f.geometry.coordinates.map(([lon]) => lon!);
    expect(lons(east!)).toEqual(lons(home!).map((lon) => lon + 360));
    expect(lons(west!)).toEqual(lons(home!).map((lon) => lon - 360));
    const samples = features.filter((_, i) => i % 3 === 0).reduce((n, f) => n + (f.geometry as GeoJSON.LineString).coordinates.length, 0);
    expect(samples).toBe(Math.floor(5568 / 30) + 1);
    expect(home!.geometry.coordinates[1]).toEqual(subPointAt(TIANGONG, NOW + 30_000));
  });

  it('gives the satellite a live marker in its colour at its sub-point', async () => {
    await check('Tiangong');

    const marker = markerFor('🇨🇳 Tiangong (CSS)');
    expect(marker?.added).toBe(renderedMap());
    expect(marker?.options.element?.className).toBe('sat-marker');
    expect(marker?.options.element?.style.background).toBe('#ff9e2c');
    expect(marker?.lngLat).toEqual(subPointAt(TIANGONG, NOW));
  });

  it('unchecking removes the track, its source and its marker, and forgets the selection', async () => {
    await check('Tiangong');
    await check('Tiangong');

    expect(renderedMap().getLayer('sat-track-layer-48274')).toBeUndefined();
    expect(renderedMap().getSource('sat-track-48274')).toBeUndefined();
    expect(markerFor('🇨🇳 Tiangong (CSS)')?.removed).toBe(true);
    expect(checkboxFor('Tiangong').checked).toBe(false);
    expect(persisted()).toBe('[]');
  });

  it('the topbar readout names each tracked satellite by its short label, live position and colour', async () => {
    await check('Tiangong');

    const [lon, lat] = subPointAt(TIANGONG, NOW);
    const text = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
    expect(mapModule.getSatelliteTopbarReadouts()).toEqual([{ label: 'Tg', text, color: '#ff9e2c' }]);
  });

  it('a NORAD number typed into the box tracks that satellite under a NORAD name', async () => {
    await typeAndAdd('43013');

    expect(renderedMap().getLayer('sat-track-layer-43013')?.paint).toMatchObject({ 'line-color': '#888' });
    expect(markerFor('🛰 NORAD 43013')?.lngLat).toEqual(subPointAt(NOAA20, NOW));
    expect(status().textContent).toBe('Tracking added');
    expect(el<HTMLInputElement>('satellite-picker-input').value).toBe('');
    expect(persisted()).toBe('["43013"]');
    expect(mapModule.getSatelliteTopbarReadouts()[0]).toMatchObject({ label: '013', color: '#888' });
  });

  it('a curated name search that matches several objects tracks the first and says so', async () => {
    await check('X-37B');

    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toContain(`${CELESTRAK}?NAME=USA&FORMAT=TLE`);
    expect(rowFor('X-37B').querySelector('.sat-multi-match')?.textContent).toBe('1 of 3');
    expect(trackStart('name:USA')).toEqual(subPointAt({ line1: USA_SEARCH[0]![1]!, line2: USA_SEARCH[0]![2]! }, NOW));
    expect(persisted()).toBe('["name:USA"]');
  });

  it('a stale cached TLE still paints, badged stale, when CelesTrak is unreachable', async () => {
    delete celestrak['CATNR=48274'];
    localStorage.setItem('opd-tle-48274', JSON.stringify({ tle: { ...TIANGONG, name: 'CSS' }, match_count: 1, fetchedAtMs: NOW - 7 * 3_600_000 }));

    await check('Tiangong');

    expect(renderedMap().getLayer('sat-track-layer-48274')).toBeDefined();
    expect(rowFor('Tiangong').querySelector('.sat-stale')?.textContent).toBe('stale TLE');
  });

  it('a lookup that finds nothing reports it and leaves the box unchecked', async () => {
    await typeAndAdd('99999');
    expect(status().textContent).toBe("Couldn't fetch TLE for NORAD 99999");
    expect(status().className).toBe('satellite-picker-status error');
    expect(el<HTMLInputElement>('satellite-picker-input').value).toBe('99999');

    await typeAndAdd('nosuchbird');
    expect(status().textContent).toBe('No satellite found for "NOSUCHBIRD"');
    expect(persisted()).toBeNull();
    expect(renderedMap().layerOrder.some((id) => id.startsWith('sat-track-layer-'))).toBe(false);
  });
});

describe('the clock', () => {
  beforeEach(async () => {
    pickerButton().click();
    await check('Tiangong');
  });

  it('a scrub moves the track window and the marker to the view instant', () => {
    mapModule.setLookahead(360, false);

    const at = NOW + 360 * 60_000;
    expect(trackStart('48274')).toEqual(subPointAt(TIANGONG, at));
    expect(markerFor('🇨🇳 Tiangong (CSS)')?.lngLat).toEqual(subPointAt(TIANGONG, at));
  });

  it('live, the 1 Hz hook moves the marker and the 60 s ticker advances the window', () => {
    vi.advanceTimersByTime(30_000);
    mapModule.tickSatelliteMarkers();
    expect(markerFor('🇨🇳 Tiangong (CSS)')?.lngLat).toEqual(subPointAt(TIANGONG, NOW + 30_000));

    expect(trackStart('48274')).toEqual(subPointAt(TIANGONG, NOW));
    vi.advanceTimersByTime(30_000);
    expect(trackStart('48274')).toEqual(subPointAt(TIANGONG, NOW + 60_000));
  });

  it('scrubbed, neither the 1 Hz hook nor the 60 s ticker moves anything', () => {
    mapModule.setLookahead(360, false);
    const at = NOW + 360 * 60_000;

    vi.advanceTimersByTime(30_000);
    mapModule.tickSatelliteMarkers();
    vi.advanceTimersByTime(30_000);

    expect(markerFor('🇨🇳 Tiangong (CSS)')?.lngLat).toEqual(subPointAt(TIANGONG, at));
    expect(trackStart('48274')).toEqual(subPointAt(TIANGONG, at));
  });

  it('back at Now the marker and window return to the wall clock', () => {
    mapModule.setLookahead(360, false);
    vi.setSystemTime(NOW + 30_000);
    mapModule.setLookahead(0, false);

    expect(markerFor('🇨🇳 Tiangong (CSS)')?.lngLat).toEqual(subPointAt(TIANGONG, NOW + 30_000));
    expect(trackStart('48274')).toEqual(subPointAt(TIANGONG, NOW + 30_000));
  });
});

describe('persistence', () => {
  it('a persisted selection is restored, fetched and painted on the next map render', async () => {
    localStorage.setItem('opd-selected-satellites', '["48274","43013"]');
    vi.resetModules();
    resetMaplibreDouble();
    mapModule = await import('../src/map');
    await mapModule.renderMap(MANIFEST_FIXTURE);
    await settle();

    expect(renderedMap().layerOrder.filter((id) => id.startsWith('sat-track-layer-'))).toEqual([
      'sat-track-layer-48274',
      'sat-track-layer-43013',
    ]);
    expect(markerFor('🛰 NORAD 43013')?.lngLat).toEqual(subPointAt(NOAA20, NOW));
    pickerButton().click();
    expect(checkboxFor('Tiangong').checked).toBe(true);
  });
});
