import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Env } from '../src/index';

const issuer = 'https://test-team.cloudflareaccess.com';
const origin = 'https://map.astroanil.dev';
const authEnv = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: 'map-audience', CALIB_TOKEN: 'legacy' };
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: string;
beforeAll(async () => {
  pair = await generateKeyPair('RS256');
  jwks = JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test-key' }] });
});
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    expect(String(url)).toBe(`${issuer}/cdn-cgi/access/certs`);
    return new Response(jwks, { headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function token(overrides: Record<string, unknown> = {}, key = pair.privateKey) {
  return new SignJWT({
    sub: 'user-1', email: 'test@example.com', iss: issuer, aud: ['map-audience'],
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(key);
}
function req(jwt?: string, method = 'GET', extra = {}) {
  return new Request(`${origin}/api/log`, { method, headers: {
    ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}),
    ...(['POST', 'PUT', 'DELETE'].includes(method) ? { origin } : {}), ...extra,
  } });
}
async function bindingForTestAccount(profile: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test@example.com'));
  const key = 'email:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return JSON.stringify({ [key]: profile });
}
async function authorize(request: Request, env = authEnv) {
  return (await import('../src/calibration-auth')).authorizeCalibration(request, env);
}

describe('Google Access calibration authorization', () => {
  it('accepts a signed, unexpired map audience without a shared token', async () => {
    expect(await authorize(req(await token()))).toBeNull();
    expect(await authorize(req(await token(), 'POST'))).toBeNull();
  });
  for (const claims of [
    { exp: 1 }, { iss: 'https://another-team.cloudflareaccess.com' },
    { aud: ['different-application'] }, { email: null }, { sub: '' }, { exp: undefined },
    { nbf: Math.floor(Date.now() / 1000) + 3600 },
  ]) {
    it(`rejects invalid claims ${JSON.stringify(claims)}`, async () => {
      expect((await authorize(req(await token(claims))))?.status).toBe(401);
    });
  }
  it('rejects wrong signatures', async () => {
    const other = await generateKeyPair('RS256');
    expect((await authorize(req(await token({}, other.privateKey))))?.status).toBe(401);
  });
  it('rejects forged identity headers, unsigned assertions and anonymous callers', async () => {
    expect((await authorize(req(undefined, 'GET', { 'cf-access-authenticated-user-email': 'test@example.com' })))?.status).toBe(401);
    expect((await authorize(req('forged'))) ?.status).toBe(401);
    expect((await authorize(req()))?.status).toBe(401);
  });
  it('does not fall back from invalid assertion to legacy credential', async () => {
    expect((await authorize(req('forged', 'GET', { 'x-calib-token': 'legacy' })))?.status).toBe(401);
  });
  it('rejects cross-origin or origin-less session-authenticated writes', async () => {
    const jwt = await token();
    for (const value of ['https://evil.example', 'null', '']) {
      expect((await authorize(req(jwt, 'POST', { origin: value })))?.status).toBe(403);
    }
    expect((await authorize(req(jwt, 'POST', { 'sec-fetch-site': 'cross-site' })))?.status).toBe(403);
  });
  it('fails closed without issuer/audience config or when keys are unavailable', async () => {
    const jwt = await token();
    expect((await authorize(req(jwt), { ...authEnv, ACCESS_AUD: '' }))?.status).toBe(503);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect((await authorize(req(jwt)))?.status).toBe(503);
  });
  it('retains the existing machine credential', async () => {
    expect(await authorize(req(undefined, 'GET', { 'x-calib-token': 'legacy' }))).toBeNull();
  });
  it('authorizes profile CRUD using signed Google sessions and rejects unsafe writes before storage', async () => {
    const records = new Map<string, string>();
    const bucket = {
      get: vi.fn(async (key: string) => records.has(key) ? { json: async () => JSON.parse(records.get(key)!) } : null),
      put: vi.fn(async (key: string, body: string) => { records.set(key, body); return { key }; }),
    };
    const env = { ...authEnv, ACCESS_PROFILE_BINDINGS: await bindingForTestAccount('jack'), CALIB_TOKEN: '', CALIB: bucket, SITE: bucket } as unknown as Env;
    const worker = (await import('../src/index')).default;
    const jwt = await token();
    const target = { id: 'personal:jack:test', name: 'Test', lat: 0, lon: 0, priority: 5, createdAt: '2026-09-09T00:00:00Z' };
    const request = (method: string, body?: unknown, extra = {}, suffix = '') => new Request(`${origin}/api/browser/profiles/jack/targets${suffix}`, {
      method, headers: { origin, 'content-type': 'application/json', 'cf-access-jwt-assertion': jwt, ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const method of ['POST', 'PUT', 'DELETE']) {
      for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
        expect((await worker.fetch(request(method, undefined, headers), env, {} as ExecutionContext)).status).toBe(403);
      }
    }
    expect(bucket.get).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect((await worker.fetch(request('POST', target), env, {} as ExecutionContext)).status).toBe(200);
    const read = await worker.fetch(request('GET'), env, {} as ExecutionContext);
    expect(await read.json()).toEqual({ targets: [target] });
    expect((await worker.fetch(request('PUT', { targets: [target] }), env, {} as ExecutionContext)).status).toBe(200);
    const removed = await worker.fetch(request('DELETE', undefined, {}, `/${encodeURIComponent(target.id)}`), env, {} as ExecutionContext);
    expect(await removed.json()).toMatchObject({ ok: true, removed: true, count: 0 });
    const forged = await worker.fetch(request('GET', undefined, { 'cf-access-jwt-assertion': 'forged', 'x-calib-token': 'legacy' }), { ...env, CALIB_TOKEN: 'legacy' }, {} as ExecutionContext);
    expect(forged.status).toBe(401);
  });
  it('routes token-free ratings through validation, persistence and idempotency', async () => {
    const records = new Map<string, string>();
    const bucket = {
      get: async (key: string) => records.has(key) ? { json: async () => JSON.parse(records.get(key)!) } : null,
      put: async (key: string, body: string, options?: { onlyIf?: unknown }) => {
        if (options?.onlyIf && records.has(key)) return null;
        records.set(key, body); return { key };
      },
      list: async () => ({ objects: [] }),
    };
    const env = { ...authEnv, ACCESS_PROFILE_BINDINGS: await bindingForTestAccount('anil'), CALIB: bucket, SITE: bucket } as unknown as Env;
    const worker = (await import('../src/index')).default;
    const jwt = await token();
    const makeRequest = () => new Request(`${origin}/api/log`, { method: 'POST', headers: {
      origin, 'content-type': 'application/json', 'cf-access-jwt-assertion': jwt,
    }, body: JSON.stringify({ target_id: 'test', pass_time: '2026-09-07T12:00:00Z',
      action: 'rate', rating: 4, profile: 'anil', dedupe_key: 'test-rating' }) });
    const first = await worker.fetch(makeRequest(), env, {} as ExecutionContext);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, deduped: false });
    const second = await worker.fetch(makeRequest(), env, {} as ExecutionContext);
    expect(await second.json()).toMatchObject({ ok: true, deduped: true });
    expect([...records.keys()].filter((key) => key.startsWith('log/'))).toHaveLength(1);
    const read = await worker.fetch(req(jwt), env, {} as ExecutionContext);
    expect(read.status).toBe(200);
  });
});
