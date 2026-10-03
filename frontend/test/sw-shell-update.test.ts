import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppShellHandler, createAppShellMatcher, NAVIGATION_FALLBACK_DENYLIST } from '../src/sw-navigation';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function memoryCaches() {
  const entries = new Map<string, string>();
  const cache = {
    async put(request: string | Request, response: Response) {
      const key = typeof request === 'string' ? request : new URL(request.url).pathname;
      entries.set(key, await response.clone().text());
    },
    async match(request: string | Request) {
      const key = typeof request === 'string' ? request : new URL(request.url).pathname;
      const body = entries.get(key);
      if (body === undefined) return undefined;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  };
  return { entries, open: async () => cache };
}

describe('app shell navigations', () => {
  const matcher = createAppShellMatcher(NAVIGATION_FALLBACK_DENYLIST);

  it.each(['/', '/?u=anil', '/anil', '/anil?tab=map'])('claims %s for the fresh shell', (path) => {
    const url = new URL(path, 'https://map.astroanil.dev');
    expect(matcher({ request: { mode: 'navigate' }, url })).toBe(true);
  });

  it.each([
    '/api/app?u=jessica',
    '/cdn-cgi/access/login',
    '/profile-research/jessica.html',
    '/launch/latest.json',
    '/v/20260101T000000Z/track.json',
    '/manifest.json',
    '/__opd_probe',
  ])('leaves %s on the network', (path) => {
    const url = new URL(path, 'https://map.astroanil.dev');
    expect(matcher({ request: { mode: 'navigate' }, url })).toBe(false);
  });

  it('ignores asset fetches', () => {
    expect(matcher({
      request: { mode: 'no-cors' },
      url: { pathname: '/assets/index-abc.js', search: '' },
    })).toBe(false);
  });
});

describe('app shell handler', () => {
  const previousFetch = globalThis.fetch;
  const previousCaches = globalThis.caches;
  const previousRequest = globalThis.Request;
  const handler = createAppShellHandler();

  afterEach(() => {
    globalThis.fetch = previousFetch;
    globalThis.caches = previousCaches;
    globalThis.Request = previousRequest;
  });

  it('loads the current index.html and bypasses a fresh HTTP cache entry', async () => {
    const seen: Array<{ url: string; cache?: RequestCache }> = [];
    const RealRequest = previousRequest;
    globalThis.Request = class extends RealRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init);
        seen.push({ url: this.url, cache: init?.cache });
      }
    };
    const bucket = memoryCaches();
    globalThis.caches = { open: bucket.open } as unknown as CacheStorage;
    globalThis.fetch = (async () => new Response('<html>BUILD 2</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;
    const navigation = new RealRequest('https://map.astroanil.dev/anil?tab=map');
    const response = await handler({ request: navigation });
    expect(await response.text()).toBe('<html>BUILD 2</html>');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cache).toBe('reload');
    expect(new URL(seen[0]!.url).pathname).toBe('/');
    expect(bucket.entries.get('/')).toBe('<html>BUILD 2</html>');
  });

  it('serves the last good shell when the network fails after a previous deploy', async () => {
    const bucket = memoryCaches();
    bucket.entries.set('/', '<html>BUILD 1</html>');
    globalThis.caches = { open: bucket.open } as unknown as CacheStorage;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const response = await handler({ request: new Request('https://map.astroanil.dev/?u=anil') });
    expect(await response.text()).toBe('<html>BUILD 1</html>');
  });

  it('is the source the generated worker inlines', () => {
    const source = handler.toString();
    expect(source).toContain('opd-shell');
    expect(source).toContain("cache: 'reload'");
    const shell = readFileSync(resolve(root, 'public/sw-shell.js'), 'utf8');
    expect(shell).toContain("caches.open('opd-shell')");
    expect(shell).toContain("cache: 'reload'");
    expect(shell).toContain('clients.claim');
    expect(shell).toContain('client.navigate');
    expect(shell).toContain('setTimeout');
    const register = readFileSync(resolve(root, 'public/registerSW.js'), 'utf8');
    expect(register).toContain("updateViaCache: 'none'");
    expect(register).toContain('registration.update()');
  });
});
