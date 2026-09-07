import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LaunchStore, LAUNCH_STORAGE_KEY } from '../src/launch-store';
import { parseLaunchArtifact, parseLaunchPointer } from '../src/launch-schema';
import { launchCoverageLabel, launchFresh, selectLaunches } from '../src/launch-selectors';
import { artifact, envelope, iso, launch, NOW, supported } from './launch-fixtures';

beforeEach(() => localStorage.clear());

describe('launch runtime schema', () => {
  it('preserves inverted map-only bounds with TIME_CONFLICT but rejects unmarked or supported conflicts', () => {
    const item = launch({ reason_codes: ['TIME_CONFLICT'], launch_window: { net: iso(10), start: iso(20), end: iso(-10), precision: 'minute' } });
    const a = artifact([item]);
    expect(parseLaunchArtifact(a).items[0]!.launch_window).toEqual(item.launch_window);
    item.reason_codes = [];
    expect(() => parseLaunchArtifact(a)).toThrow();
    const supportedConflict = supported({ reason_codes: ['TIME_CONFLICT'], launch_window: item.launch_window });
    expect(() => parseLaunchArtifact(artifact([supportedConflict]))).toThrow();
  });
  it('accepts contract map-only and supported artifacts', () => {
    expect(parseLaunchArtifact(artifact([launch(), supported({ event_id: 'other' })])).items).toHaveLength(2);
  });
  it.each(['Minute', 'minute', 'Second', 'second'])('accepts supported %s timing', (precision) => {
    const item = supported();
    item.launch_window.precision = precision;
    expect(parseLaunchArtifact(artifact([item])).items[0]).toBe(item);
  });
  it.each([
    { start: null }, { end: null }, { precision: null }, { precision: 'Hour' },
    { precision: '' }, { net: iso(7) }, { net: iso(8.5) }, { net: iso(10) },
    { start: iso(10), end: iso(9) },
  ])('rejects unsupported launch timing %j', (window) => {
    const item = supported();
    Object.assign(item.launch_window, window);
    expect(() => parseLaunchArtifact(artifact([item]))).toThrow('Invalid launch schema');
  });
  it.each([
    { liftoff_start: iso(7) }, { liftoff_end: iso(10) }, { start: iso(7) },
  ])('rejects inconsistent conditional timing %j', (interval) => {
    const item = supported();
    Object.assign(item.capture_intervals[0]!, interval);
    expect(() => parseLaunchArtifact(artifact([item]))).toThrow('Invalid launch schema');
  });
  it.each([1, 15 * 60_000])('accepts a %d ms pointer and artifact lifetime', async (lifetime) => {
    const a = artifact([], { valid_until: new Date(Date.parse(iso(-5)) + lifetime).toISOString() });
    expect(parseLaunchArtifact(a)).toBe(a);
    const e = await envelope(a);
    expect(parseLaunchPointer(e.pointer)).toBe(e.pointer);
  });
  it.each([-1, 0, 15 * 60_000 + 1, 65 * 60_000])('rejects a %d ms pointer and artifact lifetime', async (lifetime) => {
    const a = artifact([], { valid_until: new Date(Date.parse(iso(-5)) + lifetime).toISOString() });
    expect(() => parseLaunchArtifact(a)).toThrow('Invalid launch schema');
    const e = await envelope(a);
    expect(() => parseLaunchPointer(e.pointer)).toThrow('Invalid launch schema');
  });
  it.each(['https://evil.test/a.json', '//evil.test/a.json', '/launch/v/r1.json', 'launch/v/../r1.json',
    'launch/v/%2e%2e.json', 'launch/v/r1.json?x=1', 'launch/v/r1.json#x', 'launch\\v\\r1.json', 'launch/v/other.json'])('rejects path %s before fetching it', async (path) => {
    const e = await envelope();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...e.pointer, path })));
    const store = new LaunchStore(fetcher);
    await store.refresh();
    expect(store.getState().artifact).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['', 'g'.repeat(64), 'a'.repeat(63)])('requires a SHA256 digest (%s)', async (sha256) => {
    expect(() => parseLaunchPointer({ ...(awaitedPointer), sha256 })).toThrow();
  });
  const awaitedPointer = { schema_version: 2, revision: 'r1', generated_at: iso(-5), valid_until: iso(10), path: 'launch/v/r1.json', sha256: 'a'.repeat(64) };
  it.each([
    (a: ReturnType<typeof artifact>) => { a.items[0]!.site.lat = NaN; },
    (a: ReturnType<typeof artifact>) => { a.items[0]!.site.lon = 181; },
    (a: ReturnType<typeof artifact>) => { a.items[0]!.launch_window.net = '2026-09-07T12:10:00-05:00'; },
    (a: ReturnType<typeof artifact>) => { a.generated_at = '2026-02-30T12:00:00Z'; },
    (a: ReturnType<typeof artifact>) => { a.items.push(a.items[0]!); },
    (a: ReturnType<typeof artifact>) => { a.items[0]!.sources[0]!.url = 'javascript:alert(1)'; },
    (a: ReturnType<typeof artifact>) => { a.items[0]!.capture_intervals[0]!.peak = iso(90); },
    (a: ReturnType<typeof artifact>) => { a.items[0]!.capture_intervals[0]!.look!.frame = 'station-body' as 'orbital-lvlh'; },
    (a: ReturnType<typeof artifact>) => { a.items[0]!.trajectory.quality = 'unknown'; },
    (a: ReturnType<typeof artifact>) => { a.items[0]!.trajectory.source = null; },
    (a: ReturnType<typeof artifact>) => { a.items[0]!.capture_intervals[0]!.look = null; },
    (a: ReturnType<typeof artifact>) => { a.items[0]!.reason_codes = ['VALIDATION_PENDING']; },
    (a: ReturnType<typeof artifact>) => { a.items[0]!.trajectory.points[1]!.t_offset_seconds = 0; },
    (a: ReturnType<typeof artifact>) => { a.coverage.until = iso(-120); },
    (a: ReturnType<typeof artifact>) => { Object.assign(a, { private_profile: 'crew' }); },
  ])('rejects malformed runtime data case %#', (mutate) => {
    const a = artifact([supported()]); mutate(a);
    expect(() => parseLaunchArtifact(a)).toThrow();
  });
});

