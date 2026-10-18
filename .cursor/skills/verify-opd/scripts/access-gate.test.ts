import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Env } from '../../../../worker/src/index';

const issuer = 'https://verify-team.cloudflareaccess.com';
const audience = 'map-audience';
const hosts = ['map.astroanil.dev', 'map.expedition75.com'] as const;
const allowedEmail = 'allowed-one@example.test';
const offListEmail = 'off-list@example.test';
const serviceClientId = 'monitor-one';
const calibToken = 'machine-secret';

let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: string;

beforeAll(async () => {
  pair = await generateKeyPair('RS256');
  jwks = JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'gate-key' }] });
});

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== `${issuer}/cdn-cgi/access/certs`) {
      throw new Error(`unexpected fetch ${url}`);
    }
    return new Response(jwks, { headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: 'crew-allowed-one',
    email: allowedEmail,
    iss: issuer,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'gate-key' }).sign(pair.privateKey);
}

async function serviceToken(commonName: string) {
  return new SignJWT({
    iss: issuer,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    common_name: commonName,
  }).setProtectedHeader({ alg: 'RS256', kid: 'gate-key' }).sign(pair.privateKey);
}

function site(objects: Record<string, string>) {
  return {
    async get(key: string) {
      const body = objects[key];
      if (body === undefined) return null;
      return {
        body,
        text: async () => body,
        json: async () => JSON.parse(body),
        httpEtag: `"${key}"`,
        httpMetadata: {},
      };
    },
    async put() {
      return { key: 'unused' };
    },
    async list() {
      return { objects: [] };
    },
  };
}

const syntheticAllowlist = allowedEmail;
const gatedPaths = ['/', '/sw.js', '/api/health'] as const;

function envFor(emails: string | null = syntheticAllowlist, clientIds: string | null = serviceClientId): Env {
  const manifest = JSON.stringify({
    version: 'verify',
    generated_at: new Date().toISOString(),
    freshness: { tle_hours: 1, cloud_hours: 1, ok: true },
  });
  const bucket = site({
    'index.html': '<html><head><title>SNAP</title></head><body>map</body></html>',
    'sw.js': 'self.skipWaiting()',
    'manifest.json': manifest,
    'v/demo/passes.json': '{"passes":[]}',
  });
  const env: Record<string, unknown> = {
    SITE: bucket,
    CALIB: bucket,
    CALIB_TOKEN: calibToken,
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: audience,
    STALE_THRESHOLD_SECONDS: '7200',
  };
  if (emails !== null) env.ACCESS_ALLOWED_EMAILS = emails;
  if (clientIds !== null) env.ACCESS_SERVICE_TOKEN_CLIENT_IDS = clientIds;
  return env as unknown as Env;
}

async function call(
  host: string,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  emails: string | null = syntheticAllowlist,
  clientIds: string | null = serviceClientId,
) {
  const worker = (await import('../../../../worker/src/index.ts')).default;
  return worker.fetch(
    new Request(`https://${host}${path}`, { method, headers }),
    envFor(emails, clientIds),
    {} as ExecutionContext,
  );
}

