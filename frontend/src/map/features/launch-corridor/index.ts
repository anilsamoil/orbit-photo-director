import { wrapLon } from '../../../geo';
import { openLaunchDetails, renderLegacyLaunchCard } from '../../../launch-card';
import { launchStore, type LaunchState } from '../../../launch-store';
import { selectLaunches } from '../../../launch-selectors';
import { getMapLaunchMode, setMapLaunchMode, subscribeMapLaunchMode } from '../../../map-launch-mode';
import type { PassEntry } from '../../../types';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import { boundsOf } from '../../map-core/geometry';
import type { Unsubscribe } from '../../map-core/vendor-map';
import { buildAscentFeatures, buildLaunchMapFeatures, legacyPassesInHorizon } from './geometry';

export { ascentPadLayer, ascentTrajectoryLayer } from './layers';
export { buildAscentFeatures, buildLaunchMapFeatures } from './geometry';

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
};

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
  const launchState: LaunchState = launchStore.getState();
  const now = core.clock.now();
  const { lines, pads } = launchState.artifact
    ? buildLaunchMapFeatures(launchState, now)
    : buildAscentFeatures(legacyPassesInHorizon(state.passes, now));
  core.setGeoJson('ascent-trajectory', { type: 'FeatureCollection', features: lines });
  core.setGeoJson('ascent-pad', { type: 'FeatureCollection', features: pads });
}

/** Show the corridor and hide it when launch mode is off. */
export function applyAscentLaunchVisibility(): void {
  const core = state.core;
  if (!core) return;
  const enabled = getMapLaunchMode();
  try {
    for (const layer of ['ascent-trajectory-layer', 'ascent-pad-layer'] as const) {
      const visibility = enabled ? 'visible' : 'none';
      if (core.hasLayer(layer) && core.visibilityOf(layer) !== visibility) {
        core.setVisibility(layer, visibility);
      }
    }
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
  launchStore.subscribe(() => {
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
      openLaunchDetails(String(props.event_id));
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

/** Fly to the launch site or fit the supplied corridor, and leave follow. */
export function focusLaunchOnMap(eventId: string): boolean {
  const core = state.core;
  if (!core) return false;
  const selection = selectLaunches(launchStore.getState(), nowMs(), 'map')
    .find(({ item }) => item.event_id === eventId);
  if (!selection) return false;
  const { site, trajectory } = selection.item;
  state.exitFollow();
  setMapLaunchMode(true);
  applyLaunchVisibility();
  const points: [number, number][] = [[site.lon, site.lat]];
  if (trajectory.quality !== 'unknown' && trajectory.source && trajectory.points.length >= 2) {
    let longitude = site.lon;
    for (const point of trajectory.points) {
      longitude += wrapLon(point.lon - longitude);
      points.push([longitude, point.lat]);
    }
  }
  const only = points[0];
  if (points.length === 1 && only) core.easeTo({ center: only, zoom: 4, duration: 600 });
  else core.fitBounds(boundsOf(points), { padding: 50, maxZoom: 5, duration: 600 });
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
}

/** Ascent corridor and pad. Launch mode swaps these with the target pins. */
export const launchCorridor: MapFeature = {
  id: 'launch-corridor',
  mount(core) {
    state.core = core;
  },
};
