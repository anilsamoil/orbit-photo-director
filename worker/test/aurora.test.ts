/**
 * Tests for worker/src/aurora.ts — SWPC Kp index proxy.
 *
 * Coverage:
 * - parseKp: happy path, empty array, malformed row, schema-drift tolerance
 *   (kp_index vs kp string), NaN/out-of-range Kp, bad timestamps
 * - handleKpRequest: happy path with fresh fetch, edge cache hit short-circuit,
 *   SWPC network failure (fetch throws), SWPC 5xx response, SWPC malformed JSON
 *   parse failure, SWPC valid JSON but no parseable rows
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { handleKpRequest, parseKp } from '../src/aurora';

/** Shape of the JSON bodies our handler emits. Success path returns
 *  KpResponse fields; error path returns an `error` discriminator plus
 *  optional context fields. Tests use this to type-narrow `res.json()`,
 *  which returns `unknown` under strict TS. */
type KpBody = {
  kp?: number;
  timestamp?: string;
  age_min?: number;
  error?: string;
  status?: number;
};

// ----- Mock infrastructure ---------------------------------------------------

class MockCache implements Pick<Cache, 'match' | 'put'> {
  private store = new Map<string, Response>();
  async match(req: RequestInfo): Promise<Response | undefined> {
    const key = typeof req === 'string' ? req : (req as Request).url;
    const r = this.store.get(key);
    // Cache.match returns a fresh response; clone to avoid body-already-read.
    return r ? r.clone() : undefined;
  }
  async put(req: RequestInfo, res: Response): Promise<void> {
    const key = typeof req === 'string' ? req : (req as Request).url;
    this.store.set(key, res.clone());
  }
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => { /* swallow */ },
    passThroughOnException: () => { /* noop */ },
    props: {},
  } as ExecutionContext;
}

function makeFetch(impl: (url: string) => Promise<Response>): typeof fetch {
  return ((input: RequestInfo | URL, _init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    return impl(u);
  }) as typeof fetch;
}

// ----- parseKp unit tests ----------------------------------------------------

describe('parseKp', () => {
  const NOW = Date.parse('2026-05-13T12:00:00Z');

  it('extracts the latest row from a well-formed SWPC payload', () => {
    const payload = [
      { time_tag: '2026-05-13T11:00:00Z', kp_index: 3.0 },
      { time_tag: '2026-05-13T11:30:00Z', kp_index: 3.7 },
      { time_tag: '2026-05-13T11:55:00Z', kp_index: 4.2 },
    ];
    expect(parseKp(payload, NOW)).toEqual({
      kp: 4.2,
      timestamp: '2026-05-13T11:55:00Z',
      age_min: 5,
    });
  });

  it('returns null for empty array', () => {
    expect(parseKp([], NOW)).toBeNull();
  });

  it('returns null for non-array input (schema drift defense)', () => {
    expect(parseKp({}, NOW)).toBeNull();
    expect(parseKp('not an array', NOW)).toBeNull();
    expect(parseKp(null, NOW)).toBeNull();
  });

  it('accepts kp as a string (alternate schema)', () => {
    const payload = [{ time_tag: '2026-05-13T11:55:00Z', kp: '5.3' }];
    expect(parseKp(payload, NOW)).toEqual({
      kp: 5.3,
      timestamp: '2026-05-13T11:55:00Z',
      age_min: 5,
    });
  });

  it('walks back from the newest row, skipping malformed trailing samples', () => {
    const payload = [
      { time_tag: '2026-05-13T11:00:00Z', kp_index: 3.0 },
      { time_tag: '2026-05-13T11:30:00Z', kp_index: 3.7 },
      { time_tag: 'BAD_TIMESTAMP', kp_index: 4.0 },    // trailing garbage
      { time_tag: '2026-05-13T11:55:00Z', kp_index: NaN }, // trailing garbage
    ];
    // The two trailing rows are skipped; latest valid is the 11:30 sample.
    expect(parseKp(payload, NOW)).toEqual({
      kp: 3.7,
      timestamp: '2026-05-13T11:30:00Z',
      age_min: 30,
    });
  });

  it('rejects out-of-range Kp values', () => {
    expect(parseKp([{ time_tag: '2026-05-13T11:00:00Z', kp_index: -1 }], NOW)).toBeNull();
    expect(parseKp([{ time_tag: '2026-05-13T11:00:00Z', kp_index: 10 }], NOW)).toBeNull();
  });

  it('clamps age_min to 0 for future-dated samples (clock skew)', () => {
    const future = Date.parse('2026-05-13T12:30:00Z');
    const result = parseKp([{ time_tag: '2026-05-13T12:30:00Z', kp_index: 3.0 }], NOW);
    expect(result?.age_min).toBe(0);
    expect(future).toBeGreaterThan(NOW); // sanity check
  });
});

