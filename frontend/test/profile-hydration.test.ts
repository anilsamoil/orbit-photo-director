/** Slot 6b — Profile pane API hydration tests.
 *
 *  Covers the one-shot GET that fires on Profile-pane render:
 *    - profile-api.getProfileTargets (URL, headers, response shape)
 *    - profile-crud.hydratePersonalTargets (additive merge and mutation guards,
 *      silent-fail surfaces, save + rerender on success)
 *    - buildCrudSection wires the hydrate call on mount
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ account: null as { name: string; displayName: string; isVerified?: boolean } | null }));
vi.mock('../src/profile-session', () => ({ getAccountProfile: () => session.account }));

import {
  addPersonalTarget,
  createDefaultProfile,
  loadProfile,
  makePersonalTargetId,
  removePersonalTarget,
  saveProfile,
  type PersonalTarget,
} from '../src/profile';
import { getProfileTargets } from '../src/profile-api';
import { _test, buildCrudSection } from '../src/profile-crud';
import { markProfileTargetsChanged, profileTargetRevision, resetProfileTargetSyncForTests } from '../src/profile-target-sync';

const PROFILE = 'jack';
const TOKEN_KEY = 'opd-calib-token';

beforeEach(() => {
  session.account = null;
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, 'test-token');
  // Each test simulates a fresh page load — clear the per-session
  // hydrated-profiles set so buildCrudSection re-hydrates.
  _test.resetHydrationState();
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
  session.account = null;
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function makeServerTarget(name: string): PersonalTarget {
  return {
    id: makePersonalTargetId(PROFILE),
    name,
    lat: 40.0,
    lon: -74.0,
    priority: 5,
    createdAt: '2026-05-25T10:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// getProfileTargets — fetch wrapper
// ---------------------------------------------------------------------------

describe('getProfileTargets', () => {
  it('sends a same-origin session GET without a token to the right URL', async () => {
    localStorage.removeItem(TOKEN_KEY);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ targets: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await getProfileTargets(PROFILE)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`/api/browser/profiles/${PROFILE}/targets`, expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
  });

  it('parses targets array out of the response body', async () => {
    const t1 = makeServerTarget('Server Alpha');
    const t2 = makeServerTarget('Server Beta');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, targets: [t1, t2] }), { status: 200 }),
    ));
    const r = await getProfileTargets(PROFILE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.targets).toHaveLength(2);
      expect(r.data.targets[0]!.name).toBe('Server Alpha');
    }
  });

  it('rejects a missing targets field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      // Some unexpected shape — body is {ok:true} but no targets.
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ));
    const r = await getProfileTargets(PROFILE);
    expect(r.ok).toBe(false);
  });

  it('reports http on 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 }),
    ));
    const r = await getProfileTargets(PROFILE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('http');
      expect(r.status).toBe(503);
    }
  });

  it('reports network on fetch throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const r = await getProfileTargets(PROFILE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('network');
  });
});

// ---------------------------------------------------------------------------
// hydratePersonalTargets — preserve-local guard + side effects
// ---------------------------------------------------------------------------

describe('hydratePersonalTargets', () => {
  it('populates local additions when local is empty and server has targets', async () => {
    saveProfile(createDefaultProfile(PROFILE));
    const serverTargets = [
      makeServerTarget('Server 1'),
      makeServerTarget('Server 2'),
      makeServerTarget('Server 3'),
    ];
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, targets: serverTargets }), { status: 200 }),
    ));
    // Mount section so the rerender side-effect has something to replace.
    document.getElementById('profile-body')!.appendChild(buildCrudSection(PROFILE));

    await _test.hydratePersonalTargets(PROFILE);

    const after = loadProfile(PROFILE)!;
    expect(after.additions).toHaveLength(3);
    expect(after.additions.map((t) => t.name)).toEqual([
      'Server 1', 'Server 2', 'Server 3',
    ]);
  });

  it('adds Tuvalu from the server to an existing two-target device without replacing local values', async () => {
    const local = [makeServerTarget('Local Alpha'), makeServerTarget('Local Beta')];
    const tuvalu = { ...makeServerTarget('Tuvalu'), lat: -8.525292, lon: 179.196561 };
    saveProfile({ ...createDefaultProfile(PROFILE), additions: local, distanceThresholdKm: 700, removedCuratedIds: ['tokyo'] });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ targets: [{ ...local[0], name: 'Older server Alpha' }, local[1], tuvalu] })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await _test.hydratePersonalTargets(PROFILE);

    const after = loadProfile(PROFILE)!;
    expect(after.additions).toEqual([...local, tuvalu]);
    expect(after.distanceThresholdKm).toBe(700);
    expect(after.removedCuratedIds).toEqual(['tokyo']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves every local-only or unsynced item when the server omits it', async () => {
    const local = makeServerTarget('Unsynced local');
    const remote = makeServerTarget('Other device');
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), local));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ targets: [remote, remote] }))));
    await _test.hydratePersonalTargets(PROFILE);
    expect(loadProfile(PROFILE)!.additions).toEqual([local, remote]);
  });

  it('rejects the wrong account before fetching and rejects cross-profile response items', async () => {
    saveProfile(createDefaultProfile(PROFILE));
    session.account = { name: 'other', displayName: 'Other' };
    const foreign = { ...makeServerTarget('Foreign'), id: makePersonalTargetId('other') };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ targets: [foreign] })));
    vi.stubGlobal('fetch', fetchMock);
    await _test.hydratePersonalTargets(PROFILE);
    expect(fetchMock).not.toHaveBeenCalled();
    session.account = { name: PROFILE, displayName: 'Jack' };
    await _test.hydratePersonalTargets(PROFILE);
    expect(loadProfile(PROFILE)!.additions).toEqual([]);
  });

  it('does not apply a response after the signed-in account changes', async () => {
    saveProfile(createDefaultProfile(PROFILE));
    session.account = { name: PROFILE, displayName: 'Jack' };
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    const hydrate = _test.hydratePersonalTargets(PROFILE);
    session.account = { name: 'other', displayName: 'Other' };
    resolve(new Response(JSON.stringify({ targets: [makeServerTarget('Jack server')] })));
    await hydrate;
    expect(loadProfile(PROFILE)!.additions).toEqual([]);
  });

  it('shares an in-flight fetch so boot and Profile mount cannot race separate server responses', async () => {
    saveProfile(createDefaultProfile(PROFILE));
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal('fetch', fetchMock);
    const first = _test.hydratePersonalTargets(PROFILE);
    const second = _test.hydratePersonalTargets(PROFILE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify({ targets: [makeServerTarget('Server')] })));
    await Promise.all([first, second]);
    expect(loadProfile(PROFILE)!.additions).toHaveLength(1);
  });

  it('does not resurrect a target deleted while the hydrate fetch is in flight', async () => {
    const removed = makeServerTarget('Delete me');
    const retained = makeServerTarget('Keep me');
    saveProfile({ ...createDefaultProfile(PROFILE), additions: [removed, retained] });
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    const hydrate = _test.hydratePersonalTargets(PROFILE);
    saveProfile(removePersonalTarget(loadProfile(PROFILE)!, removed.id));
    resolve(new Response(JSON.stringify({ targets: [removed, retained] })));
    await hydrate;
    expect(loadProfile(PROFILE)!.additions).toEqual([retained]);
  });

  it('defers same-tab hydration and reconciles cross-tab resurrection after confirmed deletion', async () => {
    const removed = makeServerTarget('Delete me');
    const retained = makeServerTarget('Keep me');
    saveProfile({ ...createDefaultProfile(PROFILE), additions: [removed, retained] });
    let resolveDelete!: (r: Response) => void;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => init?.method === 'DELETE'
      ? new Promise<Response>((r) => { resolveDelete = r; })
      : Promise.resolve(new Response(JSON.stringify({ targets: [removed, retained] }))));
    vi.stubGlobal('fetch', fetchMock);
    const deleting = _test.handleDelete(PROFILE, removed);
    await _test.hydratePersonalTargets(PROFILE);
    expect(loadProfile(PROFILE)!.additions).toEqual([retained]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A separate tab has its own module guard. Simulate its stale GET merge
    // into shared storage, alongside an unrelated local edit and new target.
    const edited = { ...retained, name: 'Edited in other tab' };
    const added = makeServerTarget('Added in other tab');
    saveProfile({ ...loadProfile(PROFILE)!, additions: [removed, edited, added], distanceThresholdKm: 850 });
    resolveDelete(new Response('{"ok":true,"removed":true}'));
    await deleting;
    expect(loadProfile(PROFILE)!.additions).toEqual([edited, added]);
    expect(loadProfile(PROFILE)!.distanceThresholdKm).toBe(850);
  });

  it('rejects an old GET resolving after another tab confirms DELETE even if local profile bytes did not change', async () => {
    const deleted = makeServerTarget('Deleted in other tab');
    const retained = makeServerTarget('Keep');
    saveProfile({ ...createDefaultProfile(PROFILE), additions: [retained] });
    markProfileTargetsChanged(PROFILE); // Tab A has already removed its target.
    resetProfileTargetSyncForTests(); // Tab B has an independent in-memory guard.
    const before = localStorage.getItem(`opd-profile-${PROFILE}`);
    const revision = profileTargetRevision(PROFILE);
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    const hydrate = _test.hydratePersonalTargets(PROFILE);
    markProfileTargetsChanged(PROFILE); // Tab A receives confirmed DELETE.
    resetProfileTargetSyncForTests(); // Its module-local guard is not Tab B's.
    expect(profileTargetRevision(PROFILE)).not.toBe(revision);
    expect(localStorage.getItem(`opd-profile-${PROFILE}`)).toBe(before);
    resolve(new Response(JSON.stringify({ targets: [deleted, retained] })));
    await hydrate;
    expect(loadProfile(PROFILE)!.additions).toEqual([retained]);
  });

  it('hydrates a fresh device without a stored key', async () => {
    saveProfile(createDefaultProfile(PROFILE));
    localStorage.removeItem(TOKEN_KEY);
    const targets = [makeServerTarget('Signed-in target')];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ targets })));
    vi.stubGlobal('fetch', fetchMock);
    await _test.hydratePersonalTargets(PROFILE);
    expect(loadProfile(PROFILE)!.additions).toEqual(targets);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('silently no-ops when the server returns 5xx', async () => {
    saveProfile(createDefaultProfile(PROFILE));
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 }),
    ));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await _test.hydratePersonalTargets(PROFILE);

    expect(loadProfile(PROFILE)!.additions).toHaveLength(0);
    expect(document.getElementById('toast')!.hidden).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('silently no-ops when fetch throws (offline)', async () => {
    saveProfile(createDefaultProfile(PROFILE));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await _test.hydratePersonalTargets(PROFILE);

    expect(loadProfile(PROFILE)!.additions).toHaveLength(0);
    expect(document.getElementById('toast')!.hidden).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('re-checks local state after fetch resolves (defends against mid-flight optimistic add)', async () => {
    saveProfile(createDefaultProfile(PROFILE));
    const serverTargets = [makeServerTarget('Server 1')];
    let resolveFetch: (r: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => pending));

    const hydrate = _test.hydratePersonalTargets(PROFILE);

    // Simulate an operator add that lands while the GET is in flight.
    const local = makeServerTarget('Local in-flight');
    saveProfile(addPersonalTarget(loadProfile(PROFILE)!, local));

    // Now resolve the GET — hydrate should see the local has additions and bail.
    resolveFetch(new Response(JSON.stringify({ ok: true, targets: serverTargets }), { status: 200 }));
    await hydrate;

    const after = loadProfile(PROFILE)!;
    // Local in-flight target preserved, server targets NOT clobbered in.
    expect(after.additions).toHaveLength(1);
    expect(after.additions[0]!.name).toBe('Local in-flight');
  });
});

// ---------------------------------------------------------------------------
// buildCrudSection — wires hydrate on mount
// ---------------------------------------------------------------------------

describe('buildCrudSection hydration wiring', () => {
  it('fires getProfileTargets on render when local is empty', async () => {
    saveProfile(createDefaultProfile(PROFILE));
    const serverTargets = [
      makeServerTarget('From server 1'),
      makeServerTarget('From server 2'),
    ];
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, targets: serverTargets }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = document.getElementById('profile-body')!;
    body.appendChild(buildCrudSection(PROFILE));

    // Render must not block on the network — hydrate is fire-and-forget.
    // Wait a microtask + macrotask to let the GET resolve and rerender.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalled();
    const after = loadProfile(PROFILE)!;
    expect(after.additions).toHaveLength(2);
  });

  it('checks the server once on mount even when local additions exist', async () => {
    saveProfile(addPersonalTarget(
      createDefaultProfile(PROFILE),
      makeServerTarget('Already local'),
    ));
    // Default-resolving stub: slot 8b also fires a `/api/log` fetch on
    // first mount for shot-count badges. We're asserting only that the
    // *targets* endpoint is called once — filter on URL below.
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ targets: [], entries: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    document.getElementById('profile-body')!.appendChild(buildCrudSection(PROFILE));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const targetsCalls = (fetchMock.mock.calls as unknown[][]).filter((c) =>
      String(c[0]).includes('/api/browser/profiles/'),
    );
    expect(targetsCalls).toHaveLength(1);
  });

  it('credits the exact Tuvalu point separately from generic OSM geocoding', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"targets":[],"entries":[]}')));
    saveProfile(createDefaultProfile(PROFILE));
    const section = buildCrudSection(PROFILE);
    expect(section.querySelector('#profile-add-search-attribution')?.textContent).toContain('Geoscience Australia');
    expect(section.querySelector('#profile-add-search-attribution')?.textContent).toContain('OpenStreetMap');
  });
});
