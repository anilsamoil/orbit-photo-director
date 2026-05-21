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
import { issPositionWithAltSGP4 } from './iss-sgp4';
import { subsolarFeature, terminatorFeatures } from './terminator';

let map: maplibregl.Map | null = null;
let issMarker: maplibregl.Marker | null = null;
let liveTimer: number | null = null;
// Refreshes the UTC time chips on the time-step buttons every 30s so
// labels stay accurate as the wall clock advances.
let timeLabelTimer: number | null = null;
let currentTrack: Track | null = null;
// Cached most-recently-fetched passes list — kept so when the operator
// hits a time-scrub button we can re-derive the target-pin opacity (and
// future-orbit ground track) without re-fetching the manifest.
let currentPasses: PassEntry[] = [];
// Orbit time-scrub: 0 = "Now" (live ISS marker + current 2-orbit track).
// Positive values move forward by 45- or 90-minute steps; the map then
// shows ONLY the orbit centered at +N min and freezes the ISS marker
// at the start of that orbit (per Q2 → A in the 2026-05-20 decision).
// Capped at 36h = 2160 min via clampLookahead() — matches the upcoming
// passes.json horizon so we don't scrub into orbits with no target data.
// Cannot go negative (Q3 — "back" is relative-to-current; floor at 0).
let lookaheadMinutes = 0;

const LOOKAHEAD_MAX_MINUTES = 36 * 60;  // 2160; matches passes.json horizon

function clampLookahead(m: number): number {
  if (!Number.isFinite(m) || m < 0) return 0;
  if (m > LOOKAHEAD_MAX_MINUTES) return LOOKAHEAD_MAX_MINUTES;
  return Math.round(m);
}

/** UTC ISO 8601 time portion at minute precision, e.g., "12:34Z". */
function formatUtcHm(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/** "Pass window" half-width: a pass with closest_approach within ±45 min
 *  of the current view time is considered in-orbit and rendered full
 *  opacity. Outside that window the pin dims to 0.3 alpha (Q3 → C). */
const PASS_WINDOW_HALF_MINUTES = 45;

/** Day-night terminator visibility preference. Same pattern as the cloud
 *  toggle (v1.2.9.0) — persisted to localStorage. Default ON because
 *  Pettit explicitly asked for day-night shading; it complements the
 *  time-scrub naturally (without it, operator can't tell day-side from
 *  night-side at +6h scrubbed views). */
const TERMINATOR_PREF_KEY = 'opd-map-terminator-visible';
function readTerminatorVisible(): boolean {
  try {
    const v = localStorage.getItem(TERMINATOR_PREF_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}
let terminatorVisible: boolean = readTerminatorVisible();

/** Multi-orbit display preference (v1.5.0.0 — Pettit feedback 2026-05-19:
 *  "multi-orbit display"). When ON, the ground-track polyline splits
 *  track_points into 4 per-orbit segments and renders each with
 *  progressively reduced opacity (current orbit solid, +1/+2/+3 fading
 *  out) so the operator sees the full ~6h forward envelope, not just
 *  the next 95-min orbit. Default OFF — explicit opt-in so existing
 *  users keep the familiar single-orbit look until they reach for the
 *  toggle. */
const MULTI_ORBIT_PREF_KEY = 'opd-map-multi-orbit-visible';
function readMultiOrbitVisible(): boolean {
  try {
    const v = localStorage.getItem(MULTI_ORBIT_PREF_KEY);
    return v === '1';
  } catch {
    return false;
  }
}
let multiOrbitVisible: boolean = readMultiOrbitVisible();

/** ISS orbital period in seconds. Used to split track_points into
 *  per-orbit segments. 92.8 min ≈ 5568s; SGP4 mean motion varies
 *  ±0.1% over the mission so a fixed constant is fine for visual
 *  segmentation (the segments don't need to be exactly orbit-aligned,
 *  just visually distinguishable). */
const ISS_ORBIT_PERIOD_SECONDS = 5568;

/** Cloud overlay visibility preference. Persisted to localStorage so Pettit's
 *  "make so can turn off/on as needed" stays sticky across reloads. Default
 *  on (clouds visible) matches v1.0+ behavior. */
const CLOUDS_PREF_KEY = 'opd-map-clouds-visible';
function readCloudsVisible(): boolean {
  try {
    const v = localStorage.getItem(CLOUDS_PREF_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}
let cloudsVisible: boolean = readCloudsVisible();

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
// gibsTrueColorUrl + yesterdayIso live in tile-precache.ts so main.ts can
// import them without pulling the heavy MapLibre bundle. Re-exported from
// here so this module's existing internal callers (buildStyle below) don't
// have to change.
import { GIBS_MAX_ZOOM, gibsTrueColorUrl, yesterdayIso } from './tile-precache';

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
        // Carto dark_all serves up to z20 for retina (@2x). Without an
        // explicit maxzoom MapLibre tries to fetch tiles at every requested
        // zoom — z21+ returns 404 → blank squares. Setting maxzoom=20
        // tells MapLibre to overzoom the z20 tile beyond that (slightly
        // pixelated, but always shows terrain rather than blanks). Chris
        // (operator, 2026-05-05) asked for more zoom for terrain detail
        // (mountains / coastline / man-made features as WORF reference).
        maxzoom: 20,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      },
      'gibs-clouds': {
        type: 'raster',
        tiles: [gibsTrueColorUrl(dateIso)],
        tileSize: 256,
        // GIBS true-color VIIRS at GoogleMapsCompatible_Level9 caps at z9.
        // Same overzoom logic as carto: explicit maxzoom keeps the cloud
        // overlay visible (pixelated) above z9 instead of going blank.
        // GIBS_MAX_ZOOM lives in tile-precache.ts so the precache zoom
        // clamp stays in sync with the map source's maxzoom.
        maxzoom: GIBS_MAX_ZOOM,
        attribution:
          'Imagery from <a href="https://earthdata.nasa.gov">NASA GIBS</a>',
      },
      // Esri World Imagery (v1.5.1.0 — Chris feedback 2026-05-21).
      // When clouds toggle is OFF, this basemap swaps in instead of the
      // dark Carto basemap so the operator can see real satellite imagery
      // for feature picking (shoreline / mountain / pad coordinates).
      // Free, no auth, ~17m global resolution with sub-meter in many
      // regions. Esri ToS allows non-commercial use with attribution.
      'esri-imagery': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          'Imagery © <a href="https://www.esri.com">Esri</a> &mdash; Source: Esri, Maxar, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN, and the GIS User Community',
      },
      'ne-coastline': {
        // Natural Earth 110m coastlines, served from frontend/public/.
        // 94KB raw / ~31KB gzipped. Used to draw thin outlines on top of
        // the 55%-opacity cloud overlay so the operator can still pick
        // out continents when clouds are thick (reported 2026-05-17 —
        // without an explicit outline, the Carto basemap's coastlines
        // are washed out by the GIBS cloud layer's opacity). 110m is
        // intentionally coarse: at world-zoom this map shows orbital
        // geometry, not navigation-grade detail.
        type: 'geojson',
        data: '/ne_110m_coastline.geojson',
        attribution:
          'Coastlines: <a href="https://www.naturalearthdata.com/">Natural Earth</a>',
      },
    },
    layers: [
      {
        // Esri imagery basemap. Visibility is initially 'none' (Carto Dark
        // is the default). bindCloudToggle flips this to 'visible' when
        // clouds are toggled OFF, and Carto to 'none'. Order matters: this
        // sits BELOW Carto in the stack so a tile failure on Esri falls
        // through visually to the Carto layer underneath (A2 fallback).
        // Wait — actually we want the opposite. Carto BELOW Esri, with
        // both layers present in the stack; visibility toggles which one
        // shows. The "fallback on Esri error" is handled by an error
        // listener that flips visibility, not by stacking order.
        id: 'esri-imagery-layer',
        type: 'raster',
        source: 'esri-imagery',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 1.0 },
      },
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
      {
        // Coastline overlay ABOVE the cloud layer (renders order is
        // bottom-up in the array). Thin warm-toned line stays visible
        // through dense cloud cover; opacity tapered so it doesn't
        // overpower the cloud signal where clouds are light.
        id: 'ne-coastline-layer',
        type: 'line',
        source: 'ne-coastline',
        paint: {
          'line-color': '#f4d27a',
          'line-width': 0.6,
          'line-opacity': 0.75,
        },
      },
    ],
  };
}

