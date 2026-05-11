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
let currentTrack: Track | null = null;
// 0 = "Now" (live position); 90 = "+90 min" (preview future ISS position).
let lookaheadMinutes = 0;

/** Bearing mode for the map. 'north' = standard north-up. 'iss-up' = rotate
 *  the map so the ISS direction-of-travel points up — matches Chris's
 *  mental model in WORF: "I'm looking down, this is what's coming next."
 *  Persisted to localStorage so the operator's preference survives reload. */
type BearingMode = 'north' | 'iss-up';
const BEARING_PREF_KEY = 'opd-map-bearing-mode';
function readBearingMode(): BearingMode {
  try {
    const v = localStorage.getItem(BEARING_PREF_KEY);
    return v === 'iss-up' ? 'iss-up' : 'north';
  } catch {
    return 'north';  // localStorage unavailable (private mode, etc.)
  }
}
let bearingMode: BearingMode = readBearingMode();

/** Test-only: reset module-level state between vitest runs. */
export function _resetMapStateForTest(): void {
  bearingMode = 'north';
  try { localStorage.removeItem(BEARING_PREF_KEY); } catch { /* noop */ }
}

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

/** Render the ground track polyline. Prefers `track_points` (raw SGP4
 *  samples covering 2 orbits, no fit drift) when present. Falls back to
 *  evaluating the polynomial across its full duration for older manifests
 *  that don't ship `track_points` yet.
 *
 *  Splits at antimeridian crossings so the line doesn't drag across the
 *  whole map.
 */
