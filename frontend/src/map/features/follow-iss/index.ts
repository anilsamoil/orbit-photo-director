import { issPositionWithAltSGP4 } from '../../../iss-sgp4';
import { liveIssPosition } from '../../../iss';
import { greatCircleBearingDeg } from '../../../pin-drop';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import { PREF_KEYS } from '../../map-core/prefs';

export type BearingMode = 'north' | 'iss-up';

const BEARING_NOOP_THRESHOLD_DEG = 0.5;

type MarkerPosition = { lat: number; lon: number };

type Motion = { toward: number; pending: MarkerPosition | null };

type Runtime = {
  core: MapCore | null;
  mode: BearingMode;
  follow: boolean;
  motion: Motion | null;
  motionWatch: boolean;
  toggleBound: boolean;
  bearingBound: boolean;
  clickGuard: boolean;
  bearingPress: boolean;
  hasTrack: () => boolean;
  position: () => MarkerPosition | null;
};

const ROTATE_CLICK_MS = 200;

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
  motion: null,
  motionWatch: false,
  toggleBound: false,
  bearingBound: false,
  clickGuard: false,
  bearingPress: false,
  hasTrack: () => false,
  position: () => null,
};

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

export function bindFollowMarker(marker: { hasTrack(): boolean; position(): MarkerPosition | null }): void {
  state.hasTrack = marker.hasTrack;
  state.position = marker.position;
}

export function setFollowEnv(core: MapCore | null, follow: boolean): void {
  state.core = core;
  state.follow = follow;
}

/** Recenter on the live ISS while follow is on and the view is live.
 *  setCenter aborts a north ease, so that ease keeps the latest center
 *  and this applies it once the bearing has reached north. */
export function applyFollowISS(pos: MarkerPosition): void {
  const core = state.core;
  if (!state.follow || !core || core.clock.isScrubbed()) return;
  if (state.mode === 'north' && state.motion) {
    state.motion.pending = pos;
    return;
  }
  core.setCenter([pos.lon, pos.lat]);
  if (!state.follow || state.mode !== 'north') return;
  core.setBearing(0);
}

/** The follow handler is registered before the ease watch. It reads a pending
 *  center before that watch clears the record, and applies the center on a
 *  later frame. setCenter here would fire another moveend inside this one. */
function settleMotion(): void {
  const motion = state.motion;
  if (!motion?.pending) return;
  const core = state.core;
  if (!core || !state.follow || state.mode !== 'north') return;
  if (Math.abs(core.bearing()) >= 0.01) return;
  const center: [number, number] = [motion.pending.lon, motion.pending.lat];
  requestAnimationFrame(() => {
    const live = state.core;
    if (live !== core || state.motion || !state.follow || state.mode !== 'north') return;
    live.setCenter(center);
  });
}

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
    ? 'Following ISS — click again or pan, zoom, or rotate to release'
    : 'Recenter on ISS — click again or pan to release';
}

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

function bearingApart(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function nearBearing(a: number, b: number): boolean {
  return bearingApart(a, b) < BEARING_NOOP_THRESHOLD_DEG;
}

function watchMotion(core: MapCore): void {
  if (state.motionWatch) return;
  state.motionWatch = true;
  core.on('moveend', () => {
    state.motion = null;
  });
}

function desiredBearing(core: MapCore): number | null {
  if (state.mode === 'north') return 0;
  return computeIssHeading(core.clock.viewMs());
}

/** Apply the bearing mode. A camera already on that bearing stays put, and an ease toward another bearing is replaced.
 *  The record is marked after easeTo, so the moveend from the ease just
 *  interrupted does not drop that mark. An ease that has already finished,
 *  including a duration-0 cancel, clears the record in this same turn. */
export function applyBearing(animate: boolean): void {
  const core = state.core;
  if (!core) return;
  watchMotion(core);
  const desired = desiredBearing(core);
  if (desired === null) return;
  if (state.motion !== null && nearBearing(state.motion.toward, desired)) return;
  const current = core.bearing();
  if (nearBearing(current, desired)) {
    if (state.motion !== null) {
      state.motion = null;
      core.easeTo({ bearing: desired, duration: 0 });
    }
    return;
  }
  if (animate) {
    if (state.clickGuard) return;
    core.easeTo({ bearing: desired, duration: 600 });
    state.motion = { toward: desired, pending: null };
    if (nearBearing(core.bearing(), desired)) state.motion = null;
    return;
  }
  state.motion = null;
  core.setBearing(desired);
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
    const pointer = { held: false, release: 0 };
    const pressPointer = (event: Event): void => {
      pointer.held = true;
      const mouse = event as MouseEvent;
      const target = event.target;
      state.bearingPress = mouse.button === 0
        && target instanceof Element
        && target.closest('#bearing-north, #bearing-iss') !== null;
    };
    const releasePointer = (): void => {
      pointer.held = false;
      if (!state.clickGuard) return;
      window.clearTimeout(pointer.release);
      pointer.release = window.setTimeout(() => { state.clickGuard = false; }, ROTATE_CLICK_MS);
    };
    document.addEventListener('pointerdown', pressPointer, true);
    document.addEventListener('mousedown', pressPointer, true);
    document.addEventListener('pointerup', releasePointer, true);
    document.addEventListener('mouseup', releasePointer, true);
    core.on('rotatestart', ({ byUser }) => {
      if (!byUser) return;
      state.motion = null;
      exitFollow();
      if (!pointer.held) return;
      state.bearingPress = false;
      state.clickGuard = true;
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.id === 'bearing-north' || active.id === 'bearing-iss')) active.blur();
    });
    core.on('moveend', () => { settleMotion(); });
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
    state.mode = mode;
    try { localStorage.setItem(PREF_KEYS.bearingMode, mode); } catch {}
    reflectActive();
    applyBearing(true);
  };
  const onBearingClick = (mode: BearingMode, event: MouseEvent): void => {
    const pressedHere = state.bearingPress;
    state.bearingPress = false;
    if (state.clickGuard || (event.isTrusted && !pressedHere)) {
      state.clickGuard = false;
      return;
    }
    setMode(mode);
  };
  northBtn.addEventListener('click', (event) => onBearingClick('north', event));
  issBtn.addEventListener('click', (event) => onBearingClick('iss-up', event));
  state.bearingBound = true;
}

export function resetFollowMemoryForTest(): void {
  state.follow = false;
  state.mode = 'north';
  state.motion = null;
  state.motionWatch = false;
  state.clickGuard = false;
  state.bearingPress = false;
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

export const followIss: MapFeature = {
  id: 'follow-iss',
  mount(core) {
    state.core = core;
  },
};
