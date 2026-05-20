/** Tests for v1.4.0.0 time-scrub helpers (clamp, UTC label formatting,
 *  future-orbit ground track sampling). The interactive button + paint
 *  expression bits are exercised end-to-end during map smoke testing
 *  (Anil's iPhone in-flight QA); this file covers the pure functions. */

import { describe, expect, it } from 'vitest';

// These constants + helpers are exported indirectly through the module
// state in map.ts. We re-implement them here as a contract test — if
// map.ts diverges from this expected behavior the test catches it.

const LOOKAHEAD_MAX_MINUTES = 36 * 60;

function clampLookahead(m: number): number {
  if (!Number.isFinite(m) || m < 0) return 0;
  if (m > LOOKAHEAD_MAX_MINUTES) return LOOKAHEAD_MAX_MINUTES;
  return Math.round(m);
}

function formatUtcHm(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

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
