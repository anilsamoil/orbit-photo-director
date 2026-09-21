import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const PARIS = { lng: 2.35, lat: 48.85 };
const SYDNEY = { lng: 151.21, lat: -33.87 };
const ONE_FINGER = [{ clientX: 10, clientY: 10 }];

function rightClick(at: { lng: number; lat: number }): void {
  renderedMap().fire('contextmenu', { preventDefault: () => {}, point: { x: 100, y: 100 }, lngLat: at });
}

function touch(
  event: 'touchstart' | 'touchmove' | 'touchend',
  touches: { clientX: number; clientY: number }[],
  at: { lng: number; lat: number } = PARIS,
): void {
  renderedMap().fire(event, { lngLat: at, originalEvent: { touches } });
}

function pinData(): GeoJSON.FeatureCollection | undefined {
  const source = renderedMap().getSource('dropped-pin');
  if (!source) return undefined;
  const writes = vi.mocked(source.setData).mock.calls;
  const last = writes.at(-1);
  return (last ? last[0] : source.spec.data) as GeoJSON.FeatureCollection;
}

function pinAt(lon: number, lat: number, precision: number): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { lat, lon, precision },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    }],
  };
}

function openPopups() {
  return currentMaplibreDouble().popups.filter((popup) => popup.isOpen());
}

