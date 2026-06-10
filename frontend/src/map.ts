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
import { liveIssNow, liveIssPosition, wrapLon } from './iss';
import { issPositionWithAltSGP4, liveIssPositionSGP4 } from './iss-sgp4';
import { formatTrackOffset } from './track-offset';
import {
  findUpcomingPasses,
  roundForZoom,
  type UpcomingPass,
} from './pin-drop';
import {
  CURATED_SATELLITES,
  fetchSatelliteTLE,
  fetchTLEByCATNR,
  fetchTLEByName,
  metaKey,
  type SatelliteMeta,
  type TLEPair,
} from './satellites';
import {
  classifyIssIllumination,
  subsolarFeature,
  terminatorFeatures,
  terminatorNightPolygonFeatures,
  type IssIllumination,
} from './terminator';
import { loadProfile, parseProfileFromURL, type PersonalTarget } from './profile';
import { applyTargetFilter, getTargetFilter } from './target-filter-pref';
import { subscribeProfileChanged } from './profile-events';

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
// Orbit time-scrub: null = live "Now" mode (1Hz marker tick + standard
// 2-orbit track). Non-null = the map is pinned to an ABSOLUTE UTC instant
// and shows ONLY the orbit centered there, ISS marker frozen at that
// instant (per Q2 → A in the 2026-05-20 decision).
//
// T1 (eng-review 2026-06-10): this was `let lookaheadMinutes = 0` — a
// RELATIVE offset that every refresh re-resolved against the advancing
// wall clock, so a view parked on the 19:42Z pass silently became the
// 19:52Z view ten minutes later. Buttons + short glances hid the drift;
// the continuous slider invites parking, so the instant is now absolute
// and the wall clock catching up snaps the view back to live
// (maybeSnapToLive, called from the 1Hz live timer).
//
// Still capped at now+36h via clampLookahead() — matches the upcoming
// passes.json horizon so we don't scrub into orbits with no target data.
// Cannot go into the past (Q3/3A — "back" is toward Now; floor at 0).
let viewTimeMs: number | null = null;

// Exported (6A, 2026-06-10): the cap, the clamp, and the UTC formatter are
// the contract the time controls (steppers + slider) and their tests share.
// time-scrub.test.ts previously re-implemented these as local copies — a
// copy can never catch the real implementation diverging, so the real
// functions are exported and the copies were deleted.
export const LOOKAHEAD_MAX_MINUTES = 36 * 60;  // 2160; matches passes.json horizon

export function clampLookahead(m: number): number {
  if (!Number.isFinite(m) || m < 0) return 0;
  if (m > LOOKAHEAD_MAX_MINUTES) return LOOKAHEAD_MAX_MINUTES;
  return Math.round(m);
}

/** UTC ISO 8601 time portion at minute precision, e.g., "12:34Z". */
export function formatUtcHm(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/** The absolute instant the map renders (live now when not scrubbed). */
function currentViewMs(nowMs = Date.now()): number {
  return viewTimeMs ?? nowMs;
}

/** Minutes from live-now to the pinned view instant (0 when live).
 *  Fractional by design: the pinned instant doesn't move, so this offset
 *  shrinks as the wall clock advances toward it. */
function lookaheadMinutesNow(nowMs = Date.now()): number {
  if (viewTimeMs === null) return 0;
  return Math.max(0, (viewTimeMs - nowMs) / 60_000);
}

/** True when the map is pinned to a future instant (scrub active). Gates
 *  follow-ISS recentering and live ticking; exported for tests + main.ts. */
export function isScrubbed(): boolean {
  return viewTimeMs !== null;
}

/** Snap back to live mode once the wall clock reaches the pinned instant
 *  (T1, 2026-06-10): a +N scrub eventually becomes "now"; returning to live
 *  beats rendering a frozen scene that slowly falls behind. Called from the
 *  1Hz live timer; returns true when a snap happened. Exported for unit
 *  tests (the timer itself needs a full map env). */
export function maybeSnapToLive(nowMs = Date.now()): boolean {
  if (viewTimeMs !== null && nowMs >= viewTimeMs) {
    setLookahead(0, /*recenter=*/false);
    return true;
  }
  return false;
}

/** Test-only: the pinned absolute view instant (null = live). */
export function _getViewTimeMsForTest(): number | null {
  return viewTimeMs;
}

/** Test-only: install a Track so track-dependent affordances (e.g. the
 *  stale-TLE readout hint) can be exercised without a full renderMap. */
export function _setCurrentTrackForTest(track: Track | null): void {
  currentTrack = track;
}

/** Day-aware UTC readout for the slider (eng-review T6a): "13:30Z" today,
 *  "+1d 03:15Z" past midnight UTC. Bare HH:MMZ is ambiguous across the 36h
 *  scrub range — pass planning around midnight needs the day. */
export function formatViewTimeReadout(viewMs: number, nowMs: number): string {
  const dayDiff = Math.floor(viewMs / 86_400_000) - Math.floor(nowMs / 86_400_000);
  const prefix = dayDiff > 0 ? `+${dayDiff}d ` : '';
  return `${prefix}${formatUtcHm(viewMs)}`;
}

/** rAF-gate factory (eng-review 7A): coalesce a ~60Hz event burst to at most
 *  one apply() per animation frame; apply reads the LATEST value at fire
 *  time. No trailing timer needed — 'input' keeps firing while the value
 *  changes and 'change' fires once at release. The tiered light/heavy split
 *  is the documented fallback ONLY if real-iPad QA measures jank with this.
 *  Exported for tests (inject a manual raf). */
export function rafCoalesce(
  apply: () => void,
  raf: (cb: () => void) => unknown = (cb) => requestAnimationFrame(cb),
): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    raf(() => {
      pending = false;
      apply();
    });
  };
}

/** "Pass window" half-width: a pass with closest_approach within ±45 min
 *  of the current view time is considered in-orbit and rendered full
 *  opacity. Outside that window the pin dims to 0.3 alpha (Q3 → C). */
const PASS_WINDOW_HALF_MINUTES = 45;

/** Fallback distance threshold (km) used when no profile is present or
 *  the profile is corrupted. Matches the existing ISS_HORIZON_KM used by
 *  the generator's scoring loop, so the v1 default behavior is unchanged
 *  for first-launchers. */
const DEFAULT_DISTANCE_THRESHOLD_KM = 1500;

/** Read the active profile's distanceThresholdKm from localStorage. Slot
 *  7 of design rev 2 — the threshold is per-profile, settable from the
 *  Profile tab slider, and filters out long-range passes from the queue,
 *  upcoming list, and map.
 *
 *  We re-read every refresh (cheap; localStorage reads are sync + O(1))
 *  so cross-tab + in-tab edits flow through without a separate state
 *  cache. Returns the fallback when:
 *    - no profile exists yet (first launch)
 *    - loadProfile throws (corrupted localStorage; safer to render than
 *      crash the map)
 *    - the profile's distanceThresholdKm is not a finite number (data
 *      corruption / mid-migration state)
 */
function readActiveDistanceThresholdKm(): number {
  try {
    const name = parseProfileFromURL(window.location.href);
    const profile = loadProfile(name);
    const v = profile?.distanceThresholdKm;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  } catch {
    /* fallthrough to default */
  }
  return DEFAULT_DISTANCE_THRESHOLD_KM;
}

/** Apply the distance threshold filter to a passes array. Exported for
 *  the queue/upcoming list builders in main.ts so the entire view stays
 *  consistent (same passes in the queue + upcoming + map). Pure function
 *  — no I/O, takes the threshold as an arg so callers can pass the value
 *  they just read. */
export function filterPassesByDistance(
  passes: PassEntry[],
  thresholdKm: number,
): PassEntry[] {
  if (!Number.isFinite(thresholdKm) || thresholdKm <= 0) return passes;
  return passes.filter((p) => {
    const d = p.nadir_distance_km;
    // Defensive: missing / non-finite distance means the generator
    // couldn't compute it. Don't filter those out — they'll still render
    // (and the operator will see the missing-distance state on the card).
    if (typeof d !== 'number' || !Number.isFinite(d)) return true;
    return d <= thresholdKm;
  });
}

/** Re-read the threshold + re-render the targets source. Called from
 *  the 'profile-changed' subscriber so map pins drop in/out as the
 *  operator drags the slider in the Profile tab. Also refreshes the
 *  my-targets ring layer so a target added in the Profile tab shows as a
 *  pin immediately (no wait for a daemon tick). Pure DOM effect — no
 *  network. Exported so main.ts can drive it too when needed. */
export function applyDistanceThreshold(): void {
  if (!map) return;
  refreshTargetsSource();
  refreshMyTargetsSource();
}

/** Threshold-changed subscriber bookkeeping. Bound once at the first
 *  renderMap call so a tab-switch round-trip doesn't accumulate
 *  listeners. Slot 11 wires this through the central event bus so the
 *  150ms debounce + cross-tab storage event story is automatic. */
let profileChangedBound = false;
function bindProfileChangedListener(): void {
  if (profileChangedBound) return;
  subscribeProfileChanged(() => {
    applyDistanceThreshold();
  });
  profileChangedBound = true;
}

/** VIIRS Black Marble night-lights overlay preference. Default OFF — this is
 *  a heavy, niche layer (asks the operator to opt in). v2 (Chris feedback
 *  2026-05-27). Same persistence pattern as cloud + terminator. */
const NIGHT_LIGHTS_PREF_KEY = 'opd-map-night-lights-visible';
function readNightLightsVisible(): boolean {
  try {
    return localStorage.getItem(NIGHT_LIGHTS_PREF_KEY) === '1';
  } catch {
    return false;
  }
}
let nightLightsVisible: boolean = readNightLightsVisible();

/** Esri Reference labels overlay preference. Default ON — country / city
 *  labels are a near-universal-utility overlay (Chris feedback 2026-05-27);
 *  operators who don't want them can toggle off. */