// ----- handleKpRequest integration tests -------------------------------------

describe('handleKpRequest', () => {
  let cache: MockCache;
  let ctx: ExecutionContext;
  const cacheableSwpc = JSON.stringify([
    { time_tag: '2026-05-13T11:55:00Z', kp_index: 4.2 },
  ]);

  beforeEach(() => {
    cache = new MockCache();
    ctx = makeCtx();
  });

  it('serves SWPC data on cache miss', async () => {
    const fetchImpl = makeFetch(async () => new Response(cacheableSwpc, { status: 200 }));
    const res = await handleKpRequest(
      new Request('https://example.com/api/kp'),
      {},
      ctx,
      fetchImpl,
      cache as unknown as Cache,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as KpBody;
    expect(body.kp).toBe(4.2);
    expect(body.timestamp).toBe('2026-05-13T11:55:00Z');
    expect(typeof body.age_min).toBe('number');
  });

  it('returns cached response on cache hit (no upstream fetch)', async () => {
    let fetchCalls = 0;
    const fetchImpl = makeFetch(async () => {
      fetchCalls++;
      return new Response(cacheableSwpc, { status: 200 });
    });
    // Prime the cache.
    await handleKpRequest(
      new Request('https://example.com/api/kp'),
      {},
      ctx,
      fetchImpl,
      cache as unknown as Cache,
    );
    expect(fetchCalls).toBe(1);
    // Second call hits cache.
    const res = await handleKpRequest(
      new Request('https://example.com/api/kp'),
      {},
      ctx,
      fetchImpl,
      cache as unknown as Cache,
    );
    expect(fetchCalls).toBe(1);
    expect(res.status).toBe(200);
  });

  it('returns 502 when fetch throws (SWPC unreachable)', async () => {
    const fetchImpl = makeFetch(async () => {
      throw new Error('connection refused');
    });
    const res = await handleKpRequest(
      new Request('https://example.com/api/kp'),
      {},
      ctx,
      fetchImpl,
      cache as unknown as Cache,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as KpBody;
    expect(body.error).toBe('swpc_unreachable');
  });

  it('returns 502 when SWPC returns 5xx', async () => {
    const fetchImpl = makeFetch(async () => new Response('upstream error', { status: 503 }));
    const res = await handleKpRequest(
      new Request('https://example.com/api/kp'),
      {},
      ctx,
      fetchImpl,
      cache as unknown as Cache,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as KpBody;
    expect(body.error).toBe('swpc_status');
    expect(body.status).toBe(503);
  });

  it('returns 502 when SWPC returns malformed JSON', async () => {
    const fetchImpl = makeFetch(async () => new Response('not json at all', { status: 200 }));
    const res = await handleKpRequest(
      new Request('https://example.com/api/kp'),
      {},
      ctx,
      fetchImpl,
      cache as unknown as Cache,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as KpBody;
    expect(body.error).toBe('swpc_parse');
  });

  it('returns 502 when SWPC returns valid JSON with no parseable rows', async () => {
    const fetchImpl = makeFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    const res = await handleKpRequest(
      new Request('https://example.com/api/kp'),
      {},
      ctx,
      fetchImpl,
      cache as unknown as Cache,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as KpBody;
    expect(body.error).toBe('swpc_no_data');
  });

  it('includes CORS headers so the frontend can fetch from map.astroanil.dev', async () => {
    const fetchImpl = makeFetch(async () => new Response(cacheableSwpc, { status: 200 }));
    const res = await handleKpRequest(
      new Request('https://example.com/api/kp'),
      {},
      ctx,
      fetchImpl,
      cache as unknown as Cache,
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
