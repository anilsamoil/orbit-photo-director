import { wrapLon } from '../../../geo';
import { openLaunchDetails, renderLegacyLaunchCard } from '../../../launch-card';
import { launchCatalog, subscribeLaunchSlots } from '../../../launch-catalog';
import {
  activeHazardFeatures,
  HAZARD_LABEL,
  loadPublishedHazards,
  publishHazardNotes,
  STARSHIP_FLIGHT15_EVENT_ID,
  type HazardBundle,
  type HazardLoad,
  type HazardNote,
} from '../../../launch-hazards';
import { tierWindowText } from '../../../launch-tiers';
import { openTierDetails } from '../../../launch-tier-card';
import type { TierLaunch } from '../../../launch-tiers';
import { launchStore, type LaunchState } from '../../../launch-store';
import { selectLaunches } from '../../../launch-selectors';
import { getMapLaunchMode, setMapLaunchMode, subscribeMapLaunchMode } from '../../../map-launch-mode';
import type { PassEntry } from '../../../types';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import { boundsOf } from '../../map-core/geometry';
import type { FitPadding, Unsubscribe } from '../../map-core/vendor-map';
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
  hazardEpoch: number;
  hazardStarted: boolean;
  hazardSignature: string;
  hazardFeatures: GeoJSON.Feature[];
  selectedEventId: string | null;
  pendingFocusId: string | null;
  clicksCore: MapCore | null;
  focusWatch: MapCore | null;
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
  hazardEpoch: 0,
  hazardStarted: false,
  hazardSignature: '',
  hazardFeatures: [],
  selectedEventId: null,
  pendingFocusId: null,
  clicksCore: null,
  focusWatch: null,
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
  state.hazardEpoch += 1;
  state.hazardSignature = '';
}

function notesOf(features: readonly GeoJSON.Feature[]): HazardNote[] {
  const notes: HazardNote[] = [];
  for (const feature of features) {
    const props = feature.properties;
    if (!props) continue;
    const noticeId = props.notice_id;
    const areaId = props.area_id;
    const domain = props.domain;
    const restriction = props.restriction_class;
    const windowStart = props.window_start;
    const windowEnd = props.window_end;
    const sourceUrl = props.source_url;
    if (typeof noticeId !== 'string' || typeof areaId !== 'string') continue;
    if (typeof domain !== 'string' || typeof restriction !== 'string') continue;
    if (typeof windowStart !== 'string' || typeof windowEnd !== 'string') continue;
    if (typeof sourceUrl !== 'string') continue;
    notes.push({ noticeId, areaId, domain, restriction, windowStart, windowEnd, sourceUrl });
  }
  return notes;
}

function applyHazardLoad(result: HazardLoad): void {
  if (result.kind === 'current') state.hazardBundle = result.bundle;
  else if (result.kind === 'withdrawn') state.hazardBundle = null;
}

