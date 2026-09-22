import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREF_KEYS } from '../../map-core/prefs';

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('follow-iss module was not loaded');
  return mod;
}

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  loaded.mod = await import('./index');
});

afterEach(() => {
  localStorage.clear();
});

describe('follow-iss', () => {
  it('reads iss-up unless the stored bearing is north', () => {
    expect(api().readBearingMode()).toBe('iss-up');
    localStorage.setItem(PREF_KEYS.bearingMode, 'north');
    expect(api().readBearingMode()).toBe('north');
    localStorage.setItem(PREF_KEYS.bearingMode, 'sideways');
    expect(api().readBearingMode()).toBe('iss-up');
  });
});
