/** Aurora (Kp index) topbar widget — V4-P2 v1.
 *
 *  Operator context: Chris Williams (ISS, 8-month mission) visits NOAA
 *  SWPC daily to check the Kp index. This widget surfaces the headline
 *  number on the topbar with a click-through to SWPC for the full oval
 *  map. v1 is intentionally minimal — no visibility prediction, no oval
 *  overlay, no "visible from ISS" math. Those are deferred to v1.1
 *  pending operator feedback on whether the headline number alone covers
 *  the daily-tab use case.
 *
 *  Data path:
 *    SWPC planetary_k_index_1m.json
 *      → Cloudflare Worker /api/kp (edge cache, 5min TTL)
 *      → this module's fetchKpData()
 *      → renderKpWidget() updates #kp-widget in the topbar
 *
 *  Failure handling: the widget is OPTIONAL. If /api/kp returns null
 *  (fetch failed, SWPC down, parse error, etc.), the widget hides
 *  itself. No banner, no error toast. The operator can always click
 *  through to SWPC directly via the static fallback link in the HTML
 *  (rendered when the widget is hidden).
 */

/** Response shape returned by the Worker. Matches KpResponse from
 *  worker/src/aurora.ts. Kept independent of that type so the worker
 *  can evolve without recompiling the frontend. */
export interface KpData {
  kp: number;
  timestamp: string;
  age_min: number;
}

/** SWPC dashboard URL. Clicking the widget opens this in a new tab so
 *  Chris can drill into the oval map when Kp suggests storms. */
export const SWPC_DASHBOARD_URL =
  'https://www.swpc.noaa.gov/communities/aurora-dashboard-experimental';

/** Fetch the latest Kp from the Worker proxy. Returns null on any
 *  failure mode (network, 4xx/5xx, malformed JSON). Callers should
 *  treat null as "hide the widget" rather than retrying — the next
 *  refresh tick will try again on its own. */
export async function fetchKpData(
  fetchImpl: typeof fetch = fetch,
): Promise<KpData | null> {
  try {
    const res = await fetchImpl('/api/kp');
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<KpData>;
    if (
      typeof data.kp !== 'number' ||
      typeof data.timestamp !== 'string' ||
      typeof data.age_min !== 'number'
    ) {
      return null;
    }
    return { kp: data.kp, timestamp: data.timestamp, age_min: data.age_min };
  } catch {
    return null;
  }
}

/** Map a Kp value to a color class. Thresholds match NOAA's G-scale:
 *    Kp 0-3   "quiet"  — green
 *    Kp 3-5   "active" — yellow
 *    Kp 5-7   "storm"  — orange  (G1-G2 geomagnetic storm)
 *    Kp 7-9   "severe" — red     (G3-G5)
 *
 *  Out-of-range values (shouldn't happen post parseKp validation, but
 *  defensive against future schema drift) fall back to the quiet class. */
export function kpToColorClass(kp: number): string {
  if (!Number.isFinite(kp) || kp < 0) return 'kp-quiet';
  if (kp < 3) return 'kp-quiet';
  if (kp < 5) return 'kp-active';
  if (kp < 7) return 'kp-storm';
  return 'kp-severe';
}

/** Render the topbar Kp widget. Null state hides the widget entirely;
 *  any non-null state shows the colored badge with the Kp value.
 *
 *  Idempotent: safe to call repeatedly with the same state (1Hz tick
 *  pattern). Sets hidden + textContent + className; no listeners are
 *  attached or removed per render. The click handler is attached once
 *  in initKpWidget() below. */
export function renderKpWidget(state: KpData | null, container: HTMLElement): void {
  if (state === null) {
    container.hidden = true;
    container.textContent = '';
    container.className = 'kp-badge';
    container.removeAttribute('title');
    return;
  }
  container.hidden = false;
  // Kp displays to one decimal place; SWPC publishes integers + occasional
  // fractional values. toFixed(1) normalizes both into the same shape.
  container.textContent = `Kp ${state.kp.toFixed(1)}`;
  container.className = `kp-badge ${kpToColorClass(state.kp)}`;
  // Hover tooltip shows source age (how stale the SWPC reading is, not
  // the cache layer's age). Click-through opens the SWPC dashboard.
  const ageNote =
    state.age_min < 60
      ? `${state.age_min}m ago`
      : `${Math.floor(state.age_min / 60)}h ${state.age_min % 60}m ago`;
  container.title = `Kp ${state.kp.toFixed(1)} · updated ${ageNote} · click for SWPC dashboard`;
}

