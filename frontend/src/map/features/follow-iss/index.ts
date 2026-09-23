import { issPositionWithAltSGP4 } from '../../../iss-sgp4';
import { liveIssPosition } from '../../../iss';
import { greatCircleBearingDeg } from '../../../pin-drop';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import { PREF_KEYS } from '../../map-core/prefs';

/** North-up, or rotated so the ISS direction of travel points up. */
export type BearingMode = 'north' | 'iss-up';

const BEARING_NOOP_THRESHOLD_DEG = 0.5;

type MarkerPosition = { lat: number; lon: number };

type Runtime = {
  core: MapCore | null;
  mode: BearingMode;
  follow: boolean;
  toggleBound: boolean;
  bearingBound: boolean;
  hasTrack: () => boolean;
  position: () => MarkerPosition | null;
};

function readStoredMode(): BearingMode {
  try {
    const stored = localStorage.getItem(PREF_KEYS.bearingMode);
    return stored === 'north' ? 'north' : 'iss-up';
  } catch {
    return 'iss-up';
  }
}

const state: Runtime = {
  core: null,
  mode: readStoredMode(),
  follow: true,
  toggleBound: false,
  bearingBound: false,
  hasTrack: () => false,
  position: () => null,
};

/** Default iss-up. Only a stored `'north'` selects north-up. */
export function readBearingMode(): BearingMode {
  return readStoredMode();
}

export function currentBearingMode(): BearingMode {
  return state.mode;
}

export function isFollowing(): boolean {
  return state.follow;
}

export function noteFollowCore(core: MapCore | null): void {
  state.core = core;
}

/** Marker position for the follow click. The root installs the ISS marker. */
export function bindFollowMarker(marker: { hasTrack(): boolean; position(): MarkerPosition | null }): void {
  state.hasTrack = marker.hasTrack;
  state.position = marker.position;
}

export function setFollowEnv(core: MapCore | null, follow: boolean): void {
  state.core = core;
  state.follow = follow;
}

/** Recenter on the live ISS while follow is on and the view is live. */
export function applyFollowISS(pos: MarkerPosition): void {
  const core = state.core;
  if (!state.follow || !core || core.clock.isScrubbed()) return;
  core.setCenter([pos.lon, pos.lat]);
}

/** Leave follow and update the dock button. */
export function exitFollow(): void {
  if (!state.follow) return;
  state.follow = false;
  reflectFollowButton();
}

function reflectFollowButton(): void {
  const btn = document.getElementById('toggle-follow-iss');
  if (!btn) return;
  btn.classList.toggle('active', state.follow);
  btn.setAttribute('aria-pressed', state.follow ? 'true' : 'false');
  btn.title = state.follow
    ? 'Following ISS — click again or pan/zoom to release'
    : 'Recenter on ISS — click again or pan to release';
}

/** Heading from a sample now and a sample 30 seconds ahead. */
export function computeIssHeading(nowMs: number): number | null {
  const core = state.core;
  const track = core?.view().track;
  if (!track) return null;
  const here = liveIssPosition(track, nowMs) ?? issPositionWithAltSGP4(track, nowMs);
  const ahead = liveIssPosition(track, nowMs + 30_000) ?? issPositionWithAltSGP4(track, nowMs + 30_000);
  if (!here || !ahead) return null;
  if (here.lat === ahead.lat && here.lon === ahead.lon) return null;
  return greatCircleBearingDeg(here.lat, here.lon, ahead.lat, ahead.lon);
}

/** Apply the bearing mode. Skips a write when the camera is already there. */
export function applyBearing(animate: boolean): void {
  const core = state.core;
  if (!core) return;
  const current = core.bearing();
  if (state.mode === 'north') {
    if (Math.abs(current) < BEARING_NOOP_THRESHOLD_DEG) return;
    if (animate) core.easeTo({ bearing: 0, duration: 600 });
    else core.setBearing(0);
    return;
  }
  const heading = computeIssHeading(core.clock.viewMs());
  if (heading === null) return;
  const delta = Math.abs(((heading - current + 540) % 360) - 180);
  if (delta < BEARING_NOOP_THRESHOLD_DEG) return;
  if (animate) core.easeTo({ bearing: heading, duration: 600 });
  else core.setBearing(heading);
}

export function bindFollowToggle(): void {
  if (state.toggleBound) return;
  const btn = document.getElementById('toggle-follow-iss');
  if (!btn) return;
  reflectFollowButton();
  btn.addEventListener('click', () => {
    if (state.follow) {
      state.follow = false;
      reflectFollowButton();
      return;
    }
    state.follow = true;
    reflectFollowButton();
    if (!state.hasTrack()) return;
    const pos = state.position();
    const core = state.core;
    if (pos && core) core.flyTo({ center: [pos.lon, pos.lat], duration: 800 });
  });
  const core = state.core;
  if (core) {
    core.on('dragstart', () => { exitFollow(); });
    core.on('zoomstart', ({ byUser }) => {
      if (byUser) exitFollow();
    });
  }
  state.toggleBound = true;
}

export function bindBearingToggle(): void {
  if (state.bearingBound) return;
  const northBtn = document.getElementById('bearing-north');
  const issBtn = document.getElementById('bearing-iss');
  if (!northBtn || !issBtn) return;
  const reflectActive = (): void => {
    northBtn.classList.toggle('active', state.mode === 'north');
    issBtn.classList.toggle('active', state.mode === 'iss-up');
  };
  reflectActive();
  const setMode = (mode: BearingMode): void => {
    if (mode === state.mode) return;
    state.mode = mode;
    try { localStorage.setItem(PREF_KEYS.bearingMode, mode); } catch {}
    reflectActive();
    applyBearing(true);
  };
  northBtn.addEventListener('click', () => setMode('north'));
  issBtn.addEventListener('click', () => setMode('iss-up'));
  state.bearingBound = true;
}

/** Tests assume follow is off and bearing is north. The stored key is cleared separately. */
export function resetFollowMemoryForTest(): void {
  state.follow = false;
  state.mode = 'north';
}

export function clearBearingPref(): void {
  try { localStorage.removeItem(PREF_KEYS.bearingMode); } catch {}
}

export function resetFollowForTest(): void {
  resetFollowMemoryForTest();
  clearBearingPref();
}

export function _resetFollowStateForTest(): void {
  state.follow = false;
}

/** Follow the ISS, and rotate the map to its direction of travel. */
export const followIss: MapFeature = {
  id: 'follow-iss',
  mount(core) {
    state.core = core;
  },
};
