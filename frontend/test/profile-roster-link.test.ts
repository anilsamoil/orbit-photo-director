import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isRosterProfile, rosterSites } from '../src/crew-roster';
import * as rings from '../src/map/features/targets';
import { createClock } from '../src/map/map-core/clock';
import { createMapCore } from '../src/map/map-core/core';
import { loadProfile, type PersonalTarget } from '../src/profile';
import { deleteProfileTarget, postProfileTarget, putProfileTargets, putRemovedCuratedIds } from '../src/profile-api';
import { handleAdd, hydratePersonalTargets, rerenderCrudSection } from '../src/profile-crud';
import { clearLinkedRosterTargets, setLinkedRosterTargetsOffline } from '../src/profile-roster-targets';
import { resolveAccountProfile } from '../src/profile-session';
import { renderProfilePane } from '../src/profile-ui';
import { createVendorDouble } from './vendor-map-double';

vi.mock('../src/cloud', () => ({ fetchLiveCloud: async () => null }));

const viewer = { name: 'test-viewer', displayName: 'Fixture viewer' };
const josh = { name: 'josh', displayName: 'Fixture account' };
const linkedTarget: PersonalTarget = {
  id: 'personal:josh:fixture-ridge',
  name: 'Fixture ridge',
  lat: 12.5,
  lon: 24.5,
  priority: 5,
  createdAt: '2026-11-16T12:00:00Z',
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function installWorker({
  session = () => json({ ok: true, profile: viewer, profiles: [viewer, josh] }),
  targets = () => json({ targets: [linkedTarget] }),
}: {
  session?: () => Response | Promise<Response>;
  targets?: () => Response | Promise<Response>;
} = {}) {
  const requests: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (url === '/api/browser/session') return session();
    if (url.startsWith('/api/browser/profiles/') && method === 'GET') return targets();
    return new Response(null, { status: 404 });
  }));
  return {
    targetRequests: () => requests.filter(({ url }) => url.startsWith('/api/browser/profiles/')),
    writes: () => requests.filter(({ method }) => ['POST', 'PUT', 'DELETE'].includes(method)),
  };
}

function select(name: string): void {
  history.replaceState(null, '', '/?u=' + name);
}

function bundledIds(name: string): string[] {
  if (!isRosterProfile(name)) throw new Error('Expected a roster profile');
  return rosterSites(name).map((target) => target.id);
}

function listIds(): (string | undefined)[] {
  return [...document.querySelectorAll<HTMLElement>('#profile-crud-section li[data-target-id]')]
    .map((element) => element.dataset.targetId);
}

