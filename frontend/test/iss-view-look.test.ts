import { describe, expect, it } from 'vitest';

import { lookRoom, nudgeLook, settleLook } from '../src/iss-view/look';

describe('ISS look clamp', () => {
  const wide = lookRoom(81.2, 600, 400, 69.58);
  const narrow = lookRoom(12, 600, 400, 69.58);

  it('lets a wide field turn less from nadir and a narrow field turn less past the horizon', () => {
    expect(wide.radiusDeg).toBeLessThan(69.58);
    expect(narrow.radiusDeg).toBeGreaterThan(wide.radiusDeg);
    expect(narrow.outwardDeg).toBeLessThan(wide.outwardDeg);
    expect(wide.outwardDeg).toBeLessThan(wide.radiusDeg);
  });

  it('keeps an ordinary pan and eases an extreme one back as soon as the drag reverses', () => {
    const ordinary = nudgeLook({ rightDeg: 0, upDeg: 0 }, { rightDeg: 10, upDeg: 0 }, 'nadir', wide);
    expect(ordinary).toEqual({ rightDeg: 10, upDeg: 0 });

    const slammed = nudgeLook({ rightDeg: 0, upDeg: 0 }, { rightDeg: 400, upDeg: 0 }, 'nadir', wide);
    const slammedMag = Math.hypot(slammed.rightDeg, slammed.upDeg);
    expect(slammedMag).toBeLessThan(wide.radiusDeg);
    expect(slammedMag).toBeGreaterThan(wide.radiusDeg * 0.8);

    const backed = nudgeLook(slammed, { rightDeg: -8, upDeg: 0 }, 'nadir', wide);
    expect(Math.hypot(backed.rightDeg, backed.upDeg)).toBeLessThan(slammedMag - 2);
  });

  it('resists a push past the horizon and still accepts the reverse', () => {
    const out = nudgeLook({ rightDeg: 0, upDeg: 0 }, { rightDeg: 0, upDeg: -80 }, 'horizon', wide);
    expect(-out.upDeg).toBeLessThanOrEqual(wide.outwardDeg);
    expect(-out.upDeg).toBeGreaterThan(wide.outwardDeg * 0.8);
    const back = nudgeLook(out, { rightDeg: 0, upDeg: 3 }, 'horizon', wide);
    expect(back.upDeg).toBeGreaterThan(out.upDeg + 2);
  });

  it('pulls a telephoto aim back in when the field widens', () => {
    const parked = { rightDeg: narrow.radiusDeg, upDeg: 0 };
    const settled = settleLook(parked, 'nadir', wide);
    expect(Math.hypot(settled.rightDeg, settled.upDeg)).toBeCloseTo(wide.radiusDeg, 5);
    expect(settleLook({ rightDeg: 4, upDeg: -1 }, 'horizon', wide)).toEqual({ rightDeg: 4, upDeg: -1 });
  });
});
