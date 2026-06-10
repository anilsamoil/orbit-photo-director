/** Tests for the continuous time-slider (Chris feedback 2026-06-09,
 *  eng-review 1C/7A/T6a 2026-06-10).
 *
 *  Covers the rAF coalescing gate, the day-aware readout, the slider→
 *  setLookahead seam (input/change wiring), the value-unchanged no-op that
 *  protects the absolute time model, and the stepper↔slider lockstep sync.
 *  Touch feel, 44px hit target, and control-bar layout are browser-QA only
 *  (happy-dom has no layout engine — project convention). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOOKAHEAD_MAX_MINUTES,
  _getViewTimeMsForTest,
  _resetMapStateForTest,
  _setCurrentTrackForTest,
  bindTimeSlider,
  formatViewTimeReadout,
  rafCoalesce,
  setLookahead,
} from '../src/map';
import type { Track } from '../src/types';

const SLIDER_HTML = `
  <button id="time-now" class="time-btn time-step-btn active" data-step="0">
    <span class="time-step-utc" data-time-utc>--:--Z</span>
  </button>
  <div class="time-slider-row">
    <input id="time-slider" class="time-slider" type="range" min="0" max="2160" step="5" value="0" />
    <span id="time-slider-readout">Now</span>
  </div>`;

describe('rafCoalesce', () => {
  it('coalesces a burst into one apply per frame', () => {
    const frames: Array<() => void> = [];
    let applied = 0;
    const handler = rafCoalesce(() => { applied += 1; }, (cb) => frames.push(cb));
    handler();
    handler();
    handler(); // ~60Hz burst inside a single frame
    expect(applied).toBe(0); // nothing runs until the frame fires
    expect(frames).toHaveLength(1); // one scheduled callback for the burst
    frames[0]!();
    expect(applied).toBe(1);
  });

  it('re-arms after each frame', () => {
    const frames: Array<() => void> = [];
    let applied = 0;
    const handler = rafCoalesce(() => { applied += 1; }, (cb) => frames.push(cb));
    handler();
    frames[0]!();
    handler(); // next frame's burst
    expect(frames).toHaveLength(2);
    frames[1]!();
    expect(applied).toBe(2);
  });
});

describe('formatViewTimeReadout (day-aware UTC — T6a)', () => {
  it('same UTC day: plain HH:MMZ', () => {
    const now = Date.parse('2026-06-10T12:00:00Z');
    expect(formatViewTimeReadout(now + 90 * 60_000, now)).toBe('13:30Z');
  });

  it('past midnight UTC: +1d prefix (bare HH:MMZ is ambiguous)', () => {
    const now = Date.parse('2026-06-10T23:50:00Z');
    expect(formatViewTimeReadout(now + 30 * 60_000, now)).toBe('+1d 00:20Z');
  });

  it('the full 36h reach can cross two UTC dates', () => {
    const now = Date.parse('2026-06-10T13:00:00Z');
    expect(formatViewTimeReadout(now + 2160 * 60_000, now)).toBe('+2d 01:00Z');
  });

  it('exactly midnight of the next day carries the prefix', () => {
    const now = Date.parse('2026-06-10T22:00:00Z');
    expect(formatViewTimeReadout(now + 120 * 60_000, now)).toBe('+1d 00:00Z');
  });

  it('viewMs slightly in the past (pre-snap tick window) never emits a negative prefix', () => {
    // The 1Hz snap means the pinned instant can sit up to ~1s in the past;
    // across midnight that is dayDiff -1 — must render plain, never '-1d'.
    const now = Date.parse('2026-06-11T00:00:10Z');
    expect(formatViewTimeReadout(now - 30_000, now)).toBe('23:59Z');
  });
});

describe('slider binding (eng-review 1C/7A)', () => {
  let frames: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'));
    document.body.innerHTML = SLIDER_HTML;
    _resetMapStateForTest();
    frames = [];
    bindTimeSlider((cb) => frames.push(cb));
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const slider = (): HTMLInputElement =>
    document.getElementById('time-slider') as HTMLInputElement;
  const readout = (): HTMLElement =>
    document.getElementById('time-slider-readout') as HTMLElement;
  const drainFrames = (): void => {
    while (frames.length) frames.shift()!();
  };

  it('binds bounds AND step from the clamp contract, not hand-kept HTML attributes', () => {
    expect(slider().min).toBe('0');
    expect(slider().max).toBe(String(LOOKAHEAD_MAX_MINUTES));
    // step owned in code: real browsers snap programmatic .value writes to
    // the step grid, so the contract must not live only in index.html.
    expect(slider().step).toBe('5');
  });

  it("trailing rAF frame after 'change' does not re-pin (guard catches the stale frame)", () => {
    slider().value = '45';
    slider().dispatchEvent(new Event('input')); // frame queued
    slider().dispatchEvent(new Event('change')); // applies immediately
    const pinned = _getViewTimeMsForTest();
    vi.setSystemTime(new Date('2026-06-10T12:00:05Z'));
    drainFrames(); // stale frame fires with the same value
    expect(_getViewTimeMsForTest()).toBe(pinned);
  });

  it("release ('change') with an unchanged value does not re-pin against a newer now", () => {
    slider().value = '45';
    slider().dispatchEvent(new Event('input'));
    drainFrames(); // pinned at 12:45Z
    const pinned = _getViewTimeMsForTest();
    vi.setSystemTime(new Date('2026-06-10T12:00:10Z'));
    slider().dispatchEvent(new Event('change')); // same value at release
    // setLookahead's same-instant guard: recenter honored, pin untouched.
    expect(_getViewTimeMsForTest()).toBe(pinned);
  });

  it("drag ('input') pins the view through the rAF gate", () => {
    slider().value = '45';
    slider().dispatchEvent(new Event('input'));
    expect(_getViewTimeMsForTest()).toBeNull(); // waits for the frame
    drainFrames();
    expect(_getViewTimeMsForTest()).toBe(Date.parse('2026-06-10T12:45:00Z'));
  });

  it('a drag burst applies ONCE with the latest value (latest-wins)', () => {
    for (const v of ['15', '30', '45']) {
      slider().value = v;
      slider().dispatchEvent(new Event('input'));
    }
    expect(frames).toHaveLength(1); // coalesced
    drainFrames();
    expect(_getViewTimeMsForTest()).toBe(Date.parse('2026-06-10T12:45:00Z'));
  });

  it('value-unchanged input does NOT re-pin to a newer now (T1 guard)', () => {
    slider().value = '45';
    slider().dispatchEvent(new Event('input'));
    drainFrames();
    const pinned = _getViewTimeMsForTest();
    vi.setSystemTime(new Date('2026-06-10T12:10:00Z'));
    slider().dispatchEvent(new Event('input')); // same value, later clock
    drainFrames();
    expect(_getViewTimeMsForTest()).toBe(pinned); // still 12:45Z, not 12:55Z
  });

  it("release ('change') applies without waiting for a frame", () => {
    slider().value = '90';
    slider().dispatchEvent(new Event('change'));
    expect(_getViewTimeMsForTest()).toBe(Date.parse('2026-06-10T13:30:00Z'));
  });

  it('steppers and slider stay in lockstep (sync via updateTimeStepLabels)', () => {
    setLookahead(90, /*recenter=*/false);
    expect(slider().value).toBe('90');
    expect(readout().textContent).toBe('13:30Z');
    expect(slider().getAttribute('aria-valuetext')).toBe('13:30Z');
    expect(readout().classList.contains('time-slider-scrubbed')).toBe(true);
    setLookahead(0, false);
    expect(slider().value).toBe('0');
    expect(readout().textContent).toBe('Now');
    expect(readout().classList.contains('time-slider-scrubbed')).toBe(false);
  });

  it('readout carries the day label past midnight UTC', () => {
    vi.setSystemTime(new Date('2026-06-10T23:50:00Z'));
    setLookahead(30, false);
    expect(readout().textContent).toBe('+1d 00:20Z');
  });

  it('binding is idempotent (renderMap re-runs do not double-wire)', () => {
    bindTimeSlider((cb) => frames.push(cb)); // second bind: no-op
    slider().value = '45';
    slider().dispatchEvent(new Event('input'));
    expect(frames).toHaveLength(1); // one listener, one scheduled frame
  });

  // T6b (eng-review 2026-06-10): deep scrubs compound TLE propagation
  // error — the readout inherits the existing >48h staleness threshold.
  describe('stale-TLE hint', () => {
    const staleTrack = {
      tle: { line1: '', line2: '' },
      tle_epoch: '2026-06-07T00:00:00Z',
      tle_age_hours: 60,
      tle_freshness_factor: 0.5,
      iss_polynomial: {
        start: '2026-06-10T12:00:00Z',
        duration_seconds: 0,
        lat_coeffs: [],
        lon_coeffs: [],
        polynomial_order: 0,
      },
    } as unknown as Track;

    afterEach(() => {
      _setCurrentTrackForTest(null);
    });

    it('flags the readout when scrubbing on a TLE older than 48h', () => {
      _setCurrentTrackForTest(staleTrack);
      setLookahead(360, false);
      expect(readout().textContent).toBe('18:00Z · stale TLE');
      expect(readout().classList.contains('time-slider-stale')).toBe(true);
      expect(slider().getAttribute('aria-valuetext')).toBe('18:00Z · stale TLE');
    });

    it('no flag at Now even with a stale TLE (live view, no projection)', () => {
      _setCurrentTrackForTest(staleTrack);
      setLookahead(360, false);
      setLookahead(0, false);
      expect(readout().textContent).toBe('Now');
      expect(readout().classList.contains('time-slider-stale')).toBe(false);
    });

    it('no flag when the TLE is fresh', () => {
      _setCurrentTrackForTest({ ...staleTrack, tle_age_hours: 6 } as Track);
      setLookahead(360, false);
      expect(readout().textContent).toBe('18:00Z');
      expect(readout().classList.contains('time-slider-stale')).toBe(false);
    });

    // Boundary semantics are SHARED with the topbar banner (isTleStale,
    // rounded comparison — pre-landing review 2026-06-10): the two surfaces
    // must agree at the threshold.
    it('exactly 48h is not stale (rounded ≤ threshold, matches banner)', () => {
      _setCurrentTrackForTest({ ...staleTrack, tle_age_hours: 48 } as Track);
      setLookahead(360, false);
      expect(readout().textContent).toBe('18:00Z');
      expect(readout().classList.contains('time-slider-stale')).toBe(false);
    });

    it('48.4h rounds to 48 → fresh on BOTH surfaces (banner consistency)', () => {
      _setCurrentTrackForTest({ ...staleTrack, tle_age_hours: 48.4 } as Track);
      setLookahead(360, false);
      expect(readout().classList.contains('time-slider-stale')).toBe(false);
    });

    it('48.6h rounds to 49 → stale', () => {
      _setCurrentTrackForTest({ ...staleTrack, tle_age_hours: 48.6 } as Track);
      setLookahead(360, false);
      expect(readout().classList.contains('time-slider-stale')).toBe(true);
    });

    it('missing tle_age_hours (legacy manifest) is not stale', () => {
      const legacy = { ...staleTrack } as Record<string, unknown>;
      delete legacy.tle_age_hours;
      _setCurrentTrackForTest(legacy as unknown as Track);
      setLookahead(360, false);
      expect(readout().classList.contains('time-slider-stale')).toBe(false);
    });
  });
});
