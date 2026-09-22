import { fetchLiveCloud } from '../../../cloud';
import { getMapLaunchMode } from '../../../map-launch-mode';
import { isLaunchPass } from '../../../launch-selectors';
import { DEFAULT_DISTANCE_THRESHOLD_KM, filterPassesByDistance } from '../../../pass-filter';
import { loadProfile, parseProfileFromURL, type PersonalTarget } from '../../../profile';
import { EDIT_TARGET_EVENT, subscribeProfileChanged } from '../../../profile-events';
import { getShotCount } from '../../../shot-counts';
import { applyTargetFilter, getTargetFilter } from '../../../target-filter-pref';
import type { PassEntry } from '../../../types';
import type { Clock } from '../../map-core/clock';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import type { Point } from '../../map-core/geometry';
import type { Hit, PopupHandle } from '../../map-core/vendor-map';
import { buildTargetPopupContent, patchPopupWeather, type TargetPopupProps } from './popup';

export { myTargetsCasingLayer, myTargetsLayer, targetsLayer } from './layers';
export { buildTargetPopupContent, cloudSourceLabel, patchPopupWeather, type TargetPopupProps } from './popup';

/** Half-width of the pass window. A closest approach inside it paints at full opacity. */
const PASS_WINDOW_HALF_MINUTES = 45;

/** A merge-deduped target under a tap. */
export interface TargetHit {
  props: TargetPopupProps;
  lngLat: [number, number];
}

type PointHit = Hit & { geometry: GeoJSON.Point };

type Runtime = {
  core: MapCore | null;
  clock: Clock | null;
  passes: PassEntry[];
  profileBound: boolean;
};

const state: Runtime = {
  core: null,
  clock: null,
  passes: [],
  profileBound: false,
};

function mapClock(): Clock {
  const clock = state.clock;
  if (!clock) throw new Error('bindTargetsClock before using targets');
  return clock;
}

/** Share the composition root's clock. The popup's next-pass scan reads it at click time. */
export function bindTargetsClock(clock: Clock): void {
  state.clock = clock;
}

export function noteTargetCore(core: MapCore | null): void {
  state.core = core;
}

export function setTargetPasses(passes: PassEntry[]): void {
  state.passes = passes;
}

function readActiveDistanceThresholdKm(): number {
  try {
    const name = parseProfileFromURL(window.location.href);
    const profile = loadProfile(name);
    const value = profile?.distanceThresholdKm;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  } catch {}
  return DEFAULT_DISTANCE_THRESHOLD_KM;
}

/** Rebuild score pins from the cached passes at the current view instant. */
export function refreshTargetsSource(): void {
  const core = state.core;
  if (!core) return;
  const viewMs = mapClock().viewMs();
  const halfWindowMs = PASS_WINDOW_HALF_MINUTES * 60_000;
  const thresholdKm = readActiveDistanceThresholdKm();
  const distanceVisible = filterPassesByDistance(state.passes.filter((pass) => !isLaunchPass(pass)), thresholdKm);
  const visible = applyTargetFilter(distanceVisible, getTargetFilter());
  const features = visible.map((pass) => {
    const closestMs = Date.parse(pass.closest_approach);
    const inWindow = Number.isFinite(closestMs) && Math.abs(closestMs - viewMs) <= halfWindowMs;
    return {
      type: 'Feature' as const,
      properties: {
        target_id: pass.target_id,
        target_name: pass.target_name,
        score: pass.score,
        in_window: inWindow,
        closest_approach: pass.closest_approach,
        cloud_fraction: pass.cloud_fraction,
        cloud_source: pass.cloud_source,
        pass_regime: pass.pass_regime,
        obstruction_class: pass.obstruction_class,
        sample_time: pass.sample_time ?? null,
        lat: pass.target_lat,
        lon: pass.target_lon,
        has_pass: true,
        angle_off_nadir_deg: pass.angle_off_nadir_deg,
        iss_relative_bearing_deg: pass.iss_relative_bearing_deg,
      },
      geometry: { type: 'Point' as const, coordinates: [pass.target_lon, pass.target_lat] },
    };
  });
  core.setGeoJson('targets', { type: 'FeatureCollection', features });
}

