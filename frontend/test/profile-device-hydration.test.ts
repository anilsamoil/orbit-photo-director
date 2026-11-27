import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalTarget } from '../src/profile';
import type { LogEntry } from '../src/log';

const ararat: PersonalTarget = {
  id: 'personal:josh:11111111-1111-4111-8111-111111111111',
  name: 'Mount Ararat',
  lat: 39.702,
  lon: 44.299,
  priority: 5,
  createdAt: '2026-11-16T12:00:00.000Z',
};

let serverLists: Map<string, PersonalTarget[]>;
let nextRead: (() => Promise<Response>) | undefined;
let targetReads: number;
let logEntries: LogEntry[];
let nextLogRead: (() => Promise<Response>) | undefined;
let logReads: number;

beforeEach(() => {
  serverLists = new Map();
  nextRead = undefined;
  targetReads = 0;
  logEntries = [];
  nextLogRead = undefined;
  logReads = 0;
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/browser/session') {
      return new Response(JSON.stringify({ ok: true, profile: { name: 'josh', displayName: 'Josh' } }));
    }
    if (url.startsWith('/api/log?')) {
      logReads += 1;
      const read = nextLogRead;
      nextLogRead = undefined;
      return read ? read() : new Response(JSON.stringify({ entries: logEntries }));
    }
    const match = /^\/api\/browser\/profiles\/([^/]+)\/targets$/.exec(url);
    if (!match) throw new Error(`Unexpected request ${url}`);
    const profile = match[1]!;
    if (init?.method === 'POST') {
      const target: PersonalTarget = JSON.parse(String(init.body));
      const targets = [...(serverLists.get(profile) ?? []), target];
      serverLists.set(profile, targets);
      return new Response(JSON.stringify({ ok: true, count: targets.length }));
    }
    if (init?.method !== 'GET') throw new Error(`Unexpected method ${init?.method}`);
    targetReads += 1;
    const read = nextRead;
    nextRead = undefined;
    return read ? read() : new Response(JSON.stringify({ targets: serverLists.get(profile) ?? [] }));
  }));
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function freshDevice() {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="toast" hidden></div><div id="profile-body"></div>';
  window.history.replaceState({}, '', '/');
  const session = await import('../src/profile-session');
  await session.resolveAccountProfile();
  expect(session.getAccountProfile()).toMatchObject({ name: 'josh', isVerified: true });
  const profiles = await import('../src/profile');
  profiles.saveProfile(profiles.createDefaultProfile('josh'));
  const crud = await import('../src/profile-crud');
  return { ...profiles, ...crud };
}

