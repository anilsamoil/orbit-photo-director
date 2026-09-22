import type { Clock } from '../../map-core/clock';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import { PREF_KEYS } from '../../map-core/prefs';
import { futureOrbitGroundTrackFeatures } from './geometry';
import { ISS_TRACK_LAYER } from './layers';

export { splitByIllumination, splitTrackByOrbit } from './geometry';
export { ISS_TRACK_LAYER } from './layers';

/** Multi-orbit defaults off. Only the exact stored value `'1'` turns it on. */
export function readMultiOrbitVisible(): boolean {
  try {
    return localStorage.getItem(PREF_KEYS.multiOrbitVisible) === '1';
  } catch {
    return false;
  }
}

type Runtime = {
  core: MapCore | null;
  multiOrbit: boolean;
  bound: boolean;
};

const state: Runtime = {
  core: null,
  multiOrbit: readMultiOrbitVisible(),
  bound: false,
};

function lookaheadMinutes(core: MapCore): number {
  const nowMs = core.clock.now();
  const view = core.clock.viewTime();
  if (view.kind !== 'scrubbed') return 0;
  return Math.max(0, (view.atMs - nowMs) / 60_000);
}

function write(core: MapCore): void {
  const track = core.view().track;
  if (!track) return;
  const nowMs = core.clock.now();
  core.setGeoJson('iss-track', {
    type: 'FeatureCollection',
    features: futureOrbitGroundTrackFeatures(track, lookaheadMinutes(core), nowMs, state.multiOrbit),
  });
}

function reflectButton(): void {
  const btn = document.getElementById('toggle-multi-orbit');
  if (!btn) return;
  btn.classList.toggle('active', state.multiOrbit);
  btn.setAttribute('aria-pressed', state.multiOrbit ? 'true' : 'false');
  btn.title = state.multiOrbit
    ? 'Showing 4 future orbits — click to show just the current orbit'
    : 'Showing current orbit only — click to show next 4 orbits';
}

function bindMultiOrbitToggle(): void {
  if (state.bound) return;
  const btn = document.getElementById('toggle-multi-orbit');
  if (!btn) return;
  reflectButton();
  btn.addEventListener('click', () => {
    state.multiOrbit = !state.multiOrbit;
    try {
      localStorage.setItem(PREF_KEYS.multiOrbitVisible, state.multiOrbit ? '1' : '0');
    } catch {}
    reflectButton();
    const core = state.core;
    if (core) write(core);
  });
  state.bound = true;
}

/** Rebuild the ground track at the view instant and put the layer on
 *  the map. A missing dock button is retried on the next call. */
export function refreshGroundTrack(core: MapCore): void {
  state.core = core;
  write(core);
  core.ensureLayer(ISS_TRACK_LAYER);
  bindMultiOrbitToggle();
}

/** Share the composition root's clock. A scrub rebuilds the track even
 *  when `renderMap` does not run again. */
export function bindGroundTrackClock(clock: Clock): void {
  clock.onViewTime(() => {
    const core = state.core;
    if (core) write(core);
  });
}

/** ISS ground track. One orbit, or the forward orbits when the operator asks. */
export const groundTrack: MapFeature = {
  id: 'ground-track',
  mount(core) {
    refreshGroundTrack(core);
  },
};
