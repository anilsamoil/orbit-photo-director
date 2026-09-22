import type { Manifest, PassEntry, Track } from './types';
import { fetchArtifact } from './manifest';
import { wrapLon } from './geo';
import { createVendorMap } from './map/adapters/maplibre';
import { initialCamera } from './map/map-core/camera';
import { createClock } from './map/map-core/clock';
import { createMapCore, type MapCore } from './map/map-core/core';
import {
  attachBasemap,
  bindBasemapClock,
  ensureImageryDateBadge,
  refreshBasemap,
  refreshForecastCloudLayer,
  resetBasemapForTest,
  setBasemapManifest,
  setForecastSwapDeferred,
} from './map/features/basemap';
import { bindGroundTrackClock, refreshGroundTrack } from './map/features/ground-track';
import { refreshLabels, resetLabelsForTest } from './map/features/labels';
import {
  GLOBAL_DIM_LAYER,
  NIGHT_LIGHTS_LAYER,
  refreshNightLights,
  resetNightLightsForTest,
} from './map/features/night-lights';
import {
  SUBSOLAR_LAYER,
  TERMINATOR_FILL_LAYER,
  TERMINATOR_LINE_LAYER,
  bindTerminatorClock,
  refreshTerminator,
  refreshTerminatorGeometry,
} from './map/features/terminator';
import { FEATURES } from './map/features';
import { buildPassList } from './map/overlays/pass-list';
import { boundsOf, type Point } from './map/map-core/geometry';
import type { StyleSpec } from './map/map-core/layer-spec';
import type {
  Hit,
  MarkerHandle,
  PopupHandle,
  Unsubscribe,
  VendorMap,
} from './map/map-core/vendor-map';
import { DEFAULT_DISTANCE_THRESHOLD_KM, filterPassesByDistance } from './pass-filter';
import { liveIssNow, liveIssPosition } from './iss';
import { isTleStale } from './banner';
import { issPositionWithAltSGP4, liveIssPositionSGP4 } from './iss-sgp4';
import { formatTrackOffset } from './track-offset';
import { fetchLiveCloud } from './cloud';
import { getShotCount } from './shot-counts';
import { formatUtcHm } from './countdown';
import { greatCircleBearingDeg, findUpcomingPasses } from './pin-drop';
import { loadProfile, parseProfileFromURL, type PersonalTarget } from './profile';
import { applyTargetFilter, getTargetFilter } from './target-filter-pref';
import { subscribeProfileChanged } from './profile-events';
import { launchStore, type LaunchState } from './launch-store';
import { isLaunchPass, legacyLaunchInHorizon, selectLaunches } from './launch-selectors';
import { openLaunchDetails, renderLegacyLaunchCard } from './launch-card';
import { getMapLaunchMode, setMapLaunchMode, subscribeMapLaunchMode } from './map-launch-mode';

const clock = createClock();
bindBasemapClock(clock);
bindTerminatorClock(clock);
bindGroundTrackClock(clock);
let core: MapCore | null = null;
let issMarker: MarkerHandle | null = null;
let currentTrack: Track | null = null;
// Cached most-recently-fetched passes list — kept so when the operator
// hits a time-scrub button we can re-derive the target-pin opacity (and
// future-orbit ground track) without re-fetching the manifest.
let currentPasses: PassEntry[] = [];
let launchSubscriptionBound = false;

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

/** Minutes from live-now to the pinned view instant (0 when live).
 *  Fractional by design: the pinned instant doesn't move, so this offset
 *  shrinks as the wall clock advances toward it. */
function lookaheadMinutesNow(nowMs = clock.now()): number {
  const view = clock.viewTime();
  if (view.kind !== 'scrubbed') return 0;
  return Math.max(0, (view.atMs - nowMs) / 60_000);
}

/** True when the map is pinned to a future instant (scrub active). Gates
 *  follow-ISS recentering and live ticking; exported for tests. */
export function isScrubbed(): boolean {
  return clock.isScrubbed();
}

/** Snap back to live mode once the wall clock reaches the pinned instant
 *  (T1, 2026-06-10): a +N scrub eventually becomes "now"; returning to live
 *  beats rendering a frozen scene that slowly falls behind. Called from the
 *  1Hz live timer; returns true when a snap happened. Exported for unit
 *  tests (the timer itself needs a full map env). */
export function maybeSnapToLive(nowMs = clock.now()): boolean {
  const view = clock.viewTime();
  if (view.kind === 'scrubbed' && nowMs >= view.atMs) {
    setLookahead(0, /*recenter=*/false);
    // Follow × snap interleaving (red-team 2026-06-10): with follow-ISS
    // active, the next 1Hz tick would setCenter (instant) from the parked
    // future view to the live sub-point — a silent jump cut. Give the
    // operator one animated ease instead, mirroring the follow-entry cue.
    if (followISS && core && currentTrack) {
      const pos = markerPositionFor(currentTrack);
      if (pos) core.easeTo({ center: [pos.lon, pos.lat], duration: 600 });
    }
    return true;
  }
  return false;
}

/** Test-only: the pinned absolute view instant (null = live). */
export function _getViewTimeMsForTest(): number | null {
  const view = clock.viewTime();
  return view.kind === 'scrubbed' ? view.atMs : null;
}

/** Test-only: install a Track so track-dependent affordances (e.g. the
 *  stale-TLE readout hint) can be exercised without a full renderMap. */
