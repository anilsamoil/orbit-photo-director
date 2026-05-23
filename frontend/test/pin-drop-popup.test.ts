import { describe, expect, it } from 'vitest';
import { formatShootHint, formatUtcClock } from '../src/map';
import type { UpcomingPass } from '../src/pin-drop';

// Regression: v1.6.1.2 — pin-drop popup gains a "shoot from" hint.
// Anil request 2026-05-23:
//   "It would be nice to show what angle from station window to shoot it
//    and what direction like on the cards. If that makes it too cluttered
//    then we can get rid of the date field because we have a how many
//    minutes field."

function makePass(overrides: Partial<UpcomingPass> = {}): UpcomingPass {
  return {
    closestApproachMs: Date.UTC(2026, 4, 29, 23, 33, 0),
    nadirKm: 250,
    regime: 'iss-twilight',
    issAltKm: 408,
    angleOffNadirDeg: 28,
    relativeBearingDeg: 90,
    ...overrides,
  };
}

describe('formatUtcClock (v1.6.1.2 — dropped date, kept HH:MMZ)', () => {
  it('renders 23:33Z for the Atlas V Amazon Leo example', () => {
    const ms = Date.UTC(2026, 4, 29, 23, 33, 0);
    expect(formatUtcClock(ms)).toBe('23:33Z');
  });

  it('zero-pads single-digit hours and minutes', () => {
    const ms = Date.UTC(2026, 0, 1, 4, 7, 0);
    expect(formatUtcClock(ms)).toBe('04:07Z');
  });

  it('midnight UTC is 00:00Z', () => {
    const ms = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(formatUtcClock(ms)).toBe('00:00Z');
  });

  it('does not include date components', () => {
    const s = formatUtcClock(Date.UTC(2026, 4, 29, 12, 34, 0));
    expect(s).not.toMatch(/2026/);
    expect(s).not.toMatch(/05|29/);
  });
});

describe('formatShootHint (v1.6.1.2 — angle · window · direction)', () => {
  it('returns "" when angle data is missing (legacy 4-col layout)', () => {
    const p = makePass({ angleOffNadirDeg: undefined });
    expect(formatShootHint(p)).toBe('');
  });

  it('returns angle · WORF for narrow-angle passes (<30°)', () => {
    const p = makePass({
      angleOffNadirDeg: 25,
      relativeBearingDeg: 90,
    });
    expect(formatShootHint(p)).toBe('25° · WORF · starboard');
  });

  it('returns angle · Cupola for wide-angle passes (≥30°)', () => {
    const p = makePass({
      angleOffNadirDeg: 45,
      relativeBearingDeg: 90,
    });
    expect(formatShootHint(p)).toBe('45° · Cupola · starboard');
  });

  it('uses Cupola at exactly 30° (the boundary)', () => {
    const p = makePass({ angleOffNadirDeg: 30, relativeBearingDeg: 0 });
    expect(formatShootHint(p)).toContain('Cupola');
  });

  it('uses WORF at 29.9° (just under the boundary)', () => {
    const p = makePass({ angleOffNadirDeg: 29.9, relativeBearingDeg: 0 });
    expect(formatShootHint(p)).toContain('WORF');
  });

  it('omits direction when relative bearing is missing', () => {
    const p = makePass({
      angleOffNadirDeg: 28,
      relativeBearingDeg: undefined,
    });
    expect(formatShootHint(p)).toBe('28° · WORF');
  });

  it('rounds the angle to integer degrees', () => {
    const p = makePass({
      angleOffNadirDeg: 27.6,
      relativeBearingDeg: 90,
    });
    expect(formatShootHint(p)).toBe('28° · WORF · starboard');
  });

  it('formats fore-aft directions correctly', () => {
    expect(formatShootHint(makePass({
      angleOffNadirDeg: 40, relativeBearingDeg: 0,
    }))).toContain('fore');
    expect(formatShootHint(makePass({
      angleOffNadirDeg: 40, relativeBearingDeg: 180,
    }))).toContain('aft');
    expect(formatShootHint(makePass({
      angleOffNadirDeg: 40, relativeBearingDeg: 270,
    }))).toContain('port');
  });
});