/** Fetch the hazard file again. A newer catalog refresh supersedes an older reply. */
export function reloadLaunchHazards(fetcher: typeof fetch = fetch): Promise<void> {
  const epoch = state.hazardEpoch + 1;
  state.hazardEpoch = epoch;
  state.hazardStarted = true;
  state.hazardPending = true;
  return loadPublishedHazards(fetcher).then((result) => {
    if (epoch !== state.hazardEpoch) return;
    applyHazardLoad(result);
  }).catch(() => {
    if (epoch !== state.hazardEpoch) return;
  }).then(() => {
    if (epoch !== state.hazardEpoch) return;
    state.hazardPending = false;
    const live = state.core;
    if (!live) return;
    paintHazards(live, live.clock.now());
    settlePendingFocus(live);
  });
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

function eligibleAttempt(now: number): { startMs: number; endMs: number } | null {
  const pin = launchCatalog.read(now)?.mapPins.find((launch) => launch.eventId === STARSHIP_FLIGHT15_EVENT_ID);
  if (!pin) return null;
  if (state.selectedEventId !== null && state.selectedEventId !== STARSHIP_FLIGHT15_EVENT_ID) return null;
  return launchCatalog.attempt(STARSHIP_FLIGHT15_EVENT_ID, now);
}

function paintHazards(core: MapCore, now: number): void {
  const attempt = state.hazardBundle ? eligibleAttempt(now) : null;
  const features = state.hazardBundle ? activeHazardFeatures(state.hazardBundle, now, attempt) : [];
  const signature = hazardSignature(features);
  state.hazardFeatures = features;
  publishHazardNotes(notesOf(features));
  if (signature !== state.hazardSignature || !core.hasSource('launch-hazards')) {
    state.hazardSignature = signature;
    core.setGeoJson('launch-hazards', { type: 'FeatureCollection', features });
  }
  paintHazardCaption();
}

function settlePendingFocus(core: MapCore): void {
  const pending = state.pendingFocusId;
  if (!pending || pending !== STARSHIP_FLIGHT15_EVENT_ID) return;
  if (!state.hazardFeatures.length || !getMapLaunchMode()) return;
  if (state.selectedEventId !== pending || !getMapLaunchMode()) {
    state.pendingFocusId = null;
    return;
  }
  const now = core.clock.now();
  const pin = launchCatalog.read(now)?.mapPins.find((launch) => launch.eventId === pending);
  if (!pin) {
    state.pendingFocusId = null;
    return;
  }
  if (!state.hazardFeatures.length) return;
  state.pendingFocusId = null;
  fitLaunch(core, tierFocusPoints(pin), true);
}

/** Draw the published polygons for the wall-clock instant, not the scrubbed view. */
export function syncLaunchHazards(now: number): void {
  const core = state.core;
  if (!core) return;
  if (!state.hazardStarted && import.meta.env.MODE !== 'test') {
    void reloadLaunchHazards(fetch);
  }
  paintHazards(core, now);
  settlePendingFocus(core);
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
      if (!enabled) state.pendingFocusId = null;
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
    if (import.meta.env.MODE !== 'test') void reloadLaunchHazards(fetch);
    refreshAscentTrajectorySource();
    state.targets.refresh();
  });
}

function watchCamera(core: MapCore): void {
  if (state.focusWatch === core) return;
  state.focusWatch = core;
  core.on('dragstart', () => {
    state.pendingFocusId = null;
  });
  core.on('zoomstart', (event) => {
    if (event.byUser) state.pendingFocusId = null;
  });
  core.on('rotatestart', (event) => {
    if (event.byUser) state.pendingFocusId = null;
  });
}

function hazardPopup(features: { properties: Record<string, unknown> | null }[]): HTMLElement {
  const content = document.createElement('div');
  const title = document.createElement('p');
  title.textContent = 'Published hazard areas \u2014 not a flight path or navigation guidance';
  content.append(title);
  for (const feature of features) {
    const props = feature.properties;
    if (!props) continue;
    const start = Date.parse(String(props.window_start ?? ''));
    const end = Date.parse(String(props.window_end ?? ''));
    const when = Number.isFinite(start) && Number.isFinite(end) ? tierWindowText(start, end) : '';
    const fact = document.createElement('p');
    fact.textContent = `${String(props.notice_id)} area ${String(props.area_id)}, ${String(props.domain)} ${String(props.restriction_class)}. ${when}`;
    const link = document.createElement('a');
    link.href = String(props.source_url ?? '');
    link.rel = 'noopener noreferrer';
    link.target = '_blank';
    link.textContent = String(props.source_url ?? '');
    content.append(fact, link);
  }
  return content;
}

function bindHazardClicks(host: MapCore): void {
  if (state.clicksCore === host) return;
  state.clicksCore = host;
  host.onLayer('click', 'launch-hazard-fill-layer', (event) => {
    host.openPopup({ at: event.lngLat, content: hazardPopup(event.features), owner: 'launch' });
  });
}

