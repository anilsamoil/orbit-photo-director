import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openHelpModal } from '../src/help';
import {
  MANIFEST_FIXTURE,
  TRACK_FIXTURE,
  buildMapDock,
  renderedMap,
  resetMaplibreDouble,
  stubArtifactFetch,
} from './maplibre-double';

vi.mock('maplibre-gl', async () => (await import('./maplibre-double')).maplibreModuleMock());

// Feature C, the live geostationary-IR overlay. Every test renders the map
// through the recording double and observes the geo-ir source, the
// geo-ir-layer, the dock buttons and the imagery badge. The design-review
// items each pin holds (R3/R5/R7/R9, Codex #1-#3) are named per test. R1,
// the IR exclusion inside the basemap arbiter, is pinned on the pure
// basemapVisibility in map-basemap.test.ts; this file pins the toggle wiring
// that feeds it.
let mapModule: typeof import('../src/map');

// The clock is 12:10Z, so the newest published frame is 11:40Z (30 min
// publish backoff, floored to the 10-min grid) and rolls to 11:50Z at 12:20Z.
const GOES_EAST_1140 = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/2026-05-04T11:40:00Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png';
const GOES_EAST_1150 = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/2026-05-04T11:50:00Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png';
const HIMAWARI_1140 = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/2026-05-04T11:40:00Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png';
const METEOSAT_LATEST_1140 = 'https://realearth.ssec.wisc.edu/api/image?products=Met11-SEVIRI-FD-BAND09-enh&x={x}&y={y}&z={z}&_v=2026-05-04T11%3A40%3A00Z';

const DAILY_BADGE = 'Imagery: 2026-05-04 · ~70m old';

function click(id: string): void {
  document.getElementById(id)!.dispatchEvent(new Event('click'));
}

function pressed(id: string): string | null {
  return document.getElementById(id)!.getAttribute('aria-pressed');
}

function badge(): string {
  return document.querySelector('#map .map-imagery-date')?.textContent ?? '';
}

function irTiles(): string[][] {
  return renderedMap().tilesSetOn('geo-ir');
}

function panTo(lng: number, lat: number): void {
  renderedMap().center = { lng, lat };
  renderedMap().fire('moveend');
}

/** map.ts reads the IR pref at import, so a persisted session needs a fresh
 *  module graph loaded after the pref is stored. */
async function importWithStoredPrefs(prefs: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(prefs)) localStorage.setItem(key, value);
  vi.resetModules();
  resetMaplibreDouble();
  mapModule = await import('../src/map');
}

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

