import type { Manifest, PassEntry, Track } from '../types';
import { fetchArtifact } from '../manifest';
import { createVendorMap } from './adapters/maplibre';
import { registerViirsAlphaProtocol, viirsAlphaUrl } from './adapters/maplibre/viirs-alpha';
import { initialCamera } from './map-core/camera';
import { createClock } from './map-core/clock';
import { createMapCore, type MapCore } from './map-core/core';
import type { StyleSpec } from './map-core/layer-spec';
import type { VendorMap } from './map-core/vendor-map';
import { FEATURES } from './features';
import {
  attachBasemap,
  bindBasemapClock,
  ensureImageryDateBadge,
  refreshBasemap,
  refreshForecastCloudLayer,
  resetBasemapForTest,
  setBasemapManifest,
  setForecastSwapDeferred,
} from './features/basemap';
import {
  applyBearing,
  bindBearingToggle,
  bindFollowMarker,
  bindFollowToggle,
  clearBearingPref,
  currentBearingMode,
  exitFollow,
  isFollowing,
  noteFollowCore,
  resetFollowMemoryForTest,
  setFollowEnv,
} from './features/follow-iss';
import { bindGroundTrackClock, refreshGroundTrack } from './features/ground-track';
import {
  hasIssMarker,
  issMarkerPosition,
  moveIssMarkerToView,
  syncIssMarker,
  tickIssMarker,
} from './features/iss-marker';
import { refreshLabels, resetLabelsForTest } from './features/labels';
import {
  ascentPadLayer,
  ascentTrajectoryLayer,
  bindAscentPad,
  bindExitFollow,
  bindLaunchStore,
  bindLaunchTargets,
  noteLaunchCore,
  refreshAscentTrajectorySource,
  resetLaunchForTest,
  setLaunchPasses,
  syncMapLaunchMode,
} from './features/launch-corridor';
import {
  GLOBAL_DIM_LAYER,
  NIGHT_LIGHTS_LAYER,
  refreshNightLights,
  resetNightLightsForTest,
} from './features/night-lights';
import {
  applyTargetLaunchVisibility,
  bindProfileChangedListener,
  bindTargetInteractions,
  bindTargetsClock,
  myTargetsCasingLayer,
  myTargetsLayer,
  noteTargetCore,
  refreshMyTargetsSource,
  refreshTargetsIfPresent,
  refreshTargetsSource,
  setTargetPasses,
  targetsLayer,
} from './features/targets';
import {
  SUBSOLAR_LAYER,
  TERMINATOR_FILL_LAYER,
  TERMINATOR_LINE_LAYER,
  bindTerminatorClock,
  refreshTerminator,
  refreshTerminatorGeometry,
} from './features/terminator';
import {
  bindScrubServices,
  bindTimeScrubClock,
  bindTimeSlider,
  bindTimeToggle,
  maybeSnapToLive,
  resetScrubControlsForTest,
  scrubTrack,
  setScrubTrack,
  updateTimeStepLabels,
  _resetScrubTierStateForTest,
} from './features/time-scrub';
import { setMapLaunchMode } from '../map-launch-mode';
import { parseProfileFromURL } from '../profile';
import {
  GIBS_GEO_IR_MAX_ZOOM,
  GIBS_MAX_ZOOM,
  VIIRS_BLACK_MARBLE_MAX_ZOOM,
  geoIRTimeForNow,
  gibsGeoIRUrl,
  gibsTrueColorUrl,
  yesterdayIso,
} from '../tile-precache';

export { createIssMarkerElement, markerPositionAt } from './features/iss-marker';
export { getSatelliteTopbarReadouts } from './features/satellites';
export {
  applyDistanceThreshold,
  buildTargetPopupContent,
  cloudSourceLabel,
  dropLookupPin,
  patchPopupWeather,
  pickTargetAtTap,
} from './features/targets';
export type { TargetHit, TargetPopupProps } from './features/targets';
export {
  buildAscentFeatures,
  buildLaunchMapFeatures,
  focusLaunchOnMap,
  syncMapLaunchMode as _syncMapLaunchModeForTest,
} from './features/launch-corridor';
export {
  LOOKAHEAD_MAX_MINUTES,
  bindTimeSlider,
  bindTimeToggle,
  clampLookahead,
  formatViewTimeReadout,
  isScrubbed,
  maybeSnapToLive,
  rafCoalesce,
  setLookahead,
  _getScrubTier2RunCountForTest,
  _getViewTimeMsForTest,
  _isScrubTier2TimerArmedForTest,
  _resetScrubTierStateForTest,
} from './features/time-scrub';
export { applyFollowISS, readBearingMode, _resetFollowStateForTest } from './features/follow-iss';
export type { BearingMode } from './features/follow-iss';

registerViirsAlphaProtocol();

