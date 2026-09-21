import type { ForecastCloudsIndex, Manifest } from '../../../types';
import { geoIRTileUrl, geoIRTimeForNow, pickGeoIRSat, type GeoIRSat } from '../../../tile-precache';
import type { Clock } from '../../map-core/clock';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import type { LayerId } from '../../map-core/catalog';
import { PREF_KEYS } from '../../map-core/prefs';
import { compactFrameKey, nearestForecastFrame } from './forecast';
import { basemapVisibility } from './visibility';

export { basemapVisibility } from './visibility';
export { compactFrameKey, nearestForecastFrame } from './forecast';

/** Forecast cloud frames stay off. A scrubbed view keeps the observed
 *  imagery and the "observed — not forecast" badge. The test override is
 *  the only switch that turns the machinery on. */
const FORECAST_CLOUDS_UI = false;

const BASEMAP_LAYERS = [
  'gibs-clouds-layer',
  'fcst-clouds-layer',
  'esri-imagery-layer',
  'carto-dark-layer',
] as const satisfies readonly LayerId[];

type Runtime = {
  core: MapCore | null;
  clock: Clock | null;
  cloudsVisible: boolean;
  irVisible: boolean;
  currentGeoIRSat: GeoIRSat | null;
  currentGeoIRTime: string | null;
  geoIrAnyLoaded: boolean;
  geoIrFeedDown: boolean;
  manifest: Manifest | null;
  fcstTilesFailed: boolean;
  fcstCurrentFrameKey: string | null;
  esriTilesFailed: boolean;
  forecastUiOverride: boolean | null;
  lastImageryBadgeArgs: { container: HTMLElement; manifest: Manifest } | null;
  deferTileSwap: boolean;
  cloudToggleBound: boolean;
  irToggleBound: boolean;
  irErrorLogged: boolean;
};

/** Clouds default on: a missing key is visible, and only `'0'` hides them. */
export function readCloudsVisible(): boolean {
  try {
    const stored = localStorage.getItem(PREF_KEYS.cloudsVisible);
    return stored === null ? true : stored === '1';
  } catch {
    return true;
  }
}

/** IR defaults off. Only the exact stored value `'1'` turns it on. */
export function readIrVisible(): boolean {
  try {
    return localStorage.getItem(PREF_KEYS.irVisible) === '1';
  } catch {
    return false;
  }
}

const state: Runtime = {
  core: null,
  clock: null,
  cloudsVisible: readCloudsVisible(),
  irVisible: readIrVisible(),
  currentGeoIRSat: null,
  currentGeoIRTime: null,
  geoIrAnyLoaded: false,
  geoIrFeedDown: false,
  manifest: null,
  fcstTilesFailed: false,
  fcstCurrentFrameKey: null,
  esriTilesFailed: false,
  forecastUiOverride: null,
  lastImageryBadgeArgs: null,
  deferTileSwap: false,
  cloudToggleBound: false,
  irToggleBound: false,
  irErrorLogged: false,
};

function mapClock(): Clock {
  const clock = state.clock;
  if (!clock) throw new Error('bindBasemapClock before using the basemap');
  return clock;
}

/** The manifest `renderMap` just loaded. Frame selection reads it outside
 *  that function. */
export function setBasemapManifest(manifest: Manifest | null): void {
  state.manifest = manifest;
}

/** Hold forecast tile swaps while the slider thumb is down. The release
 *  clears this before the explicit frame refresh. */
export function setForecastSwapDeferred(deferred: boolean): void {
  state.deferTileSwap = deferred;
}

/** Test-only. Turns the dormant forecast machinery on, or back to the
 *  production flag when passed null. */
export function _setForecastCloudsUiForTest(on: boolean | null): void {
  state.forecastUiOverride = on;
}

/** Test-only. The real flag is set by the tile-error handler. */
export function _setFcstTilesFailedForTest(failed: boolean): void {
  state.fcstTilesFailed = failed;
}

/** Test-only. Matches the basemap fields `_resetMapStateForTest` used to
 *  clear. The in-memory IR flag and the Esri-failure flag survive, and the
 *  IR preference key is removed. */
export function resetBasemapForTest(): void {
  state.lastImageryBadgeArgs = null;
  state.manifest = null;
  state.fcstTilesFailed = false;
  state.fcstCurrentFrameKey = null;
  state.cloudsVisible = true;
  state.deferTileSwap = false;
  try {
    localStorage.removeItem(PREF_KEYS.irVisible);
  } catch {}
}

