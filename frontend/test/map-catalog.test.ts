import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LAYER_ORDER,
  SOURCE_IDS,
  beforeIdFor,
  isLayerId,
  positionOf,
  satTrackLayerId,
  satTrackSourceId,
  type LayerId,
  type SourceId,
} from '../src/map/map-core/catalog';
import {
  MANIFEST_FIXTURE,
  TRACK_FIXTURE,
  buildMapDock,
  renderedMap,
  resetMaplibreDouble,
  stubArtifactFetch,
} from './maplibre-double';

vi.mock('maplibre-gl', async () => (await import('./maplibre-double')).maplibreModuleMock());

describe('the layer catalog', () => {
  it('is the twenty-one slot paint order, bottom first', () => {
    expect([...LAYER_ORDER]).toEqual([
      'esri-imagery-layer',
      'carto-dark-layer',
      'gibs-clouds-layer',
      'geo-ir-layer',
      'fcst-clouds-layer',
      'ne-coastline-layer',
      'night-lights-global-dim-layer',
      'terminator-night-fill-layer',
      'viirs-night-lights-layer',
      'iss-track-layer',
      'my-targets-casing',
      'my-targets-layer',
      'targets-layer',
      'terminator-line-layer',
      'subsolar-point-layer',
      'ascent-trajectory-layer',
      'ascent-pad-layer',
      'esri-labels-reference-layer',
      'sat-track-layer-*',
      'lookup-pin-layer',
      'dropped-pin-layer',
    ]);
  });

  it('has no duplicate layer or source ids', () => {
    expect(new Set(LAYER_ORDER).size).toBe(LAYER_ORDER.length);
    expect(new Set(SOURCE_IDS).size).toBe(SOURCE_IDS.length);
  });

  it('places every satellite track in the one shared slot above the labels', () => {
    expect(positionOf(satTrackLayerId('iss'))).toBe(18);
    expect(positionOf(satTrackLayerId('tiangong'))).toBe(18);
    expect(positionOf('esri-labels-reference-layer')).toBe(17);
    expect(positionOf('lookup-pin-layer')).toBe(19);
  });

  it('derives the satellite ids from one key', () => {
    expect(satTrackLayerId('25544')).toBe('sat-track-layer-25544');
    expect(satTrackSourceId('25544')).toBe('sat-track-25544');
  });

  it('recognises catalog ids and rejects everything else', () => {
    expect(isLayerId('iss-track-layer')).toBe(true);
    expect(isLayerId('sat-track-layer-anything')).toBe(true);
    expect(isLayerId('terminator-day-mask-layer')).toBe(false);
    expect(isLayerId('targets-layr')).toBe(false);
    expect(() => positionOf('aurora-oval-layer' as LayerId)).toThrow('aurora-oval-layer is not in LAYER_ORDER');
  });

  it('does not let an unplaced id or a typo typecheck as a LayerId or SourceId', () => {
    // @ts-expect-error a layer that has no catalog position is not a LayerId
    const unplaced: LayerId = 'aurora-oval-layer';
    // @ts-expect-error a typo is not a LayerId
    const typo: LayerId = 'targets-layr';
    // @ts-expect-error a layer id is not a SourceId
    const wrongKind: SourceId = 'targets-layer';
    const fine: LayerId = 'sat-track-layer-25544';
    expect([unplaced, typo, wrongKind, fine]).toHaveLength(4);
  });
});

