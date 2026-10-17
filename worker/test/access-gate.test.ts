import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Env } from '../src/index';

const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'map-audience';
const hosts = ['map.astroanil.dev', 'map.expedition75.com'] as const;
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
    expect(url).toBe(`${issuer}/cdn-cgi/access/certs`);
    return new Response(jwks, { headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: 'pyotr',
    email: 'realvr@gmail.com',
    iss: issuer,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'gate-key' }).sign(pair.privateKey);
}

function site(objects: Record<string, string>, failOnRead = false) {
  const reads: string[] = [];
  const bucket = {
    reads,
    async get(key: string) {
      reads.push(key);
      if (failOnRead) throw new Error('storage should stay closed');
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
  return bucket;
}

function envFor(objects: Record<string, string>, failOnRead = false): Env {
  const bucket = site(objects, failOnRead);
  return {
    SITE: bucket,
    CALIB: bucket,
    CALIB_TOKEN: 'machine-secret',
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: audience,
    STALE_THRESHOLD_SECONDS: '7200',
  } as unknown as Env;
}

async function call(host: string, path: string, jwt?: string, extra: Record<string, string> = {}) {
  const worker = (await import('../src/index')).default;
  const headers = new Headers(extra);
  if (jwt) headers.set('cf-access-jwt-assertion', jwt);
  return worker.fetch(new Request(`https://${host}${path}`, { headers }), envFor(
    {
      'sw.js': 'self.skipWaiting()',
      'v/demo/passes.json': '{"passes":[]}',
      'index.html': '<html><head><title>SNAP</title></head><body>map</body></html>',
    },
    jwt === undefined,
  ), {} as ExecutionContext);
}

describe('map Access gate', () => {
  it('denies an asset and a data path with no JWT and does not read storage', async () => {
    for (const host of hosts) {
      const asset = await call(host, '/sw.js');
      const data = await call(host, '/v/demo/passes.json');
      expect(asset.status).toBe(401);
      expect(data.status).toBe(401);
      expect(await asset.json()).toEqual({ error: 'unauthorized' });
      expect(await data.json()).toEqual({ error: 'unauthorized' });
      expect(asset.headers.get('location')).toBeNull();
      expect(data.headers.get('location')).toBeNull();
    }
  });

  it('denies a machine token on a gated path', async () => {
    const response = await call('map.expedition75.com', '/sw.js', undefined, { 'x-calib-token': 'machine-secret' });
    expect(response.status).toBe(401);
  });

  it('denies an expired JWT and a JWT for another audience', async () => {
    const expired = await call('map.astroanil.dev', '/sw.js', await token({ exp: 1 }));
    const other = await call('map.expedition75.com', '/v/demo/passes.json', await token({ aud: 'other-app' }));
    expect(expired.status).toBe(401);
    expect(other.status).toBe(401);
  });

  it('serves the same object on either host for one valid audience', async () => {
    const jwt = await token();
    for (const host of hosts) {
      const asset = await call(host, '/sw.js', jwt);
      const data = await call(host, '/v/demo/passes.json', jwt);
      const page = await call(host, '/', jwt);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe('self.skipWaiting()');
      expect(data.status).toBe(200);
      expect(await data.json()).toEqual({ passes: [] });
      expect(page.status).toBe(200);
      expect(await page.text()).not.toContain('og:url');
      expect(page.headers.get('location')).toBeNull();
      for (const response of [asset, data, page]) {
        const location = response.headers.get('location') ?? '';
        expect(location).not.toContain('map.astroanil.dev');
        expect(location).not.toContain('map.expedition75.com');
      }
    }
  });

  it('keeps the profile machine path open and echoes the second map origin', async () => {
    const worker = (await import('../src/index')).default;
    const bucket = site({});
    const env = {
      SITE: bucket,
      CALIB: bucket,
      CALIB_TOKEN: 'machine-secret',
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUD: audience,
      STALE_THRESHOLD_SECONDS: '7200',
    } as unknown as Env;
    const profiles = await worker.fetch(new Request('https://map.expedition75.com/api/profiles/anil/targets', {
      headers: { 'x-calib-token': 'machine-secret' },
    }), env, {} as ExecutionContext);
    expect(profiles.status).toBe(200);
    expect(await profiles.json()).toMatchObject({ targets: [] });
    const denied = await worker.fetch(new Request('https://map.expedition75.com/sw.js', {
      headers: { origin: 'https://map.expedition75.com' },
    }), env, {} as ExecutionContext);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('access-control-allow-origin')).toBe('https://map.expedition75.com');
  });
});