export function _setCurrentTrackForTest(track: Track | null): void {
  currentTrack = track;
  core?.setTrack(track);
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

/** Re-read the threshold + re-render the targets source. Called from
 *  the 'profile-changed' subscriber so map pins drop in/out as the
 *  operator drags the slider in the Profile tab. Also refreshes the
 *  my-targets ring layer so a target added in the Profile tab shows as a
 *  pin immediately (no wait for a daemon tick). Pure DOM effect — no
 *  network. Exported so main.ts can drive it too when needed. */
export function applyDistanceThreshold(): void {
  if (!core) return;
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

/** Bearing mode for the map. 'north' = standard north-up. 'iss-up' = rotate
 *  the map so the ISS direction-of-travel points up — matches Chris's
 *  mental model in WORF: "I'm looking down, this is what's coming next."
 *  Persisted to localStorage so the operator's preference survives reload. */
export type BearingMode = 'north' | 'iss-up';
const BEARING_PREF_KEY = 'opd-map-bearing-mode';
export function readBearingMode(): BearingMode {
  try {
    const v = localStorage.getItem(BEARING_PREF_KEY);
    // Default to iss-up; only switch to north if explicitly stored.
    return v === 'north' ? 'north' : 'iss-up';
  } catch {
    return 'iss-up';  // localStorage unavailable (private mode, etc.)
  }
}
let bearingMode: BearingMode = readBearingMode();

/** Test-only: reset module-level state between vitest runs. */
export function _resetMapStateForTest(): void {
  mapLaunchModeUnsubscribe?.();
  mapLaunchModeUnsubscribe = null;
  core?.closePopup('target');
  core?.closePopup('launch');
  mapLaunchStyleUnsubscribe?.();
  mapLaunchStyleUnsubscribe = null;
  mapLaunchStyleCore = null;
  setMapLaunchMode(false);
  bearingMode = 'north';
  followISS = false;   // tests assume follow off; production default is ON
  clock.setViewTime({ kind: 'live' });
  sliderBound = false;
  sliderLastAppliedMinutes = -1;
  sliderDragging = false;
  toggleBound = false;
  currentTrack = null;
  core?.setTrack(null);
  resetBasemapForTest();
  resetLabelsForTest();
  resetNightLightsForTest();
  try { localStorage.removeItem(BEARING_PREF_KEY); } catch { /* noop */ }
  _resetScrubTierStateForTest();
}

/** GIBS true-color tile URL pattern. {date} is replaced per render. Daily layer
 *  — captures cloud cover visually (you can SEE clouds, not derive them).
 */
// gibsTrueColorUrl + yesterdayIso live in tile-precache.ts so main.ts can
// import them without pulling the heavy MapLibre bundle. Re-exported from
// here so this module's existing internal callers (buildStyle below) don't
// have to change.
import {
  GIBS_GEO_IR_MAX_ZOOM,
  GIBS_MAX_ZOOM,
  VIIRS_BLACK_MARBLE_MAX_ZOOM,
  geoIRTimeForNow,
  gibsGeoIRUrl,
  gibsTrueColorUrl,
  yesterdayIso,
} from './tile-precache';
import { registerViirsAlphaProtocol, viirsAlphaUrl } from './map/adapters/maplibre/viirs-alpha';

registerViirsAlphaProtocol();

export function buildStyle(): StyleSpec {
  const dateIso = yesterdayIso();
  return {
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
      // Live geostationary IR (Feature C, 2026-06-21). Opt-in "IR" toggle:
      // near-real-time (~10 min) Band-13 cloud-top imagery, day AND night.
      // Initial tiles use GOES-East; applyIrVisibility re-picks the satellite
      // covering the view on toggle/pan. The layer below ships visibility:'none'
      // → MapLibre fetches ZERO tiles until the operator turns it on.
      'geo-ir': {
        type: 'raster',
        tiles: [gibsGeoIRUrl('GOES-East_ABI_Band13_Clean_Infrared', geoIRTimeForNow())],
        tileSize: 256,
        maxzoom: GIBS_GEO_IR_MAX_ZOOM,
        attribution:
          'Live IR: <a href="https://earthdata.nasa.gov">NASA GIBS</a> (GOES/Himawari) + <a href="https://realearth.ssec.wisc.edu">SSEC RealEarth</a> (Meteosat)',
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
        // Live geostationary IR overlay (Feature C). Cloud-layer z-level (below
        // coastline / track / markers). Ships visibility:'none' → zero tiles
        // until toggled; mutually exclusive with the daily clouds layer. 0.82
        // opacity over the dark basemap reads as a thermal cloud picture (cold
        // tops bright); off-disk pixels are transparent so the basemap shows.
        id: 'geo-ir-layer',
        type: 'raster',
        source: 'geo-ir',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.82 },
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
  setBasemapManifest(manifest);

  const isFirstInit = !core;
  if (!core) {
    const vendor = createVendorMap({
      container,
      style: buildStyle(),
      camera: initialCamera(container.clientWidth || window.innerWidth),
    });
    core = createMapCore(vendor, clock);
    attachBasemap(core);
    await vendor.whenLoaded();
  }
  core.setTrack(track);

  // Imagery-date badge: tells the user how recent the cloud composite the
  // map's tiles are showing actually is. Especially load-bearing offline —
  // GIBS tiles cached past day-roll could otherwise read as today's clouds.
  ensureImageryDateBadge(container, manifest);

  // Stash for the time-scrub refresh path (v1.4.0.0). The buttons rebuild
  // the track + target sources from this cached list without re-fetching.
  currentPasses = passes;

  refreshGroundTrack(core);

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
  // luminance.
  core.ensureLayer({
    id: 'my-targets-casing',
    type: 'circle',
    source: 'my-targets',
    layout: { visibility: getMapLaunchMode() ? 'none' : 'visible' },
    paint: {
      'circle-radius': 9,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#0b0d12',
      'circle-stroke-width': 4,
      'circle-stroke-opacity': 0.7,
    },
  });
  core.ensureLayer({
    id: 'my-targets-layer',
    type: 'circle',
    source: 'my-targets',
    layout: { visibility: getMapLaunchMode() ? 'none' : 'visible' },
    paint: {
      'circle-radius': 9,
      'circle-color': 'rgba(0,0,0,0)',  // hollow — stroke-only ring
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
      'circle-stroke-opacity': 0.95,
    },
  });

  // Targets layer — features carry closest_approach_ms so the paint
  // expression can dim out-of-window passes per Q3 → C (filter+dim).
  refreshTargetsSource();
  if (!core.hasLayer('targets-layer')) {
    core.ensureLayer({
      id: 'targets-layer',
      type: 'circle',
      source: 'targets',
      layout: { visibility: getMapLaunchMode() ? 'none' : 'visible' },
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
        // is set in refreshTargetsSource() based on the view time.
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
    // Unified target tap (Jack 2026-06-23, review R1/R2/R10/R11): ONE general
    // click handler that hit-tests BOTH target layers, merge-dedups a personal-
    // target-that-also-has-a-pass (it lives in both sources under one id), picks
    // the pin nearest the tap when the bbox caught more than one, then derives
    // has_pass / is_personal from the union. Returns early when no target was
    // hit so the pad / lookup-pin / dropped-pin handlers still fire normally —
    // this fixes Jack's "works sometimes but not always" (the old single-layer
    // handler missed personal rings and lost ties).
    //
    // Uses setDOMContent + textContent (NOT setHTML) so a user-controlled target
    // name like "<img onerror=...>" from personal-targets.csv stays literal.
    core.on('click', (e) => {
      if (!core) return;
      const layers = (['targets-layer', 'my-targets-layer'] as const).filter((id) => core!.hasLayer(id));
      if (layers.length === 0) return;
      // ~7px bbox around the tap — fingertip-generous, yet tight enough that
      // "nearest" rarely needs to disambiguate (review R10/R16).
      const pad = 7;
      const bbox: [Point, Point] = [
        { x: e.point.x - pad, y: e.point.y - pad },
        { x: e.point.x + pad, y: e.point.y + pad },
      ];
      // Higher-priority interactive layers own their taps: if the tap also
      // landed on an ascent pad / lookup pin / dropped pin, defer to their own
      // layer-scoped handlers so we don't double-open a target popup over them
      // (Codex review). Their handlers still fire; we just bow out.
      const priorityLayers = (['ascent-pad-layer', 'lookup-pin-layer', 'dropped-pin-layer'] as const)
        .filter((id) => core!.hasLayer(id));
      if (priorityLayers.length > 0
        && core.queryAt(bbox, priorityLayers).length > 0) {
        return;
      }
      const feats = core.queryAt(bbox, layers);
      if (feats.length === 0) return; // not a target tap — let other handlers run
      const hit = pickTargetAtTap(
        feats,
        { x: e.point.x, y: e.point.y },
        (ll) => core!.project(ll),
      );
      if (!hit) return;
      const props = hit.props;

      // "Have I shot it yet" — read from the shared in-memory store the Profile
      // pane publishes (review R12: no /api/log fetch on tap). 0 / unknown →
      // the popup quietly omits the row (absence ≠ never shot).
      if (props.target_id) {
        const shot = getShotCount(props.target_id);
        if (shot > 0) props.shot_count = shot;
      }

      // INTENTIONALLY live (clock.now()): the popup's countdown answers "when is
      // this pass from NOW" alongside the absolute UTC time — same live-domain
      // rule as the topbar even while the map is scrubbed.
      let popup: PopupHandle | null = null;
      const onEdit = props.is_personal && props.target_id
        ? (id: string) => {
            popup?.remove();
            // Deep-link to the Profile-pane edit form (review R11). The pane
            // listener switches tabs + opens the form pre-filled for this id.
            window.dispatchEvent(new CustomEvent('opd-edit-target', { detail: { targetId: id } }));
          }
        : undefined;
      const popupBody = buildTargetPopupContent(props, clock.now(), onEdit, currentTrack);
      popup = core.openPopup({ at: hit.lngLat, content: popupBody, maxWidth: '360px', owner: 'target' });

      // Async live "now" cloud — patched onto the popup's single weather row
      // once it resolves. Guard on isConnected so a resolve after the popup
      // closed / was replaced is a no-op (review R7/R8). Offline → null → the
      // at-pass baseline stays (or the row collapses); it NEVER blocks the tap.
      const [lon, lat] = hit.lngLat;
      void fetchLiveCloud(lat, lon).then((pct) => {
        if (popupBody.isConnected) patchPopupWeather(popupBody, pct, props);
      });
    });
    // Pointer cursor over BOTH target layers (review R3 — the ring layer had none).
    for (const layerId of ['targets-layer', 'my-targets-layer'] as const) {
      core.onLayer('mouseenter', layerId, () => {
        if (core) core.setCursor('pointer');
      });
      core.onLayer('mouseleave', layerId, () => {
        if (core) core.setCursor('');
      });
    }
  }

  refreshTerminatorGeometry(core);
  core.ensureLayer(GLOBAL_DIM_LAYER);
  core.ensureLayer(TERMINATOR_FILL_LAYER);
  core.ensureLayer(NIGHT_LIGHTS_LAYER);
  core.ensureLayer(TERMINATOR_LINE_LAYER);
  core.ensureLayer(SUBSOLAR_LAYER);

  // Launch candidates share a gold marker/corridor identity. A corridor is
  // supplied only with trajectory provenance; legacy rows retain only a pad.
  refreshAscentTrajectorySource();
  core.ensureLayer({
    id: 'ascent-trajectory-layer',
    type: 'line',
    source: 'ascent-trajectory',
    layout: { visibility: getMapLaunchMode() ? 'visible' : 'none' },
    paint: {
      'line-color': '#ffd45c',
      'line-width': 3,
      'line-opacity': 0.9,
    },
  });
  if (!core.hasLayer('ascent-pad-layer')) {
    core.ensureLayer({
      id: 'ascent-pad-layer',
      type: 'circle',
      source: 'ascent-pad',
      layout: { visibility: getMapLaunchMode() ? 'visible' : 'none' },
      paint: {
        'circle-radius': 7,
        'circle-color': '#ffd45c',
        'circle-stroke-color': '#0b0d12',
        'circle-stroke-width': 2,
        'circle-opacity': 0.95,
      },
    });
    core.onLayer('click', 'ascent-pad-layer', (e) => {
      const f = e.features[0];
      if (!f || f.geometry.type !== 'Point') return;
      const coords = (f.geometry.coordinates as [number, number]).slice() as [number, number];
      const props = f.properties ?? {};
      if (props.event_id) {
        openLaunchDetails(String(props.event_id));
        return;
      }
      const pass = currentPasses.find((p) => p.target_id === props.target_id);
      if (!pass || launchStore.getState().artifact) return;
      const body = renderLegacyLaunchCard(pass, true);
      core!.openPopup({ at: coords, content: body, owner: 'launch' });
    });
    core.onLayer('mouseenter', 'ascent-pad-layer', () => {
      if (core) core.setCursor('pointer');
    });
    core.onLayer('mouseleave', 'ascent-pad-layer', () => {
      if (core) core.setCursor('');
    });
  }
  syncMapLaunchMode();
  if (!launchSubscriptionBound) {
    launchSubscriptionBound = true;
    launchStore.subscribe(() => {
      if (!core?.hasSource('ascent-pad')) return;
      refreshAscentTrajectorySource();
      refreshTargetsSource();
    });
  }

  // ISS marker: ISS-silhouette icon + pulsing halo. Replaces the prior
  // cyan dot which blended into the cloud overlay at world-zoom and was
  // hard to spot.
  if (!issMarker) {
    const initial = markerPositionFor(track) ?? { lat: 0, lon: 0 };
    const el = createIssMarkerElement();
    issMarker = core.addMarker(el, [initial.lon, initial.lat]);
  } else {
    // Reposition the EXISTING marker from the fresh track (red-team
    // 2026-06-10): a manifest refresh during a parked scrub rebuilds the
    // future-orbit polyline from the NEW track.json, but the 1Hz tick is
    // gated while scrubbed — without this, the marker strands on the OLD
    // orbit solution (the v1.7.12.0 marker-off-track class at the manifest
    // boundary). Live mode is idempotent (next 1s tick does the same).
    const pos = markerPositionFor(track);
    if (pos) issMarker.setLngLat([pos.lon, pos.lat]);
  }

  if (isFirstInit) {
    // Live ISS position update (every 1s while map is open).
    // While scrubbed, the marker is pinned at the absolute view instant and
    // updates only when the controls move it or new track data arrives.
    clock.every(1000, (nowMs) => {
      if (!core || !issMarker || !currentTrack) return;
      // Wall clock caught the pinned instant → return to live mode (T1).
      if (maybeSnapToLive(nowMs)) return;
      // Live ISS marker updates every 1s ONLY in live mode. When the
      // operator has scrubbed, the marker is pinned at the absolute view
      // instant (Q2 → A) — no point recomputing every second since the
      // pinned time isn't moving.
      if (!clock.isScrubbed()) {
        const pos = markerPositionFor(currentTrack, nowMs);
        if (pos) issMarker.setLngLat([pos.lon, pos.lat]);
      }
      if (bearingMode === 'iss-up') applyBearing(false);
    });

    // Refresh the UTC labels on the time-step buttons every 30s so the
    // displayed "click would take you to HH:MMZ" stays accurate without
    // a per-second redraw on the unattended Mac.
    clock.every(30_000, () => {
      updateTimeStepLabels();
    });
  }
  updateTimeStepLabels();

  refreshLabels(core);

  bindTimeToggle();
  bindTimeSlider();
  bindBearingToggle();
  bindFollowToggle();
  if (isFirstInit) for (const feature of FEATURES) feature.mount(core);
  // Slot 7: re-filter the targets layer when the active profile's
  // distance threshold changes. Slot 11 refactors this to the debounced
  // event-bus subscriber.
  bindProfileChangedListener();
  refreshBasemap();
  refreshTerminator(core);
  refreshNightLights(core);
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
function markerPositionFor(track: Track, nowMs = clock.now()): { lat: number; lon: number } | null {
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
  if (!core) return;
  await renderMap(manifest);
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
  const seen = new Set<string>();
  for (const p of passes) {
    if (!p.launch) continue;
    const key = `${p.launch.name}|${p.launch.t0}`;
    if (seen.has(key)) continue;
    const lat = p.launch.pad_lat ?? p.target_lat;
    const lon = p.launch.pad_lon ?? p.target_lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    seen.add(key);
    pads.push({
      type: 'Feature' as const,
      properties: {
        target_id: p.target_id,
        label: 'LAUNCH / MAP ONLY',
        launch_name: p.launch?.name ?? '',
        site_name: p.launch?.site_name ?? '',
        t0: p.launch?.t0 ?? '',
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [lon, lat],
      },
    });
  }
  return { lines, pads };
}

export function buildLaunchMapFeatures(state: LaunchState, now: number): { lines: GeoJSON.Feature[]; pads: GeoJSON.Feature[] } {
  const lines: GeoJSON.Feature[] = [];
  const pads: GeoJSON.Feature[] = [];
  for (const { item } of selectLaunches(state, now, 'map')) {
    const properties = { event_id: item.event_id, revision: item.revision, artifact_revision: state.artifact!.revision,
      label: `LAUNCH / ${item.status === 'map_only' ? 'MAP ONLY' : 'ASCENT'}`, launch_name: item.name };
    pads.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [item.site.lon, item.site.lat] } });
    const trajectory = item.trajectory;
    if (trajectory.quality === 'unknown' || !trajectory.source || trajectory.points.length < 2) continue;
    // Unwrap each supplied pair locally. Unlike the Earth-track helper's
    // sample splitting, this retains even a two-point dateline crossing.
    const segments: GeoJSON.Feature[] = [];
    for (let i = 1; i < trajectory.points.length; i++) {
      const a = trajectory.points[i - 1]!;
      const b = trajectory.points[i]!;
      const lon = a.lon + wrapLon(b.lon - a.lon);
      for (const offset of [-360, 0, 360]) {
        segments.push({ type: 'Feature', properties: {}, geometry: {
          type: 'LineString', coordinates: [[a.lon + offset, a.lat], [lon + offset, b.lat]],
        } });
      }
    }
    for (const segment of segments) segment.properties = { ...properties, quality: trajectory.quality };
    lines.push(...segments);
  }
  return { lines, pads };
}

/** Rebuild the ascent-trajectory geojson sources from currentPasses.
 *  Side-effecting wrapper around buildAscentFeatures — pushes the
 *  features to the map sources. */
function refreshAscentTrajectorySource(): void {
  if (!core) return;
  const state = launchStore.getState();
  const now = clock.now();
  const { lines, pads } = state.artifact ? buildLaunchMapFeatures(state, now)
    : buildAscentFeatures(currentPasses.filter((pass) => legacyLaunchInHorizon(pass, now, 7 * 24 * 3600_000)));
  core.setGeoJson('ascent-trajectory', {
    type: 'FeatureCollection',
    features: lines,
  });
  core.setGeoJson('ascent-pad', {
    type: 'FeatureCollection',
    features: pads,
  });
}

/** Launch mode replaces ordinary target pins; all other overlays keep their
 * current settings. Recheck recreated layers without changing map time. */
function applyMapLaunchVisibility(): void {
  if (!core) return;
  const enabled = getMapLaunchMode();
  try {
    for (const [layer, launch] of [
      ['ascent-trajectory-layer', true], ['ascent-pad-layer', true],
      ['targets-layer', false], ['my-targets-layer', false], ['my-targets-casing', false],
    ] as const) {
      const visibility = enabled === launch ? 'visible' : 'none';
      if (core.hasLayer(layer) && core.visibilityOf(layer) !== visibility) {
        core.setVisibility(layer, visibility);
      }
    }
  } catch { /* layers not loaded yet */ }
}

let mapLaunchModeUnsubscribe: (() => void) | null = null;
let mapLaunchStyleUnsubscribe: Unsubscribe | null = null;
let mapLaunchStyleCore: MapCore | null = null;

function syncMapLaunchMode(): void {
  if (!mapLaunchModeUnsubscribe) {
    mapLaunchModeUnsubscribe = subscribeMapLaunchMode((enabled) => {
      core?.closePopup(enabled ? 'target' : 'launch');
      if (!core) return;
      // Sources may predate this mode switch after an offline or profile
      // refresh. Rebuild only sources that the loaded style already owns.
      if (core.hasSource('ascent-pad')) refreshAscentTrajectorySource();
      if (core.hasSource('targets')) refreshTargetsSource();
      if (core.hasSource('my-targets')) refreshMyTargetsSource();
      applyMapLaunchVisibility();
    });
  }
  if (core && mapLaunchStyleCore !== core) {
    mapLaunchStyleUnsubscribe?.();
    mapLaunchStyleUnsubscribe = core.on('styledata', applyMapLaunchVisibility);
    mapLaunchStyleCore = core;
  }
  applyMapLaunchVisibility();
}

/** Test hook for actual startup/subscription behavior without WebGL. */
export { syncMapLaunchMode as _syncMapLaunchModeForTest };

/** Focus the current launch revision's site and supplied corridor. The ISS
 * marker keeps the time selected by the operator's existing map controls. */
export function focusLaunchOnMap(eventId: string): boolean {
  if (!core) return false;
  const selection = selectLaunches(launchStore.getState(), clock.now(), 'map')
    .find(({ item }) => item.event_id === eventId);
  if (!selection) return false;
  const { site, trajectory } = selection.item;
  exitFollowISS();
  setMapLaunchMode(true);
  applyMapLaunchVisibility();
  const points: [number, number][] = [[site.lon, site.lat]];
  if (trajectory.quality !== 'unknown' && trajectory.source && trajectory.points.length >= 2) {
    let longitude = site.lon;
    for (const point of trajectory.points) {
      longitude += wrapLon(point.lon - longitude);
      points.push([longitude, point.lat]);
    }
  }
  if (points.length === 1) core.easeTo({ center: points[0], zoom: 4, duration: 600 });
  else core.fitBounds(boundsOf(points), { padding: 50, maxZoom: 5, duration: 600 });
  return true;
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
  if (!core) return;
  const viewMs = clock.viewMs();
  const halfWindowMs = PASS_WINDOW_HALF_MINUTES * 60_000;
  const thresholdKm = readActiveDistanceThresholdKm();
  const distanceVisible = filterPassesByDistance(currentPasses.filter((p) => !isLaunchPass(p)), thresholdKm);
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
        // Tap-target popup (Jack 2026-06-23): lat/lon for live-cloud + edit,
        // off-nadir for the distance-from-track row, has_pass so the merged
        // popup knows this id has an upcoming pass.
        lat: p.target_lat,
        lon: p.target_lon,
        has_pass: true,
        angle_off_nadir_deg: p.angle_off_nadir_deg,
        iss_relative_bearing_deg: p.iss_relative_bearing_deg,
      },
      geometry: { type: 'Point' as const, coordinates: [p.target_lon, p.target_lat] },
    };
  });
  core.setGeoJson('targets', {
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
  if (!core) return;
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
      properties: {
        target_id: t.id, target_name: t.name,
        lat: t.lat, lon: t.lon, priority: t.priority,
        has_pass: false, is_personal: true,
      },
      geometry: { type: 'Point' as const, coordinates: [t.lon, t.lat] },
    }));
  core.setGeoJson('my-targets', { type: 'FeatureCollection', features });
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
  if (!core) return;
  const current = core.bearing();
  if (bearingMode === 'north') {
    if (Math.abs(current) < BEARING_NOOP_THRESHOLD_DEG) return;
    if (animate) core.easeTo({ bearing: 0, duration: 600 });
    else core.setBearing(0);
    return;
  }
  if (!currentTrack) return;
  const heading = computeIssHeading(currentTrack, clock.viewMs());
  if (heading === null) return;
  // Smallest angle between current and target, accounting for the 0=360 wrap.
  const delta = Math.abs(((heading - current + 540) % 360) - 180);
  if (delta < BEARING_NOOP_THRESHOLD_DEG) return;
  if (animate) core.easeTo({ bearing: heading, duration: 600 });
  else core.setBearing(heading);
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
  const nowMs = clock.now();
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