/** Convert a flat list of [lat, lon] samples into MapLibre LineString
 *  features, splitting at antimeridian crossings (so the line doesn't
 *  drag across the whole map) and duplicating at lon ±360 (so the line
 *  renders continuously when the user pans across world copies — see
 *  Pettit feedback 2026-05-19).
 *
 *  Factored out so both the live-orbit (`groundTrackFeatures`) and
 *  future-orbit (`futureOrbitGroundTrackFeatures`) paths share the
 *  same antimeridian + world-copy handling.
 */
function buildLineFeatures(samples: [number, number][]): GeoJSON.Feature[] {
  type Pt = [number, number];
  const segments: Pt[][] = [];
  let current: Pt[] = [];
  let prevLon: number | null = null;

  for (const [lat, lonRaw] of samples) {
    const lon = wrapLon(lonRaw);
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push([lon, lat]);
    prevLon = lon;
  }
  if (current.length > 1) segments.push(current);

  const segmentFeatures = segments.map((coords) => ({
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: coords },
  }));
  const duplicated: GeoJSON.Feature[] = [];
  for (const f of segmentFeatures) {
    const coords = f.geometry.coordinates as [number, number][];
    duplicated.push(f);
    duplicated.push({
      ...f,
      geometry: {
        type: 'LineString',
        coordinates: coords.map(([lon, lat]) => [lon + 360, lat]),
      },
    });
    duplicated.push({
      ...f,
      geometry: {
        type: 'LineString',
        coordinates: coords.map(([lon, lat]) => [lon - 360, lat]),
      },
    });
  }
  return duplicated;
}

/** Split `track_points` (each `[t_seconds, lat, lon]`) into per-orbit
 *  buckets. Bucket `k` holds samples with `t in [k*period, (k+1)*period)`.
 *  Used by the multi-orbit display (v1.5.0.0) to render each orbit as
 *  a separate feature with its own `orbit_index` property, enabling a
 *  data-driven opacity ramp in the MapLibre layer paint.
 *
 *  Exported for unit testing.
 */
export function splitTrackByOrbit(
  trackPoints: [number, number, number][],
  periodSeconds: number = ISS_ORBIT_PERIOD_SECONDS,
): [number, number][][] {
  const buckets: [number, number][][] = [];
  for (const [t, lat, lon] of trackPoints) {
    const idx = Math.floor(t / periodSeconds);
    if (!buckets[idx]) buckets[idx] = [];
    buckets[idx].push([lat, lon]);
  }
  // Replace any holes (no samples for an orbit) with empty arrays to
  // keep indices stable when callers map across the array.
  for (let i = 0; i < buckets.length; i++) {
    if (!buckets[i]) buckets[i] = [];
  }
  return buckets;
}

/** Wrap line features for one orbit's samples with an `orbit_index`
 *  property. Re-uses `buildLineFeatures` for antimeridian + world-copy
 *  handling, then stamps every feature with its orbit index so the
 *  layer paint expression can drive opacity per orbit. */