describe('beforeIdFor', () => {
  it('returns the nearest painted successor, not the top of the stack', () => {
    const painted: LayerId[] = ['carto-dark-layer', 'iss-track-layer', 'targets-layer', 'esri-labels-reference-layer'];
    expect(beforeIdFor('terminator-night-fill-layer', painted)).toBe('iss-track-layer');
    expect(beforeIdFor('my-targets-layer', painted)).toBe('targets-layer');
    expect(beforeIdFor('terminator-line-layer', painted)).toBe('esri-labels-reference-layer');
  });

  it('returns undefined when nothing above the layer is painted yet', () => {
    expect(beforeIdFor('dropped-pin-layer', ['carto-dark-layer', 'lookup-pin-layer'])).toBeUndefined();
    expect(beforeIdFor('esri-imagery-layer', [])).toBeUndefined();
  });

  it('is independent of the order the painted list is given in', () => {
    const bottomFirst: LayerId[] = ['gibs-clouds-layer', 'ne-coastline-layer', 'iss-track-layer', 'targets-layer'];
    const shuffled: LayerId[] = ['targets-layer', 'gibs-clouds-layer', 'iss-track-layer', 'ne-coastline-layer'];
    expect(beforeIdFor('fcst-clouds-layer', bottomFirst)).toBe('ne-coastline-layer');
    expect(beforeIdFor('fcst-clouds-layer', shuffled)).toBe('ne-coastline-layer');
  });

  it('puts a lookup pin under a dropped pin and a satellite track under both, whichever arrives first', () => {
    const base: LayerId[] = ['carto-dark-layer', 'esri-labels-reference-layer'];
    expect(beforeIdFor('lookup-pin-layer', [...base, 'dropped-pin-layer'])).toBe('dropped-pin-layer');
    expect(beforeIdFor('dropped-pin-layer', [...base, 'lookup-pin-layer'])).toBeUndefined();
    expect(beforeIdFor(satTrackLayerId('25544'), [...base, 'lookup-pin-layer'])).toBe('lookup-pin-layer');
    expect(beforeIdFor('lookup-pin-layer', [...base, satTrackLayerId('25544')])).toBeUndefined();
  });

  it('places a second satellite track beside the first, above the labels', () => {
    const painted: LayerId[] = ['esri-labels-reference-layer', satTrackLayerId('25544'), 'dropped-pin-layer'];
    expect(beforeIdFor(satTrackLayerId('48274'), painted)).toBe('dropped-pin-layer');
  });
});

describe('the catalog against what renderMap paints', () => {
  let mapModule: typeof import('../src/map');

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-04T12:10:00Z'));
    buildMapDock();
    stubArtifactFetch({ 'passes.json': [], 'track.json': TRACK_FIXTURE });
    vi.resetModules();
    resetMaplibreDouble();
    mapModule = await import('../src/map');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('every layer renderMap brings up is a catalog id, painted in ascending catalog position', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const painted = renderedMap().layerOrder;
    expect(painted).toHaveLength(17);
    for (const id of painted) expect(isLayerId(id)).toBe(true);
    const positions = painted.map((id) => positionOf(id as LayerId));
    expect(positions).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('every source renderMap declares or adds is a catalog source id', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const declared = [...renderedMap().sources.keys()].sort();
    const known = [...SOURCE_IDS].sort();
    for (const id of declared) expect(known).toContain(id);
  });

  it('places the night overlays under the ISS track and everything else on top, by catalog position alone', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const placed = renderedMap().addLayerCalls.filter((call) => call.beforeId !== undefined);
    expect(placed).toEqual([
      { id: 'night-lights-global-dim-layer', beforeId: 'iss-track-layer' },
      { id: 'terminator-night-fill-layer', beforeId: 'iss-track-layer' },
      { id: 'viirs-night-lights-layer', beforeId: 'iss-track-layer' },
    ]);
  });

  it('stacks the on-demand pins in catalog order whichever one the operator makes first', async () => {
    const drop = { lat: 51.5, lon: -0.12, alt_km: 420, timestamp_utc: new Date('2026-05-04T12:10:00Z') };
    const rightClick = () => renderedMap().fire('contextmenu', {
      preventDefault: () => {},
      lngLat: { lng: 2.35, lat: 48.85 },
    });

    await mapModule.renderMap(MANIFEST_FIXTURE);
    rightClick();
    mapModule.dropLookupPin(drop);
    expect(renderedMap().layerOrder.slice(-2)).toEqual(['lookup-pin-layer', 'dropped-pin-layer']);
    expect(renderedMap().addLayerCalls.at(-1)).toEqual({ id: 'lookup-pin-layer', beforeId: 'dropped-pin-layer' });

    vi.resetModules();
    resetMaplibreDouble();
    mapModule = await import('../src/map');
    await mapModule.renderMap(MANIFEST_FIXTURE);
    mapModule.dropLookupPin(drop);
    rightClick();
    expect(renderedMap().layerOrder.slice(-2)).toEqual(['lookup-pin-layer', 'dropped-pin-layer']);
  });
});
