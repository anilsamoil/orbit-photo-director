/**
 * Worker tests for /api/profiles/<name>/targets CRUD — Slot 3 of design rev 2.
 *
 * Uses the same hand-rolled fetch invocation + MockR2Bucket pattern as
 * index.test.ts to keep portability with the existing harness.
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
  public throwOnGet: Error | null = null;
  public throwOnPut: Error | null = null;

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

  async put(
    key: string,
    body: string,
    meta?: Record<string, unknown>,
  ): Promise<{ key: string } | null> {
    if (this.throwOnPut) throw this.throwOnPut;
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

  has(key: string): boolean {
    return this.store.has(key);
  }
  raw(key: string): string | undefined {
    return this.store.get(key)?.body;
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
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const url = `https://example.com${path}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (worker as any).fetch(new Request(url, init), env, {});
}

const TOKEN = 'test-secret-123';
function authHeaders(extras: Record<string, string> = {}): Record<string, string> {
  return { 'x-calib-token': TOKEN, 'content-type': 'application/json', ...extras };
}

/** A minimal valid PersonalTarget for `jack`. Tweak per-test as needed. */
function validTarget(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'personal:jack:11111111-2222-3333-4444-555555555555',
    name: 'Boston',
    lat: 42.36,
    lon: -71.06,
    priority: 5,
    createdAt: '2026-05-26T12:00:00Z',
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Auth gate
// --------------------------------------------------------------------------

describe('/api/profiles auth', () => {
  it('GET without token → 401', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets');
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('GET with wrong token → 401', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      headers: { 'x-calib-token': 'WRONG' },
    });
    expect(r.status).toBe(401);
  });

  it('GET with token of differing length still 401 (constant-time path)', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      headers: { 'x-calib-token': 'short' },
    });
    expect(r.status).toBe(401);
  });

  it('PUT without token → 401 even with valid body', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      body: JSON.stringify({ targets: [] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(401);
  });

  it('returns 503 when CALIB_TOKEN env is unset (deploy misconfig)', async () => {
    const env = makeEnv({ CALIB_TOKEN: '' });
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      headers: { 'x-calib-token': 'anything' },
    });
    expect(r.status).toBe(503);
  });
});

// --------------------------------------------------------------------------
// Profile name validation
// --------------------------------------------------------------------------

describe('/api/profiles profile-name validation', () => {
  it('rejects uppercase names with 400', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/Jack/targets', {
      headers: authHeaders(),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_profile_name');
  });

  it('rejects names with path traversal characters', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/..%2Fchris/targets', {
      headers: authHeaders(),
    });
    // ".." after URL decoding is invalid; the .. and other chars aren't in
    // the regex anyway.
    expect(r.status).toBe(400);
  });

  it('rejects names longer than 32 chars', async () => {
    const env = makeEnv();
    const longName = 'a'.repeat(33);
    const r = await fetchWorker(env, `/api/profiles/${longName}/targets`, {
      headers: authHeaders(),
    });
    expect(r.status).toBe(400);
  });

  it('accepts lowercase + digits + hyphen', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack-2/targets', {
      headers: authHeaders(),
    });
    expect(r.status).toBe(200);
  });
});

// --------------------------------------------------------------------------
// GET
// --------------------------------------------------------------------------

describe('GET /api/profiles/<name>/targets', () => {
  it('returns empty list when R2 has no object', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      headers: authHeaders(),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { targets: unknown[] };
    expect(body.targets).toEqual([]);
  });

  it('returns stored targets when R2 has data', async () => {
    const env = makeEnv();
    const stored = [validTarget({ name: 'Tokyo' })];
    await env.CALIB.put('profiles/jack/targets.json', JSON.stringify(stored));
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      headers: authHeaders(),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { targets: Array<{ name: string }> };
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]?.name).toBe('Tokyo');
  });

  it('returns 503 when the stored object is not an array', async () => {
    const env = makeEnv();
    await env.CALIB.put('profiles/jack/targets.json', JSON.stringify({ rogue: 'shape' }));
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      headers: authHeaders(),
    });
    // The handler treats corrupted storage as 503 (caught by the outer
    // try/catch); operator can rebuild via PUT.
    expect(r.status).toBe(503);
  });
});

// --------------------------------------------------------------------------
// PUT
// --------------------------------------------------------------------------

