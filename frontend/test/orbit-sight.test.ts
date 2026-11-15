import { describe, expect, it } from 'vitest';

import { clearRangeKm, issSightWindows, sightText, type SightWindow } from '../src/orbit-sight';
import type { Track } from '../src/types';

const FROM = Date.parse('2026-05-04T12:10:00Z');
const HOUR = 3_600_000;
const R = 6378.137;

/** A 15.6 rev/day orbit, about 390 km up, with the mean anomaly given. */
function orbit(meanAnomaly: string): Track {
  return {
    tle: {
      line1: '1 48274U 21035A   26124.50000000  .00000000  00000-0  00000-0 0  9990',
      line2: `2 48274  41.4700  10.0000 0000001  86.0000 ${meanAnomaly} 15.60000000123456`,
    },
    tle_epoch: '',
    tle_age_hours: 0,
    tle_freshness_factor: 1,
    iss_polynomial: { start: '', duration_seconds: 0, lat_coeffs: [], lon_coeffs: [], polynomial_order: 0 },
  } as Track;
}

const ISS = orbit('274.1000');

describe('clearRangeKm', () => {
  const at = (r: number, degrees: number): [number, number, number] => {
    const a = (degrees * Math.PI) / 180;
    return [r * Math.cos(a), r * Math.sin(a), 0];
  };
  const limbAngle = (2 * Math.acos(R / (R + 400)) * 180) / Math.PI;

  it('gives the range between two points whose line stays above the ground', () => {
    expect(clearRangeKm(at(R + 400, 0), at(R + 400, 10))).toBeCloseTo(2 * (R + 400) * Math.sin((5 * Math.PI) / 180), 6);
  });

  it('is blocked when the Earth is between them', () => {
    expect(clearRangeKm(at(R + 400, 0), at(R + 400, 180))).toBeNull();
  });

  it('turns from clear to blocked where the line grazes the surface', () => {
    expect(clearRangeKm(at(R + 400, 0), at(R + 400, limbAngle - 0.01))).not.toBeNull();
    expect(clearRangeKm(at(R + 400, 0), at(R + 400, limbAngle + 0.01))).toBeNull();
  });

  it('sees a point straight below without calling the far side visible', () => {
    expect(clearRangeKm(at(R + 400, 0), at(R + 10, 0))).toBeCloseTo(390, 6);
  });
});

describe('issSightWindows', () => {
  it('an object 20 degrees ahead on the same orbit is in sight the whole horizon at one steady range', () => {
    const windows = issSightWindows(ISS, orbit('294.1000'), FROM, 2);

    expect(windows).toHaveLength(1);
    expect(windows[0]!.startMs).toBe(FROM);
    expect(windows[0]!.endMs).toBe(FROM + 2 * HOUR);
    expect(windows[0]!.closestKm).toBeGreaterThan(2_300);
    expect(windows[0]!.closestKm).toBeLessThan(2_400);
  });

  it('an object on the far side of the same orbit is never in sight', () => {
    expect(issSightWindows(ISS, orbit(' 94.1000'), FROM, 2)).toEqual([]);
  });

  it('a slightly faster object drifts out of sight, and the window ends on the last clear sample', () => {
    const faster = orbit('294.1000');
    faster.tle!.line2 = faster.tle!.line2.replace('15.60000000', '15.90000000');
    const windows = issSightWindows(ISS, faster, FROM, 24);

    expect(windows[0]!.startMs).toBe(FROM);
    expect(windows[0]!.endMs).toBeGreaterThan(FROM);
    expect(windows[0]!.endMs).toBeLessThan(FROM + 24 * HOUR);
    expect((windows[0]!.endMs - FROM) % 30_000).toBe(0);
    expect(issSightWindows(ISS, faster, windows[0]!.endMs + 30_000, 0)).toEqual([]);
    expect(issSightWindows(ISS, faster, windows[0]!.endMs, 0)).toHaveLength(1);
  });

  it('an object that laps the ISS gets a second window, apart from the first', () => {
    const faster = orbit('294.1000');
    faster.tle!.line2 = faster.tle!.line2.replace('15.60000000', '15.90000000');
    const windows = issSightWindows(ISS, faster, FROM, 96);

    expect(windows).toHaveLength(2);
    expect(windows[1]!.startMs - windows[0]!.endMs).toBeGreaterThan(24 * HOUR);
    expect(windows[1]!.closestKm).toBeLessThan(150);
  });

  it('has no windows when either element set does not propagate', () => {
    const broken = { ...ISS, tle: { line1: 'x', line2: 'y' } } as Track;

    expect(issSightWindows(broken, ISS, FROM, 1)).toEqual([]);
    expect(issSightWindows(ISS, broken, FROM, 1)).toEqual([]);
  });
});

describe('sightText', () => {
  const window: SightWindow = {
    startMs: Date.parse('2026-05-04T13:02:00Z'),
    endMs: Date.parse('2026-05-04T13:11:30Z'),
    closestMs: Date.parse('2026-05-04T13:06:00Z'),
    closestKm: 1240.4,
  };

  it('names the next window with its closest range', () => {
    expect(sightText([window], FROM)).toBe('ISS line of sight 13:02Z to 13:11Z, closest 1,240 km at 13:06Z');
  });

  it('says so when the window is open now', () => {
    expect(sightText([window], window.startMs + 60_000))
      .toBe('In ISS line of sight now until 13:11Z, closest 1,240 km at 13:06Z');
  });

  it('gives no end time for a window that outlasts the 24 h it looked at', () => {
    const whole: SightWindow = { ...window, startMs: FROM, endMs: FROM + 24 * HOUR };
    expect(sightText([whole], FROM))
      .toBe('In ISS line of sight now and for the next 24 h or longer, closest 1,240 km at 13:06Z');
    expect(sightText([{ ...whole, startMs: FROM + HOUR }], FROM))
      .toBe('ISS line of sight from 13:10Z for the next 24 h or longer, closest 1,240 km at 13:06Z');
    expect(sightText([{ ...whole, endMs: FROM + 24 * HOUR - 30_000 }], FROM)).toContain('until 12:09Z');
  });

  it('skips a window that has ended and says when there is none', () => {
    expect(sightText([window], window.endMs + 1)).toBe('No ISS line of sight in the next 24 h');
    expect(sightText([], FROM)).toBe('No ISS line of sight in the next 24 h');
  });
});
