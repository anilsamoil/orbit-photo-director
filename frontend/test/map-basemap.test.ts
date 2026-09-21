import { describe, expect, it } from 'vitest';

import { basemapVisibility } from '../src/map/features/basemap';

// The basemap arbiter picks which of the four basemap/cloud layers show.
// Clouds ON keeps the dark Carto basemap, because the 55%-opacity GIBS
// overlay is only legible over it. Clouds OFF swaps to Esri imagery so the
// operator can pick shoreline and pad features. IR is mutually exclusive
// with both cloud layers and forces Carto. T3 from /plan-eng-review
// 2026-05-21: offline with clouds off must fall back to Carto so the
// operator never sees a blank map.
//
// This suite calls the production function. An earlier revision duplicated
// the logic here and drifted: the copy omitted the IR and forecast gates.

const observed = { forecastFrameActive: false, esriTilesFailed: false };

describe('basemapVisibility', () => {
  it('clouds ON shows Carto Dark and the GIBS overlay, hides Esri', () => {
    expect(basemapVisibility({ cloudsVisible: true, irVisible: false, ...observed })).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'visible',
      'fcst-clouds-layer': 'none',
    });
  });

  it('clouds OFF swaps to Esri imagery and hides both cloud layers', () => {
    expect(basemapVisibility({ cloudsVisible: false, irVisible: false, ...observed })).toEqual({
      'carto-dark-layer': 'none',
      'esri-imagery-layer': 'visible',
      'gibs-clouds-layer': 'none',
      'fcst-clouds-layer': 'none',
    });
  });

  it('clouds OFF after an Esri tile failure falls back to Carto Dark (A2)', () => {
    expect(basemapVisibility({
      cloudsVisible: false,
      irVisible: false,
      forecastFrameActive: false,
      esriTilesFailed: true,
    })).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'none',
      'fcst-clouds-layer': 'none',
    });
  });

  it('clouds back ON after an Esri failure keeps Esri hidden for the session', () => {
    expect(basemapVisibility({
      cloudsVisible: true,
      irVisible: false,
      forecastFrameActive: false,
      esriTilesFailed: true,
    })).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'visible',
      'fcst-clouds-layer': 'none',
    });
  });

  it('IR ON hides the daily clouds and holds Carto, even with clouds ON (R1)', () => {
    expect(basemapVisibility({ cloudsVisible: true, irVisible: true, ...observed })).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'none',
      'fcst-clouds-layer': 'none',
    });
  });

  it('IR ON blocks the Esri swap that clouds OFF would otherwise make (R1)', () => {
    expect(basemapVisibility({ cloudsVisible: false, irVisible: true, ...observed })).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'none',
      'fcst-clouds-layer': 'none',
    });
  });

  it('an active forecast frame replaces the observed cloud layer (V4-P2)', () => {
    expect(basemapVisibility({
      cloudsVisible: true,
      irVisible: false,
      forecastFrameActive: true,
      esriTilesFailed: false,
    })).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'none',
      'fcst-clouds-layer': 'visible',
    });
  });

  it('clouds OFF hides the forecast frame and still swaps to Esri', () => {
    expect(basemapVisibility({
      cloudsVisible: false,
      irVisible: false,
      forecastFrameActive: true,
      esriTilesFailed: false,
    })).toEqual({
      'carto-dark-layer': 'none',
      'esri-imagery-layer': 'visible',
      'gibs-clouds-layer': 'none',
      'fcst-clouds-layer': 'none',
    });
  });

  it('IR ON beats an active forecast frame', () => {
    expect(basemapVisibility({
      cloudsVisible: true,
      irVisible: true,
      forecastFrameActive: true,
      esriTilesFailed: false,
    })).toEqual({
      'carto-dark-layer': 'visible',
      'esri-imagery-layer': 'none',
      'gibs-clouds-layer': 'none',
      'fcst-clouds-layer': 'none',
    });
  });

  it('never shows Carto and Esri at the same time, for any input', () => {
    for (const cloudsVisible of [true, false]) {
      for (const irVisible of [true, false]) {
        for (const forecastFrameActive of [true, false]) {
          for (const esriTilesFailed of [true, false]) {
            const vis = basemapVisibility({
              cloudsVisible, irVisible, forecastFrameActive, esriTilesFailed,
            });
            const basemaps = [vis['carto-dark-layer'], vis['esri-imagery-layer']];
            expect(basemaps.filter((v) => v === 'visible')).toHaveLength(1);
            const clouds = [vis['gibs-clouds-layer'], vis['fcst-clouds-layer']];
            expect(clouds.filter((v) => v === 'visible').length).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});