function activeForecastIndex(manifest: Manifest | null | undefined): ForecastCloudsIndex | undefined {
  const enabled = state.forecastUiOverride ?? FORECAST_CLOUDS_UI;
  return enabled ? manifest?.forecast_clouds : undefined;
}

function frameForIndex(
  fc: ForecastCloudsIndex | undefined,
  nowMs: number,
): { iso: string; validMs: number } | null {
  if (!mapClock().isScrubbed() || state.fcstTilesFailed || !state.cloudsVisible) return null;
  if (!fc || !Array.isArray(fc.valid_times) || fc.valid_times.length === 0) return null;
  return nearestForecastFrame(fc.valid_times, mapClock().viewMs(nowMs), nowMs);
}

function forecastFrameForView(nowMs = mapClock().now()): { iso: string; validMs: number } | null {
  return frameForIndex(activeForecastIndex(state.manifest), nowMs);
}

function applyCloudsVisibility(): void {
  const core = state.core;
  if (!core) return;
  let forecastFrameActive = false;
  try {
    forecastFrameActive = core.hasLayer('fcst-clouds-layer') && forecastFrameForView() !== null;
  } catch {}
  const visibility = basemapVisibility({
    cloudsVisible: state.cloudsVisible,
    irVisible: state.irVisible,
    forecastFrameActive,
    esriTilesFailed: state.esriTilesFailed,
  });
  try {
    for (const layerId of BASEMAP_LAYERS) core.setVisibility(layerId, visibility[layerId]);
  } catch {}
}

/** Point the forecast raster at the frame for this view, then apply the
 *  basemap decision. A bad manifest path or a tile failure leaves the
 *  observed layer in charge. */
export function refreshForecastCloudLayer(): void {
  const core = state.core;
  if (!core) return;
  const frame = forecastFrameForView();
  const fc = activeForecastIndex(state.manifest);
  if (frame && fc) {
    const key = compactFrameKey(frame.iso);
    if (!/^clouds-fcst\/\d{8}T\d{6}Z$/.test(fc.prefix) || !/^\d{8}T\d{6}Z$/.test(key)) {
      applyCloudsVisibility();
      return;
    }
    const url = `/${fc.prefix}/${key}/{z}/{x}/{y}.png`;
    try {
      if (!core.hasSource('fcst-clouds')) {
        core.addRasterSource('fcst-clouds', {
          type: 'raster',
          tiles: [url],
          tileSize: 256,
          maxzoom: fc.max_zoom,
        });
        core.ensureLayer({
          id: 'fcst-clouds-layer',
          type: 'raster',
          source: 'fcst-clouds',
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': 0.55 },
        });
        state.fcstCurrentFrameKey = key;
      } else if (state.fcstCurrentFrameKey !== key) {
        if (state.deferTileSwap) {
          applyCloudsVisibility();
          return;
        }
        core.setRasterTiles('fcst-clouds', [url]);
        state.fcstCurrentFrameKey = key;
      }
    } catch {}
  }
  applyCloudsVisibility();
}

function reflectCloudsButton(): void {
  const btn = document.getElementById('toggle-clouds');
  if (!btn) return;
  btn.classList.toggle('active', state.cloudsVisible);
  btn.setAttribute('aria-pressed', state.cloudsVisible ? 'true' : 'false');
  btn.title = state.cloudsVisible
    ? 'Clouds shown (dark basemap) — click to hide clouds and show satellite imagery'
    : 'Clouds hidden (satellite imagery) — click to show clouds and dark basemap';
}

function reflectIrButton(): void {
  const btn = document.getElementById('toggle-ir');
  if (!btn) return;
  btn.classList.toggle('active', state.irVisible);
  btn.setAttribute('aria-pressed', state.irVisible ? 'true' : 'false');
  btn.title = state.irVisible
    ? 'Live IR cloud-tops shown (replaces daily clouds; misses low cloud) — click to hide'
    : 'Show live geostationary IR cloud-tops (~10 min, day + night; replaces the daily clouds layer)';
}

function bindCloudToggle(): void {
  if (state.cloudToggleBound) return;
  const btn = document.getElementById('toggle-clouds');
  if (!btn) return;
  reflectCloudsButton();
  btn.addEventListener('click', () => {
    state.cloudsVisible = !state.cloudsVisible;
    try {
      localStorage.setItem(PREF_KEYS.cloudsVisible, state.cloudsVisible ? '1' : '0');
    } catch {}
    reflectCloudsButton();
    if (state.cloudsVisible && state.irVisible) {
      state.irVisible = false;
      try {
        localStorage.setItem(PREF_KEYS.irVisible, '0');
      } catch {}
      applyIrVisibility();
      reflectIrButton();
    }
    refreshForecastCloudLayer();
  });
  state.cloudToggleBound = true;
}

