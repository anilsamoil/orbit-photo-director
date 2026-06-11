/**
 * Worker tests using a hand-rolled fetch invocation against the default export.
 * Avoids miniflare for portability — passes a mock Env with in-memory R2 stubs.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import worker from '../src/index';

interface MockObj {
  body: string;
  meta: Record<string, unknown>;
  httpMetadata?: { contentType?: string; cacheControl?: string };
}

class MockR2Bucket {
  private store = new Map<string, MockObj>();
  /** Test hook: when set, get() throws this error. Lets us simulate R2 outages. */
  public throwOnGet: Error | null = null;

  async get(
    key: string,
  ): Promise<
    | {
        json: () => Promise<unknown>;
        text: () => Promise<string>;
        body: string;
        httpMetadata?: { contentType?: string; cacheControl?: string };
        httpEtag: string;
      }
    | null
  > {
    if (this.throwOnGet) throw this.throwOnGet;
    const v = this.store.get(key);
    if (!v) return null;
    return {
      json: async () => JSON.parse(v.body),
      text: async () => v.body,
      body: v.body,
      httpMetadata: v.httpMetadata,
      httpEtag: `"${key}-etag"`,
    };
  }

  async head(key: string): Promise<MockObj | null> {
    return this.store.get(key) ?? null;
  }

  async put(
    key: string,
    body: string,
    meta?: Record<string, unknown>,
  ): Promise<{ key: string } | null> {
    // Honor R2 conditional put: `onlyIf: { etagDoesNotMatch: '*' }` returns
    // null if the key already exists. Used by handleLog for atomic dedupe.
    const onlyIf = (meta as { onlyIf?: { etagDoesNotMatch?: string } } | undefined)?.onlyIf;
    if (onlyIf?.etagDoesNotMatch === '*' && this.store.has(key)) {
      return null;
    }
    this.store.set(key, {
      body,
      meta: meta ?? {},
      httpMetadata: (meta as { httpMetadata?: { contentType?: string; cacheControl?: string } } | undefined)?.httpMetadata,
    });
    return { key };
  }

  async list(opts: { prefix?: string; limit?: number }): Promise<{ objects: Array<{ key: string }> }> {
    const prefix = opts.prefix ?? '';
    const limit = opts.limit ?? 1000;
    const matches: Array<{ key: string }> = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        matches.push({ key });
        if (matches.length >= limit) break;
      }
    }
    return { objects: matches };
  }

  // helpers for tests
  has(key: string): boolean {
    return this.store.has(key);
  }
  size(): number {
    return this.store.size;
  }
  /** Count only calibration log entries; excludes internal meta keys like
   *  the rate-limit counter. Use this in tests asserting record counts. */
  logSize(): number {
    let n = 0;
    for (const k of this.store.keys()) if (k.startsWith('log/')) n++;
    return n;
  }
}

interface TestEnv {
  SITE: MockR2Bucket;
  CALIB: MockR2Bucket;
  CALIB_TOKEN: string;
  STALE_THRESHOLD_SECONDS: string;
}

function makeEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return {
    SITE: new MockR2Bucket(),
    CALIB: new MockR2Bucket(),
    CALIB_TOKEN: 'test-secret-123',
    STALE_THRESHOLD_SECONDS: '1800',
    ...overrides,
  };
}

