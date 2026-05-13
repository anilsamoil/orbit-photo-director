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