describe('common launch store', () => {
  it.each([true, false])('honors the latest %s online intent while restoring', async (online) => {
    const e = await envelope(artifact([supported()]));
    localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify(e));
    const fetcher = vi.fn(async () => new Response(JSON.stringify(e.pointer)));
    const store = new LaunchStore(fetcher);
    const first = store.refresh(!online);
    expect(store.refresh(online)).toBe(first);
    const availability: string[] = [];
    store.subscribe(() => availability.push(store.getState().availability));
    await first;
    expect(store.getState().availability).toBe(online ? 'ready' : 'offline');
    expect(fetcher).toHaveBeenCalledTimes(online ? 1 : 0);
    expect(selectLaunches(store.getState(), NOW, 'queue')).toHaveLength(online ? 1 : 0);
    if (!online) expect(availability.every((value) => value === 'offline')).toBe(true);
  });
  it.each([false, true])('handles offline during a download, reconnect=%s', async (reconnect) => {
    const e = await envelope(artifact([supported()]));
    let finish!: (response: Response) => void;
    let started!: () => void;
    const downloading = new Promise<void>((resolve) => { started = resolve; });
    const fetcher = vi.fn(async (path, options?: RequestInit) => {
      if (path === '/launch/latest.json') return new Response(JSON.stringify(e.pointer));
      if (!finish) {
        started();
        // An already delivered response can settle despite cancellation.
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      expect(options?.signal?.aborted).toBe(false);
      return new Response(e.body);
    });
    const store = new LaunchStore(fetcher);
    const first = store.refresh(true);
    await downloading;
    expect(store.refresh(false)).toBe(first);
    expect(store.getState().availability).toBe('offline');
    expect(fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    if (reconnect) expect(store.refresh(true)).toBe(first);
    finish(new Response(e.body));
    await first;
    expect(store.getState().availability).toBe(reconnect ? 'ready' : 'offline');
    expect(store.getState().artifact?.revision ?? null).toBe(reconnect ? 'r1' : null);
    expect(selectLaunches(store.getState(), NOW, 'queue')).toHaveLength(reconnect ? 1 : 0);
  });
  it('still reports unavailable when the online fetch times out', async () => {
    vi.useFakeTimers();
    try {
      let started!: () => void;
      const fetching = new Promise<void>((resolve) => { started = resolve; });
      const fetcher = vi.fn((_path, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        started();
      }));
      const store = new LaunchStore(fetcher);
      const refresh = store.refresh();
      await fetching;
      await vi.advanceTimersByTimeAsync(12_000);
      await refresh;
      expect(store.getState().availability).toBe('unavailable');
      expect(store.getState().artifact).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('publishes one frozen artifact to all subscribers; coalesces refreshes', async () => {
    const e = await envelope();
    const fetcher = vi.fn(async (path) => new Response(path === '/launch/latest.json' ? JSON.stringify(e.pointer) : e.body));
    const store = new LaunchStore(fetcher);
    const views: unknown[] = [];
    store.subscribe(() => views.push(store.getState().artifact));
    store.subscribe(() => views.push(store.getState().artifact));
    const first = store.refresh();
    expect(store.refresh()).toBe(first);
    await first;
    expect(views[0]).toBe(views[1]);
    expect(Object.isFrozen(store.getState().artifact?.items[0]?.site)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[0]).toBe('/launch/v/r1.json');
    await store.refresh();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each(['hash', 'schema', 'revision', 'timestamp'])('preserves last-good after a %s failure', async (failure) => {
    const old = await envelope();
    localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify(old));
    const a = artifact([launch()], { revision: 'r2', generated_at: iso(-1) });
    const next = await envelope(a);
    if (failure === 'hash') next.body += ' ';
    if (failure === 'schema') {
      next.body = JSON.stringify({ ...a, items: null });
      next.pointer.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(next.body))), (n) => n.toString(16).padStart(2, '0')).join('');
    }
    if (failure === 'revision') { next.pointer.revision = 'r3'; next.pointer.path = 'launch/v/r3.json'; }
    if (failure === 'timestamp') next.pointer.valid_until = iso(11);
    const fetcher = vi.fn(async (path) => new Response(path === '/launch/latest.json' ? JSON.stringify(next.pointer) : next.body));
    const store = new LaunchStore(fetcher);
    await store.refresh();
    expect(store.getState().artifact?.revision).toBe('r1');
    expect(store.getState().availability).toBe('last-good');
    expect(JSON.parse(localStorage.getItem(LAUNCH_STORAGE_KEY)!).pointer.revision).toBe('r1');
  });
  it('rejects a pointer race and succeeds on the next shared cycle', async () => {
    const old = await envelope();
    const next = await envelope(artifact([supported()], { revision: 'r2', generated_at: iso(-1) }));
    let count = 0;
    const store = new LaunchStore(vi.fn(async (path) => {
      if (path === '/launch/latest.json') return new Response(JSON.stringify(++count === 1 ? old.pointer : next.pointer));
      return new Response(path === '/launch/v/r1.json' ? old.body : next.body);
    }));
    await store.refresh();
    expect(store.getState().artifact).toBeNull();
    await store.refresh();
    expect(store.getState().artifact?.revision).toBe('r2');
  });
  it('rejects older revisions and same-revision content collisions', async () => {
    const latest = await envelope(artifact([], { revision: 'r2', generated_at: iso(-1) }));
    localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify(latest));
    for (const pointer of [(await envelope()).pointer, { ...latest.pointer, sha256: 'f'.repeat(64) }]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(pointer)));
      const store = new LaunchStore(fetcher);
      await store.refresh();
      expect(store.getState().artifact?.revision).toBe('r2');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('validates disk bytes and expires against the real clock offline', async () => {
    const e = await envelope(artifact([supported()]));
    localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify(e));
    const fetcher = vi.fn();
    const store = new LaunchStore(fetcher);
    await store.refresh(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(selectLaunches(store.getState(), NOW, 'queue')).toHaveLength(0);
    expect(selectLaunches(store.getState(), NOW, 'map')).toHaveLength(1);
    expect(launchFresh(store.getState(), NOW)).toBe(true);
    expect(launchFresh(store.getState(), Date.parse(iso(10)) - 1)).toBe(true);
    expect(launchFresh(store.getState(), Date.parse(iso(10)))).toBe(false);
    expect(selectLaunches(store.getState(), Date.parse(iso(10)), 'queue')).toEqual([]);
    expect(launchCoverageLabel(store.getState(), Date.parse(iso(10)))).toContain('STALE / EXPIRED');
    localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify({ ...e, body: e.body + ' ' }));
    const corrupted = new LaunchStore(fetcher);
    await corrupted.restore();
    expect(corrupted.getState().artifact).toBeNull();
  });
  it('404 absence is independent, with explicit unknown coverage', async () => {
    const store = new LaunchStore(vi.fn(async () => new Response('', { status: 404 })));
    await store.refresh();
    expect(launchCoverageLabel(store.getState(), NOW)).toContain('coverage unknown');
  });
  it('notifies on clock boundaries without a fetch', async () => {
    localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify(await envelope(artifact([supported()]))));
    const store = new LaunchStore(vi.fn()); await store.restore();
    const listener = vi.fn(); store.subscribe(listener);
    store.tick(NOW); listener.mockClear();
    store.tick(NOW + 1000); expect(listener).not.toHaveBeenCalled();
    store.tick(Date.parse(iso(15))); expect(listener).toHaveBeenCalledOnce();
  });
  it('notifies at source expiry even before wrapper expiry', async () => {
    localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify(await envelope(artifact([supported()]))));
    const store = new LaunchStore(vi.fn()); await store.restore();
    const listener = vi.fn(); store.subscribe(listener);
    store.tick(Date.parse(iso(5)) - 1); listener.mockClear();
    expect(selectLaunches(store.getState(), Date.parse(iso(5)) - 1, 'queue')).toHaveLength(1);
    store.tick(Date.parse(iso(5)));
    expect(listener).toHaveBeenCalledOnce();
    expect(launchFresh(store.getState(), Date.parse(iso(5)))).toBe(true);
    expect(selectLaunches(store.getState(), Date.parse(iso(5)), 'queue')).toEqual([]);
  });
});
