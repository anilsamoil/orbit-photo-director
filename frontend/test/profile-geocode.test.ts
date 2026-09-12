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
import { readFileSync } from 'node:fs';

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
  vi.useRealTimers();
  localStorage.clear();
  _clearGeocodeCacheForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('geocode — Tuvalu photography target', () => {
  it.each(['Tuvalu', ' tubalu ', 'TUVALU', 'Funafuti', 'Funafuti, Tuvalu', 'Fongafale'])
  ('resolves %s on Funafuti without needing a provider', async (query) => {
    const fetchMock = vi.fn(async () => { throw new TypeError('offline'); });
    vi.stubGlobal('fetch', fetchMock);
    const r = await geocode(query);
    expect(r).toEqual({ ok: true, data: [{
      displayName: 'Funafuti atoll (Fongafale), Tuvalu',
      shortName: 'Funafuti, Tuvalu', country: 'Tuvalu',
      lat: -8.525292, lon: 179.196561,
    }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes precedence over a previously cached empty country search', async () => {
    localStorage.setItem('opd-geocode-cache-v1', JSON.stringify({
      tuvalu: { storedAt: Date.now(), data: [] },
    }));
    const r = await geocode('Tuvalu');
    expect(r.ok && r.data[0]?.shortName).toBe('Funafuti, Tuvalu');
  });

  it('matches the shared curated target consumed by the map generator', async () => {
    const targets = JSON.parse(readFileSync('../targets.json', 'utf8'));
    const target = targets.find((t: { id: string }) => t.id === 'tuvalu-funafuti');
    expect(target).toMatchObject({
      name: 'Tuvalu — Funafuti atoll', regime: 'day',
      geom: { type: 'point', lat: -8.525292, lon: 179.196561 },
    });
    const r = await geocode('Tuvalu');
    expect(r.ok && r.data[0]?.lat).toBe(target.geom.lat);
    expect(r.ok && r.data[0]?.lon).toBe(target.geom.lon);
  });

  it('does not replace a more specific query containing Tuvalu', async () => {
    const fetchMock = vi.fn(async () => new Response('[]'));
    vi.stubGlobal('fetch', fetchMock);
    await geocode('Tuvalu Street, Auckland');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('geocode — recovery from intermittent provider failures', () => {
  it('retries an empty result after one minute, including old v1 cache entries', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([makeNominatimHit()])));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('opd-geocode-cache-v1', JSON.stringify({
      'san diego': { storedAt: Date.now() - 61_000, data: [] },
    }));
    const r = await geocode('San Diego');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(r.ok && r.data).toHaveLength(1);
  });

  it('briefly caches a genuine no-match response to avoid repeated provider calls', async () => {
    const fetchMock = vi.fn(async () => new Response('[]'));
    vi.stubGlobal('fetch', fetchMock);
    await geocode('antarctica-spaceport');
    await geocode('antarctica-spaceport');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { storedAt: Date.now(), data: [{}] },
    { storedAt: 'yesterday', data: [] },
    { storedAt: Date.now(), data: { message: 'bad cache' } },
  ])('refetches malformed cached entries instead of rendering them: %j', async (entry) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([makeNominatimHit()])));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('opd-geocode-cache-v1', JSON.stringify({ 'san diego': entry }));
    const r = await geocode('San Diego');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(r.ok && r.data[0]?.shortName).toBe('San Diego');
  });

  it('allows a normal response that takes longer than three seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      setTimeout(() => resolve(new Response(JSON.stringify([makeNominatimHit()]))), 4_500);
    })));
    const pending = geocode('San Diego');
    await vi.advanceTimersByTimeAsync(4_500);
    expect((await pending).ok).toBe(true);
  });

  it('keeps the timeout active while the response body is downloading', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    } as Response)));
    const settled = vi.fn();
    void geocode('San Diego').then(settled);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false, reason: 'timeout' }));
  });

  it('identifies provider blocking and does not cache it as no matches', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Blocked', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([makeNominatimHit()])));
    vi.stubGlobal('fetch', fetchMock);
    expect(await geocode('San Diego')).toMatchObject({
      ok: false, reason: 'http', status: 403, detail: expect.stringMatching(/provider.*blocked/i),
    });
    expect((await geocode('San Diego')).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed nonempty provider response as an error, not no matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      makeNominatimHit({ lat: null }),
      makeNominatimHit({ lon: '' }),
      makeNominatimHit({ lat: false }),
      makeNominatimHit({ display_name: '' }),
    ]))));
    expect(await geocode('malformed')).toMatchObject({ ok: false, reason: 'bad_json' });
  });
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
    // Runtime AbortError normalization, separate from the fake-clock
    // response/body timeout tests above.
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
