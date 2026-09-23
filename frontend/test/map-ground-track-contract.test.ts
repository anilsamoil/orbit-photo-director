import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Track } from '../src/types';
import {
  MANIFEST_FIXTURE,
  buildMapDock,
  renderedMap,
  resetMaplibreDouble,
  stubArtifactFetch,
} from './maplibre-double';

vi.mock('maplibre-gl', async () => (await import('./maplibre-double')).maplibreModuleMock());

const NOW = Date.parse('2026-05-04T12:10:00Z');
const ORBIT_1_LON = 55.68;

const ISS_TLE = {
  line1: '1 25544U 98067A   26161.50000000  .00016717  00000-0  30771-3 0  9991',
  line2: '2 25544  51.6400  10.0000 0003000  86.0000 274.1000 15.50000000123456',
};

function sample(t: number): [number, number, number] {
  return [t, 10, t / 100];
}

const WIDE_TRACK: Track = {
  iss_polynomial: {
    start: '2026-05-04T12:00:00Z',
    duration_seconds: 5400,
    lat_coeffs: [0, 0.01],
    lon_coeffs: [0, 0.06],
    polynomial_order: 1,
  },
  track_points: [
    sample(0), sample(1800), sample(3600), sample(5400),
    sample(5568), sample(7000), sample(9000), sample(11000),
    sample(11136), sample(13000),
  ],
  tle: ISS_TLE,
  tle_epoch: '',
  tle_age_hours: 0,
  tle_freshness_factor: 1,
};

const POLY_TRACK: Track = {
  iss_polynomial: {
    start: '2026-05-04T12:00:00Z',
    duration_seconds: 90,
    lat_coeffs: [1],
    lon_coeffs: [2],
    polynomial_order: 0,
  },
  tle_epoch: '',
  tle_age_hours: 0,
  tle_freshness_factor: 1,
};

let mapModule: typeof import('../src/map');

function click(): void {
  document.getElementById('toggle-multi-orbit')!.dispatchEvent(new Event('click'));
}

function trackFeatures(): GeoJSON.Feature[] {
  const source = renderedMap().getSource('iss-track');
  if (!source) throw new Error('iss-track source missing');
  const last = vi.mocked(source.setData).mock.calls.at(-1)?.[0] as GeoJSON.FeatureCollection | undefined;
  const data = last ?? (source.spec.data as GeoJSON.FeatureCollection);
  return data.features;
}

function orbitIndexes(features: GeoJSON.Feature[]): number[] {
  return [...new Set(features.map((feature) => Number(feature.properties?.orbit_index)))].sort((a, b) => a - b);
}

function hasLon(features: GeoJSON.Feature[], lon: number): boolean {
  return features.some((feature) => {
    const coords = (feature.geometry as GeoJSON.LineString).coordinates;
    return coords.some(([x]) => x !== undefined && (Math.abs(x - lon) < 1e-6 || Math.abs(x - lon - 360) < 1e-6 || Math.abs(x - lon + 360) < 1e-6));
  });
}

async function render(track: Track): Promise<void> {
  stubArtifactFetch({ 'passes.json': [], 'track.json': track });
  await mapModule.renderMap(MANIFEST_FIXTURE);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  buildMapDock();
  stubArtifactFetch({ 'passes.json': [], 'track.json': WIDE_TRACK });
  vi.resetModules();
  resetMaplibreDouble();
  mapModule = await import('../src/map');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('ground track through renderMap', () => {
  it('paints the illumination color matrix and the orbit opacity ramp', async () => {
    await render(WIDE_TRACK);
    expect(renderedMap().getLayer('iss-track-layer')).toMatchObject({
      id: 'iss-track-layer',
      type: 'line',
      source: 'iss-track',
      paint: {
        'line-color': [
          'match',
          ['coalesce', ['get', 'illumination'], 'iss-day'],
          'iss-day', [
            'match', ['coalesce', ['get', 'orbit_index'], 0],
            0, '#5cd0ff',
            1, '#5ce0c8',
            2, '#7cd99c',
            3, '#a8d680',
            '#5cd0ff',
          ],
          'iss-twilight', [
            'match', ['coalesce', ['get', 'orbit_index'], 0],
            0, '#d65cff',
            1, '#d680e0',
            2, '#cc94c8',
            3, '#bca0a8',
            '#d65cff',
          ],
          'iss-eclipse', [
            'match', ['coalesce', ['get', 'orbit_index'], 0],
            0, '#7a8aa8',
            1, '#7392ac',
            2, '#6c9aac',
            3, '#65a0a0',
            '#7a8aa8',
          ],
          '#5cd0ff',
        ],
        'line-width': 2,
        'line-opacity': [
          'match',
          ['coalesce', ['get', 'orbit_index'], 0],
          0, 0.85,
          1, 0.55,
          2, 0.35,
          3, 0.2,
          0.12,
        ],
        'line-dasharray': [2, 1],
      },
    });
  });

  it('draws the current orbit until the operator asks for the next ones', async () => {
    await render(WIDE_TRACK);
    const button = document.getElementById('toggle-multi-orbit');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.title).toBe('Showing current orbit only — click to show next 4 orbits');
    expect(orbitIndexes(trackFeatures())).toEqual([0]);
    expect(hasLon(trackFeatures(), ORBIT_1_LON)).toBe(false);

    click();
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.title).toBe('Showing 4 future orbits — click to show just the current orbit');
    expect(localStorage.getItem('opd-map-multi-orbit-visible')).toBe('1');
    expect(orbitIndexes(trackFeatures())).toEqual([0, 1, 2]);
    expect(hasLon(trackFeatures(), ORBIT_1_LON)).toBe(true);

    click();
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem('opd-map-multi-orbit-visible')).toBe('0');
    expect(orbitIndexes(trackFeatures())).toEqual([0]);
  });

  it('opens on the stored multi-orbit choice', async () => {
    localStorage.setItem('opd-map-multi-orbit-visible', '1');
    vi.resetModules();
    resetMaplibreDouble();
    mapModule = await import('../src/map');
    await render(WIDE_TRACK);
    expect(document.getElementById('toggle-multi-orbit')?.getAttribute('aria-pressed')).toBe('true');
    expect(orbitIndexes(trackFeatures())).toEqual([0, 1, 2]);
  });

  it('draws one cyan orbit from the polynomial when the manifest has no samples', async () => {
    await render(POLY_TRACK);
    const features = trackFeatures();
    expect(features.length).toBeGreaterThan(0);
    expect(orbitIndexes(features)).toEqual([0]);
    expect(features.every((feature) => feature.properties?.illumination === 'iss-day')).toBe(true);
  });

  it('replaces the track with one orbit around the scrubbed instant', async () => {
    await render(WIDE_TRACK);
    click();
    expect(orbitIndexes(trackFeatures())).toEqual([0, 1, 2]);
    mapModule.setLookahead(90, false);
    const scrubbed = trackFeatures();
    expect(scrubbed.length).toBeGreaterThan(0);
    expect(orbitIndexes(scrubbed)).toEqual([0]);
    expect(hasLon(scrubbed, ORBIT_1_LON)).toBe(false);
    mapModule.setLookahead(0, false);
    expect(orbitIndexes(trackFeatures())).toEqual([0, 1, 2]);
  });
});
