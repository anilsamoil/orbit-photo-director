/** Map view: dark basemap + GIBS true-color cloud overlay + ground track + targets + live ISS dot.
 *
 *  Layer stack (bottom → top):
 *    1. Carto dark basemap (continents, ocean, country outlines)
 *    2. GIBS true-color daily imagery — visible clouds baked into the satellite image
 *    3. ISS ground track polyline (polynomial-fit, ~1h ahead)
 *    4. Target points (colored by score)
 *    5. Live ISS marker (updates every 1s from polynomial)
 *
 *  Lazy-loaded: heavy MapLibre import only fires when the user toggles to map view.
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { Manifest, PassEntry, Track } from './types';
import { fetchArtifact } from './manifest';
import { liveIssPosition, wrapLon } from './iss';

let map: maplibregl.Map | null = null;
let issMarker: maplibregl.Marker | null = null;
let liveTimer: number | null = null;

/** GIBS true-color tile URL pattern. {date} is replaced per render. Daily layer
 *  — captures cloud cover visually (you can SEE clouds, not derive them).
 */
function gibsTrueColorUrl(dateIso: string): string {
  const layer = 'VIIRS_NOAA21_CorrectedReflectance_TrueColor';
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${dateIso}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
}

/** Yesterday's date in YYYY-MM-DD; today's product may not be published yet. */
function yesterdayIso(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function buildStyle(): maplibregl.StyleSpecification {
  const dateIso = yesterdayIso();
  return {
    version: 8,
    sources: {
      'carto-dark': {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
          'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
          'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
          'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        ],
        tileSize: 256,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      },
      'gibs-clouds': {
        type: 'raster',
        tiles: [gibsTrueColorUrl(dateIso)],
        tileSize: 256,
        attribution:
          'Imagery from <a href="https://earthdata.nasa.gov">NASA GIBS</a>',
      },
    },
    layers: [
      {
        id: 'carto-dark-layer',
        type: 'raster',
        source: 'carto-dark',
        paint: { 'raster-opacity': 1.0 },
      },
      {
        id: 'gibs-clouds-layer',
        type: 'raster',
        source: 'gibs-clouds',
        paint: { 'raster-opacity': 0.55 }, // semi-transparent so basemap shows through
      },
    ],
  };
}

/** Render the ground track polyline from the iss_polynomial.
 *  Samples every 30s for the polynomial's full duration. Splits at antimeridian
 *  crossings so the line doesn't drag across the whole map.
 */
function groundTrackFeatures(track: Track): GeoJSON.Feature[] {
  const startMs = Date.parse(track.iss_polynomial.start);
  if (Number.isNaN(startMs)) return [];
  const dur = track.iss_polynomial.duration_seconds;
  const stepSec = 30;

  // Evaluate polynomial at each sample
  const evalPoly = (coeffs: number[], t: number): number => {
    let acc = 0;
    for (const c of coeffs) acc = acc * t + c;
    return acc;
  };

  type Pt = [number, number];
  const segments: Pt[][] = [];
  let current: Pt[] = [];
  let prevLon: number | null = null;

  for (let t = 0; t <= dur; t += stepSec) {
    const lat = evalPoly(track.iss_polynomial.lat_coeffs, t);
    const lon = wrapLon(evalPoly(track.iss_polynomial.lon_coeffs, t));
    // Detect antimeridian crossing: previous lon and current lon differ by > 180°
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push([lon, lat]);
    prevLon = lon;
  }
  if (current.length > 1) segments.push(current);

  return segments.map((coords) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coords },
  }));
}

