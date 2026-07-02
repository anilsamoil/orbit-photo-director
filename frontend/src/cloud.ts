/**
 * Live current cloud-cover (%) for the map target popup. Mirrors wx.ts's
 * offline/async discipline: it NEVER blocks the popup (the caller opens the
 * popup synchronously and patches the cloud row async-after-mount), and returns
 * null on offline / timeout / any failure so the caller collapses the row.
 *
 * Keyed by the EXACT coord (`.toFixed(4)`, like wx.ts) so two distinct nearby
 * targets never share a cloud figure (design review R3). The value is an
 * integer percent 0-100, same scale as the at-pass cloud number.
 */
const FETCH_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 5 * 60_000; // matches the Worker edge TTL (300s)

interface CacheEntry {
  t: number;
  pct: number | null;
}
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<number | null>>();

function key(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/**
 * Current cloud-cover % for a target, or null on offline / timeout / failure.
 * Concurrent calls for the same exact coord share one request; a fresh result
 * is reused for CACHE_TTL_MS. Never issues a request when offline.
 */
export async function fetchLiveCloud(
  lat: number,
  lon: number,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<number | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Never even issue the request offline (review R8) — kills the hang/storm.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

  const k = key(lat, lon);
  const cached = cache.get(k);
  if (cached && nowMs - cached.t < CACHE_TTL_MS) return cached.pct;
  const pending = inflight.get(k);
  if (pending) return pending;

  const job = (async (): Promise<number | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`/api/cloud?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, { signal: ctrl.signal });
      if (!res.ok) return null; // 502 (incl. upstream 429) → collapse the row
      const data = (await res.json()) as { cloud_pct?: unknown };
      return typeof data.cloud_pct === 'number' && Number.isFinite(data.cloud_pct) ? data.cloud_pct : null;
    } catch {
      return null; // abort / offline / parse error → caller hides the row
    } finally {
      clearTimeout(timer);
    }
  })();

  inflight.set(k, job);
  try {
    const pct = await job;
    cache.set(k, { t: nowMs, pct });
    return pct;
  } finally {
    inflight.delete(k);
  }
}

/** Reset module caches — test-only. */
export function _resetCloudCacheForTest(): void {
  cache.clear();
  inflight.clear();
}