function buildOrbitLineFeatures(
  samples: [number, number][],
  orbitIndex: number,
): GeoJSON.Feature[] {
  return buildLineFeatures(samples).map((f) => ({
    ...f,
    properties: { ...(f.properties ?? {}), orbit_index: orbitIndex },
  }));
}

/** Render the ground track polyline for the CURRENT orbit window.
 *  Prefers `track_points` (raw SGP4 samples covering ~4 orbits as of
 *  v1.5.0.0) when present. Falls back to evaluating the polynomial
 *  across its full duration for older manifests.
 *
 *  When `multiOrbitVisible` is true, splits track_points into per-orbit
 *  features so the layer paint can apply a fading-opacity ramp. When
 *  false, returns the full track as a single segment (the legacy
 *  one-feature path with `orbit_index: 0` on everything).
 */
function groundTrackFeatures(track: Track): GeoJSON.Feature[] {
  if (track.track_points && track.track_points.length > 0) {
    if (multiOrbitVisible) {
      const orbits = splitTrackByOrbit(track.track_points);
      const out: GeoJSON.Feature[] = [];
      for (let k = 0; k < orbits.length; k++) {
        const samples = orbits[k];
        if (!samples || samples.length < 2) continue;
        out.push(...buildOrbitLineFeatures(samples, k));
      }
      return out;
    }
    // Single-orbit (legacy) view: only the first orbit's samples.
    const firstOrbit = (track.track_points
      .filter(([t]) => t < ISS_ORBIT_PERIOD_SECONDS)
      .map(([, lat, lon]) => [lat, lon] as [number, number]));
    return buildOrbitLineFeatures(firstOrbit, 0);
  }
  // Polynomial fallback for older manifests without track_points.
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
  return buildOrbitLineFeatures(out, 0);
}

/** Render a SINGLE orbit's ground track at a future time, SGP4-derived.
 *
 *  Used by the time-scrub buttons (v1.4.0.0). For lookaheadMinutes > 0,
 *  we sample the ISS ground track in a ±45-min window centered on
 *  (nowMs + lookahead*60s) at 30s resolution. The result is exactly
 *  one orbit's worth of polyline — the visual answer to "what would
 *  ISS be flying over at that future time?"
 *
 *  Returns empty list if the track has no usable TLE (older manifest).
 */
function futureOrbitGroundTrackFeatures(
  track: Track, lookaheadMinutes: number, nowMs: number,
): GeoJSON.Feature[] {
  if (lookaheadMinutes <= 0) return groundTrackFeatures(track);
  const centerMs = nowMs + lookaheadMinutes * 60_000;
  const halfWindowMs = PASS_WINDOW_HALF_MINUTES * 60_000;
  const stepMs = 30_000;
  const samples: [number, number][] = [];
  for (let t = centerMs - halfWindowMs; t <= centerMs + halfWindowMs; t += stepMs) {
    const pos = issPositionWithAltSGP4(track, t);
    if (!pos) continue;
    samples.push([pos.lat, pos.lon]);
  }
  return buildLineFeatures(samples);
}