describe('Feature C, live IR overlay', () => {
  it('ships the IR layer hidden and never re-points the geo-ir source until the button is pressed (R5)', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const map = renderedMap();
    expect(map.getLayer('geo-ir-layer')?.layout).toEqual({ visibility: 'none' });
    expect(map.visibilityOf('geo-ir-layer')).toBe('none');
    expect(irTiles()).toEqual([]);
    click('toggle-ir');
    expect(map.visibilityOf('geo-ir-layer')).toBe('visible');
    expect(irTiles()).toEqual([[METEOSAT_LATEST_1140]]);
  });

  it('opens with IR on only when opd-map-ir-visible is exactly "1"', async () => {
    await importWithStoredPrefs({ 'opd-map-ir-visible': 'true' });
    await mapModule.renderMap(MANIFEST_FIXTURE);
    expect(renderedMap().visibilityOf('geo-ir-layer')).toBe('none');
    expect(pressed('toggle-ir')).toBe('false');
    expect(mapModule.readIrVisible()).toBe(false);

    await importWithStoredPrefs({ 'opd-map-ir-visible': '1' });
    await mapModule.renderMap(MANIFEST_FIXTURE);
    expect(renderedMap().visibilityOf('geo-ir-layer')).toBe('visible');
    expect(pressed('toggle-ir')).toBe('true');
    expect(mapModule.readIrVisible()).toBe(true);
  });

  it('turning IR on turns the daily clouds off, and turning clouds on turns IR off', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    const map = renderedMap();
    const state = () => ({
      ir: pressed('toggle-ir'),
      clouds: pressed('toggle-clouds'),
      irPref: localStorage.getItem('opd-map-ir-visible'),
      cloudsPref: localStorage.getItem('opd-map-clouds-visible'),
      'geo-ir-layer': map.visibilityOf('geo-ir-layer'),
      'gibs-clouds-layer': map.visibilityOf('gibs-clouds-layer'),
      'esri-imagery-layer': map.visibilityOf('esri-imagery-layer'),
      'carto-dark-layer': map.visibilityOf('carto-dark-layer'),
    });
    expect(state()).toEqual({
      ir: 'false',
      clouds: 'true',
      irPref: null,
      cloudsPref: null,
      'geo-ir-layer': 'none',
      'gibs-clouds-layer': 'visible',
      'esri-imagery-layer': 'none',
      'carto-dark-layer': 'visible',
    });
    click('toggle-ir');
    expect(state()).toEqual({
      ir: 'true',
      clouds: 'false',
      irPref: '1',
      cloudsPref: '0',
      'geo-ir-layer': 'visible',
      'gibs-clouds-layer': 'none',
      'esri-imagery-layer': 'none',
      'carto-dark-layer': 'visible',
    });
    click('toggle-clouds');
    expect(state()).toEqual({
      ir: 'false',
      clouds: 'true',
      irPref: '0',
      cloudsPref: '1',
      'geo-ir-layer': 'none',
      'gibs-clouds-layer': 'visible',
      'esri-imagery-layer': 'none',
      'carto-dark-layer': 'visible',
    });
  });

  it('panning with IR off fetches nothing; panning with IR on re-points the source at the covering satellite (R5)', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    panTo(-75, 0);
    expect(irTiles()).toEqual([]);
    expect(badge()).toBe(DAILY_BADGE);
    click('toggle-ir');
    expect(irTiles()).toEqual([[GOES_EAST_1140]]);
    panTo(140, 0);
    expect(irTiles()).toEqual([[GOES_EAST_1140], [HIMAWARI_1140]]);
    expect(badge()).toBe('IR · Himawari · ~30m old · misses low cloud');
  });

  it('hides the raster in a no-coverage gap and says so in the badge, instead of blank or stale tiles (R7)', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    click('toggle-ir');
    expect(renderedMap().visibilityOf('geo-ir-layer')).toBe('visible');
    panTo(0, 80);
    expect(renderedMap().visibilityOf('geo-ir-layer')).toBe('none');
    expect(pressed('toggle-ir')).toBe('true');
    expect(badge()).toBe('IR: no geostationary coverage here');
    expect(irTiles()).toEqual([[METEOSAT_LATEST_1140]]);
    panTo(-75, 0);
    expect(renderedMap().visibilityOf('geo-ir-layer')).toBe('visible');
    expect(irTiles()).toEqual([[METEOSAT_LATEST_1140], [GOES_EAST_1140]]);
  });

  it('badges a GIBS satellite with its frame age and the low-cloud caveat (R3/R9, Codex #1)', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    renderedMap().center = { lng: -75, lat: 0 };
    click('toggle-ir');
    expect(badge()).toBe('IR · GOES-East · ~30m old · misses low cloud');
  });

  it('serves Meteosat from RealEarth and badges it "latest", not a false age', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    click('toggle-ir');
    expect(irTiles()).toEqual([[METEOSAT_LATEST_1140]]);
    expect(badge()).toBe('IR · Meteosat-11 · latest · misses low cloud');
  });

  it('badges LIVE now under a scrubbed view, never as a forecast for the scrubbed time (Codex #2)', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    click('toggle-ir');
    mapModule.setLookahead(360, false);
    expect(badge()).toBe('IR · Meteosat-11 · LIVE now (not the scrubbed time) · misses low cloud');
    mapModule.setLookahead(0, false);
    expect(badge()).toBe('IR · Meteosat-11 · latest · misses low cloud');
  });

  it('a persisted IR-on session badges the covering satellite on first paint, not a false no-coverage flash (Codex #3)', async () => {
    await importWithStoredPrefs({ 'opd-map-ir-visible': '1' });
    await mapModule.renderMap(MANIFEST_FIXTURE);
    expect(badge()).toBe('IR · Meteosat-11 · latest · misses low cloud');
    expect(renderedMap().visibilityOf('geo-ir-layer')).toBe('visible');
    expect(irTiles()).toEqual([[METEOSAT_LATEST_1140]]);
  });

  it('advances the frame on the 10-min rollover from the ticker, with no pan (Codex #1)', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    renderedMap().center = { lng: -75, lat: 0 };
    click('toggle-ir');
    expect(irTiles()).toEqual([[GOES_EAST_1140]]);
    vi.advanceTimersByTime(8 * 60_000);
    expect(irTiles()).toEqual([[GOES_EAST_1140]]);
    expect(badge()).toBe('IR · GOES-East · ~38m old · misses low cloud');
    vi.advanceTimersByTime(2 * 60_000);
    expect(irTiles()).toEqual([[GOES_EAST_1140], [GOES_EAST_1150]]);
    expect(badge()).toBe('IR · GOES-East · ~30m old · misses low cloud');
  });

  it('reports "feed unavailable" when the map idles with IR on and nothing loaded, and clears it on the first loaded tile (Codex)', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    renderedMap().fire('idle');
    expect(badge()).toBe(DAILY_BADGE);
    click('toggle-ir');
    renderedMap().fire('idle');
    expect(badge()).toBe('IR · Meteosat-11 · feed unavailable');
    renderedMap().fire('data', { sourceId: 'geo-ir', tile: { state: 'loaded' } });
    expect(badge()).toBe('IR · Meteosat-11 · latest · misses low cloud');
    renderedMap().fire('idle');
    expect(badge()).toBe('IR · Meteosat-11 · latest · misses low cloud');
  });

  it('the dock button is shipped inactive in index.html and reflects the IR state once bound', async () => {
    // A template fragment stays inert, so the document's scripts and
    // stylesheets are parsed but never fetched.
    const shippedDocument = document.createElement('template');
    shippedDocument.innerHTML = await readFile(resolve(__dirname, '../index.html'), 'utf-8');
    const shipped = shippedDocument.content.querySelector('#toggle-ir');
    expect(shipped?.tagName).toBe('BUTTON');
    expect(shipped?.classList.contains('active')).toBe(false);

    await mapModule.renderMap(MANIFEST_FIXTURE);
    const button = document.getElementById('toggle-ir')!;
    expect([pressed('toggle-ir'), button.classList.contains('active')]).toEqual(['false', false]);
    click('toggle-ir');
    expect([pressed('toggle-ir'), button.classList.contains('active')]).toEqual(['true', true]);
  });

  it('help and attribution name Meteosat, with no stale GOES/Himawari-only claim', async () => {
    await mapModule.renderMap(MANIFEST_FIXTURE);
    expect(renderedMap().sources.get('geo-ir')?.spec.attribution).toBe(
      'Live IR: <a href="https://earthdata.nasa.gov">NASA GIBS</a> (GOES/Himawari) + <a href="https://realearth.ssec.wisc.edu">SSEC RealEarth</a> (Meteosat)',
    );
    openHelpModal();
    const help = document.querySelector('.help-body')?.textContent ?? '';
    expect(help).toContain('GOES / Himawari / Meteosat');
    expect(help).not.toContain('blank over Europe/Africa');
  });
});