// ── Scrub-drag tiered refresh (7A) ──────────────────────────────────────
// Activated by Jack's iPad report (2026-06-11): "super stutters... jumps
// different amounts... sun or weather up makes the picture even more
// corrupted as the data can't keep up." Every coalesced drag frame was
// running two satellite SGP4 refreshes + full ground-track, targets, and
// terminator GeoJSON rebuilds + setData — far past the iPad frame budget.
// Tier 1 (every frame): view-time pin, ISS marker, readout — what the
// finger is steering. Tier 2: everything else, heard through the clock's
// view-time listeners — at once for a discrete change, coalesced through
// clock.settle while the slider drags.
let scrubTier2RunCount = 0; // test observability — counts REAL tier-2 runs

function runScrubTier2(): void {
  scrubTier2RunCount += 1;
  // Each refresher is isolated (adversarial F5, 2026-06-11): pre-throttle,
  // a throw here retried on the next 16ms frame; now the retry would be
  // the next user action, so one bad surface must not strand the rest
  // ~150ms in the past.
  const safely = (fn: () => void): void => {
    try { fn(); } catch { /* surface isolated — others still refresh */ }
  };
  const isLive = !clock.isScrubbed();
  document.querySelectorAll<HTMLButtonElement>('.time-step-btn').forEach((b) => {
    b.classList.toggle('active', b.id === 'time-now' && isLive);
  });
  if (currentTrack) safely(refreshTargetsSource);
}

