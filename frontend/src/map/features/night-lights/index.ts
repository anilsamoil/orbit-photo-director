import { gibsBlackMarbleUrl } from '../../../tile-precache';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import { PREF_KEYS } from '../../map-core/prefs';
import { applyGlobalDim, setDimNightLights } from '../../overlays/global-dim';
import { CANONICAL_VIIRS_DATE, GLOBAL_DIM_LAYER, NIGHT_LIGHTS_LAYER } from './layers';

export { GLOBAL_DIM_LAYER, NIGHT_LIGHTS_LAYER } from './layers';

/** Night lights default off. Only the exact stored value `'1'` turns them on. */
export function readNightLightsVisible(): boolean {
  try {
    return localStorage.getItem(PREF_KEYS.nightLightsVisible) === '1';
  } catch {
    return false;
  }
}

type Runtime = {
  core: MapCore | null;
  visible: boolean;
  bound: boolean;
  errorLogged: boolean;
};

const state: Runtime = {
  core: null,
  visible: readNightLightsVisible(),
  bound: false,
  errorLogged: false,
};

setDimNightLights(state.visible);

function tiles(): string[] {
  return [`viirs-alpha://${gibsBlackMarbleUrl(CANONICAL_VIIRS_DATE)}`];
}

function applyNightLightsVisibility(): void {
  const core = state.core;
  if (!core) return;
  try {
    core.setVisibility(NIGHT_LIGHTS_LAYER.id, state.visible ? 'visible' : 'none');
  } catch {}
  setDimNightLights(state.visible);
  applyGlobalDim(core);
}

function reflectButton(): void {
  const btn = document.getElementById('toggle-night-lights');
  if (!btn) return;
  btn.classList.toggle('active', state.visible);
  btn.setAttribute('aria-pressed', state.visible ? 'true' : 'false');
  btn.title = state.visible
    ? 'VIIRS night lights shown — click to hide'
    : 'VIIRS night lights hidden — click to show (annual composite, slow first load)';
}

function armErrorHandler(): void {
  const core = state.core;
  if (!core) return;
  core.on('error', ({ sourceId }) => {
    if (sourceId !== 'viirs-night-lights') return;
    if (state.errorLogged) return;
    state.errorLogged = true;
    console.warn(
      '[map] VIIRS Black Marble 2016-01-01 tiles failed to load; ' +
      'GIBS may be down. Hiding night-lights layer — operator can re-toggle.',
    );
    state.visible = false;
    try {
      localStorage.setItem(PREF_KEYS.nightLightsVisible, '0');
    } catch {}
    applyNightLightsVisibility();
    reflectButton();
  });
}

function bindNightLightsToggle(): void {
  if (state.bound) return;
  const btn = document.getElementById('toggle-night-lights');
  if (!btn) return;
  armErrorHandler();
  reflectButton();
  btn.addEventListener('click', () => {
    if (state.errorLogged) {
      state.errorLogged = false;
      const core = state.core;
      if (core) core.setRasterTiles('viirs-night-lights', tiles());
    }
    state.visible = !state.visible;
    try {
      localStorage.setItem(PREF_KEYS.nightLightsVisible, state.visible ? '1' : '0');
    } catch {}
    reflectButton();
    applyNightLightsVisibility();
  });
  state.bound = true;
}

/** Put the dim and the raster on the map and apply the preference. */
export function refreshNightLights(core: MapCore): void {
  state.core = core;
  core.ensureLayer(GLOBAL_DIM_LAYER);
  core.ensureLayer(NIGHT_LIGHTS_LAYER);
  applyNightLightsVisibility();
}

/** Test-only. Lights off, stored key removed. The error latch and a bound
 *  button stay. */
export function resetNightLightsForTest(): void {
  state.visible = false;
  setDimNightLights(false);
  try {
    localStorage.removeItem(PREF_KEYS.nightLightsVisible);
  } catch {}
}

/** VIIRS Black Marble and the lights-only global dim. */
export const nightLights: MapFeature = {
  id: 'night-lights',
  mount(core) {
    refreshNightLights(core);
    bindNightLightsToggle();
  },
};
