/**
 * Tests for empty-hint.ts (V4-P3 — empty-Queue disambiguator).
 *
 * Coverage:
 * - Fresh manifest (< 90 min) → null (default copy fires)
 * - At threshold (exactly 90 min) → hint string
 * - Stale manifest (90+ min) → hint with correct age + next-tick projection
 * - Hour-boundary edges (60m, 120m) format correctly
 * - NaN/invalid generated_at → null (don't crash)
 * - Future-dated manifest (clock skew) → null
 */
import { describe, expect, it } from 'vitest';

import { EMPTY_HINT_THRESHOLD_MIN, emptyQueueHint } from '../src/empty-hint';
import type { Manifest } from '../src/types';

/** Build a manifest with a generated_at offset from `nowMs` by `ageMin`
 *  minutes. Other fields are stub values — emptyQueueHint only reads
 *  generated_at, so the rest is filler for the type. */
function manifestAgedBy(ageMin: number, nowMs: number): Manifest {
  return {
    version: '20260513T060000Z',
    generated_at: new Date(nowMs - ageMin * 60_000).toISOString(),
    tle_epoch: '2026-05-13T00:00:00Z',
    cloud_composite_hour: '2026-05-13T05:00:00Z',
    target_data_version: 'v1',
    build_version: '1.2.2.0',
    freshness: { tle_hours: 6, cloud_hours: 1, ok: true },
    artifacts: {},
  };
}

const NOW = Date.parse('2026-05-13T12:00:00Z');

describe('emptyQueueHint', () => {
  it('returns null when manifest is fresh (< 90 min)', () => {
    expect(emptyQueueHint(manifestAgedBy(0, NOW), NOW)).toBeNull();
    expect(emptyQueueHint(manifestAgedBy(45, NOW), NOW)).toBeNull();
    expect(emptyQueueHint(manifestAgedBy(60, NOW), NOW)).toBeNull();
    expect(emptyQueueHint(manifestAgedBy(89, NOW), NOW)).toBeNull();
  });

  it('returns hint at exactly the threshold (90 min)', () => {
    const hint = emptyQueueHint(manifestAgedBy(90, NOW), NOW);
    expect(hint).not.toBeNull();
    expect(hint).toContain('1h 30m stale');
    // 90 % 60 = 30 → next tick due in 60-30 = 30m.
    expect(hint).toContain('Next update due in 30m');
  });

  it('formats age correctly above the hour', () => {
    const hint = emptyQueueHint(manifestAgedBy(102, NOW), NOW);
    expect(hint).toContain('1h 42m stale');
    // 102 % 60 = 42 → next tick in 18m.
    expect(hint).toContain('Next update due in 18m');
  });

  it('drops minute suffix when age is on the hour', () => {
    const hint = emptyQueueHint(manifestAgedBy(120, NOW), NOW);
    expect(hint).toContain('2h stale');
    expect(hint).not.toContain('2h 0m');
    // 120 % 60 = 0 → next tick in 60m (full cycle wait).
    expect(hint).toContain('Next update due in 60m');
  });

  it('handles very old manifests (multi-hour)', () => {
    const hint = emptyQueueHint(manifestAgedBy(245, NOW), NOW);
    expect(hint).toContain('4h 5m stale');
    // 245 % 60 = 5 → next tick in 55m.
    expect(hint).toContain('Next update due in 55m');
  });

  it('returns null on invalid generated_at (NaN parse)', () => {
    const m = manifestAgedBy(120, NOW);
    m.generated_at = 'not-a-date';
    expect(emptyQueueHint(m, NOW)).toBeNull();
  });

  it('returns null when manifest is in the future (clock skew)', () => {
    // ageMin = -10 means generated_at is 10 min in the future relative
    // to nowMs. Math.floor(-10) = -10 which is < threshold, so null.
    expect(emptyQueueHint(manifestAgedBy(-10, NOW), NOW)).toBeNull();
  });

  it('exports the threshold constant for callers', () => {
    expect(EMPTY_HINT_THRESHOLD_MIN).toBe(90);
  });

  // offline param (v1.7.9.0): when the device is offline (LOS), the cause of
  // the empty queue is the device, not the generator — blaming the generator
  // misleads the operator during a real loss-of-signal window.
  describe('offline framing', () => {
    it('blames the device (not the generator) when offline=true', () => {
      const hint = emptyQueueHint(manifestAgedBy(2923, NOW), NOW, true);
      expect(hint).not.toBeNull();
      expect(hint).toContain("You're offline");
      expect(hint).toContain('last synced');
      expect(hint).not.toContain('generator has been slow');
    });

    it('keeps the generator framing when offline=false (regression)', () => {
      const hint = emptyQueueHint(manifestAgedBy(102, NOW), NOW, false);
      expect(hint).toContain('generator has been slow');
      expect(hint).not.toContain("You're offline");
    });

    it('defaults to the generator framing when offline is omitted', () => {
      expect(emptyQueueHint(manifestAgedBy(102, NOW), NOW)).toContain('generator has been slow');
    });

    it('returns null below the threshold regardless of offline state', () => {
      expect(emptyQueueHint(manifestAgedBy(45, NOW), NOW, true)).toBeNull();
    });
  });
});
