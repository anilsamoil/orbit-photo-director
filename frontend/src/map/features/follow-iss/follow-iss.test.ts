import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  it('ships ISS up as the default control', () => {
    const html = readFileSync(resolve(__dirname, '../../../../index.html'), 'utf8');
    const doc = document.createElement('template');
    doc.innerHTML = html;
    const north = doc.content.querySelector('#bearing-north');
    const iss = doc.content.querySelector('#bearing-iss');
    expect(north?.classList.contains('active')).toBe(false);
    expect(iss?.classList.contains('active')).toBe(true);
    expect(north?.getAttribute('title') ?? '').not.toMatch(/default/i);
    expect(iss?.getAttribute('title') ?? '').toMatch(/default/i);
    expect(iss?.getAttribute('title') ?? '').toMatch(/direction of travel/i);
  });

  it('reads iss-up unless the stored bearing is north', () => {
    expect(api().readBearingMode()).toBe('iss-up');
    localStorage.setItem(PREF_KEYS.bearingMode, 'north');
    expect(api().readBearingMode()).toBe('north');
    localStorage.setItem(PREF_KEYS.bearingMode, 'sideways');
    expect(api().readBearingMode()).toBe('iss-up');
  });
});
