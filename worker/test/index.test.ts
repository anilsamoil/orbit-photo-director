/**
 * Worker tests using a hand-rolled fetch invocation against the default export.
 * Avoids miniflare for portability — passes a mock Env with in-memory R2 stubs.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import worker from '../src/index';

interface MockObj {
  body: string;
  meta: Record<string, unknown>;
}

class MockR2Bucket {
  private store = new Map<string, MockObj>();

  async get(key: string): Promise<{ json: () => Promise<unknown>; text: () => Promise<string> } | null> {
    const v = this.store.get(key);
    if (!v) return null;
    return {
      json: async () => JSON.parse(v.body),
      text: async () => v.body,
    };
  }

  async head(key: string): Promise<MockObj | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, body: string, meta?: Record<string, unknown>): Promise<void> {
    this.store.set(key, { body, meta: meta ?? {} });
  }

  // helper for tests
  has(key: string): boolean {
    return this.store.has(key);
  }
  size(): number {
    return this.store.size;
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
    expect(env.CALIB.size()).toBe(1);
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
    expect(env.CALIB.size()).toBe(1);
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
