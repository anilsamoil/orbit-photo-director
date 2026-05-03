import { parseUtcIso } from './countdown';

export type BannerLevel = 'green' | 'yellow' | 'red' | 'loading';

export interface BannerState {
  level: BannerLevel;
  text: string;
}

/** Compute the staleness banner from manifest age + freshness flags.
 *
 *  green    < 40 min old AND freshness.ok
 *  yellow   40–60 min old, or freshness.ok=false but recent
 *  red      > 60 min old, OR explicit stale flag from server
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

  if (ageMin < 40 && freshnessOk) {
    return { level: 'green', text: `Last updated ${formatAge(ageMin)} ago` };
  }
  if (ageMin < 60 && freshnessOk) {
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
