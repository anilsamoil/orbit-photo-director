import { beforeEach, describe, expect, it } from 'vitest';

import { _resetSatrecCacheForTests, tleEpochMs } from '../src/iss-sgp4';
import {
  BUNDLED_ISS_TLE,
  issLookupCandidates,
  propagateBestIssTle,
  rememberIssTle,
  type IssTleCandidate,
} from '../src/iss-tle';

const OCTOBER_2024: IssTleCandidate = {
  line1: '1 25544U 98067A   24290.79041667  .00031560  00000-0  56270-3 0  9990',
  line2: '2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.49814196479596',
};

beforeEach(() => {
  _resetSatrecCacheForTests();
  localStorage.clear();
});

describe('propagateBestIssTle', () => {
  it('propagates the bundled TLE at its own epoch plus two days', () => {
    const epoch = tleEpochMs(BUNDLED_ISS_TLE);
    expect(epoch).not.toBeNull();
    const fix = propagateBestIssTle([BUNDLED_ISS_TLE], epoch! + 2 * 86_400_000);
    expect(fix.ok).toBe(true);
    if (!fix.ok) return;
    expect(fix.alt_km).toBeGreaterThan(300);
    expect(fix.alt_km).toBeLessThan(500);
    expect(Math.abs(fix.epochMs - epoch!)).toBeLessThan(2_000);
  });

  it('reports stale when every candidate is too old to propagate', () => {
    const epoch = tleEpochMs(BUNDLED_ISS_TLE)!;
    const fix = propagateBestIssTle(
      [OCTOBER_2024, BUNDLED_ISS_TLE],
      epoch + 3_000 * 86_400_000,
    );
    expect(fix).toEqual({ ok: false, reason: 'stale' });
  });

  it('picks the October 2024 TLE for a date next to that epoch and the bundled TLE for 2026', () => {
    const oldEpoch = tleEpochMs(OCTOBER_2024)!;
    const nearOld = propagateBestIssTle(
      [BUNDLED_ISS_TLE, OCTOBER_2024],
      oldEpoch + 2 * 86_400_000,
    );
    expect(nearOld.ok).toBe(true);
    if (nearOld.ok) expect(Math.abs(nearOld.epochMs - oldEpoch)).toBeLessThan(2_000);

    const bundledEpoch = tleEpochMs(BUNDLED_ISS_TLE)!;
    const nearBundled = propagateBestIssTle(
      [OCTOBER_2024, BUNDLED_ISS_TLE],
      bundledEpoch + 2 * 86_400_000,
    );
    expect(nearBundled.ok).toBe(true);
    if (nearBundled.ok) expect(Math.abs(nearBundled.epochMs - bundledEpoch)).toBeLessThan(2_000);
  });
});

describe('rememberIssTle', () => {
  it('keeps the newer element set and offers it ahead of the bundled one', () => {
    rememberIssTle(OCTOBER_2024);
    rememberIssTle(BUNDLED_ISS_TLE);
    rememberIssTle(OCTOBER_2024);
    const stored = JSON.parse(localStorage.getItem('opd-iss-tle-last-good')!) as { line1: string };
    expect(stored.line1).toBe(BUNDLED_ISS_TLE.line1);
    const candidates = issLookupCandidates(null);
    expect(candidates[0]?.line1).toBe(BUNDLED_ISS_TLE.line1);
    expect(candidates.some((candidate) => candidate.line1 === BUNDLED_ISS_TLE.line1)).toBe(true);
  });
});
