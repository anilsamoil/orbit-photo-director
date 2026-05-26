import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_PROFILE_VERSION,
  DEFAULT_PROFILE_NAME,
  createDefaultProfile,
  isValidProfileName,
  listProfiles,
  loadOrCreateProfileFromURL,
  loadProfile,
  migrate,
  parseProfileFromURL,
  saveProfile,
} from '../src/profile';

// Slot 1 of design rev 2 — locked 2026-05-26.
// Covers: profile data model, URL parsing, schema migration framework,
// localStorage namespace isolation between profiles, and the
// 'profile-changed' event dispatch contract that subscribers (Map tab,
// topbar, Queue list builder) rely on in later slots.

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// isValidProfileName
// ---------------------------------------------------------------------------

describe('isValidProfileName', () => {
  it('accepts simple lowercase ASCII names', () => {
    expect(isValidProfileName('jack')).toBe(true);
    expect(isValidProfileName('chris')).toBe(true);
    expect(isValidProfileName('anil')).toBe(true);
  });

  it('accepts digits and hyphens but not as the first character', () => {
    expect(isValidProfileName('jack-2')).toBe(true);
    expect(isValidProfileName('astro1')).toBe(true);
    expect(isValidProfileName('a1-b2')).toBe(true);
    expect(isValidProfileName('-jack')).toBe(false);
  });

  it('rejects uppercase, spaces, slashes, dots, traversal attempts', () => {
    expect(isValidProfileName('Jack')).toBe(false);
    expect(isValidProfileName('jack jr')).toBe(false);
    expect(isValidProfileName('jack/admin')).toBe(false);
    expect(isValidProfileName('../etc/passwd')).toBe(false);
    expect(isValidProfileName('jack.profile')).toBe(false);
  });

  it('rejects empty and too-long names', () => {
    expect(isValidProfileName('')).toBe(false);
    expect(isValidProfileName('a'.repeat(33))).toBe(false);
    expect(isValidProfileName('a'.repeat(32))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseProfileFromURL — the URL-routes-profile decision from the eng review.
// ---------------------------------------------------------------------------

describe('parseProfileFromURL', () => {
  it('reads ?u=<name> from the query string', () => {
    expect(parseProfileFromURL('https://map.astroanil.dev/?u=jack')).toBe('jack');
  });

  it('reads first path segment when ?u= is absent', () => {
    expect(parseProfileFromURL('https://map.astroanil.dev/chris')).toBe('chris');
  });

  it('?u= takes precedence over path segment', () => {
    expect(
      parseProfileFromURL('https://map.astroanil.dev/chris?u=jack'),
    ).toBe('jack');
  });

  it('falls back to DEFAULT_PROFILE_NAME when neither is present', () => {
    expect(parseProfileFromURL('https://map.astroanil.dev/')).toBe(DEFAULT_PROFILE_NAME);
    expect(parseProfileFromURL('https://map.astroanil.dev/?other=x')).toBe(DEFAULT_PROFILE_NAME);
  });

  it('falls back to default on invalid ?u= value', () => {
    // Uppercase fails validation; default kicks in instead of leaking
    // a typo into the manifest fetch URL.
    expect(parseProfileFromURL('https://map.astroanil.dev/?u=JACK')).toBe(DEFAULT_PROFILE_NAME);
    expect(parseProfileFromURL('https://map.astroanil.dev/?u=jack.jr')).toBe(DEFAULT_PROFILE_NAME);
    expect(parseProfileFromURL('https://map.astroanil.dev/?u=')).toBe(DEFAULT_PROFILE_NAME);
  });

  it('falls back to default on invalid path segment', () => {
    expect(parseProfileFromURL('https://map.astroanil.dev/JACK')).toBe(DEFAULT_PROFILE_NAME);
    expect(parseProfileFromURL('https://map.astroanil.dev/has.dots')).toBe(DEFAULT_PROFILE_NAME);
    // URL parser normalizes `..` before we see it, so /../etc resolves
    // to /etc — and "etc" IS a valid profile name. The traversal defense
    // is at the validation-pattern layer; URL-level traversal can't
    // produce names containing slashes anyway.
    expect(parseProfileFromURL('https://map.astroanil.dev/../etc')).toBe('etc');
  });

  it('handles malformed URLs by falling back to default', () => {
    expect(parseProfileFromURL('not a url')).toBe(DEFAULT_PROFILE_NAME);
    expect(parseProfileFromURL('javascript:alert(1)')).toBe(DEFAULT_PROFILE_NAME);
  });

  it('accepts a URL object as input', () => {
    expect(parseProfileFromURL(new URL('https://map.astroanil.dev/?u=jack'))).toBe('jack');
  });
});

// ---------------------------------------------------------------------------
// createDefaultProfile + roundtrip — fresh profiles match the schema and
// survive save → load cycles unchanged.
// ---------------------------------------------------------------------------

describe('createDefaultProfile', () => {
  it('produces a valid profile with locked defaults', () => {
    const p = createDefaultProfile('jack');
    expect(p.version).toBe(CURRENT_PROFILE_VERSION);
    expect(p.name).toBe('jack');
    expect(p.additions).toEqual([]);
    expect(p.removedCuratedIds).toEqual([]);
    expect(p.distanceThresholdKm).toBe(1500); // matches ISS_HORIZON_KM
    expect(p.instantBuffer).toEqual([]);
  });

  it('refuses to create a profile with an invalid name', () => {
    expect(() => createDefaultProfile('Jack')).toThrow(/invalid/i);
    expect(() => createDefaultProfile('../etc')).toThrow(/invalid/i);
  });
});

describe('save/load roundtrip', () => {
  it('saves and reads back an identical profile', () => {
    const p = createDefaultProfile('jack');
    p.additions.push({
      id: 'personal:jack:abc',
      name: 'Boston',
      lat: 42.36,
      lon: -71.06,
      priority: 5,
      createdAt: '2026-05-26T08:00:00Z',
    });
    p.distanceThresholdKm = 800;
    saveProfile(p);
    const loaded = loadProfile('jack');
    expect(loaded).toEqual(p);
  });

  it('returns null for a profile that was never saved', () => {
    expect(loadProfile('jack')).toBeNull();
  });

  it('returns null for an invalid name without touching localStorage', () => {
    localStorage.setItem('opd-profile-JACK', '{"version":1}');
    expect(loadProfile('JACK')).toBeNull();
  });

  it('isolates profiles by name — no cross-contamination', () => {
    const jack = createDefaultProfile('jack');
    jack.distanceThresholdKm = 800;
    const chris = createDefaultProfile('chris');
    chris.distanceThresholdKm = 1500;
    saveProfile(jack);
    saveProfile(chris);
    const jackLoaded = loadProfile('jack')!;
    const chrisLoaded = loadProfile('chris')!;
    expect(jackLoaded.distanceThresholdKm).toBe(800);
    expect(chrisLoaded.distanceThresholdKm).toBe(1500);
    // Mutating one's additions must not affect the other's stored copy.
    jackLoaded.additions.push({
      id: 'x', name: 'X', lat: 0, lon: 0, priority: 5, createdAt: '2026-05-26T00:00:00Z',
    });
    saveProfile(jackLoaded);
    expect(loadProfile('chris')!.additions).toEqual([]);
  });

  it('throws on corrupted localStorage with a clear message', () => {
    localStorage.setItem('opd-profile-jack', '{this is not json');
    expect(() => loadProfile('jack')).toThrow(/failed to load profile "jack"/);
  });

  it('refuses to save a profile whose version differs from CURRENT', () => {
    const stale = { ...createDefaultProfile('jack'), version: 0 };
    expect(() => saveProfile(stale)).toThrow(/version/);
  });

  it('refuses to save under an invalid name', () => {
    const p = createDefaultProfile('jack');
    const evil = { ...p, name: '../etc/passwd' };
    expect(() => saveProfile(evil)).toThrow(/invalid name/);
  });
});

// ---------------------------------------------------------------------------
// Schema migration framework
// ---------------------------------------------------------------------------

describe('migrate', () => {
  it('returns the profile unchanged at CURRENT_PROFILE_VERSION', () => {
    const p = createDefaultProfile('jack');
    expect(migrate(p as unknown as Record<string, unknown>)).toEqual(p);
  });

  it('throws with a clear message on an unknown older version', () => {
    // v1 has no v0 → v1 migrator yet (MIGRATIONS is empty); the message
    // tells the caller to discard + recreate.
    expect(() => migrate({ version: 0 } as Record<string, unknown>)).toThrow(
      /no migration from profile version 0/i,
    );
  });

  it('throws when the stored version is newer than the current build', () => {
    // Future profile written by a newer app build the user later
    // downgraded from — refuse to downgrade silently.
    expect(() => migrate({ version: 999 } as Record<string, unknown>)).toThrow(
      /newer than this build/i,
    );
  });

  it('treats a missing version field as version 0 (forces migration)', () => {
    // A profile without `version` is from a hypothetical pre-v1 era. The
    // migrate() call should treat that as version 0 and throw the same
    // "no migration" error rather than silently accepting bad data.
    expect(() => migrate({ name: 'jack', additions: [] })).toThrow(
      /no migration from profile version 0/i,
    );
  });
});

// ---------------------------------------------------------------------------
// listProfiles — drives the picker dropdown in Slot 2.
// ---------------------------------------------------------------------------

describe('listProfiles', () => {
  it('returns [] when no profiles have been saved', () => {
    expect(listProfiles()).toEqual([]);
  });

  it('returns sorted names of saved profiles', () => {
    saveProfile(createDefaultProfile('jack'));
    saveProfile(createDefaultProfile('anil'));
    saveProfile(createDefaultProfile('chris'));
    expect(listProfiles()).toEqual(['anil', 'chris', 'jack']);
  });

  it('does not duplicate entries when the same profile is saved twice', () => {
    const p = createDefaultProfile('jack');
    saveProfile(p);
    saveProfile(p);
    expect(listProfiles()).toEqual(['jack']);
  });

  it('filters out invalid names from a corrupted list', () => {
    // Defensive: if the list itself is tampered with, never surface bad
    // names to the picker.
    localStorage.setItem(
      'opd-profile-names',
      JSON.stringify(['jack', 'JACK', '../etc', 'chris', 12345]),
    );
    expect(listProfiles()).toEqual(['chris', 'jack']);
  });

  it('returns [] on corrupted JSON without throwing', () => {
    localStorage.setItem('opd-profile-names', '{nope');
    expect(listProfiles()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadOrCreateProfileFromURL — main.ts boot's one-call entry point.
// ---------------------------------------------------------------------------

describe('loadOrCreateProfileFromURL', () => {
  it('creates a default profile on first visit with ?u=jack', () => {
    const p = loadOrCreateProfileFromURL('https://map.astroanil.dev/?u=jack');
    expect(p.name).toBe('jack');
    expect(p.version).toBe(CURRENT_PROFILE_VERSION);
    expect(p.additions).toEqual([]);
    // And it's now in the list for the picker.
    expect(listProfiles()).toContain('jack');
  });

  it('returns the existing profile on a return visit', () => {
    const first = loadOrCreateProfileFromURL('https://map.astroanil.dev/?u=jack');
    first.distanceThresholdKm = 800;
    saveProfile(first);
    const second = loadOrCreateProfileFromURL('https://map.astroanil.dev/?u=jack');
    expect(second.distanceThresholdKm).toBe(800);
  });

  it('falls back to DEFAULT_PROFILE_NAME when URL has no profile hint', () => {
    const p = loadOrCreateProfileFromURL('https://map.astroanil.dev/');
    expect(p.name).toBe(DEFAULT_PROFILE_NAME);
  });
});

// ---------------------------------------------------------------------------
// 'profile-changed' event — subscribers rely on this in Slot 11.
// ---------------------------------------------------------------------------

describe("'profile-changed' event", () => {
  it('fires when a profile is saved, carrying the profile name in detail', () => {
    const handler = vi.fn();
    window.addEventListener('profile-changed', handler as EventListener);
    try {
      saveProfile(createDefaultProfile('jack'));
      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0]![0] as CustomEvent;
      expect(event.detail).toEqual({ name: 'jack' });
    } finally {
      window.removeEventListener('profile-changed', handler as EventListener);
    }
  });

  it('fires once per save call (no double-dispatch)', () => {
    const handler = vi.fn();
    window.addEventListener('profile-changed', handler as EventListener);
    try {
      const p = createDefaultProfile('jack');
      saveProfile(p);
      saveProfile(p);
      saveProfile(p);
      expect(handler).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener('profile-changed', handler as EventListener);
    }
  });
});