function groundTrackFeatures(track: Track): GeoJSON.Feature[] {
  type Pt = [number, number];

  // Source 1: explicit SGP4 samples. Each entry: [t_sec, lat, lon].
  // Always preferred when available — drift-free over 2 orbits.
  const samples: [number, number][] = (() => {
    if (track.track_points && track.track_points.length > 0) {
      return track.track_points.map(([, lat, lon]) => [lat, lon] as [number, number]);
    }
    // Source 2 (fallback): polynomial-derived samples over the polynomial's
    // own window. Used only when the manifest predates track_points.
    const dur = track.iss_polynomial.duration_seconds;
    const stepSec = 30;
    const evalPoly = (coeffs: number[], t: number): number => {
      let acc = 0;
      for (const c of coeffs) acc = acc * t + c;
      return acc;
    };
    const out: [number, number][] = [];
    for (let t = 0; t <= dur; t += stepSec) {
      const lat = evalPoly(track.iss_polynomial.lat_coeffs, t);
      const lon = evalPoly(track.iss_polynomial.lon_coeffs, t);
      out.push([lat, lon]);
    }
    return out;
  })();

  const segments: Pt[][] = [];
  let current: Pt[] = [];
  let prevLon: number | null = null;

  for (const [lat, lonRaw] of samples) {
    const lon = wrapLon(lonRaw);
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
  currentTrack = track;

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

  // Imagery-date badge: tells the user how recent the cloud composite the
  // map's tiles are showing actually is. Especially load-bearing offline —
  // GIBS tiles cached past day-roll could otherwise read as today's clouds.
  ensureImageryDateBadge(container, manifest);

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
    // Click handler: popup with target name + score. Uses setDOMContent +
    // textContent (NOT setHTML) so target names with HTML-meta characters
    // can't render as markup. personal-targets.csv is user-controlled, so
    // a name like "<img onerror=...>" must not become a script-injection
    // surface inside the popup.
    map.on('click', 'targets-layer', (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      const props = f.properties as { target_name?: string; score?: number };
      const coords = (f.geometry.coordinates as [number, number]).slice() as [number, number];
      const popupBody = document.createElement('div');
      popupBody.style.cssText = 'font:0.85rem/1.4 system-ui;color:#0b0d12';
      const name = document.createElement('strong');
      name.textContent = props.target_name ?? 'unknown';
      const score = document.createElement('div');
      score.textContent = `score ${Math.round(props.score ?? 0)}`;
      popupBody.append(name, score);
      new maplibregl.Popup()
        .setLngLat(coords)
        .setDOMContent(popupBody)
        .addTo(map!);
    });
    map.on('mouseenter', 'targets-layer', () => {
      if (map) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'targets-layer', () => {
      if (map) map.getCanvas().style.cursor = '';
    });
  }

  // ISS marker: ISS-silhouette icon + pulsing halo. Replaces the prior
  // cyan dot which blended into the cloud overlay at world-zoom and was
  // hard to spot.
  if (!issMarker) {
    const initial = markerPositionFor(track) ?? { lat: 0, lon: 0 };
    const el = createIssMarkerElement();
    issMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([initial.lon, initial.lat])
      .addTo(map);
  }

  // Live ISS position update (every 1s while map is open).
  // In "+90 min" mode the marker is anchored to the future projection and
  // updates only when the user toggles or new track data arrives.
  if (liveTimer !== null) {
    clearInterval(liveTimer);
  }
  liveTimer = window.setInterval(() => {
    if (!map || !issMarker || !currentTrack) return;
    const pos = markerPositionFor(currentTrack);
    if (pos) issMarker.setLngLat([pos.lon, pos.lat]);
    // Re-apply bearing each tick when ISS-up is on. ISS heading drifts ~1°
    // per minute so 1Hz is overkill but harmless; the alternative (only
    // update on toggle) leaves the map mis-oriented after a few minutes.
    // setBearing (no animate) — micro-rotations every 1s would jitter.
    if (bearingMode === 'iss-up') applyBearing(false);
  }, 1000);

  bindTimeToggle();
  bindBearingToggle();
  // Apply persisted bearing preference on first map render. Animate so the
  // user sees the rotation kick in (helps establish the visual model that
  // it's intentional, not a glitch).
  applyBearing(true);
}

/** Return the position the ISS marker should occupy given the current
 *  lookahead toggle. Returns null if the polynomial doesn't cover the
 *  requested time (clamps to end-of-window).
 */
function markerPositionFor(track: Track): { lat: number; lon: number } | null {
  const targetMs = Date.now() + lookaheadMinutes * 60_000;
  const pos = liveIssPosition(track, targetMs);
  if (pos) return pos;
  // Fallback: clamp to last point in the polynomial window
  const startMs = Date.parse(track.iss_polynomial.start);
  if (Number.isNaN(startMs)) return null;
  const endMs = startMs + track.iss_polynomial.duration_seconds * 1000;
  return liveIssPosition(track, Math.min(targetMs, endMs - 1000));
}

/** Great-circle initial bearing from (lat1, lon1) to (lat2, lon2), in degrees
 *  clockwise from true north (0..360). Standard formula; ISS travels along
 *  great circles so this is the correct way to read direction-of-travel
 *  vs flat-Earth atan2(Δlat, Δlon). At ISS speed (~7.7 km/s, 30s spacing)
 *  the great-circle vs rhumb-line difference is negligible, but using the
 *  right formula means antimeridian + polar passes don't blow up.
 */
export function greatCircleBearingDeg(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Compute the ISS heading (degrees clockwise from north) by sampling the
 *  polynomial fit at `nowMs` and `nowMs + 30s`. Returns null if either
 *  sample is outside the polynomial window or the sample positions are
 *  identical (degenerate case). */
function computeIssHeading(track: Track, nowMs: number): number | null {
  const here = liveIssPosition(track, nowMs);
  const ahead = liveIssPosition(track, nowMs + 30_000);
  if (!here || !ahead) return null;
  if (here.lat === ahead.lat && here.lon === ahead.lon) return null;
  return greatCircleBearingDeg(here.lat, here.lon, ahead.lat, ahead.lon);
}

/** Apply the current bearing mode to the map. ISS-up sets bearing to the
 *  current heading so direction-of-travel points up; north resets to 0.
 *  Smooth animation via easeTo; no-op if heading can't be computed. */
function applyBearing(animate: boolean): void {
  if (!map) return;
  if (bearingMode === 'north') {
    if (animate) map.easeTo({ bearing: 0, duration: 600 });
    else map.setBearing(0);
    return;
  }
  if (!currentTrack) return;
  const heading = computeIssHeading(currentTrack, Date.now() + lookaheadMinutes * 60_000);
  if (heading === null) return;
  if (animate) map.easeTo({ bearing: heading, duration: 600 });
  else map.setBearing(heading);
}

let toggleBound = false;
function bindTimeToggle(): void {
  if (toggleBound) return;
  const nowBtn = document.getElementById('time-now');
  const plus90Btn = document.getElementById('time-plus90');
  if (!nowBtn || !plus90Btn) return;

  const setMode = (minutes: 0 | 90) => {
    lookaheadMinutes = minutes;
    nowBtn.classList.toggle('active', minutes === 0);
    plus90Btn.classList.toggle('active', minutes === 90);
    if (map && issMarker && currentTrack) {
      const pos = markerPositionFor(currentTrack);
      if (pos) {
        issMarker.setLngLat([pos.lon, pos.lat]);
        // On +90, recenter so the user can see where ISS will be
        if (minutes === 90) {
          map.easeTo({ center: [pos.lon, pos.lat], duration: 600 });
        }
      }
    }
  };

  nowBtn.addEventListener('click', () => setMode(0));
  plus90Btn.addEventListener('click', () => setMode(90));
  toggleBound = true;
}

let bearingToggleBound = false;
function bindBearingToggle(): void {
  if (bearingToggleBound) return;
  const northBtn = document.getElementById('bearing-north');
  const issBtn = document.getElementById('bearing-iss');
  if (!northBtn || !issBtn) return;

  // Restore the persisted pref to the button's active state on first bind.
  const reflectActive = () => {
    northBtn.classList.toggle('active', bearingMode === 'north');
    issBtn.classList.toggle('active', bearingMode === 'iss-up');
  };
  reflectActive();

  const setBearingMode = (mode: BearingMode) => {
    if (mode === bearingMode) return;
    bearingMode = mode;
    try { localStorage.setItem(BEARING_PREF_KEY, mode); } catch { /* noop */ }
    reflectActive();
    applyBearing(true);  // animate the rotation on user toggle
  };

  northBtn.addEventListener('click', () => setBearingMode('north'));
  issBtn.addEventListener('click', () => setBearingMode('iss-up'));
  bearingToggleBound = true;
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

/** Build the ISS marker DOM: a stylized ISS silhouette (central truss + two
 *  long solar arrays) with a pulsing halo behind it. The whole thing is
 *  ~40 × 16 px so the truss center sits exactly on the lat/lon point.
 *
 *  Exported for unit tests.
 */
export function createIssMarkerElement(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'iss-marker';
  // Pulse halo (CSS-driven). Sits behind the SVG, centered on the truss.
  const pulse = document.createElement('span');
  pulse.className = 'iss-pulse';
  wrap.appendChild(pulse);

  // SVG silhouette. viewBox -20..20 horizontally, -8..8 vertically so the
  // truss sits at (0,0). The marker's CSS width sizes the whole thing.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '-20 -8 40 16');
  svg.setAttribute('aria-label', 'ISS live position');
  svg.setAttribute('role', 'img');

  // Solar arrays (left + right). Cyan with dark stroke; small interior
  // grid lines for the photovoltaic-cell look.
  const panel = (x: number) => {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', String(x));
    r.setAttribute('y', '-3');
    r.setAttribute('width', '14');
    r.setAttribute('height', '6');
    r.setAttribute('fill', '#5cd0ff');
    r.setAttribute('stroke', '#0b0d12');
    r.setAttribute('stroke-width', '0.7');
    svg.appendChild(r);
    // Grid divisions inside the panel
    for (const dx of [4, 8, 12]) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(x + dx));
      line.setAttribute('y1', '-3');
      line.setAttribute('x2', String(x + dx));
      line.setAttribute('y2', '3');
      line.setAttribute('stroke', '#0b0d12');
      line.setAttribute('stroke-width', '0.4');
      svg.appendChild(line);
    }
  };
  panel(-18); // port array
  panel(4);   // starboard array

  // Central truss + modules (white core for max contrast on cloudy basemap)
  const truss = document.createElementNS(SVG_NS, 'rect');
  truss.setAttribute('x', '-3');
  truss.setAttribute('y', '-2');
  truss.setAttribute('width', '6');
  truss.setAttribute('height', '4');
  truss.setAttribute('fill', '#ffffff');
  truss.setAttribute('stroke', '#0b0d12');
  truss.setAttribute('stroke-width', '0.7');
  svg.appendChild(truss);

  wrap.appendChild(svg);
  return wrap;
}

/** Inject (or update) a small "Imagery: YYYY-MM-DD" badge in the map
 *  container so the user knows how recent the cloud composite they're
 *  looking at actually is. Important offline — a GIBS tile cached past
 *  day-roll otherwise reads as today's clouds. Idempotent.
 */
export function ensureImageryDateBadge(container: HTMLElement, manifest: Manifest): void {
  let badge = container.querySelector<HTMLElement>('.map-imagery-date');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'map-imagery-date';
    container.appendChild(badge);
  }
  const hour = manifest.cloud_composite_hour;
  if (!hour) {
    badge.hidden = true;
    badge.textContent = '';
    return;
  }
  const t = Date.parse(hour);
  if (Number.isNaN(t)) {
    badge.hidden = true;
    return;
  }
  const date = new Date(t).toISOString().slice(0, 10);
  badge.textContent = `Imagery: ${date}`;
  badge.hidden = false;
}