export async function renderMap(manifest: Manifest): Promise<void> {
  const container = document.getElementById('map');
  if (!container) return;

  const passes = await fetchArtifact<PassEntry[]>(manifest, 'passes');
  const track = await fetchArtifact<Track>(manifest, 'track');
  currentTrack = track;

  const isFirstInit = !map;
  if (!map) {
    map = new maplibregl.Map({
      container,
      style: buildStyle(),
      center: [0, 0],
      // z=1.5 fit the whole world but made panning feel like a no-op (you
      // were already at the edge of the visible tile space). z=2 leaves
      // room to drag without losing the "see the orbit at a glance"
      // affordance. Operator reported 2026-05-17 pan felt locked at z=1.5.
      zoom: 2,
      attributionControl: { compact: true },
      // Pettit feedback 2026-05-19: "Having the map view scroll left and
      // right so that ISS location can be placed where you want (so if
      // near right hand side map not to have orbit clipped where you
      // have to piece together with the left hand side)." Explicit
      // renderWorldCopies (default true; pin it so MapLibre majors
      // can't silently flip it) + below in groundTrackFeatures we
      // duplicate the ground track at lon ±360 offsets so the polyline
      // renders continuously across world copies.
      renderWorldCopies: true,
      // Explicit gesture defaults. Defending against a future MapLibre
      // major bump silently flipping a default to false.
      dragPan: true,
      dragRotate: true,
      scrollZoom: true,
      touchZoomRotate: true,
      touchPitch: true,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-left');
    // A2 from /plan-eng-review 2026-05-21: silent fallback to Carto Dark
    // if Esri imagery tiles fail to load. Listens for source-data errors;
    // if the failing source is the Esri basemap, flip the session flag
    // and re-apply visibility (which will keep Carto visible). One-way:
    // once Esri has failed in this session, we don't retry until reload.
    map.on('error', (e) => {
      const errSource = (e as { sourceId?: string } | undefined)?.sourceId;
      if (errSource === 'esri-imagery' && !esriTilesFailed) {
        esriTilesFailed = true;
        // eslint-disable-next-line no-console
        console.warn('[map] Esri imagery tile load failed; falling back to Carto Dark basemap for the rest of this session');
        applyCloudsVisibility();
      }
    });
    await new Promise<void>((resolve) => {
      map!.once('load', () => resolve());
    });
  }

  // Imagery-date badge: tells the user how recent the cloud composite the
  // map's tiles are showing actually is. Especially load-bearing offline —
  // GIBS tiles cached past day-roll could otherwise read as today's clouds.
  ensureImageryDateBadge(container, manifest);

  // Stash for the time-scrub refresh path (v1.4.0.0). The buttons rebuild
  // the track + target sources from this cached list without re-fetching.
  currentPasses = passes;

  // Ground track layer — lookahead-aware. At Now (lookahead=0) shows the
  // standard track_points 2-orbit polyline; at +N>0 shows a single ±45min
  // window centered on the future time, SGP4-derived.
  refreshGroundTrackSource(track);
  if (!map.getLayer('iss-track-layer')) {
    map.addLayer({
      id: 'iss-track-layer',
      type: 'line',
      source: 'iss-track',
      paint: {
        'line-color': '#5cd0ff',
        'line-width': 2,
        // v1.5.0.0: data-driven opacity. With multi-orbit OFF every
        // feature has orbit_index=0 and renders at 0.85 (the prior
        // single-orbit look). With multi-orbit ON, orbit 0 is solid,
        // +1/+2/+3 fade out so the operator sees current is dominant
        // and future orbits are context, not noise.
        'line-opacity': [
          'match',
          ['coalesce', ['get', 'orbit_index'], 0],
          0, 0.85,
          1, 0.55,
          2, 0.35,
          3, 0.2,
          0.12,
        ],
        'line-dasharray': [2, 1],
      },
    });
  }

  // Targets layer — features carry closest_approach_ms so the paint
  // expression can dim out-of-window passes per Q3 → C (filter+dim).
  refreshTargetsSource();
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
        // Data-driven opacity: pins for passes whose closest_approach
        // falls within ±45 min of the current view time render full
        // opacity; out-of-window pins dim to 0.25 (Q3 → C from the
        // 2026-05-20 decision). The per-feature `in_window` property
        // is set in refreshTargetsSource() based on lookaheadMinutes.
        'circle-opacity': [
          'case',
          ['==', ['get', 'in_window'], true], 0.95,
          0.25,
        ],
        'circle-stroke-opacity': [
          'case',
          ['==', ['get', 'in_window'], true], 1.0,
          0.3,
        ],
      },
    });
    // Click handler: popup with target name + score + forecast conditions.
    // Uses setDOMContent + textContent (NOT setHTML) so target names with
    // HTML-meta characters can't render as markup. personal-targets.csv is
    // user-controlled, so a name like "<img onerror=...>" must not become
    // a script-injection surface inside the popup.
    map.on('click', 'targets-layer', (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      const coords = (f.geometry.coordinates as [number, number]).slice() as [number, number];
      const popupBody = buildTargetPopupContent(
        f.properties as TargetPopupProps,
        Date.now(),
      );
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

  // Day-night terminator overlay (v1.4.2.0 — Pettit feedback 2026-05-19).
  // Line + subsolar-point icon. Updates when the operator scrubs the
  // time controls (refreshTerminatorSources is called from setLookahead).
  refreshTerminatorSources();
  if (!map.getLayer('terminator-line-layer')) {
    map.addLayer({
      id: 'terminator-line-layer',
      type: 'line',
      source: 'terminator-line',
      paint: {
        'line-color': '#ffd45c',  // warm gold; reads clearly over both
        'line-width': 1.4,         // dark basemap and bright cloud overlay
        'line-opacity': 0.7,
        'line-dasharray': [3, 2],
      },
    });
  }
  if (!map.getLayer('subsolar-point-layer')) {
    map.addLayer({
      id: 'subsolar-point-layer',
      type: 'circle',
      source: 'subsolar-point',
      paint: {
        'circle-radius': 8,
        'circle-color': '#ffd45c',
        'circle-stroke-color': '#0b0d12',
        'circle-stroke-width': 1.5,
        'circle-opacity': 0.95,
      },
    });
  }
  applyTerminatorVisibility();

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
    // Live ISS marker updates every 1s ONLY at Now (lookahead=0). When
    // the operator has scrubbed forward, the marker is frozen at the
    // future orbit's start (Q2 → A) — no point recomputing every second
    // since the target time isn't moving.
    if (lookaheadMinutes === 0) {
      const pos = markerPositionFor(currentTrack);
      if (pos) issMarker.setLngLat([pos.lon, pos.lat]);
    }
    if (bearingMode === 'iss-up') applyBearing(false);
  }, 1000);

  // Refresh the UTC labels on the time-step buttons every 30s so the
  // displayed "click would take you to HH:MMZ" stays accurate without
  // a per-second redraw on the unattended Mac.
  if (timeLabelTimer !== null) clearInterval(timeLabelTimer);
  timeLabelTimer = window.setInterval(() => {
    updateTimeStepLabels();
    // Refresh terminator + subsolar point with the new wall-clock time
    // (at lookahead=0; if scrubbed, the terminator follows lookahead
    // already and won't drift). Cheap — terminatorFeatures is ~10ms.
    if (lookaheadMinutes === 0) refreshTerminatorSources();
  }, 30_000);
  updateTimeStepLabels();

  bindTimeToggle();
  bindBearingToggle();
  bindCloudToggle();
  bindTerminatorToggle();
  bindMultiOrbitToggle();
  // Apply persisted cloud + terminator preferences on first map render.
  applyCloudsVisibility();
  applyTerminatorVisibility();
  // Apply persisted bearing preference ONLY on first map creation. Calling
  // easeTo on every Map-tab click (which re-runs renderMap) was eating
  // user pan/zoom gestures that landed in the 600ms animation window —
  // contributed to the "map feels locked" report (2026-05-17). The live
  // timer's setBearing(heading) every 1s already keeps iss-up in sync; no
  // need to re-animate on each tab visit.
  if (isFirstInit) applyBearing(true);
}

/** Return the position the ISS marker should occupy given the current
 *  lookahead toggle. Returns null if the polynomial doesn't cover the
 *  requested time (clamps to end-of-window).
 */
