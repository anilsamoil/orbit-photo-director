import { parseUtcIso } from './countdown';

export type BannerLevel = 'green' | 'yellow' | 'orange' | 'red' | 'loading';

export interface BannerState {
  level: BannerLevel;
  text: string;
}

/** Compute the staleness banner from manifest age + freshness flags.
 *
 *  Generator ticks every 1h. Thresholds:
 *    green    < 1h30m old AND freshness.ok
 *    yellow   1h30m–2h old, or freshness.ok=false but recent
 *    red      > 2h old, OR explicit stale flag from server
 */
export function bannerFromManifest(
  generatedAtIso: string,
  freshnessOk: boolean,
  nowMs: number
): BannerState {
  const generated = parseUtcIso(generatedAtIso).getTime();
  const ageMin = (nowMs - generated) / 60000;

  if (ageMin < 0) {
    return { level: 'red', text: `Clock skew: server ahead ${Math.round(-ageMin)} min — verify Mac time` };
  }

  if (ageMin < 90 && freshnessOk) {
    return { level: 'green', text: `Last updated ${formatAge(ageMin)} ago` };
  }
  if (ageMin < 120 && freshnessOk) {
    return { level: 'yellow', text: `Last updated ${formatAge(ageMin)} ago — generator running slow` };
  }
  if (!freshnessOk) {
    return {
      level: 'red',
      text: `Inputs degraded — TLE or cloud composite past freshness threshold (${formatAge(ageMin)} ago)`,
    };
  }
  return {
    level: 'red',
    text: `STALE — last updated ${formatAge(ageMin)} ago — values may be wrong`,
  };
}

/** Confidence banner shown when the live fetch fails or the OS reports offline.
 *  The user is reading data from localStorage; the level escalates with how long
 *  it's been since the last good network refresh.
 *
 *  "LOS" = Loss of Signal, the spaceflight term for an unattended-comms gap.
 *  Chris (operator) requested this over "Offline" since LOS is the operational
 *  vocabulary on ISS — clearer signal at a glance during a real LOS window.
 *
 *  Thresholds (V2 plan):
 *    < 1h     green   "LOS · Nm — last sync recent"
 *    1–3h     yellow  "LOS 2h 15m"
 *    3–12h    orange  "LOS 5h — values may be drifting"
 *    > 12h    red     "LOS 14h — data may be very old"
 *
 *  Confidence NEVER causes the snapshot to be discarded; this is a UX signal,
 *  not a kill switch. Always show *something*.
 */
export function bannerOffline(snapshotAgeMin: number): BannerState {
  const age = formatAge(snapshotAgeMin);
  if (snapshotAgeMin < 60) {
    return { level: 'green', text: `LOS · ${age} ago — last sync recent` };
  }
  if (snapshotAgeMin < 180) {
    return { level: 'yellow', text: `LOS · ${age} ago` };
  }
  if (snapshotAgeMin < 720) {
    return { level: 'orange', text: `LOS · ${age} ago — values may be drifting` };
  }
  return { level: 'red', text: `LOS · ${age} ago — data may be very old` };
}

/** Append a TLE-age overlay onto an existing banner. The plan thresholds
 *  surface a TLE older than 48h as orange (the SGP4 propagation drifts
 *  noticeably past that). If the base banner is already red, only the
 *  text gets appended — we don't downgrade red to orange.
 */
/** Shared TLE-staleness predicate. Encodes the ROUNDED-boundary semantics
 *  (tleAgeHours=47.6 previously read "TLE 48h old" in text while being
 *  treated as fresh — boundary inconsistency, fixed once). Used by the
 *  banner overlay AND the map's scrub-readout hint so the two surfaces can
 *  never disagree at the boundary (pre-landing review 2026-06-10). */
export const TLE_STALE_AFTER_HOURS = 48;
export function isTleStale(tleAgeHours: number | undefined): boolean {
  if (typeof tleAgeHours !== 'number' || !Number.isFinite(tleAgeHours)) return false;
  return Math.round(tleAgeHours) > TLE_STALE_AFTER_HOURS;
}

export function bannerWithTleOverlay(
  base: BannerState,
  tleAgeHours: number | undefined,
): BannerState {
  if (!isTleStale(tleAgeHours)) return base;
  // Display the rounded value the threshold was judged against.
  const displayedHours = Math.round(tleAgeHours as number);
  const tleNote = `TLE ${displayedHours}h old — live track may drift`;
  if (base.level === 'red') {
    return { level: 'red', text: `${base.text} · ${tleNote}` };
  }
  return { level: 'orange', text: `${base.text} · ${tleNote}` };
}

/** Append a launches-stale overlay onto an existing banner. Mirrors
 *  `bannerWithTleOverlay` (eng-review ARCH-2): when LL2 has been unreachable
 *  for >24h the topbar gets a "🚀 launches stale Nh" suffix so the operator
 *  knows the launches feature is degraded. Threshold 24h matches "anything
 *  less is just a few missed polls, which the cached data already covers."
 *
 *  If launches data is fresh (hoursStale undefined or <=24) the base banner
 *  passes through unchanged. If the base is already red, the text gets the
 *  overlay note appended without downgrading the level. Same precedent as
 *  bannerWithTleOverlay. */
export function bannerWithLaunchesOverlay(
  base: BannerState,
  hoursStale: number | undefined,
): BannerState {
  if (typeof hoursStale !== 'number' || !Number.isFinite(hoursStale)) return base;
  if (hoursStale <= 24) return base;
  // Don't overlay onto the loading state. A cold-start with a stale-launches
  // signal would otherwise upgrade "Loading…" → "orange" and surface the
  // overlay before any data has been fetched (review 2026-05-10).
  if (base.level === 'loading') return base;
  const note = `🚀 launches stale ${formatStaleAge(hoursStale)}`;
  if (base.level === 'red') {
    return { level: 'red', text: `${base.text} · ${note}` };
  }
  return { level: 'orange', text: `${base.text} · ${note}` };
}

function formatStaleAge(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function bannerLoading(): BannerState {
  return { level: 'loading', text: 'Loading…' };
}

export function bannerError(reason: string): BannerState {
  return { level: 'red', text: `Failed to load: ${reason}` };
}

function formatAge(min: number): string {
  if (min < 1) return `<1 min`;
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${m}m`;
}