function repickGeoIRForView(): void {
  const core = state.core;
  if (!core || !state.irVisible) return;
  let lat: number;
  let lng: number;
  try {
    [lng, lat] = core.center();
  } catch {
    return;
  }
  const sat = pickGeoIRSat(lat, lng);
  const time = geoIRTimeForNow();
  const changed = (sat?.layer ?? null) !== (state.currentGeoIRSat?.layer ?? null) || time !== state.currentGeoIRTime;
  state.currentGeoIRSat = sat;
  if (sat && changed) {
    state.currentGeoIRTime = time;
    state.geoIrAnyLoaded = false;
    state.geoIrFeedDown = false;
    try {
      core.setRasterTiles('geo-ir', [geoIRTileUrl(sat, time)]);
    } catch {}
  } else if (!sat) {
    state.currentGeoIRTime = null;
  }
}

function applyIrVisibility(): void {
  const core = state.core;
  if (!core) return;
  const showRaster = state.irVisible && state.currentGeoIRSat !== null;
  try {
    core.setVisibility('geo-ir-layer', showRaster ? 'visible' : 'none');
  } catch {}
}

function refreshIr(): void {
  repickGeoIRForView();
  applyIrVisibility();
  applyCloudsVisibility();
  refreshImageryDateBadgeForView();
}

function armIrErrorHandler(): void {
  const core = state.core;
  if (!core) return;
  core.on('error', ({ sourceId }) => {
    if (sourceId !== 'geo-ir') return;
    if (state.irErrorLogged) return;
    state.irErrorLogged = true;
    console.warn('[map] some geo-IR tiles 404 (disk edge / unpublished frame); IR left on.');
  });
}

function bindIrToggle(): void {
  if (state.irToggleBound) return;
  const btn = document.getElementById('toggle-ir');
  if (!btn) return;
  armIrErrorHandler();
  reflectIrButton();
  mapClock().every(120_000, () => {
    if (!state.irVisible) return;
    repickGeoIRForView();
    applyIrVisibility();
    refreshImageryDateBadgeForView();
  });
  const core = state.core;
  if (core) {
    core.on('moveend', () => {
      if (!state.irVisible) return;
      repickGeoIRForView();
      applyIrVisibility();
      refreshImageryDateBadgeForView();
    });
    core.on('data', ({ sourceId, tileLoaded }) => {
      if (sourceId === 'geo-ir' && tileLoaded) {
        state.geoIrAnyLoaded = true;
        if (state.geoIrFeedDown) {
          state.geoIrFeedDown = false;
          refreshImageryDateBadgeForView();
        }
      }
    });
    core.on('idle', () => {
      if (state.irVisible && state.currentGeoIRSat && !state.geoIrAnyLoaded && !state.geoIrFeedDown) {
        state.geoIrFeedDown = true;
        refreshImageryDateBadgeForView();
      }
    });
  }
  btn.addEventListener('click', () => {
    if (state.irErrorLogged) state.irErrorLogged = false;
    state.irVisible = !state.irVisible;
    try {
      localStorage.setItem(PREF_KEYS.irVisible, state.irVisible ? '1' : '0');
    } catch {}
    if (state.irVisible && state.cloudsVisible) {
      state.cloudsVisible = false;
      try {
        localStorage.setItem(PREF_KEYS.cloudsVisible, '0');
      } catch {}
      reflectCloudsButton();
    }
    reflectIrButton();
    refreshIr();
  });
  state.irToggleBound = true;
}

/** Age of the shown cloud imagery. Never negative. */
export function formatImageryAge(compositeMs: number, nowMs: number): string {
  const ageMin = Math.max(0, Math.floor((nowMs - compositeMs) / 60_000));
  if (ageMin < 90) return `~${ageMin}m old`;
  if (ageMin < 24 * 60) return `~${Math.round(ageMin / 60)}h old`;
  const ageD = Math.round(ageMin / 1440);
  return `~${ageD} day${ageD === 1 ? '' : 's'} old`;
}

function lastValidTimeMs(fc: ForecastCloudsIndex): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const iso of fc.valid_times) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && t > max) max = t;
  }
  return max;
}

/** The imagery badge. Its wording follows the layer on screen: live IR,
 *  the daily composite, or the observed-not-forecast line while scrubbed. */
