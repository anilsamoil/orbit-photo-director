/**
 * Tests for worker/src/wx.ts — nearest-station METAR + TAF proxy.
 *
 * Coverage:
 * - tafToPlainLanguage: FM (definite), TEMPO/PROB30/BECMG (QUALIFIED, never
 *   stated as fact), empty fcsts
 * - buildBboxes: single box, antimeridian split (lon near ±180)
 * - haversineKm: antimeridian-aware shortest distance
 * - handleWxRequest: happy path (caches + R2 persist), nearest computed
 *   SEPARATELY for METAR vs TAF, >150km honest-quiet (no cover figure),
 *   empty box (stations_found 0), bad coords 400, partial failure still 200
 *   (uncached), both-down → R2 last-good degraded (≤6h) / 502 (older / none),
 *   edge-cache key rounds to 0.25°
 */
import { describe, expect, it, beforeEach } from 'vitest';

import {
  buildBboxes,
  haversineKm,
  handleWxRequest,
  tafToPlainLanguage,
  type WxResponse,
} from '../src/wx';

const NOW = Date.parse('2026-06-21T12:00:00Z');
const NOW_SEC = Math.floor(NOW / 1000);

// ----- fixtures ---------------------------------------------------------------

const metarStation = (
  icaoId: string,
  lat: number,
  lon: number,
  clouds: Array<{ cover: string; base: number | null }>,
  opts: { fltCat?: string; ageMin?: number } = {},
) => ({
  icaoId,
  name: `${icaoId} Field`,
  lat,
  lon,
  clouds,
  fltCat: opts.fltCat ?? 'VFR',
  obsTime: NOW_SEC - (opts.ageMin ?? 12) * 60,
});

const tafStation = (icaoId: string, lat: number, lon: number, fcsts: unknown[]) => ({
  icaoId,
  name: `${icaoId} Field`,
  lat,
  lon,
  issueTime: NOW_SEC - 45 * 60,
  fcsts,
});

// ----- mock infra -------------------------------------------------------------

class MockCache implements Pick<Cache, 'match' | 'put'> {
  store = new Map<string, Response>();
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
  async get(key: string) {
    const v = this.store.get(key);
    return v === undefined ? null : { text: async () => v };
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
    return undefined;
  }
}
function makeCtx(): ExecutionContext {
  return { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
}

/** fetch mock dispatching on /metar vs /taf; a value of Error → that product
 *  rejects (timeout/down). Records requested URLs for bbox assertions. */
function makeFetch(opts: { metar?: unknown; taf?: unknown }, seen?: string[]): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    seen?.push(u);
    const which = u.includes('/api/data/metar') ? 'metar' : 'taf';
    const v = opts[which];
    if (v instanceof Error) throw v;
    return new Response(JSON.stringify(v ?? []), { status: 200 });
  }) as typeof fetch;
}

const wxReq = (lat: number, lon: number) =>
  new Request(`https://map.astroanil.dev/api/wx?lat=${lat}&lon=${lon}`);

// ----- tafToPlainLanguage -----------------------------------------------------

describe('tafToPlainLanguage', () => {
  const base = { clouds: [{ cover: 'SCT', base: 300 }] };
  const future = NOW_SEC + 3 * 3600; // 15:00Z

  it('FM is stated as a definite transition', () => {
    const lines = tafToPlainLanguage([base, { fcstChange: 'FM', timeFrom: future, timeTo: future + 3600, clouds: [{ cover: 'BKN', base: 1000 }] }], NOW);
    expect(lines[0]).toBe('Now: scattered 300 ft');
    expect(lines[1]).toBe('From 15:00Z: broken 1,000 ft');
  });

  it('TEMPO is qualified as temporary, never definite', () => {
    const lines = tafToPlainLanguage([base, { fcstChange: 'TEMPO', timeFrom: future, timeTo: future + 3600, clouds: [{ cover: 'OVC', base: 800 }] }], NOW);
    expect(lines[1]).toMatch(/^Temporarily overcast 800 ft/);
  });

  it('PROB30 is qualified as a percentage chance', () => {
    const lines = tafToPlainLanguage([base, { probability: 30, timeFrom: future, timeTo: future + 3600, clouds: [{ cover: 'BKN', base: 800 }] }], NOW);
    expect(lines[1]).toBe('30% chance broken 800 ft around 15:00Z');
  });

  it('BECMG is qualified as gradual', () => {
    const lines = tafToPlainLanguage([base, { fcstChange: 'BECMG', timeFrom: future, timeBec: future + 1800, timeTo: future + 3600, clouds: [{ cover: 'BKN', base: 3000 }] }], NOW);
    expect(lines[1]).toBe('Gradually broken 3,000 ft by 15:30Z');
  });

  it('empty fcsts → no lines', () => {
    expect(tafToPlainLanguage([], NOW)).toEqual([]);
    expect(tafToPlainLanguage(undefined, NOW)).toEqual([]);
  });

  it('skips a fully-past change group', () => {
    const past = NOW_SEC - 2 * 3600;
    const lines = tafToPlainLanguage([base, { fcstChange: 'FM', timeFrom: past - 3600, timeTo: past, clouds: [{ cover: 'OVC', base: 500 }] }], NOW);
    expect(lines).toEqual(['Now: scattered 300 ft']);
  });
});