function popupTitle(): string | undefined {
  return openPopups()[0]?.content?.querySelector('strong')?.textContent ?? undefined;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-04T12:10:00Z'));
  buildMapDock();
  stubArtifactFetch({ 'passes.json': [], 'track.json': TRACK_FIXTURE });
  vi.resetModules();
  resetMaplibreDouble();
  mapModule = await import('../src/map');
  await mapModule.renderMap(MANIFEST_FIXTURE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('dropping a pin', () => {
  it('a right-click drops one pin, rounded to whole degrees at world zoom, and opens its popup there', () => {
    rightClick(PARIS);

    expect(pinData()).toEqual(pinAt(2, 49, 0));
    expect(renderedMap().getLayer('dropped-pin-layer')).toEqual({
      id: 'dropped-pin-layer',
      type: 'circle',
      source: 'dropped-pin',
      paint: {
        'circle-radius': 11,
        'circle-color': '#5cd0ff',
        'circle-stroke-color': '#0b0d12',
        'circle-stroke-width': 3,
        'circle-opacity': 1.0,
      },
    });
    const [popup] = openPopups();
    expect(popup?.lngLat).toEqual([2, 49]);
    expect(popupTitle()).toBe('📍 49°N, 2°E');
    expect(popup?.content?.querySelector('.pin-add-button')?.textContent).toBe('➕ Add to my targets');
  });

  it('says so when no tracked satellite passes within 1500 km in 36 hours', () => {
    rightClick(PARIS);
    const body = openPopups()[0]?.content;
    expect(body?.textContent).toBe(
      '📍 49°N, 2°E'
      + 'No passes from any tracked satellite within 1500 km in the next 36 hours.'
      + 'Most low-Earth-orbit satellites have inclinations 27-65°; points near the poles see few passes.'
      + 'Closest-approach within 1500 km horizon. Click pin to dismiss.'
      + '➕ Add to my targets',
    );
  });

  it('a second right-click replaces the pin and its popup instead of stacking', () => {
    rightClick(PARIS);
    const [first] = openPopups();
    rightClick(SYDNEY);

    expect(pinData()).toEqual(pinAt(151, -34, 0));
    expect(first?.isOpen()).toBe(false);
    expect(openPopups()).toHaveLength(1);
    expect(popupTitle()).toBe('📍 34°S, 151°E');
  });

  it('clicking the pin dismisses it and its popup', () => {
    rightClick(PARIS);
    renderedMap().fire('click', { point: { x: 100, y: 100 }, lngLat: PARIS, features: [] }, 'dropped-pin-layer');

    expect(pinData()).toEqual({ type: 'FeatureCollection', features: [] });
    expect(openPopups()).toHaveLength(0);
  });

  it('hovering the pin shows a pointer cursor', () => {
    rightClick(PARIS);
    renderedMap().fire('mouseenter', undefined, 'dropped-pin-layer');
    expect(renderedMap().getCanvas().style.cursor).toBe('pointer');
    renderedMap().fire('mouseleave', undefined, 'dropped-pin-layer');
    expect(renderedMap().getCanvas().style.cursor).toBe('');
  });

  it('does nothing before the ISS track has loaded', () => {
    mapModule._setCurrentTrackForTest(null);
    rightClick(PARIS);
    expect(pinData()).toBeUndefined();
    expect(openPopups()).toHaveLength(0);
  });
});

describe('long-pressing on touch', () => {
  it('a single finger held for 500 ms drops the pin where it landed', () => {
    touch('touchstart', ONE_FINGER);
    vi.advanceTimersByTime(499);
    expect(pinData()).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(pinData()).toEqual(pinAt(2, 49, 0));
    expect(popupTitle()).toBe('📍 49°N, 2°E');
  });

  it('a finger that drifts more than 8 px is a pan, not a press', () => {
    touch('touchstart', ONE_FINGER);
    vi.advanceTimersByTime(200);
    touch('touchmove', [{ clientX: 19, clientY: 10 }]);
    vi.advanceTimersByTime(500);
    expect(pinData()).toBeUndefined();
  });

  it('a finger that drifts 8 px or less still drops the pin', () => {
    touch('touchstart', ONE_FINGER);
    vi.advanceTimersByTime(200);
    touch('touchmove', [{ clientX: 18, clientY: 10 }]);
    vi.advanceTimersByTime(300);
    expect(pinData()).toEqual(pinAt(2, 49, 0));
  });

  it('lifting the finger early cancels the press', () => {
    touch('touchstart', ONE_FINGER);
    vi.advanceTimersByTime(300);
    touch('touchend', []);
    vi.advanceTimersByTime(500);
    expect(pinData()).toBeUndefined();
  });

  it('two fingers never drop a pin', () => {
    touch('touchstart', [{ clientX: 10, clientY: 10 }, { clientX: 40, clientY: 40 }]);
    vi.advanceTimersByTime(600);
    expect(pinData()).toBeUndefined();
  });
});

describe('the pass list', () => {
  const ISS_TLE = {
    line1: '1 25544U 98067A   26161.50000000  .00016717  00000-0  30771-3 0  9991',
    line2: '2 25544  51.6400  10.0000 0003000  86.0000 274.1000 15.50000000123456',
  };

  function rows(): string[][] {
    const body = openPopups()[0]?.content;
    return Array.from(body?.querySelectorAll<HTMLElement>('div[style*="grid-template-columns"]') ?? [], (row) =>
      Array.from(row.children, (cell) => cell.textContent ?? ''));
  }

  function heading(): string | undefined {
    return openPopups()[0]?.content?.querySelector<HTMLElement>('strong + div')?.textContent ?? undefined;
  }

  beforeEach(async () => {
    vi.setSystemTime(new Date('2026-06-10T12:10:00Z'));
    stubArtifactFetch({
      'passes.json': [],
      'track.json': { ...TRACK_FIXTURE, tle: ISS_TLE, tle_epoch: '2026-06-10T12:00:00Z' },
    });
    vi.resetModules();
    resetMaplibreDouble();
    mapModule = await import('../src/map');
    await mapModule.renderMap(MANIFEST_FIXTURE);
  });

  it('lists the next ISS passes over the pin, one row of when, UTC, nadir distance, shoot-from hint and light', () => {
    rightClick(PARIS);
    expect(heading()).toBe(ISS_HEADING);
    expect(rows()).toEqual(ISS_ROWS);
  });

  it('measures the passes from the wall clock even while the map is scrubbed ahead', () => {
    mapModule.setLookahead(360, false);
    rightClick(PARIS);
    expect(heading()).toBe(ISS_HEADING);
    expect(rows()).toEqual(ISS_ROWS);
  });
});

const ISS_HEADING = 'ISS — next 5 passes';
const ISS_ROWS = [
  ['+11m', '12:20Z', '196 km', '26° right of track · WORF', 'day'],
  ['+1h48m', '13:57Z', '234 km', '30° right of track · WORF', 'day'],
  ['+3h25m', '15:34Z', '315 km', '37° left of track · Cupola', 'day'],
  ['+5h1m', '17:10Z', '1351 km', '68° left of track · Cupola', 'day'],
  ['+21h46m', '09:55Z', '660 km', '56° left of track · Cupola', 'day'],
];