export function ensureImageryDateBadge(container: HTMLElement, manifest: Manifest): void {
  state.lastImageryBadgeArgs = { container, manifest };
  let badge = container.querySelector<HTMLElement>('.map-imagery-date');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'map-imagery-date';
    container.appendChild(badge);
  }
  if (state.irVisible) {
    if (!state.currentGeoIRSat) {
      badge.textContent = 'IR: no geostationary coverage here';
    } else if (state.geoIrFeedDown) {
      badge.textContent = `IR · ${state.currentGeoIRSat.label} · feed unavailable`;
    } else if (mapClock().isScrubbed()) {
      badge.textContent = `IR · ${state.currentGeoIRSat.label} · LIVE now (not the scrubbed time) · misses low cloud`;
    } else {
      const fresh = state.currentGeoIRSat.source === 'realearth'
        ? 'latest'
        : (state.currentGeoIRTime ? formatImageryAge(Date.parse(state.currentGeoIRTime), mapClock().now()) : '');
      badge.textContent = `IR · ${state.currentGeoIRSat.label}${fresh ? ` · ${fresh}` : ''} · misses low cloud`;
    }
    badge.hidden = false;
    return;
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
  if (!mapClock().isScrubbed()) {
    badge.textContent = `Imagery: ${date} · ${formatImageryAge(t, mapClock().now())}`;
  } else {
    const nowMs = mapClock().now();
    const fc = activeForecastIndex(manifest);
    const frame = frameForIndex(fc, nowMs);
    const eligible = !!fc && state.cloudsVisible && !state.fcstTilesFailed
      && Array.isArray(fc.valid_times) && fc.valid_times.length > 0;
    if (frame && fc) {
      const aheadH = Math.round((frame.validMs - nowMs) / 3_600_000);
      const runHH = fc.gfs_run.slice(11, 13);
      const horizon = aheadH < 1 ? 'now' : `+${aheadH}h`;
      badge.textContent = `Clouds: GFS forecast ${horizon} · coarse (${runHH}z)`;
    } else if (eligible && fc && lastValidTimeMs(fc) < mapClock().viewMs(nowMs)) {
      const endH = Math.max(0, Math.round((lastValidTimeMs(fc) - nowMs) / 3_600_000));
      badge.textContent = `Clouds: observed ${date} — forecast ends +${endH}h`;
    } else {
      badge.textContent = `Clouds: observed ${date} — not forecast`;
    }
  }
  badge.hidden = false;
}

function refreshImageryDateBadgeForView(): void {
  if (state.lastImageryBadgeArgs) {
    ensureImageryDateBadge(state.lastImageryBadgeArgs.container, state.lastImageryBadgeArgs.manifest);
  }
}

/** Forecast layer, IR satellite, IR visibility, and the imagery badge.
 *  Terminator, night lights, and labels stay with their own callers. */
export function refreshBasemap(): void {
  refreshForecastCloudLayer();
  repickGeoIRForView();
  applyIrVisibility();
  refreshImageryDateBadgeForView();
}

/** Tile-failure fallback for the forecast raster and Esri imagery. One-way
 *  for the session. Registered when the map is created, before the style
 *  finishes loading, so a first-paint failure is not missed. */
export function attachBasemap(core: MapCore): void {
  state.core = core;
  core.on('error', ({ sourceId }) => {
    if (sourceId === 'fcst-clouds' && !state.fcstTilesFailed) {
      state.fcstTilesFailed = true;
      console.warn('[map] forecast cloud tile load failed; observed layer for the rest of this session');
      applyCloudsVisibility();
      refreshImageryDateBadgeForView();
    }
    if (sourceId === 'esri-imagery' && !state.esriTilesFailed) {
      state.esriTilesFailed = true;
      console.warn('[map] Esri imagery tile load failed; falling back to Carto Dark basemap for the rest of this session');
      applyCloudsVisibility();
    }
  });
}

/** Share the composition root's clock. The forecast layer and the imagery
 *  badge refresh on every view-time change, including scrubs that never
 *  call `renderMap`. */
export function bindBasemapClock(clock: Clock): void {
  state.clock = clock;
  clock.onViewTime(() => {
    refreshForecastCloudLayer();
    refreshImageryDateBadgeForView();
  });
}

/** Clouds, IR, the Esri/Carto basemap, and the imagery badge. */
export const basemap: MapFeature = {
  id: 'basemap',
  mount(core) {
    state.core = core;
    bindCloudToggle();
    bindIrToggle();
  },
};
