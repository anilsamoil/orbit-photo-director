import { wrapLon } from '../../../geo';
import { openLaunchDetails, renderLegacyLaunchCard } from '../../../launch-card';
import { launchCatalog, subscribeLaunchSlots } from '../../../launch-catalog';
import {
  activeHazardFeatures,
  HAZARD_LABEL,
  loadPublishedHazards,
  STARSHIP_FLIGHT15_EVENT_ID,
  type HazardBundle,
} from '../../../launch-hazards';
import { openTierDetails } from '../../../launch-tier-card';
import type { TierLaunch } from '../../../launch-tiers';
import { launchStore, type LaunchState } from '../../../launch-store';
import { selectLaunches } from '../../../launch-selectors';
import { getMapLaunchMode, setMapLaunchMode, subscribeMapLaunchMode } from '../../../map-launch-mode';
import type { PassEntry } from '../../../types';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import { boundsOf } from '../../map-core/geometry';
import type { Unsubscribe } from '../../map-core/vendor-map';
import { buildAscentFeatures, buildLaunchMapFeatures, buildTierMapFeatures, legacyPassesInHorizon } from './geometry';

export { ascentPadLayer, ascentTrajectoryLayer, launchHazardFillLayer, launchHazardOutlineLayer } from './layers';
export { buildAscentFeatures, buildLaunchMapFeatures, buildTierMapFeatures } from './geometry';

type TargetSide = {
  refreshIfPresent(): void;
  refresh(): void;
  applyVisibility(): void;
};

type Runtime = {
  core: MapCore | null;
  passes: PassEntry[];
  modeUnsub: (() => void) | null;
  styleUnsub: Unsubscribe | null;
  styleCore: MapCore | null;
  storeBound: boolean;
  exitFollow: () => void;
  targets: TargetSide;
  hazardBundle: HazardBundle | null;
  hazardPending: boolean;
  hazardFailed: boolean;
  hazardSignature: string;
  hazardFeatures: GeoJSON.Feature[];
};

const state: Runtime = {
  core: null,
  passes: [],
  modeUnsub: null,
  styleUnsub: null,
  styleCore: null,
  storeBound: false,
  exitFollow() {},
  targets: {
    refreshIfPresent() {},
    refresh() {},
    applyVisibility() {},
  },
  hazardBundle: null,
  hazardPending: false,
  hazardFailed: false,
  hazardSignature: '',
  hazardFeatures: [],
};

const LAUNCH_LAYERS = [
  'launch-hazard-fill-layer',
  'launch-hazard-outline-layer',
  'ascent-trajectory-layer',
  'ascent-pad-layer',
] as const;

/** Tests install the published file without a network fetch. */
export function useHazardBundleForTest(bundle: HazardBundle | null): void {
  state.hazardBundle = bundle;
  state.hazardPending = false;
  state.hazardFailed = bundle === null;
  state.hazardSignature = '';
}

function paintHazardCaption(): void {
  const node = document.getElementById('launch-hazard-caption');
  if (!node) return;
  if (node.textContent !== HAZARD_LABEL) node.textContent = HAZARD_LABEL;
  node.hidden = !(getMapLaunchMode() && state.hazardFeatures.length > 0);
}

function hazardSignature(features: readonly GeoJSON.Feature[]): string {
  return features.map((feature) => String(feature.id ?? '')).join(',');
}

/** Draw the published polygons for the wall-clock instant, not the scrubbed view. */
export function syncLaunchHazards(now: number): void {
  const core = state.core;
  if (!core) return;
  if (!state.hazardBundle && !state.hazardPending && !state.hazardFailed && import.meta.env.MODE !== 'test') {
    state.hazardPending = true;
    void loadPublishedHazards(fetch).then((bundle) => {
      state.hazardBundle = bundle;
      state.hazardFailed = bundle === null;
    }).finally(() => {
      state.hazardPending = false;
      const live = state.core;
      if (live) syncLaunchHazards(live.clock.now());
    });
  }
  const attempt = state.hazardBundle ? launchCatalog.attempt(STARSHIP_FLIGHT15_EVENT_ID, now) : null;
  const features = state.hazardBundle ? activeHazardFeatures(state.hazardBundle, now, attempt) : [];
  const signature = hazardSignature(features);
  state.hazardFeatures = features;
  if (signature !== state.hazardSignature || !core.hasSource('launch-hazards')) {
    state.hazardSignature = signature;
    core.setGeoJson('launch-hazards', { type: 'FeatureCollection', features });
  }
  paintHazardCaption();
}

