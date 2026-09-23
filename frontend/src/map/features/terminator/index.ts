import { subsolarFeature, terminatorFeatures, terminatorNightPolygonFeatures } from '../../../terminator';
import type { Clock } from '../../map-core/clock';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import { PREF_KEYS } from '../../map-core/prefs';
import { applyGlobalDim, setDimTerminator } from '../../overlays/global-dim';
import { SUBSOLAR_LAYER, TERMINATOR_FILL_LAYER, TERMINATOR_LINE_LAYER } from './layers';

export { SUBSOLAR_LAYER, TERMINATOR_FILL_LAYER, TERMINATOR_LINE_LAYER } from './layers';

/** Terminator default on. A missing key is shown, and only `'0'` hides it. */
export function readTerminatorVisible(): boolean {
  try {
    const stored = localStorage.getItem(PREF_KEYS.terminatorVisible);
    return stored === null ? true : stored === '1';
  } catch {
    return true;
  }
}

type Runtime = {
  core: MapCore | null;
  clock: Clock | null;
  visible: boolean;
  bound: boolean;
};

const state: Runtime = {
  core: null,
  clock: null,
  visible: readTerminatorVisible(),
  bound: false,
};

setDimTerminator(state.visible);

function mapClock(): Clock {
  const clock = state.clock;
  if (!clock) throw new Error('bindTerminatorClock before using the terminator');
  return clock;
}

function applyTerminatorVisibility(): void {
  const core = state.core;
  if (!core) return;
  const vis = state.visible ? 'visible' : 'none';
  try {
    core.setVisibility(TERMINATOR_LINE_LAYER.id, vis);
    core.setVisibility(SUBSOLAR_LAYER.id, vis);
    core.setVisibility(TERMINATOR_FILL_LAYER.id, vis);
  } catch {}
  setDimTerminator(state.visible);
  applyGlobalDim(core);
}

function refreshTerminatorSources(): void {
  const core = state.core;
  if (!core) return;
  const when = new Date(mapClock().viewMs());
  core.setGeoJson('terminator-line', {
    type: 'FeatureCollection',
    features: terminatorFeatures(when),
  });
  core.setGeoJson('subsolar-point', {
    type: 'FeatureCollection',
    features: [subsolarFeature(when)],
  });
  core.setGeoJson('terminator-night-fill', {
    type: 'FeatureCollection',
    features: terminatorNightPolygonFeatures(when),
  });
}

/** Rebuild the GeoJSON at the view instant. Layers are added by the
 *  composition root so they keep the documented add sequence. */
export function refreshTerminatorGeometry(core: MapCore): void {
  state.core = core;
  refreshTerminatorSources();
}

function reflectButton(): void {
  const btn = document.getElementById('toggle-terminator');
  if (!btn) return;
  btn.classList.toggle('active', state.visible);
  btn.setAttribute('aria-pressed', state.visible ? 'true' : 'false');
  btn.title = state.visible
    ? 'Day-night terminator shown — click to hide'
    : 'Day-night terminator hidden — click to show';
}

function bindTerminatorToggle(): void {
  if (state.bound) return;
  const btn = document.getElementById('toggle-terminator');
  if (!btn) return;
  reflectButton();
  btn.addEventListener('click', () => {
    state.visible = !state.visible;
    try {
      localStorage.setItem(PREF_KEYS.terminatorVisible, state.visible ? '1' : '0');
    } catch {}
    reflectButton();
    applyTerminatorVisibility();
  });
  state.bound = true;
}

/** Rebuild the line, fill and subsolar point at the view instant, then
 *  show or hide them from the preference. */
export function refreshTerminator(core: MapCore): void {
  state.core = core;
  refreshTerminatorSources();
  core.ensureLayer(TERMINATOR_FILL_LAYER);
  core.ensureLayer(TERMINATOR_LINE_LAYER);
  core.ensureLayer(SUBSOLAR_LAYER);
  applyTerminatorVisibility();
}

/** Share the composition root's clock. Geometry follows every view-time
 *  change. */
export function bindTerminatorClock(clock: Clock): void {
  state.clock = clock;
  clock.onViewTime(() => {
    refreshTerminatorSources();
  });
}

/** Day-night terminator line, night fill, and subsolar point. Live, the
 *  geometry also ticks every 30 s so the line does not freeze. */
export const terminator: MapFeature = {
  id: 'terminator',
  mount(core) {
    refreshTerminator(core);
    bindTerminatorToggle();
    mapClock().every(30_000, () => {
      if (!mapClock().isScrubbed()) refreshTerminatorSources();
    });
  },
};