function markerPositionFor(track: Track): { lat: number; lon: number } | null {
  const targetMs = Date.now() + lookaheadMinutes * 60_000;
  // For lookahead > 0 the polynomial likely doesn't cover the target time
  // (only ~120 min). Use SGP4 directly so the frozen marker lands at the
  // future orbit's start (Q2 → A in the 2026-05-20 decision).
  if (lookaheadMinutes > 0) {
    const sgp4 = issPositionWithAltSGP4(track, targetMs);
    if (sgp4) return { lat: sgp4.lat, lon: sgp4.lon };
  }
  const pos = liveIssPosition(track, targetMs);
  if (pos) return pos;
  // Fallback: clamp to last point in the polynomial window
  const startMs = Date.parse(track.iss_polynomial.start);
  if (Number.isNaN(startMs)) return null;
  const endMs = startMs + track.iss_polynomial.duration_seconds * 1000;
  return liveIssPosition(track, Math.min(targetMs, endMs - 1000));
}

/** Rebuild the iss-track geojson source based on the current lookahead.
 *  At Now (lookahead=0) renders the standard 2-orbit polynomial track;
 *  at +N>0 renders just the ±45min window around (now + N min) via SGP4. */
function refreshGroundTrackSource(track: Track): void {
  if (!map) return;
  const features = futureOrbitGroundTrackFeatures(track, lookaheadMinutes, Date.now());
  upsertGeoJson(map, 'iss-track', {
    type: 'FeatureCollection',
    features,
  });
}

/** Rebuild the terminator line + subsolar point sources at the current
 *  view time (now + lookaheadMinutes). Called from renderMap on first
 *  render and from setLookahead on every time-scrub click. */
function refreshTerminatorSources(): void {
  if (!map) return;
  const when = new Date(Date.now() + lookaheadMinutes * 60_000);
  upsertGeoJson(map, 'terminator-line', {
    type: 'FeatureCollection',
    features: terminatorFeatures(when),
  });
  upsertGeoJson(map, 'subsolar-point', {
    type: 'FeatureCollection',
    features: [subsolarFeature(when)],
  });
}

/** Show / hide the terminator overlay (line + subsolar dot). Idempotent. */
function applyTerminatorVisibility(): void {
  if (!map) return;
  const vis = terminatorVisible ? 'visible' : 'none';
  try {
    if (map.getLayer('terminator-line-layer')) {
      map.setLayoutProperty('terminator-line-layer', 'visibility', vis);
    }
    if (map.getLayer('subsolar-point-layer')) {
      map.setLayoutProperty('subsolar-point-layer', 'visibility', vis);
    }
  } catch { /* layers not loaded yet */ }
}

/** Rebuild the targets geojson source. Each feature carries `in_window`
 *  derived from its closest_approach vs the current view time. The
 *  data-driven opacity expression on the targets-layer paint reads this
 *  property — full opacity for in-window passes, dimmed for the rest. */
function refreshTargetsSource(): void {
  if (!map) return;
  const viewMs = Date.now() + lookaheadMinutes * 60_000;
  const halfWindowMs = PASS_WINDOW_HALF_MINUTES * 60_000;
  const features = currentPasses.map((p) => {
    const closestMs = Date.parse(p.closest_approach);
    const inWindow = Number.isFinite(closestMs)
      && Math.abs(closestMs - viewMs) <= halfWindowMs;
    // Carry the forecast-cloud + regime + obstruction fields through to
    // the geojson properties so the click-popup can render the predicted
    // conditions for THIS pass time without re-fetching passes.json.
    // (v1.4.1.0 — operator question 2026-05-20: "if I see a green dot
    // at +6h does that mean predicted-good?" Yes — and now you can tap
    // the dot to see the predicted cloud number.)
    return {
      type: 'Feature' as const,
      properties: {
        target_id: p.target_id,
        target_name: p.target_name,
        score: p.score,
        in_window: inWindow,
        closest_approach: p.closest_approach,
        cloud_fraction: p.cloud_fraction,
        cloud_source: p.cloud_source,
        pass_regime: p.pass_regime,
        obstruction_class: p.obstruction_class,
        sample_time: p.sample_time ?? null,
      },
      geometry: { type: 'Point' as const, coordinates: [p.target_lon, p.target_lat] },
    };
  });
  upsertGeoJson(map, 'targets', {
    type: 'FeatureCollection',
    features,
  });
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

/** Compute the ISS heading (degrees clockwise from north) by sampling
 *  ISS position at `nowMs` and `nowMs + 30s`. Returns null if either
 *  sample fails or the two are identical (degenerate case).
 *
 *  Picks the propagation path based on whether the requested time is
 *  inside the polynomial window:
 *    - In window (~120 min from polynomial start): polynomial — cheap
 *      evaluation, used for the 1Hz live-bearing path.
 *    - Past window OR lookahead-scrubbed: SGP4 directly. v1.4.0.0 fix
 *      — previously this used the polynomial only, so ISS-up did nothing
 *      whenever the operator scrubbed forward past the 120-min window
 *      (which is most of the time, since +90 already lands at ~90min).
 */
function computeIssHeading(track: Track, nowMs: number): number | null {
  const here = liveIssPosition(track, nowMs)
    ?? issPositionWithAltSGP4(track, nowMs);
  const ahead = liveIssPosition(track, nowMs + 30_000)
    ?? issPositionWithAltSGP4(track, nowMs + 30_000);
  if (!here || !ahead) return null;
  if (here.lat === ahead.lat && here.lon === ahead.lon) return null;
  return greatCircleBearingDeg(here.lat, here.lon, ahead.lat, ahead.lon);
}

/** Apply the current bearing mode to the map. ISS-up sets bearing to the
 *  current heading so direction-of-travel points up; north resets to 0.
 *  Smooth animation via easeTo; no-op if bearing already matches target
 *  (calling easeTo with same value still starts a 0-duration animation
 *  that can interrupt in-flight pan/zoom gestures). */
const BEARING_NOOP_THRESHOLD_DEG = 0.5;

function applyBearing(animate: boolean): void {
  if (!map) return;
  const current = map.getBearing();
  if (bearingMode === 'north') {
    if (Math.abs(current) < BEARING_NOOP_THRESHOLD_DEG) return;
    if (animate) map.easeTo({ bearing: 0, duration: 600 });
    else map.setBearing(0);
    return;
  }
  if (!currentTrack) return;
  const heading = computeIssHeading(currentTrack, Date.now() + lookaheadMinutes * 60_000);
  if (heading === null) return;
  // Smallest angle between current and target, accounting for the 0=360 wrap.
  const delta = Math.abs(((heading - current + 540) % 360) - 180);
  if (delta < BEARING_NOOP_THRESHOLD_DEG) return;
  if (animate) map.easeTo({ bearing: heading, duration: 600 });
  else map.setBearing(heading);
}

/** Refresh the UTC time chips on each time-step button.
 *
 *  Each button's chip shows the UTC time the operator would land at if
 *  they clicked it from the CURRENT lookahead state. So at Now, the
 *  [T+90 →] chip shows now+90min; at +180, the same [T+90 →] chip
 *  shows now+270min (the +90 would jump to). The Now button always
 *  shows the actual current wall clock.
 */
function updateTimeStepLabels(): void {
  const nowMs = Date.now();
  const viewMs = nowMs + lookaheadMinutes * 60_000;
  // Map button id → step in minutes relative to CURRENT view.
  const steps: Array<[string, number]> = [
    ['time-back-90', -90],
    ['time-back-45', -45],
    ['time-now', 0],
    ['time-fwd-45', 45],
    ['time-fwd-90', 90],
  ];
  for (const [id, step] of steps) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const chip = btn.querySelector<HTMLElement>('[data-time-utc]');
    if (!chip) continue;
    let targetMinutes: number;
    if (id === 'time-now') {
      // Now button always shows the real wall-clock UTC, not lookahead-adjusted.
      targetMinutes = 0;
    } else {
      // Back buttons clamp at 0; forward buttons clamp at LOOKAHEAD_MAX_MINUTES.
      targetMinutes = clampLookahead(lookaheadMinutes + step);
    }
    const targetMs = nowMs + targetMinutes * 60_000;
    chip.textContent = formatUtcHm(targetMs);
    // Disabled-look when the button would be a no-op (already at floor/ceiling).
    const wouldBeNoop = (id !== 'time-now') &&
      clampLookahead(lookaheadMinutes + step) === lookaheadMinutes;
    btn.classList.toggle('time-step-noop', wouldBeNoop);
  }
}