export async function renderMap(manifest: Manifest): Promise<void> {
  const container = document.getElementById('map');
  if (!container) return;

  const passes = await fetchArtifact<PassEntry[]>(manifest, 'passes');
  const track = await fetchArtifact<Track>(manifest, 'track');

  if (!map) {
    map = new maplibregl.Map({
      container,
      style: buildStyle(),
      center: [0, 0],
      zoom: 1.5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-left');
    await new Promise<void>((resolve) => {
      map!.once('load', () => resolve());
    });
  }

  // Ground track layer
  const trackFc: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: groundTrackFeatures(track),
  };
  upsertGeoJson(map, 'iss-track', trackFc);
  if (!map.getLayer('iss-track-layer')) {
    map.addLayer({
      id: 'iss-track-layer',
      type: 'line',
      source: 'iss-track',
      paint: {
        'line-color': '#5cd0ff',
        'line-width': 2,
        'line-opacity': 0.85,
        'line-dasharray': [2, 1],
      },
    });
  }

  // Targets layer
  const targetFc: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: passes.map((p) => ({
      type: 'Feature' as const,
      properties: {
        target_id: p.target_id,
        target_name: p.target_name,
        score: p.score,
      },
      geometry: { type: 'Point' as const, coordinates: [p.target_lon, p.target_lat] },
    })),
  };
  upsertGeoJson(map, 'targets', targetFc);
  if (!map.getLayer('targets-layer')) {
    map.addLayer({
      id: 'targets-layer',
      type: 'circle',
      source: 'targets',
      paint: {
        'circle-radius': 6,
        'circle-color': [
          'interpolate',
          ['linear'],
          ['get', 'score'],
          0, '#ff6464',
          30, '#ffce4d',
          60, '#5be37a',
        ],
        'circle-stroke-color': '#0b0d12',
        'circle-stroke-width': 1.5,
      },
    });
    // Click handler: popup with target name + score
    map.on('click', 'targets-layer', (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      const props = f.properties as { target_name?: string; score?: number };
      const coords = (f.geometry.coordinates as [number, number]).slice() as [number, number];
      new maplibregl.Popup()
        .setLngLat(coords)
        .setHTML(
          `<div style="font:0.85rem/1.4 system-ui;color:#0b0d12">
            <strong>${props.target_name ?? 'unknown'}</strong><br/>
            score ${Math.round(props.score ?? 0)}
          </div>`,
        )
        .addTo(map!);
    });
    map.on('mouseenter', 'targets-layer', () => {
      if (map) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'targets-layer', () => {
      if (map) map.getCanvas().style.cursor = '';
    });
  }

  // ISS dot
  if (!issMarker) {
    const initial = liveIssPosition(track, Date.now()) ?? { lat: 0, lon: 0 };
    const el = document.createElement('div');
    el.style.cssText =
      'width:14px;height:14px;border-radius:50%;background:#5cd0ff;' +
      'box-shadow:0 0 8px #5cd0ff,0 0 16px rgba(92,208,255,0.5);border:2px solid #0b0d12';
    issMarker = new maplibregl.Marker({ element: el })
      .setLngLat([initial.lon, initial.lat])
      .addTo(map);
  }

  // Live ISS position update (every 1s while map is open)
  if (liveTimer !== null) {
    clearInterval(liveTimer);
  }
  liveTimer = window.setInterval(() => {
    if (!map || !issMarker) return;
    const pos = liveIssPosition(track, Date.now());
    if (pos) {
      issMarker.setLngLat([pos.lon, pos.lat]);
    }
  }, 1000);
}

function upsertGeoJson(
  m: maplibregl.Map,
  id: string,
  data: GeoJSON.FeatureCollection,
): void {
  const existing = m.getSource(id);
  if (existing && 'setData' in existing) {
    (existing as maplibregl.GeoJSONSource).setData(data);
  } else {
    m.addSource(id, { type: 'geojson', data });
  }
}

/** Force the map to recompute its canvas size. Call after the container becomes
 *  visible (e.g., after the user clicks the Map tab). MapLibre samples the
 *  container size at init; if it was display:none, the canvas is stuck at 0×0
 *  until a resize event fires.
 */
export function resizeMap(): void {
  if (map) map.resize();
}
