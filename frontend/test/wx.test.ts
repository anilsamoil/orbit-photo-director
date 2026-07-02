/**
 * Tests for frontend/src/wx.ts — nearest-station weather column.
 *
 * Focus on the reviewer-required offline/speed contract (R1): offline never
 * fetches, concurrent calls dedup, results cache by rounded coord, and the
 * column self-collapses for distant/empty/offline/error (honest-quiet).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWx, renderWxColumn, _resetWxCacheForTest, type WxData } from '../src/wx';
import type { PassEntry } from '../src/types';

const NOW = Date.parse('2026-06-21T12:00:00Z');

function wxData(over: Partial<WxData> = {}): WxData {
  return {
    metar: { station: 'KAAA', name: 'KAAA', distance_km: 14, distant: false, age_min: 12, flt_cat: 'MVFR', summary: 'broken 1,700 ft', clouds: [] },
    taf: { station: 'KAAA', name: 'KAAA', distance_km: 14, distant: false, issued_age_min: 45, lines: ['Now: few 25,000 ft'] },
    stations_found: 5,
    ...over,
  };
}
function okFetch(data: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })) as unknown as typeof fetch;
}
function setOnline(v: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
}
const pass = (lat = 40, lon = -96): PassEntry => ({ target_lat: lat, target_lon: lon } as unknown as PassEntry);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetWxCacheForTest();
  setOnline(true);
});

describe('fetchWx', () => {
  it('offline → null, never issues a request', async () => {
    setOnline(false);
    const f = okFetch(wxData());
    expect(await fetchWx(40, -96, f, NOW)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('ok response → parsed data', async () => {
    const d = await fetchWx(40, -96, okFetch(wxData()), NOW);
    expect(d?.metar?.summary).toBe('broken 1,700 ft');
  });

  it('non-ok / throw → null (caller hides column)', async () => {
    const f502 = vi.fn(async () => new Response('x', { status: 502 })) as unknown as typeof fetch;
    expect(await fetchWx(40, -96, f502, NOW)).toBeNull();
    const fThrow = vi.fn(async () => { throw new Error('abort'); }) as unknown as typeof fetch;
    expect(await fetchWx(40, -96, fThrow, NOW)).toBeNull();
  });

  it('caches by exact coord — the same target reuses one fetch within TTL', async () => {
    const f = okFetch(wxData());
    await fetchWx(40.02, -96.01, f, NOW);
    await fetchWx(40.02, -96.01, f, NOW + 1000); // same exact target
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('distinct nearby targets do NOT share a cache entry (Codex #4)', async () => {
    const f = okFetch(wxData());
    await fetchWx(40.02, -96.01, f, NOW);
    await fetchWx(40.20, -96.01, f, NOW + 1000); // different target ~20km away
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('dedups concurrent calls for the same coord', async () => {
    let resolve!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((r) => { resolve = r; })) as unknown as typeof fetch;
    const p1 = fetchWx(40, -96, f, NOW);
    const p2 = fetchWx(40, -96, f, NOW);
    resolve(new Response(JSON.stringify(wxData()), { status: 200 }));
    await Promise.all([p1, p2]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('renderWxColumn', () => {
  it('offline → hidden, no fetch', () => {
    setOnline(false);
    const f = okFetch(wxData());
    const col = renderWxColumn(pass(), f);
    expect(col.hidden).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('near station → cover summary + flight-category chip + TAF line', async () => {
    const col = renderWxColumn(pass(), okFetch(wxData()));
    await flush();
    expect(col.hidden).toBe(false);
    expect(col.textContent).toContain('broken 1,700 ft');
    expect(col.querySelector('.pass-thumbnail-wx-chip')?.getAttribute('data-cat')).toBe('MVFR');
    expect(col.textContent).toContain('Now: few 25,000 ft');
  });

  it('distant station → name+distance, NO cover figure (honest-quiet)', async () => {
    const data = wxData({
      metar: { station: 'KFAR', name: 'KFAR', distance_km: 210, distant: true, age_min: 20, flt_cat: null, summary: '', clouds: [] },
      taf: { station: 'KFAR', name: 'KFAR', distance_km: 210, distant: true, issued_age_min: 60, lines: [] },
    });
    const col = renderWxColumn(pass(), okFetch(data));
    await flush();
    expect(col.textContent).toContain('KFAR · 210 km');
    expect(col.textContent).toContain('too far');
    expect(col.textContent).not.toContain('broken');
  });

  it('no METAR but a nearby TAF (remote target) → station + distance + forecast', async () => {
    // Reproduces Victoria Falls: no METAR in remote Africa, nearest data is a
    // TAF from Kasane 72km away. Must show WHICH station + how far, not a bare
    // "Now: clear" with no context.
    const data = wxData({
      metar: null,
      stations_found: 3,
      taf: { station: 'FBKE', name: 'Kasane', distance_km: 72, distant: false, issued_age_min: 30, lines: ['Now: clear'] },
    });
    const col = renderWxColumn(pass(), okFetch(data));
    await flush();
    expect(col.hidden).toBe(false);
    expect(col.textContent).toContain('FBKE · 72 km');
    expect(col.textContent).toContain('forecast only');
    expect(col.textContent).toContain('Now: clear');
  });

  it('ocean / no station → column collapses hidden', async () => {
    const col = renderWxColumn(pass(), okFetch(wxData({ metar: null, taf: null, stations_found: 0 })));
    await flush();
    expect(col.hidden).toBe(true);
  });

  it('fetch failure → column collapses hidden', async () => {
    const f = vi.fn(async () => { throw new Error('x'); }) as unknown as typeof fetch;
    const col = renderWxColumn(pass(), f);
    await flush();
    expect(col.hidden).toBe(true);
  });

  it('stations_found 0 collapses even if a stray TAF line is present (Codex #3)', async () => {
    const data = wxData({
      metar: null,
      stations_found: 0,
      taf: { station: 'X', name: 'X', distance_km: 10, distant: false, issued_age_min: 5, lines: ['Now: clear'] },
    });
    const col = renderWxColumn(pass(), okFetch(data));
    await flush();
    expect(col.hidden).toBe(true);
  });
});
