/** Slot 6 — Profile-tab CRUD tests.
 *
 *  Covers:
 *    - validatePersonalTargetInput field-by-field (mirrors worker)
 *    - addPersonalTarget / removePersonalTarget / toggleCuratedRemoved helpers
 *    - API client: token-missing / network / 4xx-validation / 5xx-http branches
 *    - Optimistic UI: handleAdd persists locally before fetch resolves,
 *      rolls back on API failure
 *    - DOM: buildCrudSection renders the add form + personal list
 *      + curated chips for a mixed-state profile
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addPersonalTarget,
  createDefaultProfile,
  loadProfile,
  makePersonalTargetId,
  removePersonalTarget,
  saveProfile,
  toggleCuratedRemoved,
  validatePersonalTargetInput,
  type PersonalTarget,
} from '../src/profile';
import {
  deleteProfileTarget,
  postProfileTarget,
  putProfileTargets,
} from '../src/profile-api';
import {
  _test,
  buildCrudSection,
  rerenderCrudSection,
} from '../src/profile-crud';

const PROFILE = 'jack';
const TOKEN_KEY = 'opd-calib-token';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, 'test-token');
  // Mount the minimal DOM the CRUD section + toast call into.
  document.body.innerHTML = `
    <div id="toast" hidden></div>
    <main>
      <section id="profile-pane">
        <div id="profile-body"></div>
      </section>
    </main>
  `;
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function mountSection(name: string): HTMLElement {
  const body = document.getElementById('profile-body')!;
  body.replaceChildren();
  const section = buildCrudSection(name);
  body.appendChild(section);
  return section;
}

function makeTarget(overrides: Partial<PersonalTarget> = {}): PersonalTarget {
  return {
    id: overrides.id ?? makePersonalTargetId(PROFILE),
    name: 'Test target',
    lat: 12.5,
    lon: -34.25,
    priority: 5,
    createdAt: '2026-05-26T12:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validatePersonalTargetInput — mirrors worker/src/profiles.ts validateTarget
// ---------------------------------------------------------------------------

describe('validatePersonalTargetInput', () => {
  it('accepts a fully-specified valid target', () => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE,
      name: 'Great Barrier Reef',
      lat: -18.0,
      lon: 147.5,
      priority: 7,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.name).toBe('Great Barrier Reef');
    expect(result.target.lat).toBe(-18.0);
    expect(result.target.lon).toBe(147.5);
    expect(result.target.priority).toBe(7);
    expect(result.target.id.startsWith(`personal:${PROFILE}:`)).toBe(true);
    expect(result.target.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('defaults priority to 5 when missing', () => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE,
      name: 'Foo',
      lat: 0,
      lon: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target.priority).toBe(5);
  });

  it('trims whitespace around name', () => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE,
      name: '   trimmed   ',
      lat: 0,
      lon: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target.name).toBe('trimmed');
  });

  it('rejects empty name', () => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE, name: '   ', lat: 0, lon: 0,
    });
    expect(result).toEqual({ ok: false, error: 'name_empty' });
  });

  it('rejects name over 200 chars', () => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE, name: 'x'.repeat(201), lat: 0, lon: 0,
    });
    expect(result).toEqual({ ok: false, error: 'name_too_long' });
  });

  it('rejects non-finite lat', () => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE, name: 'a', lat: Number.NaN, lon: 0,
    });
    expect(result).toEqual({ ok: false, error: 'lat_must_be_finite_number' });
  });

  it.each([[-91], [91], [180]])('rejects lat out of [-90,90]: %s', (bad) => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE, name: 'a', lat: bad, lon: 0,
    });
    expect(result).toEqual({ ok: false, error: 'lat_out_of_range' });
  });

  it.each([[-181], [181], [360]])('rejects lon out of [-180,180]: %s', (bad) => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE, name: 'a', lat: 0, lon: bad,
    });
    expect(result).toEqual({ ok: false, error: 'lon_out_of_range' });
  });

  it('rejects non-integer priority', () => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE, name: 'a', lat: 0, lon: 0, priority: 3.5,
    });
    expect(result).toEqual({ ok: false, error: 'priority_must_be_integer' });
  });

  it.each([[0], [11], [-1]])('rejects priority out of [1,10]: %s', (bad) => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE, name: 'a', lat: 0, lon: 0, priority: bad,
    });
    expect(result).toEqual({ ok: false, error: 'priority_out_of_range' });
  });

  it('rejects id whose profile portion mismatches', () => {
    const result = validatePersonalTargetInput({
      id: 'personal:chris:abc123',
      profileName: PROFILE,
      name: 'a', lat: 0, lon: 0,
    });
    expect(result).toEqual({ ok: false, error: 'id_profile_mismatch' });
  });

  it('rejects malformed id shape', () => {
    const result = validatePersonalTargetInput({
      id: 'not-a-valid-id',
      profileName: PROFILE,
      name: 'a', lat: 0, lon: 0,
    });
    expect(result).toEqual({ ok: false, error: 'invalid_id' });
  });

  it('rejects invalid profile name', () => {
    const result = validatePersonalTargetInput({
      profileName: 'Jack-Bad',
      name: 'a', lat: 0, lon: 0,
    });
    expect(result).toEqual({ ok: false, error: 'invalid_profile_name' });
  });

  it('rejects malformed createdAt', () => {
    const result = validatePersonalTargetInput({
      profileName: PROFILE, name: 'a', lat: 0, lon: 0,
      createdAt: 'yesterday',
    });
    expect(result).toEqual({ ok: false, error: 'invalid_createdAt' });
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — addPersonalTarget / removePersonalTarget / toggleCuratedRemoved
// ---------------------------------------------------------------------------

describe('addPersonalTarget', () => {
  it('returns a NEW profile with the target appended (immutable)', () => {
    const before = createDefaultProfile(PROFILE);
    const t = makeTarget();
    const after = addPersonalTarget(before, t);
    expect(after).not.toBe(before);
    expect(before.additions).toHaveLength(0);
    expect(after.additions).toHaveLength(1);
    expect(after.additions[0]).toEqual(t);
  });

  it('throws on duplicate id', () => {
    const t = makeTarget();
    const profile = addPersonalTarget(createDefaultProfile(PROFILE), t);
    expect(() => addPersonalTarget(profile, t)).toThrow(/duplicate/);
  });
});

describe('removePersonalTarget', () => {
  it('removes by id and returns a new profile object', () => {
    const t = makeTarget();
    const profile = addPersonalTarget(createDefaultProfile(PROFILE), t);
    const after = removePersonalTarget(profile, t.id);
    expect(after.additions).toHaveLength(0);
    expect(after).not.toBe(profile);
  });

  it('is a no-op (and returns the SAME reference) when id is missing', () => {
    const profile = createDefaultProfile(PROFILE);
    const after = removePersonalTarget(profile, 'personal:jack:missing');
    expect(after).toBe(profile);
  });
});

describe('toggleCuratedRemoved', () => {
  it('adds when absent, removes when present (symmetric)', () => {
    const p = createDefaultProfile(PROFILE);
    const after = toggleCuratedRemoved(p, 'aurora-scandinavia');
    expect(after.removedCuratedIds).toEqual(['aurora-scandinavia']);
    const restored = toggleCuratedRemoved(after, 'aurora-scandinavia');
    expect(restored.removedCuratedIds).toEqual([]);
  });

  it('ignores empty / non-string id (defensive)', () => {
    const p = createDefaultProfile(PROFILE);
    const after = toggleCuratedRemoved(p, '');
    expect(after).toBe(p);
  });
});

// ---------------------------------------------------------------------------
// API client — fetch-mock + result discrimination
// ---------------------------------------------------------------------------

describe('profile-api', () => {
  it('postProfileTarget returns token_missing when no calib token is set', async () => {
    localStorage.removeItem(TOKEN_KEY);
    const t = makeTarget();
    const r = await postProfileTarget(PROFILE, t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_missing');
  });

  it('postProfileTarget sends x-calib-token + JSON body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const t = makeTarget();
    const r = await postProfileTarget(PROFILE, t);
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calls = fetchMock.mock.calls as unknown[][];
    const [url, init] = calls[0]! as [string, RequestInit];
    expect(url).toBe(`/api/profiles/${PROFILE}/targets`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-calib-token']).toBe('test-token');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(t);
  });

  it('postProfileTarget categorises 4xx validation errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_target', detail: 'lat_out_of_range' }), { status: 400 }),
    ));
    const r = await postProfileTarget(PROFILE, makeTarget());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('validation');
      expect(r.status).toBe(400);
    }
  });

  it('postProfileTarget categorises 5xx as http', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 }),
    ));
    const r = await postProfileTarget(PROFILE, makeTarget());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('http');
      expect(r.status).toBe(503);
    }
  });

  it('postProfileTarget returns network on fetch throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('no network'); }));
    const r = await postProfileTarget(PROFILE, makeTarget());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('network');
  });

  it('deleteProfileTarget URL-encodes the target id', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, removed: true, count: 0 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const id = 'personal:jack:abc-123_def';
    const r = await deleteProfileTarget(PROFILE, id);
    expect(r.ok).toBe(true);
    const calls = fetchMock.mock.calls as unknown[][];
    const [url, init] = calls[0]! as [string, RequestInit];
    expect(url).toBe(`/api/profiles/${PROFILE}/targets/${encodeURIComponent(id)}`);
    expect(init.method).toBe('DELETE');
  });

  it('putProfileTargets wraps in {targets:[...]} payload shape', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const t = makeTarget();
    await putProfileTargets(PROFILE, [t]);
    const calls = fetchMock.mock.calls as unknown[][];
    const init = calls[0]![1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ targets: [t] });
  });
});

// ---------------------------------------------------------------------------
// Optimistic UI — handleAdd / handleDelete / handleToggleCurated
// ---------------------------------------------------------------------------

describe('optimistic add flow', () => {
  beforeEach(() => {
    saveProfile(createDefaultProfile(PROFILE));
    mountSection(PROFILE);
  });

  it('persists the target locally BEFORE the API call resolves', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => pending));

    const t = makeTarget({ name: 'Optimistic' });
    const promise = _test.handleAdd(PROFILE, t);
    // Microtask flush so the synchronous saveProfile + rerender ran.
    await Promise.resolve();
    const mid = loadProfile(PROFILE)!;
    expect(mid.additions).toHaveLength(1);
    expect(mid.additions[0]!.name).toBe('Optimistic');

    // Resolve fetch successfully — final state still has the target.
    resolveFetch(new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 }));
    await promise;
    expect(loadProfile(PROFILE)!.additions).toHaveLength(1);
  });

  it('rolls back local state when the API returns 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 }),
    ));
    const t = makeTarget({ name: 'Doomed' });
    const result = await _test.handleAdd(PROFILE, t);
    expect(result).not.toBe('ok');
    expect(loadProfile(PROFILE)!.additions).toHaveLength(0);
  });

  it('rolls back local state when fetch throws (offline)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const t = makeTarget({ name: 'Offline' });
    await _test.handleAdd(PROFILE, t);
    expect(loadProfile(PROFILE)!.additions).toHaveLength(0);
  });

  it('rolls back local state when the API returns 401 (token rejected)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    ));
    const t = makeTarget();
    await _test.handleAdd(PROFILE, t);
    expect(loadProfile(PROFILE)!.additions).toHaveLength(0);
  });
});

describe('optimistic delete flow', () => {
  let existing: PersonalTarget;
  beforeEach(() => {
    existing = makeTarget({ name: 'To delete' });
    const seeded = addPersonalTarget(createDefaultProfile(PROFILE), existing);
    saveProfile(seeded);
    mountSection(PROFILE);
  });

  it('removes locally then calls DELETE', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, removed: true, count: 0 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await _test.handleDelete(PROFILE, existing);
    expect(loadProfile(PROFILE)!.additions).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calls = fetchMock.mock.calls as unknown[][];
    expect((calls[0]![1] as RequestInit).method).toBe('DELETE');
  });

  it('rolls back the deletion when API errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 }),
    ));
    await _test.handleDelete(PROFILE, existing);
    const after = loadProfile(PROFILE)!;
    expect(after.additions).toHaveLength(1);
    expect(after.additions[0]!.id).toBe(existing.id);
  });
});

describe('curated toggle flow', () => {
  beforeEach(() => {
    saveProfile(createDefaultProfile(PROFILE));
    mountSection(PROFILE);
  });

  it('persists hide → restore round-trip without an API call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await _test.handleToggleCurated(PROFILE, 'aurora-scandinavia', true);
    expect(loadProfile(PROFILE)!.removedCuratedIds).toEqual(['aurora-scandinavia']);
    await _test.handleToggleCurated(PROFILE, 'aurora-scandinavia', false);
    expect(loadProfile(PROFILE)!.removedCuratedIds).toEqual([]);
    // Curated removal is local-only (daemon reads from profile JSON);
    // verify we didn't accidentally make an API call.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DOM rendering — mixed curated / personal list
// ---------------------------------------------------------------------------

describe('buildCrudSection DOM', () => {
  it('renders the add form with name + lat + lon + priority inputs', () => {
    saveProfile(createDefaultProfile(PROFILE));
    const section = mountSection(PROFILE);
    expect(section.querySelector('#profile-add-name')).not.toBeNull();
    expect(section.querySelector('#profile-add-lat')).not.toBeNull();
    expect(section.querySelector('#profile-add-lon')).not.toBeNull();
    expect(section.querySelector('#profile-add-priority')).not.toBeNull();
    expect(section.querySelector('#profile-add-btn')).not.toBeNull();
  });

  it('shows empty-state copy when there are no personal targets', () => {
    saveProfile(createDefaultProfile(PROFILE));
    const section = mountSection(PROFILE);
    const empty = section.querySelector('.profile-crud-empty');
    expect(empty?.textContent).toMatch(/No personal targets/);
  });

  it('renders one row per personal target', () => {
    let p = createDefaultProfile(PROFILE);
    p = addPersonalTarget(p, makeTarget({ id: makePersonalTargetId(PROFILE), name: 'Alpha' }));
    p = addPersonalTarget(p, makeTarget({ id: makePersonalTargetId(PROFILE), name: 'Beta' }));
    saveProfile(p);
    const section = mountSection(PROFILE);
    const rows = section.querySelectorAll('[data-kind="personal"]');
    expect(rows).toHaveLength(2);
    const names = Array.from(rows).map((r) => r.querySelector('.profile-crud-name')?.textContent);
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
  });

  it('renders a chip per removedCuratedId (mixed curated/personal)', () => {
    let p = createDefaultProfile(PROFILE);
    p = addPersonalTarget(p, makeTarget({ name: 'Personal A' }));
    p = toggleCuratedRemoved(p, 'aurora-scandinavia');
    p = toggleCuratedRemoved(p, 'patagonia-glaciers');
    saveProfile(p);
    const section = mountSection(PROFILE);
    expect(section.querySelectorAll('[data-kind="personal"]')).toHaveLength(1);
    const chips = section.querySelectorAll('[data-kind="curated"]');
    expect(chips).toHaveLength(2);
    const ids = Array.from(chips).map((c) => (c as HTMLElement).dataset.curatedId);
    expect(ids).toContain('aurora-scandinavia');
    expect(ids).toContain('patagonia-glaciers');
  });

  it('escapes operator-controlled name via textContent (no innerHTML)', () => {
    let p = createDefaultProfile(PROFILE);
    p = addPersonalTarget(p, makeTarget({ name: '<script>alert(1)</script>' }));
    saveProfile(p);
    const section = mountSection(PROFILE);
    const row = section.querySelector('[data-kind="personal"] .profile-crud-name') as HTMLElement;
    expect(row.textContent).toBe('<script>alert(1)</script>');
    // No script element actually injected
    expect(section.querySelector('script')).toBeNull();
  });

  it('rerenderCrudSection swaps the mounted node in place', () => {
    saveProfile(createDefaultProfile(PROFILE));
    mountSection(PROFILE);
    const first = document.getElementById('profile-crud-section');
    rerenderCrudSection(PROFILE);
    const second = document.getElementById('profile-crud-section');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});