describe('PUT /api/profiles/<name>/targets', () => {
  it('writes a valid list and GET returns it', async () => {
    const env = makeEnv();
    const list = [validTarget(), validTarget({
      id: 'personal:jack:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'Kyoto',
      lat: 35.0,
      lon: 135.7,
    })];
    const putRes = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ targets: list }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { ok: boolean; count: number };
    expect(putBody.ok).toBe(true);
    expect(putBody.count).toBe(2);

    const getRes = await fetchWorker(env, '/api/profiles/jack/targets', {
      headers: authHeaders(),
    });
    const getBody = (await getRes.json()) as { targets: Array<{ name: string }> };
    expect(getBody.targets).toHaveLength(2);
    expect(getBody.targets[1]?.name).toBe('Kyoto');
  });

  it('rejects body with no targets field', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('targets_must_be_array');
  });

  it('rejects invalid JSON', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      headers: authHeaders(),
      body: 'not json',
    });
    expect(r.status).toBe(400);
  });

  it('rejects target with out-of-range lat (per-index error)', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        targets: [validTarget(), validTarget({
          id: 'personal:jack:zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
          lat: 95,
        })],
      }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; errors: Array<{ index: number; error: string }> };
    expect(body.error).toBe('invalid_targets');
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.index).toBe(1);
    expect(body.errors[0]?.error).toBe('lat_out_of_range');
  });

  it('rejects target with missing name', async () => {
    const env = makeEnv();
    const t = validTarget();
    delete (t as Record<string, unknown>).name;
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ targets: [t] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { errors: Array<{ error: string }> };
    expect(body.errors[0]?.error).toBe('name_must_be_string');
  });

  it('rejects target whose id profile-segment does not match URL profile', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        targets: [validTarget({ id: 'personal:chris:11111111-2222-3333-4444-555555555555' })],
      }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { errors: Array<{ error: string }> };
    expect(body.errors[0]?.error).toBe('id_profile_mismatch');
  });

  it('rejects target with non-integer priority', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ targets: [validTarget({ priority: 3.5 })] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { errors: Array<{ error: string }> };
    expect(body.errors[0]?.error).toBe('priority_must_be_integer');
  });

  it('rejects duplicate ids in the same PUT', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ targets: [validTarget(), validTarget()] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('duplicate_id');
  });

  it('rejects PUT exceeding the per-profile target cap', async () => {
    const env = makeEnv();
    const tooMany = Array.from({ length: 501 }, (_, i) => validTarget({
      id: `personal:jack:${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`,
    }));
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ targets: tooMany }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('too_many_targets');
  });

  it('PUT with empty list clears the profile', async () => {
    const env = makeEnv();
    await env.CALIB.put('profiles/jack/targets.json', JSON.stringify([validTarget()]));
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ targets: [] }),
    });
    expect(r.status).toBe(200);
    const stored = env.CALIB.raw('profiles/jack/targets.json');
    expect(JSON.parse(stored ?? '[]')).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// POST
// --------------------------------------------------------------------------

describe('POST /api/profiles/<name>/targets', () => {
  it('appends a target to an empty list', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(validTarget()),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; count: number };
    expect(body.count).toBe(1);
  });

  it('appends a target to an existing list', async () => {
    const env = makeEnv();
    await env.CALIB.put(
      'profiles/jack/targets.json',
      JSON.stringify([validTarget()]),
    );
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(validTarget({
        id: 'personal:jack:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        name: 'Kyoto',
        lat: 35.0,
        lon: 135.7,
      })),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { count: number };
    expect(body.count).toBe(2);
  });

  it('rejects duplicate id on append with 409', async () => {
    const env = makeEnv();
    await env.CALIB.put(
      'profiles/jack/targets.json',
      JSON.stringify([validTarget()]),
    );
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(validTarget()),
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('duplicate_id');
  });

  it('rejects invalid target with detail field', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(validTarget({ lon: 999 })),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; detail: string };
    expect(body.error).toBe('invalid_target');
    expect(body.detail).toBe('lon_out_of_range');
  });
});

// --------------------------------------------------------------------------
// DELETE
// --------------------------------------------------------------------------

describe('DELETE /api/profiles/<name>/targets/<id>', () => {
  it('removes a matching entry', async () => {
    const env = makeEnv();
    const list = [
      validTarget(),
      validTarget({
        id: 'personal:jack:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        name: 'Kyoto',
      }),
    ];
    await env.CALIB.put('profiles/jack/targets.json', JSON.stringify(list));
    const r = await fetchWorker(
      env,
      `/api/profiles/jack/targets/${encodeURIComponent('personal:jack:11111111-2222-3333-4444-555555555555')}`,
      { method: 'DELETE', headers: authHeaders() },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; removed: boolean; count: number };
    expect(body.removed).toBe(true);
    expect(body.count).toBe(1);

    const stored = JSON.parse(env.CALIB.raw('profiles/jack/targets.json') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Kyoto');
  });

  it('returns ok:true removed:false when id does not exist (idempotent)', async () => {
    const env = makeEnv();
    await env.CALIB.put(
      'profiles/jack/targets.json',
      JSON.stringify([validTarget()]),
    );
    const r = await fetchWorker(
      env,
      `/api/profiles/jack/targets/${encodeURIComponent('personal:jack:ffffffff-ffff-ffff-ffff-ffffffffffff')}`,
      { method: 'DELETE', headers: authHeaders() },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { removed: boolean; count: number };
    expect(body.removed).toBe(false);
    expect(body.count).toBe(1);
  });

  it('returns 400 for malformed id', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets/not-a-real-id', {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(r.status).toBe(400);
  });
});

// --------------------------------------------------------------------------
// Routing edges
// --------------------------------------------------------------------------

describe('/api/profiles routing edges', () => {
  it('returns 404 for unknown subpath under /api/profiles/<name>/', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/other', {
      headers: authHeaders(),
    });
    expect(r.status).toBe(404);
  });

  it('returns 405 for an unsupported verb on the collection route', async () => {
    const env = makeEnv();
    // PATCH isn't in ALLOWED_METHODS so the outer router replies 405 first.
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'PATCH',
      headers: authHeaders(),
    });
    expect(r.status).toBe(405);
  });

  it('returns 503 when R2 read throws', async () => {
    const env = makeEnv();
    env.CALIB.throwOnGet = new Error('outage');
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      headers: authHeaders(),
    });
    expect(r.status).toBe(503);
  });

  it('OPTIONS preflight advertises PUT + DELETE for CORS', async () => {
    const env = makeEnv();
    const r = await fetchWorker(env, '/api/profiles/jack/targets', {
      method: 'OPTIONS',
      headers: { origin: 'https://map.astroanil.dev' },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(r.headers.get('access-control-allow-methods')).toContain('DELETE');
  });
});