let toggleBound = false;
function bindTimeToggle(): void {
  if (toggleBound) return;
  const stepBtns = document.querySelectorAll<HTMLButtonElement>('.time-step-btn');
  if (stepBtns.length === 0) return;

  const setLookahead = (newMinutes: number, recenter: boolean) => {
    const clamped = clampLookahead(newMinutes);
    if (clamped === lookaheadMinutes && lookaheadMinutes === 0) {
      // Clicking Now while already at Now is a no-op; same for clicking
      // back at floor. Skip the visual churn.
      updateTimeStepLabels();
      return;
    }
    lookaheadMinutes = clamped;
    // Update active state — only the Now button has an "active" state
    // (it's the only one that represents a specific lookahead value);
    // the +/- step buttons are pure delta buttons that flash on click.
    stepBtns.forEach((b) => {
      const isNow = b.id === 'time-now';
      b.classList.toggle('active', isNow && clamped === 0);
    });

    // Rebuild track + targets with the new lookahead.
    if (currentTrack) {
      refreshGroundTrackSource(currentTrack);
      refreshTargetsSource();
      // Terminator + subsolar follow the time-scrub so day/night
      // reflects the view time, not real-time-now (v1.4.2.0).
      refreshTerminatorSources();
      // Move + freeze marker at the new view time.
      if (map && issMarker) {
        const pos = markerPositionFor(currentTrack);
        if (pos) {
          issMarker.setLngLat([pos.lon, pos.lat]);
          if (recenter) {
            map.easeTo({ center: [pos.lon, pos.lat], duration: 600 });
          }
        }
      }
    }
    updateTimeStepLabels();
  };

  stepBtns.forEach((btn) => {
    const step = Number(btn.dataset.step);
    if (!Number.isFinite(step)) return;
    btn.addEventListener('click', () => {
      if (step === 0) {
        // Now: reset to live current orbit
        setLookahead(0, /*recenter=*/false);
      } else {
        setLookahead(lookaheadMinutes + step, /*recenter=*/true);
      }
    });
  });
  toggleBound = true;
}

/** Show / hide both the GIBS cloud raster layer AND the coastline overlay's
 *  toggle target. Pettit asked for cloud-toggle specifically; coastline
 *  stays on because it doesn't compete with the cloud signal. Idempotent —
 *  safe to call before MapLibre has loaded the layers. */
/** Track whether Esri tiles have failed to load. If they have, we never
 *  swap to the Esri basemap again this session — fall back to Carto Dark
 *  silently (A2 from /plan-eng-review 2026-05-21). Prevents the operator
 *  from ending up on a blank map when Esri's CDN is down. */
let esriTilesFailed = false;

