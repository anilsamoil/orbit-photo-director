/**
 * Nearest-station weather (METAR + plain-language TAF) for the CEO zoom panel.
 *
 * Ground-truth complement to the satellite/IR cloud picture: a station looks
 * UP and measures the ceiling directly, catching the low stratus/fog the
 * satellite misses. METAR is the decisive current read; TAF is a supporting
 * trend. Both come from the Worker /api/wx proxy.
 *
 * Offline/speed discipline (design-review-folded, R1):
 *  - Rendered ASYNC-AFTER-MOUNT: renderWxColumn() returns an element
 *    synchronously (never blocking the thumbnail) and patches text in when the
 *    fetch resolves.
 *  - fetchWx() hard-aborts at 2.5s, skips entirely when navigator.onLine is
 *    false, and dedups concurrent calls + caches by rounded coord so N open
 *    cards for one target = at most one network request per ~5min.
 *  - Honest-quiet: a station >150km, an empty box, offline, or an error all
 *    collapse the column to nothing (no clutter for ocean/remote targets).
 */
import type { PassEntry } from './types';

export interface WxCloudLayer {
  cover: string;
  base_ft: number | null;
}
export interface WxMetar {
  station: string;
  name: string;
  distance_km: number;
  distant: boolean;
  age_min: number;
  flt_cat: string | null;
  summary: string;
  clouds: WxCloudLayer[];
}
export interface WxTaf {
  station: string;
  name: string;
  distance_km: number;
  distant: boolean;
  issued_age_min: number;
  lines: string[];
}
export interface WxData {
  metar: WxMetar | null;
  taf: WxTaf | null;
  stations_found: number;
  degraded?: boolean;
}

// 4s: a cold aviationweather.gov fetch can take a few seconds. The column
// shows a "checking…" placeholder meanwhile and the card stays fully
// interactive (async-after-mount), so this never blocks — it just lifts the
// first-view data hit-rate. The Worker edge-caches (300s), so the next view
// of the same area is fast regardless.
const FETCH_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 5 * 60_000; // matches the Worker edge TTL (300s)

interface CacheEntry {
  t: number;
  data: WxData | null;
}
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<WxData | null>>();

function key(lat: number, lon: number): string {
  // Per-target EXACT key (matches the Worker): a target re-rendered keeps the
  // same coord → cache hit; two DISTINCT targets must not share a cached
  // distance/cover figure near the 150km gate (Codex review #4).
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/**
 * Fetch nearest-station weather. Returns null on offline / timeout / any
 * failure (caller collapses the column). Concurrent calls for the same rounded
 * coord share one request; a fresh result is reused for CACHE_TTL_MS.
 */
export async function fetchWx(
  lat: number,
  lon: number,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<WxData | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Never even issue the request offline — kills the offline hang + fetch storm.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

  const k = key(lat, lon);
  const cached = cache.get(k);
  if (cached && nowMs - cached.t < CACHE_TTL_MS) return cached.data;
  const pending = inflight.get(k);
  if (pending) return pending;

  const job = (async (): Promise<WxData | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`/api/wx?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as WxData;
      if (!data || typeof data !== 'object' || typeof data.stations_found !== 'number') return null;
      return data;
    } catch {
      return null; // abort / offline / parse error → caller hides the column
    } finally {
      clearTimeout(timer);
    }
  })();

  inflight.set(k, job);
  try {
    const data = await job;
    cache.set(k, { t: nowMs, data });
    return data;
  } finally {
    inflight.delete(k);
  }
}

/** Reset module caches — test-only. */
export function _resetWxCacheForTest(): void {
  cache.clear();
  inflight.clear();
}

function fmtAge(min: number): string {
  if (!Number.isFinite(min) || min < 0) return '';
  return min < 60 ? `${min}m` : `${Math.round(min / 60)}h`;
}

function row(cls: string, text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text; // textContent only — NWS strings rendered safely
  return d;
}

/** Whether a WxData carries anything worth showing (else collapse the column). */
function hasContent(data: WxData | null): boolean {
  if (!data) return false;
  if (data.stations_found === 0) return false; // truly empty box (ocean) → show nothing
  const m = data.metar;
  const t = data.taf;
  const metarShows = !!m && ((!m.distant && !!m.summary) || m.distant);
  const tafShows = !!t && !t.distant && t.lines.length > 0;
  return metarShows || tafShows;
}

function renderWxInto(col: HTMLElement, data: WxData): void {
  col.appendChild(row('pass-thumbnail-wx-label', 'NEAREST STATION'));
  const m = data.metar;
  const t = data.taf;
  const tafUsable = !!t && !t.distant && t.lines.length > 0;

  if (m && !m.distant && m.summary) {
    // Current observation — the decisive read: cover (bold) + flight category,
    // then station + distance + observation age.
    const cover = row('pass-thumbnail-wx-cover', m.summary);
    if (m.flt_cat) {
      const chip = document.createElement('span');
      chip.className = 'pass-thumbnail-wx-chip';
      chip.dataset.cat = m.flt_cat;
      chip.textContent = m.flt_cat;
      cover.appendChild(document.createTextNode(' '));
      cover.appendChild(chip);
    }
    col.appendChild(cover);
    const age = fmtAge(m.age_min);
    const meta = `${m.station} · ${m.distance_km} km${age ? ` · obs ${age} ago` : ''}`;
    col.appendChild(row('pass-thumbnail-wx-meta', meta));
  } else if (tafUsable) {
    // No usable current obs nearby (remote target) — the nearest data is a
    // forecast station. Show WHICH station + how far, labelled honestly so it
    // never reads like a current observation at the target.
    col.appendChild(row('pass-thumbnail-wx-meta', `${t!.station} · ${t!.distance_km} km · forecast only`));
  } else if (m && m.distant) {
    // Honest-quiet: name + distance only, no cover figure for a far station.
    col.appendChild(row('pass-thumbnail-wx-meta', `${m.station} · ${m.distance_km} km — too far for a current read`));
  }

  // TAF forecast lines — supporting trend, or the only data when no METAR.
  if (tafUsable) {
    for (const line of t!.lines.slice(0, 2)) {
      col.appendChild(row('pass-thumbnail-wx-taf', line));
    }
  }
  if (data.degraded) col.appendChild(row('pass-thumbnail-wx-degraded', '· last good'));
}

/**
 * Build the weather column for a pass thumbnail. Returns synchronously; the
 * column starts collapsed/loading and patches in when /api/wx resolves. Stays
 * collapsed offline or when no useful station data exists (honest-quiet).
 */
export function renderWxColumn(
  pass: PassEntry,
  fetchImpl: typeof fetch = fetch,
): HTMLElement {
  const col = document.createElement('div');
  col.className = 'pass-thumbnail-wx';
  col.hidden = true;

  const lat = pass.target_lat;
  const lon = pass.target_lon;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return col;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return col; // offline → stay collapsed, no request issued
  }

  const loading = row('pass-thumbnail-wx-loading', 'checking nearby station…');
  col.appendChild(loading);
  col.hidden = false;

  void fetchWx(lat, lon, fetchImpl)
    .then((data) => {
      col.replaceChildren();
      if (!hasContent(data)) {
        col.hidden = true; // ocean/remote/no-station → collapse
        return;
      }
      renderWxInto(col, data as WxData);
    })
    .catch(() => {
      col.replaceChildren();
      col.hidden = true;
    });

  return col;
}
