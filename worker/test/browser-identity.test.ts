import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Env } from '../src/index';
const issuer = 'https://test-team.cloudflareaccess.com';
const origin = 'https://map.astroanil.dev';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: string;
let records: Map<string, string>;
let env: Env;
let bucket: {
  get: (key: string) => Promise<{ json: () => Promise<unknown> } | null>;
  put: (key: string, body: string, options?: { onlyIf?: unknown }) => Promise<{ key: string } | null>;
  list: (options: { prefix?: string; limit?: number }) => Promise<{ objects: Array<{ key: string }> }>;
};
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwks = JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'identity-key' }] });
});
beforeEach(() => {
  vi.resetModules(); records = new Map();
  bucket = {
    get: vi.fn(async (key: string) => records.has(key) ? { json: async () => JSON.parse(records.get(key)!) } : null),
    put: vi.fn(async (key: string, body: string, options?: { onlyIf?: unknown }) => {
      if (options?.onlyIf && records.has(key)) return null;
      records.set(key, body); return { key };
    }),
    list: vi.fn(async ({ prefix = '', limit = 100 }: { prefix?: string; limit?: number }) => ({
      objects: [...records.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit).map((key) => ({ key })),
    })),
  };
  env = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: 'map-audience', CALIB_TOKEN: 'legacy', SITE: bucket, CALIB: bucket } as unknown as Env;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(jwks, { headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { vi.unstubAllGlobals(); });
async function jwt(sub = 'jessica-id', email = 'jessica@example.com', overrides = {}) {
  return new SignJWT({ sub, email, iss: issuer, aud: 'map-audience', iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'identity-key' }).sign(keys.privateKey);
}
async function call(path: string, assertion?: string, method = 'GET', body?: unknown, extras = {}) {
  const request = new Request(`${origin}${path}`, { method, headers: {
    ...(assertion ? { 'cf-access-jwt-assertion': assertion } : {}), origin, 'content-type': 'application/json', ...extras,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return (await import('../src/index')).default.fetch(request, env, {} as ExecutionContext);
}
async function session(assertion: string) {
  const response = await call('/api/browser/session', assertion);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return await response.json() as { ok: true; profile: { name: string; displayName: string } };
}
async function emailBinding(email: string, name: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  const key = 'email:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const bindings = JSON.parse(env.ACCESS_PROFILE_BINDINGS || '{}');
  Object.assign(env, { ACCESS_PROFILE_BINDINGS: JSON.stringify({ ...bindings, [key]: name }) });
}
function target(profile: string) {
  return { id: `personal:${profile}:test`, name: 'Tuvalu', lat: -8.52, lon: 179.2, priority: 5, createdAt: '2026-09-12T00:00:00Z' };
}
describe('account-owned browser profiles', () => {
  it('returns distinct stable profiles without exposing identity credentials', async () => {
    const a = await session(await jwt());
    const again = await session(await jwt('jessica-id', 'changed@example.com'));
    const b = await session(await jwt('other-id', 'other@example.com'));
    expect(a.profile.name).toMatch(/^u-[a-f0-9]{28}$/);
    expect(again.profile.name).toBe(a.profile.name);
    expect(b.profile.name).not.toBe(a.profile.name);
    expect(JSON.stringify(a)).not.toMatch(/@|jessica-id|eyJ/);
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it('retains an explicitly bound legacy profile and existing targets', async () => {
    await emailBinding(' OWNER@EXAMPLE.COM ', 'anil');
    await emailBinding('other-owner@example.com', 'anil');
    expect((await session(await jwt('second-owner-id', 'other-owner@example.com'))).profile.name).toBe('anil');
    const assertion = await jwt('owner-id', 'owner@example.com');
    expect((await session(assertion)).profile.name).toBe('anil');
    records.set('profiles/anil/targets.json', JSON.stringify([target('anil')]));
    expect(await (await call('/api/browser/profiles/anil/targets', assertion)).json()).toEqual({ targets: [target('anil')] });
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it('uses only the verified identity for the display label and supports safe session reads', async () => {
    const assertion = await jwt('jessica-id', 'jessica@example.com', { name: 'Jessica' });
    const response = await call('/api/browser/session', assertion, 'GET', undefined,
      { 'cf-access-authenticated-user-email': 'owner@example.com' });
    expect(await response.json()).toMatchObject({ profile: { displayName: 'Jessica' } });
    const head = await call('/api/browser/session', assertion, 'HEAD');
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect((await call('/api/browser/session', assertion, 'POST')).status).toBe(405);
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
  });
  it('cannot claim or edit Anil using a copied path or client-supplied identity', async () => {
    const assertion = await jwt();
    for (const prefix of ['/api/browser/profiles', '/api/profiles']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const response = await call(`${prefix}/anil/targets${method === 'DELETE' ? '/personal%3Aanil%3Atest' : ''}`, assertion, method,
          method === 'POST' ? target('anil') : method === 'PUT' ? { targets: [target('anil')] } : undefined,
          { 'cf-access-authenticated-user-email': 'owner@example.com', 'x-calib-token': 'legacy' });
        expect(response.status).toBe(403);
      }
    }
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
  });
  it('permits same-origin CRUD only on the account namespace', async () => {
    const assertion = await jwt(); const name = (await session(assertion)).profile.name;
    const path = `/api/browser/profiles/${name}/targets`;
    expect((await call(path, assertion, 'POST', target(name))).status).toBe(200);
    expect(await (await call(path, assertion)).json()).toEqual({ targets: [target(name)] });
    for (const method of ['POST', 'PUT', 'DELETE']) {
      for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }])
        expect((await call(path, assertion, method, undefined, headers)).status).toBe(403);
    }
    expect((await call(path, assertion, 'PUT', { targets: [] })).status).toBe(200);
  });
  it('rejects forged, unsigned, expired, anonymous and machine-only browser identity', async () => {
    expect((await call('/api/browser/session', undefined, 'GET', undefined,
      { 'cf-access-authenticated-user-email': 'owner@example.com', 'x-calib-token': 'legacy' })).status).toBe(401);
    for (const assertion of ['forged', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJvd25lciJ9.', await jwt('jessica-id', 'jessica@example.com', { exp: 1 })])
      expect((await call('/api/browser/session', assertion)).status).toBe(401);
    expect((await call('/api/browser/profiles/anil/targets', undefined, 'GET', undefined, { 'x-calib-token': 'legacy' })).status).toBe(401);
    expect((await call('/api/profiles/anil/targets', undefined, 'GET', undefined, { 'x-calib-token': 'legacy' })).status).toBe(200);
  });
  it('fails closed on malformed private binding configuration', async () => {
    for (const value of ['not-json', '[]', '{"raw@example.com":"anil"}', '{"email:bad":"anil"}']) {
      Object.assign(env, { ACCESS_PROFILE_BINDINGS: value });
      expect((await call('/api/browser/session', await jwt())).status).toBe(503);
    }
    delete env.ACCESS_PROFILE_BINDINGS;
    await emailBinding('jessica@example.com', 'u-' + 'a'.repeat(28));
    expect((await call('/api/browser/session', await jwt())).status).toBe(503);
  });
});
describe('account-owned ratings', () => {
  it('rejects another profile before reading or writing storage', async () => {
    const assertion = await jwt();
    expect((await call('/api/log?profile=anil', assertion)).status).toBe(403);
    expect((await call('/api/log', assertion, 'POST', { target_id: 'test', pass_time: '2026-09-12T01:00:00Z', action: 'shoot', profile: 'anil' })).status).toBe(403);
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
  });
  it('separates equal shot dedupe keys and returns only the account logs', async () => {
    const a = await jwt(); const b = await jwt('other-id', 'other@example.com');
    const body = { target_id: 'test', pass_time: '2026-09-12T01:00:00Z', action: 'shoot', dedupe_key: 'same-photo' };
    expect(await (await call('/api/log', a, 'POST', body)).json()).toMatchObject({ ok: true, deduped: false });
    expect(await (await call('/api/log', b, 'POST', body)).json()).toMatchObject({ ok: true, deduped: false });
    expect(await (await call('/api/log', a, 'POST', body)).json()).toMatchObject({ ok: true, deduped: true });
    const profile = (await session(a)).profile.name;
    const read = await (await call('/api/log', a)).json() as { entries: Array<{profile: string}> };
    expect(read.entries).toHaveLength(1); expect(read.entries[0]!.profile).toBe(profile);
  });
  it('finds personal ratings even when other accounts have filled the shared month', async () => {
    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    for (let i = 0; i < 250; i++) records.set(`log/${month}/foreign-${i}.json`, '{}');
    const assertion = await jwt();
    expect((await call('/api/log', assertion, 'POST', {
      target_id: 'test', pass_time: '2026-09-12T01:00:00Z', action: 'shoot', dedupe_key: 'my-photo',
    })).status).toBe(200);
    expect(await (await call('/api/log', assertion)).json()).toMatchObject({ entries: [{ dedupe_key: 'my-photo' }] });
  });
  it('preserves existing owner dedupe keys under the bound Google account', async () => {
    await emailBinding('owner@example.com', 'anil');
    const body = { target_id: 'test', pass_time: '2026-09-12T01:00:00Z', action: 'shoot', dedupe_key: 'old-owner-photo', profile: 'anil' };
    expect(await (await call('/api/log', undefined, 'POST', body, { 'x-calib-token': 'legacy' })).json()).toMatchObject({ ok: true, deduped: false });
    expect(await (await call('/api/log', await jwt('owner-id', 'owner@example.com'), 'POST', body)).json()).toMatchObject({ ok: true, deduped: true });
  });
});