let core: MapCore | null = null;
const clock = createClock();
bindBasemapClock(clock);
bindTerminatorClock(clock);
bindGroundTrackClock(clock);
bindTargetsClock(clock);
bindTimeScrubClock(clock);
bindScrubServices({
  refreshTargets() {
    if (scrubTrack()) refreshTargetsSource();
  },
  hasMarker: hasIssMarker,
  hasTrack: () => scrubTrack() !== null,
  markerPosition: () => issMarkerPosition(),
  moveMarker: () => moveIssMarkerToView(),
  easeTo(pos) {
    if (core) core.easeTo({ center: [pos.lon, pos.lat], duration: 600 });
  },
  onLiveSnap(pos) {
    if (isFollowing() && core && scrubTrack()) core.easeTo({ center: [pos.lon, pos.lat], duration: 600 });
  },
  deferForecast: setForecastSwapDeferred,
  refreshForecast: refreshForecastCloudLayer,
});
bindLaunchTargets({
  refreshIfPresent: refreshTargetsIfPresent,
  refresh: refreshTargetsSource,
  applyVisibility: applyTargetLaunchVisibility,
});
bindExitFollow(exitFollow);
bindFollowMarker({
  hasTrack: () => scrubTrack() !== null,
  position: () => issMarkerPosition(),
});

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
        
        
        
        
        
        
        
        maxzoom: 20,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      },
      'gibs-clouds': {
        type: 'raster',
        tiles: [gibsTrueColorUrl(dateIso)],
        tileSize: 256,
        
        
        
        
        
        maxzoom: GIBS_MAX_ZOOM,
        attribution:
          'Imagery from <a href="https://earthdata.nasa.gov">NASA GIBS</a>',
      },
      
      
      
      
      
      
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
        
        
        
        
        
        
        
        
        type: 'geojson',
        data: '/ne_110m_coastline.geojson',
        attribution:
          'Coastlines: <a href="https://www.naturalearthdata.com/">Natural Earth</a>',
      },
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      'viirs-night-lights': {
        type: 'raster',
        tiles: [viirsAlphaUrl('2016-01-01')],
        tileSize: 256,
        maxzoom: VIIRS_BLACK_MARBLE_MAX_ZOOM,
        attribution:
          'Night lights: <a href="https://earthdata.nasa.gov">NASA GIBS VIIRS Black Marble</a>',
      },
      
      
      
      
      
      'geo-ir': {
        type: 'raster',
        tiles: [gibsGeoIRUrl('GOES-East_ABI_Band13_Clean_Infrared', geoIRTimeForNow())],
        tileSize: 256,
        maxzoom: GIBS_GEO_IR_MAX_ZOOM,
        attribution:
          'Live IR: <a href="https://earthdata.nasa.gov">NASA GIBS</a> (GOES/Himawari) + <a href="https://realearth.ssec.wisc.edu">SSEC RealEarth</a> (Meteosat)',
      },
      
      
      
      
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
        paint: { 'raster-opacity': 0.55 }, 
      },
      {
        
        
        
        
        
        id: 'geo-ir-layer',
        type: 'raster',
        source: 'geo-ir',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.82 },
      },
      {
        
        
        
        
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

  const profileName = parseProfileFromURL(window.location.href);
  const passes = await fetchArtifact<PassEntry[]>(manifest, 'passes', '', profileName);
  const track = await fetchArtifact<Track>(manifest, 'track');
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
  noteTargetCore(core);
  noteLaunchCore(core);
  noteFollowCore(core);
  core.setTrack(track);
  setScrubTrack(track);
  setTargetPasses(passes);
  setLaunchPasses(passes);

  ensureImageryDateBadge(container, manifest);
  refreshGroundTrack(core);

  refreshMyTargetsSource();
  core.ensureLayer(myTargetsCasingLayer());
  core.ensureLayer(myTargetsLayer());
  refreshTargetsSource();
  if (!core.hasLayer('targets-layer')) {
    core.ensureLayer(targetsLayer());
    bindTargetInteractions(core);
  }

  refreshTerminatorGeometry(core);
  core.ensureLayer(GLOBAL_DIM_LAYER);
  core.ensureLayer(TERMINATOR_FILL_LAYER);
  core.ensureLayer(NIGHT_LIGHTS_LAYER);
  core.ensureLayer(TERMINATOR_LINE_LAYER);
  core.ensureLayer(SUBSOLAR_LAYER);

  refreshAscentTrajectorySource();
  core.ensureLayer(ascentTrajectoryLayer());
  if (!core.hasLayer('ascent-pad-layer')) {
    core.ensureLayer(ascentPadLayer());
    bindAscentPad(core);
  }
  syncMapLaunchMode();
  bindLaunchStore();
  syncIssMarker(core);

  if (isFirstInit) {
    clock.every(1000, (nowMs) => {
      if (!core || !hasIssMarker() || !scrubTrack()) return;
      if (maybeSnapToLive(nowMs)) return;
      tickIssMarker(nowMs);
      if (currentBearingMode() === 'iss-up') applyBearing(false);
    });
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
  bindProfileChangedListener();
  refreshBasemap();
  refreshTerminator(core);
  refreshNightLights(core);
  if (isFirstInit) applyBearing(true);
}

export async function refreshMapForManifest(manifest: Manifest): Promise<void> {
  if (!core) return;
  await renderMap(manifest);
}

export function _setCurrentTrackForTest(track: Track | null): void {
  setScrubTrack(track);
  core?.setTrack(track);
}

export function _resetMapStateForTest(): void {
  resetLaunchForTest();
  setMapLaunchMode(false);
  resetFollowMemoryForTest();
  clock.setViewTime({ kind: 'live' });
  resetScrubControlsForTest();
  setScrubTrack(null);
  core?.setTrack(null);
  resetBasemapForTest();
  resetLabelsForTest();
  resetNightLightsForTest();
  clearBearingPref();
  _resetScrubTierStateForTest();
}

export function _setFollowEnvForTest(
  vendor: { setCenter(center: [number, number]): void } | null,
  follow: boolean,
): MapCore | null {
  core = vendor ? createMapCore(vendor as unknown as VendorMap, clock) : null;
  noteTargetCore(core);
  noteLaunchCore(core);
  setFollowEnv(core, follow);
  return core;
}

export function resizeMap(): void {
  if (core) core.resize();
}