// ----- buildBboxes / haversineKm ----------------------------------------------

describe('buildBboxes', () => {
  it('returns a single box away from the antimeridian', () => {
    expect(buildBboxes(40, -96)).toHaveLength(1);
  });
  it('splits across +180 (target just west of the dateline)', () => {
    const boxes = buildBboxes(0, 179.8);
    expect(boxes).toHaveLength(2);
    // One box ends at +180, the other starts at -180.
    expect(boxes.some((b) => b.endsWith(',180.00'))).toBe(true);
    expect(boxes.some((b) => b.includes(',-180.00,'))).toBe(true);
  });
  it('splits across -180 (target just east of the dateline)', () => {
    expect(buildBboxes(0, -179.8)).toHaveLength(2);
  });
});

describe('haversineKm', () => {
  it('~111km per degree of latitude', () => {
    expect(haversineKm(40, -96, 41, -96)).toBeGreaterThan(108);
    expect(haversineKm(40, -96, 41, -96)).toBeLessThan(114);
  });
  it('takes the short way around the antimeridian', () => {
    // 179.5 to -179.5 is 1° apart, not 359°.
    expect(haversineKm(0, 179.5, 0, -179.5)).toBeLessThan(120);
  });
});

// ----- handleWxRequest --------------------------------------------------------