/** Rebuild the personal-target rings from the active profile. */
export function refreshMyTargetsSource(): void {
  const core = state.core;
  if (!core) return;
  let additions: PersonalTarget[] = [];
  try {
    const profile = loadProfile(parseProfileFromURL(window.location.href));
    additions = Array.isArray(profile?.additions) ? profile.additions : [];
  } catch {
    additions = [];
  }
  const features = additions
    .filter((target) =>
      Number.isFinite(target.lat) && Number.isFinite(target.lon)
      && Math.abs(target.lat) <= 90 && Math.abs(target.lon) <= 180)
    .map((target) => ({
      type: 'Feature' as const,
      properties: {
        target_id: target.id,
        target_name: target.name,
        lat: target.lat,
        lon: target.lon,
        priority: target.priority,
        has_pass: false,
        is_personal: true,
      },
      geometry: { type: 'Point' as const, coordinates: [target.lon, target.lat] },
    }));
  core.setGeoJson('my-targets', { type: 'FeatureCollection', features });
}

/** Re-read the distance threshold and both target sources. */
export function applyDistanceThreshold(): void {
  if (!state.core) return;
  refreshTargetsSource();
  refreshMyTargetsSource();
}

/** One profile-changed subscription for the life of the page. */
export function bindProfileChangedListener(): void {
  if (state.profileBound) return;
  subscribeProfileChanged(() => {
    applyDistanceThreshold();
  });
  state.profileBound = true;
}

/** Hide ordinary target pins while launch mode is on, and the reverse. */
export function applyTargetLaunchVisibility(): void {
  const core = state.core;
  if (!core) return;
  const enabled = getMapLaunchMode();
  try {
    for (const layer of ['targets-layer', 'my-targets-layer', 'my-targets-casing'] as const) {
      const visibility = enabled ? 'none' : 'visible';
      if (core.hasLayer(layer) && core.visibilityOf(layer) !== visibility) {
        core.setVisibility(layer, visibility);
      }
    }
  } catch {}
}

/** Refresh target sources only when the style already owns them. */
export function refreshTargetsIfPresent(): void {
  const core = state.core;
  if (!core) return;
  if (core.hasSource('targets')) refreshTargetsSource();
  if (core.hasSource('my-targets')) refreshMyTargetsSource();
}

/** Nearest pin wins. Features that share its id are merged into one popup. */
export function pickTargetAtTap(
  features: Hit[],
  tap: { x: number; y: number },
  project: (lngLat: [number, number]) => { x: number; y: number },
): TargetHit | null {
  const points = features.filter((feature): feature is PointHit => feature.geometry?.type === 'Point' && !!feature.properties);
  let nearest: PointHit | null = null;
  let nearestD = Infinity;
  for (const feature of points) {
    const lngLat = feature.geometry.coordinates as [number, number];
    const projected = project(lngLat);
    const distance = (projected.x - tap.x) ** 2 + (projected.y - tap.y) ** 2;
    if (distance < nearestD) {
      nearestD = distance;
      nearest = feature;
    }
  }
  if (!nearest) return null;
  const winId = (nearest.properties as Record<string, unknown>).target_id;
  const group = winId != null ? points.filter((feature) => feature.properties!.target_id === winId) : [nearest];
  const merged: Record<string, unknown> = {};
  let hasPass = false;
  let isPersonal = false;
  for (const feature of group) {
    const props = feature.properties as Record<string, unknown>;
    for (const [key, value] of Object.entries(props)) {
      if (value !== undefined && value !== null) merged[key] = value;
    }
    if (props.has_pass === true) hasPass = true;
    if (props.is_personal === true) isPersonal = true;
  }
  if (typeof winId === 'string' && winId.startsWith('personal:')) isPersonal = true;
  merged.has_pass = hasPass;
  merged.is_personal = isPersonal;
  return { props: merged as TargetPopupProps, lngLat: nearest.geometry.coordinates as [number, number] };
}

