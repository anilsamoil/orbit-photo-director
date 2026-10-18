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

function envFor(): Env {
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
  return {
    SITE: bucket,
    CALIB: bucket,
    CALIB_TOKEN: calibToken,
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: audience,
    ACCESS_SERVICE_TOKEN_CLIENT_IDS: serviceClientId,
    STALE_THRESHOLD_SECONDS: '7200',
  } as unknown as Env;
}

async function call(host: string, path: string, headers: Record<string, string> = {}, method = 'GET') {
  const worker = (await import('../../../../worker/src/index.ts')).default;
  return worker.fetch(new Request(`https://${host}${path}`, { method, headers }), envFor(), {} as ExecutionContext);
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

  it('serves a page and health for an allowed map JWT on both hosts', async () => {
    const jwt = await token();
    for (const host of hosts) {
      const page = await call(host, '/', { 'cf-access-jwt-assertion': jwt });
      const health = await call(host, '/api/health', { 'cf-access-jwt-assertion': jwt });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('map');
      expect(page.headers.get('location')).toBeNull();
      expect(health.status).toBe(200);
      expect(health.headers.get('location')).toBeNull();
    }
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
      const service = await call(host, '/api/profiles/anil/targets', {
        'cf-access-jwt-assertion': await serviceToken(serviceClientId),
      });
      expect(service.status).toBe(401);
    }
  });
});
