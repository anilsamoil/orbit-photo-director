/** Tests for v1.4.0.0 time-scrub helpers (clamp, UTC label formatting,
 *  step semantics). The interactive button + paint expression bits are
 *  exercised end-to-end during map smoke testing (Anil's iPhone in-flight
 *  QA); this file covers the pure functions.
 *
 *  6A (2026-06-10): these tests previously ran against LOCAL COPIES of the
 *  helpers, with a comment claiming the copies were "contract tests" that
 *  would catch divergence — they couldn't (nothing ever compared the copy
 *  to the real code; a real change kept these green). The real functions
 *  are now exported from map.ts and tested directly, so the bounds the
 *  slider's min/max/step depend on are actually guarded. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOOKAHEAD_MAX_MINUTES,
  _getViewTimeMsForTest,
  _resetMapStateForTest,
  clampLookahead,
  formatUtcHm,
  isScrubbed,
  maybeSnapToLive,
  setLookahead,
} from '../src/map';

describe('clampLookahead', () => {
  it('floors at 0 (no negative lookahead — back is relative-to-current)', () => {
    expect(clampLookahead(-1)).toBe(0);
    expect(clampLookahead(-9999)).toBe(0);
    expect(clampLookahead(0)).toBe(0);
  });

  it('passes through valid in-range values', () => {
    expect(clampLookahead(45)).toBe(45);
    expect(clampLookahead(90)).toBe(90);
    expect(clampLookahead(180)).toBe(180);
    expect(clampLookahead(1000)).toBe(1000);
  });

  it('caps at LOOKAHEAD_MAX_MINUTES (36h horizon = 2160 min)', () => {
    expect(clampLookahead(LOOKAHEAD_MAX_MINUTES)).toBe(LOOKAHEAD_MAX_MINUTES);
    expect(clampLookahead(LOOKAHEAD_MAX_MINUTES + 1)).toBe(LOOKAHEAD_MAX_MINUTES);
    expect(clampLookahead(99999)).toBe(LOOKAHEAD_MAX_MINUTES);
  });

  it('rejects NaN / Infinity (all non-finite collapse to 0 — defensive)', () => {
    expect(clampLookahead(NaN)).toBe(0);
    expect(clampLookahead(Infinity)).toBe(0);
    expect(clampLookahead(-Infinity)).toBe(0);
  });

  it('rounds fractional minutes (defensive against floating-point drift)', () => {
    expect(clampLookahead(45.4)).toBe(45);
    expect(clampLookahead(45.5)).toBe(46);
    expect(clampLookahead(89.9)).toBe(90);
  });
});

describe('formatUtcHm', () => {
  it('formats midnight UTC as 00:00Z', () => {
    expect(formatUtcHm(Date.UTC(2024, 0, 1, 0, 0))).toBe('00:00Z');
  });

  it('formats noon UTC as 12:00Z', () => {
    expect(formatUtcHm(Date.UTC(2024, 0, 1, 12, 0))).toBe('12:00Z');
  });

  it('zero-pads minutes', () => {
    expect(formatUtcHm(Date.UTC(2024, 0, 1, 9, 5))).toBe('09:05Z');
  });

  it('uses UTC, not local time', () => {
    // 03:45 UTC stays 03:45Z regardless of TZ
    expect(formatUtcHm(Date.UTC(2024, 5, 15, 3, 45))).toBe('03:45Z');
  });

  it('handles end-of-day boundary', () => {
    expect(formatUtcHm(Date.UTC(2024, 11, 31, 23, 59))).toBe('23:59Z');
  });
});

describe('lookahead step semantics (back-from-current floor logic)', () => {
  // Mimics the bindTimeToggle setLookahead logic: stepping back at the
  // floor stays at floor; stepping forward at the ceiling stays at
  // ceiling. The "no-op" UI state derives from
  // (clampLookahead(current + step) === current).
  const step = (current: number, delta: number): number => clampLookahead(current + delta);

  it('back at floor stays at floor', () => {
    expect(step(0, -90)).toBe(0);
    expect(step(0, -45)).toBe(0);
  });

  it('back from 45 with -90 clamps to 0', () => {
    expect(step(45, -90)).toBe(0);
  });

  it('forward 90 then back 90 returns to start', () => {
    expect(step(step(0, 90), -90)).toBe(0);
  });

  it('forward at ceiling stays at ceiling', () => {
    expect(step(LOOKAHEAD_MAX_MINUTES, 90)).toBe(LOOKAHEAD_MAX_MINUTES);
    expect(step(LOOKAHEAD_MAX_MINUTES, 45)).toBe(LOOKAHEAD_MAX_MINUTES);
  });

  it('combination of +45 / +90 reaches arbitrary multiples', () => {
    // +90, +90, +45 = 225
    expect(step(step(step(0, 90), 90), 45)).toBe(225);
  });
});

describe('absolute view-time model (T1, eng-review 2026-06-10)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'));
    _resetMapStateForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('setLookahead pins an ABSOLUTE instant: now + N minutes', () => {
    setLookahead(45, /*recenter=*/false);
    expect(_getViewTimeMsForTest()).toBe(Date.parse('2026-06-10T12:45:00Z'));
    expect(isScrubbed()).toBe(true);
  });

  it('the pinned instant does NOT drift as the wall clock advances', () => {
    // The bug class this model kills: under the old relative
    // lookaheadMinutes, a view parked at +6h re-resolved to a LATER
    // instant on every refresh as "now" advanced.
    setLookahead(360, false);
    const pinned = _getViewTimeMsForTest();
    vi.setSystemTime(new Date('2026-06-10T12:10:00Z'));
    expect(_getViewTimeMsForTest()).toBe(pinned); // still 18:00Z, not 18:10Z
  });

  it('setLookahead(0) returns to live mode', () => {
    setLookahead(90, false);
    setLookahead(0, false);
    expect(_getViewTimeMsForTest()).toBeNull();
    expect(isScrubbed()).toBe(false);
  });

  it('negative / NaN input clamps to live mode, never into the past', () => {
    setLookahead(90, false);
    setLookahead(-45, false);
    expect(_getViewTimeMsForTest()).toBeNull();
    setLookahead(NaN, false);
    expect(_getViewTimeMsForTest()).toBeNull();
  });

  it('caps at +36h (clamp applies before pinning)', () => {
    setLookahead(99_999, false);
    expect(_getViewTimeMsForTest())
      .toBe(Date.now() + LOOKAHEAD_MAX_MINUTES * 60_000);
  });

  it('stepper semantics compose against the current offset-from-now', () => {
    setLookahead(90, false); // pinned at 13:30Z
    vi.setSystemTime(new Date('2026-06-10T12:30:00Z')); // offset is now 60
    // What a +45 stepper click computes: lookaheadMinutesNow() + 45.
    setLookahead(60 + 45, false);
    expect(_getViewTimeMsForTest()).toBe(Date.parse('2026-06-10T14:15:00Z'));
  });

  describe('maybeSnapToLive', () => {
    it('does not snap while the pinned instant is still in the future', () => {
      setLookahead(5, false);
      expect(maybeSnapToLive(Date.now())).toBe(false);
      expect(isScrubbed()).toBe(true);
    });

    it('snaps to live once the wall clock reaches the pinned instant', () => {
      setLookahead(5, false);
      vi.setSystemTime(new Date('2026-06-10T12:05:00Z'));
      expect(maybeSnapToLive(Date.now())).toBe(true);
      expect(_getViewTimeMsForTest()).toBeNull();
      expect(isScrubbed()).toBe(false);
    });

    it('is a no-op in live mode', () => {
      expect(maybeSnapToLive(Date.now())).toBe(false);
      expect(isScrubbed()).toBe(false);
    });
  });
});