/** One-time wiring: attach the click handler that opens SWPC. Called
 *  once at init so we don't re-attach on every render. */
export function initKpWidget(container: HTMLElement): void {
  container.addEventListener('click', () => {
    window.open(SWPC_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
  });
  container.setAttribute('role', 'button');
  container.setAttribute('tabindex', '0');
  container.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      window.open(SWPC_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
    }
  });
}

// ---------------------------------------------------------------------------
// Aurora v1.1 — "is aurora visible from ISS right now?"
// ---------------------------------------------------------------------------
//
// The Kp number says how disturbed the magnetosphere is; it says nothing
// about whether the oval is anywhere near the station. v1.1 answers the
// operator's actual question with honest geometry (Codex requirements from
// the v1 design review, folded 2026-05-13):
//
// - The Worker downsamples OVATION's ~900KB 1° grid to a 5° MAX-pooled
//   ~9KB grid (/api/aurora); this module runs the visibility lookup
//   client-side so a cached grid still answers during LOS.
// - Real look-angle geometry, not naive subpoint lookup: from 420km the
//   ISS sees aurora (≈150km emission altitude) out to a tangent ground
//   range of ~3,600km — we scan every grid cell within that cap.
// - Day/night gating: aurora is invisible in daylight regardless of the
//   oval. Sun elevation at the subpoint must be below twilight.
// - Trust-calibrated copy: a false "visible" is worse than an honest
//   "aurora nearby" — thresholds and wording stay conservative, and the
//   tooltip always carries the source age.

import { subsolarPoint } from './terminator';

export interface AuroraGrid {
  observation_time: string;
  forecast_time: string;
  age_min: number;
  grid_step: number;
  /** [36][72] aurora probability 0-100; row 0 = lat [-90,-85), col 0 = [0°E,5°E). */
  probs: number[][];
  degraded?: boolean;
}

/** Ground range of the ISS→aurora sight line: horizon distance from 420km
 *  observer + horizon distance to a 150km-altitude emission layer,
 *  R·(acos(R/(R+420)) + acos(R/(R+150))) ≈ 3,600km. */
export const AURORA_VIEW_CAP_KM = 3600;
/** Sun elevation at the subpoint above which aurora is washed out.
 *  −8° splits civil/nautical twilight — conservative toward "daylit". */
export const AURORA_DAYLIT_SUN_ELEV_DEG = -8;
/** OVATION probability thresholds. ≥40: confident copy; ≥15: hedged copy.
 *  Below 15 the oval is noise at photographic exposure times. */
export const AURORA_PROB_IN_VIEW = 40;
export const AURORA_PROB_FAINT = 15;

/** Fetch the downsampled OVATION grid. Null on any failure (the widget
 *  simply omits the aurora note until the next refresh). */
