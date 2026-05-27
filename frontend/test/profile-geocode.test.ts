/** v3 — Component B (Anil 2026-05-26). Geocoding helper unit tests.
 *
 *  Covers:
 *    - happy path: Nominatim response normalizes correctly
 *    - cache hit: second call with same query never re-fetches
 *    - cache TTL: expired entry refetches
 *    - 4xx / 5xx response surfaces as `http`
 *    - network throw surfaces as `network`
 *    - bad JSON surfaces as `bad_json`
 *    - timeout (AbortController) surfaces as `timeout`
 *    - empty/whitespace query short-circuits with `empty_query`
 *    - empty Nominatim array returns ok with []
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _clearGeocodeCacheForTest, geocode } from '../src/profile-geocode';

function makeNominatimHit(over: Record<string, unknown> = {}) {
  return {
    lat: '32.7157',
    lon: '-117.1611',
    display_name: 'San Diego, San Diego County, California, USA',
    address: {
      city: 'San Diego',
      country: 'United States',
      country_code: 'us',
    },
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  _clearGeocodeCacheForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  localStorage.clear();
  _clearGeocodeCacheForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('geocode — happy path', () => {
  it('normalizes the Nominatim response to GeocodeResult[]', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([makeNominatimHit()]), { status: 200 }),
    ));
    const r = await geocode('San Diego');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    expect(r.data[0]!.lat).toBeCloseTo(32.7157, 3);
    expect(r.data[0]!.lon).toBeCloseTo(-117.1611, 3);
    expect(r.data[0]!.shortName).toBe('San Diego');
    expect(r.data[0]!.country).toBe('United States');
    expect(r.data[0]!.displayName).toContain('San Diego County');
  });

  it('uses the Nominatim /search endpoint with the expected query string', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await geocode('Mount Etna');
    expect(fetchMock).toHaveBeenCalledOnce();
    const calls = fetchMock.mock.calls as unknown[][];
    const url = calls[0]![0] as string;
    expect(url).toContain('nominatim.openstreetmap.org/search');
    expect(url).toContain('q=Mount+Etna');
    expect(url).toContain('format=json');
    expect(url).toContain('limit=5');
    expect(url).toContain('addressdetails=1');
  });

  it('falls back to display_name first segment when address.city is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([makeNominatimHit({
        display_name: 'Some Remote Outpost, Nowhere, Antarctica',
        address: { country: 'Antarctica' },  // no city/town
      })]), { status: 200 }),
    ));
    const r = await geocode('outpost');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0]!.shortName).toBe('Some Remote Outpost');
  });

  it('drops entries with non-finite lat/lon', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([
        makeNominatimHit(),
        makeNominatimHit({ lat: 'NaN' }),
        makeNominatimHit({ lon: 'not-a-number' }),
      ]), { status: 200 }),
    ));
    const r = await geocode('mixed');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
  });
});

describe('geocode — cache', () => {
  it('returns the cached result without a second fetch', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([makeNominatimHit()]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await geocode('San Diego');
    expect(fetchMock).toHaveBeenCalledOnce();
    await geocode('San Diego');
    expect(fetchMock).toHaveBeenCalledOnce(); // no second call
  });

  it('cache hit is case-insensitive (lowercased key)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([makeNominatimHit()]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await geocode('San Diego');
    await geocode('SAN DIEGO');
    await geocode('san diego');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('expired entries (>24h) are refetched', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([makeNominatimHit()]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await geocode('San Diego');
    expect(fetchMock).toHaveBeenCalledOnce();
    // Rewrite the cache entry with a far-past timestamp.
    const cache = JSON.parse(localStorage.getItem('opd-geocode-cache-v1')!);
    cache['san diego'].storedAt = Date.now() - (25 * 3600_000);
    localStorage.setItem('opd-geocode-cache-v1', JSON.stringify(cache));
    await geocode('San Diego');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('geocode — error paths', () => {
  it('returns http for 4xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('Bad Request', { status: 400 }),
    ));
    const r = await geocode('xyz');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('http');
    expect(r.status).toBe(400);
  });

  it('returns http for 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('Internal Server Error', { status: 503 }),
    ));
    const r = await geocode('xyz');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('http');
    expect(r.status).toBe(503);
  });

  it('returns network when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const r = await geocode('xyz');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('network');
  });

  it('returns timeout when AbortController fires (AbortError)', async () => {
    // Simulate the timeout path by throwing an AbortError-like exception.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit | undefined) => {
      // Wait long enough for the test runner to abort the controller.
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      // Never resolves.
      return new Response(null);
    }));
    // The default timeout is 3000ms; we just trust the AbortController
    // codepath here (waiting 3+ seconds in a unit test is wasteful).
    // To simulate without waiting, mock setTimeout to fire abort
    // synchronously. Simpler: assert geocode returns reason=timeout
    // when the underlying fetch throws AbortError.
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    }));
    const r = await geocode('xyz');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('timeout');
  });

  it('returns bad_json when the response is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('this is not json', { status: 200 }),
    ));
    const r = await geocode('xyz');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('bad_json');
  });

  it('returns bad_json when the response is JSON but not an array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'something' }), { status: 200 }),
    ));
    const r = await geocode('xyz');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('bad_json');
  });

  it('returns empty_query for empty / whitespace input without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r1 = await geocode('');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('empty_query');
    const r2 = await geocode('   ');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('empty_query');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok:true with empty array when Nominatim has no matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200 }),
    ));
    const r = await geocode('antarctica-spaceport');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual([]);
  });
});

describe('geocode — Accept header', () => {
  it('sends Accept: application/json', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await geocode('test');
    const calls = fetchMock.mock.calls as unknown[][];
    const init = calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
  });
});