/** Target pins stay in their own feature. The root installs these so one
 *  launch-mode subscription can still refresh both sides. */
export function bindLaunchTargets(targets: TargetSide): void {
  state.targets = targets;
}

/** Focus leaves follow. The root installs the follow feature's exit. */
export function bindExitFollow(exit: () => void): void {
  state.exitFollow = exit;
}

export function noteLaunchCore(core: MapCore | null): void {
  state.core = core;
}

export function setLaunchPasses(passes: PassEntry[]): void {
  state.passes = passes;
}

function nowMs(): number {
  const core = state.core;
  if (!core) throw new Error('launch corridor has no map');
  return core.clock.now();
}

/** Rebuild ascent sources from the artifact, or from legacy passes inside a week. */
export function refreshAscentTrajectorySource(): void {
  const core = state.core;
  if (!core) return;
  const now = core.clock.now();
  const tiers = launchCatalog.read(now);
  const launchState: LaunchState = launchStore.getState();
  const { lines, pads } = tiers
    ? buildTierMapFeatures(tiers, now)
    : launchState.artifact
      ? buildLaunchMapFeatures(launchState, now)
      : buildAscentFeatures(legacyPassesInHorizon(state.passes, now));
  core.setGeoJson('ascent-trajectory', { type: 'FeatureCollection', features: lines });
  core.setGeoJson('ascent-pad', { type: 'FeatureCollection', features: pads });
  syncLaunchHazards(now);
}

/** Show the corridor and hide it when launch mode is off. */
export function applyAscentLaunchVisibility(): void {
  const core = state.core;
  if (!core) return;
  const enabled = getMapLaunchMode();
  try {
    for (const layer of LAUNCH_LAYERS) {
      const visibility = enabled ? 'visible' : 'none';
      if (core.hasLayer(layer) && core.visibilityOf(layer) !== visibility) {
        core.setVisibility(layer, visibility);
      }
    }
    paintHazardCaption();
  } catch {}
}

function applyLaunchVisibility(): void {
  applyAscentLaunchVisibility();
  state.targets.applyVisibility();
}

/** One mode subscription and one styledata listener, shared with the target side. */
export function syncMapLaunchMode(): void {
  if (!state.modeUnsub) {
    state.modeUnsub = subscribeMapLaunchMode((enabled) => {
      const core = state.core;
      core?.closePopup(enabled ? 'target' : 'launch');
      if (!core) return;
      if (core.hasSource('ascent-pad')) refreshAscentTrajectorySource();
      state.targets.refreshIfPresent();
      applyLaunchVisibility();
    });
  }
  const core = state.core;
  if (core && state.styleCore !== core) {
    state.styleUnsub?.();
    state.styleUnsub = core.on('styledata', applyLaunchVisibility);
    state.styleCore = core;
  }
  applyLaunchVisibility();
}

export { syncMapLaunchMode as _syncMapLaunchModeForTest };

/** Subscribe once to launch-artifact updates. A missing pad source skips the refresh. */
export function bindLaunchStore(): void {
  if (state.storeBound) return;
  state.storeBound = true;
  subscribeLaunchSlots(() => {
    if (!state.core?.hasSource('ascent-pad')) return;
    refreshAscentTrajectorySource();
    state.targets.refresh();
  });
}

