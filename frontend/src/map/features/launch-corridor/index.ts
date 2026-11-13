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
  refreshBound: boolean;
  hazardArmed: boolean;
  userMoved: boolean;
  hazardFrameKey: string;
  inputBound: boolean;
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
  refreshBound: false,
  hazardArmed: false,
  userMoved: false,
  hazardFrameKey: '',
  inputBound: false,
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
    const checkedAt = props.checked_at;
    const qualification = props.qualification;
    if (typeof noticeId !== 'string' || typeof areaId !== 'string') continue;
    if (typeof domain !== 'string' || typeof restriction !== 'string') continue;
    if (typeof windowStart !== 'string' || typeof windowEnd !== 'string') continue;
    if (typeof sourceUrl !== 'string' || typeof checkedAt !== 'string' || typeof qualification !== 'string') continue;
    notes.push({ noticeId, areaId, domain, restriction, windowStart, windowEnd, sourceUrl, checkedAt, qualification });
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
  return features.map((feature) => {
    const ring = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : undefined;
    const coords = (ring ?? []).map((position) => `${position[0]},${position[1]}`).join(';');
    const props = feature.properties;
    return [
      String(feature.id ?? ''),
      coords,
      String(props?.restriction_class ?? ''),
      String(props?.checked_at ?? ''),
      String(props?.qualification ?? ''),
      String(props?.source_url ?? ''),
      String(props?.window_start ?? ''),
      String(props?.window_end ?? ''),
    ].join(':');
  }).join('|');
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

/** Fetch hazards again after a catalog refresh, including one that keeps the same pins. */
export function onHazardCatalogRefresh(fetcher: typeof fetch = fetch): Promise<void> {
  if (!state.core) return Promise.resolve();
  return reloadLaunchHazards(fetcher);
}

/** Subscribe once to launch-artifact updates. A missing pad source skips the refresh. */
export function bindLaunchStore(): void {
  if (!state.refreshBound) {
    state.refreshBound = true;
    launchCatalog.subscribeRefresh(() => {
      void onHazardCatalogRefresh();
    });
  }
  if (state.storeBound) return;
  state.storeBound = true;
  subscribeLaunchSlots(() => {
    if (!state.core?.hasSource('ascent-pad')) return;
    refreshAscentTrajectorySource();
    state.targets.refresh();
  });
}

function watchCamera(core: MapCore): void {
  if (state.focusWatch === core) return;
  state.focusWatch = core;
  core.on('dragstart', () => {
    state.pendingFocusId = null;
    state.userMoved = true;
    state.hazardArmed = false;
  });
  core.on('zoomstart', (event) => {
    if (!event.byUser) return;
    state.pendingFocusId = null;
    state.userMoved = true;
    state.hazardArmed = false;
  });
  core.on('rotatestart', (event) => {
    if (!event.byUser) return;
    state.pendingFocusId = null;
    state.userMoved = true;
    state.hazardArmed = false;
  });
  core.on('moveend', () => {
    if (!state.hazardArmed || state.userMoved) return;
    frameHazards(core);
  });
  if (state.inputBound) return;
  state.inputBound = true;
  const releaseAim = (): void => {
    state.pendingFocusId = null;
    state.userMoved = true;
    state.hazardArmed = false;
  };
  window.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    releaseAim();
  });
  window.addEventListener('wheel', (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const pane = document.getElementById('map-pane');
    if (!pane || (target !== pane && !pane.contains(target))) return;
    releaseAim();
  }, { passive: true });
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
    fact.textContent = `${String(props.notice_id)} area ${String(props.area_id)}, ${String(props.domain)} ${String(props.restriction_class)}. ${when} Checked ${String(props.checked_at ?? '')}. ${String(props.qualification ?? '')}`;
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
  const pad = { top: 16, right: 16, bottom: 16, left: 16 };
  const selectors = [
    '.map-toolbar',
    '.map-control-dock',
    '.map-controls-time',
    '#map-launch-coverage',
    '#map-legend-toggle',
    '#map-legend-panel',
    '#map-chrome-toggle',
    '.maplibregl-ctrl-top-left',
    '.maplibregl-ctrl-bottom-right',
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (!node || (node instanceof HTMLElement && node.hidden)) continue;
    const box = node.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    contributeInset(box, pane, pad);
  }
  return pad;
}

function contributeInset(box: DOMRect, pane: DOMRect, pad: { top: number; right: number; bottom: number; left: number }): void {
  const topGap = box.top - pane.top;
  const bottomGap = pane.bottom - box.bottom;
  const leftGap = box.left - pane.left;
  const rightGap = pane.right - box.right;
  if (topGap <= 80 && box.height <= 140 && box.width >= pane.width * 0.25) {
    pad.top = Math.max(pad.top, Math.round(box.bottom - pane.top) + 12);
    return;
  }
  if (rightGap <= 24 && box.width <= pane.width * 0.45) {
    pad.right = Math.max(pad.right, Math.round(pane.right - box.left) + 12);
    return;
  }
  if (leftGap <= 40 && box.width <= Math.min(160, pane.width * 0.25)) {
    pad.left = Math.max(pad.left, Math.round(box.right - pane.left) + 12);
    return;
  }
  if (leftGap <= 80 && box.width <= pane.width * 0.6 && box.height >= 100) {
    pad.left = Math.max(pad.left, Math.round(box.right - pane.left) + 12);
    return;
  }
  if (bottomGap <= 24) {
    pad.bottom = Math.max(pad.bottom, Math.round(pane.bottom - box.top) + 12);
    return;
  }
  const midY = box.top + box.height / 2;
  if (midY > pane.top + pane.height * 0.55 && box.width > pane.width * 0.4) {
    pad.bottom = Math.max(pad.bottom, Math.round(pane.bottom - box.top) + 12);
    return;
  }
  if (topGap <= 160 && box.width > pane.width * 0.6) {
    pad.top = Math.max(pad.top, Math.round(box.bottom - pane.top) + 12);
  }
}

function frameKey(bearing: number, padding: FitPadding): string {
  return `${bearing.toFixed(2)}:${JSON.stringify(padding)}`;
}

function frameHazards(core: MapCore): void {
  if (!state.hazardArmed || state.userMoved || !state.hazardFeatures.length || !getMapLaunchMode()) return;
  const pin = launchCatalog.read(core.clock.now())?.mapPins.find((launch) => launch.eventId === STARSHIP_FLIGHT15_EVENT_ID);
  if (!pin) return;
  const bearing = core.bearing();
  const padding = hazardFitPadding();
  const key = frameKey(bearing, padding);
  if (key === state.hazardFrameKey) return;
  state.hazardFrameKey = key;
  core.fitBounds(boundsOf(tierFocusPoints(pin)), {
    padding,
    maxZoom: 6,
    duration: 0,
    bearing,
  });
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
  state.hazardArmed = true;
  state.userMoved = false;
  state.hazardFrameKey = '';
  frameHazards(core);
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
  state.hazardArmed = false;
  state.userMoved = false;
  state.hazardFrameKey = '';
  publishHazardNotes([]);
}

/** Ascent corridor and pad. Launch mode swaps these with the target pins. */
export const launchCorridor: MapFeature = {
  id: 'launch-corridor',
  mount(core) {
    state.core = core;
  },
};