function applyCloudsVisibility(): void {
  if (!map) return;
  const cloudsLayerVis = cloudsVisible ? 'visible' : 'none';
  // v1.5.1.0: when clouds are OFF, swap from Carto Dark to Esri World Imagery
  // so the operator can see real satellite/feature data (Chris ask 2026-05-21).
  // Carto Dark stays as the basemap when clouds are ON because the dark
  // background makes the 55%-opacity GIBS cloud overlay legible.
  // P1 from review: source-swap via setLayoutProperty visibility, not
  // setStyle rebuild — keeps all overlays + layer state intact.
  const useEsri = !cloudsVisible && !esriTilesFailed;
  const esriVis = useEsri ? 'visible' : 'none';
  const cartoVis = useEsri ? 'none' : 'visible';
  try {
    if (map.getLayer('gibs-clouds-layer')) {
      map.setLayoutProperty('gibs-clouds-layer', 'visibility', cloudsLayerVis);
    }
    if (map.getLayer('esri-imagery-layer')) {
      map.setLayoutProperty('esri-imagery-layer', 'visibility', esriVis);
    }
    if (map.getLayer('carto-dark-layer')) {
      map.setLayoutProperty('carto-dark-layer', 'visibility', cartoVis);
    }
  } catch {
    /* layers may not be loaded yet on the first call — applyCloudsVisibility
       runs again after renderMap binds */
  }
}

let cloudToggleBound = false;
function bindCloudToggle(): void {
  if (cloudToggleBound) return;
  const btn = document.getElementById('toggle-clouds');
  if (!btn) return;
  const reflect = () => {
    btn.classList.toggle('active', cloudsVisible);
    btn.setAttribute(
      'aria-pressed', cloudsVisible ? 'true' : 'false',
    );
    btn.title = cloudsVisible
      ? 'Clouds shown (dark basemap) — click to hide clouds and show satellite imagery'
      : 'Clouds hidden (satellite imagery) — click to show clouds and dark basemap';
  };
  reflect();
  btn.addEventListener('click', () => {
    cloudsVisible = !cloudsVisible;
    try { localStorage.setItem(CLOUDS_PREF_KEY, cloudsVisible ? '1' : '0'); } catch { /* noop */ }
    reflect();
    applyCloudsVisibility();
  });
  cloudToggleBound = true;
}

let terminatorToggleBound = false;
function bindTerminatorToggle(): void {
  if (terminatorToggleBound) return;
  const btn = document.getElementById('toggle-terminator');
  if (!btn) return;
  const reflect = () => {
    btn.classList.toggle('active', terminatorVisible);
    btn.setAttribute(
      'aria-pressed', terminatorVisible ? 'true' : 'false',
    );
    btn.title = terminatorVisible
      ? 'Day-night terminator shown — click to hide'
      : 'Day-night terminator hidden — click to show';
  };
  reflect();
  btn.addEventListener('click', () => {
    terminatorVisible = !terminatorVisible;
    try { localStorage.setItem(TERMINATOR_PREF_KEY, terminatorVisible ? '1' : '0'); } catch { /* noop */ }
    reflect();
    applyTerminatorVisibility();
  });
  terminatorToggleBound = true;
}

let multiOrbitToggleBound = false;
function bindMultiOrbitToggle(): void {
  if (multiOrbitToggleBound) return;
  const btn = document.getElementById('toggle-multi-orbit');
  if (!btn) return;
  const reflect = () => {
    btn.classList.toggle('active', multiOrbitVisible);
    btn.setAttribute('aria-pressed', multiOrbitVisible ? 'true' : 'false');
    btn.title = multiOrbitVisible
      ? 'Showing 4 future orbits — click to show just the current orbit'
      : 'Showing current orbit only — click to show next 4 orbits';
  };
  reflect();
  btn.addEventListener('click', () => {
    multiOrbitVisible = !multiOrbitVisible;
    try { localStorage.setItem(MULTI_ORBIT_PREF_KEY, multiOrbitVisible ? '1' : '0'); } catch { /* noop */ }
    reflect();
    // Rebuild the iss-track source with the new orbit-segmentation.
    // refreshGroundTrackSource reads `multiOrbitVisible` via the closure
    // chain into groundTrackFeatures (when lookahead=0; the time-scrub
    // path uses a single ±45min window so the toggle is a no-op there).
    if (currentTrack) refreshGroundTrackSource(currentTrack);
  });
  multiOrbitToggleBound = true;
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

/** Shape of MapLibre feature properties on a target pin. Mirrors the
 *  fields populated in refreshTargetsSource(); kept inline so the popup
 *  builder is self-contained and testable without importing PassEntry. */
export interface TargetPopupProps {
  target_name?: string;
  score?: number;
  closest_approach?: string;
  cloud_fraction?: number;
  cloud_source?: string;
  pass_regime?: string;
  obstruction_class?: string;
  sample_time?: string | null;
}

/** Translate the generator's cloud_source string into an operator-facing
 *  label. The generator's source values are technical (e.g., "gfs-forecast",
 *  "geo-ir-goes16"); we surface "Forecast" vs "Observed" + the underlying
 *  satellite so the operator instantly knows what kind of prediction
 *  drove the score.
 */
export function cloudSourceLabel(source: string | undefined): string {
  if (!source) return 'unknown';
  if (source === 'gfs-forecast') return 'GFS forecast';
  if (source === 'gibs') return 'MODIS observed';
  if (source.startsWith('geo-ir-')) {
    const sat = source.slice('geo-ir-'.length);
    return `${sat.toUpperCase()} observed`;
  }
  if (source === 'meteosat-ir108') return 'Meteosat observed';
  if (source === 'himawari-nict') return 'Himawari observed';
  if (source === 'mock') return 'mock (no obs)';
  if (source.endsWith('-no-coverage') || source === 'combined-no-coverage') return 'no obs';
  return source;
}

/** Build the popup body for a target pin click. Includes target name,
 *  pass time (UTC + relative), score, forecast/observed cloud number,
 *  regime, and obstruction class. Exported for unit testing — the click
 *  handler in renderMap() just calls this and hands the result to
 *  MapLibre's Popup.setDOMContent.
 *
 *  Safety: every text node uses textContent (never innerHTML), so a
 *  user-supplied target name with HTML-meta characters can never escape
 *  into markup.
 */
export function buildTargetPopupContent(
  props: TargetPopupProps,
  nowMs: number,
): HTMLElement {
  const body = document.createElement('div');
  body.className = 'map-target-popup';
  body.style.cssText = 'font:0.85rem/1.4 system-ui;color:#0b0d12;min-width:200px';

  const nameEl = document.createElement('strong');
  nameEl.textContent = props.target_name ?? 'unknown';
  body.appendChild(nameEl);

  const scoreEl = document.createElement('div');
  scoreEl.className = 'map-popup-score';
  scoreEl.style.cssText = 'font-weight:600;color:#0b0d12;margin-top:2px';
  scoreEl.textContent = `score ${Math.round(props.score ?? 0)}`;
  body.appendChild(scoreEl);

  // Pass time row.
  if (props.closest_approach) {
    const passMs = Date.parse(props.closest_approach);
    if (Number.isFinite(passMs)) {
      const row = document.createElement('div');
      row.className = 'map-popup-row';
      row.style.cssText = 'margin-top:6px;color:#444';
      const utc = props.closest_approach.replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, 'Z');
      const deltaMin = Math.round((passMs - nowMs) / 60_000);
      const rel = formatRelativeMinutes(deltaMin);
      row.textContent = `Pass: ${utc}${rel ? ` (${rel})` : ''}`;
      body.appendChild(row);
    }
  }

  // Forecast / observed cloud row.
  if (typeof props.cloud_fraction === 'number') {
    const row = document.createElement('div');
    row.className = 'map-popup-row';
    row.style.cssText = 'margin-top:2px;color:#444';
    const label = cloudSourceLabel(props.cloud_source);
    row.textContent = `Cloud: ${Math.round(props.cloud_fraction)}% (${label})`;
    body.appendChild(row);
  }

  // Regime + obstruction row.
  const regimeBits: string[] = [];
  if (props.pass_regime) regimeBits.push(props.pass_regime);
  if (props.obstruction_class) regimeBits.push(props.obstruction_class);
  if (regimeBits.length > 0) {
    const row = document.createElement('div');
    row.className = 'map-popup-row';
    row.style.cssText = 'margin-top:2px;color:#444';
    row.textContent = regimeBits.join(' · ');
    body.appendChild(row);
  }

  return body;
}