clock.onViewTime(runScrubTier2);

/** Test-only: reset throttle state between vitest runs. */
export function _resetScrubTierStateForTest(): void {
  clock.settle.reset();
  scrubTier2RunCount = 0;
}

/** Test-only: how many times tier 2 actually ran. */
export function _getScrubTier2RunCountForTest(): number {
  return scrubTier2RunCount;
}

/** Test-only: whether a trailing tier-2 timer is currently armed. */
export function _isScrubTier2TimerArmedForTest(): boolean {
  return clock.settle.armed;
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
  if (clamped === 0 && !clock.isScrubbed()) {
    // Already live: skip the refresh churn — but HONOR a requested
    // recenter (Codex structured review P2, 2026-06-10): a slider drag
    // back to 0 lands here already-live (the rAF 'input' applied 0 before
    // the finger lifted), and the release's recenter must still bring the
    // camera home; otherwise the controls say Now while the camera stays
    // parked on the prior future view.
    if (recenter && core && issMarker && currentTrack) {
      const pos = markerPositionFor(currentTrack);
      if (pos) core.easeTo({ center: [pos.lon, pos.lat], duration: 600 });
    }
    updateTimeStepLabels();
    return;
  }
  // Same-instant no-op (pre-landing review 2026-06-10, 3-specialist
  // confirmed): a slider release / keyboard commit / ceiling-stepper click
  // that lands on the CURRENT whole-minute offset must not re-pin the
  // absolute instant against a newer now (that re-pin is exactly the
  // relative-drift class T1 killed) nor re-run the full refresh cascade
  // for a no-op time change. A requested recenter is still honored.
  if (clamped !== 0 && clock.isScrubbed()
      && clamped === clampLookahead(lookaheadMinutesNow())) {
    if (recenter && core && issMarker && currentTrack) {
      const pos = markerPositionFor(currentTrack);
      if (pos) core.easeTo({ center: [pos.lon, pos.lat], duration: 600 });
    }
    updateTimeStepLabels();
    return;
  }
  // 0 = return to live mode; >0 = pin the view to an ABSOLUTE instant (T1).
  // A drag frame is coalesced (7A): the view-time listeners ride
  // clock.settle and are flushed on release. The slider's own listeners
  // never pass recenter=true mid-drag ('input' passes false; 'change' fires
  // after pointerup) — but a second-finger STEPPER tap mid-drag does
  // (adversarial F2, 2026-06-11), and the ease plus an immediate full
  // refresh are exactly what that tap is asking for.
  clock.setViewTime(
    clamped === 0 ? { kind: 'live' } : { kind: 'scrubbed', atMs: clock.now() + clamped * 60_000 },
    sliderDragging && !recenter ? 'coalesced' : 'now',
  );
  // Move + freeze marker at the new view time.
  if (currentTrack && core && issMarker) {
    const pos = markerPositionFor(currentTrack);
    if (pos) {
      issMarker.setLngLat([pos.lon, pos.lat]);
      if (recenter) core.easeTo({ center: [pos.lon, pos.lat], duration: 600 });
    }
  }
  updateTimeStepLabels();
}

