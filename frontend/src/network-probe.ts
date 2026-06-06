/** Connectivity probe that defeats the service-worker cache.
 *
 *  Why this exists: neither of the two obvious "are we offline?" signals is
 *  trustworthy on the operator's iPhone.
 *    1. navigator.onLine reports `true` in iOS Safari Airplane Mode (it tracks
 *       "has a network interface", not "has Internet").
 *    2. The SW's NetworkFirst manifest rule serves the last cached manifest
 *       when the network is down, so a plain fetchManifest() SUCCEEDS while
 *       offline — the app thinks it just refreshed stale data.
 *  Result (observed 2026-06-06): a 48h-offline iPhone showed "generator has
 *  been slow" instead of "you're offline (LOS)".
 *
 *  Probe target: a DEDICATED path (`/__opd_probe`) that matches NO Workbox
 *  route — not the manifest route, not precache, not the tile/versioned routes.
 *  Two properties follow:
 *    - It's never written to any SW cache, so it can't be served from cache and
 *      falsely report "online" while offline. The bare manifest URL was the
 *      obvious target, but probing it would let Workbox cache the throwaway
 *      `?_probe=` response and (maxEntries:1) EVICT the real /manifest.json
 *      entry — eroding the SW's offline manifest fallback. A non-matching path
 *      avoids that entirely.
 *    - Online it returns a real HTTP response (the static host 404s it), so any
 *      status > 0 means reachable. Offline the fetch rejects.
 *
 *  Only called when data is already stale (see EMPTY_HINT_THRESHOLD_MIN), so
 *  the request fires rarely — never on the fresh-data happy path.
 */
export const PROBE_PATH = '/__opd_probe';

export async function probeConnectivity(
  probePath: string = PROBE_PATH,
  timeoutMs = 3000,
): Promise<boolean> {
  const sep = probePath.includes('?') ? '&' : '?';
  const url = `${probePath}${sep}_probe=${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // cache:'no-store' bypasses the HTTP cache; the unique query is belt-and-
    // suspenders against any intermediary. Any real HTTP response (even 404)
    // means the network is reachable — only a network error / timeout / abort
    // counts as offline.
    const resp = await fetch(url, { cache: 'no-store', signal: controller.signal });
    return resp.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