/** Pad tap opens the launch card, or the legacy popup when no artifact is loaded. */
export function bindAscentPad(host: MapCore): void {
  host.onLayer('click', 'ascent-pad-layer', (event) => {
    const feature = event.features[0];
    if (!feature || feature.geometry.type !== 'Point') return;
    const coords = (feature.geometry.coordinates as [number, number]).slice() as [number, number];
    const props = feature.properties ?? {};
    if (props.event_id) {
      const eventId = String(props.event_id);
      const now = state.core?.clock.now();
      const tiers = typeof now === 'number' ? launchCatalog.read(now) : null;
      const found = props.catalog === 'tier' && tiers ? tiers.find(eventId) : null;
      if (found && tiers?.mapPins.some((pin) => pin.eventId === eventId)) {
        openTierDetails(found);
        return;
      }
      openLaunchDetails(eventId);
      return;
    }
    const pass = state.passes.find((entry) => entry.target_id === props.target_id);
    if (!pass || launchStore.getState().artifact) return;
    const body = renderLegacyLaunchCard(pass, true);
    state.core?.openPopup({ at: coords, content: body, owner: 'launch' });
  });
  host.onLayer('mouseenter', 'ascent-pad-layer', () => {
    state.core?.setCursor('pointer');
  });
  host.onLayer('mouseleave', 'ascent-pad-layer', () => {
    state.core?.setCursor('');
  });
}

function fitLaunch(core: MapCore, points: [number, number][]): void {
  state.exitFollow();
  setMapLaunchMode(true);
  applyLaunchVisibility();
  const only = points[0];
  if (points.length === 1 && only) core.easeTo({ center: only, zoom: 4, duration: 600 });
  else core.fitBounds(boundsOf(points), { padding: 50, maxZoom: 5, duration: 600 });
}

function tierFocusPoints(pin: TierLaunch): [number, number][] {
  const points: [number, number][] = [[pin.site.lon, pin.site.lat]];
  if (pin.eventId === STARSHIP_FLIGHT15_EVENT_ID) {
    for (const feature of state.hazardFeatures) {
      if (feature.geometry.type !== 'Polygon') continue;
      const ring = feature.geometry.coordinates[0];
      if (!ring) continue;
      for (const position of ring) {
        const lon = position[0];
        const lat = position[1];
        if (typeof lon !== 'number' || typeof lat !== 'number') continue;
        points.push([lon, lat]);
      }
    }
  }
  if (!pin.corridor) return points;
  let longitude = pin.site.lon;
  for (const point of pin.corridor.points) {
    longitude += wrapLon(point.lon - longitude);
    points.push([longitude, point.lat]);
  }
  return points;
}

/** Fly to the launch site or fit the supplied corridor, and leave follow. */
export function focusLaunchOnMap(eventId: string): boolean {
  const core = state.core;
  if (!core) return false;
  const now = nowMs();
  const tiers = launchCatalog.read(now);
  if (tiers) {
    const pin = tiers.mapPins.find((launch) => launch.eventId === eventId);
    if (!pin) return false;
    fitLaunch(core, tierFocusPoints(pin));
    return true;
  }
  const selection = selectLaunches(launchStore.getState(), now, 'map')
    .find(({ item }) => item.event_id === eventId);
  if (!selection) return false;
  const { site, trajectory } = selection.item;
  const points: [number, number][] = [[site.lon, site.lat]];
  if (trajectory.quality !== 'unknown' && trajectory.source && trajectory.points.length >= 2) {
    let longitude = site.lon;
    for (const point of trajectory.points) {
      longitude += wrapLon(point.lon - longitude);
      points.push([longitude, point.lat]);
    }
  }
  fitLaunch(core, points);
  return true;
}

/** Drop the mode subscription and the styledata listener. The artifact
 *  subscription stays, matching the previous reset. */
export function resetLaunchForTest(): void {
  state.modeUnsub?.();
  state.modeUnsub = null;
  state.core?.closePopup('target');
  state.core?.closePopup('launch');
  state.styleUnsub?.();
  state.styleUnsub = null;
  state.styleCore = null;
  state.hazardBundle = null;
  state.hazardPending = false;
  state.hazardFailed = false;
  state.hazardSignature = '';
  state.hazardFeatures = [];
}

/** Ascent corridor and pad. Launch mode swaps these with the target pins. */
export const launchCorridor: MapFeature = {
  id: 'launch-corridor',
  mount(core) {
    state.core = core;
  },
};