describe('local map Access gate', () => {
  it('returns 401 with no JWT and leaves preflight open on both hosts', async () => {
    for (const host of hosts) {
      for (const path of ['/', '/sw.js', '/api/health', '/api/profiles', '/api/profiles/anil/targets']) {
        const denied = await call(host, path);
        expect(denied.status).toBe(401);
        expect(await denied.json()).toEqual({ error: 'unauthorized' });
        expect(denied.headers.get('location')).toBeNull();
      }
      const preflight = await call(host, '/api/health', { origin: `https://${host}` }, 'OPTIONS');
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(`https://${host}`);
    }
  });

  it('serves gated paths for allowed-one on both hosts', async () => {
    const jwt = await token();
    for (const host of hosts) {
      for (const path of gatedPaths) {
        const response = await call(host, path, { 'cf-access-jwt-assertion': jwt });
        expect(response.status, `${host} ${path}`).toBe(200);
        expect(response.headers.get('location')).toBeNull();
        if (path === '/') expect(await response.text()).toContain('map');
      }
    }
  });

  it('returns 403 email_not_allowlisted for off-list on /, /sw.js, and /api/health', async () => {
    const jwt = await token({ email: offListEmail, sub: 'crew-off-list' });
    for (const host of hosts) {
      for (const path of gatedPaths) {
        const denied = await call(host, path, { 'cf-access-jwt-assertion': jwt });
        expect(denied.status, `${host} ${path}`).toBe(403);
        expect(await denied.json()).toEqual({ error: 'email_not_allowlisted' });
        expect(denied.headers.get('location')).toBeNull();
      }
    }
  });

  it('returns 403 for every human when the allowlist is empty, unset, or Unicode-blank', async () => {
    const humans = [
      await token(),
      await token({ email: offListEmail, sub: 'crew-off-list' }),
    ];
    const lists: Array<string | null> = ['', null, '\uFEFF', '\u00A0', '\uFEFF,\u00A0'];
    for (const emails of lists) {
      for (const host of hosts) {
        for (const jwt of humans) {
          for (const path of gatedPaths) {
            const denied = await call(host, path, { 'cf-access-jwt-assertion': jwt }, 'GET', emails);
            expect(denied.status, `${JSON.stringify(emails)} ${host} ${path}`).toBe(403);
            expect(await denied.json()).toEqual({ error: 'email_not_allowlisted' });
          }
        }
      }
    }
    const service = { 'cf-access-jwt-assertion': await serviceToken(serviceClientId) };
    const health = await call(hosts[0], '/api/health', service, 'GET', '');
    expect(health.status).toBe(200);
    const page = await call(hosts[0], '/', service, 'GET', null);
    expect(page.status).toBe(401);
  });

  it('accepts an allowlisted service token only on exact /api/health', async () => {
    const allowed = await serviceToken(serviceClientId);
    const headers = { 'cf-access-jwt-assertion': allowed };
    for (const host of hosts) {
      const health = await call(host, '/api/health', headers);
      const head = await call(host, '/api/health', headers, 'HEAD');
      const queried = await call(host, '/api/health?probe=1', headers);
      expect(health.status).toBe(200);
      expect(head.status).toBe(200);
      expect(queried.status).toBe(200);
      for (const path of ['/', '/sw.js', '/api/health/', '/api/health/extra', '/v/demo/passes.json', '/api/profiles/anil/targets']) {
        const denied = await call(host, path, headers);
        expect(denied.status, `${host} ${path}`).toBe(401);
      }
      const offList = await call(host, '/api/health', {
        'cf-access-jwt-assertion': await serviceToken(offListEmail),
      });
      expect(offList.status).toBe(401);
      const machine = await call(host, '/api/health', { 'x-calib-token': calibToken });
      expect(machine.status).toBe(401);
    }
  });

  it('keeps /api/health human-only on both hosts when the service client id list is empty', async () => {
    const service = { 'cf-access-jwt-assertion': await serviceToken(serviceClientId) };
    const human = { 'cf-access-jwt-assertion': await token() };
    for (const clientIds of ['', null] as const) {
      for (const host of hosts) {
        const health = await call(host, '/api/health', service, 'GET', syntheticAllowlist, clientIds);
        expect(health.status, `${JSON.stringify(clientIds)} ${host} service`).toBe(401);
        expect(await health.json()).toEqual({ error: 'unauthorized' });
        expect(health.headers.get('location')).toBeNull();
        const humanHealth = await call(host, '/api/health', human, 'GET', syntheticAllowlist, clientIds);
        expect(humanHealth.status, `${JSON.stringify(clientIds)} ${host} human`).toBe(200);
        const profiles = await call(host, '/api/profiles', {}, 'GET', syntheticAllowlist, clientIds);
        expect(profiles.status, `${host} profiles`).toBe(401);
        expect(await profiles.json()).toEqual({ error: 'unauthorized' });
        expect(profiles.headers.get('location')).toBeNull();
        const page = await call(host, '/', {}, 'GET', syntheticAllowlist, clientIds);
        expect(page.status, `${host} page`).toBe(401);
        expect(page.headers.get('location')).toBeNull();
      }
    }
  });

  it('requires the calib token on /api/profiles and does not treat a map JWT as that token', async () => {
    const jwt = await token({ email: allowedEmail });
    for (const host of hosts) {
      const missing = await call(host, '/api/profiles/anil/targets');
      const exact = await call(host, '/api/profiles');
      expect(missing.status).toBe(401);
      expect(exact.status).toBe(401);
      const opened = await call(host, '/api/profiles/anil/targets', { 'x-calib-token': calibToken });
      expect(opened.status).toBe(200);
      expect(await opened.json()).toMatchObject({ targets: [] });
      const signedIn = await call(host, '/api/profiles/anil/targets', { 'cf-access-jwt-assertion': jwt });
      expect(signedIn.status).toBe(403);
      expect(await signedIn.json()).toEqual({ error: 'profile_forbidden' });
      const service = await call(host, '/api/profiles/anil/targets', {
        'cf-access-jwt-assertion': await serviceToken(serviceClientId),
      });
      expect(service.status).toBe(401);
    }
  });
});
