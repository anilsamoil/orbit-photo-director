import { describe, expect, it } from 'vitest';
import { legacyLaunchInHorizon } from '../src/launch-selectors';
import type { PassEntry } from '../src/types';

describe('legacy launch lifetime', () => {
  const now = Date.parse('2026-09-07T23:55:00Z');
  const entry = (t0: string) => ({ launch: { t0 } } as Pick<PassEntry, 'launch'>);
  it('rejects missing, malformed, timezone-free and expired NET', () => {
    for (const value of ['', 'bad', '2026-09-07T23:59:00', '2026-09-07T23:25:00Z']) {
      expect(legacyLaunchInHorizon(entry(value), now, 36 * 3600_000)).toBe(false);
    }
  });
  it('uses UTC across midnight and distinct map/upcoming horizons', () => {
    expect(legacyLaunchInHorizon(entry('2026-09-08T00:05:00Z'), now, 36 * 3600_000)).toBe(true);
    const dayThree = entry('2026-09-10T00:00:00Z');
    expect(legacyLaunchInHorizon(dayThree, now, 36 * 3600_000)).toBe(false);
    expect(legacyLaunchInHorizon(dayThree, now, 7 * 24 * 3600_000)).toBe(true);
  });
});