describe('personal targets across devices', () => {
  it('hydrates an iPhone add onto a fresh iPad signed in as josh', async () => {
    const iphone = await freshDevice();
    expect(await iphone.handleAdd('josh', ararat)).toBe('ok');
    expect(serverLists.get('josh')).toEqual([ararat]);

    const ipad = await freshDevice();
    expect(ipad.loadProfile('josh')!.additions).toEqual([]);
    await ipad.hydratePersonalTargets('josh');
    expect(ipad.loadProfile('josh')!.additions).toEqual([ararat]);
  });

  it.each(['network', '503', 'expired session', 'invalid_response'])(
    'retries a failed %s boot read when the Profile section opens in the same page',
    async (failure) => {
      serverLists.set('josh', [ararat]);
      const ipad = await freshDevice();
      nextRead = async () => {
        if (failure === 'network') throw new TypeError('offline');
        if (failure === '503') return new Response('{}', { status: 503 });
        if (failure === 'expired session') return new Response('{}', { status: 401 });
        return new Response('{"ok":true}');
      };
      await ipad.hydratePersonalTargets('josh');
      expect(ipad.loadProfile('josh')!.additions).toEqual([]);
      expect(targetReads).toBe(1);

      document.getElementById('profile-body')!.append(ipad.buildCrudSection('josh'));
      await vi.waitFor(() => expect(ipad.loadProfile('josh')!.additions).toEqual([ararat]));
      expect(targetReads).toBe(2);
    },
  );

  it('keeps a distance threshold saved while applying an in-flight server read', async () => {
    serverLists.set('josh', [ararat]);
    const ipad = await freshDevice();
    let finishRead: (response: Response) => void = () => {};
    nextRead = () => new Promise<Response>((resolve) => { finishRead = resolve; });
    const hydration = ipad.hydratePersonalTargets('josh');
    ipad.saveProfile({ ...ipad.loadProfile('josh')!, distanceThresholdKm: 700 });
    finishRead(new Response(JSON.stringify({ targets: serverLists.get('josh') })));
    await hydration;

    expect(ipad.loadProfile('josh')!.additions).toEqual([ararat]);
    expect(ipad.loadProfile('josh')!.distanceThresholdKm).toBe(700);
  });

  it('reuses a successful empty read when the Profile section opens again', async () => {
    const ipad = await freshDevice();
    await ipad.hydratePersonalTargets('josh');
    document.getElementById('profile-body')!.append(ipad.buildCrudSection('josh'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.getElementById('profile-body')!.replaceChildren(ipad.buildCrudSection('josh'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(targetReads).toBe(1);
    expect(logReads).toBe(1);
    expect(ipad.loadProfile('josh')!.additions).toEqual([]);
  });

  it('retries a failed shot-count read on the next Profile opening and shows the badge', async () => {
    serverLists.set('josh', [ararat]);
    logEntries = [{ target_id: ararat.id, pass_time: '2026-11-16T12:00:00Z', action: 'shoot' }];
    const ipad = await freshDevice();
    await ipad.hydratePersonalTargets('josh');
    nextLogRead = async () => new Response('{}', { status: 503 });
    document.getElementById('profile-body')!.append(ipad.buildCrudSection('josh'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.profile-crud-shot-badge')).toBeNull();
    expect(logReads).toBe(1);

    document.getElementById('profile-body')!.replaceChildren(ipad.buildCrudSection('josh'));
    await vi.waitFor(() => expect(document.querySelector('.profile-crud-shot-badge')?.textContent).toBe('✓ 1'));
    expect(logReads).toBe(2);
  });

  it.each(['edit', 'delete', 'hide', 'hide timestamp'])(
    'rejects a stale read after a concurrent target %s saved by another tab',
    async (change) => {
      const ipad = await freshDevice();
      ipad.saveProfile({
        ...ipad.loadProfile('josh')!,
        additions: [ararat],
        removedCuratedIds: ['tokyo'],
        removedCuratedUpdatedAt: '2026-11-15T12:00:00.000Z',
      });
      let finishRead: (response: Response) => void = () => {};
      nextRead = () => new Promise<Response>((resolve) => { finishRead = resolve; });
      const hydration = ipad.hydratePersonalTargets('josh');
      const fresh = ipad.loadProfile('josh')!;
      const edited = { ...ararat, name: 'My Ararat' };
      const additions = change === 'edit' ? [edited] : change === 'delete' ? [] : [ararat];
      const removedCuratedIds = change === 'hide' ? ['tokyo', 'london'] : ['tokyo'];
      const removedCuratedUpdatedAt = change === 'hide timestamp'
        ? '2026-11-16T12:00:00.000Z' : fresh.removedCuratedUpdatedAt;
      ipad.saveProfile({ ...fresh, additions, removedCuratedIds, removedCuratedUpdatedAt });
      finishRead(new Response(JSON.stringify({
        targets: [ararat, { ...ararat, id: 'personal:josh:22222222-2222-4222-8222-222222222222', name: 'Server only' }],
        removedCuratedIds: [],
        removedCuratedUpdatedAt: '2026-11-17T12:00:00.000Z',
      })));
      await hydration;

      expect(ipad.loadProfile('josh')!.additions).toEqual(additions);
      expect(ipad.loadProfile('josh')!.removedCuratedIds).toEqual(removedCuratedIds);
      expect(ipad.loadProfile('josh')!.removedCuratedUpdatedAt).toBe(removedCuratedUpdatedAt);
    },
  );
});
