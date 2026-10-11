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
  return await response.json() as { ok: true; profile: { name: string; displayName: string }; profiles: Array<{ name: string; displayName: string }> };
}
async function emailKey(email: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  return 'email:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function emailBinding(email: string, name: string) {
  const key = await emailKey(email);
  const bindings = JSON.parse(env.ACCESS_PROFILE_BINDINGS || '{}');
  Object.assign(env, { ACCESS_PROFILE_BINDINGS: JSON.stringify({ ...bindings, [key]: name }) });
}
async function emailAddition(email: string, name: string) {
  const key = await emailKey(email);
  const additions = JSON.parse(env.ACCESS_PROFILE_BINDINGS_ADDITIONS || '{}');
  env.ACCESS_PROFILE_BINDINGS_ADDITIONS = JSON.stringify({ ...additions, [key]: name });
}
async function emailGrants(email: string, profiles: unknown) {
  const key = await emailKey(email);
  const grants = JSON.parse(env.ACCESS_PROFILE_GRANTS || '{}');
  Object.assign(env, { ACCESS_PROFILE_GRANTS: JSON.stringify({ ...grants, [key]: profiles }) });
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
    expect(await (await call('/api/browser/profiles/anil/targets', assertion)).json()).toEqual({ targets: [target('anil')], removedCuratedIds: null, removedCuratedUpdatedAt: null });
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
    expect(await (await call(path, assertion)).json()).toEqual({ targets: [target(name)], removedCuratedIds: null, removedCuratedUpdatedAt: null });
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
describe('private binding additions', () => {
  it('resolves a normalized signed email to its named profile and existing targets without writes', async () => {
    await emailAddition('pilot@example.com', 'pilot');
    const assertion = await jwt('pilot-id', ' PILOT@EXAMPLE.COM ', { name: 'Test Pilot' });
    records.set('profiles/pilot/targets.json', JSON.stringify([target('pilot')]));
    expect(await session(assertion)).toEqual({ ok: true, profile: { name: 'pilot', displayName: 'Test Pilot' },
      profiles: [{ name: 'pilot', displayName: 'Test Pilot' }] });
    expect(await (await call('/api/browser/profiles/pilot/targets', assertion)).json()).toEqual({
      targets: [target('pilot')], removedCuratedIds: null, removedCuratedUpdatedAt: null,
    });
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it('keeps base precedence and existing grants while additions grant no other profiles', async () => {
    await emailBinding('controller@example.com', 'controller');
    await emailAddition('controller@example.com', 'pilot');
    await emailAddition('pilot@example.com', 'pilot');
    await emailGrants('controller@example.com', [
      { name: 'controller', displayName: 'Ignored rename' }, { name: 'shared', displayName: 'Shared' },
    ]);
    await emailGrants('pilot@example.com', [{ name: 'pilot', displayName: 'Ignored rename' }]);
    const base = await jwt('controller-id', 'controller@example.com', { name: 'Controller' });
    const added = await jwt('pilot-id', 'pilot@example.com', { name: 'Test Pilot' });
    expect(await session(base)).toEqual({ ok: true, profile: { name: 'controller', displayName: 'Controller' },
      profiles: [{ name: 'controller', displayName: 'Controller' }, { name: 'shared', displayName: 'Shared' }] });
    expect(await session(added)).toEqual({ ok: true, profile: { name: 'pilot', displayName: 'Test Pilot' },
      profiles: [{ name: 'pilot', displayName: 'Test Pilot' }] });
    expect((await call('/api/browser/profiles/shared/targets', base)).status).toBe(200);
    expect((await call('/api/browser/profiles/pilot/targets', base)).status).toBe(403);
    expect((await call('/api/browser/profiles/shared/targets', added)).status).toBe(403);
  });
  it('keeps absent and empty maps compatible and unrelated accounts opaque', async () => {
    const ordinary = await session(await jwt());
    await emailBinding('controller@example.com', 'controller');
    await emailGrants('controller@example.com', [{ name: 'shared', displayName: 'Shared' }]);
    const base = await jwt('controller-id', 'controller@example.com', { name: 'Controller' });
    const expected = { ok: true, profile: { name: 'controller', displayName: 'Controller' },
      profiles: [{ name: 'controller', displayName: 'Controller' }, { name: 'shared', displayName: 'Shared' }] };
    expect(await session(base)).toEqual(expected);
    for (const value of ['', '{}']) {
      env.ACCESS_PROFILE_BINDINGS_ADDITIONS = value;
      expect(await session(base)).toEqual(expected);
      expect(await session(await jwt())).toEqual(ordinary);
    }
    await emailAddition('pilot@example.com', 'pilot');
    expect(await session(await jwt())).toEqual(ordinary);
    delete env.ACCESS_PROFILE_BINDINGS;
    env.ACCESS_PROFILE_BINDINGS = '';
    expect((await session(await jwt('pilot-id', 'pilot@example.com'))).profile.name).toBe('pilot');
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it('denies malformed additions for valid base callers before targets or ratings storage', async () => {
    await emailBinding('controller@example.com', 'controller');
    const assertion = await jwt('controller-id', 'controller@example.com');
    const unrelated = await emailKey('unrelated@example.com');
    const invalidValues: unknown[] = [null, 1, {}, [], '', 'Pilot', '../pilot', 'u-' + 'a'.repeat(28)];
    const invalidMaps = ['not-json', 'null', '[]', '1', 'true', '{"raw@example.com":"pilot"}', '{"email:bad":"pilot"}',
      ...invalidValues.map((value) => JSON.stringify({ [unrelated]: value }))];
    for (const value of invalidMaps) {
      env.ACCESS_PROFILE_BINDINGS_ADDITIONS = value;
      for (const path of ['/api/browser/session', '/api/browser/profiles/controller/targets', '/api/log']) {
        const response = await call(path, assertion);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'identity_configuration_unavailable' });
      }
      const write = await call('/api/log', assertion, 'POST', {
        target_id: 'test', pass_time: '2026-09-12T01:00:00Z', action: 'shoot',
      });
      expect(write.status).toBe(503);
      expect(await write.json()).toEqual({ error: 'identity_configuration_unavailable' });
    }
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled(); expect(bucket.list).not.toHaveBeenCalled();
  });
  it('still validates the complete base map and grants for an additions caller', async () => {
    await emailAddition('pilot@example.com', 'pilot');
    const assertion = await jwt('pilot-id', 'pilot@example.com');
    const unrelated = await emailKey('unrelated@example.com');
    env.ACCESS_PROFILE_BINDINGS = JSON.stringify({ [unrelated]: 'u-' + 'a'.repeat(28) });
    const baseDenied = await call('/api/browser/session', assertion);
    expect(baseDenied.status).toBe(503);
    expect(await baseDenied.json()).toEqual({ error: 'identity_configuration_unavailable' });
    delete env.ACCESS_PROFILE_BINDINGS;
    env.ACCESS_PROFILE_GRANTS = JSON.stringify({ [unrelated]: [{ name: 'shared' }] });
    const grantsDenied = await call('/api/browser/profiles/pilot/targets', assertion);
    expect(grantsDenied.status).toBe(503);
    expect(await grantsDenied.json()).toEqual({ error: 'identity_configuration_unavailable' });
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
  });
  it('permits owned target CRUD and denies ungranted profiles despite client identity headers', async () => {
    await emailAddition('pilot@example.com', 'pilot');
    const assertion = await jwt('pilot-id', 'pilot@example.com');
    const own = '/api/browser/profiles/pilot/targets';
    expect((await call(own, assertion, 'POST', target('pilot'))).status).toBe(200);
    expect(await (await call(own, assertion)).json()).toEqual({ targets: [target('pilot')],
      removedCuratedIds: null, removedCuratedUpdatedAt: null });
    expect((await call(own, assertion, 'PUT', { targets: [target('pilot')] })).status).toBe(200);
    expect((await call(`${own}/personal%3Apilot%3Atest`, assertion, 'DELETE')).status).toBe(200);
    expect(await (await call(own, assertion)).json()).toEqual({ targets: [], removedCuratedIds: null, removedCuratedUpdatedAt: null });
    vi.mocked(bucket.get).mockClear(); vi.mocked(bucket.put).mockClear();
    for (const prefix of ['/api/browser/profiles', '/api/profiles']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect((await call(`${prefix}/controller/targets${method === 'DELETE' ? '/personal%3Acontroller%3Atest' : ''}`,
          assertion, method, method === 'POST' ? target('controller') : method === 'PUT' ? { targets: [target('controller')] } : undefined,
          { 'cf-access-authenticated-user-email': 'controller@example.com', 'x-calib-token': 'legacy' })).status).toBe(403);
      }
    }
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
  });
  it('retains named rating ownership and separates dedupe from another account', async () => {
    await emailAddition('pilot@example.com', 'pilot');
    const assertion = await jwt('pilot-id', 'pilot@example.com');
    const body = { target_id: 'test', pass_time: '2026-09-12T01:00:00Z', action: 'shoot', dedupe_key: 'existing-pilot-photo' };
    expect(await (await call('/api/log', undefined, 'POST', { ...body, profile: 'pilot' },
      { 'x-calib-token': 'legacy' })).json()).toMatchObject({ ok: true, deduped: false });
    expect(await (await call('/api/log', assertion)).json()).toMatchObject({ entries: [{ profile: 'pilot' }], count: 1 });
    const newBody = { ...body, dedupe_key: 'new-pilot-photo' };
    expect(await (await call('/api/log', assertion, 'POST', newBody)).json()).toMatchObject({ ok: true, deduped: false });
    expect(await (await call('/api/log', assertion, 'POST', newBody)).json()).toMatchObject({ ok: true, deduped: true });
    expect(await (await call('/api/log?profile=pilot', assertion)).json()).toMatchObject({
      entries: [{ profile: 'pilot' }, { profile: 'pilot' }], count: 2,
    });
    vi.mocked(bucket.get).mockClear(); vi.mocked(bucket.put).mockClear(); vi.mocked(bucket.list).mockClear();
    expect((await call('/api/log?profile=controller', assertion)).status).toBe(403);
    expect((await call('/api/log', assertion, 'POST', { ...body, profile: 'controller' })).status).toBe(403);
    const other = await jwt('other-id', 'other@example.com');
    expect((await call('/api/log?profile=pilot', other)).status).toBe(403);
    expect((await call('/api/log', other, 'POST', { ...body, profile: 'pilot' })).status).toBe(403);
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled(); expect(bucket.list).not.toHaveBeenCalled();
  });
  it('keeps forged identities and cross-origin writes denied with additions configured', async () => {
    await emailAddition('pilot@example.com', 'pilot');
    const assertion = await jwt('pilot-id', 'pilot@example.com');
    expect((await call('/api/browser/session', undefined, 'GET', undefined,
      { 'cf-access-authenticated-user-email': 'pilot@example.com', 'x-calib-token': 'legacy' })).status).toBe(401);
    for (const forged of ['forged', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJwaWxvdC1pZCJ9.',
      await jwt('pilot-id', 'pilot@example.com', { exp: 1 })]) {
      expect((await call('/api/browser/session', forged)).status).toBe(401);
    }
    for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect((await call('/api/browser/profiles/pilot/targets', assertion, 'POST', target('pilot'), headers)).status).toBe(403);
      expect((await call('/api/log', assertion, 'POST', {
        target_id: 'test', pass_time: '2026-09-12T01:00:00Z', action: 'shoot',
      }, headers)).status).toBe(403);
    }
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled(); expect(bucket.list).not.toHaveBeenCalled();
  });
});
describe('explicit delegated profiles', () => {
  const jessica = { name: 'jessica', displayName: 'Jessica Meir' };
  async function owner() {
    await emailBinding('owner@example.com', 'anil');
    await emailGrants(' OWNER@EXAMPLE.COM ', [jessica]);
    return jwt('owner-id', 'owner@example.com', { name: 'Anil' });
  }
  it('suggests only the caller grants, own profile first, without disclosing private identities', async () => {
    const assertion = await owner();
    await emailGrants('other@example.com', [{ name: 'jack', displayName: 'Jack' }]);
    const result = await session(assertion);
    expect(result).toEqual({ ok: true, profile: { name: 'anil', displayName: 'Anil' },
      profiles: [{ name: 'anil', displayName: 'Anil' }, jessica] });
    expect(JSON.stringify(result)).not.toMatch(/@|email:|owner-id|eyJ|jack/);
    const ordinary = await session(await jwt());
    expect(ordinary.profiles).toEqual([ordinary.profile]);
    expect(JSON.stringify(ordinary)).not.toContain('Jessica Meir');
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
  });
  it('ignores a redundant own-profile grant without renaming the account', async () => {
    const assertion = await owner();
    await emailGrants('owner@example.com', [{ name: 'anil', displayName: 'Renamed' }, jessica]);
    expect((await session(assertion)).profiles).toEqual([{ name: 'anil', displayName: 'Anil' }, jessica]);
  });
  it('allows granted target CRUD and rejects ungranted names or forged identity headers before storage', async () => {
    const assertion = await owner();
    for (const prefix of ['/api/browser/profiles', '/api/profiles']) {
      const path = `${prefix}/jessica/targets`;
      expect((await call(path, assertion, 'POST', target('jessica'))).status).toBe(200);
      expect(await (await call(path, assertion)).json()).toEqual({ targets: [target('jessica')], removedCuratedIds: null, removedCuratedUpdatedAt: null });
      expect((await call(path, assertion, 'PUT', { targets: [target('jessica')] })).status).toBe(200);
      expect((await call(`${path}/personal%3Ajessica%3Atest`, assertion, 'DELETE')).status).toBe(200);
      expect(await (await call(path, assertion)).json()).toEqual({ targets: [], removedCuratedIds: null, removedCuratedUpdatedAt: null });
    }
    vi.mocked(bucket.get).mockClear(); vi.mocked(bucket.put).mockClear();
    for (const [token, name] of [[assertion, 'jack'], [await jwt(), 'jessica']]) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect((await call(`/api/browser/profiles/${name}/targets${method === 'DELETE' ? `/personal%3A${name}%3Atest` : ''}`,
          token, method, method === 'POST' ? target(name!) : method === 'PUT' ? { targets: [target(name!)] } : undefined,
          { 'cf-access-authenticated-user-email': 'owner@example.com', 'x-calib-token': 'legacy' })).status).toBe(403);
      }
    }
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
  });
  it('keeps target ownership and same-origin write rules on delegated profiles', async () => {
    const assertion = await owner();
    expect((await call('/api/browser/profiles/jessica/targets', assertion, 'POST', target('anil'))).status).toBe(400);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await call('/api/browser/profiles/jessica/targets', assertion, method, target('jessica'),
        { origin: 'https://evil.example' })).status).toBe(403);
    }
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
  });
  it('fails closed on malformed grant configuration, including unrelated account entries', async () => {
    const assertion = await owner();
    const key = await emailKey('unrelated@example.com');
    const invalidProfiles: unknown[] = [null, {}, 'jessica', [null], [{ name: 'jessica' }], [{ name: 'Jessica', displayName: 'Jessica' }],
      [{ name: '../anil', displayName: 'Jessica' }], [{ name: 'jessica', displayName: '' }], [{ name: 'jessica', displayName: ' Jessica' }],
      [{ name: 'jessica', displayName: 'Jessica\nMeir' }], [{ name: 'jessica', displayName: 'jessica@example.com' }],
      [{ name: 'jessica', displayName: 'x'.repeat(61) }], [{ ...jessica, email: 'jessica@example.com' }], [jessica, jessica],
      Array.from({ length: 33 }, (_, i) => ({ name: `person-${i}`, displayName: `Person ${i}` }))];
    for (const config of ['not-json', 'null', '[]', '{"raw@example.com":[]}', '{"email:bad":[]}',
      ...invalidProfiles.map((profiles) => JSON.stringify({ [key]: profiles }))]) {
      env.ACCESS_PROFILE_GRANTS = config;
      expect((await call('/api/browser/session', assertion)).status).toBe(503);
      expect((await call('/api/browser/profiles/anil/targets', assertion)).status).toBe(503);
      expect((await call('/api/log', assertion)).status).toBe(503);
    }
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled(); expect(bucket.list).not.toHaveBeenCalled();
  });
  it('requires current grants on each request and leaves machine access compatible', async () => {
    const assertion = await owner();
    expect((await call('/api/browser/profiles/jessica/targets', assertion)).status).toBe(200);
    delete env.ACCESS_PROFILE_GRANTS;
    expect((await call('/api/browser/profiles/jessica/targets', assertion)).status).toBe(403);
    expect((await session(assertion)).profiles).toEqual([{ name: 'anil', displayName: 'Anil' }]);
    env.ACCESS_PROFILE_GRANTS = 'malformed';
    expect((await call('/api/profiles/jessica/targets', undefined, 'GET', undefined, { 'x-calib-token': 'legacy' })).status).toBe(200);
  });
  it('scopes granted ratings explicitly while omitted profile keeps the account default and dedupe stays separate', async () => {
    const assertion = await owner();
    const body = { target_id: 'test', pass_time: '2026-09-12T01:00:00Z', action: 'shoot', dedupe_key: 'same-photo' };
    expect(await (await call('/api/log', assertion, 'POST', body)).json()).toMatchObject({ ok: true, deduped: false });
    expect(await (await call('/api/log', assertion, 'POST', { ...body, profile: 'jessica' })).json()).toMatchObject({ ok: true, deduped: false });
    expect(await (await call('/api/log', assertion, 'POST', { ...body, profile: 'jessica' })).json()).toMatchObject({ ok: true, deduped: true });
    expect(await (await call('/api/log', assertion)).json()).toMatchObject({ entries: [{ profile: 'anil' }], count: 1 });
    expect(await (await call('/api/log?profile=jessica', assertion)).json()).toMatchObject({ entries: [{ profile: 'jessica' }], count: 1 });
    vi.mocked(bucket.get).mockClear(); vi.mocked(bucket.put).mockClear(); vi.mocked(bucket.list).mockClear();
    for (const [token, profile] of [[assertion, 'jack'], [await jwt(), 'jessica']]) {
      expect((await call(`/api/log?profile=${profile}`, token)).status).toBe(403);
      expect((await call('/api/log', token, 'POST', { ...body, profile })).status).toBe(403);
    }
    expect(bucket.get).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled(); expect(bucket.list).not.toHaveBeenCalled();
  });
  it('reads legacy logs for a named grant even when the caller own profile is opaque', async () => {
    await emailGrants('jessica@example.com', [jessica]);
    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    records.set(`log/${month}/legacy-jessica.json`, JSON.stringify({ profile: 'jessica', target_id: 'legacy' }));
    records.set(`log/${month}/legacy-anil.json`, JSON.stringify({ profile: 'anil', target_id: 'foreign' }));
    expect(await (await call('/api/log?profile=jessica', await jwt())).json()).toMatchObject({ entries: [{ profile: 'jessica', target_id: 'legacy' }], count: 1 });
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