let sliderBound = false;
// Last whole-minute value applied FROM the slider (or synced INTO it).
// Guards re-pinning the same offset against a newer wall clock, which
// would quietly reintroduce the relative-drift the absolute model kills.
let sliderLastAppliedMinutes = -1;
// True while a pointer is actively manipulating the slider. The 30s label
// timer's sync would otherwise rewrite slider.value mid-drag, yanking the
// thumb out from under the finger (red-team 2026-06-10).
let sliderDragging = false;
/** Slider snap granularity (minutes). 1-minute steps (Chris 2026-06-14:
 *  finer time resolution) — the tiered drag refresh (7A) throttles the
 *  expensive surface work regardless of step count, so the finer grid adds
 *  no per-frame cost. Owned here with min/max — real browsers snap
 *  programmatic .value writes to the step grid, so the contract must live
 *  in code, not hand-kept HTML. */
const SLIDER_STEP_MINUTES = 1;

/** Wire the continuous time-slider (eng-review 1C — Chris 2026-06-09:
 *  "slide time forward/backward... lets you see an arbitrary time later in
 *  the day"). Augments the steppers: slider = reach, steppers = precise
 *  orbit-relative jumps. Exported for tests; `raf` injectable. */
export function bindTimeSlider(raf?: (cb: () => void) => unknown): void {
  if (sliderBound) return;
  const slider = document.getElementById('time-slider') as HTMLInputElement | null;
  if (!slider) return;
  // Bounds + step come from the clamp contract, not hand-kept HTML
  // attributes (real browsers snap programmatic .value to the step grid).
  slider.min = '0';
  slider.max = String(LOOKAHEAD_MAX_MINUTES);
  slider.step = String(SLIDER_STEP_MINUTES);
  const applyFromSlider = (recenter: boolean): void => {
    const minutes = Number(slider.value);
    if (!Number.isFinite(minutes)) return;
    // Value-unchanged no-op: re-applying the same minutes would pin the
    // SAME offset to a NEW now (T1). syncTimeSliderControls keeps this
    // tracker in lockstep when steppers / snap-to-live move the view.
    // (setLookahead's same-instant guard backstops the recenter=true path.)
    if (minutes === sliderLastAppliedMinutes && !recenter) return;
    setLookahead(minutes, recenter);
  };
  // Drag-in-progress tracking: suppresses the 30s timer's value sync.
  slider.addEventListener('pointerdown', () => {
    sliderDragging = true;
    setForecastSwapDeferred(true);
  });
  slider.addEventListener('pointerup', () => {
    sliderDragging = false;
    setForecastSwapDeferred(false);
    // Settle deferred tier-2 work first (terminator/pins/satellites/track),
    // then the frame swap deferred during the drag (the release's
    // same-instant guard can skip the full refresh path entirely).
    clock.settle.flush();
    refreshForecastCloudLayer();
  });
  slider.addEventListener('pointercancel', () => {
    sliderDragging = false;
    setForecastSwapDeferred(false);
    clock.settle.flush();
    refreshForecastCloudLayer();
  });
  // Belt-and-braces (Codex adversarial 2026-06-10): a drag that loses
  // pointer capture without a pointerup on the element (page blur, OS
  // gesture swallowing the release) must not leave the sync suppressed
  // forever. Bound once — sliderBound guards re-binding.
  window.addEventListener('blur', () => {
    sliderDragging = false;
    setForecastSwapDeferred(false);
    clock.settle.flush();
    // Mirror pointerup (adversarial F3): the leading tier-2 run during the
    // drag deferred its forecast frame swap (visibility-only while
    // dragging); without this, a blur-ended drag leaves the fcst raster on
    // the pre-drag frame while every other surface shows the final time.
    refreshForecastCloudLayer();
  });
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
  if (!sliderDragging) {
    slider.value = String(curMin);
    // Read BACK the value: real browsers snap range writes to the step
    // grid, so the guard tracker must record what the slider can actually
    // report, not what we asked for (red-team 2026-06-10; happy-dom does
    // not implement the snapping, so tests see them equal).
    sliderLastAppliedMinutes = Number(slider.value);
  }
  const scrubbed = clock.isScrubbed();
  // T6b (eng-review 2026-06-10): deep scrubs compound TLE propagation
  // error. isTleStale shares the banner's rounded-boundary semantics so
  // the topbar and the readout can never disagree at the threshold.
  //
  // Age is measured at the VIEW instant, not at manifest generation
  // (Codex adversarial 2026-06-10): a 24h-old TLE scrubbed +36h is a 60h
  // projection — the warning matters MOST at depth. Missing age (legacy
  // manifest) stays unflagged: unknown is not the same as stale.
  const ageAtView = typeof currentTrack?.tle_age_hours === 'number'
    ? currentTrack.tle_age_hours + lookaheadMinutesNow(nowMs) / 60
    : undefined;
  const tleStale = scrubbed && isTleStale(ageAtView);
  const baseText = scrubbed
    ? formatViewTimeReadout(clock.viewMs(nowMs), nowMs)
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
/** Wire the five stepper buttons. Exported for tests (pre-landing review
 *  2026-06-10): the click wiring is the one seam between the DOM and
 *  setLookahead that hand-computed offsets in tests cannot exercise. */
export function bindTimeToggle(): void {
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
let followISS = true;  // default ON — tracks ISS on every fresh load; user drag/button turns it off

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
  if (!followISS || !core || clock.isScrubbed()) return;
  core.setCenter([pos.lon, pos.lat]);
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
    // VIEW-time position, not live (red-team 2026-06-10): clicking Follow
    // while scrubbed must fly to the marker the operator can SEE (pinned
    // at the view instant), not to the live sub-point where nothing is
    // drawn. markerPositionFor honors the scrub and falls back through
    // SGP4 → polynomial exactly like every other marker consumer.
    const pos = markerPositionFor(currentTrack);
    if (pos && core) {
      core.flyTo({ center: [pos.lon, pos.lat], duration: 800 });
    }
  });
  if (core) {
    // User-initiated drag breaks follow. Programmatic setCenter (from
    // applyFollowISS) does NOT fire dragstart so this is safe.
    core.on('dragstart', () => { exitFollowISS(); });
    // User-initiated zoom also breaks follow — operator is zooming for
    // a reason that conflicts with auto-recenter. Programmatic
    // setCenter doesn't trigger zoomstart, so this is safe too.
    core.on('zoomstart', ({ byUser }) => {
      // Only respect zoomstart that came from a real user event.
      if (byUser) exitFollowISS();
    });
  }
  followToggleBound = true;
}