async function fetchWorker(
  env: TestEnv,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {}
): Promise<Response> {
  const url = `https://example.com${path}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (worker as any).fetch(new Request(url, init), env, {});
}

// --------------------------------------------------------------------------
// /api/log
// --------------------------------------------------------------------------

describe('POST /api/log', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  it('rejects requests without a token', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(401);
  });

  it('rejects invalid token', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'wrong' },
    });
    expect(r.status).toBe(401);
  });

  it('rejects invalid JSON', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect((body as { error: string }).error).toBe('invalid_json');
  });

  it('rejects payload missing required fields', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({ target_id: 'x' }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(400);
  });

  it('rejects pass_time without Z suffix', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 'tokyo-night',
        pass_time: '2024-10-17T12:00:00+00:00',
        action: 'shoot',
      }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(400);
  });

  it('accepts a valid shoot record', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 'tokyo-night',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
        score_at_time: 87,
      }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; deduped: boolean; key: string };
    expect(body.ok).toBe(true);
    expect(body.deduped).toBe(false);
    expect(env.CALIB.logSize()).toBe(1);
  });

  it('rejects rate action without rating', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 'tokyo-night',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'rate',
      }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(400);
  });

  it('accepts rate action with valid rating', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 'tokyo-night',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'rate',
        rating: 4,
        observed_obstruction: 'clear',
      }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
  });

  it('is idempotent on dedupe_key', async () => {
    const payload = {
      target_id: 'tokyo-night',
      pass_time: '2024-10-17T12:00:00Z',
      action: 'shoot' as const,
      dedupe_key: 'fixed-key-1',
    };
    const headers = {
      'content-type': 'application/json',
      'x-calib-token': 'test-secret-123',
    };
    const r1 = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers,
    });
    const r2 = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers,
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { deduped: boolean };
    expect(b2.deduped).toBe(true);
    expect(env.CALIB.logSize()).toBe(1);
  });
});

// --------------------------------------------------------------------------
// /api/health
// --------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('returns 503 when manifest.json is missing', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/health');
    expect(r.status).toBe(503);
    const body = (await r.json()) as { reason: string };
    expect(body.reason).toBe('manifest_not_found');
  });

  it('returns 503 when manifest is unparseable', async () => {
    const env = makeEnv();
    await env.SITE.put('manifest.json', 'not json');
    const r = await fetchWorker(env, '/api/health');
    expect(r.status).toBe(503);
  });

  it('returns 200 when manifest is fresh', async () => {
    const env = makeEnv();
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    await env.SITE.put(
      'manifest.json',
      JSON.stringify({
        version: '20241017T120000Z',
        generated_at: now,
        freshness: { tle_hours: 1, cloud_hours: 0.5, ok: true },
      })
    );
    const r = await fetchWorker(env, '/api/health');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; age_seconds: number };
    expect(body.ok).toBe(true);
    expect(body.age_seconds).toBeLessThan(5);
  });

  it('returns 503 when manifest is stale beyond threshold', async () => {
    const env = makeEnv({ STALE_THRESHOLD_SECONDS: '60' });
    const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    await env.SITE.put(
      'manifest.json',
      JSON.stringify({
        version: 'old',
        generated_at: stale,
        freshness: { tle_hours: 1, cloud_hours: 0.5, ok: true },
      })
    );
    const r = await fetchWorker(env, '/api/health');
    expect(r.status).toBe(503);
  });

  it('returns 503 when manifest.freshness.ok is false', async () => {
    const env = makeEnv();
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    await env.SITE.put(
      'manifest.json',
      JSON.stringify({
        version: 'v1',
        generated_at: now,
        freshness: { tle_hours: 48, cloud_hours: 5, ok: false },
      })
    );
    const r = await fetchWorker(env, '/api/health');
    expect(r.status).toBe(503);
  });
});

// --------------------------------------------------------------------------
// Routing + CORS
// --------------------------------------------------------------------------

describe('GET /api/log', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  it('rejects without token', async () => {
    const r = await fetchWorker(env, '/api/log');
    expect(r.status).toBe(401);
  });

  it('returns empty when no entries exist', async () => {
    const r = await fetchWorker(env, '/api/log', {
      headers: { 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it('returns entries from current month', async () => {
    const now = new Date();
    const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await env.CALIB.put(`log/${yyyymm}/event-a.json`, JSON.stringify({
      target_id: 'tokyo-night',
      pass_time: '2024-10-17T12:00:00Z',
      action: 'shoot',
      received_at: '2024-10-17T12:00:30Z',
    }));
    await env.CALIB.put(`log/${yyyymm}/event-b.json`, JSON.stringify({
      target_id: 'tokyo-night',
      pass_time: '2024-10-17T12:00:00Z',
      action: 'rate',
      rating: 4,
      received_at: '2024-10-17T13:00:00Z',
    }));

    const r = await fetchWorker(env, '/api/log', {
      headers: { 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: Array<{ action: string }> };
    expect(body.entries).toHaveLength(2);
    // sorted by received_at desc — rate (13:00) comes before shoot (12:00:30)
    expect(body.entries[0]?.action).toBe('rate');
    expect(body.entries[1]?.action).toBe('shoot');
  });

  it('respects limit query parameter', async () => {
    const now = new Date();
    const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    for (let i = 0; i < 5; i++) {
      await env.CALIB.put(`log/${yyyymm}/event-${i}.json`, JSON.stringify({
        target_id: `t${i}`,
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
        received_at: `2024-10-17T12:0${i}:00Z`,
      }));
    }
    const r = await fetchWorker(env, '/api/log?limit=3', {
      headers: { 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(3);
  });

  it('clamps oversized limit to 50 (Workers Free subrequest budget)', async () => {
    const now = new Date();
    const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    // Seed 80 entries — more than the 50 cap
    for (let i = 0; i < 80; i++) {
      await env.CALIB.put(`log/${yyyymm}/entry-${String(i).padStart(2, '0')}.json`, JSON.stringify({
        target_id: 't',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
        received_at: `2024-10-17T${String(i).padStart(2, '0')}:00:00Z`,
      }));
    }
    const r = await fetchWorker(env, '/api/log?limit=99999', {
      headers: { 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: unknown[] };
    expect(body.entries.length).toBeLessThanOrEqual(50);
  });

  it('skips unparseable entries gracefully', async () => {
    const now = new Date();
    const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await env.CALIB.put(`log/${yyyymm}/junk.json`, 'not json');
    await env.CALIB.put(`log/${yyyymm}/good.json`, JSON.stringify({
      target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot', received_at: '2024-10-17T12:00:00Z',
    }));
    const r = await fetchWorker(env, '/api/log', {
      headers: { 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });
});

describe('routing + CORS', () => {
  it('returns 404 for unknown paths', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/unknown');
    expect(r.status).toBe(404);
  });

  it('handles OPTIONS preflight', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/log', { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('rejects unsupported methods', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/log', { method: 'PUT' });
    expect(r.status).toBe(405);
  });

  it('rejects POST to /api/aurora (read-only route)', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/aurora', { method: 'POST' });
    expect(r.status).toBe(405);
  });

  it('attaches CORS headers to allowed origin', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/health', {
      headers: { origin: 'https://map.astroanil.dev' },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://map.astroanil.dev');
    expect(r.headers.get('vary')).toBe('origin');
  });

  it('omits ACAO for disallowed origin', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/health', {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('omits ACAO when no origin header', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/health');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('input hardening', () => {
  it('rejects oversized target_id', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 'a'.repeat(500),
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
      }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(400);
  });

  it('rejects unknown observed_obstruction', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 'tokyo-night',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'rate',
        rating: 4,
        observed_obstruction: 'aurora-tag',
      }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(400);
  });

  it('sanitizes path-like dedupe_key (no traversal in resulting object key)', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 'tokyo-night',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
        dedupe_key: '../../../site/manifest.json',
      }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { key: string };
    expect(body.key.includes('..')).toBe(false);
    expect(body.key.includes('/site/')).toBe(false);
  });

  it('rejects oversized body via content-length header', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 'x',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
      }),
      headers: {
        'content-type': 'application/json',
        'x-calib-token': 'test-secret-123',
        'content-length': '100000', // 100 KB > 8 KB cap
      },
    });
    expect(r.status).toBe(413);
  });

  it('returns 503 when R2 write fails', async () => {
    const env = makeEnv();
    env.CALIB.put = async () => {
      throw new Error('simulated R2 outage');
    };
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 'x',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
      }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(503);
  });
});

// --------------------------------------------------------------------------
// handleStatic — R2 fallback for site assets
// --------------------------------------------------------------------------

describe('handleStatic (R2 fallback)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  it('rewrites root / to index.html', async () => {
    await env.SITE.put('index.html', '<html>home</html>', {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
    const r = await fetchWorker(env, '/');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('<html>home</html>');
    expect(r.headers.get('content-type')).toContain('text/html');
  });

  it('rewrites trailing-slash paths to {path}index.html', async () => {
    await env.SITE.put('docs/index.html', '<html>docs</html>', {});
    const r = await fetchWorker(env, '/docs/');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('<html>docs</html>');
  });

  it('returns 404 for log/ prefix even if the key exists in R2 (defense-in-depth)', async () => {
    await env.SITE.put('log/202605.jsonl', 'leaked!', {});
    const r = await fetchWorker(env, '/log/202605.jsonl');
    expect(r.status).toBe(404);
  });

  it('returns 404 when the key is not in R2', async () => {
    const r = await fetchWorker(env, '/missing-asset.css');
    expect(r.status).toBe(404);
  });

  it('returns 503 when R2 get throws (simulated outage)', async () => {
    env.SITE.throwOnGet = new Error('R2 outage');
    const r = await fetchWorker(env, '/anything.html');
    expect(r.status).toBe(503);
  });

  it('uses long-immutable cache for hashed asset extensions', async () => {
    await env.SITE.put('assets/index-abc.js', 'console.log(1);', {});
    const r = await fetchWorker(env, '/assets/index-abc.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('content-type')).toContain('application/javascript');
  });

  it('uses short cache for index.html', async () => {
    await env.SITE.put('index.html', '<html></html>', {});
    const r = await fetchWorker(env, '/');
    expect(r.headers.get('cache-control')).toContain('max-age=60');
  });

  it('serves the etag header for client-side cache validation', async () => {
    await env.SITE.put('index.html', '<html></html>', {});
    const r = await fetchWorker(env, '/');
    expect(r.headers.get('etag')).toBeTruthy();
  });
});

// --------------------------------------------------------------------------
// CALIB_TOKEN unset → 503 (deploy-misconfig guard)
// --------------------------------------------------------------------------

describe('CALIB_TOKEN unset', () => {
  it('POST /api/log returns 503 when CALIB_TOKEN is missing', async () => {
    const env = makeEnv({ CALIB_TOKEN: '' as string });
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({ target_id: 'x', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'whatever' },
    });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('service_misconfigured');
  });

  it('GET /api/log returns 503 when CALIB_TOKEN is missing', async () => {
    const env = makeEnv({ CALIB_TOKEN: '' as string });
    const r = await fetchWorker(env, '/api/log', {
      headers: { 'x-calib-token': 'whatever' },
    });
    expect(r.status).toBe(503);
  });
});

// --------------------------------------------------------------------------
// Rate limit: per-day counter caps abuse if the token leaks
// --------------------------------------------------------------------------

describe('rate limit', () => {
  it('counter object lands at _meta/ratelimit/<date>.json after a successful POST', async () => {
    const env = makeEnv();
    await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({ target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    const meta = Array.from(env.CALIB['store'].keys()).filter((k) => k.startsWith('_meta/ratelimit/'));
    expect(meta).toHaveLength(1);
  });

  it('returns 429 once the daily counter reaches the cap', async () => {
    const env = makeEnv();
    // Pre-seed the counter at the cap
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, '0');
    const d = String(today.getUTCDate()).padStart(2, '0');
    await env.CALIB.put(`_meta/ratelimit/${y}${m}${d}.json`, JSON.stringify({ count: 200 }), {});
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({ target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(429);
    const body = (await r.json()) as { error: string; reset_at: string; limit: number };
    expect(body.error).toBe('rate_limited');
    expect(body.limit).toBe(200);
    // reset_at should be the next UTC midnight
    expect(body.reset_at).toMatch(/T00:00:00\.000Z$/);
  });

  it('does NOT consume rate-limit budget on auth failure', async () => {
    const env = makeEnv();
    await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({ target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'WRONG-TOKEN' },
    });
    const meta = Array.from(env.CALIB['store'].keys()).filter((k) => k.startsWith('_meta/ratelimit/'));
    expect(meta).toHaveLength(0);
  });

  it('does NOT consume rate-limit budget on invalid payload', async () => {
    const env = makeEnv();
    await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({ /* missing required fields */ }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    const meta = Array.from(env.CALIB['store'].keys()).filter((k) => k.startsWith('_meta/ratelimit/'));
    expect(meta).toHaveLength(0);
  });

  it('rejects malformed pass_time (loose-Z trick like "AAAAAAAAZ")', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 't',
        pass_time: 'AAAAAAAAZ',
        action: 'shoot',
      }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_payload');
  });

  it('accepts pass_time with fractional seconds', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 't',
        pass_time: '2024-10-17T12:00:00.123Z',
        action: 'shoot',
      }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
  });

  it('dedupe-no-op retries do NOT consume rate-limit budget', async () => {
    const env = makeEnv();
    const payload = JSON.stringify({
      target_id: 't',
      pass_time: '2024-10-17T12:00:00Z',
      action: 'shoot' as const,
      dedupe_key: 'replay-key-1',
    });
    const headers = { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' };

    // First write succeeds and counts.
    const r1 = await fetchWorker(env, '/api/log', { method: 'POST', body: payload, headers });
    expect(r1.status).toBe(200);

    // 50 replays of the same dedupe_key — drainQueue's pathological case
    // when the network was flaky and the same record is queued/retried.
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetchWorker(env, '/api/log', { method: 'POST', body: payload, headers });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { deduped: boolean };
      expect(body.deduped).toBe(true);
    }

    // Counter should be at exactly 1 — the first-time write — NOT 51.
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, '0');
    const d = String(today.getUTCDate()).padStart(2, '0');
    const counterObj = await env.CALIB.get(`_meta/ratelimit/${y}${m}${d}.json`);
    expect(counterObj).toBeTruthy();
    const counterData = (await counterObj!.json()) as { count: number };
    expect(counterData.count).toBe(1);
  });

  it('atomic dedupe: concurrent identical posts → second is deduped, not overwritten', async () => {
    const env = makeEnv();
    const payload = JSON.stringify({
      target_id: 't',
      pass_time: '2024-10-17T12:00:00Z',
      action: 'shoot' as const,
      dedupe_key: 'race-1',
    });
    const headers = { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' };
    // Two concurrent POSTs with the same dedupe_key
    const [r1, r2] = await Promise.all([
      fetchWorker(env, '/api/log', { method: 'POST', body: payload, headers }),
      fetchWorker(env, '/api/log', { method: 'POST', body: payload, headers }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { deduped: boolean };
    const b2 = (await r2.json()) as { deduped: boolean };
    // Exactly one of the two responses should have deduped=true.
    expect([b1.deduped, b2.deduped].filter((v) => v).length).toBe(1);
    expect(env.CALIB.logSize()).toBe(1);
  });

  it('rate-limit read failure fails open (still accepts the write)', async () => {
    const env = makeEnv();
    // Force a get failure on the counter-read path; the put for the actual
    // log entry must still succeed.
    const realGet = env.CALIB.get.bind(env.CALIB);
    let getCalls = 0;
    env.CALIB.get = async (key: string) => {
      getCalls++;
      if (key.startsWith('_meta/ratelimit/')) throw new Error('read outage');
      return realGet(key);
    };
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({ target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' }),
      headers: { 'content-type': 'application/json', 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
    expect(getCalls).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// Slot 8: /api/log gets a `profile` field
// --------------------------------------------------------------------------

describe('Slot 8: /api/log profile field', () => {
  let env: TestEnv;
  const headers = {
    'content-type': 'application/json',
    'x-calib-token': 'test-secret-123',
  };

  beforeEach(() => {
    env = makeEnv();
  });

  it('POST stores the profile field when present', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 't',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
        profile: 'jack',
      }),
      headers,
    });
    expect(r.status).toBe(200);
    // Find the stored key
    const stored = Array.from(env.CALIB['store'].keys()).filter(
      (k) => k.startsWith('log/') && k.endsWith('.json'),
    );
    expect(stored).toHaveLength(1);
    const obj = await env.CALIB.get(stored[0]!);
    expect(obj).toBeTruthy();
    const parsed = (await obj!.json()) as { profile: string };
    expect(parsed.profile).toBe('jack');
  });

  it('POST defaults missing profile field to "anil"', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 't',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
      }),
      headers,
    });
    expect(r.status).toBe(200);
    const stored = Array.from(env.CALIB['store'].keys()).filter(
      (k) => k.startsWith('log/') && k.endsWith('.json'),
    );
    const obj = await env.CALIB.get(stored[0]!);
    const parsed = (await obj!.json()) as { profile: string };
    expect(parsed.profile).toBe('anil');
  });

  it('POST rejects malformed profile name with 400', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 't',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
        profile: 'Jack/Evil',
      }),
      headers,
    });
    expect(r.status).toBe(400);
  });

  it('POST rejects profile name with uppercase', async () => {
    const r = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 't',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
        profile: 'Jack',
      }),
      headers,
    });
    expect(r.status).toBe(400);
  });

  it('GET ?profile=jack filters to only jack entries', async () => {
    const now = new Date();
    const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await env.CALIB.put(`log/${yyyymm}/a.json`, JSON.stringify({
      target_id: 't1', pass_time: '2024-10-17T12:00:00Z', action: 'shoot',
      profile: 'jack', received_at: '2024-10-17T12:00:30Z',
    }));
    await env.CALIB.put(`log/${yyyymm}/b.json`, JSON.stringify({
      target_id: 't2', pass_time: '2024-10-17T12:00:00Z', action: 'shoot',
      profile: 'chris', received_at: '2024-10-17T13:00:00Z',
    }));
    await env.CALIB.put(`log/${yyyymm}/c.json`, JSON.stringify({
      target_id: 't3', pass_time: '2024-10-17T12:00:00Z', action: 'shoot',
      profile: 'anil', received_at: '2024-10-17T14:00:00Z',
    }));
    const r = await fetchWorker(env, '/api/log?profile=jack', {
      headers: { 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: Array<{ target_id: string; profile: string }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.target_id).toBe('t1');
    expect(body.entries[0]?.profile).toBe('jack');
  });

  it('GET without ?profile returns anil-or-missing entries (backward compat)', async () => {
    const now = new Date();
    const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    // Pre-v1.6.3.0 entry: no profile field at all.
    await env.CALIB.put(`log/${yyyymm}/legacy.json`, JSON.stringify({
      target_id: 'old', pass_time: '2024-10-17T12:00:00Z', action: 'shoot',
      received_at: '2024-10-17T12:00:30Z',
    }));
    // Anil entry stamped by Slot 8 default.
    await env.CALIB.put(`log/${yyyymm}/anil.json`, JSON.stringify({
      target_id: 'a', pass_time: '2024-10-17T12:00:00Z', action: 'shoot',
      profile: 'anil', received_at: '2024-10-17T13:00:00Z',
    }));
    // Jack entry — should NOT appear in unfiltered read.
    await env.CALIB.put(`log/${yyyymm}/jack.json`, JSON.stringify({
      target_id: 'j', pass_time: '2024-10-17T12:00:00Z', action: 'shoot',
      profile: 'jack', received_at: '2024-10-17T14:00:00Z',
    }));
    const r = await fetchWorker(env, '/api/log', {
      headers: { 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: Array<{ target_id: string }> };
    const ids = body.entries.map((e) => e.target_id).sort();
    expect(ids).toEqual(['a', 'old']);
  });

  it('GET ?profile=<malformed> returns 400', async () => {
    const r = await fetchWorker(env, '/api/log?profile=Jack/Evil', {
      headers: { 'x-calib-token': 'test-secret-123' },
    });
    expect(r.status).toBe(400);
  });

  it('roundtrip: POST with profile then GET ?profile=name returns it', async () => {
    const post = await fetchWorker(env, '/api/log', {
      method: 'POST',
      body: JSON.stringify({
        target_id: 'boston',
        pass_time: '2024-10-17T12:00:00Z',
        action: 'shoot',
        profile: 'jack',
      }),
      headers,
    });
    expect(post.status).toBe(200);
    const get = await fetchWorker(env, '/api/log?profile=jack', {
      headers: { 'x-calib-token': 'test-secret-123' },
    });
    const body = (await get.json()) as { entries: Array<{ target_id: string; profile: string }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.target_id).toBe('boston');
    expect(body.entries[0]?.profile).toBe('jack');
  });
});

// ---------------------------------------------------------------------------
// GET /api/cal — serve a client-built .ics as text/calendar so iOS offers
// "Add All to Calendar" (sharing/downloading the FILE does not, on iOS).
// ---------------------------------------------------------------------------
describe('GET /api/cal', () => {
  const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nEND:VCALENDAR\r\n';

  it('serves the ics verbatim as text/calendar with an inline filename', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, `/api/cal?d=${encodeURIComponent(ICS)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/calendar');
    expect(r.headers.get('content-disposition')).toContain('orbit-shots.ics');
    expect(await r.text()).toBe(ICS);
  });

  it('400s when d is missing or not a VCALENDAR (no serving arbitrary content)', async () => {
    const env = makeEnv();
    expect((await fetchWorker(env, '/api/cal')).status).toBe(400);
    expect((await fetchWorker(env, `/api/cal?d=${encodeURIComponent('hello')}`)).status).toBe(400);
  });

  it('413s when the calendar exceeds the size cap', async () => {
    const env = makeEnv();
    const big = 'BEGIN:VCALENDAR\r\n' + 'X'.repeat(33 * 1024);
    const r = await fetchWorker(env, `/api/cal?d=${encodeURIComponent(big)}`);
    expect(r.status).toBe(413);
  });
});
