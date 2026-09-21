import { describe, expect, it } from 'vitest';

import { buildStyle } from '../src/map';

// Characterization of the style MapLibre is constructed with. Layer array
// order is paint order, bottom first, so the id list below is behavior: the
// coastline has to sit above the cloud raster, and the night rasters that
// renderMap inserts later go under iss-track-layer because v1.6.18 stacked
// VIIRS above the ground track and hid it.

type LayerRow = [id: string, source: string | null, visibility: string];

function firstTileUrl(sourceId: string): string {
  const source = buildStyle().sources[sourceId];
  if (!source || !('tiles' in source)) throw new Error(`no raster source ${sourceId}`);
  return source.tiles?.[0] ?? '';
}

function layerRows(): LayerRow[] {
  return buildStyle().layers.map((layer) => [
    layer.id,
    'source' in layer && typeof layer.source === 'string' ? layer.source : null,
    layer.layout?.visibility ?? 'visible',
  ]);
}

describe('buildStyle', () => {
  it('declares the seven raster and vector sources the map runs on', () => {
    expect(Object.keys(buildStyle().sources).sort()).toEqual([
      'carto-dark',
      'esri-imagery',
      'esri-labels-reference',
      'geo-ir',
      'gibs-clouds',
      'ne-coastline',
      'viirs-night-lights',
    ]);
  });

  it('is a style spec version 8 document', () => {
    expect(buildStyle().version).toBe(8);
  });

  it('paints five layers, bottom first, each wired to its own source', () => {
    expect(layerRows()).toEqual([
      ['esri-imagery-layer', 'esri-imagery', 'none'],
      ['carto-dark-layer', 'carto-dark', 'visible'],
      ['gibs-clouds-layer', 'gibs-clouds', 'visible'],
      ['geo-ir-layer', 'geo-ir', 'none'],
      ['ne-coastline-layer', 'ne-coastline', 'visible'],
    ]);
  });

  it('ships the two opt-in rasters hidden so MapLibre fetches zero tiles', () => {
    const hidden = layerRows().filter(([, , visibility]) => visibility === 'none');
    expect(hidden.map(([id]) => id)).toEqual(['esri-imagery-layer', 'geo-ir-layer']);
  });

  it('keeps the basemap opaque and the cloud rasters semi-transparent', () => {
    const opacity = Object.fromEntries(
      buildStyle().layers
        .filter((layer) => layer.type === 'raster')
        .map((layer) => [layer.id, (layer.paint as Record<string, unknown>)['raster-opacity']]),
    );
    expect(opacity).toEqual({
      'esri-imagery-layer': 1.0,
      'carto-dark-layer': 1.0,
      'gibs-clouds-layer': 0.55,
      'geo-ir-layer': 0.82,
    });
  });

  it('draws the coastline as a thin warm line over the cloud raster', () => {
    const coastline = buildStyle().layers.find((l) => l.id === 'ne-coastline-layer');
    expect(coastline?.type).toBe('line');
    expect(coastline && 'paint' in coastline ? coastline.paint : null).toEqual({
      'line-color': '#f4d27a',
      'line-width': 0.6,
      'line-opacity': 0.75,
    });
  });

  it('caps every raster source at the zoom its provider actually serves', () => {
    const sources = buildStyle().sources;
    const maxzoom = Object.fromEntries(
      Object.entries(sources).map(([id, source]) => [
        id,
        'maxzoom' in source ? source.maxzoom : null,
      ]),
    );
    expect(maxzoom).toEqual({
      'carto-dark': 20,
      'gibs-clouds': 9,
      'esri-imagery': 19,
      'ne-coastline': null,
      'viirs-night-lights': 8,
      'geo-ir': 6,
      'esri-labels-reference': 19,
    });
  });

  it('serves the coastline from the bundled Natural Earth file, not a CDN', () => {
    const coastline = buildStyle().sources['ne-coastline'];
    expect(coastline).toMatchObject({ type: 'geojson', data: '/ne_110m_coastline.geojson' });
  });

  it('routes night lights through the viirs-alpha protocol that keys out the dark background', () => {
    expect(firstTileUrl('viirs-night-lights')).toMatch(/^viirs-alpha:\/\//);
  });

  it('pins night lights to 2016-01-01, the last date GIBS publishes Black Marble', () => {
    expect(firstTileUrl('viirs-night-lights')).toContain('2016-01-01');
  });

  it('attributes every source it renders', () => {
    const unattributed = Object.entries(buildStyle().sources)
      .filter(([, source]) => !('attribution' in source) || !source.attribution)
      .map(([id]) => id);
    expect(unattributed).toEqual([]);
  });

  it('leaves the labels layer out of the style so renderMap can add it last', () => {
    expect(layerRows().map(([id]) => id)).not.toContain('esri-labels-reference-layer');
    expect(buildStyle().sources['esri-labels-reference']).toBeDefined();
  });
});
