import { isTleStale } from '../../../banner';
import { formatUtcHm } from '../../../countdown';
import type { Track } from '../../../types';
import type { Clock } from '../../map-core/clock';
import type { MapFeature } from '../../map-core/feature';

/** Cap for the slider and the steppers. Matches the passes.json horizon. */
export const LOOKAHEAD_MAX_MINUTES = 36 * 60;

const SLIDER_STEP_MINUTES = 1;

export type MarkerPosition = { lat: number; lon: number };

/** What the composition root supplies so this feature never imports another. */
export type ScrubServices = {
  refreshTargets(): void;
  hasMarker(): boolean;
  hasTrack(): boolean;
  markerPosition(): MarkerPosition | null;
  moveMarker(): MarkerPosition | null;
  easeTo(pos: MarkerPosition): void;
  onLiveSnap(pos: MarkerPosition): void;
  deferForecast(deferred: boolean): void;
  refreshForecast(): void;
};

const services: ScrubServices = {
  refreshTargets() {},
  hasMarker: () => false,
  hasTrack: () => false,
  markerPosition: () => null,
  moveMarker: () => null,
  easeTo() {},
  onLiveSnap() {},
  deferForecast() {},
  refreshForecast() {},
};

type Runtime = {
  clock: Clock | null;
  track: Track | null;
  tier2Runs: number;
  sliderBound: boolean;
  sliderLastAppliedMinutes: number;
  sliderDragging: boolean;
  toggleBound: boolean;
};

const state: Runtime = {
  clock: null,
  track: null,
  tier2Runs: 0,
  sliderBound: false,
  sliderLastAppliedMinutes: -1,
  sliderDragging: false,
  toggleBound: false,
};

function mapClock(): Clock {
  const clock = state.clock;
  if (!clock) throw new Error('bindTimeScrubClock before using the time scrub');
  return clock;
}

/** Register the tier-2 listener after the other view-time listeners. */
export function bindTimeScrubClock(clock: Clock): void {
  if (state.clock) return;
  state.clock = clock;
  clock.onViewTime(runScrubTier2);
}

export function bindScrubServices(next: ScrubServices): void {
  Object.assign(services, next);
}

/** Track copy for the stale-TLE readout and the tier-2 gate. */
export function setScrubTrack(track: Track | null): void {
  state.track = track;
}

export function scrubTrack(): Track | null {
  return state.track;
}

export function clampLookahead(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes < 0) return 0;
  if (minutes > LOOKAHEAD_MAX_MINUTES) return LOOKAHEAD_MAX_MINUTES;
  return Math.round(minutes);
}

function lookaheadMinutesNow(nowMs = mapClock().now()): number {
  const view = mapClock().viewTime();
  if (view.kind !== 'scrubbed') return 0;
  return Math.max(0, (view.atMs - nowMs) / 60_000);
}

export function isScrubbed(): boolean {
  return mapClock().isScrubbed();
}

/** Snap to live once the wall clock reaches the pinned instant.
 *  Returns true when a snap happened, so the caller can skip the rest of that tick. */
export function maybeSnapToLive(nowMs = mapClock().now()): boolean {
  const view = mapClock().viewTime();
  if (view.kind === 'scrubbed' && nowMs >= view.atMs) {
    setLookahead(0, false);
    const pos = services.markerPosition();
    if (pos) services.onLiveSnap(pos);
    return true;
  }
  return false;
}

export function _getViewTimeMsForTest(): number | null {
  const view = mapClock().viewTime();
  return view.kind === 'scrubbed' ? view.atMs : null;
}

/** Day-aware UTC readout: `13:30Z` today, `+1d 03:15Z` past midnight. */
export function formatViewTimeReadout(viewMs: number, nowMs: number): string {
  const dayDiff = Math.floor(viewMs / 86_400_000) - Math.floor(nowMs / 86_400_000);
  const prefix = dayDiff > 0 ? `+${dayDiff}d ` : '';
  return `${prefix}${formatUtcHm(viewMs)}`;
}

/** At most one `apply` per animation frame. `apply` reads the latest value. */
export function rafCoalesce(
  apply: () => void,
  raf: (cb: () => void) => unknown = (cb) => requestAnimationFrame(cb),
): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    raf(() => {
      pending = false;
      apply();
    });
  };
}

function syncTimeSliderControls(nowMs: number, curMin: number): void {
  const slider = document.getElementById('time-slider') as HTMLInputElement | null;
  if (!slider) return;
  if (!state.sliderDragging) {
    slider.value = String(curMin);
    state.sliderLastAppliedMinutes = Number(slider.value);
  }
  const scrubbed = mapClock().isScrubbed();
  const ageHours = state.track?.tle_age_hours;
  const ageAtView = typeof ageHours === 'number' ? ageHours + lookaheadMinutesNow(nowMs) / 60 : undefined;
  const tleStale = scrubbed && isTleStale(ageAtView);
  const baseText = scrubbed ? formatViewTimeReadout(mapClock().viewMs(nowMs), nowMs) : 'Now';
  const readoutText = tleStale ? `${baseText} · stale TLE` : baseText;
  slider.setAttribute('aria-valuetext', readoutText);
  const readout = document.getElementById('time-slider-readout');
  if (readout) {
    readout.textContent = readoutText;
    readout.classList.toggle('time-slider-scrubbed', scrubbed);
    readout.classList.toggle('time-slider-stale', tleStale);
    readout.title = tleStale
      ? 'TLE is over 48h old — projected positions degrade with both TLE age and scrub distance'
      : '';
  }
}

