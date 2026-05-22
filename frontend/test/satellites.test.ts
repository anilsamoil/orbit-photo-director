import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURATED_SATELLITES,
  _clearTLECacheForTests,
  fetchSatelliteTLE,
  fetchTLEByCATNR,
  fetchTLEByName,
  metaKey,
  parseCelestrakTLE,
} from '../src/satellites';

const SAMPLE_ISS_3LE = `ISS (ZARYA)
1 25544U 98067A   24291.00000000  .00018000  00000-0  32500-3 0  9999
2 25544  51.6400  60.0000 0006000  90.0000 270.0000 15.50000000400000`;

const SAMPLE_MULTI_3LE = `STARSHIP FLIGHT 12
1 99001U 26100A   26141.50000000  .00000000  00000-0  00000-0 0  9999
2 99001  26.5000 270.0000 0003000  90.0000 270.0000 16.00000000 00010
STARSHIP IFT-11 DEBRIS
1 99002U 26100B   26141.50000000  .00000000  00000-0  00000-0 0  9990
2 99002  26.5000 270.0000 0003000  90.0000 270.0000 16.00000000 00020
STARSHIP IFT-11 STAGE 2
1 99003U 26100C   26141.50000000  .00000000  00000-0  00000-0 0  9991
2 99003  26.5000 270.0000 0003000  90.0000 270.0000 16.00000000 00030`;

beforeEach(() => {
  _clearTLECacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseCelestrakTLE (A3 — 3-line + multi-result handling)', () => {
  it('parses a single 3-line TLE block', () => {
    const result = parseCelestrakTLE(SAMPLE_ISS_3LE);
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('ISS (ZARYA)');
    expect(result!.tle.line1.startsWith('1 25544')).toBe(true);
    expect(result!.tle.line2.startsWith('2 25544')).toBe(true);
    expect(result!.match_count).toBe(1);
  });

  it('returns first match + count when multiple satellites in response (A4)', () => {
    const result = parseCelestrakTLE(SAMPLE_MULTI_3LE);
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('STARSHIP FLIGHT 12');
    expect(result!.match_count).toBe(3);
  });

  it('returns null for empty input', () => {
    expect(parseCelestrakTLE('')).toBeNull();
  });

  it('returns null for non-TLE garbage', () => {
    expect(parseCelestrakTLE('No satellites match the given criteria.')).toBeNull();
  });

  it('returns null when missing the line 2 partner', () => {
    expect(parseCelestrakTLE('ORPHAN\n1 12345U 98067A   24291.00000000  .00018000  00000-0  32500-3 0  9999')).toBeNull();
  });

  it('parses a 2-line response (no name header) with name=UNKNOWN', () => {
    const lines = SAMPLE_ISS_3LE.split('\n').slice(1).join('\n');
    const result = parseCelestrakTLE(lines);
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('UNKNOWN');
  });
});

describe('metaKey', () => {
  it('returns the CATNR for catnr-resolved satellites', () => {
    expect(metaKey(CURATED_SATELLITES[0]!)).toBe('25544'); // ISS
    expect(metaKey(CURATED_SATELLITES[1]!)).toBe('48274'); // Tiangong
  });

  it('returns "name:<query>" for name-resolved satellites', () => {
    const starship = CURATED_SATELLITES.find((s) => s.name === 'Starship')!;
    expect(metaKey(starship)).toBe('name:STARSHIP');
  });
});

describe('CURATED_SATELLITES', () => {
  it('contains the 5 expected satellites in order', () => {
    expect(CURATED_SATELLITES).toHaveLength(5);
    expect(CURATED_SATELLITES[0]!.name).toBe('ISS (Zarya)');
    expect(CURATED_SATELLITES[1]!.name).toBe('Tiangong (CSS)');
    expect(CURATED_SATELLITES[2]!.name).toBe('Hubble (HST)');
    expect(CURATED_SATELLITES[3]!.name).toBe('X-37B');
    expect(CURATED_SATELLITES[4]!.name).toBe('Starship');
  });

  it('ISS resolves by CATNR 25544', () => {
    const iss = CURATED_SATELLITES[0]!;
    expect(iss.resolution.kind).toBe('catnr');
    if (iss.resolution.kind === 'catnr') {
      expect(iss.resolution.catnr).toBe(25544);
    }
  });

  it('Starship resolves by name "STARSHIP"', () => {
    const ss = CURATED_SATELLITES.find((s) => s.name === 'Starship')!;
    expect(ss.resolution.kind).toBe('name');
    if (ss.resolution.kind === 'name') {
      expect(ss.resolution.query).toBe('STARSHIP');
    }
  });
});