const LABELS_PREF_KEY = 'opd-map-labels-visible';
function readLabelsVisible(): boolean {
  try {
    const v = localStorage.getItem(LABELS_PREF_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}
let labelsVisible: boolean = readLabelsVisible();

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

/** ASCENT trajectory overlay (v1.6.1.0). When ON and a PassEntry with
 *  launch.kind="ascent" and a non-empty trajectory exists, the layer
 *  draws the rocket's predicted ground track (T+0 → orbit insertion,
 *  ~9 min) as an altitude-colored polyline plus a pad pin. Default ON
 *  — when an ascent is actionable, you want to see it. */
const ASCENT_PREF_KEY = 'opd-map-ascent-visible';
function readAscentVisible(): boolean {
  try {
    const v = localStorage.getItem(ASCENT_PREF_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}
let ascentVisible: boolean = readAscentVisible();

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
  nightLightsVisible = false;
  labelsVisible = true;
  viewTimeMs = null;
  sliderBound = false;
  sliderLastAppliedMinutes = -1;
  currentTrack = null;
  lastImageryBadgeArgs = null;
  try { localStorage.removeItem(BEARING_PREF_KEY); } catch { /* noop */ }
  try { localStorage.removeItem(NIGHT_LIGHTS_PREF_KEY); } catch { /* noop */ }
  try { localStorage.removeItem(LABELS_PREF_KEY); } catch { /* noop */ }
  _resetViirsFallbackForTest();
}

/** GIBS true-color tile URL pattern. {date} is replaced per render. Daily layer
 *  — captures cloud cover visually (you can SEE clouds, not derive them).
 */
// gibsTrueColorUrl + yesterdayIso live in tile-precache.ts so main.ts can
// import them without pulling the heavy MapLibre bundle. Re-exported from
// here so this module's existing internal callers (buildStyle below) don't
// have to change.
import {
  GIBS_MAX_ZOOM,
  VIIRS_BLACK_MARBLE_MAX_ZOOM,
  gibsTrueColorUrl,
  yesterdayIso,
} from './tile-precache';
import { registerViirsAlphaProtocol, viirsAlphaUrl } from './viirs-alpha-protocol';

// Register the viirs-alpha:// MapLibre protocol once at module load. The
// handler luminance-keys VIIRS Black Marble tiles so dark areas become
// transparent (v3.5 — ends the opacity-tuning saga; see
// frontend/src/viirs-alpha-protocol.ts for the full why). Idempotent.
registerViirsAlphaProtocol(maplibregl);

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
      // VIIRS Black Marble annual night-lights composite (v2 — Chris
      // feedback 2026-05-27). Renders city lights on the night-side of the
      // terminator. Default visibility is 'none' — toggled on via the
      // toggle-night-lights button. The PNG product has transparent
      // day-side pixels so the basemap shows through cleanly.
      //
      // v2 hotfix (Anil same-day feedback after v1.6.16.0): GIBS only
      // publishes VIIRS_Black_Marble for two discrete dates — 2012-01-01
      // and 2016-01-01 — verified via live HTTP + GetCapabilities XML. The
      // prior `currentYear - 1` assumption (with a one-year fallback walk)
      // 404'd silently and killed the toggle. Hardcoding 2016-01-01 as the
      // canonical date. If GIBS itself goes down, the error handler logs
      // one console.warn (no toast, no walk-back — there's nowhere to
      // walk to).
      //
      // Follow-up if more recent imagery is needed: switch to the daily
      // VIIRS_SNPP_DayNightBand_ENCC layer (daily cadence; different
      // visual character — single-orbit composite instead of cloud-free
      // annual). DON'T implement here — separate feature, not a hotfix.
      'viirs-night-lights': {
        type: 'raster',
        tiles: [viirsAlphaUrl('2016-01-01')],
        tileSize: 256,
        maxzoom: VIIRS_BLACK_MARBLE_MAX_ZOOM,
        attribution:
          'Night lights: <a href="https://earthdata.nasa.gov">NASA GIBS VIIRS Black Marble</a>',
      },
      // Esri Reference labels overlay (v2 — Chris feedback 2026-05-27).
      // Country / state / city / road labels on a transparent background,
      // rendered ABOVE all other layers so labels remain legible regardless
      // of which basemap is active. No API key, attribution-clean.
      'esri-labels-reference': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          'Labels © <a href="https://www.esri.com">Esri</a> &mdash; Source: Esri, HERE, Garmin, FAO, NOAA, USGS, OpenStreetMap contributors',
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
      // Esri Reference labels layer is added later in renderMap (rather
      // than here) so it remains the TOPMOST layer above all later overlays
      // (terminator night-fill, ground track, ISS marker, targets, etc.).
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
 *  v1.5.3.0: return type widened from `[lat, lon][]` to `[t, lat, lon][]`
 *  so downstream illumination-state splitting has access to the sample
 *  time. Existing callers extract `[lat, lon]` at the line-feature
 *  build step.
 *
 *  Exported for unit testing.
 */
export function splitTrackByOrbit(
  trackPoints: [number, number, number][],
  periodSeconds: number = ISS_ORBIT_PERIOD_SECONDS,
): [number, number, number][][] {
  const buckets: [number, number, number][][] = [];
  for (const point of trackPoints) {
    const t = point[0];
    const idx = Math.floor(t / periodSeconds);
    if (!buckets[idx]) buckets[idx] = [];
    buckets[idx].push(point);
  }
  // Replace any holes (no samples for an orbit) with empty arrays to
  // keep indices stable when callers map across the array.
  for (let i = 0; i < buckets.length; i++) {
    if (!buckets[i]) buckets[i] = [];
  }
  return buckets;
}

/** Split a run of [t_seconds, lat, lon] samples into contiguous runs of
 *  the same ISS-illumination state (v1.5.3.0 — Chris ask). Each output
 *  segment carries its illumination value so the caller can build line
 *  features tagged with that property.
 *
 *  Why this matters: the iss-track layer's paint uses a data-driven
 *  `match` on `illumination` to color cyan for day passes, magenta for
 *  the "twilight" warning state (ISS sunlit + ground dark — bad for
 *  photos), and grey-blue for night passes. Splitting at the boundary
 *  produces clean color transitions instead of trying to interpolate.
 *
 *  Each segment includes a 1-sample OVERLAP with the next segment so
 *  the rendered lines visually connect at the boundary (otherwise a
 *  tiny gap shows up between segments of different colors).
 *
 *  Exported for unit testing.
 */
export function splitByIllumination(
  samples: [number, number, number][],
  trackStartMs: number,
): { illumination: IssIllumination; coords: [number, number][] }[] {
  if (samples.length === 0) return [];
  const out: { illumination: IssIllumination; coords: [number, number][] }[] = [];
  let cur: { illumination: IssIllumination; coords: [number, number][] } | null = null;
  for (const [t, lat, lon] of samples) {
    const when = new Date(trackStartMs + t * 1000);
    const illum = classifyIssIllumination(when, lat, lon);
    if (cur === null || cur.illumination !== illum) {
      // Boundary crossed (or first sample). Close current segment if it
      // has samples by also appending this boundary sample to it — the
      // 1-sample overlap stitches the visual at the color transition.
      if (cur && cur.coords.length > 0) {
        cur.coords.push([lat, lon]);
        out.push(cur);
      } else if (cur) {
        out.push(cur);
      }
      cur = { illumination: illum, coords: [[lat, lon]] };
    } else {
      cur.coords.push([lat, lon]);
    }
  }
  if (cur && cur.coords.length > 0) out.push(cur);
  return out;
}

/** Wrap line features for one orbit's samples with an `orbit_index`
 *  property AND an optional `illumination` property. Re-uses
 *  `buildLineFeatures` for antimeridian + world-copy handling, then
 *  stamps every feature with the orbit index + illumination so the
 *  layer paint expression can drive opacity per orbit (v1.5.0.0) AND
 *  color per ISS-illumination state (v1.5.3.0).
 */
function buildOrbitLineFeatures(
  samples: [number, number][],
  orbitIndex: number,
  illumination: IssIllumination = 'iss-day',
): GeoJSON.Feature[] {
  return buildLineFeatures(samples).map((f) => ({
    ...f,
    properties: {
      ...(f.properties ?? {}),
      orbit_index: orbitIndex,
      illumination,
    },
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
    // v1.5.3.0: track_start_ms anchors the illumination math. track_points
    // t_seconds are offsets from iss_polynomial.start (the generator
    // computes both from the same reference time).
    const trackStartMs = Date.parse(track.iss_polynomial.start);
    if (multiOrbitVisible) {
      const orbits = splitTrackByOrbit(track.track_points);
      const out: GeoJSON.Feature[] = [];
      for (let k = 0; k < orbits.length; k++) {
        const orbitSamples = orbits[k];
        if (!orbitSamples || orbitSamples.length < 2) continue;
        const illumSegments = splitByIllumination(orbitSamples, trackStartMs);
        for (const seg of illumSegments) {
          if (seg.coords.length < 2) continue;
          out.push(...buildOrbitLineFeatures(seg.coords, k, seg.illumination));
        }
      }
      return out;
    }
    // Single-orbit (legacy) view: only the first orbit's samples,
    // still illumination-aware.
    const firstOrbit = track.track_points.filter(([t]) => t < ISS_ORBIT_PERIOD_SECONDS);
    const illumSegments = splitByIllumination(firstOrbit, trackStartMs);
    const out: GeoJSON.Feature[] = [];
    for (const seg of illumSegments) {
      if (seg.coords.length < 2) continue;
      out.push(...buildOrbitLineFeatures(seg.coords, 0, seg.illumination));
    }
    return out;
  }
  // Polynomial fallback for older manifests without track_points.
  // No illumination split here — older manifests pre-date this feature;
  // legacy snapshots show cyan-only track. The Track type guarantees
  // iss_polynomial is present in this branch.
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
  // v1.5.4.0 (Chris feedback 2026-05-21): also tag the future-window
  // samples with their illumination state so the cyan/magenta/grey-blue
  // coloring persists when the operator scrubs T+45/T+90. Previously
  // future view returned plain LineString features → fell back to default
  // cyan at 0.85, losing the illumination signal.
  //
  // Sample tuples are [t_seconds_since_track_start, lat, lon] so
  // splitByIllumination can derive the wall-clock time at each sample
  // (matches the groundTrackFeatures Now-view path).
  const trackStartMs = Date.parse(track.iss_polynomial.start);
  const samples: [number, number, number][] = [];
  for (let t = centerMs - halfWindowMs; t <= centerMs + halfWindowMs; t += stepMs) {
    const pos = issPositionWithAltSGP4(track, t);
    if (!pos) continue;
    const tSec = (t - trackStartMs) / 1000;
    samples.push([tSec, pos.lat, pos.lon]);
  }
  const illumSegments = splitByIllumination(samples, trackStartMs);
  const out: GeoJSON.Feature[] = [];
  for (const seg of illumSegments) {
    if (seg.coords.length < 2) continue;
    out.push(...buildOrbitLineFeatures(seg.coords, 0, seg.illumination));
  }
  return out;
}

export async function renderMap(manifest: Manifest): Promise<void> {
  const container = document.getElementById('map');
  if (!container) return;

  // v1.6.7.0+ slot 5: per-profile passes variant fetch. Track stays
  // canonical (ISS orbit is profile-agnostic). Reads the active profile
  // from the URL on every renderMap call, matching the pattern Lane A
  // used for the distance threshold — keeps the map authoritative on
  // every render without coupling to main.ts's in-memory currentProfile.
  const profileName = parseProfileFromURL(window.location.href);
  const passes = await fetchArtifact<PassEntry[]>(manifest, 'passes', '', profileName);
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
        // v1.5.4.0 (Chris ask 2026-05-21): each orbit gets a slightly
        // different color hue layered on top of the illumination signal.
        // Hue family is determined by illumination state (cyan=day,
        // magenta=twilight, grey-blue=eclipse); per-orbit sub-shade
        // shifts the color so the operator can also tell orbits apart
        // visually (not just by opacity).
        //
        // Matrix is 3 illumination × 4 orbit_index = 12 cells. Default
        // (no illumination property) falls through to cyan day orbit-0
        // so legacy code paths still render correctly.
        'line-color': [
          'match',
          ['coalesce', ['get', 'illumination'], 'iss-day'],
          'iss-day', [
            'match', ['coalesce', ['get', 'orbit_index'], 0],
            0, '#5cd0ff',  // cyan
            1, '#5ce0c8',  // cyan-teal
            2, '#7cd99c',  // soft green
            3, '#a8d680',  // yellow-green
            '#5cd0ff',
          ],
          'iss-twilight', [
            'match', ['coalesce', ['get', 'orbit_index'], 0],
            0, '#d65cff',  // magenta
            1, '#d680e0',  // soft pink-magenta
            2, '#cc94c8',  // muted mauve
            3, '#bca0a8',  // dusty pink
            '#d65cff',
          ],
          'iss-eclipse', [
            'match', ['coalesce', ['get', 'orbit_index'], 0],
            0, '#7a8aa8',  // grey-blue
            1, '#7392ac',  // slightly cooler
            2, '#6c9aac',  // more teal
            3, '#65a0a0',  // dusty teal
            '#7a8aa8',
          ],
          '#5cd0ff',  // fallback
        ],
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

  // "My targets" ring layer (Jack feedback 2026-06-01) — every personal
  // target as a hollow white ring, independent of whether it has a pass.
  // Added BEFORE the score-dot layer so a personal target that DOES have a
  // pass renders its filled score-dot on top of its ring (reads as "yours,
  // and it has an upcoming pass").
  refreshMyTargetsSource();
  // Dark casing under the white ring so it doesn't wash out over bright
  // basemap regions (clouds, snow, desert, day-side). Mirrors how the
  // score-dot layer pairs every dot with a dark #0b0d12 stroke. Wider dark
  // stroke under a narrower white one reads as a haloed ring on any
  // luminance. Added first so it sits beneath the white ring.
  if (!map.getLayer('my-targets-casing')) {
    map.addLayer({
      id: 'my-targets-casing',
      type: 'circle',
      source: 'my-targets',
      paint: {
        'circle-radius': 9,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#0b0d12',
        'circle-stroke-width': 4,
        'circle-stroke-opacity': 0.7,
      },
    });
  }
  if (!map.getLayer('my-targets-layer')) {
    map.addLayer({
      id: 'my-targets-layer',
      type: 'circle',
      source: 'my-targets',
      paint: {
        'circle-radius': 9,
        'circle-color': 'rgba(0,0,0,0)',  // hollow — stroke-only ring
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-stroke-opacity': 0.95,
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
  // v2 (Chris feedback 2026-05-27): added a night-side polygon fill at 55%
  // opacity (was previously line-only, which was visually subtle vs GoISSWatch's
  // clean dark night-side). The fill goes UNDER the line (added first → bottom
  // of stack), and the line gains a 40px line-blur halo so the day/night
  // boundary is a soft gradient rather than a hard edge.
  refreshTerminatorSources();
  // v3.1 (Anil same-day feedback 2026-05-26): both addLayer calls below pass
  // `beforeId='iss-track-layer'` so MapLibre inserts these fill/raster layers
  // BELOW the cyan ISS ground-track polyline. v1.6.18.0 added them without a
  // beforeId, which stacked the 0.95-opacity Black Marble tile (and the
  // 0.30-opacity night-fill) ABOVE the track and made the polyline disappear
  // whenever the 🌃 toggle was on. The track must stay topmost over the
  // night/day raster + fill layers so the operator can always see where the
  // ISS is going.
  const beforeTrack = map.getLayer('iss-track-layer') ? 'iss-track-layer' : undefined;
  // v3.6 (Anil 2026-05-29): global dim for lights-only mode. When night-lights
  // is ON but terminator is OFF, this background fill darkens the whole map
  // so bright pinpoint lights pop. When terminator is ON, the existing
  // terminator-night-fill handles night-side dimming and this layer hides
  // (otherwise the day side would also be dimmed). Inserted first among the
  // night-related layers so it sits below terminator-night-fill + the raster.
  if (!map.getLayer('night-lights-global-dim-layer')) {
    map.addLayer({
      id: 'night-lights-global-dim-layer',
      type: 'background',
      layout: { visibility: 'none' },
      paint: {
        'background-color': '#000000',
        'background-opacity': 0.30,
      },
    }, beforeTrack);
  }
  if (!map.getLayer('terminator-night-fill-layer')) {
    map.addLayer({
      id: 'terminator-night-fill-layer',
      type: 'fill',
      source: 'terminator-night-fill',
      paint: {
        'fill-color': '#000000',
        // v2 hotfix (Anil same-day feedback after v1.6.16.0): opacity
        // bumped to 0.55 obscured the underlying basemap too aggressively.
        // Drop to 0.30 — still reads as "night side" at a glance, but
        // labels, coastlines, and city lights stay legible underneath.
        // Prior journey: 0.35 (initial) → 0.55 (v2 spec) → 0.30 (this fix).
        'fill-opacity': 0.30,
        'fill-antialias': true,
      },
    }, beforeTrack);
  }
  // VIIRS Black Marble night-lights overlay (v2 — Chris feedback 2026-05-27).
  // Added AFTER the night-side dim fill so city lights render on top of (not
  // under) the dimming, staying visible. Default visibility 'none' — operator
  // opts in via toggle-night-lights button.
  //
  // Opacity journey:
  //   v2 (1.6.16.0): 0.95 — assumed PNG had alpha so dark areas would be
  //     transparent. WRONG — verified via curl 2026-05-27 that the GIBS
  //     VIIRS_Black_Marble PNG is RGB with no alpha channel and a dark navy
  //     background (~rgb 4,5,15). At 0.95 the raster's background obscured
  //     the basemap, clouds, and the entire day side.
  //   v3.1 (1.6.19.0): added an opaque #0b0d12 day-mask polygon ABOVE the
  //     raster to hide lights on the sun side. Regressed: day side went
  //     fully black (mask hid basemap+clouds+raster) and clouds appeared
  //     "inactive" because the 0.95 raster on the night side left only ~5%
  //     cloud signal visible.
  //   v3.3 (1.6.21.0): drop the day-mask entirely and lower the raster to
  //     0.55. At 0.55 the raster's dark-navy background is dim enough that
  //     the basemap (Carto Dark or Esri imagery) and the GIBS cloud overlay
  //     show through everywhere, while city lights — which are much brighter
  //     than the background — remain clearly visible. Compromise between
  //     light legibility and seeing what's underneath.
  //   v3.4 (1.6.22.0): stale-comment cleanup; opacity unchanged at 0.55.
  //   v3.5 (this commit): added viirs-alpha protocol that luminance-keys the
  //     tile to transparent for dark background pixels. With the dark
  //     background gone, 0.95 opacity paints bright city lights cleanly
  //     without darkening basemap or clouds. Solves the saga that started
  //     in v2.
  if (!map.getLayer('viirs-night-lights-layer')) {
    map.addLayer({
      id: 'viirs-night-lights-layer',
      type: 'raster',
      source: 'viirs-night-lights',
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.95 },
    }, beforeTrack);
  }
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
        // v2 (Chris 2026-05-27): 40px line-blur softens the day/night
        // boundary — instead of a hard line between the satellite imagery
        // and the 55%-opacity night fill, the operator sees a gentle
        // gradient over ~40 device pixels. Pairs visually with the
        // terminatorNightPolygonFeatures fill below.
        'line-blur': 40,
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

  // ASCENT trajectory layer (v1.6.1.0). Polyline colored by altitude:
  // red near surface (early climb / max-Q), orange mid-climb,
  // cyan near orbital altitude (~200km). Plus a pad pin at T+0.
  refreshAscentTrajectorySource();
  if (!map.getLayer('ascent-trajectory-layer')) {
    map.addLayer({
      id: 'ascent-trajectory-layer',
      type: 'line',
      source: 'ascent-trajectory',
      paint: {
        'line-color': [
          'interpolate', ['linear'], ['get', 'alt_km'],
          0, '#ff4d4d',     // red: pre-Max-Q (0-10km)
          50, '#ffa64d',    // orange: through stratosphere
          120, '#ffe14d',   // yellow: stage sep regime
          200, '#5cd0ff',   // cyan: orbit insertion
        ],
        'line-width': 3,
        'line-opacity': 0.9,
      },
    });
  }
  if (!map.getLayer('ascent-pad-layer')) {
    map.addLayer({
      id: 'ascent-pad-layer',
      type: 'circle',
      source: 'ascent-pad',
      paint: {
        'circle-radius': 7,
        'circle-color': '#ff4d4d',
        'circle-stroke-color': '#0b0d12',
        'circle-stroke-width': 2,
        'circle-opacity': 0.95,
      },
    });
    map.on('click', 'ascent-pad-layer', (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      const coords = (f.geometry.coordinates as [number, number]).slice() as [number, number];
      const props = f.properties ?? {};
      const body = document.createElement('div');
      body.className = 'target-popup';
      const name = String(props.launch_name ?? 'Launch');
      const site = String(props.site_name ?? '');
      const t0 = String(props.t0 ?? '');
      body.textContent = '';
      const h = document.createElement('div');
      h.style.fontWeight = '600';
      h.textContent = `🚀 ${name}`;
      const s = document.createElement('div');
      s.textContent = site;
      const t = document.createElement('div');
      t.style.opacity = '0.75';
      t.textContent = `T-0: ${t0}`;
      body.appendChild(h);
      body.appendChild(s);
      body.appendChild(t);
      new maplibregl.Popup()
        .setLngLat(coords)
        .setDOMContent(body)
        .addTo(map!);
    });
    map.on('mouseenter', 'ascent-pad-layer', () => {
      if (map) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'ascent-pad-layer', () => {
      if (map) map.getCanvas().style.cursor = '';
    });
  }
  applyAscentVisibility();

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
    // Wall clock caught the pinned instant → return to live mode (T1).
    if (maybeSnapToLive()) return;
    // Live ISS marker updates every 1s ONLY in live mode. When the
    // operator has scrubbed, the marker is pinned at the absolute view
    // instant (Q2 → A) — no point recomputing every second since the
    // pinned time isn't moving.
    if (!isScrubbed()) {
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
    // (live mode only; when scrubbed, the terminator is pinned to the
    // absolute view instant and must NOT drift). ~10ms, cheap.
    if (!isScrubbed()) refreshTerminatorSources();
  }, 30_000);
  updateTimeStepLabels();

  // Esri Reference labels overlay (v2 — Chris feedback 2026-05-27). Added
  // at the END of renderMap so it remains TOPMOST above all later overlays
  // (terminator, ground track, ISS marker, targets, etc.). Default visibility
  // is governed by labelsVisible preference (default ON), applied below.
  if (!map.getLayer('esri-labels-reference-layer')) {
    map.addLayer({
      id: 'esri-labels-reference-layer',
      type: 'raster',
      source: 'esri-labels-reference',
      paint: { 'raster-opacity': 0.85 },
    });
  }

  bindTimeToggle();
  bindTimeSlider();
  bindBearingToggle();
  bindCloudToggle();
  bindTerminatorToggle();
  bindNightLightsToggle();
  bindLabelsToggle();
  bindAscentToggle();
  bindMultiOrbitToggle();
  bindFollowToggle();
  bindPinDrop();
  bindSatellitePicker();
  // Slot 7: re-filter the targets layer when the active profile's
  // distance threshold changes. Slot 11 refactors this to the debounced
  // event-bus subscriber.
  bindProfileChangedListener();
  // Restore persisted satellite selections (fire-and-forget; UI updates
  // as each fetch resolves). Also kick off the 60s track refresh tick.
  void restorePersistedSatellites();
  if (!_satTrackTickerStarted) {
    _satTrackTickerStarted = true;
    window.setInterval(() => {
      // Live mode only: while scrubbed the track window is pinned to the
      // view instant (4A) — rebuilding yields identical geometry.
      if (isScrubbed()) return;
      try { refreshSatelliteTracks(); } catch { /* noop */ }
    }, 60_000);
  }
  // Apply persisted cloud + terminator preferences on first map render.
  applyCloudsVisibility();
  applyTerminatorVisibility();
  applyNightLightsVisibility();
  applyLabelsVisibility();
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
  const nowMs = Date.now();
  return markerPositionAt(track, lookaheadMinutesNow(nowMs), nowMs);
}

/** Live ISS marker position for a given lookahead + wall-clock. Exported for
 *  unit testing.
 *
 *  SGP4-first (via liveIssNow) so the marker sits on the SAME curve as the
 *  ground-track polyline, which is raw SGP4 (generator sample_track_points).
 *  Until 2026-06-09 the lookahead-0 path used the polynomial fit
 *  (liveIssPosition) — up to ~1.1° / ~120 km off SGP4 truth INSIDE the window
 *  (see liveIssNow in iss.ts), and the error grows toward the 120-min window
 *  edge as the polynomial degrades. That put the marker visibly off the track
 *  line when zoomed in, worse the longer the app stayed open (Chris feedback
 *  2026-06-09). liveIssNow already handles future times natively, so the prior
 *  lookahead>0 SGP4 special-case folds away.
 *
 *  Falls back to the polynomial only for legacy manifests with no usable TLE,
 *  then clamps to the end of the polynomial window. */
export function markerPositionAt(
  track: Track,
  lookaheadMinutes: number,
  nowMs: number,
): { lat: number; lon: number } | null {
  const targetMs = nowMs + lookaheadMinutes * 60_000;
  const pos = liveIssNow(track, targetMs);
  if (pos) return pos;
  // No TLE AND past the polynomial window — clamp to the window's last point.
  const startMs = Date.parse(track.iss_polynomial.start);
  if (Number.isNaN(startMs)) return null;
  const endMs = startMs + track.iss_polynomial.duration_seconds * 1000;
  return liveIssPosition(track, Math.min(targetMs, endMs - 1000));
}

/** Re-render the map's dynamic layers when a newer manifest arrives mid-
 *  session. No-op until the map has been created (renderMap lazily builds it
 *  on the first Map-tab click).
 *
 *  Fixes the frozen-ground-track bug (Chris 2026-06-09): the 60s manifest
 *  poll (main.ts doRefresh) updated the Queue/cards but never re-rendered the
 *  map, so the ground-track polyline stayed pinned to the manifest from when
 *  the Map tab was first opened — the live marker kept moving while the track
 *  it should sit on never advanced to the next generator tick's data. Calling
 *  this on each newer manifest rebuilds the track + marker + targets from the
 *  fresh track.json. renderMap is idempotent on an existing map (it only
 *  animates the bearing on first init), so it won't fight the operator's
 *  current pan/zoom. */
export async function refreshMapForManifest(manifest: Manifest): Promise<void> {
  if (!map) return;
  await renderMap(manifest);
}

/** Rebuild the iss-track geojson source based on the current lookahead.
 *  At Now (lookahead=0) renders the standard 2-orbit polynomial track;
 *  at +N>0 renders just the ±45min window around (now + N min) via SGP4. */
function refreshGroundTrackSource(track: Track): void {
  if (!map) return;
  const nowMs = Date.now();
  const features = futureOrbitGroundTrackFeatures(track, lookaheadMinutesNow(nowMs), nowMs);
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
  const when = new Date(currentViewMs());
  upsertGeoJson(map, 'terminator-line', {
    type: 'FeatureCollection',
    features: terminatorFeatures(when),
  });
  upsertGeoJson(map, 'subsolar-point', {
    type: 'FeatureCollection',
    features: [subsolarFeature(when)],
  });
  // v2 (Chris 2026-05-27): night-side polygon fill paired with the line.
  // Same upsert pattern as the line — refreshed every 30s + on time-scrub.
  upsertGeoJson(map, 'terminator-night-fill', {
    type: 'FeatureCollection',
    features: terminatorNightPolygonFeatures(when),
  });
  // v3.3 (2026-05-27): the day-mask source + layer were removed. The mask
  // (terminator-day-mask-layer) was added in v3.1 to hide VIIRS night-lights
  // on the sun side, but its opaque #0b0d12 fill also hid the basemap and
  // clouds. v3.3 instead lowers the raster opacity to 0.55 so the basemap +
  // clouds show through everywhere, with lights still legible on the night
  // side. terminatorDayPolygonFeatures is no longer called from anywhere.
}

/** Build the ascent-trajectory geojson features from a pass list.
 *  Exported for unit testing — refreshAscentTrajectorySource is the
 *  side-effecting wrapper that calls this and pushes to the map sources.
 *
 *  For every PassEntry whose launch.kind === "ascent" and whose
 *  trajectory has ≥2 points, emits:
 *  - Line features split into consecutive segments, each carrying the
 *    midpoint altitude as `alt_km` so the paint expression colors per
 *    segment (red at surface → cyan at orbit insertion).
 *  - One pad-pin point feature at the first trajectory point.
 *
 *  Antimeridian + world-copy split inherited from buildLineFeatures.
 */
export function buildAscentFeatures(passes: PassEntry[]): {
  lines: GeoJSON.Feature[];
  pads: GeoJSON.Feature[];
} {
  const lines: GeoJSON.Feature[] = [];
  const pads: GeoJSON.Feature[] = [];
  for (const p of passes) {
    const traj = p.launch?.trajectory;
    if (!traj || traj.length < 2) continue;
    if (p.launch?.kind !== 'ascent') continue;
    for (let i = 0; i < traj.length - 1; i++) {
      const a = traj[i];
      const b = traj[i + 1];
      if (!a || !b) continue;
      const segMidAlt = (a.alt_km + b.alt_km) / 2;
      const segs = buildLineFeatures([
        [a.lat, a.lon],
        [b.lat, b.lon],
      ]);
      for (const s of segs) {
        s.properties = { alt_km: segMidAlt, launch_name: p.launch?.name ?? '' };
        lines.push(s);
      }
    }
    const pad = traj[0];
    if (!pad) continue;
    pads.push({
      type: 'Feature' as const,
      properties: {
        launch_name: p.launch?.name ?? '',
        site_name: p.launch?.site_name ?? '',
        t0: p.launch?.t0 ?? '',
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [pad.lon, pad.lat],
      },
    });
  }
  return { lines, pads };
}

/** Rebuild the ascent-trajectory geojson sources from currentPasses.
 *  Side-effecting wrapper around buildAscentFeatures — pushes the
 *  features to the map sources. */
function refreshAscentTrajectorySource(): void {
  if (!map) return;
  const { lines, pads } = buildAscentFeatures(currentPasses);
  upsertGeoJson(map, 'ascent-trajectory', {
    type: 'FeatureCollection',
    features: lines,
  });
  upsertGeoJson(map, 'ascent-pad', {
    type: 'FeatureCollection',
    features: pads,
  });
}

/** Show / hide the ascent-trajectory layers (polyline + pad pin). */
function applyAscentVisibility(): void {
  if (!map) return;
  const vis = ascentVisible ? 'visible' : 'none';
  try {
    if (map.getLayer('ascent-trajectory-layer')) {
      map.setLayoutProperty('ascent-trajectory-layer', 'visibility', vis);
    }
    if (map.getLayer('ascent-pad-layer')) {
      map.setLayoutProperty('ascent-pad-layer', 'visibility', vis);
    }
  } catch { /* layers not loaded yet */ }
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
    // v2: night-side fill toggles with the same control as line + dot.
    if (map.getLayer('terminator-night-fill-layer')) {
      map.setLayoutProperty('terminator-night-fill-layer', 'visibility', vis);
    }
  } catch { /* layers not loaded yet */ }
  // v3.6: when terminator state changes, the global-dim layer may also need
  // to toggle (it's visible only when lights ON + terminator OFF).
  applyGlobalDimVisibility();
}

/** Show / hide the global dim layer (v3.6 — 2026-05-29). Visible only when
 *  night-lights is on AND the terminator is off — restores the "night world"
 *  feel when lights are toggled alone, without dimming the day side when
 *  the terminator overlay is active (the existing terminator-night-fill
 *  handles night-side dimming in that case). Idempotent. */
function applyGlobalDimVisibility(): void {
  if (!map) return;
  const dimVisible = nightLightsVisible && !terminatorVisible;
  const vis = dimVisible ? 'visible' : 'none';
  try {
    if (map.getLayer('night-lights-global-dim-layer')) {
      map.setLayoutProperty('night-lights-global-dim-layer', 'visibility', vis);
    }
  } catch { /* layer not loaded yet */ }
}

/** Rebuild the targets geojson source. Each feature carries `in_window`
 *  derived from its closest_approach vs the current view time. The
 *  data-driven opacity expression on the targets-layer paint reads this
 *  property — full opacity for in-window passes, dimmed for the rest.
 *
 *  Slot 7: distance-threshold filter excludes passes whose
 *  nadir_distance_km exceeds the active profile's threshold. Re-reads
 *  the threshold on every refresh so 'profile-changed' subscribers can
 *  call this without staging a separate threshold cache. */
function refreshTargetsSource(): void {
  if (!map) return;
  const viewMs = currentViewMs();
  const halfWindowMs = PASS_WINDOW_HALF_MINUTES * 60_000;
  const thresholdKm = readActiveDistanceThresholdKm();
  const distanceVisible = filterPassesByDistance(currentPasses, thresholdKm);
  // Honor the global "All / Mine" filter: 'mine' drops curated score-dots so
  // the map matches the Queue/Upcoming view. The always-on my-targets ring
  // layer still shows every personal target regardless of this filter.
  const visible = applyTargetFilter(distanceVisible, getTargetFilter());
  const features = visible.map((p) => {
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

/** Rebuild the "my targets" pin source from the active profile's personal
 *  targets (localStorage), independent of passes. The score-dot layer only
 *  plots targets that have a computed pass, so a freshly-added target — or
 *  one with no pass in the next 36h — was invisible (Jack feedback
 *  2026-06-01: "nice to see my targets visually too"). This always-on ring
 *  layer fixes that: every personal target gets a pin the moment it's saved
 *  locally, even before the next daemon tick produces passes for it. */
function refreshMyTargetsSource(): void {
  if (!map) return;
  let additions: PersonalTarget[] = [];
  try {
    const profile = loadProfile(parseProfileFromURL(window.location.href));
    // migrate() blind-casts a current-version profile, so a corrupted
    // localStorage with a non-array `additions` would slip through and make
    // `.filter` below throw — breaking the whole Map tab. Guard explicitly.
    additions = Array.isArray(profile?.additions) ? profile!.additions : [];
  } catch {
    additions = [];  // corrupted localStorage — render the map without pins
  }
  const features = additions
    .filter((t) =>
      Number.isFinite(t.lat) && Number.isFinite(t.lon)
      && Math.abs(t.lat) <= 90 && Math.abs(t.lon) <= 180)
    .map((t) => ({
      type: 'Feature' as const,
      properties: { target_id: t.id, target_name: t.name },
      geometry: { type: 'Point' as const, coordinates: [t.lon, t.lat] },
    }));
  upsertGeoJson(map, 'my-targets', { type: 'FeatureCollection', features });
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
  const heading = computeIssHeading(currentTrack, currentViewMs());
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
  // Whole-minute offset from live now to the view instant. The pinned
  // instant is absolute, so this shrinks as the wall clock advances —
  // the chips always answer "where would a click land me FROM HERE."
  const curMin = clampLookahead(lookaheadMinutesNow(nowMs));
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
      targetMinutes = clampLookahead(curMin + step);
    }
    const targetMs = nowMs + targetMinutes * 60_000;
    chip.textContent = formatUtcHm(targetMs);
    // Disabled-look when the button would be a no-op (already at floor/ceiling).
    const wouldBeNoop = (id !== 'time-now') &&
      clampLookahead(curMin + step) === curMin;
    btn.classList.toggle('time-step-noop', wouldBeNoop);
  }
  // Slider thumb + readout ride the same refresh so the controls can
  // never disagree about the view time.
  syncTimeSliderControls(nowMs, curMin);
}

/** Move the map's view time to now + newMinutes (clamped 0..36h) and refresh
 *  every view-time consumer: ground track, target pins, terminator, ISS
 *  marker, and the time-control labels.
 *
 *  Module-level + exported (5A, 2026-06-10 — was a closure inside
 *  bindTimeToggle): the stepper buttons, the continuous slider, and unit
 *  tests all drive this one function, so the controls can never disagree
 *  about what a time change refreshes.
 */
export function setLookahead(newMinutes: number, recenter: boolean): void {
  const clamped = clampLookahead(newMinutes);
  if (clamped === 0 && viewTimeMs === null) {
    // Clicking Now while already live is a no-op; same for clicking
    // back at floor. Skip the visual churn.
    updateTimeStepLabels();
    return;
  }
  // 0 = return to live mode; >0 = pin the view to an ABSOLUTE instant (T1).
  viewTimeMs = clamped === 0 ? null : Date.now() + clamped * 60_000;
  // One-clock surface (4A): satellite markers + track windows follow the
  // view time with everything else. Both no-op until the map exists; live
  // 1Hz ticking resumes via the tickSatelliteMarkers gate at Now.
  refreshSatelliteTracks();
  refreshSatelliteMarkers();
  // Cloud-honesty badge (T5): observed-not-forecast wording while scrubbed.
  refreshImageryDateBadgeForView();
  // Update active state — only the Now button has an "active" state
  // (it's the only one that represents a specific lookahead value);
  // the +/- step buttons are pure delta buttons that flash on click.
  document.querySelectorAll<HTMLButtonElement>('.time-step-btn').forEach((b) => {
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
}

let sliderBound = false;
// Last whole-minute value applied FROM the slider (or synced INTO it).
// Guards re-pinning the same offset against a newer wall clock, which
// would quietly reintroduce the relative-drift the absolute model kills.
let sliderLastAppliedMinutes = -1;

/** Wire the continuous time-slider (eng-review 1C — Chris 2026-06-09:
 *  "slide time forward/backward... lets you see an arbitrary time later in
 *  the day"). Augments the steppers: slider = reach, steppers = precise
 *  orbit-relative jumps. Exported for tests; `raf` injectable. */
export function bindTimeSlider(raf?: (cb: () => void) => unknown): void {
  if (sliderBound) return;
  const slider = document.getElementById('time-slider') as HTMLInputElement | null;
  if (!slider) return;
  // Bounds come from the clamp contract, not hand-kept HTML attributes.
  slider.min = '0';
  slider.max = String(LOOKAHEAD_MAX_MINUTES);
  const applyFromSlider = (recenter: boolean): void => {
    const minutes = Number(slider.value);
    if (!Number.isFinite(minutes)) return;
    // Value-unchanged no-op: re-applying the same minutes would pin the
    // SAME offset to a NEW now (T1). syncTimeSliderControls keeps this
    // tracker in lockstep when steppers / snap-to-live move the view.
    if (minutes === sliderLastAppliedMinutes && !recenter) return;
    setLookahead(minutes, recenter);
  };
  // Drag: rAF-coalesced full refresh; never recenter under the finger.
  slider.addEventListener('input', rafCoalesce(() => applyFromSlider(false), raf));
  // Release (or keyboard commit): one recenter ease onto the marker.
  slider.addEventListener('change', () => applyFromSlider(true));
  sliderBound = true;
}

/** Push the current view state into the slider + readout. Called from
 *  updateTimeStepLabels, so every pathway that changes or re-labels time
 *  (steppers, slider, snap-to-live, the 30s label tick) keeps the controls
 *  in lockstep. Programmatic .value writes don't fire 'input', so this
 *  never loops back into setLookahead. */
function syncTimeSliderControls(nowMs: number, curMin: number): void {
  const slider = document.getElementById('time-slider') as HTMLInputElement | null;
  if (!slider) return;
  slider.value = String(curMin);
  sliderLastAppliedMinutes = curMin;
  const scrubbed = isScrubbed();
  // T6b (eng-review 2026-06-10): deep scrubs compound TLE propagation
  // error. Inherit the existing >48h staleness threshold (Lane E banner):
  // flag the readout so the operator knows the projected geometry is
  // running on an old orbit solution.
  const tleStale = scrubbed && (currentTrack?.tle_age_hours ?? 0) > 48;
  const baseText = scrubbed
    ? formatViewTimeReadout(currentViewMs(nowMs), nowMs)
    : 'Now';
  const readoutText = tleStale ? `${baseText} · stale TLE` : baseText;
  slider.setAttribute('aria-valuetext', readoutText);
  const readout = document.getElementById('time-slider-readout');
  if (readout) {
    readout.textContent = readoutText;
    readout.classList.toggle('time-slider-scrubbed', scrubbed);
    readout.classList.toggle('time-slider-stale', tleStale);
    readout.title = tleStale
      ? 'TLE is over 48h old — projected positions degrade with both TLE age and scrub distance'
      : '';
  }
}

let toggleBound = false;
function bindTimeToggle(): void {
  if (toggleBound) return;
  const stepBtns = document.querySelectorAll<HTMLButtonElement>('.time-step-btn');
  if (stepBtns.length === 0) return;

  stepBtns.forEach((btn) => {
    const step = Number(btn.dataset.step);
    if (!Number.isFinite(step)) return;
    btn.addEventListener('click', () => {
      if (step === 0) {
        // Now: reset to live current orbit AND recenter on ISS.
        // v1.5.4.0 (Chris feedback 2026-05-21): the original v1.4.0.0
        // design passed recenter=false here to "not disrupt the operator's
        // pan." But the operator's mental model is "Now = back to current
        // ISS view," and the recenter button (🛰 / 📍 follow toggle) was
        // unreliable enough that Now had to fill that role. Flipping to
        // recenter=true matches the T+/T- behavior and the operator's
        // expectation.
        setLookahead(0, /*recenter=*/true);
      } else {
        setLookahead(lookaheadMinutesNow() + step, /*recenter=*/true);
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

/** Follow-ISS state (v1.5.2.0 — Chris feedback 2026-05-21). When true, the
 *  1Hz live-position tick re-centers the map on the ISS sub-point. NOT
 *  persisted — ephemeral by design (a session-local view mode, not a
 *  preference). Most map sessions start by surveying the broader orbit
 *  envelope, then narrowing to a target; persisting "follow" would force
 *  the operator to manually break it every page load.
 *
 *  User-initiated `dragstart` or `zoomstart` silently exits follow.
 *  Programmatic `setCenter` calls from applyFollowISS do NOT fire
 *  dragstart, so the recurring follow tick won't break itself.
 */
let followISS = false;

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

let ascentToggleBound = false;
function bindAscentToggle(): void {
  if (ascentToggleBound) return;
  const btn = document.getElementById('toggle-ascent');
  if (!btn) return;
  const reflect = () => {
    btn.classList.toggle('active', ascentVisible);
    btn.setAttribute('aria-pressed', ascentVisible ? 'true' : 'false');
    btn.title = ascentVisible
      ? 'ASCENT trajectory shown — click to hide'
      : 'ASCENT trajectory hidden — click to show';
  };
  reflect();
  btn.addEventListener('click', () => {
    ascentVisible = !ascentVisible;
    try { localStorage.setItem(ASCENT_PREF_KEY, ascentVisible ? '1' : '0'); } catch { /* noop */ }
    reflect();
    applyAscentVisibility();
  });
  ascentToggleBound = true;
}

/** Show / hide the VIIRS Black Marble night-lights overlay. Idempotent —
 *  safe to call before MapLibre has finished loading the layer. v2
 *  (Chris feedback 2026-05-27). */
function applyNightLightsVisibility(): void {
  if (!map) return;
  const vis = nightLightsVisible ? 'visible' : 'none';
  try {
    if (map.getLayer('viirs-night-lights-layer')) {
      map.setLayoutProperty('viirs-night-lights-layer', 'visibility', vis);
    }
  } catch { /* layer not loaded yet */ }
  // v3.6: night-lights flip may toggle the global-dim layer (active only
  // when lights ON + terminator OFF).
  applyGlobalDimVisibility();
}

/** Test-only: no-op stub kept for source compatibility with the prior
 *  year-fallback machinery (removed in the v2 hotfix). Other test files
 *  may still import this; keep the symbol so they don't break.
 *  TODO: remove once no test imports it. */
export function _resetViirsFallbackForTest(): void {
  // Year-fallback removed: GIBS publishes VIIRS_Black_Marble for only
  // 2012-01-01 + 2016-01-01. We hardcode 2016 — nothing to reset.
}

/** Arm a minimal error listener for the VIIRS night-lights source. With
 *  the year-fallback gone (v2 hotfix — 2016-01-01 is hardcoded), there's
 *  no walk-back logic; if the canonical date fails it means GIBS itself
 *  is down. Log once per session and hide the layer so the operator can
 *  re-toggle later. */
let nightLightsErrorLogged = false;
function armNightLightsErrorHandler(): void {
  if (!map) return;
  map.on('error', (e) => {
    const sourceId = (e as { sourceId?: string }).sourceId;
    if (sourceId !== 'viirs-night-lights') return;
    if (nightLightsErrorLogged) return;
    nightLightsErrorLogged = true;
    console.warn(
      '[map] VIIRS Black Marble 2016-01-01 tiles failed to load; ' +
      'GIBS may be down. Hiding night-lights layer — operator can re-toggle.',
    );
    nightLightsVisible = false;
    try { localStorage.setItem(NIGHT_LIGHTS_PREF_KEY, '0'); } catch { /* noop */ }
    applyNightLightsVisibility();
    reflectNightLightsButton();
  });
}

let nightLightsToggleBound = false;
function reflectNightLightsButton(): void {
  const btn = document.getElementById('toggle-night-lights');
  if (!btn) return;
  btn.classList.toggle('active', nightLightsVisible);
  btn.setAttribute('aria-pressed', nightLightsVisible ? 'true' : 'false');
  btn.title = nightLightsVisible
    ? 'VIIRS night lights shown — click to hide'
    : 'VIIRS night lights hidden — click to show (annual composite, slow first load)';
}
function bindNightLightsToggle(): void {
  if (nightLightsToggleBound) return;
  const btn = document.getElementById('toggle-night-lights');
  if (!btn) return;
  // Arm the error listener once — if the 2016 canonical date 404s we log
  // a single warning and hide the layer (no walk-back to attempt).
  armNightLightsErrorHandler();
  reflectNightLightsButton();
  btn.addEventListener('click', () => {
    // Allow re-arming the warn-once gate on explicit re-toggle — maybe
    // GIBS is back up after a transient outage.
    if (nightLightsErrorLogged) {
      nightLightsErrorLogged = false;
      if (map) {
        const src = map.getSource('viirs-night-lights') as maplibregl.RasterTileSource | undefined;
        if (src && 'setTiles' in src) {
          src.setTiles([viirsAlphaUrl('2016-01-01')]);
        }
      }
    }
    nightLightsVisible = !nightLightsVisible;
    try { localStorage.setItem(NIGHT_LIGHTS_PREF_KEY, nightLightsVisible ? '1' : '0'); } catch { /* noop */ }
    reflectNightLightsButton();
    applyNightLightsVisibility();
  });
  nightLightsToggleBound = true;
}

/** Show / hide the Esri Reference labels overlay. v2 (Chris feedback
 *  2026-05-27). Default ON. Idempotent. */
function applyLabelsVisibility(): void {
  if (!map) return;
  const vis = labelsVisible ? 'visible' : 'none';
  try {
    if (map.getLayer('esri-labels-reference-layer')) {
      map.setLayoutProperty('esri-labels-reference-layer', 'visibility', vis);
    }
  } catch { /* layer not loaded yet */ }
}

let labelsToggleBound = false;
function bindLabelsToggle(): void {
  if (labelsToggleBound) return;
  const btn = document.getElementById('toggle-labels');
  if (!btn) return;
  const reflect = () => {
    btn.classList.toggle('active', labelsVisible);
    btn.setAttribute('aria-pressed', labelsVisible ? 'true' : 'false');
    btn.title = labelsVisible
      ? 'Country/city labels shown — click to hide'
      : 'Country/city labels hidden — click to show';
  };
  reflect();
  btn.addEventListener('click', () => {
    labelsVisible = !labelsVisible;
    try { localStorage.setItem(LABELS_PREF_KEY, labelsVisible ? '1' : '0'); } catch { /* noop */ }
    reflect();
    applyLabelsVisibility();
  });
  labelsToggleBound = true;
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

/** Apply the follow-ISS pan if active. Called from main.ts's 1Hz live-
 *  position tick (`updateIssNow`). No-op when follow is off or the map
 *  isn't ready yet. Uses `setCenter` (instant) not `easeTo` (animated)
 *  per A5 from /plan-eng-review 2026-05-21: 1Hz easeTo calls queue
 *  animations and jitter. setCenter for recurring; easeTo only on the
 *  one-shot toggle click below.
 */
export function applyFollowISS(pos: { lat: number; lon: number }): void {
  // Gate while scrubbed (4A, Codex finding verified at main.ts:837): the
  // 1Hz caller passes the LIVE ISS position; recentering on it while the
  // marker shows a future instant makes the camera chase a position that
  // isn't on screen. Follow resumes when the view returns to live.
  if (!followISS || !map || isScrubbed()) return;
  map.setCenter([pos.lon, pos.lat]);
}

/** Exit follow silently. Called by user dragstart/zoomstart handlers and
 *  reflected to the button without firing applyFollowISS again. */
function exitFollowISS(): void {
  if (!followISS) return;
  followISS = false;
  reflectFollowButton();
}

function reflectFollowButton(): void {
  const btn = document.getElementById('toggle-follow-iss');
  if (!btn) return;
  btn.classList.toggle('active', followISS);
  btn.setAttribute('aria-pressed', followISS ? 'true' : 'false');
  btn.title = followISS
    ? 'Following ISS — click again or pan/zoom to release'
    : 'Recenter on ISS — click again or pan to release';
}

let followToggleBound = false;
function bindFollowToggle(): void {
  if (followToggleBound) return;
  const btn = document.getElementById('toggle-follow-iss');
  if (!btn) return;
  // v1.5.3.1: removed the `!map` guard that prevented click binding when
  // map happened to be null at bind time. Chris reported 2026-05-21 that
  // the button didn't highlight on click — the guard was attaching no
  // event listener, leaving the button dead. The click handler does its
  // own map-presence check internally; only the dragstart/zoomstart
  // listeners genuinely require map (and they're attached defensively
  // below).
  reflectFollowButton();
  btn.addEventListener('click', () => {
    if (followISS) {
      // Already following → exit follow.
      followISS = false;
      reflectFollowButton();
      return;
    }
    // Entering follow. Fly to current ISS pos on first click (gives the
    // operator a visual cue that the map jumped to ISS). Subsequent
    // recurring updates go through applyFollowISS which uses setCenter
    // (instant) — see A5 in /plan-eng-review 2026-05-21.
    //
    // v2 hotfix (Anil same-day feedback after v1.6.16.0): switched from
    // easeTo({duration:500}) to flyTo({duration:800, essential:true}).
    // easeTo does a linear pan at the current zoom; at high zoom the
    // re-center looked frozen because MapLibre couldn't load tiles fast
    // enough across the long pan. flyTo zooms out, pans, zooms back in,
    // which handles any zoom level gracefully. essential:true bypasses
    // prefers-reduced-motion (the operator clicked the button — they
    // expect the camera to move).
    followISS = true;
    reflectFollowButton();
    if (!currentTrack) return;
    const pos = liveIssPositionSGP4(currentTrack, Date.now())
      ?? liveIssPosition(currentTrack, Date.now());
    if (pos && map) {
      map.flyTo({ center: [pos.lon, pos.lat], duration: 800, essential: true });
    }
  });
  if (map) {
    // User-initiated drag breaks follow. Programmatic setCenter (from
    // applyFollowISS) does NOT fire dragstart so this is safe.
    map.on('dragstart', () => { exitFollowISS(); });
    // User-initiated zoom also breaks follow — operator is zooming for
    // a reason that conflicts with auto-recenter. Programmatic
    // setCenter doesn't trigger zoomstart, so this is safe too.
    map.on('zoomstart', (e: unknown) => {
      // Only respect zoomstart that came from a real user event.
      const orig = (e as { originalEvent?: unknown } | undefined)?.originalEvent;
      if (orig) exitFollowISS();
    });
  }
  followToggleBound = true;
}

/** Test-only: reset follow state between vitest runs. */
export function _resetFollowStateForTest(): void {
  followISS = false;
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
// Last (container, manifest) the imagery badge rendered with, so the badge
// can re-render when the SCRUB state changes without renderMap re-running
// (T5 — the badge text depends on isScrubbed()).
let lastImageryBadgeArgs: { container: HTMLElement; manifest: Manifest } | null = null;

export function ensureImageryDateBadge(container: HTMLElement, manifest: Manifest): void {
  lastImageryBadgeArgs = { container, manifest };
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
  // T5 (eng-review 2026-06-10, Codex finding accepted): while scrubbed,
  // the cloud raster is STILL the observed composite — pins show forecast,
  // the background does not (until V4-P2 ships forecast frames). Say the
  // mismatch out loud instead of letting the operator plan against
  // yesterday's clouds believing they're tomorrow's (the trust mismatch
  // Chris reported 2026-05-20). V4-P2's "Forecast +Nh (GFS run)" text
  // lands in this same slot later.
  badge.textContent = isScrubbed()
    ? `Clouds: observed ${date} — not forecast`
    : `Imagery: ${date}`;
  badge.hidden = false;
}

/** Re-render the imagery badge for the current scrub state (called from
 *  setLookahead). No-op until renderMap has drawn the badge once. */
function refreshImageryDateBadgeForView(): void {
  if (lastImageryBadgeArgs) {
    ensureImageryDateBadge(lastImageryBadgeArgs.container, lastImageryBadgeArgs.manifest);
  }
}

// ---------------------------------------------------------------------------
// Pin-drop pass lookup (v1.5.6.0 — Pettit feedback #10)
// ---------------------------------------------------------------------------
//
// Operator long-presses (touch) or right-clicks (desktop) anywhere on the
// map. We drop a cyan pin at that lat/lon and surface a popup listing the
// next 5 upcoming ISS passes over that point. All client-side via SGP4 +
// the existing iss-sgp4 satrec cache.
//
// State: module-level so the pin survives renderMap re-runs (i.e., Map tab
// re-entry within the same page session). Cleared on full page reload.

let droppedPinPopup: maplibregl.Popup | null = null;
let pinDropBound = false;
// Long-press tracking for touch devices.
let longPressTimer: number | null = null;
let longPressStartXY: { x: number; y: number } | null = null;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_THRESHOLD_PX = 8;

function bindPinDrop(): void {
  if (pinDropBound || !map) return;

  // Desktop: right-click (contextmenu). Suppress the browser menu.
  map.on('contextmenu', (e) => {
    e.preventDefault();
    handlePinDrop(e.lngLat.lng, e.lngLat.lat);
  });

  // Touch: long-press. MapLibre's `touchstart` fires before MapLibre decides
  // it's a drag vs a tap; we start a 500ms timer and cancel it on touchmove
  // beyond an 8px threshold (treated as a pan).
  map.on('touchstart', (e) => {
    if (!e.originalEvent || e.originalEvent.touches.length !== 1) return;
    const touch = e.originalEvent.touches[0];
    if (!touch) return;
    longPressStartXY = { x: touch.clientX, y: touch.clientY };
    const lng = e.lngLat.lng;
    const lat = e.lngLat.lat;
    longPressTimer = window.setTimeout(() => {
      longPressTimer = null;
      handlePinDrop(lng, lat);
    }, LONG_PRESS_MS);
  });
  map.on('touchmove', (e) => {
    if (longPressTimer === null || !longPressStartXY) return;
    const touch = e.originalEvent.touches[0];
    if (!touch) return;
    const dx = touch.clientX - longPressStartXY.x;
    const dy = touch.clientY - longPressStartXY.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_THRESHOLD_PX) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });
  map.on('touchend', () => {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStartXY = null;
  });

  pinDropBound = true;
}

/** Drop a pin at (lng, lat), compute upcoming passes, show popup. */
function handlePinDrop(lng: number, lat: number): void {
  if (!map || !currentTrack) return;
  // Round to zoom-appropriate precision (A3 from /plan-eng-review).
  const rounded = roundForZoom(lat, lng, map.getZoom());
  const pinLat = rounded.lat;
  const pinLon = rounded.lon;

  // Single-pin model: replace previous source.
  const fc: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        lat: pinLat,
        lon: pinLon,
        precision: rounded.precision,
      },
      geometry: { type: 'Point', coordinates: [pinLon, pinLat] },
    }],
  };
  upsertGeoJson(map, 'dropped-pin', fc);

  // Add layer on first drop. Distinct cyan color + downward-triangle-with-dot
  // style differentiates from target pins (score-colored) and lookup pin
  // (magenta).
  if (!map.getLayer('dropped-pin-layer')) {
    map.addLayer({
      id: 'dropped-pin-layer',
      type: 'circle',
      source: 'dropped-pin',
      paint: {
        'circle-radius': 11,
        'circle-color': '#5cd0ff',
        'circle-stroke-color': '#0b0d12',
        'circle-stroke-width': 3,
        'circle-opacity': 1.0,
      },
    });
    map.on('click', 'dropped-pin-layer', () => {
      // Clicking the pin dismisses (matches the "active query" mental model).
      dismissDroppedPin();
    });
    map.on('mouseenter', 'dropped-pin-layer', () => {
      if (map) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'dropped-pin-layer', () => {
      if (map) map.getCanvas().style.cursor = '';
    });
  }

  // Compute the passes. Pure-frontend SGP4 walk — see pin-drop.ts.
  // v1.6.0.0: also compute passes for any selected non-ISS satellites
  // (Pettit #6 — multi-satellite). Each satellite gets its own section
  // in the popup; ISS is the default.
  const sectionsForPopup: { name: string; color: string; passes: UpcomingPass[] }[] = [
    {
      name: 'ISS',
      color: '#5cd0ff',
      passes: findUpcomingPasses(currentTrack, pinLat, pinLon, Date.now()),
    },
  ];
  for (const sat of getSelectedSatellitesForPasses()) {
    sectionsForPopup.push({
      name: sat.name,
      color: sat.color,
      passes: findUpcomingPasses(sat.track, pinLat, pinLon, Date.now()),
    });
  }

  // Build popup body via DOM (Q1: no innerHTML).
  const body = buildPinDropPopup(pinLat, pinLon, rounded.precision, sectionsForPopup);

  // Replace any prior popup.
  if (droppedPinPopup) droppedPinPopup.remove();
  droppedPinPopup = new maplibregl.Popup({ maxWidth: '340px' })
    .setLngLat([pinLon, pinLat])
    .setDOMContent(body)
    .addTo(map);
}

/** Remove the dropped pin + popup. */
function dismissDroppedPin(): void {
  if (!map) return;
  if (droppedPinPopup) {
    droppedPinPopup.remove();
    droppedPinPopup = null;
  }
  upsertGeoJson(map, 'dropped-pin', { type: 'FeatureCollection', features: [] });
}

/** One satellite's passes for the pin-drop popup. v1.6.0.0 — Q2 from
 *  /plan-eng-review: builder is generic over multiple satellites, so
 *  the multi-satellite feature surfaces ISS + Tiangong + ... sections. */
export interface PinDropSection {
  name: string;
  color: string;
  passes: UpcomingPass[];
}

/** Build the pin-drop popup DOM. textContent throughout — no innerHTML.
 *  Multi-section: one section per selected satellite (ISS is always first).
 *  Exported for unit testing.
 *
 *  Per A2 from /plan-eng-review: popup body is `max-height: 60vh; overflow-y: auto`
 *  so it scrolls on mobile when many satellites × passes are listed. */
export function buildPinDropPopup(
  pinLat: number,
  pinLon: number,
  precision: number,
  sections: PinDropSection[],
): HTMLElement {
  const body = document.createElement('div');
  body.className = 'dropped-pin-popup';
  body.style.cssText = 'font:0.85rem/1.4 system-ui;color:#0b0d12;min-width:320px;max-height:60vh;overflow-y:auto';

  // Title: 📍 lat°N/S, lon°E/W
  const title = document.createElement('strong');
  const latStr = `${Math.abs(pinLat).toFixed(precision)}°${pinLat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(pinLon).toFixed(precision)}°${pinLon >= 0 ? 'E' : 'W'}`;
  title.textContent = `📍 ${latStr}, ${lonStr}`;
  body.appendChild(title);

  const nowMs = Date.now();
  let anyPasses = false;

  for (const section of sections) {
    if (section.passes.length === 0) continue;
    anyPasses = true;
    const heading = document.createElement('div');
    heading.style.cssText = `margin:8px 0 2px;color:${section.color};font-weight:600;font-size:0.82rem`;
    heading.textContent = `${section.name} — next ${section.passes.length} pass${section.passes.length === 1 ? '' : 'es'}`;
    body.appendChild(heading);

    const list = document.createElement('div');
    list.style.cssText = 'font:0.78rem/1.5 ui-monospace,Menlo,monospace;color:#0b0d12';
    for (const p of section.passes) {
      const row = document.createElement('div');
      // v1.6.1.2: 5 cols (was 4). Dropped UTC date portion (kept HH:MMZ
      // only — relative "+12m" already implies the day). Added shoot-from
      // column with "angle · window · direction" matching the card render.
      row.style.cssText = 'display:grid;grid-template-columns:55px 50px 55px 1fr 70px;gap:6px;padding:3px 0;border-bottom:1px solid #eee;align-items:baseline';
      const rel = document.createElement('span');
      rel.style.fontWeight = '600';
      rel.textContent = formatRelative(p.closestApproachMs - nowMs);
      const utc = document.createElement('span');
      utc.textContent = formatUtcClock(p.closestApproachMs);
      const nadir = document.createElement('span');
      nadir.style.textAlign = 'right';
      nadir.textContent = `${Math.round(p.nadirKm)} km`;
      const shoot = document.createElement('span');
      shoot.style.cssText = 'font-size:0.72rem;color:#444';
      shoot.textContent = formatShootHint(p);
      const regime = document.createElement('span');
      regime.style.textAlign = 'right';
      regime.style.color = regimeColor(p.regime);
      regime.textContent = regimeLabel(p.regime);
      row.append(rel, utc, nadir, shoot, regime);
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  if (!anyPasses) {
    const empty = document.createElement('div');
    empty.style.cssText = 'margin-top:8px;color:#444';
    empty.textContent = 'No passes from any tracked satellite within 1500 km in the next 36 hours.';
    body.appendChild(empty);
    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:6px;color:#888;font-size:0.78rem';
    hint.textContent = 'Most low-Earth-orbit satellites have inclinations 27-65°; points near the poles see few passes.';
    body.appendChild(hint);
  }

  const footer = document.createElement('div');
  footer.style.cssText = 'margin-top:6px;color:#888;font-size:0.72rem';
  footer.textContent = 'Closest-approach within 1500 km horizon. Click pin to dismiss.';
  body.appendChild(footer);

  return body;
}

function formatUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/** Clock-only UTC for the pin-drop popup. v1.6.1.2 dropped the date
 *  portion to free up a column for the angle/window/direction hint —
 *  the relative "+12m" / "+1d3h" already implies which day. */
export function formatUtcClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/** Format the "where do I point the camera" hint for one pass row.
 *  Returns "" if the pass has no window/bearing data (older builds).
 *  Format mirrors the card render: "35° right of track · WORF" (CEO convention,
 *  off-nadir = degrees right/left of track at closest). Exported for unit testing. */
export function formatShootHint(p: UpcomingPass): string {
  if (typeof p.angleOffNadirDeg !== 'number') return '';
  const deg = Math.round(p.angleOffNadirDeg);
  const win = p.angleOffNadirDeg < 30 ? 'WORF' : 'Cupola';
  if (typeof p.relativeBearingDeg !== 'number') {
    return `${deg}° · ${win}`;
  }
  return `${formatTrackOffset(p.angleOffNadirDeg, p.relativeBearingDeg)} · ${win}`;
}

function formatRelative(deltaMs: number): string {
  const totalMin = Math.round(deltaMs / 60000);
  if (totalMin < 60) return `+${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m === 0 ? `+${h}h` : `+${h}h${m}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `+${d}d` : `+${d}d${rh}h`;
}

function regimeLabel(r: import('./terminator').IssIllumination): string {
  if (r === 'iss-day') return 'day';
  if (r === 'iss-twilight') return 'twilight';
  return 'night';
}

function regimeColor(r: import('./terminator').IssIllumination): string {
  if (r === 'iss-day') return '#0a8acc';      // cyan-ish, photo-friendly
  if (r === 'iss-twilight') return '#a8389a';  // magenta — warning
  return '#5b6b8a';                            // grey-blue — night
}

// ---------------------------------------------------------------------------
// Multi-satellite tracking (v1.6.0.0 — Pettit feedback #6)
// ---------------------------------------------------------------------------
//
// Operator picks satellites to track beyond ISS via the 🛰 picker button.
// Each selected non-ISS satellite gets:
//  - Ground-track polyline (color per satellite, refreshed every 60s)
//  - Live marker at current sub-point (1Hz refresh — uses SGP4 propagator)
//  - Pin-drop popup section with next 5 passes over the pinned point
//
// All client-side. TLEs from CelesTrak (cached 6h in localStorage).
// Per /plan-eng-review 2026-05-22 P1: track polyline at 60s, markers at 1s.

/** Per-satellite state. ISS is the canonical existing path and is NOT
 *  represented here — selectedSatellites only holds non-ISS picks. */
interface SatelliteState {
  meta: SatelliteMeta;
  tle: TLEPair;
  matchCount: number;
  stale: boolean;
  marker: maplibregl.Marker | null;
}

const selectedSatellites = new Map<string, SatelliteState>();
let pickerOpen = false;
let satellitePickerBound = false;
let _satTrackTickerStarted = false;
const SATELLITE_SELECTION_KEY = 'opd-selected-satellites';

/** Synthetic Track for a non-ISS satellite. Wraps the TLE so the existing
 *  `findUpcomingPasses` (which expects a `Track`) and `liveIssPositionSGP4`
 *  callsites work without modification. */
function trackFromTLE(tle: TLEPair): Track {
  return {
    tle: { line1: tle.line1, line2: tle.line2 },
    tle_epoch: '', // SGP4 parses epoch from the TLE itself
    tle_age_hours: 0,
    tle_freshness_factor: 1,
    iss_polynomial: {
      start: new Date().toISOString(),
      duration_seconds: 0,
      lat_coeffs: [],
      lon_coeffs: [],
      polynomial_order: 0,
    },
  } as Track;
}

function readSelectedKeys(): string[] {
  try {
    const v = localStorage.getItem(SATELLITE_SELECTION_KEY);
    if (!v) return [];
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function persistSelectedKeys(): void {
  try {
    const keys = Array.from(selectedSatellites.keys());
    localStorage.setItem(SATELLITE_SELECTION_KEY, JSON.stringify(keys));
  } catch { /* noop */ }
}

/** Build the ground-track polyline samples for a non-ISS satellite over
 *  one full orbit (~95min default) at 30s cadence, starting at `viewMs`.
 *  Returns features ready for upsertGeoJson — already split at
 *  antimeridian + world-copy duplicated.
 *
 *  4A (eng-review 2026-06-10): the window starts at the map's VIEW time,
 *  not live now — when the operator scrubs to +6h, satellite tracks render
 *  where those satellites will be, on the same clock as the ISS track
 *  (the v1.7.12.0 marker-on-wrong-track bug class, applied forward).
 *  ISS_ORBIT_PERIOD_SECONDS stays the window length for every LEO bird —
 *  documented-acceptable approximation (HST/Tiangong are similar).
 *  Exported for unit tests; viewMs injectable. */
export function buildSatelliteTrackFeatures(
  tle: TLEPair,
  viewMs: number = currentViewMs(),
): GeoJSON.Feature[] {
  const track = trackFromTLE(tle);
  const stepSec = 30;
  const orbitSec = ISS_ORBIT_PERIOD_SECONDS; // close enough for LEO; HST/Tiangong are similar
  const samples: [number, number][] = [];
  for (let t = 0; t <= orbitSec; t += stepSec) {
    const pos = liveIssPositionSGP4(track, viewMs + t * 1000);
    if (!pos) continue;
    samples.push([pos.lat, pos.lon]);
  }
  return buildLineFeatures(samples);
}

function refreshSatelliteTracks(): void {
  if (!map) return;
  for (const [key, state] of selectedSatellites.entries()) {
    const sourceId = `sat-track-${key}`;
    const layerId = `sat-track-layer-${key}`;
    const features = buildSatelliteTrackFeatures(state.tle);
    upsertGeoJson(map, sourceId, { type: 'FeatureCollection', features });
    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': state.meta.track_color,
          'line-width': 1.6,
          'line-opacity': 0.7,
          'line-dasharray': [3, 2],
        },
      });
    }
  }
}

function refreshSatelliteMarkers(): void {
  if (!map) return;
  // One-clock surface (4A): markers render at the VIEW time — live now in
  // live mode, the pinned instant while scrubbed.
  const viewMs = currentViewMs();
  for (const state of selectedSatellites.values()) {
    const track = trackFromTLE(state.tle);
    const pos = liveIssPositionSGP4(track, viewMs);
    if (!pos) continue;
    if (!state.marker) {
      const el = document.createElement('div');
      el.className = 'sat-marker';
      el.style.background = state.meta.track_color;
      el.title = `${state.meta.icon} ${state.meta.name}`;
      state.marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([pos.lon, pos.lat])
        .addTo(map);
    } else {
      state.marker.setLngLat([pos.lon, pos.lat]);
    }
  }
}

function removeSatelliteVisuals(key: string): void {
  if (!map) return;
  const state = selectedSatellites.get(key);
  if (state?.marker) {
    state.marker.remove();
    state.marker = null;
  }
  const layerId = `sat-track-layer-${key}`;
  const sourceId = `sat-track-${key}`;
  try {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  } catch { /* noop */ }
}

async function addSatelliteByMeta(meta: SatelliteMeta): Promise<{ ok: boolean; message: string }> {
  const key = metaKey(meta);
  if (selectedSatellites.has(key)) {
    return { ok: true, message: 'Already tracking' };
  }
  const result = await fetchSatelliteTLE(meta);
  if (!result) {
    return {
      ok: false,
      message: meta.resolution.kind === 'name'
        ? `No satellite found for "${meta.resolution.query}"`
        : `Couldn't fetch TLE for NORAD ${meta.resolution.catnr}`,
    };
  }
  selectedSatellites.set(key, {
    meta,
    tle: result.tle,
    matchCount: result.match_count,
    stale: result.stale,
    marker: null,
  });
  refreshSatelliteTracks();
  refreshSatelliteMarkers();
  persistSelectedKeys();
  return { ok: true, message: 'Tracking added' };
}

function removeSatellite(key: string): void {
  if (!selectedSatellites.has(key)) return;
  removeSatelliteVisuals(key);
  selectedSatellites.delete(key);
  persistSelectedKeys();
}

/** Render the picker panel's curated satellite list. Called on open
 *  AND on every selection change so checkboxes + match-count labels stay
 *  in sync. */
function renderSatellitePickerList(): void {
  const list = document.getElementById('satellite-picker-list');
  if (!list) return;
  list.textContent = '';
  for (const meta of CURATED_SATELLITES) {
    if (metaKey(meta) === '25544') continue; // ISS is always-on; not in picker
    const key = metaKey(meta);
    const state = selectedSatellites.get(key);
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!state;
    cb.addEventListener('change', async () => {
      if (cb.checked) {
        const status = document.getElementById('satellite-picker-status');
        if (status) status.textContent = `Fetching ${meta.name}…`;
        const result = await addSatelliteByMeta(meta);
        if (status) {
          status.textContent = result.message;
          status.className = `satellite-picker-status ${result.ok ? 'success' : 'error'}`;
        }
        if (!result.ok) cb.checked = false;
        renderSatellitePickerList();
      } else {
        removeSatellite(key);
        renderSatellitePickerList();
      }
    });
    const icon = document.createElement('span');
    icon.className = 'sat-icon';
    icon.textContent = meta.icon;
    const nameSpan = document.createElement('span');
    nameSpan.textContent = meta.name;
    label.append(cb, icon, nameSpan);
    if (state) {
      if (state.stale) {
        const badge = document.createElement('span');
        badge.className = 'sat-stale';
        badge.textContent = 'stale TLE';
        label.appendChild(badge);
      } else if (state.matchCount > 1) {
        const badge = document.createElement('span');
        badge.className = 'sat-multi-match';
        badge.textContent = `1 of ${state.matchCount}`;
        label.appendChild(badge);
      }
    }
    list.appendChild(label);
  }
}

function bindSatellitePicker(): void {
  if (satellitePickerBound) return;
  const btn = document.getElementById('toggle-satellite-picker');
  const panel = document.getElementById('satellite-picker-panel');
  const input = document.getElementById('satellite-picker-input') as HTMLInputElement | null;
  const addBtn = document.getElementById('satellite-picker-add');
  const status = document.getElementById('satellite-picker-status');
  if (!btn || !panel || !input || !addBtn) return;

  const closePicker = () => {
    pickerOpen = false;
    panel.hidden = true;
    btn.classList.remove('active');
  };
  const openPicker = () => {
    pickerOpen = true;
    panel.hidden = false;
    btn.classList.add('active');
    renderSatellitePickerList();
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pickerOpen ? closePicker() : openPicker();
  });
  // Outside-click closes the panel.
  document.addEventListener('click', (e) => {
    if (!pickerOpen) return;
    const target = e.target as Node | null;
    if (target && (panel.contains(target) || btn.contains(target))) return;
    closePicker();
  });

  const handleAdd = async () => {
    const q = input.value.trim();
    if (!q) return;
    if (status) {
      status.textContent = 'Searching…';
      status.className = 'satellite-picker-status';
    }
    const isNumeric = /^\d+$/.test(q);
    const meta: SatelliteMeta = isNumeric
      ? {
        name: `NORAD ${q}`,
        short_label: q.slice(-3),
        track_color: '#888',
        icon: '🛰',
        resolution: { kind: 'catnr', catnr: Number(q) },
      }
      : {
        name: q.toUpperCase(),
        short_label: q.slice(0, 3).toUpperCase(),
        track_color: '#aaa',
        icon: '🔍',
        resolution: { kind: 'name', query: q.toUpperCase() },
      };
    const result = await addSatelliteByMeta(meta);
    if (status) {
      status.textContent = result.message;
      status.className = `satellite-picker-status ${result.ok ? 'success' : 'error'}`;
    }
    if (result.ok) {
      input.value = '';
      renderSatellitePickerList();
    }
  };
  addBtn.addEventListener('click', handleAdd);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdd();
  });

  satellitePickerBound = true;
}

/** Restore selected satellites from localStorage on map init. Best-effort:
 *  fetches each cached selection's TLE; failures are silent (operator
 *  can re-add). */
async function restorePersistedSatellites(): Promise<void> {
  const keys = readSelectedKeys();
  for (const key of keys) {
    // Find the SatelliteMeta — either a curated entry, a CATNR, or a name search.
    let meta: SatelliteMeta | null = null;
    for (const c of CURATED_SATELLITES) {
      if (metaKey(c) === key) {
        meta = c;
        break;
      }
    }
    if (!meta) {
      if (key.startsWith('name:')) {
        const q = key.slice(5);
        meta = {
          name: q,
          short_label: q.slice(0, 3),
          track_color: '#aaa',
          icon: '🔍',
          resolution: { kind: 'name', query: q },
        };
      } else if (/^\d+$/.test(key)) {
        const catnr = Number(key);
        meta = {
          name: `NORAD ${catnr}`,
          short_label: String(catnr).slice(-3),
          track_color: '#888',
          icon: '🛰',
          resolution: { kind: 'catnr', catnr },
        };
      }
    }
    if (meta) await addSatelliteByMeta(meta);
  }
}

/** Hook called from the existing 1Hz tick (main.ts updateIssNow) — drives
 *  non-ISS satellite markers in LIVE mode only. While scrubbed, markers are
 *  pinned at the view instant by setLookahead (4A — one clock for the whole
 *  map surface); ticking live positions over them would put two times on
 *  one map. Cheap: 1 SGP4 call per satellite × ~5 satellites max = ~0.5ms. */
export function tickSatelliteMarkers(): void {
  if (isScrubbed()) return;
  refreshSatelliteMarkers();
}

// tickSatelliteTracks was previously exported but is now only invoked
// internally via the 60s setInterval set up in renderMap (P1). No need
// for an external entrypoint.

/** Lookup currently-selected satellites for the pin-drop popup (Q2):
 *  the popup needs to iterate per satellite to compute passes. */
export function getSelectedSatellitesForPasses(): { name: string; color: string; track: Track }[] {
  const out: { name: string; color: string; track: Track }[] = [];
  for (const state of selectedSatellites.values()) {
    out.push({
      name: state.meta.name,
      color: state.meta.track_color,
      track: trackFromTLE(state.tle),
    });
  }
  return out;
}

/** Compact short-labels + sub-points for the topbar multi-sat row.
 *
 *  INTENTIONALLY live (Date.now()), not view-time: the topbar is the LIVE
 *  domain — its ISS readout also stays on the wall clock while the map is
 *  scrubbed. Only the map surface follows the scrub (4A, 2026-06-10).
 *  Returns "Tg 32.5°N, 118.3°E" style strings. */
export function getSatelliteTopbarReadouts(): { label: string; text: string; color: string }[] {
  const nowMs = Date.now();
  const out: { label: string; text: string; color: string }[] = [];
  for (const state of selectedSatellites.values()) {
    const track = trackFromTLE(state.tle);
    const pos = liveIssPositionSGP4(track, nowMs);
    if (!pos) continue;
    const ns = pos.lat >= 0 ? 'N' : 'S';
    const ew = pos.lon >= 0 ? 'E' : 'W';
    out.push({
      label: state.meta.short_label,
      text: `${Math.abs(pos.lat).toFixed(1)}°${ns}, ${Math.abs(pos.lon).toFixed(1)}°${ew}`,
      color: state.meta.track_color,
    });
  }
  return out;
}