/** Click and hover for both target layers. Registered once, with the layer. */
export function bindTargetInteractions(host: MapCore): void {
  host.on('click', (event) => {
    const core = state.core;
    if (!core) return;
    const layers = (['targets-layer', 'my-targets-layer'] as const).filter((id) => core.hasLayer(id));
    if (layers.length === 0) return;
    const pad = 7;
    const bbox: [Point, Point] = [
      { x: event.point.x - pad, y: event.point.y - pad },
      { x: event.point.x + pad, y: event.point.y + pad },
    ];
    const priorityLayers = (['ascent-pad-layer', 'lookup-pin-layer', 'dropped-pin-layer'] as const)
      .filter((id) => core.hasLayer(id));
    if (priorityLayers.length > 0 && core.queryAt(bbox, priorityLayers).length > 0) return;
    const feats = core.queryAt(bbox, layers);
    if (feats.length === 0) return;
    const hit = pickTargetAtTap(feats, { x: event.point.x, y: event.point.y }, (lngLat) => core.project(lngLat));
    if (!hit) return;
    const props = hit.props;
    if (props.target_id) {
      const shot = getShotCount(props.target_id);
      if (shot > 0) props.shot_count = shot;
    }
    let popup: PopupHandle | null = null;
    const onEdit = props.is_personal && props.target_id
      ? (id: string) => {
          popup?.remove();
          window.dispatchEvent(new CustomEvent(EDIT_TARGET_EVENT, { detail: { targetId: id } }));
        }
      : undefined;
    const popupBody = buildTargetPopupContent(props, mapClock().now(), onEdit, core.view().track, () => mapClock().now());
    popup = core.openPopup({ at: hit.lngLat, content: popupBody, maxWidth: '360px', owner: 'target' });
    const [lon, lat] = hit.lngLat;
    void fetchLiveCloud(lat, lon).then((pct) => {
      if (popupBody.isConnected) patchPopupWeather(popupBody, pct, props);
    });
  });
  for (const layerId of ['targets-layer', 'my-targets-layer'] as const) {
    host.onLayer('mouseenter', layerId, () => {
      state.core?.setCursor('pointer');
    });
    host.onLayer('mouseleave', layerId, () => {
      state.core?.setCursor('');
    });
  }
}

/** Magenta photo-lookup pin. The layer and its handlers are created on the first drop. */
export function dropLookupPin(result: {
  lat: number;
  lon: number;
  alt_km: number;
  timestamp_utc: Date;
}): void {
  const core = state.core;
  if (!core) return;
  const collection: GeoJSON.FeatureCollection = {
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
  core.setGeoJson('lookup-pin', collection);
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
    core.onLayer('click', 'lookup-pin-layer', (event) => {
      const feature = event.features[0];
      if (!feature || feature.geometry.type !== 'Point') return;
      const coords = (feature.geometry.coordinates as [number, number]).slice() as [number, number];
      const props = feature.properties as { timestamp_iso?: string; alt_km?: number };
      const body = document.createElement('div');
      body.style.cssText = 'font:0.85rem/1.4 system-ui;color:#0b0d12';
      const title = document.createElement('strong');
      title.textContent = '🛰️ ISS position';
      const timestamp = document.createElement('div');
      timestamp.textContent = props.timestamp_iso ?? 'unknown time';
      const altitude = document.createElement('div');
      altitude.textContent = `Altitude: ${(props.alt_km ?? 0).toFixed(1)} km`;
      body.append(title, timestamp, altitude);
      state.core?.openPopup({ at: coords, content: body });
    });
    core.onLayer('mouseenter', 'lookup-pin-layer', () => {
      state.core?.setCursor('pointer');
    });
    core.onLayer('mouseleave', 'lookup-pin-layer', () => {
      state.core?.setCursor('');
    });
  }
  const targetZoom = Math.max(core.zoom(), 4);
  core.easeTo({ center: [result.lon, result.lat], zoom: targetZoom, duration: 800 });
}

/** Shot-queue pins, personal-target rings, and the photo-lookup pin. */
export const targets: MapFeature = {
  id: 'targets',
  mount(core) {
    state.core = core;
  },
};