/** Test-only: reset follow state between vitest runs. */
export function _resetFollowStateForTest(): void {
  followISS = false;
}

/** Test-only: install a map-like object + follow flag so the camera-gating
 *  branches in applyFollowISS (follow off / no map / scrubbed — 4A) can be
 *  exercised against the REAL implementation without a live MapLibre map
 *  (happy-dom can't construct one). Pass null to restore the no-map state. */
export function _setFollowEnvForTest(
  m: { setCenter(c: [number, number]): void } | null,
  follow: boolean,
): MapCore | null {
  core = m ? createMapCore(m as unknown as VendorMap, clock) : null;
  followISS = follow;
  return core;
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

/** Force the map to recompute its canvas size. Call after the container becomes
 *  visible (e.g., after the user clicks the Map tab). MapLibre samples the
 *  container size at init; if it was display:none, the canvas is stuck at 0×0
 *  until a resize event fires.
 */
export function resizeMap(): void {
  if (core) core.resize();
}

/** Shape of MapLibre feature properties on a target pin. Mirrors the
 *  fields populated in refreshTargetsSource(); kept inline so the popup
 *  builder is self-contained and testable without importing PassEntry. */
export interface TargetPopupProps {
  target_id?: string;
  target_name?: string;
  score?: number;
  closest_approach?: string;
  cloud_fraction?: number;
  cloud_source?: string;
  pass_regime?: string;
  obstruction_class?: string;
  sample_time?: string | null;
  // Tap-target popup (Jack 2026-06-23). has_pass distinguishes the two shapes;
  // is_personal gates the Edit affordance; shot_count gates the "shot it" row
  // (rendered only when > 0); lat/lon feed live-cloud + edit deep-link;
  // off-nadir feeds the distance-from-track row (only valid when has_pass).
  lat?: number;
  lon?: number;
  priority?: number;
  has_pass?: boolean;
  is_personal?: boolean;
  shot_count?: number;
  angle_off_nadir_deg?: number;
  iss_relative_bearing_deg?: number;
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
  onEdit?: (targetId: string) => void,
  track: Track | null = null,
): HTMLElement {
  const body = document.createElement('div');
  body.className = 'map-target-popup';
  body.style.cssText = 'font:0.85rem/1.4 system-ui;color:#0b0d12;min-width:200px';

  // Local row helper — textContent ONLY (XSS-safe for names/station strings).
  const addRow = (cls: string, text: string, style: string): HTMLDivElement => {
    const r = document.createElement('div');
    r.className = cls;
    r.style.cssText = style;
    r.textContent = text;
    body.appendChild(r);
    return r;
  };

  const nameEl = document.createElement('strong');
  nameEl.textContent = props.target_name ?? 'unknown';
  body.appendChild(nameEl);

  const hasPass = props.has_pass === true;

  if (hasPass) {
    // Shape A — target with an upcoming pass (score 0 is a valid bad pass).
    addRow('map-popup-score', `score ${Math.round(props.score ?? 0)}`, 'font-weight:600;color:#0b0d12;margin-top:2px');
    if (props.closest_approach) {
      const passMs = Date.parse(props.closest_approach);
      if (Number.isFinite(passMs)) {
        const utc = props.closest_approach.replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, 'Z');
        const rel = formatRelativeMinutes(Math.round((passMs - nowMs) / 60_000));
        addRow('map-popup-row', `Pass: ${utc}${rel ? ` (${rel})` : ''}`, 'margin-top:6px;color:#444');
      }
    }
    // Distance from track — only when both angles are finite. A stationary
    // target has no off-nadir, so never call formatTrackOffset(undefined,…)
    // which would render "NaN° … of track" (review R7).
    if (Number.isFinite(props.angle_off_nadir_deg) && Number.isFinite(props.iss_relative_bearing_deg)) {
      addRow('map-popup-row', formatTrackOffset(props.angle_off_nadir_deg!, props.iss_relative_bearing_deg!), 'margin-top:2px;color:#444');
    }
    const regimeBits: string[] = [];
    if (props.pass_regime) regimeBits.push(props.pass_regime);
    if (props.obstruction_class) regimeBits.push(props.obstruction_class);
    if (regimeBits.length > 0) addRow('map-popup-row', regimeBits.join(' · '), 'margin-top:2px;color:#444');
  } else {
    // New account profiles may have no generated artifact yet. A missing
    // scored pass is not evidence that their saved location has no passes.
    addRow('map-popup-row', props.is_personal
      ? 'Saved target · no scored forecast available'
      : 'No upcoming pass in window', 'margin-top:6px;color:#444');
  }

  // ONE weather row (review R9): the at-pass forecast baseline now, patched
  // with the live "now" value async-after-open via patchPopupWeather.
  const atPass = hasPass && typeof props.cloud_fraction === 'number' ? Math.round(props.cloud_fraction) : null;
  addRow('map-popup-weather', atPass != null ? `Cloud: at pass ${atPass}%` : 'Cloud: checking now…', 'margin-top:2px;color:#444');

  // Shot status — ONLY when count > 0; absence is not "never shot" (review R12).
  if (typeof props.shot_count === 'number' && props.shot_count > 0) {
    addRow('map-popup-shot', `✓ shot ${props.shot_count}×`, 'margin-top:4px;color:#1a7a3a;font-weight:600');
  }

  // Edit affordance — personal targets only (review R11); single tap deep-links
  // to the Profile-pane edit form via the onEdit callback.
  if (props.is_personal && props.target_id && onEdit) {
    const id = props.target_id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'map-popup-edit';
    btn.textContent = 'Edit target';
    btn.style.cssText = 'margin-top:8px;font:inherit;cursor:pointer;border:1px solid #2a3142;background:#eef1f6;color:#0b0d12;border-radius:4px;padding:3px 8px';
    btn.addEventListener('click', () => onEdit(id));
    body.appendChild(btn);
  }

  if (props.is_personal && !hasPass && track
    && Number.isFinite(props.lat) && Number.isFinite(props.lon)
    && Math.abs(props.lat!) <= 90 && Math.abs(props.lon!) <= 180) {
    const lat = props.lat!;
    const lon = props.lon!;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-popup-next-passes';
    button.textContent = 'Next ISS passes';
    button.style.cssText = 'display:block;margin-top:8px;font:inherit;cursor:pointer';
    const results = document.createElement('div');
    results.className = 'map-popup-personal-passes';
    results.setAttribute('aria-live', 'polite');
    button.addEventListener('click', () => {
      button.disabled = true;
      results.textContent = 'Calculating upcoming passes…';
      // Only scan the requested target, after yielding to paint the response.
      // Hundreds of saved locations must not each trigger a scan on boot.
      window.setTimeout(() => {
        const queryMs = clock.now();
        try {
          if (!liveIssPositionSGP4(track, queryMs)) {
            results.textContent = 'Orbit data is unavailable. Reconnect and refresh to check passes.';
            return;
          }
          const passes = findUpcomingPasses(track, lat, lon, queryMs);
          const prediction = buildPassList(lat, lon, 3, [{ name: 'ISS', color: '#125e87', passes }], queryMs, {
            emptyText: 'No ISS passes within 1500 km in the next 36 hours.',
            footerText: 'Geometric estimate from the saved orbit data; clouds and window obstructions are not included.',
          });
          const epoch = Date.parse(track.tle_epoch);
          const ageHours = Number.isFinite(epoch) ? (queryMs - epoch) / 3_600_000 : track.tle_age_hours;
          if (isTleStale(ageHours)) {
            const stale = document.createElement('p');
            stale.textContent = `Orbit data is ${Math.round(ageHours!)} hours old; pass times may have drifted. Refresh when connected.`;
            prediction.appendChild(stale);
          }
          results.replaceChildren(prediction);
        } catch {
          results.textContent = 'Could not calculate passes. Reconnect and refresh the orbit data.';
        } finally {
          button.disabled = false;
        }
      }, 0);
    });
    body.append(button, results);
  }

  return body;
}

