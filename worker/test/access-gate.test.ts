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
    email: 'alice@example.com',
    iss: issuer,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'gate-key' }).sign(pair.privateKey);
}

async function serviceToken(commonName: string, overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    iss: issuer,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    common_name: commonName,
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
    ACCESS_ALLOWED_EMAILS: 'alice@example.com,bob@example.com',
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

  it('accepts an allowlisted service token only on health', async () => {
    const manifest = JSON.stringify({
      version: 'verify',
      generated_at: new Date().toISOString(),
      freshness: { tle_hours: 1, cloud_hours: 1, ok: true },
    });
    const worker = (await import('../src/index')).default;
    const bucket = site({
      'manifest.json': manifest,
      'index.html': '<html>map</html>',
      'sw.js': 'self.skipWaiting()',
      'v/demo/passes.json': '{"passes":[]}',
    });
    const env = {
      SITE: bucket,
      CALIB: bucket,
      CALIB_TOKEN: 'machine-secret',
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUD: audience,
      ACCESS_SERVICE_TOKEN_CLIENT_IDS: 'uptime-robot, other-monitor',
      ACCESS_ALLOWED_EMAILS: 'alice@example.com,bob@example.com',
      STALE_THRESHOLD_SECONDS: '7200',
    } as unknown as Env;
    const allowed = await serviceToken('uptime-robot');
    const health = await worker.fetch(new Request('https://map.astroanil.dev/api/health', {
      headers: { 'cf-access-jwt-assertion': allowed },
    }), env, {} as ExecutionContext);
    expect(health.status).toBe(200);
    for (const path of ['/', '/sw.js', '/v/demo/passes.json']) {
      const denied = await worker.fetch(new Request(`https://map.expedition75.com${path}`, {
        headers: { 'cf-access-jwt-assertion': allowed },
      }), env, {} as ExecutionContext);
      expect(denied.status).toBe(401);
    }
    const unknown = await worker.fetch(new Request('https://map.astroanil.dev/api/health', {
      headers: { 'cf-access-jwt-assertion': await serviceToken('not-on-the-list') },
    }), env, {} as ExecutionContext);
    expect(unknown.status).toBe(401);
    const human = await worker.fetch(new Request('https://map.expedition75.com/api/health', {
      headers: { 'cf-access-jwt-assertion': await token() },
    }), env, {} as ExecutionContext);
    expect(human.status).toBe(200);
    const anonymous = await worker.fetch(new Request('https://map.astroanil.dev/api/health', {
      headers: { 'x-calib-token': 'machine-secret' },
    }), env, {} as ExecutionContext);
    expect(anonymous.status).toBe(401);
    const expired = await worker.fetch(new Request('https://map.astroanil.dev/api/health', {
      headers: { 'cf-access-jwt-assertion': await serviceToken('uptime-robot', { exp: 1 }) },
    }), env, {} as ExecutionContext);
    expect(expired.status).toBe(401);
  });
});

function allowEnv(emails?: string, extra: Record<string, string> = {}): Env {
  const bucket = site({
    'sw.js': 'self.skipWaiting()',
    'index.html': '<html>map</html>',
    'manifest.json': JSON.stringify({
      version: 'verify',
      generated_at: new Date().toISOString(),
      freshness: { tle_hours: 1, cloud_hours: 1, ok: true },
    }),
  });
  const env: Record<string, unknown> = {
    SITE: bucket,
    CALIB: bucket,
    CALIB_TOKEN: 'machine-secret',
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: audience,
    STALE_THRESHOLD_SECONDS: '7200',
    ...extra,
  };
  if (emails !== undefined) env.ACCESS_ALLOWED_EMAILS = emails;
  return env as unknown as Env;
}

async function allowFetch(path: string, env: Env, jwt?: string, extra: Record<string, string> = {}) {
  const worker = (await import('../src/index')).default;
  const headers = new Headers(extra);
  if (jwt) headers.set('cf-access-jwt-assertion', jwt);
  return worker.fetch(new Request(`https://map.astroanil.dev${path}`, { headers }), env, {} as ExecutionContext);
}

describe('email allowlist', () => {
  it('admits a listed mailbox on a gated path and rejects a different mailbox', async () => {
    const env = allowEnv('person@example.com');
    const allowed = await allowFetch('/sw.js', env, await token({ email: 'person@example.com' }));
    expect(allowed.status).toBe(200);
    const denied = await allowFetch('/sw.js', env, await token({ email: 'other@example.com' }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'email_not_allowlisted' });
  });

  it('matches trim and case on the claim and the list, and rejects a longer suffix', async () => {
    const spacedList = allowEnv(' person@example.com ');
    const cased = await allowFetch('/sw.js', spacedList, await token({ email: 'Person@Example.com' }));
    expect(cased.status).toBe(200);
    const spacedClaim = await allowFetch('/sw.js', allowEnv('person@example.com'), await token({ email: ' person@example.com ' }));
    expect(spacedClaim.status).toBe(200);
    const evil = await allowFetch('/sw.js', spacedList, await token({ email: 'person@example.com.evil' }));
    expect(evil.status).toBe(403);
    expect(await evil.json()).toEqual({ error: 'email_not_allowlisted' });
    const neighbor = await allowFetch('/sw.js', spacedList, await token({ email: 'notperson@example.com' }));
    expect(neighbor.status).toBe(403);
    expect(await neighbor.json()).toEqual({ error: 'email_not_allowlisted' });
  });

  it('returns 403 for a human when the list is empty, unset, or only commas and whitespace', async () => {
    const lists: Array<string | undefined> = ['', '   ', ',', ' , ', undefined];
    for (const emails of lists) {
      const env = emails === undefined ? allowEnv() : allowEnv(emails);
      for (const path of ['/sw.js', '/api/health']) {
        const response = await allowFetch(path, env, await token({ email: 'person@example.com' }));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'email_not_allowlisted' });
      }
    }
  });

  it('keeps service health and machine profiles when the email list is empty, and does not fall through to common_name', async () => {
    const empty = allowEnv('', { ACCESS_SERVICE_TOKEN_CLIENT_IDS: 'uptime-robot' });
    const human = await allowFetch('/api/health', empty, await token({ email: 'person@example.com' }));
    expect(human.status).toBe(403);
    expect(await human.json()).toEqual({ error: 'email_not_allowlisted' });
    const health = await allowFetch('/api/health', empty, await serviceToken('uptime-robot'));
    expect(health.status).toBe(200);
    const profiles = await allowFetch('/api/profiles/anil/targets', allowEnv(''), undefined, { 'x-calib-token': 'machine-secret' });
    expect(profiles.status).toBe(200);
    const borrowed = await allowFetch('/api/health', allowEnv('person@example.com', {
      ACCESS_SERVICE_TOKEN_CLIENT_IDS: 'uptime-robot',
    }), await token({ email: 'other@example.com', common_name: 'uptime-robot' }));
    expect(borrowed.status).toBe(403);
    expect(await borrowed.json()).toEqual({ error: 'email_not_allowlisted' });
  });
});
