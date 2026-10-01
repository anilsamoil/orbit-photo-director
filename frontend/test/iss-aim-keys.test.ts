import { describe, expect, it } from 'vitest';

import { AIM_KEYS, aimHelpRows, indexAimKeys } from '../src/iss-view/aim-keys';

describe('ISS aim key table', () => {
  it('covers every live key exactly once and keeps the field step inverse', () => {
    const covered = aimHelpRows().flatMap((row) => [...row.keys]).sort();
    expect(covered).toEqual(Object.keys(AIM_KEYS).sort());
    const narrow = AIM_KEYS['+'];
    const widen = AIM_KEYS['-'];
    expect(narrow).toEqual(AIM_KEYS['=']);
    expect(widen).toEqual(AIM_KEYS['_']);
    expect(AIM_KEYS.r).toEqual({ kind: 'reset' });
    expect(AIM_KEYS.R).toEqual(AIM_KEYS.r);
    expect(AIM_KEYS.Escape).toEqual(AIM_KEYS.r);
    expect(AIM_KEYS['7']).toEqual({ kind: 'window', id: 7 });
    expect(AIM_KEYS.h).toEqual({ kind: 'preset', mode: 'horizon' });
    expect(AIM_KEYS.s).toEqual({ kind: 'preset', mode: 'nadir' });
    expect(narrow?.kind).toBe('fov');
    expect(widen?.kind).toBe('fov');
    if (narrow?.kind !== 'fov' || widen?.kind !== 'fov') return;
    expect(narrow.factor).toBeLessThan(1);
    expect(widen.factor).toBeCloseTo(1 / narrow.factor, 8);
    for (const arrow of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const plain = AIM_KEYS[arrow];
      const fine = AIM_KEYS[`Shift+${arrow}`];
      expect(plain?.kind).toBe('pan');
      expect(fine?.kind).toBe('pan');
      if (plain?.kind !== 'pan' || fine?.kind !== 'pan') continue;
      expect(fine.right).toBe(plain.right);
      expect(fine.up).toBe(plain.up);
      expect(fine.fraction).toBeCloseTo(plain.fraction / 4, 8);
      expect(fine.fraction).toBeGreaterThan(0);
      expect(fine.fraction).toBeLessThan(plain.fraction);
    }
  });

  it('rejects a key claimed by two chords', () => {
    expect(() => indexAimKeys([
      { keys: ['r'], action: { kind: 'reset' }, row: 'reset' },
      { keys: ['r', 'R'], action: { kind: 'reset' }, row: 'reset' },
    ])).toThrow('duplicate aim key: r');
  });
});