describe('fetchSatelliteTLE — cache + fetch behavior', () => {
  it('uses cached TLE on hit within 6h TTL', async () => {
    const iss = CURATED_SATELLITES[0]!;
    // Pre-populate cache
    localStorage.setItem(
      `opd-tle-25544`,
      JSON.stringify({
        tle: { line1: 'cached1', line2: 'cached2', name: 'CACHED' },
        fetchedAtMs: Date.now() - 60_000, // 1 min ago
      }),
    );
    // Fetch should not be called
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSatelliteTLE(iss);
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('CACHED');
    expect(result!.stale).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches from CelesTrak on cache miss + caches the response', async () => {
    const iss = CURATED_SATELLITES[0]!;
    const fetchMock = vi.fn(async () =>
      new Response(SAMPLE_ISS_3LE, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSatelliteTLE(iss);
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('ISS (ZARYA)');
    expect(result!.stale).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String((fetchMock.mock.calls as unknown[][])[0]?.[0]);
    expect(url).toContain('CATNR=25544');
    expect(url).toContain('FORMAT=TLE');

    // Cache should now have the result.
    const cached = JSON.parse(localStorage.getItem('opd-tle-25544')!);
    expect(cached.tle.name).toBe('ISS (ZARYA)');
  });

  it('falls back to stale cache on network error (A1 safety)', async () => {
    const iss = CURATED_SATELLITES[0]!;
    localStorage.setItem(
      `opd-tle-25544`,
      JSON.stringify({
        tle: { line1: 'old1', line2: 'old2', name: 'STALE ISS' },
        fetchedAtMs: Date.now() - 7 * 60 * 60 * 1000, // 7h ago (expired)
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const result = await fetchSatelliteTLE(iss);
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('STALE ISS');
    expect(result!.stale).toBe(true);
  });

  it('returns null on network error + no cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await fetchSatelliteTLE(CURATED_SATELLITES[1]!);
    expect(result).toBeNull();
  });

  it('returns null on 404 + no cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const result = await fetchSatelliteTLE(CURATED_SATELLITES[1]!);
    expect(result).toBeNull();
  });

  it('returns null on 5xx + no cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Server error', { status: 503 })));
    const result = await fetchSatelliteTLE(CURATED_SATELLITES[1]!);
    expect(result).toBeNull();
  });

  it('uses name-search URL for name-resolved satellites', async () => {
    const starship = CURATED_SATELLITES.find((s) => s.name === 'Starship')!;
    const fetchMock = vi.fn(async () =>
      new Response(SAMPLE_MULTI_3LE, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSatelliteTLE(starship);
    expect(result).not.toBeNull();
    expect(result!.match_count).toBe(3);
    expect(result!.tle.name).toBe('STARSHIP FLIGHT 12');
    const url = String((fetchMock.mock.calls as unknown[][])[0]?.[0]);
    expect(url).toContain('NAME=STARSHIP');
  });

  it('returns null when name search returns 0 results (corrupt response handling)', async () => {
    const starship = CURATED_SATELLITES.find((s) => s.name === 'Starship')!;
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('No GP data found', { status: 200 }),
    ));
    const result = await fetchSatelliteTLE(starship);
    expect(result).toBeNull();
  });

  it('treats corrupt TLE response as no-data (parse failure → null)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('garbage that is not a TLE', { status: 200 }),
    ));
    const result = await fetchSatelliteTLE(CURATED_SATELLITES[1]!);
    expect(result).toBeNull();
  });
});

describe('fetchTLEByCATNR — custom NORAD ID input', () => {
  it('rejects invalid CATNR (negative, zero, NaN)', async () => {
    expect(await fetchTLEByCATNR(0)).toBeNull();
    expect(await fetchTLEByCATNR(-1)).toBeNull();
    expect(await fetchTLEByCATNR(NaN)).toBeNull();
  });

  it('fetches a valid custom CATNR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(SAMPLE_ISS_3LE, { status: 200 }),
    ));
    const result = await fetchTLEByCATNR(25544);
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('ISS (ZARYA)');
  });
});

describe('fetchTLEByName — custom name search', () => {
  it('rejects empty / whitespace-only query', async () => {
    expect(await fetchTLEByName('')).toBeNull();
    expect(await fetchTLEByName('   ')).toBeNull();
  });

  it('fetches a valid name search', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(SAMPLE_ISS_3LE, { status: 200 }),
    ));
    const result = await fetchTLEByName('ZARYA');
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('ISS (ZARYA)');
    expect(result!.match_count).toBe(1);
  });
});
