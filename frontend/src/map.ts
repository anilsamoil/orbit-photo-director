/** Map view (lazy-loaded). MapLibre GL JS rendering of ISS dot, ground track, targets, cloud overlay. */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { Manifest, PassEntry, Track } from './types';
import { fetchArtifact } from './manifest';
import { liveIssPosition } from './iss';

let map: maplibregl.Map | null = null;
let issMarker: maplibregl.Marker | null = null;
let liveTimer: number | null = null;

const STYLE_URL =
  'https://demotiles.maplibre.org/style.json'; // free public demo style; swap in custom tile source pre-launch

export async function renderMap(manifest: Manifest): Promise<void> {
  const container = document.getElementById('map');
  if (!container) return;

  const passes = await fetchArtifact<PassEntry[]>(manifest, 'passes');
  const track = await fetchArtifact<Track>(manifest, 'track');

  if (!map) {
    map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: [0, 0],
      zoom: 1.5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-left');
    await new Promise<void>((resolve) => {
      map!.once('load', () => resolve());
    });
  }

  // Targets layer
  const targetFeatures = passes.map((p) => ({
    type: 'Feature' as const,
    properties: {
      target_id: p.target_id,
      target_name: p.target_name,
      score: p.score,
    },
    geometry: { type: 'Point' as const, coordinates: [p.target_lon, p.target_lat] },
  }));
  upsertGeoJson(map, 'targets', { type: 'FeatureCollection', features: targetFeatures });
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
  }

  // ISS dot — initialized at first polynomial sample
  if (!issMarker) {
    const initial = liveIssPosition(track, Date.now()) ?? { lat: 0, lon: 0 };
    issMarker = new maplibregl.Marker({ color: '#5cd0ff' })
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
  data: GeoJSON.FeatureCollection
): void {
  const existing = m.getSource(id);
  if (existing && 'setData' in existing) {
    (existing as maplibregl.GeoJSONSource).setData(data);
  } else {
    m.addSource(id, { type: 'geojson', data });
  }
}