function mountRings() {
  const vendor = createVendorDouble({ layers: [rings.myTargetsLayer()] });
  const clock = createClock(() => Date.parse('2026-11-16T12:00:00Z'));
  const core = createMapCore(vendor, clock);
  rings.bindTargetsClock(clock);
  rings.targets.mount(core);
  rings.bindProfileChangedListener();
  rings.bindTargetInteractions(core);
  rings.refreshMyTargetsSource();

  function features() {
    const source = vendor.sources.get('my-targets');
    if (source?.type !== 'geojson' || typeof source.data === 'string') throw new Error('Missing target rings');
    return source.data.features;
  }
  return {
    ids: () => features().map((feature) => feature.properties?.target_id),
    openLinkedPopup: () => {
      const feature = features().find((row) => row.properties?.target_id === linkedTarget.id);
      if (!feature) throw new Error('Missing linked ring');
      vendor.queryAt = () => [feature];
      const lngLat: [number, number] = [linkedTarget.lon, linkedTarget.lat];
      vendor.fire('click', { point: core.project(lngLat), lngLat });
      return vendor.popups.at(-1)?.content;
    },
    lastPopupRemoved: () => vendor.popups.at(-1)?.removed,
  };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div id="profile-body"></div><div id="toast" hidden></div>';
  select('kutryk');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
  clearLinkedRosterTargets();
  setLinkedRosterTargetsOffline(false);
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('read-only roster account targets', () => {
  it('adds one labelled ring and list row per granted target id without writing or persisting it', async () => {
    const worker = installWorker({ targets: () => json({
      targets: [linkedTarget, { ...linkedTarget, name: 'Duplicate ID' }],
      removedCuratedIds: ['somewhere'],
    }) });
    await resolveAccountProfile();
    const bundled = bundledIds('kutryk');
    const map = mountRings();
    const hydration = hydratePersonalTargets('kutryk');
    renderProfilePane();
    const hideInput = document.querySelector<HTMLInputElement>('#profile-curated-search');
    if (!hideInput) throw new Error('Missing Hide curated target input');
    hideInput.value = 'Unsubmitted search';
    hideInput.focus();

    expect(map.ids()).toEqual(bundled);
    await hydration;
    await vi.waitFor(() => {
      expect(map.ids()).toEqual([...bundled, linkedTarget.id]);
      expect(listIds()).toEqual([...bundled, linkedTarget.id]);
    });
    expect(document.activeElement).toBe(hideInput);
    expect(hideInput.value).toBe('Unsubmitted search');

    const list = document.getElementById('profile-crud-section');
    expect(list?.textContent).toMatch(/Josh Kutryk[’']s account (profile|targets)/);
    expect(list?.querySelector('[data-target-id="' + linkedTarget.id + '"] button')).toBeNull();
    const popup = map.openLinkedPopup();
    expect(popup?.textContent).toContain(linkedTarget.name);
    expect(popup?.textContent).toMatch(/From Josh Kutryk[’']s account profile/);
    expect(popup?.textContent).not.toContain('Edit target');

    renderProfilePane();
    await nextTask();
    expect(await handleAdd('kutryk', linkedTarget)).toMatch(/read-only/);
    for (const result of [
      await postProfileTarget('josh', linkedTarget),
      await putProfileTargets('josh', [linkedTarget]),
      await putRemovedCuratedIds('josh', ['somewhere'], linkedTarget.createdAt),
      await deleteProfileTarget('josh', linkedTarget.id),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: 'authentication' });
    }
    expect(worker.targetRequests()).toEqual([{ url: '/api/browser/profiles/josh/targets', method: 'GET' }]);
    expect(worker.writes()).toEqual([]);
    expect(loadProfile('kutryk')?.additions.map((target) => target.id)).toEqual(bundled);
    expect(loadProfile('kutryk')?.removedCuratedIds).toEqual([]);
    expect(loadProfile('josh')).toBeNull();
    expect(localStorage.getItem('opd-profile-kutryk')).toBeNull();
  });

  it.each(['ungranted', 'signed out', 'offline', 'LAN', 'malformed profiles', 'legacy session with no profiles'] as const)(
    'suppresses the roster overlay with zero target requests when %s',
    async (mode) => {
      const worker = installWorker({
        session: () => {
          if (mode === 'signed out') return new Response(null, { status: 401 });
          if (mode === 'LAN') return new Response('<main id="status-banner"></main>', {
            headers: { 'Content-Type': 'text/html' },
          });
          if (mode === 'offline') return json({ ok: true, profile: viewer, profiles: [viewer, josh] });
          if (mode === 'legacy session with no profiles') return json({ ok: true, profile: josh });
          const profiles = mode === 'malformed profiles'
            ? [viewer, josh, null]
            : [viewer, { ...josh, name: 'josh-extra' }];
          return json({ ok: true, profile: viewer, profiles });
        },
      });
      if (mode === 'offline') {
        await resolveAccountProfile();
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        await resolveAccountProfile();
      } else if (mode === 'signed out' || mode === 'malformed profiles') {
        await expect(resolveAccountProfile()).rejects.toThrow();
      } else {
        await resolveAccountProfile();
      }
      const map = mountRings();
      await hydratePersonalTargets('kutryk');
      renderProfilePane();
      await nextTask();
      expect(map.ids()).toEqual(bundledIds('kutryk'));
      expect(listIds()).toEqual(bundledIds('kutryk'));
      expect(worker.targetRequests()).toEqual([]);
      expect(worker.writes()).toEqual([]);
      expect(document.getElementById('toast')?.hidden).toBe(true);
    },
  );

  it.each([
    ['HTTP failure', () => new Response(null, { status: 503 })],
    ['LOS transport failure', () => { throw new TypeError('Connection lost'); }],
    ['malformed list', () => json({ targets: {} })],
    ['malformed row', () => json({ targets: [linkedTarget, { ...linkedTarget, priority: '5' }] })],
    ['wrong-profile row', () => json({ targets: [linkedTarget, { ...linkedTarget, id: 'personal:other:fixture' }] })],
  ] as const)('retries a %s on a Profile visit without retrying during passive renders', async (_case, fail) => {
    let reply = fail;
    const worker = installWorker({ targets: () => reply() });
    await resolveAccountProfile();
    const map = mountRings();

    await hydratePersonalTargets('kutryk');
    expect(worker.targetRequests()).toHaveLength(1);
    expect(map.ids()).toEqual(bundledIds('kutryk'));
    expect(document.getElementById('toast')?.hidden).toBe(true);

    renderProfilePane();
    await nextTask();
    expect(worker.targetRequests()).toHaveLength(2);
    expect(listIds()).toEqual(bundledIds('kutryk'));
    rerenderCrudSection('kutryk');
    rings.refreshMyTargetsSource();
    await nextTask();
    expect(worker.targetRequests()).toHaveLength(2);
    expect(map.ids()).toEqual(bundledIds('kutryk'));
    expect(document.getElementById('toast')?.hidden).toBe(true);

    reply = () => json({ targets: [linkedTarget] });
    renderProfilePane();
    await vi.waitFor(() => {
      expect(map.ids()).toContain(linkedTarget.id);
      expect(listIds()).toContain(linkedTarget.id);
    });
    expect(worker.targetRequests()).toHaveLength(3);
    expect(worker.writes()).toEqual([]);
  });

  it('releases a stalled boot read and ignores its reply after a successful Profile read', async () => {
    let finishFirstRead: (response: Response) => void = () => {};
    const stalled = new Promise<Response>((resolve) => { finishFirstRead = resolve; });
    let reply: () => Response | Promise<Response> = () => stalled;
    const worker = installWorker({ targets: () => reply() });
    await resolveAccountProfile();
    const map = mountRings();

    vi.useFakeTimers();
    const firstRead = hydratePersonalTargets('kutryk');
    await vi.advanceTimersByTimeAsync(10_000);
    await firstRead;
    vi.useRealTimers();

    expect(map.ids()).toEqual(bundledIds('kutryk'));
    reply = () => json({ targets: [linkedTarget] });
    renderProfilePane();
    await vi.waitFor(() => expect(listIds()).toContain(linkedTarget.id));
    finishFirstRead(json({ targets: [{ ...linkedTarget, id: 'personal:josh:late' }] }));
    await nextTask();

    expect(map.ids()).toEqual([...bundledIds('kutryk'), linkedTarget.id]);
    expect(worker.targetRequests()).toHaveLength(2);
  });

  it('discards an in-flight response when the reverified session loses the grant', async () => {
    let profiles = [viewer, josh];
    let finishRead: (response: Response) => void = () => {};
    const reply = new Promise<Response>((resolve) => { finishRead = resolve; });
    const worker = installWorker({
      session: () => json({ ok: true, profile: viewer, profiles }),
      targets: () => reply,
    });
    await resolveAccountProfile();
    const map = mountRings();
    const pending = hydratePersonalTargets('kutryk');

    profiles = [viewer];
    await resolveAccountProfile();
    finishRead(json({ targets: [linkedTarget] }));
    await pending;
    renderProfilePane();

    expect(map.ids()).toEqual(bundledIds('kutryk'));
    expect(listIds()).toEqual(bundledIds('kutryk'));
    expect(worker.targetRequests()).toHaveLength(1);
  });

  it('removes linked rows, rings and the open popup during known LOS even when the browser reports online', async () => {
    const worker = installWorker();
    await resolveAccountProfile();
    const map = mountRings();
    await hydratePersonalTargets('kutryk');
    renderProfilePane();
    expect(map.openLinkedPopup()?.textContent).toContain(linkedTarget.name);
    expect(listIds()).toContain(linkedTarget.id);

    setLinkedRosterTargetsOffline(true);
    expect(map.ids()).toEqual(bundledIds('kutryk'));
    expect(listIds()).toEqual(bundledIds('kutryk'));
    expect(map.lastPopupRemoved()).toBe(true);
    renderProfilePane();
    await nextTask();
    expect(worker.targetRequests()).toHaveLength(1);

    setLinkedRosterTargetsOffline(false);
    await nextTask();
    expect(worker.targetRequests()).toHaveLength(1);
    renderProfilePane();
    await vi.waitFor(() => expect(listIds()).toContain(linkedTarget.id));
    expect(worker.targetRequests()).toHaveLength(2);
  });

  it.each(['watkins', 'delaney'])('keeps the %s roster bundled-only despite the grant', async (name) => {
    const worker = installWorker();
    select(name);
    await resolveAccountProfile();
    const map = mountRings();
    await hydratePersonalTargets(name);
    renderProfilePane();
    await nextTask();

    expect(map.ids()).toEqual(bundledIds(name));
    expect(listIds()).toEqual(bundledIds(name));
    expect(worker.targetRequests()).toEqual([]);
    expect(worker.writes()).toEqual([]);
  });
});
