/**
 * Tests for worker/src/ovation.ts — OVATION aurora-grid proxy (aurora v1.1).
 *
 * Coverage:
 * - downsampleOvation: happy path (shape, MAX pooling, clamping, age_min),
 *   schema drift (missing keys, bad timestamp, non-array coordinates),
 *   truncated payload rejected by the cell-coverage floor, junk rows skipped
 * - handleAuroraRequest: fresh fetch (caches + persists R2 last-good),
 *   edge-cache hit short-circuit, upstream failure → R2 last-good served
 *   degraded + uncached, stale last-good (>24h) → 502, nothing → 502
 */
import { describe, expect, it, beforeEach } from 'vitest';

import {
  AURORA_LAT_BINS,
  AURORA_LON_BINS,
  downsampleOvation,
  handleAuroraRequest,
  type AuroraGridResponse,
} from '../src/ovation';

// ----- Fixtures ---------------------------------------------------------------

const NOW = Date.parse('2026-06-11T05:00:00Z');

/** Full-coverage OVATION payload: every 1° cell present (lon 0..359,
 *  lat -90..90), zero everywhere except the cells `hot` names. */
function ovationPayload(
  hot: Array<[lon: number, lat: number, prob: number]> = [],
  observation = '2026-06-11T04:16:00Z',
): Record<string, unknown> {
  const coords: number[][] = [];
  for (let lon = 0; lon < 360; lon++) {
    for (let lat = -90; lat <= 90; lat++) {
      coords.push([lon, lat, 0]);
    }
  }
  for (const [lon, lat, prob] of hot) coords.push([lon, lat, prob]);
  return {
    'Observation Time': observation,
    'Forecast Time': '2026-06-11T05:22:00Z',
    'Data Format': '[Longitude, Latitude, Aurora]',
    coordinates: coords,
    type: 'Aurora',
  };
}

// ----- Mock infrastructure ----------------------------------------------------

class MockCache implements Pick<Cache, 'match' | 'put'> {
  private store = new Map<string, Response>();
  async match(key: RequestInfo | URL): Promise<Response | undefined> {
    const k = key instanceof Request ? key.url : String(key);
    const hit = this.store.get(k);
    return hit ? hit.clone() : undefined;
  }
  async put(key: RequestInfo | URL, res: Response): Promise<void> {
    const k = key instanceof Request ? key.url : String(key);
    this.store.set(k, res);
  }
}

class MockR2 {
  store = new Map<string, string>();
  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    const v = this.store.get(key);
    return v === undefined ? null : { text: async () => v };
  }
  async put(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return undefined;
  }
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => { /* swallow */ },
    passThroughOnException: () => { /* noop */ },
  } as ExecutionContext;
}

const req = () => new Request('https://map.astroanil.dev/api/aurora');

// ----- downsampleOvation -------------------------------------------------------

describe('downsampleOvation', () => {
  it('produces the 36×72 grid with MAX pooling and source age', () => {
    // Two 1° cells inside the SAME 5° bin → MAX wins.
    const payload = ovationPayload([
      [12, 67, 30],
      [13, 68, 55],
    ]);
    const grid = downsampleOvation(payload, NOW);
    expect(grid).not.toBeNull();
    expect(grid!.probs.length).toBe(AURORA_LAT_BINS);
    expect(grid!.probs[0]!.length).toBe(AURORA_LON_BINS);
    expect(grid!.grid_step).toBe(5);
    // lat 67-68 → bin floor((67+90)/5)=31; lon 12-13 → bin 2
    expect(grid!.probs[31]![2]).toBe(55);
    expect(grid!.age_min).toBe(44); // 04:16 → 05:00
    expect(grid!.observation_time).toBe('2026-06-11T04:16:00Z');
  });

  it('clamps out-of-range probabilities to 0..100', () => {
    const grid = downsampleOvation(ovationPayload([[100, 70, 250]]), NOW);
    expect(grid!.probs[32]![20]).toBe(100);
  });

  it('skips junk rows without dying', () => {
    const payload = ovationPayload([[200, -70, 25]]);
    (payload.coordinates as unknown[]).push(null, [1], ['x', 'y', 'z'], [400, 95, 10]);
    const grid = downsampleOvation(payload, NOW);
    expect(grid).not.toBeNull();
    expect(grid!.probs[4]![40]).toBe(25);
  });

  it('rejects schema drift: missing keys / bad timestamp / non-array coords', () => {
    expect(downsampleOvation(null, NOW)).toBeNull();
    expect(downsampleOvation({}, NOW)).toBeNull();
    expect(downsampleOvation(ovationPayload([], 'not a date'), NOW)).toBeNull();
    expect(
      downsampleOvation(
        { 'Observation Time': '2026-06-11T04:16:00Z', 'Forecast Time': 'x', coordinates: 'nope' },
        NOW,
      ),
    ).toBeNull();
  });

  it('cell-coverage floor sits exactly at 80% of bins (2074 in, 2073 out)', () => {
    // One row per distinct 5° cell center: k cells touched out of 2592.
    // floor = 36*72*0.8 = 2073.6 → 2074 cells pass, 2073 fail.
    const cells = (k: number): Record<string, unknown> => ({
      'Observation Time': '2026-06-11T04:16:00Z',
      'Forecast Time': '2026-06-11T05:22:00Z',
      coordinates: Array.from({ length: k }, (_, i) => [
        (i % 72) * 5 + 2.5,
        Math.floor(i / 72) * 5 - 87.5,
        0,
      ]),
    });
    expect(downsampleOvation(cells(2074), NOW)).not.toBeNull();
    expect(downsampleOvation(cells(2073), NOW)).toBeNull();
  });

  it('rejects truncated payloads via the cell-coverage floor', () => {
    // Only ~100 of 65k rows present → far below 80% cell coverage.
    const coords = Array.from({ length: 100 }, (_, i) => [i, 0, 5]);
    const payload = {
      'Observation Time': '2026-06-11T04:16:00Z',
      'Forecast Time': '2026-06-11T05:22:00Z',
      coordinates: coords,
    };
    expect(downsampleOvation(payload, NOW)).toBeNull();
  });
});