/** Patch the popup's single weather row with the live "now" cloud %, combined
 *  with the at-pass forecast: "Cloud: now X% · at pass Y%". Collapses the row
 *  when there's nothing to show. Caller guards on body.isConnected so a resolve
 *  after the popup closed/replaced is a no-op (review R7/R8). */
export function patchPopupWeather(
  body: HTMLElement,
  nowPct: number | null,
  props: TargetPopupProps,
): void {
  const row = body.querySelector<HTMLElement>('.map-popup-weather');
  if (!row) return;
  const atPass = props.has_pass === true && typeof props.cloud_fraction === 'number' ? Math.round(props.cloud_fraction) : null;
  const parts: string[] = [];
  if (nowPct != null) parts.push(`now ${nowPct}%`);
  if (atPass != null) parts.push(`at pass ${atPass}%`);
  if (parts.length === 0) { row.remove(); return; }
  row.textContent = `Cloud: ${parts.join(' · ')}`;
}

/** A merge-deduped target hit under a tap, ready for the popup. */
export interface TargetHit {
  props: TargetPopupProps;
  lngLat: [number, number];
}

type PointHit = Hit & { geometry: GeoJSON.Point };

/** Resolve which target a tap selected and merge its property bags.
 *
 *  A personal target that also has an upcoming pass appears in BOTH the
 *  `targets` (score-colored, has_pass:true) and `my-targets` (white ring,
 *  is_personal:true) sources — the same target_id in two features. The tap
 *  bbox can also catch two genuinely different targets. So we:
 *    1. pick the feature whose projected pin is NEAREST the tap (review R10/R16),
 *    2. collect every hit feature sharing that winning target_id,
 *    3. union their properties, deriving has_pass / is_personal from the WHOLE
 *       group (not any single feature's flag — review R1/R2), and treating any
 *       `personal:`-prefixed id as personal even if the ring layer wasn't hit.
 *  Returns null when nothing point-like was hit. */
