import { beforeEach, describe, expect, it, vi } from 'vitest';

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('time-scrub module was not loaded');
  return mod;
}

beforeEach(async () => {
  vi.resetModules();
  loaded.mod = await import('./index');
});

describe('time-scrub', () => {
  it('clamps the lookahead to whole minutes inside the 36 hour horizon', () => {
    expect(api().clampLookahead(1.4)).toBe(1);
    expect(api().clampLookahead(-5)).toBe(0);
    expect(api().clampLookahead(Number.NaN)).toBe(0);
    expect(api().clampLookahead(99_999)).toBe(api().LOOKAHEAD_MAX_MINUTES);
  });
});