describe('handleWxRequest', () => {
  let cache: MockCache;
  let r2: MockR2;
  let ctx: ExecutionContext;
  beforeEach(() => {
    cache = new MockCache();
    r2 = new MockR2();
    ctx = makeCtx();
  });

  const baseTaf = [{ clouds: [{ cover: 'FEW', base: 25000 }] }];

  it('happy path: 200, nearest METAR summary + age, edge-cached, R2 persisted', async () => {
    const fetchImpl = makeFetch({
      metar: [metarStation('KAAA', 40.1, -96, [{ cover: 'BKN', base: 1700 }], { fltCat: 'MVFR', ageMin: 12 })],
      taf: [tafStation('KAAA', 40.1, -96, baseTaf)],
    });
    const res = await handleWxRequest(wxReq(40, -96), { CALIB: r2 }, ctx, fetchImpl, cache as unknown as Cache, NOW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WxResponse;
    expect(body.metar?.station).toBe('KAAA');
    expect(body.metar?.summary).toBe('broken 1,700 ft');
    expect(body.metar?.flt_cat).toBe('MVFR');
    expect(body.metar?.age_min).toBe(12);
    expect(body.metar?.distant).toBe(false);
    expect(body.taf?.lines[0]).toBe('Now: few 25,000 ft');
    expect(body.stations_found).toBe(1);
    expect(r2.store.has('wx/40.0000_-96.0000.json')).toBe(true);
  });

  it('computes nearest SEPARATELY for METAR and TAF', async () => {
    const fetchImpl = makeFetch({
      metar: [
        metarStation('KNEAR', 40.1, -96, [{ cover: 'SCT', base: 4000 }]),
        metarStation('KFAR', 42, -96, [{ cover: 'OVC', base: 900 }]),
      ],
      taf: [tafStation('KTAFONLY', 40.3, -96, baseTaf)],
    });
    const body = (await (await handleWxRequest(wxReq(40, -96), { CALIB: r2 }, ctx, fetchImpl, cache as unknown as Cache, NOW)).json()) as WxResponse;
    expect(body.metar?.station).toBe('KNEAR'); // closest METAR
    expect(body.taf?.station).toBe('KTAFONLY'); // closest TAF (different list)
  });

  it('station >150km: honest-quiet — distance kept, NO cover figure', async () => {
    const fetchImpl = makeFetch({
      metar: [metarStation('KFAR', 42, -96, [{ cover: 'OVC', base: 800 }])], // ~222km from (40,-96)
      taf: [],
    });
    const body = (await (await handleWxRequest(wxReq(40, -96), { CALIB: r2 }, ctx, fetchImpl, cache as unknown as Cache, NOW)).json()) as WxResponse;
    expect(body.metar?.distant).toBe(true);
    expect(body.metar?.distance_km).toBeGreaterThan(150);
    expect(body.metar?.summary).toBe(''); // no confident cover figure for a far station
    expect(body.metar?.clouds).toEqual([]);
  });

  it('empty box (ocean target): 200 with stations_found 0 and null products', async () => {
    const fetchImpl = makeFetch({ metar: [], taf: [] });
    const body = (await (await handleWxRequest(wxReq(-30, -120), { CALIB: r2 }, ctx, fetchImpl, cache as unknown as Cache, NOW)).json()) as WxResponse;
    expect(body.stations_found).toBe(0);
    expect(body.metar).toBeNull();
    expect(body.taf).toBeNull();
  });

  it('bad coords → 400', async () => {
    const fetchImpl = makeFetch({ metar: [], taf: [] });
    const res = await handleWxRequest(new Request('https://x/api/wx?lat=999&lon=0'), {}, ctx, fetchImpl, cache as unknown as Cache, NOW);
    expect(res.status).toBe(400);
    const res2 = await handleWxRequest(new Request('https://x/api/wx?lat=abc'), {}, ctx, fetchImpl, cache as unknown as Cache, NOW);
    expect(res2.status).toBe(400);
  });

  it('partial failure (TAF down): still 200 with METAR, taf null, NOT cached/persisted', async () => {
    const fetchImpl = makeFetch({
      metar: [metarStation('KAAA', 40.1, -96, [{ cover: 'CLR', base: null }])],
      taf: new Error('taf upstream timeout'),
    });
    const res = await handleWxRequest(wxReq(40, -96), { CALIB: r2 }, ctx, fetchImpl, cache as unknown as Cache, NOW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WxResponse;
    expect(body.metar?.summary).toBe('clear');
    expect(body.taf).toBeNull();
    // A partial read must not poison the edge cache or R2 last-good.
    expect(r2.store.has('wx/40.0000_-96.0000.json')).toBe(false);
    expect(cache.store.size).toBe(0);
  });

  it('edge cache: same exact coord hits cache (dead fetch still 200, non-degraded)', async () => {
    const fetchImpl = makeFetch({ metar: [metarStation('KAAA', 40.1, -96, [{ cover: 'FEW', base: 20000 }])], taf: [tafStation('KAAA', 40.1, -96, baseTaf)] });
    await handleWxRequest(wxReq(40.02, -96.01), {}, ctx, fetchImpl, cache as unknown as Cache, NOW);
    const dead = makeFetch({ metar: new Error('down'), taf: new Error('down') });
    const res2 = await handleWxRequest(wxReq(40.02, -96.01), {}, ctx, dead, cache as unknown as Cache, NOW); // same exact coord
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as WxResponse).degraded).toBeUndefined();
  });

  it('both upstreams down → R2 last-good ≤6h served degraded, uncached', async () => {
    r2.store.set('wx/40.0000_-96.0000.json', JSON.stringify({ metar: { station: 'KAAA', summary: 'broken 1,700 ft' }, taf: null, stations_found: 1, _t: NOW - 90 * 60_000 }));
    const dead = makeFetch({ metar: new Error('down'), taf: new Error('down') });
    const res = await handleWxRequest(wxReq(40, -96), { CALIB: r2 }, ctx, dead, cache as unknown as Cache, NOW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WxResponse;
    expect(body.degraded).toBe(true);
    expect(body.metar?.summary).toBe('broken 1,700 ft');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('both down + last-good older than 6h → 502', async () => {
    r2.store.set('wx/40.0000_-96.0000.json', JSON.stringify({ metar: {}, taf: null, stations_found: 1, _t: NOW - 7 * 60 * 60_000 }));
    const dead = makeFetch({ metar: new Error('down'), taf: new Error('down') });
    const res = await handleWxRequest(wxReq(40, -96), { CALIB: r2 }, ctx, dead, cache as unknown as Cache, NOW);
    expect(res.status).toBe(502);
  });

  it('both down + nothing stored → 502', async () => {
    const dead = makeFetch({ metar: new Error('down'), taf: new Error('down') });
    const res = await handleWxRequest(wxReq(40, -96), { CALIB: r2 }, ctx, dead, cache as unknown as Cache, NOW);
    expect(res.status).toBe(502);
  });
});

describe('Codex review fixes', () => {
  let cache: MockCache;
  let r2: MockR2;
  let ctx: ExecutionContext;
  beforeEach(() => { cache = new MockCache(); r2 = new MockR2(); ctx = makeCtx(); });

  it('TAF Now reflects a prevailing FM period already in effect (not array[0])', () => {
    const past = NOW_SEC - 3600;
    const lines = tafToPlainLanguage([
      { timeFrom: NOW_SEC - 7200, timeTo: past, clouds: [{ cover: 'SCT', base: 300 }] }, // expired base
      { fcstChange: 'FM', timeFrom: past, timeTo: NOW_SEC + 3600, clouds: [{ cover: 'OVC', base: 600 }] }, // active now
    ], NOW);
    expect(lines[0]).toBe('Now: overcast 600 ft');
  });

  it('TAF unknown change type is qualified ("Around"), never stated as fact', () => {
    const future = NOW_SEC + 3 * 3600;
    const lines = tafToPlainLanguage([
      { clouds: [{ cover: 'SCT', base: 300 }] },
      { fcstChange: 'WEIRD', timeFrom: future, timeTo: future + 3600, clouds: [{ cover: 'BKN', base: 900 }] },
    ], NOW);
    expect(lines[1]).toBe('Around 15:00Z: broken 900 ft');
  });

  it('TAF PROB encoded in fcstChange (no probability field) stays qualified', () => {
    const future = NOW_SEC + 3 * 3600;
    const lines = tafToPlainLanguage([
      { clouds: [{ cover: 'SCT', base: 300 }] },
      { fcstChange: 'PROB40', timeFrom: future, timeTo: future + 3600, clouds: [{ cover: 'OVC', base: 700 }] },
    ], NOW);
    expect(lines[1]).toBe('40% chance overcast 700 ft around 15:00Z');
  });

  it('METAR clear clouds + IFR/LIFR → "low visibility", never "clear" (fog)', async () => {
    const fetchImpl = makeFetch({ metar: [metarStation('KFOG', 40.1, -96, [], { fltCat: 'LIFR' })], taf: [] });
    const body = (await (await handleWxRequest(wxReq(40, -96), { CALIB: r2 }, ctx, fetchImpl, cache as unknown as Cache, NOW)).json()) as WxResponse;
    expect(body.metar?.summary).toBe('low visibility');
  });

  it('METAR clear clouds + visib < 3 sm → low visibility with the figure', async () => {
    const st = { ...metarStation('KHAZ', 40.1, -96, [], { fltCat: 'VFR' }), visib: '2' };
    const fetchImpl = makeFetch({ metar: [st], taf: [] });
    const body = (await (await handleWxRequest(wxReq(40, -96), { CALIB: r2 }, ctx, fetchImpl, cache as unknown as Cache, NOW)).json()) as WxResponse;
    expect(body.metar?.summary).toBe('low visibility (2 sm)');
  });

  it('METAR down + TAF up → stations_found reflects the TAF station, not 0', async () => {
    const fetchImpl = makeFetch({ metar: new Error('down'), taf: [tafStation('KAAA', 40.1, -96, [{ clouds: [{ cover: 'FEW', base: 25000 }] }])] });
    const body = (await (await handleWxRequest(wxReq(40, -96), { CALIB: r2 }, ctx, fetchImpl, cache as unknown as Cache, NOW)).json()) as WxResponse;
    expect(body.metar).toBeNull();
    expect(body.taf?.lines.length).toBeGreaterThan(0);
    expect(body.stations_found).toBe(1);
  });

  it('polar bbox widens the longitude span (distance-corrected)', () => {
    const boxes = buildBboxes(85, 0);
    expect(boxes).toHaveLength(1);
    const p = boxes[0]!.split(',').map(Number);
    expect(p[3]! - p[1]!).toBeGreaterThan(40); // lon span >> ±2.5° at lat 85
  });
});
