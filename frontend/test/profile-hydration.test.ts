/** Slot 6b — Profile pane API hydration tests.
 *
 *  Covers the one-shot GET that fires on Profile-pane render:
 *    - profile-api.getProfileTargets (URL, headers, response shape)
 *    - profile-crud.hydratePersonalTargets (preserve-local guard,
 *      silent-fail surfaces, save + rerender on success)
 *    - buildCrudSection wires the hydrate call on mount
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addPersonalTarget,
  createDefaultProfile,
  loadProfile,
  makePersonalTargetId,
  saveProfile,
  type PersonalTarget,
} from '../src/profile';
import { getProfileTargets } from '../src/profile-api';
import { _test, buildCrudSection } from '../src/profile-crud';

const PROFILE = 'jack';
const TOKEN_KEY = 'opd-calib-token';

beforeEach(() => {
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
  it('returns token_missing when no calib token is set', async () => {
    localStorage.removeItem(TOKEN_KEY);
    const r = await getProfileTargets(PROFILE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_missing');
  });

  it('sends GET with x-calib-token header to the right URL', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, targets: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await getProfileTargets(PROFILE);
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calls = fetchMock.mock.calls as unknown[][];
    const [url, init] = calls[0]! as [string, RequestInit];
    expect(url).toBe(`/api/profiles/${PROFILE}/targets`);
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-calib-token']).toBe('test-token');
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

  it('normalises a missing targets field to an empty array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      // Some unexpected shape — body is {ok:true} but no targets.
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ));
    const r = await getProfileTargets(PROFILE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.targets).toEqual([]);
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

  it('is a no-op when local additions already exist (preserve-local guard)', async () => {
    const local = makeServerTarget('Local target');
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), local));
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, targets: [makeServerTarget('Server X')] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await _test.hydratePersonalTargets(PROFILE);

    const after = loadProfile(PROFILE)!;
    // Local target preserved; server target NOT merged in.
    expect(after.additions).toHaveLength(1);
    expect(after.additions[0]!.name).toBe('Local target');
    // Guard short-circuits BEFORE the fetch — no network call made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('silently no-ops when token is missing (no toast, no save)', async () => {
    saveProfile(createDefaultProfile(PROFILE));
    localStorage.removeItem(TOKEN_KEY);
    // Re-seed the profile (clear-then-removeItem-then-save sequence is
    // brittle — the previous saveProfile happened with token set so it's
    // still there). Confirm starting state:
    expect(loadProfile(PROFILE)!.additions).toHaveLength(0);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await _test.hydratePersonalTargets(PROFILE);

    expect(loadProfile(PROFILE)!.additions).toHaveLength(0);
    // No toast — verify the toast element is still hidden.
    expect(document.getElementById('toast')!.hidden).toBe(true);
    expect(warn).toHaveBeenCalled();
    // Fetch should NOT fire — getProfileTargets short-circuits on missing token.
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('does not fire getProfileTargets when local additions exist', async () => {
    saveProfile(addPersonalTarget(
      createDefaultProfile(PROFILE),
      makeServerTarget('Already local'),
    ));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    document.getElementById('profile-body')!.appendChild(buildCrudSection(PROFILE));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
