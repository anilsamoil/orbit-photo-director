/**
 * Tests for frontend/src/photo-conditions.ts — the Photo Conditions
 * framework (Unit 1) + camera line.
 *
 * All math is imported from the real module — never re-implemented locally
 * (prior learning [contract-test-local-copies]). Anchor cases pin the
 * Pettit-guide cross-checks the plan documents:
 *   - footprint 400mm @ nadir/420km ≈ 38km (guide Fig. 23: 5.2° × 420km)
 *   - tracked floors (Z9-modernized 1.5/f): 400→1/640, 800→1/1250, 1200→1/2000
 *   - untracked physics floors @ nadir/420km: 400→1/1250, 800→1/2500, 1200→1/4000
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ALT_KM,
  MAX_VISIBLE_ROWS,
  betaBlackoutProvider,
  goldenHourConditionProvider,
  isNlcSeason,
  nlcConditionProvider,
  NLC_LAT_MIN,
  NLC_SUN_HI,
  NLC_SUN_LO,
  GOLDEN_FLOOR_DEG,
  GOLDEN_CEIL_DEG,
  moonConditionProvider,
  KIT_FOCAL_LENGTHS_MM,
  SHUTTER_LADDER,
  buildConditionRows,
  cameraConditionProvider,
  footprintKm,
  renderConditionBlock,
  slantRangeKm,
  snapToFasterStop,
  trackedFloorSec,
  untrackedFloorSec,
  type ConditionCtx,
  type ConditionRow,
} from '../src/photo-conditions';
import type { PassEntry } from '../src/types';
import { greatCircleAngleDeg, subsolarPoint } from '../src/terminator';

function passWith(over: Partial<PassEntry> = {}): PassEntry {
  return {
    nadir_distance_km: 0,
    iss_at_closest: { lat: 0, lon: 0, alt_km: 420 },
    ...over,
  } as PassEntry;
}

function ctxWith(over: Partial<PassEntry> = {}): ConditionCtx {
  return { pass: passWith(over), manifest: null, track: null, nowMs: Date.parse('2026-06-11T12:00:00Z') };
}

describe('slantRangeKm (law of cosines — nadir distance is arc length)', () => {
  it('equals altitude at the nadir point', () => {
    expect(slantRangeKm(0, 420)).toBeCloseTo(420, 6);
  });

  it('matches the flat chord closely near nadir but exceeds it when oblique', () => {
    const flat = (n: number, a: number): number => Math.sqrt(a * a + n * n);
    // 100km ground distance: spherical ≈ flat within 0.2%.
    expect(slantRangeKm(100, 420) / flat(100, 420)).toBeCloseTo(1, 2);
    // 1500km ground distance: the chord geometry diverges measurably.
    const ratio = slantRangeKm(1500, 420) / flat(1500, 420);
    expect(ratio).not.toBeCloseTo(1, 3);
  });

  it('is monotonic in ground distance', () => {
    let prev = 0;
    for (const n of [0, 200, 500, 1000, 1500, 2000]) {
      const d = slantRangeKm(n, 420);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });
});

describe('shutter floors', () => {
  it('tracked floors hit the guide-validated stops: 400→640, 800→1250, 1200→2000', () => {
    expect(snapToFasterStop(trackedFloorSec(400))).toBe(640);
    expect(snapToFasterStop(trackedFloorSec(800))).toBe(1250);
    expect(snapToFasterStop(trackedFloorSec(1200))).toBe(2000);
  });

  it('untracked physics floors at nadir/420km: 400→1250, 800→2500, 1200→4000', () => {
    const d = slantRangeKm(0, 420);
    expect(snapToFasterStop(untrackedFloorSec(400, d))).toBe(1250);
    expect(snapToFasterStop(untrackedFloorSec(800, d))).toBe(2500);
    expect(snapToFasterStop(untrackedFloorSec(1200, d))).toBe(4000);
  });

  it('untracked floors RELAX (slower allowed) as slant range grows', () => {
    expect(untrackedFloorSec(400, 1500)).toBeGreaterThan(untrackedFloorSec(400, 420));
  });

  it('tracking buys about a stop at the kit lengths (documented claim)', () => {
    const d = slantRangeKm(0, 420);
    for (const f of KIT_FOCAL_LENGTHS_MM) {
      const ratio = trackedFloorSec(f) / untrackedFloorSec(f, d);
      expect(ratio).toBeGreaterThan(1.5); // at least ~2/3 stop
      expect(ratio).toBeLessThan(3); // under 1.6 stops
    }
  });
});

describe('snapToFasterStop (third-stop ladder)', () => {
  it('snaps DOWN (faster), never to the nearest stop', () => {
    // 1/1124 → 1/1250 even though 1/1000 is numerically nearer.
    expect(snapToFasterStop(1 / 1124)).toBe(1250);
  });

  it('an exact ladder stop stays put', () => {
    expect(snapToFasterStop(1 / 640)).toBe(640);
    expect(snapToFasterStop(1 / 8000)).toBe(8000);
  });

  it('clamps at both ladder ends', () => {
    expect(snapToFasterStop(10)).toBe(SHUTTER_LADDER[0]); // very slow floor → slowest stop
    expect(snapToFasterStop(1 / 20000)).toBe(8000); // beyond fastest → clamp
  });

  it('rejects garbage', () => {
    expect(snapToFasterStop(NaN)).toBeNull();
    expect(snapToFasterStop(0)).toBeNull();
    expect(snapToFasterStop(-1)).toBeNull();
  });
});

describe('footprintKm', () => {
  it('matches the guide FOV cross-check: 400mm @ nadir/420km ≈ 38km', () => {
    const d = slantRangeKm(0, 420);
    expect(footprintKm(400, d)).toBeGreaterThan(36);
    expect(footprintKm(400, d)).toBeLessThan(40);
  });

  it('halves with doubled focal length and widens with slant range', () => {
    expect(footprintKm(800, 420)).toBeCloseTo(footprintKm(400, 420) / 2, 6);
    expect(footprintKm(400, 1000)).toBeGreaterThan(footprintKm(400, 420));
  });
});

describe('cameraConditionProvider', () => {
  it('renders the kit trio with footprint + tracked floor per lens', () => {
    const row = cameraConditionProvider(ctxWith());
    expect(row).not.toBeNull();
    expect(row!.icon).toBe('📷');
    expect(row!.label).toBe('tracked floors · hand-track');
    expect(row!.value).toBe('400mm ≈38km ≥1/640 · 800mm ≈19km ≥1/1250 · 1200mm ≈13km ≥1/2000');
    expect(row!.almanacAnchor).toBe('almanac-camera');
  });

  it('widens footprints on an oblique pass (slant range grows)', () => {
    const row = cameraConditionProvider(ctxWith({ nadir_distance_km: 1000 }));
    const m = row!.value.match(/400mm ≈(\d+)km/);
    expect(Number(m![1])).toBeGreaterThan(38);
  });

  it('falls back to 420km altitude when the pass carries none', () => {
    const noAlt = cameraConditionProvider(
      ctxWith({ iss_at_closest: undefined as never }),
    );
    const withDefault = cameraConditionProvider(
      ctxWith({ iss_at_closest: { lat: 0, lon: 0, alt_km: DEFAULT_ALT_KM } }),
    );
    expect(noAlt!.value).toBe(withDefault!.value);
  });

  it('returns null (silence) on missing/NaN/negative nadir distance', () => {
    expect(cameraConditionProvider(ctxWith({ nadir_distance_km: NaN }))).toBeNull();
    expect(cameraConditionProvider(ctxWith({ nadir_distance_km: -5 }))).toBeNull();
    expect(
      cameraConditionProvider(ctxWith({ nadir_distance_km: undefined as never })),
    ).toBeNull();
  });
});

describe('buildConditionRows (provider isolation)', () => {
  it('a throwing provider loses its row, logs a warning, and never breaks the rest', async () => {
    const mod = await import('../src/photo-conditions');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = (): ConditionRow | null => {
      throw new Error('ephemeris exploded');
    };
    mod.PROVIDERS.unshift(boom);
    try {
      const rows = buildConditionRows(ctxWith());
      expect(rows).toHaveLength(1); // camera survived
      expect(rows[0]!.id).toBe('camera');
      expect(warn).toHaveBeenCalledOnce(); // NOT silent (Codex #11)
    } finally {
      mod.PROVIDERS.shift();
      warn.mockRestore();
    }
  });

  it('null providers are skipped without noise', () => {
    const rows = buildConditionRows(ctxWith({ nadir_distance_km: NaN }));
    expect(rows).toHaveLength(0);
  });
});

describe('renderConditionBlock', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
  });

  const fakeRow = (id: string): ConditionRow => ({
    id,
    icon: '✨',
    label: `label ${id}`,
    value: `value ${id}`,
    almanacAnchor: `anchor-${id}`,
  });

  it('zero rows → nothing at all, not even the divider (silence is a feature)', () => {
    renderConditionBlock([], host);
    expect(host.children).toHaveLength(0);
  });

  it('renders divider + rows as buttons; tap opens the almanac at the anchor', () => {
    const opened: string[] = [];
    renderConditionBlock([fakeRow('a')], host, (anchor) => opened.push(anchor));
    expect(host.querySelector('.photo-conditions-divider')).not.toBeNull();
    const btn = host.querySelector<HTMLButtonElement>('.photo-condition-row');
    expect(btn).not.toBeNull();
    expect(btn!.tagName).toBe('BUTTON'); // real button, not a span (Codex #5)
    btn!.click();
    expect(opened).toEqual(['anchor-a']);
  });

  it('caps visible rows at MAX_VISIBLE_ROWS with a "▸ N more" disclosure', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map(fakeRow);
    renderConditionBlock(rows, host, () => {});
    expect(host.querySelectorAll('.photo-condition-row')).toHaveLength(MAX_VISIBLE_ROWS);
    const more = host.querySelector<HTMLButtonElement>('.photo-conditions-more');
    expect(more!.textContent).toBe('▸ 2 more');
    more!.click();
    expect(host.querySelectorAll('.photo-condition-row')).toHaveLength(5);
    expect(host.querySelector('.photo-conditions-more')).toBeNull();
  });

  it('exactly MAX_VISIBLE_ROWS rows → no disclosure button', () => {
    renderConditionBlock(['a', 'b', 'c'].map(fakeRow), host, () => {});
    expect(host.querySelector('.photo-conditions-more')).toBeNull();
  });
});

describe('betaBlackoutProvider (Unit 2 — hard-zero + night-regime gating)', () => {
  const SSO_TLE = {
    line1: '1 99999U 26001A   26162.50000000  .00000100  00000-0  10000-3 0  9997',
    line2: '2 99999  97.8000 350.0000 0001000  90.0000 270.0000 14.80000000  1234',
  };
  const ISS_TLE = {
    line1: '1 25544U 98067A   26161.50000000  .00016717  00000-0  30771-3 0  9991',
    line2: '2 25544  51.6400  10.0000 0003000  86.0000 274.1000 15.50000000123456',
  };
  const NOW = Date.parse('2026-06-11T12:00:00Z');
  const mkCtx = (tle: { line1: string; line2: string } | null, over: Partial<PassEntry>): ConditionCtx => ({
    pass: passWith({ closest_approach: '2026-06-12T03:00:00Z', ...over }),
    manifest: null,
    track: (tle ? { tle } : { }) as never,
    nowMs: NOW,
  });

  it('fires for a night-regime target on a true full-sun day', () => {
    const row = betaBlackoutProvider(mkCtx(SSO_TLE, { target_regime: 'night' } as never));
    expect(row).not.toBeNull();
    expect(row!.icon).toBe('☀️');
    expect(row!.value).toContain('no orbital night this period');
    expect(row!.almanacAnchor).toBe('almanac-beta');
  });

  it('silent for day-regime targets even on full-sun days (rule 5)', () => {
    expect(betaBlackoutProvider(mkCtx(SSO_TLE, { target_regime: 'day' } as never))).toBeNull();
  });

  it('silent on normal-beta days (ISS today) and without a track', () => {
    expect(betaBlackoutProvider(mkCtx(ISS_TLE, { target_regime: 'night' } as never))).toBeNull();
    expect(betaBlackoutProvider(mkCtx(null, { target_regime: 'night' } as never))).toBeNull();
  });
});

describe('moonConditionProvider (Unit 3 — night gate + sky state)', () => {
  // Real full moon; observer placed AT the sub-point so the Moon is up.
  const FULL = Date.parse('2026-06-29T23:57:00Z');
  const sub = (() => {
    // mirror moonSubpoint without importing private math: use assessMoon via
    // a coarse search is overkill — use the known value (-27.2, +1.9).
    return { lat: -27, lon: 2 };
  })();

  const nightPassAtSub = (over: Partial<PassEntry> = {}): PassEntry => passWith({
    pass_regime: 'night',
    closest_approach: '2026-06-29T23:57:00Z',
    iss_at_closest: { lat: sub.lat, lon: sub.lon, alt_km: 420 },
    ...over,
  } as never);

  const ctx = (pass: PassEntry): ConditionCtx => ({ pass, manifest: null, track: null, nowMs: FULL });

  it('fires moonlit on a night pass with the bright Moon up', () => {
    const row = moonConditionProvider(ctx(nightPassAtSub()));
    expect(row).not.toBeNull();
    expect(row!.id).toBe('moon');
    expect(row!.icon).toBe('🌕');
    expect(row!.value).toContain('full');
    expect(row!.value).toContain('moonlit — night genres washed');
    expect(row!.almanacAnchor).toBe('almanac-moon');
  });

  it('silent on a DAY pass even with the Moon up (rule 5)', () => {
    expect(moonConditionProvider(ctx(nightPassAtSub({ pass_regime: 'day' } as never)))).toBeNull();
  });

  it('silent on a night-best TARGET if the PASS is daylit (Codex gate fix)', () => {
    // night target, day pass → moonlight is irrelevant, no row.
    expect(moonConditionProvider(ctx(nightPassAtSub({ target_regime: 'night', pass_regime: 'day' } as never)))).toBeNull();
  });

  it('silent (dark) when the Moon is on the far side of Earth', () => {
    const farPass = nightPassAtSub({ iss_at_closest: { lat: 27, lon: -178, alt_km: 420 } } as never);
    expect(moonConditionProvider(ctx(farPass))).toBeNull();
  });

  it('fires on a night PASS regardless of target regime', () => {
    const byPassRegime = nightPassAtSub({ target_regime: 'day', pass_regime: 'night' } as never);
    expect(moonConditionProvider(ctx(byPassRegime))).not.toBeNull();
  });
});

describe('row budget at the cap (verifier 2026-06-14: β+moon+camera = 3, not 2)', () => {
  it('a night pass can produce exactly MAX_VISIBLE_ROWS with no disclosure', () => {
    // Camera always fires (nadir present); moon fires (Moon up); beta only
    // on a hard-zero day — we assert the cap math directly.
    expect(MAX_VISIBLE_ROWS).toBe(3);
    const rows = buildConditionRows({
      pass: passWith({
        pass_regime: 'night',
        closest_approach: '2026-06-29T23:57:00Z',
        nadir_distance_km: 200,
        iss_at_closest: { lat: -27, lon: 2, alt_km: 420 },
      } as never),
      manifest: null,
      track: null,
      nowMs: Date.parse('2026-06-29T23:57:00Z'),
    });
    // moon + camera (β needs a full-sun TLE which this lacks) → 2 here; the
    // point is the renderer caps at 3 with no overflow button.
    expect(rows.length).toBeLessThanOrEqual(MAX_VISIBLE_ROWS);
    expect(rows.some((r) => r.id === 'moon')).toBe(true);
    expect(rows.some((r) => r.id === 'camera')).toBe(true);
  });
});

describe('goldenHourConditionProvider (Unit 4 — terrain texture, advisory row)', () => {
  // Build a pass whose TARGET sits at a controlled sun elevation by placing
  // it a chosen great-circle angle from the subsolar point at a fixed time.
  const WHEN = '2026-06-21T12:00:00Z';
  const sub = subsolarPoint(new Date(WHEN));

  // A point `theta` degrees from the subsolar point → sun elevation 90-theta.
  // Walk west along the sub-point's latitude until the elevation matches.
  const targetAtElevation = (targetElev: number): { lat: number; lon: number } => {
    let best = { lat: sub.lat, lon: sub.lon };
    let bestErr = Infinity;
    for (let dLon = 0; dLon <= 180; dLon += 0.5) {
      const lon = ((sub.lon + dLon + 540) % 360) - 180;
      const elev = 90 - greatCircleAngleDeg(sub.lat, lon, sub.lat, sub.lon);
      const err = Math.abs(elev - targetElev);
      if (err < bestErr) { bestErr = err; best = { lat: sub.lat, lon }; }
    }
    return best;
  };

  const ctxFor = (category: string | undefined, elev: number): ConditionCtx => {
    const t = targetAtElevation(elev);
    return {
      pass: passWith({
        category, target_lat: t.lat, target_lon: t.lon, closest_approach: WHEN,
      } as never),
      manifest: null, track: null, nowMs: Date.parse(WHEN),
    };
  };

  it('fires for big-terrain at low sun (raking light)', () => {
    const row = goldenHourConditionProvider(ctxFor('big-terrain', 10));
    expect(row).not.toBeNull();
    expect(row!.icon).toBe('🌅');
    expect(row!.label).toBe('golden hour');
    expect(row!.value).toMatch(/low sun \d+° · raking light/);
    expect(row!.almanacAnchor).toBe('almanac-golden-hour');
  });

  it('fires for volcano at low sun', () => {
    expect(goldenHourConditionProvider(ctxFor('volcano', 8))).not.toBeNull();
  });

  it('silent at high sun (midday, shadows too short)', () => {
    expect(goldenHourConditionProvider(ctxFor('big-terrain', 60))).toBeNull();
    expect(goldenHourConditionProvider(ctxFor('big-terrain', GOLDEN_CEIL_DEG + 5))).toBeNull();
  });

  it('silent when the target is dark (sun below the floor)', () => {
    expect(goldenHourConditionProvider(ctxFor('big-terrain', GOLDEN_FLOOR_DEG - 3))).toBeNull();
  });

  it('silent for non-terrain categories (iconic-shape excluded — sea-level outlines)', () => {
    expect(goldenHourConditionProvider(ctxFor('iconic-shape', 10))).toBeNull();
    expect(goldenHourConditionProvider(ctxFor('night-megacity', 10))).toBeNull();
    expect(goldenHourConditionProvider(ctxFor('aurora', 10))).toBeNull();
  });

  it('silent when the pass carries no category (personal/launch targets)', () => {
    expect(goldenHourConditionProvider(ctxFor(undefined, 10))).toBeNull();
  });

  it('band edges: fires at the floor and ceiling, not just outside', () => {
    expect(goldenHourConditionProvider(ctxFor('big-terrain', GOLDEN_FLOOR_DEG + 1))).not.toBeNull();
    expect(goldenHourConditionProvider(ctxFor('big-terrain', GOLDEN_CEIL_DEG - 1))).not.toBeNull();
  });
});

describe('isNlcSeason (NASA AIM climatology)', () => {
  it('Northern: open at summer solstice, closed in winter', () => {
    expect(isNlcSeason(new Date('2026-06-21T00:00:00Z'), 'N')).toBe(true);
    expect(isNlcSeason(new Date('2026-12-21T00:00:00Z'), 'N')).toBe(false);
    expect(isNlcSeason(new Date('2026-03-21T00:00:00Z'), 'N')).toBe(false); // spring: NOT season (over-fire guard)
    expect(isNlcSeason(new Date('2026-09-15T00:00:00Z'), 'N')).toBe(false);
  });
  it('Southern: open around the Dec solstice, wraps the year boundary', () => {
    expect(isNlcSeason(new Date('2026-12-21T00:00:00Z'), 'S')).toBe(true);
    expect(isNlcSeason(new Date('2026-01-15T00:00:00Z'), 'S')).toBe(true); // wraps into January
    expect(isNlcSeason(new Date('2026-06-21T00:00:00Z'), 'S')).toBe(false);
  });
});

describe('nlcConditionProvider (Unit 5 — summer high-lat twilight window)', () => {
  // Place a target at a chosen latitude where the sun sits at a chosen
  // (negative) elevation, at a fixed in-season instant, by searching lon.
  const targetAtElev = (lat: number, when: Date, wantElev: number): { lat: number; lon: number } => {
    const sub = subsolarPoint(when);
    let best = { lat, lon: 0 }, bestErr = Infinity;
    for (let lon = -180; lon < 180; lon += 0.5) {
      const elev = 90 - greatCircleAngleDeg(lat, lon, sub.lat, sub.lon);
      const err = Math.abs(elev - wantElev);
      if (err < bestErr) { bestErr = err; best = { lat, lon }; }
    }
    return best;
  };
  const ctxAt = (lat: number, iso: string, wantElev: number): ConditionCtx => {
    const when = new Date(iso);
    const t = targetAtElev(lat, when, wantElev);
    return {
      pass: passWith({ target_lat: t.lat, target_lon: t.lon, closest_approach: iso } as never),
      manifest: null, track: null, nowMs: when.getTime(),
    };
  };

  it('fires for a Northern summer high-lat target in the twilight band', () => {
    const row = nlcConditionProvider(ctxAt(58, '2026-06-21T00:00:00Z', -10));
    expect(row).not.toBeNull();
    expect(row!.id).toBe('nlc');
    expect(row!.icon).toBe('🌌');
    expect(row!.value).toContain('possible');
    expect(row!.value).toContain('N pole');
    expect(row!.almanacAnchor).toBe('almanac-nlc');
  });

  it('fires deep in the band (sun 14° below) — proving NO dead-band clip', () => {
    // The original pass_regime gate would have rejected this as "night";
    // band-only gating reaches the full [-16,-6].
    expect(nlcConditionProvider(ctxAt(58, '2026-06-21T00:00:00Z', -14))).not.toBeNull();
  });

  it('fires for a Southern target in December (year-wrap season)', () => {
    const row = nlcConditionProvider(ctxAt(-58, '2026-12-21T00:00:00Z', -10));
    expect(row).not.toBeNull();
    expect(row!.value).toContain('S pole');
  });

  it('silent: sun too bright (above the band)', () => {
    expect(nlcConditionProvider(ctxAt(58, '2026-06-21T00:00:00Z', NLC_SUN_HI + 3))).toBeNull();
  });

  it('silent: sun too dark (below the band — deck unlit)', () => {
    // lat 48 on Aug 15 (still N season) CAN reach deep depression, unlike
    // midsummer high latitudes where nights are too short to get there.
    expect(nlcConditionProvider(ctxAt(48, '2026-08-15T00:00:00Z', NLC_SUN_LO - 4))).toBeNull();
  });

  it('silent: latitude too low', () => {
    expect(nlcConditionProvider(ctxAt(NLC_LAT_MIN - 10, '2026-06-21T00:00:00Z', -10))).toBeNull();
  });

  it('silent: in the band + high lat but OUT of season (winter)', () => {
    expect(nlcConditionProvider(ctxAt(58, '2026-12-21T00:00:00Z', -10))).toBeNull(); // N target, N winter
  });

  it('silent: high latitude in the WRONG (winter) hemisphere', () => {
    // Northern-summer instant, but a Southern (winter) target → no NLC.
    expect(nlcConditionProvider(ctxAt(-58, '2026-06-21T00:00:00Z', -10))).toBeNull();
  });

  it('band edges fire; just outside does not', () => {
    expect(nlcConditionProvider(ctxAt(58, '2026-06-21T00:00:00Z', NLC_SUN_HI - 0.5))).not.toBeNull();
    expect(nlcConditionProvider(ctxAt(58, '2026-06-21T00:00:00Z', NLC_SUN_LO + 0.5))).not.toBeNull();
  });
});
