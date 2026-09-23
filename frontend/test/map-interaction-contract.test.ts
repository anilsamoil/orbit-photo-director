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

const BASEMAP_LAYERS = [
  'carto-dark-layer',
  'esri-imagery-layer',
  'gibs-clouds-layer',
  'geo-ir-layer',
] as const;

function basemapVisibility(): Record<string, string | undefined> {
  const map = renderedMap();
  return Object.fromEntries(BASEMAP_LAYERS.map((id) => [id, map.visibilityOf(id)]));
}

function click(id: string): void {
  document.getElementById(id)!.dispatchEvent(new Event('click'));
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

describe('basemap swap', () => {
  it('opens on the dark basemap with the daily cloud raster over it', () => {
    expect(basemapVisibility()).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'visible',
      'geo-ir-layer': 'none',
    });
  });

  it('swaps dark basemap for Esri imagery when the operator hides clouds', () => {
    click('toggle-clouds');
    expect(basemapVisibility()).toEqual({
      'carto-dark-layer': 'none',
      'esri-imagery-layer': 'visible',
      'gibs-clouds-layer': 'none',
      'geo-ir-layer': 'none',
    });
  });

  it('returns to the dark basemap when clouds come back', () => {
    click('toggle-clouds');
    click('toggle-clouds');
    expect(basemapVisibility()).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'visible',
      'geo-ir-layer': 'none',
    });
  });

  it('keeps the dark basemap under IR, because IR is drawn for a dark backdrop', () => {
    click('toggle-clouds');
    click('toggle-ir');
    expect(basemapVisibility()).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'none',
      'geo-ir-layer': 'visible',
    });
  });

  it('drops IR when the operator turns the daily clouds back on', () => {
    click('toggle-clouds');
    click('toggle-ir');
    click('toggle-clouds');
    expect(basemapVisibility()).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'visible',
      'geo-ir-layer': 'none',
    });
  });

  it('swaps by layer visibility, never by rebuilding the style', () => {
    const before = [...renderedMap().layerOrder];
    click('toggle-clouds');
    click('toggle-ir');
    expect(renderedMap().layerOrder).toEqual(before);
    expect(currentMaplibreDouble().constructed).toHaveLength(1);
  });
});

describe('overlay toggles', () => {
  it('shows labels by default and hides them on click', () => {
    expect(renderedMap().visibilityOf('esri-labels-reference-layer')).toBe('visible');
    click('toggle-labels');
    expect(renderedMap().visibilityOf('esri-labels-reference-layer')).toBe('none');
  });

  it('shows the terminator line, fill and subsolar dot together', () => {
    const terminator = () => [
      renderedMap().visibilityOf('terminator-line-layer'),
      renderedMap().visibilityOf('terminator-night-fill-layer'),
      renderedMap().visibilityOf('subsolar-point-layer'),
    ];
    expect(terminator()).toEqual(['visible', 'visible', 'visible']);
    click('toggle-terminator');
    expect(terminator()).toEqual(['none', 'none', 'none']);
  });

  it('dims the whole globe for night lights only once the terminator is off', () => {
    click('toggle-night-lights');
    expect(renderedMap().visibilityOf('viirs-night-lights-layer')).toBe('visible');
    expect(renderedMap().visibilityOf('night-lights-global-dim-layer')).toBe('none');
    click('toggle-terminator');
    expect(renderedMap().visibilityOf('night-lights-global-dim-layer')).toBe('visible');
  });

  it('persists every overlay choice so the next session opens the same way', () => {
    click('toggle-clouds');
    click('toggle-labels');
    click('toggle-terminator');
    click('toggle-night-lights');
    expect({
      clouds: localStorage.getItem('opd-map-clouds-visible'),
      labels: localStorage.getItem('opd-map-labels-visible'),
      terminator: localStorage.getItem('opd-map-terminator-visible'),
      nightLights: localStorage.getItem('opd-map-night-lights-visible'),
    }).toEqual({ clouds: '0', labels: '0', terminator: '0', nightLights: '1' });
  });
});

describe('selecting a target', () => {
  const target = {
    properties: {
      target_id: 'curated:machu-picchu',
      target_name: 'Machu Picchu',
      has_pass: true,
      score: 72,
      closest_approach: '2026-05-04T13:00:00Z',
    },
    geometry: { type: 'Point', coordinates: [-72.5, -13.16] },
  };

  it('opens one popup naming the target the operator tapped', () => {
    const map = renderedMap();
    map.renderedFeatures = { 'targets-layer': [target] };
    map.fire('click', { point: { x: -72.5, y: -13.16 }, lngLat: { lng: -72.5, lat: -13.16 } });
    const { popups } = currentMaplibreDouble();
    expect(popups).toHaveLength(1);
    expect(popups[0]?.added).toBe(map);
    expect(popups[0]?.lngLat).toEqual([-72.5, -13.16]);
    expect(popups[0]?.content?.textContent).toContain('Machu Picchu');
  });

  it('hit-tests the two target layers and defers to the higher-priority pins', () => {
    const map = renderedMap();
    map.renderedFeatures = { 'targets-layer': [target] };
    map.fire('click', { point: { x: -72.5, y: -13.16 }, lngLat: { lng: -72.5, lat: -13.16 } });
    expect(map.queryCalls.map((call) => call.layers)).toEqual([
      ['ascent-pad-layer'],
      ['targets-layer', 'my-targets-layer'],
    ]);
  });

  it('opens no popup when the tap lands on empty ocean', () => {
    renderedMap().fire('click', { point: { x: 10, y: 10 }, lngLat: { lng: 10, lat: 10 } });
    expect(currentMaplibreDouble().popups).toHaveLength(0);
  });
});

describe('overlay add and remove', () => {
  it('adds the lookup pin source and layer on first drop, then reuses them', () => {
    const map = renderedMap();
    const drop = { lat: 51.5, lon: -0.12, alt_km: 420, timestamp_utc: new Date('2026-05-04T12:10:00Z') };
    mapModule.dropLookupPin(drop);
    expect(map.sources.has('lookup-pin')).toBe(true);
    expect(map.layerOrder.at(-1)).toBe('lookup-pin-layer');
    const layers = [...map.layerOrder];
    mapModule.dropLookupPin({ ...drop, lat: 40.7, lon: -74 });
    expect(map.layerOrder).toEqual(layers);
  });

  it('eases the camera to the looked-up position without dropping below zoom 4', () => {
    const map = renderedMap();
    mapModule.dropLookupPin({ lat: 51.5, lon: -0.12, alt_km: 420, timestamp_utc: new Date() });
    expect(map.cameraCalls.filter((call) => call.method === 'easeTo').at(-1)?.args).toEqual([
      { center: [-0.12, 51.5], zoom: 4, duration: 800 },
    ]);
  });
});