/** Compact human-friendly relative-time string for the popup pass row.
 *  Returns "" when the pass is within ±1 min (rendered as just the UTC
 *  time — relative-now adds no signal). */
function formatRelativeMinutes(deltaMinutes: number): string {
  const abs = Math.abs(deltaMinutes);
  if (abs < 1) return '';
  const past = deltaMinutes < 0;
  const suffix = past ? ' ago' : '';
  const prefix = past ? '' : 'in ';
  if (abs < 60) return `${prefix}${abs}m${suffix}`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (m === 0) return `${prefix}${h}h${suffix}`;
  return `${prefix}${h}h ${m}m${suffix}`;
}

/** Drop a single "photo lookup" pin on the map at the supplied lat/lon, replacing
 *  any prior lookup pin. Distinct color from the regular target pins (magenta
 *  vs the existing red-yellow-green target gradient). Auto-pans the map to
 *  center the pin and zooms to z=4 if the current zoom is lower.
 *
 *  Lazy: if the map hasn't initialized yet (user clicked the Lookup tab before
 *  ever visiting Map), the pin is queued and rendered when the map is next
 *  created. (Not implemented in v1 — main.ts ensures the Map tab is activated
 *  before this is called, so the map is always live by the time we drop a pin.)
 *
 *  Used by photo-lookup.ts (Pettit feedback 2026-05-19).
 */
export function dropLookupPin(result: {
  lat: number; lon: number; alt_km: number; timestamp_utc: Date;
}): void {
  if (!map) return;
  const fc: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        timestamp_iso: result.timestamp_utc.toISOString(),
        alt_km: result.alt_km,
      },
      geometry: { type: 'Point', coordinates: [result.lon, result.lat] },
    }],
  };
  upsertGeoJson(map, 'lookup-pin', fc);
  if (!map.getLayer('lookup-pin-layer')) {
    map.addLayer({
      id: 'lookup-pin-layer',
      type: 'circle',
      source: 'lookup-pin',
      paint: {
        'circle-radius': 10,
        'circle-color': '#ff5cbb',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
        'circle-opacity': 0.9,
      },
    });
    map.on('click', 'lookup-pin-layer', (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      const coords = (f.geometry.coordinates as [number, number]).slice() as [number, number];
      const props = f.properties as { timestamp_iso?: string; alt_km?: number };
      const body = document.createElement('div');
      body.style.cssText = 'font:0.85rem/1.4 system-ui;color:#0b0d12';
      const title = document.createElement('strong');
      title.textContent = '🛰️ ISS position';
      const ts = document.createElement('div');
      ts.textContent = props.timestamp_iso ?? 'unknown time';
      const alt = document.createElement('div');
      alt.textContent = `Altitude: ${(props.alt_km ?? 0).toFixed(1)} km`;
      body.append(title, ts, alt);
      new maplibregl.Popup()
        .setLngLat(coords)
        .setDOMContent(body)
        .addTo(map!);
    });
    map.on('mouseenter', 'lookup-pin-layer', () => {
      if (map) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'lookup-pin-layer', () => {
      if (map) map.getCanvas().style.cursor = '';
    });
  }
  // Center + ensure visible zoom. Don't override the user's bearing/tilt.
  const targetZoom = Math.max(map.getZoom(), 4);
  map.easeTo({ center: [result.lon, result.lat], zoom: targetZoom, duration: 800 });
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