// ----- handleAuroraRequest ------------------------------------------------------

describe('handleAuroraRequest', () => {
  let cache: MockCache;
  let r2: MockR2;
  let ctx: ExecutionContext;

  beforeEach(() => {
    cache = new MockCache();
    r2 = new MockR2();
    ctx = makeCtx();
  });

  const okFetch = (payload: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  const deadFetch: typeof fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  it('happy path: 200 grid, edge-cached, R2 last-good persisted', async () => {
    const res = await handleAuroraRequest(
      req(), { CALIB: r2 }, ctx, okFetch(ovationPayload([[10, 65, 60]])), cache as unknown as Cache, NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuroraGridResponse;
    expect(body.probs[31]![2]).toBe(60);
    expect(body.degraded).toBeUndefined();
    expect(r2.store.has('aurora/ovation-last-good.json')).toBe(true);
    // Second call: must come from the EDGE CACHE. Dead fetch AND no CALIB
    // binding — if edge caching were broken this would 502; a non-degraded
    // 200 can only be the cached response (the old assertion accepted the
    // R2 degraded fallback and could never fail — ship review 2026-06-11).
    const res2 = await handleAuroraRequest(
      req(), {}, ctx, deadFetch, cache as unknown as Cache, NOW,
    );
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as AuroraGridResponse).degraded).toBeUndefined();
  });

  it('upstream down → R2 last-good served degraded with recomputed age, uncached', async () => {
    const stored: AuroraGridResponse = {
      observation_time: '2026-06-11T03:00:00Z',
      forecast_time: '2026-06-11T04:00:00Z',
      age_min: 5, // stale stored value — must be recomputed
      grid_step: 5,
      probs: [[1]],
    };
    r2.store.set('aurora/ovation-last-good.json', JSON.stringify(stored));
    const res = await handleAuroraRequest(
      req(), { CALIB: r2 }, ctx, deadFetch, cache as unknown as Cache, NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuroraGridResponse;
    expect(body.degraded).toBe(true);
    expect(body.age_min).toBe(120); // 03:00 → 05:00
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('upstream down + last-good older than 24h → 502 (stale aurora is a lie)', async () => {
    const stored: AuroraGridResponse = {
      observation_time: '2026-06-09T03:00:00Z',
      forecast_time: '2026-06-09T04:00:00Z',
      age_min: 5,
      grid_step: 5,
      probs: [[1]],
    };
    r2.store.set('aurora/ovation-last-good.json', JSON.stringify(stored));
    const res = await handleAuroraRequest(
      req(), { CALIB: r2 }, ctx, deadFetch, cache as unknown as Cache, NOW,
    );
    expect(res.status).toBe(502);
  });

  it('last-good boundary: exactly 24h serves degraded; one minute past → 502', async () => {
    const mk = (obs: string): string => JSON.stringify({
      observation_time: obs,
      forecast_time: obs,
      age_min: 5,
      grid_step: 5,
      probs: [[1]],
    } satisfies AuroraGridResponse);
    // NOW = 2026-06-11T05:00Z. Exactly 1440 min old → still served (<=).
    r2.store.set('aurora/ovation-last-good.json', mk('2026-06-10T05:00:00Z'));
    const atCap = await handleAuroraRequest(
      req(), { CALIB: r2 }, ctx, deadFetch, cache as unknown as Cache, NOW,
    );
    expect(atCap.status).toBe(200);
    expect(((await atCap.json()) as AuroraGridResponse).age_min).toBe(1440);
    // 1441 min old → honest 502.
    r2.store.set('aurora/ovation-last-good.json', mk('2026-06-10T04:59:00Z'));
    const pastCap = await handleAuroraRequest(
      req(), { CALIB: r2 }, ctx, deadFetch, cache as unknown as Cache, NOW,
    );
    expect(pastCap.status).toBe(502);
  });

  it('upstream down + nothing stored → 502', async () => {
    const res = await handleAuroraRequest(
      req(), { CALIB: r2 }, ctx, deadFetch, cache as unknown as Cache, NOW,
    );
    expect(res.status).toBe(502);
  });

  it('schema-drifted upstream → falls to last-good path', async () => {
    const stored: AuroraGridResponse = {
      observation_time: '2026-06-11T04:30:00Z',
      forecast_time: '2026-06-11T05:30:00Z',
      age_min: 1,
      grid_step: 5,
      probs: [[2]],
    };
    r2.store.set('aurora/ovation-last-good.json', JSON.stringify(stored));
    const res = await handleAuroraRequest(
      req(), { CALIB: r2 }, ctx, okFetch({ totally: 'different schema' }), cache as unknown as Cache, NOW,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as AuroraGridResponse).degraded).toBe(true);
  });
});
