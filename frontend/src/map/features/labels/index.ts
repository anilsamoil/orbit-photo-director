import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import type { RasterLayer } from '../../map-core/layer-spec';
import { PREF_KEYS } from '../../map-core/prefs';

/** Country and city labels. Opacity matches the layer `renderMap` used
 *  to add on top of every other overlay. */
const LABELS_LAYER: RasterLayer = {
  id: 'esri-labels-reference-layer',
  type: 'raster',
  source: 'esri-labels-reference',
  paint: { 'raster-opacity': 0.85 },
};

/** Labels default on. A missing key is shown, and only `'0'` hides them. */
export function readLabelsVisible(): boolean {
  try {
    const stored = localStorage.getItem(PREF_KEYS.labelsVisible);
    return stored === null ? true : stored === '1';
  } catch {
    return true;
  }
}

type Runtime = {
  core: MapCore | null;
  visible: boolean;
  bound: boolean;
};

const state: Runtime = {
  core: null,
  visible: readLabelsVisible(),
  bound: false,
};

function applyLabelsVisibility(): void {
  const core = state.core;
  if (!core) return;
  try {
    core.setVisibility(LABELS_LAYER.id, state.visible ? 'visible' : 'none');
  } catch {}
}

function reflectButton(): void {
  const btn = document.getElementById('toggle-labels');
  if (!btn) return;
  btn.classList.toggle('active', state.visible);
  btn.setAttribute('aria-pressed', state.visible ? 'true' : 'false');
  btn.title = state.visible
    ? 'Country/city labels shown — click to hide'
    : 'Country/city labels hidden — click to show';
}

function bindLabelsToggle(): void {
  if (state.bound) return;
  const btn = document.getElementById('toggle-labels');
  if (!btn) return;
  reflectButton();
  btn.addEventListener('click', () => {
    state.visible = !state.visible;
    try {
      localStorage.setItem(PREF_KEYS.labelsVisible, state.visible ? '1' : '0');
    } catch {}
    reflectButton();
    applyLabelsVisibility();
  });
  state.bound = true;
}

/** Put the labels layer on the map and show or hide it from the preference.
 *  Called on every `renderMap`, including a refresh that does not remount. */
export function refreshLabels(core: MapCore): void {
  state.core = core;
  core.ensureLayer(LABELS_LAYER);
  applyLabelsVisibility();
}

/** Test-only. The in-memory flag returns to shown and the stored key is
 *  removed. A bound button stays bound. */
export function resetLabelsForTest(): void {
  state.visible = true;
  try {
    localStorage.removeItem(PREF_KEYS.labelsVisible);
  } catch {}
}

/** Esri reference labels above the other overlays. The source stays in
 *  `buildStyle`; this feature adds the layer and owns the dock toggle. */
export const labels: MapFeature = {
  id: 'labels',
  mount(core) {
    refreshLabels(core);
    bindLabelsToggle();
  },
};