export async function fetchAuroraGrid(
  fetchImpl: typeof fetch = fetch,
): Promise<AuroraGrid | null> {
  try {
    const res = await fetchImpl('/api/aurora');
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<AuroraGrid>;
    if (
      typeof data.observation_time !== 'string'
      || typeof data.age_min !== 'number'
      || !Array.isArray(data.probs)
      || data.probs.length === 0
    ) {
      return null;
    }
    return data as AuroraGrid;
  } catch {
    return null;
  }
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance (km) — local haversine; inputs in degrees. */
function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Max OVATION probability within the ISS's aurora-visible cap. Scans the
 *  5° grid cell centers — 2,592 haversines is sub-millisecond. */
export function maxAuroraNearIss(
  grid: AuroraGrid,
  issLat: number,
  issLon: number,
): number {
  let max = 0;
  const step = grid.grid_step || 5;
  for (let i = 0; i < grid.probs.length; i++) {
    const row = grid.probs[i];
    if (!Array.isArray(row)) continue;
    const lat = -90 + (i + 0.5) * step;
    for (let j = 0; j < row.length; j++) {
      const p = row[j];
      if (typeof p !== 'number' || p <= max) continue;
      // Grid lons run 0..360; haversine is wrap-agnostic given consistency.
      const lon = (j + 0.5) * step;
      if (greatCircleKm(issLat, issLon, lat, lon > 180 ? lon - 360 : lon) <= AURORA_VIEW_CAP_KM) {
        max = p;
      }
    }
  }
  return max;
}

/** Sun elevation (deg) at a ground point: 90° minus the angular distance
 *  to the subsolar point. Negative = sun below horizon. */
export function sunElevationDeg(lat: number, lon: number, when: Date): number {
  const sub = subsolarPoint(when);
  const angularDeg = greatCircleKm(lat, lon, sub.lat, sub.lon) / EARTH_RADIUS_KM * (180 / Math.PI);
  return 90 - angularDeg;
}

export interface AuroraVisibility {
  state: 'daylit' | 'in-view' | 'faint' | 'none';
  maxProb: number;
  ageMin: number;
  degraded: boolean;
}

/** The honest answer for the CURRENT ISS position + time. */
export function assessAuroraVisibility(
  grid: AuroraGrid,
  issLat: number,
  issLon: number,
  when: Date,
): AuroraVisibility {
  const base = { ageMin: grid.age_min, degraded: grid.degraded === true };
  if (sunElevationDeg(issLat, issLon, when) > AURORA_DAYLIT_SUN_ELEV_DEG) {
    return { state: 'daylit', maxProb: 0, ...base };
  }
  const maxProb = maxAuroraNearIss(grid, issLat, issLon);
  if (maxProb >= AURORA_PROB_IN_VIEW) return { state: 'in-view', maxProb, ...base };
  if (maxProb >= AURORA_PROB_FAINT) return { state: 'faint', maxProb, ...base };
  return { state: 'none', maxProb, ...base };
}

/** Render the aurora note INSIDE the Kp widget (a child span, so the v1
 *  badge behavior is untouched). Trust-calibrated copy: confident wording
 *  only at the high threshold; the tooltip always names probability,
 *  source age, and degraded state. Null/none/daylit → note removed. */
export function renderAuroraVisibility(
  vis: AuroraVisibility | null,
  container: HTMLElement,
): void {
  let note = container.querySelector<HTMLElement>('.kp-aurora-note');
  const show = vis !== null && (vis.state === 'in-view' || vis.state === 'faint');
  if (!show) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement('span');
    note.className = 'kp-aurora-note';
    container.appendChild(note);
  }
  note.textContent = vis.state === 'in-view' ? ' · aurora in view' : ' · aurora nearby';
  const staleNote = vis.degraded ? ' · SWPC degraded, last good reading' : '';
  note.title =
    `OVATION max ${Math.round(vis.maxProb)}% within the station's horizon`
    + ` · reading ${vis.ageMin}m old${staleNote}`;
}

// Refresh cadence gate: the kp fetch rides every 60s poll; the 9KB grid
// only needs to follow OVATION's ~5-30min product cadence. 10 minutes.
const AURORA_REFRESH_MS = 10 * 60_000;
let lastAuroraFetchMs = 0;
let lastAuroraGrid: AuroraGrid | null = null;

/** Test-only: reset the refresh-gate state between vitest runs. */
export function _resetAuroraStateForTest(): void {
  lastAuroraFetchMs = 0;
  lastAuroraGrid = null;
}

/** Fetch (rate-limited) + assess + render in one call. main.ts calls this
 *  wherever it renders the Kp widget, passing the live ISS subpoint; a
 *  null position (no track yet) clears the note. */
export async function refreshAuroraVisibility(
  pos: { lat: number; lon: number } | null,
  container: HTMLElement,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!pos) {
    renderAuroraVisibility(null, container);
    return;
  }
  if (nowMs - lastAuroraFetchMs >= AURORA_REFRESH_MS) {
    lastAuroraFetchMs = nowMs;
    const fetched = await fetchAuroraGrid(fetchImpl);
    if (fetched) lastAuroraGrid = fetched; // keep last good across blips
  }
  if (!lastAuroraGrid) {
    renderAuroraVisibility(null, container);
    return;
  }
  renderAuroraVisibility(
    assessAuroraVisibility(lastAuroraGrid, pos.lat, pos.lon, new Date(nowMs)),
    container,
  );
}