/** UTC chips on the steppers, plus the slider thumb and readout. */
export function updateTimeStepLabels(): void {
  const nowMs = mapClock().now();
  const curMin = clampLookahead(lookaheadMinutesNow(nowMs));
  const steps: Array<[string, number]> = [
    ['time-back-90', -90],
    ['time-back-45', -45],
    ['time-now', 0],
    ['time-fwd-45', 45],
    ['time-fwd-90', 90],
  ];
  for (const [id, step] of steps) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const chip = btn.querySelector<HTMLElement>('[data-time-utc]');
    if (!chip) continue;
    const targetMinutes = id === 'time-now' ? 0 : clampLookahead(curMin + step);
    const targetMs = nowMs + targetMinutes * 60_000;
    chip.textContent = formatUtcHm(targetMs);
    const wouldBeNoop = id !== 'time-now' && clampLookahead(curMin + step) === curMin;
    btn.classList.toggle('time-step-noop', wouldBeNoop);
  }
  syncTimeSliderControls(nowMs, curMin);
}

function runScrubTier2(): void {
  state.tier2Runs += 1;
  const safely = (fn: () => void): void => {
    try { fn(); } catch {}
  };
  const isLive = !mapClock().isScrubbed();
  document.querySelectorAll<HTMLButtonElement>('.time-step-btn').forEach((button) => {
    button.classList.toggle('active', button.id === 'time-now' && isLive);
  });
  safely(services.refreshTargets);
}

/** Pin the view to now + minutes and refresh every view-time consumer.
 *  A drag frame coalesces the listeners. The marker moves on this call. */
export function setLookahead(newMinutes: number, recenter: boolean): void {
  const clock = mapClock();
  const clamped = clampLookahead(newMinutes);
  if (clamped === 0 && !clock.isScrubbed()) {
    if (recenter && services.hasMarker() && services.hasTrack()) {
      const pos = services.markerPosition();
      if (pos) services.easeTo(pos);
    }
    updateTimeStepLabels();
    return;
  }
  if (clamped !== 0 && clock.isScrubbed() && clamped === clampLookahead(lookaheadMinutesNow())) {
    if (recenter && services.hasMarker() && services.hasTrack()) {
      const pos = services.markerPosition();
      if (pos) services.easeTo(pos);
    }
    updateTimeStepLabels();
    return;
  }
  clock.setViewTime(
    clamped === 0 ? { kind: 'live' } : { kind: 'scrubbed', atMs: clock.now() + clamped * 60_000 },
    state.sliderDragging && !recenter ? 'coalesced' : 'now',
  );
  const pos = services.moveMarker();
  if (pos && recenter) services.easeTo(pos);
  updateTimeStepLabels();
}

/** Wire `#time-slider`. `raf` is injectable for tests. */
export function bindTimeSlider(raf?: (cb: () => void) => unknown): void {
  if (state.sliderBound) return;
  const slider = document.getElementById('time-slider') as HTMLInputElement | null;
  if (!slider) return;
  slider.min = '0';
  slider.max = String(LOOKAHEAD_MAX_MINUTES);
  slider.step = String(SLIDER_STEP_MINUTES);
  const applyFromSlider = (recenter: boolean): void => {
    const minutes = Number(slider.value);
    if (!Number.isFinite(minutes)) return;
    if (minutes === state.sliderLastAppliedMinutes && !recenter) return;
    setLookahead(minutes, recenter);
  };
  slider.addEventListener('pointerdown', () => {
    state.sliderDragging = true;
    services.deferForecast(true);
  });
  slider.addEventListener('pointerup', () => {
    state.sliderDragging = false;
    services.deferForecast(false);
    mapClock().settle.flush();
    services.refreshForecast();
  });
  slider.addEventListener('pointercancel', () => {
    state.sliderDragging = false;
    services.deferForecast(false);
    mapClock().settle.flush();
    services.refreshForecast();
  });
  window.addEventListener('blur', () => {
    state.sliderDragging = false;
    services.deferForecast(false);
    mapClock().settle.flush();
    services.refreshForecast();
  });
  slider.addEventListener('input', rafCoalesce(() => applyFromSlider(false), raf));
  slider.addEventListener('change', () => applyFromSlider(true));
  state.sliderBound = true;
}

/** Wire the five stepper buttons. */
export function bindTimeToggle(): void {
  if (state.toggleBound) return;
  const stepBtns = document.querySelectorAll<HTMLButtonElement>('.time-step-btn');
  if (stepBtns.length === 0) return;
  stepBtns.forEach((btn) => {
    const step = Number(btn.dataset.step);
    if (!Number.isFinite(step)) return;
    btn.addEventListener('click', () => {
      if (step === 0) setLookahead(0, true);
      else setLookahead(lookaheadMinutesNow() + step, true);
    });
  });
  state.toggleBound = true;
}

export function _resetScrubTierStateForTest(): void {
  mapClock().settle.reset();
  state.tier2Runs = 0;
}

export function _getScrubTier2RunCountForTest(): number {
  return state.tier2Runs;
}

export function _isScrubTier2TimerArmedForTest(): boolean {
  return mapClock().settle.armed;
}

/** Slider and stepper bind flags, so the next test can wire a fresh DOM. */
export function resetScrubControlsForTest(): void {
  state.sliderBound = false;
  state.sliderLastAppliedMinutes = -1;
  state.sliderDragging = false;
  state.toggleBound = false;
}

/** Slider, steppers, and the snap back to live. The 1 Hz tick stays in the root. */
export const timeScrub: MapFeature = {
  id: 'time-scrub',
  mount() {},
};