describe('stepper wiring post-hoist (REGRESSION — setLookahead was closure-bound)', () => {
  // 5A moved setLookahead out of bindTimeToggle; it now queries
  // .time-step-btn from the document instead of a closure-captured
  // NodeList. Pin the active-class + UTC-chip behavior at that seam.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'));
    document.body.innerHTML = `
      <button id="time-now" class="time-btn time-step-btn active" data-step="0">
        <span class="time-step-utc" data-time-utc>--:--Z</span>
      </button>
      <button id="time-fwd-45" class="time-btn time-step-btn" data-step="45">
        <span class="time-step-utc" data-time-utc>--:--Z</span>
      </button>`;
    _resetMapStateForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('scrubbing clears the Now button active state; returning restores it', () => {
    const nowBtn = document.getElementById('time-now')!;
    setLookahead(45, false);
    expect(nowBtn.classList.contains('active')).toBe(false);
    setLookahead(0, false);
    expect(nowBtn.classList.contains('active')).toBe(true);
  });

  it('updates the UTC chips relative to the current view offset', () => {
    setLookahead(45, false);
    // At +45, the [T+45 →] chip shows the time a further +45 click would
    // land on: 12:00Z + 90min = 13:30Z. The Now chip stays wall-clock.
    const fwdChip = document.querySelector('#time-fwd-45 [data-time-utc]')!;
    const nowChip = document.querySelector('#time-now [data-time-utc]')!;
    expect(fwdChip.textContent).toBe('13:30Z');
    expect(nowChip.textContent).toBe('12:00Z');
  });
});
