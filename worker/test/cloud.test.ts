/**
 * Tests for worker/src/cloud.ts — live current cloud-cover proxy.
 * Pins the design-review contracts: 0-100 integer (R4), exact .toFixed(4) key
 * (R3), a 429 surfaces as a quiet 502 and is NOT cached (R6/R14), CORS on
 * success AND error (R15).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { handleCloudRequest, type CloudNowResponse } from '../src/cloud';

class MockCache implements Pick<Cache, 'match' | 'put'> {
  store = new Map<string, Response>();
  async match(key: RequestInfo | URL): Promise<Response | undefined> {
    const k = key instanceof Request ? key.url : String(key);
    const h = this.store.get(k);
    return h ? h.clone() : undefined;
  }
  async put(key: RequestInfo | URL, res: Response): Promise<void> {
    const k = key instanceof Request ? key.url : String(key);
    this.store.set(k, res);
  }
}
function makeCtx(): ExecutionContext {
  return { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
}
const req = (lat: number | string, lon: number | string = 0) =>
  new Request(`https://map.astroanil.dev/api/cloud?lat=${lat}&lon=${lon}`);
const okFetch = (cloud: number): typeof fetch =>
  (async () => new Response(JSON.stringify({ current: { cloud_cover: cloud, time: '2026-06-23T12:00' } }), { status: 200 })) as unknown as typeof fetch;
const statusFetch = (s: number): typeof fetch =>
  (async () => new Response('x', { status: s })) as unknown as typeof fetch;

describe('handleCloudRequest', () => {
  let cache: MockCache;
  let ctx: ExecutionContext;
  beforeEach(() => { cache = new MockCache(); ctx = makeCtx(); });

  it('bad coords → 400', async () => {
    expect((await handleCloudRequest(req(999, 0), {}, ctx, okFetch(50), cache as unknown as Cache)).status).toBe(400);
    expect((await handleCloudRequest(new Request('https://x/api/cloud?lat=abc'), {}, ctx, okFetch(50), cache as unknown as Cache)).status).toBe(400);
  });

  it('happy: cloud_cover 42 → integer cloud_pct 42 (0-100, not 0.42), and caches', async () => {
    const res = await handleCloudRequest(req(40, -96), {}, ctx, okFetch(42), cache as unknown as Cache);
    expect(res.status).toBe(200);
    expect(((await res.json()) as CloudNowResponse).cloud_pct).toBe(42);
    // cached: a second call with a dead fetch still returns the cached 200
    const res2 = await handleCloudRequest(req(40, -96), {}, ctx, statusFetch(500), cache as unknown as Cache);
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as CloudNowResponse).cloud_pct).toBe(42);
  });

  it('clamps + rounds to a 0-100 integer', async () => {
    expect(((await (await handleCloudRequest(req(1, 1), {}, ctx, okFetch(42.7), cache as unknown as Cache)).json()) as CloudNowResponse).cloud_pct).toBe(43);
  });

  it('upstream 429 → quiet 502 and NOT cached (a 429 must not poison the cache)', async () => {
    const res = await handleCloudRequest(req(40, -96), {}, ctx, statusFetch(429), cache as unknown as Cache);
    expect(res.status).toBe(502);
    // not cached → a subsequent good fetch serves fresh data
    const res2 = await handleCloudRequest(req(40, -96), {}, ctx, okFetch(10), cache as unknown as Cache);
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as CloudNowResponse).cloud_pct).toBe(10);
  });

  it('upstream 5xx / malformed body → 502', async () => {
    expect((await handleCloudRequest(req(2, 2), {}, ctx, statusFetch(500), cache as unknown as Cache)).status).toBe(502);
    const noField = (async () => new Response(JSON.stringify({ current: {} }), { status: 200 })) as unknown as typeof fetch;
    expect((await handleCloudRequest(req(3, 3), {}, ctx, noField, cache as unknown as Cache)).status).toBe(502);
  });

  it('CORS header present on 200 AND 502', async () => {
    expect((await handleCloudRequest(req(40, -96), {}, ctx, okFetch(5), cache as unknown as Cache)).headers.get('access-control-allow-origin')).toBe('*');
    expect((await handleCloudRequest(req(40, -96), {}, ctx, statusFetch(500), new MockCache() as unknown as Cache)).headers.get('access-control-allow-origin')).toBe('*');
  });

  it('exact .toFixed(4) key — two adjacent distinct coords do NOT collide', async () => {
    await handleCloudRequest(req(40.0001, -96), {}, ctx, okFetch(20), cache as unknown as Cache);
    const res = await handleCloudRequest(req(40.0002, -96), {}, ctx, okFetch(80), cache as unknown as Cache);
    expect(((await res.json()) as CloudNowResponse).cloud_pct).toBe(80); // its own value, not 20
  });
});
