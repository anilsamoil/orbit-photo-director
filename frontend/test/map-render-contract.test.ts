import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { maplibreMapOptions, maplibreStyle } from '../src/map/adapters/maplibre';
import { initialCamera } from '../src/map/map-core/camera';
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

// map.ts keeps the map, the ISS marker and every bind*-once flag in module
// scope with no teardown, so a shared registry would let the first test
// decide what the rest observe. A fresh registry per test makes each case a
// first render.
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

describe('renderMap bring-up', () => {
  it('stacks seventeen layers bottom-first, basemap under overlays under labels', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    expect(renderedMap().layerOrder).toEqual([
      'esri-imagery-layer',
      'carto-dark-layer',
      'gibs-clouds-layer',
      'geo-ir-layer',
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
    ]);
  });

  it('inserts the three night layers below the ground track so the polyline stays visible', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const beforeTrack = renderedMap().addLayerCalls
      .filter((call) => call.beforeId !== undefined)
      .map((call) => [call.id, call.beforeId]);
    expect(beforeTrack).toEqual([
      ['night-lights-global-dim-layer', 'iss-track-layer'],
      ['terminator-night-fill-layer', 'iss-track-layer'],
      ['viirs-night-lights-layer', 'iss-track-layer'],
    ]);
  });

  it('adds every runtime layer in one documented sequence', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    expect(renderedMap().addLayerCalls.map((call) => call.id)).toEqual([
      'iss-track-layer',
      'my-targets-casing',
      'my-targets-layer',
      'targets-layer',
      'night-lights-global-dim-layer',
      'terminator-night-fill-layer',
      'viirs-night-lights-layer',
      'terminator-line-layer',
      'subsolar-point-layer',
      'ascent-trajectory-layer',
      'ascent-pad-layer',
      'esri-labels-reference-layer',
    ]);
  });

  it('wires every layer to a source that exists', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const map = renderedMap();
    const wiring = map.layerOrder.map((id) => [id, map.getLayer(id)?.source ?? null]);
    expect(wiring).toEqual([
      ['esri-imagery-layer', 'esri-imagery'],
      ['carto-dark-layer', 'carto-dark'],
      ['gibs-clouds-layer', 'gibs-clouds'],
      ['geo-ir-layer', 'geo-ir'],
      ['ne-coastline-layer', 'ne-coastline'],
      ['night-lights-global-dim-layer', null],
      ['terminator-night-fill-layer', 'terminator-night-fill'],
      ['viirs-night-lights-layer', 'viirs-night-lights'],
      ['iss-track-layer', 'iss-track'],
      ['my-targets-casing', 'my-targets'],
      ['my-targets-layer', 'my-targets'],
      ['targets-layer', 'targets'],
      ['terminator-line-layer', 'terminator-line'],
      ['subsolar-point-layer', 'subsolar-point'],
      ['ascent-trajectory-layer', 'ascent-trajectory'],
      ['ascent-pad-layer', 'ascent-pad'],
      ['esri-labels-reference-layer', 'esri-labels-reference'],
    ]);
    const dangling = wiring
      .filter(([, source]) => source !== null && !map.sources.has(source as string))
      .map(([id]) => id);
    expect(dangling).toEqual([]);
  });

  it('opens with the imagery, IR, night and launch overlays hidden', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const map = renderedMap();
    expect(map.layerOrder.filter((id) => map.visibilityOf(id) === 'none')).toEqual([
      'esri-imagery-layer',
      'geo-ir-layer',
      'night-lights-global-dim-layer',
      'viirs-night-lights-layer',
      'ascent-trajectory-layer',
      'ascent-pad-layer',
    ]);
  });

  it('constructs the map from buildStyle and initialCamera, not an inline literal', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const container = document.getElementById('map')!;
    const { style, container: constructedContainer, ...camera } = renderedMap().options;
    expect(constructedContainer).toBe(container);
    expect(style).toEqual(maplibreStyle(mapModule.buildStyle()));
    expect(camera).toEqual(maplibreMapOptions(initialCamera(container.clientWidth || window.innerWidth)));
  });

  it('adds the navigation control to the top left', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    expect(renderedMap().controls.map((entry) => entry.position)).toEqual(['top-left']);
  });

  it('places one ISS marker on the map at the track position for now', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const { markers } = currentMaplibreDouble();
    expect(markers).toHaveLength(1);
    expect(markers[0]?.added).toBe(renderedMap());
    expect(markers[0]?.options.anchor).toBe('center');
    expect(markers[0]?.lngLat).toEqual([0.06, 0.01]);
  });

  it('binds the interaction handlers the map needs to answer a tap', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    expect(renderedMap().handlers.map((entry) => `${entry.event}:${entry.layerId ?? '*'}`)).toEqual([
      'error:*',
      'click:*',
      'mouseenter:targets-layer',
      'mouseleave:targets-layer',
      'mouseenter:my-targets-layer',
      'mouseleave:my-targets-layer',
      'click:ascent-pad-layer',
      'mouseenter:ascent-pad-layer',
      'mouseleave:ascent-pad-layer',
      'styledata:*',
      'error:*',
      'error:*',
      'moveend:*',
      'data:*',
      'idle:*',
      'dragstart:*',
      'zoomstart:*',
      'contextmenu:*',
      'touchstart:*',
      'touchmove:*',
      'touchend:*',
      'click:dropped-pin-layer',
      'mouseenter:dropped-pin-layer',
      'mouseleave:dropped-pin-layer',
    ]);
  });

  it('is idempotent: a second render adds no duplicate layer, source or marker', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const map = renderedMap();
    const layers = [...map.layerOrder];
    const sources = [...map.sources.keys()];
    const addLayerCalls = map.addLayerCalls.length;
    await mapModule.renderMap(MANIFEST_FIXTURE);
    expect(map.layerOrder).toEqual(layers);
    expect([...map.sources.keys()]).toEqual(sources);
    expect(map.addLayerCalls).toHaveLength(addLayerCalls);
    expect(currentMaplibreDouble().constructed).toHaveLength(1);
    expect(currentMaplibreDouble().markers).toHaveLength(1);
  });
});