export function pickTargetAtTap(
  features: Hit[],
  tap: { x: number; y: number },
  project: (lngLat: [number, number]) => { x: number; y: number },
): TargetHit | null {
  const pts = features.filter((f): f is PointHit => f.geometry?.type === 'Point' && !!f.properties);

  // Nearest pin to the tap decides the winning target.
  let nearest: PointHit | null = null;
  let nearestD = Infinity;
  for (const f of pts) {
    const ll = f.geometry.coordinates as [number, number];
    const p = project(ll);
    const d = (p.x - tap.x) ** 2 + (p.y - tap.y) ** 2;
    if (d < nearestD) { nearestD = d; nearest = f; }
  }
  if (!nearest) return null;

  const winId = (nearest.properties as Record<string, unknown>).target_id;
  const group = winId != null ? pts.filter((f) => f.properties!.target_id === winId) : [nearest];

  const merged: Record<string, unknown> = {};
  let hasPass = false;
  let isPersonal = false;
  for (const f of group) {
    const props = f.properties as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) {
      if (v !== undefined && v !== null) merged[k] = v;
    }
    if (props.has_pass === true) hasPass = true;
    if (props.is_personal === true) isPersonal = true;
  }
  if (typeof winId === 'string' && winId.startsWith('personal:')) isPersonal = true;
  merged.has_pass = hasPass;
  merged.is_personal = isPersonal;

  return { props: merged as TargetPopupProps, lngLat: nearest.geometry.coordinates as [number, number] };
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
  if (!core) return;
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
  core.setGeoJson('lookup-pin', fc);
  if (!core.hasLayer('lookup-pin-layer')) {
    core.ensureLayer({
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
    core.onLayer('click', 'lookup-pin-layer', (e) => {
      const f = e.features[0];
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
      core!.openPopup({ at: coords, content: body });
    });
    core.onLayer('mouseenter', 'lookup-pin-layer', () => {
      if (core) core.setCursor('pointer');
    });
    core.onLayer('mouseleave', 'lookup-pin-layer', () => {
      if (core) core.setCursor('');
    });
  }
  // Center + ensure visible zoom. Don't override the user's bearing/tilt.
  const targetZoom = Math.max(core.zoom(), 4);
  core.easeTo({ center: [result.lon, result.lat], zoom: targetZoom, duration: 800 });
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

/** Compact short-labels + sub-points for the topbar multi-sat row.
 *
 *  INTENTIONALLY live (clock.now()), not view-time: the topbar is the LIVE
 *  domain — its ISS readout also stays on the wall clock while the map is
 *  scrubbed. Only the map surface follows the scrub (4A, 2026-06-10).
 *  Returns "Tg 32.5°N, 118.3°E" style strings. */
export function getSatelliteTopbarReadouts(): { label: string; text: string; color: string }[] {
  const nowMs = clock.now();
  const out: { label: string; text: string; color: string }[] = [];
  for (const { label, color, track } of core?.view().satellites ?? []) {
    const pos = liveIssPositionSGP4(track, nowMs);
    if (!pos) continue;
    const ns = pos.lat >= 0 ? 'N' : 'S';
    const ew = pos.lon >= 0 ? 'E' : 'W';
    out.push({
      label,
      text: `${Math.abs(pos.lat).toFixed(1)}°${ns}, ${Math.abs(pos.lon).toFixed(1)}°${ew}`,
      color,
    });
  }
  return out;
}