function hazardFitPadding(): FitPadding {
  const pane = document.getElementById('map-pane')?.getBoundingClientRect();
  if (!pane || pane.width < 1 || pane.height < 1) return 50;
  const boxOf = (selector: string): DOMRect | null => document.querySelector(selector)?.getBoundingClientRect() ?? null;
  const toolbar = boxOf('.map-toolbar');
  const dock = boxOf('.map-control-dock');
  const command = boxOf('.map-controls-time');
  const card = boxOf('#map-launch-coverage');
  const live = (box: DOMRect | null): box is DOMRect => !!box && box.width >= 1 && box.height >= 1;
  let top = 16;
  let right = 16;
  let bottom = 16;
  let left = 16;
  if (live(toolbar) && toolbar.bottom > pane.top) top = Math.max(top, Math.round(toolbar.bottom - pane.top) + 12);
  if (live(command) && command.top < pane.bottom) bottom = Math.max(bottom, Math.round(pane.bottom - command.top) + 12);
  if (live(dock) && dock.width < pane.width * 0.45) right = Math.max(right, Math.round(pane.right - dock.left) + 12);
  if (live(card) && !cardHidden(card)) {
    if (card.width > pane.width * 0.6) top = Math.max(top, Math.round(card.bottom - pane.top) + 12);
    else if (card.left - pane.left < pane.width * 0.5) left = Math.max(left, Math.round(card.right - pane.left) + 12);
    else right = Math.max(right, Math.round(pane.right - card.left) + 12);
  }
  return {
    top: Math.min(top, Math.round(pane.height * 0.55)),
    right: Math.min(right, Math.round(pane.width * 0.34)),
    bottom: Math.min(bottom, Math.round(pane.height * 0.42)),
    left: Math.min(left, Math.round(pane.width * 0.46)),
  };
}

function cardHidden(box: DOMRect): boolean {
  const node = document.getElementById('map-launch-coverage');
  return !node || node.hidden || box.height < 1;
}

/** Pad tap opens the launch card, or the legacy popup when no artifact is loaded. */
export function bindAscentPad(host: MapCore): void {
  watchCamera(host);
  bindHazardClicks(host);
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

function fitLaunch(core: MapCore, points: [number, number][], hazard: boolean): void {
  state.exitFollow();
  setMapLaunchMode(true);
  applyLaunchVisibility();
  const only = points[0];
  if (!hazard) {
    if (points.length === 1 && only) core.easeTo({ center: only, zoom: 4, duration: 600 });
    else core.fitBounds(boundsOf(points), { padding: 50, maxZoom: 5, duration: 600 });
    return;
  }
  const bearing = core.bearing();
  core.fitBounds(boundsOf(points), {
    padding: hazardFitPadding(),
    maxZoom: 5,
    duration: Math.abs(bearing) > 0.5 ? 0 : 600,
    bearing,
  });
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
    state.selectedEventId = eventId;
    const waiting = eventId === STARSHIP_FLIGHT15_EVENT_ID
      && state.hazardFeatures.length === 0
      && (state.hazardPending || state.hazardBundle === null);
    state.pendingFocusId = waiting ? eventId : null;
    syncLaunchHazards(now);
    const hazard = eventId === STARSHIP_FLIGHT15_EVENT_ID && state.hazardFeatures.length > 0;
    fitLaunch(core, tierFocusPoints(pin), hazard);
    return true;
  }
  const selection = selectLaunches(launchStore.getState(), now, 'map')
    .find(({ item }) => item.event_id === eventId);
  if (!selection) return false;
  state.selectedEventId = eventId;
  state.pendingFocusId = null;
  const { site, trajectory } = selection.item;
  const points: [number, number][] = [[site.lon, site.lat]];
  if (trajectory.quality !== 'unknown' && trajectory.source && trajectory.points.length >= 2) {
    let longitude = site.lon;
    for (const point of trajectory.points) {
      longitude += wrapLon(point.lon - longitude);
      points.push([longitude, point.lat]);
    }
  }
  fitLaunch(core, points, false);
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
  state.hazardEpoch += 1;
  state.hazardStarted = false;
  state.hazardSignature = '';
  state.hazardFeatures = [];
  state.selectedEventId = null;
  state.pendingFocusId = null;
  publishHazardNotes([]);
}

/** Ascent corridor and pad. Launch mode swaps these with the target pins. */
export const launchCorridor: MapFeature = {
  id: 'launch-corridor',
  mount(core) {
    state.core = core;
  },
};
