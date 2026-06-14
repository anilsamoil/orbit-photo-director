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
  _getScrubTier2RunCountForTest,
  _isScrubTier2TimerArmedForTest,
  bindTimeSlider,
  ensureImageryDateBadge,
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
    <input id="time-slider" class="time-slider" type="range" min="0" max="2160" step="1" value="0" />
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
    // 1-min resolution (Chris 2026-06-14).
    expect(slider().step).toBe('1');
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

    // Age is EFFECTIVE at the view instant: tle_age_hours + scrub depth
    // (Codex adversarial 2026-06-10 — a manifest-fresh TLE scrubbed deep
    // is an old projection). Boundary semantics SHARED with the topbar
    // banner (isTleStale, rounded comparison): the surfaces must agree.
    it('effective age exactly 48h (42h TLE + 6h scrub) is not stale', () => {
      _setCurrentTrackForTest({ ...staleTrack, tle_age_hours: 42 } as Track);
      setLookahead(360, false); // +6h
      expect(readout().textContent).toBe('18:00Z');
      expect(readout().classList.contains('time-slider-stale')).toBe(false);
    });

    it('effective 48.4h rounds to 48 → fresh (banner consistency)', () => {
      _setCurrentTrackForTest({ ...staleTrack, tle_age_hours: 42.4 } as Track);
      setLookahead(360, false);
      expect(readout().classList.contains('time-slider-stale')).toBe(false);
    });

    it('effective 48.6h rounds to 49 → stale', () => {
      _setCurrentTrackForTest({ ...staleTrack, tle_age_hours: 42.6 } as Track);
      setLookahead(360, false);
      expect(readout().classList.contains('time-slider-stale')).toBe(true);
    });

    it('a manifest-fresh TLE flips stale at depth: 13h TLE + 36h scrub = 49h', () => {
      // The headline case: the warning matters MOST on deep projections —
      // manifest-time age alone would stay silent here.
      _setCurrentTrackForTest({ ...staleTrack, tle_age_hours: 13 } as Track);
      setLookahead(2160, false); // +36h
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

describe('scrub-drag tiered refresh (7A — Jack iPad stutter report 2026-06-11)', () => {
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
  const dragFrame = (value: string): void => {
    slider().value = value;
    slider().dispatchEvent(new Event('input'));
    drainFrames();
  };

  it('a rapid drag burst runs tier 2 ONCE (leading), not once per frame', () => {
    slider().dispatchEvent(new Event('pointerdown'));
    dragFrame('15'); // leading tier-2 run
    dragFrame('30');
    dragFrame('45');
    dragFrame('60'); // all within the 150ms window
    expect(_getScrubTier2RunCountForTest()).toBe(1);
    // ...but the view time itself was pinned on EVERY frame (tier 1).
    expect(_getViewTimeMsForTest()).toBe(Date.parse('2026-06-10T13:00:00Z'));
  });

  it('tier 2 runs again once the throttle window elapses mid-drag', () => {
    slider().dispatchEvent(new Event('pointerdown'));
    dragFrame('15');
    expect(_getScrubTier2RunCountForTest()).toBe(1);
    vi.setSystemTime(new Date('2026-06-10T12:00:00.200Z')); // >150ms later
    dragFrame('30');
    expect(_getScrubTier2RunCountForTest()).toBe(2);
  });

  it('a deferred tier-2 run fires via the trailing timer if the finger pauses', () => {
    slider().dispatchEvent(new Event('pointerdown'));
    dragFrame('15'); // leading run at t=0
    vi.advanceTimersByTime(50);
    dragFrame('30'); // inside window → pending
    expect(_getScrubTier2RunCountForTest()).toBe(1);
    vi.advanceTimersByTime(150); // trailing timer fires
    expect(_getScrubTier2RunCountForTest()).toBe(2);
  });

  it('release flushes pending tier-2 work IMMEDIATELY (no 150ms settle lag)', () => {
    slider().dispatchEvent(new Event('pointerdown'));
    dragFrame('15');
    vi.advanceTimersByTime(50);
    dragFrame('45'); // pending
    expect(_getScrubTier2RunCountForTest()).toBe(1);
    slider().dispatchEvent(new Event('pointerup'));
    // No timer advance — the flush is synchronous on release. This matters
    // because the 'change' event's same-instant guard can skip the full
    // refresh path entirely; without the flush the terminator/pins/
    // satellites would stay frozen ~150ms in the past after the drag.
    expect(_getScrubTier2RunCountForTest()).toBe(2);
    slider().dispatchEvent(new Event('change'));
    // Pin epoch reflects the drag frame at +50ms (fake clock advanced).
    expect(_getViewTimeMsForTest()).toBe(Date.parse('2026-06-10T12:45:00Z') + 50);
  });

  it('pointercancel and window blur also flush pending tier-2 work', () => {
    slider().dispatchEvent(new Event('pointerdown'));
    dragFrame('15');
    vi.advanceTimersByTime(50);
    dragFrame('30'); // pending
    slider().dispatchEvent(new Event('pointercancel'));
    expect(_getScrubTier2RunCountForTest()).toBe(2);

    // Second drag interrupted by page blur (OS gesture ate the pointerup).
    slider().dispatchEvent(new Event('pointerdown'));
    vi.setSystemTime(new Date('2026-06-10T12:00:01Z'));
    dragFrame('60');
    vi.advanceTimersByTime(50);
    dragFrame('75'); // pending
    window.dispatchEvent(new Event('blur'));
    expect(_getScrubTier2RunCountForTest()).toBe(4);
  });

  it('the readout updates on EVERY drag frame even while tier 2 is throttled', () => {
    slider().dispatchEvent(new Event('pointerdown'));
    dragFrame('60');
    const first = readout().textContent;
    dragFrame('120'); // same throttle window — tier 2 deferred
    expect(_getScrubTier2RunCountForTest()).toBe(1);
    expect(readout().textContent).not.toBe(first); // tier 1 kept pace
  });

  it('non-drag callers (steppers/snap-to-live) never enter the tiered path', () => {
    // No pointerdown — sliderDragging is false; setLookahead runs the full
    // inline path which does NOT increment the tier-2 counter.
    setLookahead(45, false);
    setLookahead(90, false);
    expect(_getScrubTier2RunCountForTest()).toBe(0);
  });

  it('a stale trailing timer after release cannot double-run tier 2', () => {
    slider().dispatchEvent(new Event('pointerdown'));
    dragFrame('15');
    vi.advanceTimersByTime(50);
    dragFrame('30'); // pending + trailing timer armed
    expect(_isScrubTier2TimerArmedForTest()).toBe(true);
    slider().dispatchEvent(new Event('pointerup')); // flush cancels the timer
    // The HANDLE must be cleared, not merely masked by the pending flag —
    // an orphaned callback nulls scrubTier2Timer and can clobber a newly
    // armed timer during a rapid double-drag (adversarial F4 2026-06-11).
    expect(_isScrubTier2TimerArmedForTest()).toBe(false);
    const after = _getScrubTier2RunCountForTest();
    vi.advanceTimersByTime(500); // would fire the stale timer if not cancelled
    expect(_getScrubTier2RunCountForTest()).toBe(after);
  });

  it('settle runs REAL tier-2 payload with the FINAL view state (not just the counter)', () => {
    // Adversarial F1 (2026-06-11): the run-counter tests alone stay green
    // if the refresh calls are deleted from runScrubTier2. The imagery
    // badge is tier-2 payload observable without a map double — assert its
    // wording tracks the drag through the throttle and lands on the final
    // state at flush.
    const badgeHost = document.createElement('div');
    document.body.appendChild(badgeHost);
    ensureImageryDateBadge(badgeHost, {
      cloud_composite_hour: '2026-06-10T11:00:00Z',
    } as never);
    const badge = (): string =>
      badgeHost.querySelector('.map-imagery-date')?.textContent ?? '';
    expect(badge()).toContain('Imagery:'); // live wording before the drag

    slider().dispatchEvent(new Event('pointerdown'));
    dragFrame('60'); // leading tier-2 run — scrubbed wording lands
    expect(badge()).toContain('not forecast');
    // Drag back to live INSIDE the throttle window: badge wording is
    // allowed to lag (tier 2 pending)…
    dragFrame('0');
    expect(_getScrubTier2RunCountForTest()).toBe(1);
    slider().dispatchEvent(new Event('pointerup'));
    // …but the release flush must land the FINAL (live) wording.
    expect(badge()).toContain('Imagery:');
    expect(badge()).not.toContain('not forecast');
  });
});
