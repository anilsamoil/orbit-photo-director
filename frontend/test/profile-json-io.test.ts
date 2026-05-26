/** Slot 10 — JSON export/import + schema migration framework tests.
 *
 *  Covers:
 *    - Round-trip: export → re-import yields an identical profile
 *    - Hypothetical v0 → v1 migration runs (testing-only fixture; v0 is
 *      not a real production schema)
 *    - Future schema (v2+) rejected with clear error
 *    - Malformed JSON rejected
 *    - Wrong format discriminator rejected
 *    - Per-target validation: invalid targets surface as `targetErrors`
 *      while valid targets still flow through
 *    - downloadProfileJson generates a blob URL + clicks an anchor with
 *      the expected `download` attribute
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CURRENT_PROFILE_VERSION,
  createDefaultProfile,
  saveProfile,
  type PersonalTarget,
  type Profile,
  type ProfileMigrator,
} from '../src/profile';
import {
  PROFILE_EXPORT_FORMAT,
  downloadProfileJson,
  exportProfileJson,
  parseProfileImport,
  readProfileImportFile,
} from '../src/profile-json-io';

const PROFILE = 'jack';
const APP_VERSION = '1.6.12.0';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sampleProfile(): Profile {
  const p = createDefaultProfile(PROFILE);
  p.additions = [
    {
      id: `personal:${PROFILE}:abc`,
      name: 'Boston Aerial',
      lat: 42.36,
      lon: -71.06,
      priority: 8,
      createdAt: '2026-05-26T08:00:00Z',
    },
    {
      id: `personal:${PROFILE}:def`,
      name: 'Mt. Etna',
      lat: 37.75,
      lon: 14.99,
      priority: 7,
      createdAt: '2026-05-26T09:00:00Z',
    },
  ];
  p.removedCuratedIds = ['aurora-scandinavia', 'sahel-dust'];
  p.distanceThresholdKm = 800;
  return p;
}

// ---------------------------------------------------------------------------
// exportProfileJson — envelope shape + content
// ---------------------------------------------------------------------------

describe('exportProfileJson', () => {
  it('produces an envelope with format, schemaVersion, exportedAt, appVersion, profile', () => {
    saveProfile(sampleProfile());
    const text = exportProfileJson(PROFILE, APP_VERSION, new Date('2026-05-26T19:50:00.000Z'));
    const parsed = JSON.parse(text);
    expect(parsed.format).toBe(PROFILE_EXPORT_FORMAT);
    expect(parsed.schemaVersion).toBe(CURRENT_PROFILE_VERSION);
    expect(parsed.exportedAt).toBe('2026-05-26T19:50:00.000Z');
    expect(parsed.appVersion).toBe(APP_VERSION);
    expect(parsed.profile.name).toBe(PROFILE);
    expect(parsed.profile.additions).toHaveLength(2);
    expect(parsed.profile.removedCuratedIds).toEqual(['aurora-scandinavia', 'sahel-dust']);
    expect(parsed.profile.distanceThresholdKm).toBe(800);
  });

  it('throws on missing profile in localStorage', () => {
    expect(() => exportProfileJson('nope', APP_VERSION)).toThrow(/no profile/);
  });

  it('throws on invalid profile name (defense in depth)', () => {
    expect(() => exportProfileJson('JACK', APP_VERSION)).toThrow(/invalid profile name/);
  });

  it('pretty-prints with 2-space indent for human-readable backups', () => {
    saveProfile(sampleProfile());
    const text = exportProfileJson(PROFILE, APP_VERSION);
    expect(text).toContain('\n  "format"');
    expect(text).toContain('\n  "profile"');
  });
});

// ---------------------------------------------------------------------------
// parseProfileImport — happy path + every error code
// ---------------------------------------------------------------------------

describe('parseProfileImport', () => {
  it('round-trips a profile: export → parse → identical profile', () => {
    saveProfile(sampleProfile());
    const text = exportProfileJson(PROFILE, APP_VERSION);
    const result = parseProfileImport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.name).toBe(PROFILE);
    expect(result.profile.additions).toEqual(sampleProfile().additions);
    expect(result.profile.removedCuratedIds).toEqual(['aurora-scandinavia', 'sahel-dust']);
    expect(result.profile.distanceThresholdKm).toBe(800);
    expect(result.targetErrors).toEqual([]);
    expect(result.sourceSchemaVersion).toBe(CURRENT_PROFILE_VERSION);
  });

  it('rejects malformed JSON with code malformed_json + parse error', () => {
    const result = parseProfileImport('{not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('malformed_json');
    expect(result.detail).toBeTruthy();
  });

  it('rejects JSON that is not an object (e.g., an array)', () => {
    const result = parseProfileImport('[]');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('wrong_format');
    expect(result.detail).toMatch(/must be an object/i);
  });

  it('rejects a JSON object without the format discriminator', () => {
    const result = parseProfileImport(JSON.stringify({ schemaVersion: 1, profile: {} }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('wrong_format');
    expect(result.detail).toContain('orbit-photo-director-profile');
  });

  it('rejects a JSON object with the wrong format string', () => {
    const result = parseProfileImport(
      JSON.stringify({ format: 'some-other-app', schemaVersion: 1, profile: {} }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('wrong_format');
  });

  it('rejects when schemaVersion is missing or non-integer', () => {
    const a = parseProfileImport(JSON.stringify({ format: PROFILE_EXPORT_FORMAT, profile: {} }));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe('missing_schema_version');

    const b = parseProfileImport(
      JSON.stringify({ format: PROFILE_EXPORT_FORMAT, schemaVersion: 'one', profile: {} }),
    );
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe('missing_schema_version');

    const c = parseProfileImport(
      JSON.stringify({ format: PROFILE_EXPORT_FORMAT, schemaVersion: 1.5, profile: {} }),
    );
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.code).toBe('missing_schema_version');
  });

  it('rejects schemaVersion newer than CURRENT_PROFILE_VERSION (future export)', () => {
    const futureExport = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: CURRENT_PROFILE_VERSION + 1,
      exportedAt: '2027-01-01T00:00:00Z',
      appVersion: '2.0.0',
      profile: { version: CURRENT_PROFILE_VERSION + 1, name: PROFILE, additions: [] },
    });
    const result = parseProfileImport(futureExport);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('future_schema');
    expect(result.demandedSchemaVersion).toBe(CURRENT_PROFILE_VERSION + 1);
    expect(result.detail).toMatch(/upgrade/i);
  });

  it('rejects when profile object is missing or non-object', () => {
    const a = parseProfileImport(
      JSON.stringify({ format: PROFILE_EXPORT_FORMAT, schemaVersion: 1 }),
    );
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe('missing_profile');

    const b = parseProfileImport(
      JSON.stringify({ format: PROFILE_EXPORT_FORMAT, schemaVersion: 1, profile: [] }),
    );
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe('missing_profile');
  });

  it('rejects an imported profile with an invalid name', () => {
    const result = parseProfileImport(
      JSON.stringify({
        format: PROFILE_EXPORT_FORMAT,
        schemaVersion: 1,
        profile: { version: 1, name: 'JACK', additions: [] },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_profile_name');
  });
});

// ---------------------------------------------------------------------------
// Migration framework — hypothetical v0 → v1 migrator via test injection
// ---------------------------------------------------------------------------

describe('parseProfileImport — migration chain', () => {
  it('runs a hypothetical v0 → v1 migration when schemaVersion=0', () => {
    // v0 fixture: older schema used `personalTargets` instead of `additions`,
    // had no `removedCuratedIds`, no `distanceThresholdKm`. This is a
    // hypothetical pre-v1 shape — v0 was never shipped, but the migration
    // framework must handle it cleanly so future v1 → v2 etc. can plug in.
    const v0Profile = {
      version: 0,
      name: 'jack',
      personalTargets: [
        { id: 'personal:jack:legacy', name: 'Old Site', lat: 10, lon: 20, priority: 5, createdAt: '2025-01-01T00:00:00Z' },
      ],
    };
    const text = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: 0,
      exportedAt: '2025-12-01T00:00:00Z',
      appVersion: '0.9.0',
      profile: v0Profile,
    });

    const v0ToV1: ProfileMigrator = (p) => ({
      ...p,
      version: 1,
      additions: Array.isArray(p.personalTargets) ? p.personalTargets : [],
      removedCuratedIds: [],
      distanceThresholdKm: 1500,
      instantBuffer: [],
      personalTargets: undefined,
    });

    const result = parseProfileImport(text, { migrations: { 0: v0ToV1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.version).toBe(1);
    expect(result.profile.additions).toHaveLength(1);
    expect(result.profile.additions[0]!.name).toBe('Old Site');
    expect(result.sourceSchemaVersion).toBe(0);
  });

  it('returns migration_failed when no migrator is registered for an older version', () => {
    const text = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: 0,
      profile: { version: 0, name: 'jack' },
    });
    // No migrations registered — v0 has no path to v1.
    const result = parseProfileImport(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('migration_failed');
    expect(result.detail).toMatch(/no migration/i);
  });
});

// ---------------------------------------------------------------------------
// Per-target validation: invalid lat/lon/etc. surface as targetErrors
// ---------------------------------------------------------------------------

describe('parseProfileImport — target validation', () => {
  it('surfaces invalid targets via targetErrors while keeping valid ones', () => {
    const text = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: 1,
      exportedAt: '2026-05-26T00:00:00Z',
      appVersion: '1.6.12.0',
      profile: {
        version: 1,
        name: 'jack',
        additions: [
          // valid
          { id: 'personal:jack:a', name: 'Good', lat: 10, lon: 20, priority: 5, createdAt: '2026-05-26T00:00:00Z' },
          // invalid lat
          { id: 'personal:jack:b', name: 'Bad-lat', lat: 999, lon: 0, priority: 5, createdAt: '2026-05-26T00:00:00Z' },
          // valid
          { id: 'personal:jack:c', name: 'Good2', lat: 30, lon: 40, priority: 5, createdAt: '2026-05-26T00:00:00Z' },
        ],
        removedCuratedIds: [],
        distanceThresholdKm: 1500,
        instantBuffer: [],
      },
    });
    const result = parseProfileImport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.additions).toHaveLength(2);
    expect(result.profile.additions.map((t) => t.name)).toEqual(['Good', 'Good2']);
    expect(result.targetErrors).toHaveLength(1);
    expect(result.targetErrors[0]!.index).toBe(1);
    expect(result.targetErrors[0]!.rawName).toBe('Bad-lat');
    expect(result.targetErrors[0]!.code).toBe('lat_out_of_range');
  });

  it('handles a profile with no additions array (coerces to empty)', () => {
    const text = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: 1,
      profile: { version: 1, name: 'jack' },
    });
    const result = parseProfileImport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.additions).toEqual([]);
  });

  it('coerces malformed removedCuratedIds + distanceThresholdKm to safe defaults', () => {
    const text = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: 1,
      profile: {
        version: 1,
        name: 'jack',
        additions: [],
        removedCuratedIds: 'not an array',
        distanceThresholdKm: 'bogus',
      },
    });
    const result = parseProfileImport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.removedCuratedIds).toEqual([]);
    expect(result.profile.distanceThresholdKm).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// downloadProfileJson — blob URL + anchor click
// ---------------------------------------------------------------------------

describe('downloadProfileJson', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('creates a blob URL and clicks an anchor with filename `<name>-profile.json`', () => {
    saveProfile(sampleProfile());
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    let clickedAnchor: HTMLAnchorElement | null = null;
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreateElement(tag) as HTMLAnchorElement;
      if (tag === 'a') {
        // Stub click to capture without actually triggering a download.
        el.click = () => { clickedAnchor = el; };
      }
      return el;
    });

    const result = downloadProfileJson(PROFILE, APP_VERSION);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(result.filename).toBe(`${PROFILE}-profile.json`);
    expect(result.url).toBe('blob:mock-url');
    expect(clickedAnchor).not.toBeNull();
    expect(clickedAnchor!.download).toBe(`${PROFILE}-profile.json`);
    expect(clickedAnchor!.href).toContain('blob:mock-url');
  });

  it('passes JSON content as a Blob of type application/json', () => {
    saveProfile(sampleProfile());
    let capturedBlob: Blob | null = null;
    const createObjectURL = vi.fn((b: Blob) => {
      capturedBlob = b;
      return 'blob:captured';
    });
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: () => {} });
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreateElement(tag) as HTMLAnchorElement;
      if (tag === 'a') el.click = () => {};
      return el;
    });

    downloadProfileJson(PROFILE, APP_VERSION);
    expect(capturedBlob).not.toBeNull();
    expect(capturedBlob!.type).toBe('application/json');
    expect(capturedBlob!.size).toBeGreaterThan(0);
  });

  it('throws if profile does not exist in localStorage', () => {
    expect(() => downloadProfileJson('ghost', APP_VERSION)).toThrow(/no profile/);
  });
});

// ---------------------------------------------------------------------------
// readProfileImportFile — wraps File.text() and parseProfileImport
// ---------------------------------------------------------------------------

describe('readProfileImportFile', () => {
  it('reads a File and returns a successful ImportResult on valid JSON', async () => {
    saveProfile(sampleProfile());
    const text = exportProfileJson(PROFILE, APP_VERSION);
    const file = new File([text], 'jack-profile.json', { type: 'application/json' });
    const result = await readProfileImportFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.additions).toHaveLength(2);
  });

  it('returns malformed_json when File.text() yields invalid JSON', async () => {
    const file = new File(['{nope'], 'bad.json', { type: 'application/json' });
    const result = await readProfileImportFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('malformed_json');
  });

  it('returns malformed_json when File.text() rejects', async () => {
    const fakeFile = {
      text: () => Promise.reject(new Error('disk read failed')),
    } as unknown as File;
    const result = await readProfileImportFile(fakeFile);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('malformed_json');
    expect(result.detail).toContain('disk read failed');
  });
});

// ---------------------------------------------------------------------------
// "Import only valid (N of M)" path — operator picks the partial subset
// ---------------------------------------------------------------------------

describe('parseProfileImport — partial-import semantics', () => {
  it('with 2 valid + 1 invalid yields 2 importable + 1 error', () => {
    const text = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: 1,
      profile: {
        version: 1,
        name: 'jack',
        additions: [
          { id: 'personal:jack:1', name: 'A', lat: 1, lon: 1, priority: 5, createdAt: '2026-05-26T00:00:00Z' },
          { id: 'personal:jack:2', name: '', lat: 2, lon: 2, priority: 5, createdAt: '2026-05-26T00:00:00Z' },
          { id: 'personal:jack:3', name: 'C', lat: 3, lon: 3, priority: 5, createdAt: '2026-05-26T00:00:00Z' },
        ],
        removedCuratedIds: [],
        distanceThresholdKm: 1500,
        instantBuffer: [],
      },
    });
    const result = parseProfileImport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.additions).toHaveLength(2);
    expect(result.targetErrors).toHaveLength(1);
    expect(result.targetErrors[0]!.code).toBe('name_empty');
    expect(result.targetErrors[0]!.index).toBe(1);
  });
});
