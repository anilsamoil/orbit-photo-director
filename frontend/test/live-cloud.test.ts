/**
 * Tests for frontend/src/cloud.ts — live current cloud-cover fetch.
 * Pins the offline/async contract: offline never fetches (R8), failures →
 * null (collapse), concurrent calls dedup, exact-coord cache so adjacent
 * distinct targets don't share a number (R3).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchLiveCloud, _resetCloudCacheForTest } from '../src/cloud';

const NOW = Date.parse('2026-06-23T12:00:00Z');
const okFetch = (pct: number): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify({ cloud_pct: pct }), { status: 200 })) as unknown as typeof fetch;
function setOnline(v: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
}

beforeEach(() => {
  _resetCloudCacheForTest();
  setOnline(true);
});

describe('fetchLiveCloud', () => {
  it('offline → null, never issues a request (R8)', async () => {
    setOnline(false);
    const f = okFetch(40);
    expect(await fetchLiveCloud(40, -96, f, NOW)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('ok → integer percent', async () => {
    expect(await fetchLiveCloud(40, -96, okFetch(42), NOW)).toBe(42);
  });

  it('non-ok (502) / throw → null (caller collapses the row)', async () => {
    const f502 = vi.fn(async () => new Response('x', { status: 502 })) as unknown as typeof fetch;
    expect(await fetchLiveCloud(40, -96, f502, NOW)).toBeNull();
    const fThrow = vi.fn(async () => { throw new Error('abort'); }) as unknown as typeof fetch;
    expect(await fetchLiveCloud(40, -96, fThrow, NOW)).toBeNull();
  });

  it('caches by exact coord — same target reuses one fetch within TTL', async () => {
    const f = okFetch(30);
    await fetchLiveCloud(40, -96, f, NOW);
    await fetchLiveCloud(40, -96, f, NOW + 1000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('adjacent distinct targets do NOT share a cached number (R3)', async () => {
    const f = okFetch(30);
    await fetchLiveCloud(40.0001, -96, f, NOW);
    await fetchLiveCloud(40.0002, -96, f, NOW + 1000); // distinct exact coord
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('dedups concurrent calls for the same coord', async () => {
    let resolve!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((r) => { resolve = r; })) as unknown as typeof fetch;
    const p1 = fetchLiveCloud(40, -96, f, NOW);
    const p2 = fetchLiveCloud(40, -96, f, NOW);
    resolve(new Response(JSON.stringify({ cloud_pct: 55 }), { status: 200 }));
    expect(await Promise.all([p1, p2])).toEqual([55, 55]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
