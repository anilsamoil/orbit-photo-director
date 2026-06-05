import { describe, expect, it } from 'vitest';

import { formatTrackOffset } from '../src/track-offset';

// CEO-target-sheet convention: "x° right/left of track" where x = off-nadir.
// At closest the target is abeam, so off-nadir IS the degrees right/left of
// track. Side comes from the bearing half (robust to 30s sampling jitter that
// scatters the bearing magnitude); magnitude comes from off-nadir.
describe('formatTrackOffset', () => {
  it('uses off-nadir as the magnitude and the bearing half as the side', () => {
    expect(formatTrackOffset(26, 90)).toBe('26° right of track');   // abeam-starboard
    expect(formatTrackOffset(14, 270)).toBe('14° left of track');   // abeam-port
  });

  it('takes only the SIDE from the bearing — magnitude is the off-nadir, not the bearing', () => {
    // The closest bearing is sampling-scattered (e.g. 29°, 127°), but both are
    // still on the starboard/right side → "right of track" regardless.
    expect(formatTrackOffset(13.7, 29)).toBe('14° right of track');
    expect(formatTrackOffset(13.7, 127.8)).toBe('14° right of track');
    expect(formatTrackOffset(12, 229)).toBe('12° left of track');
  });

  it('rounds the off-nadir magnitude', () => {
    expect(formatTrackOffset(13.7, 90)).toBe('14° right of track');
    expect(formatTrackOffset(57.4, 95)).toBe('57° right of track');
  });

  it('says "nadir" when off-nadir rounds to 0 (side is meaningless directly below)', () => {
    expect(formatTrackOffset(0, 90)).toBe('nadir');
    expect(formatTrackOffset(0.4, 270)).toBe('nadir');
  });

  it('pins the exact fore/aft axis side convention (< 180 split)', () => {
    // Degenerate at closest (target is abeam, not on-axis), but pin the boundary.
    expect(formatTrackOffset(20, 0)).toBe('20° right of track');    // fore → right
    expect(formatTrackOffset(20, 180)).toBe('20° left of track');   // aft → left
  });

  it('normalizes out-of-range bearings for the side', () => {
    expect(formatTrackOffset(20, 450)).toBe('20° right of track');   // 450 → 90 → right
    expect(formatTrackOffset(20, -90)).toBe('20° left of track');     // -90 → 270 → left
  });
});
