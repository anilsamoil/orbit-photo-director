import type { CaptureInterval, LaunchArtifact, LaunchOpportunity } from './launch-schema';
import type { LaunchState } from './launch-store';
import type { PassEntry } from './types';
import { isLaunchUtc } from './launch-schema';

export const LAUNCH_HORIZON_MS = 36 * 3600_000;
export const LAUNCH_MAP_HORIZON_MS = 7 * 24 * 3600_000;
export interface LaunchSelection { item: LaunchOpportunity; interval: CaptureInterval | null; expired: boolean }
export function hasLaunchTimeConflict(item: LaunchOpportunity): boolean {
  return item.reason_codes.includes('TIME_CONFLICT');
}
export function launchFresh(state: LaunchState, now: number): boolean {
  const a = state.artifact;
  return !!a && Date.parse(a.generated_at) <= now && now < Date.parse(a.valid_until);
}
function inCoverage(a: LaunchArtifact, start: string, end = start): boolean {
  return Date.parse(start) >= Date.parse(a.coverage.from) && Date.parse(end) <= Date.parse(a.coverage.until);
}
function sourceFresh(a: LaunchArtifact, fetched: string | null, now: number): boolean {
  if (!fetched) return false;
  const generated = Date.parse(a.generated_at);
  const timestamp = Date.parse(fetched);
  // A newly generated wrapper cannot extend the source's own evidence age.
  const lifetime = Date.parse(a.valid_until) - generated;
  return timestamp <= generated && now < timestamp + lifetime;
}
function compare(a: LaunchSelection, b: LaunchSelection): number {
  return Date.parse(a.interval?.start ?? a.item.launch_window.net) - Date.parse(b.interval?.start ?? b.item.launch_window.net)
    || (a.item.event_id < b.item.event_id ? -1 : a.item.event_id > b.item.event_id ? 1 : 0);
}
export function selectLaunches(state: LaunchState, now: number, view: 'queue' | 'upcoming' | 'map'): LaunchSelection[] {
  const a = state.artifact;
  if (!a || (view === 'queue' && (!launchFresh(state, now) || !a.coverage.complete
    || a.coverage.reasons.length > 0 || !sourceFresh(a, a.coverage.fetched_at, now) || state.availability !== 'ready'))) return [];
  const horizon = view === 'map' ? LAUNCH_MAP_HORIZON_MS : LAUNCH_HORIZON_MS;
  const result: LaunchSelection[] = [];
  for (const item of a.items) {
    const supported = item.status === 'geometry_supported';
    const intervals = supported ? item.capture_intervals.filter((i) => inCoverage(a, i.start, i.end))
      .slice().sort((x, y) => Date.parse(x.start) - Date.parse(y.start)) : [];
    const interval = intervals.find((i) => Date.parse(i.end) > now)
      ?? (view === 'upcoming' ? intervals.at(-1) : undefined) ?? null;
    if (view === 'queue') {
      if (interval?.look && item.reason_codes.length === 0 && item.trajectory.quality !== 'unknown'
        && item.trajectory.source && item.trajectory.points.length >= 2
        && item.sources.length > 0 && item.sources.every((source) => sourceFresh(a, source.fetched_at, now))
        && Date.parse(interval.start) <= now + 90 * 60_000 && Date.parse(interval.end) > now) {
        result.push({ item, interval, expired: false });
      }
      continue;
    }
    // A supported opportunity outside coverage cannot borrow its NET to
    // masquerade as a supported capture in another view.
    if (supported && !interval) continue;
    const start = interval?.start ?? item.launch_window.net;
    const end = interval?.end ?? (hasLaunchTimeConflict(item) ? item.launch_window.net : item.launch_window.end ?? item.launch_window.net);
    if (Date.parse(end) < Date.parse(a.coverage.from) || Date.parse(start) > Date.parse(a.coverage.until)
      || Date.parse(start) > now + horizon) continue;
    const expired = Date.parse(end) <= now;
    if (expired && (view !== 'upcoming' || now - Date.parse(end) >= 30 * 60_000)) continue;
    result.push({ item, interval, expired });
  }
  return result.sort(compare);
}

export function isLaunchPass(pass: Pick<PassEntry, 'target_id' | 'launch'>): boolean {
  return !!pass.launch || pass.target_id.startsWith('launch:');
}

export function legacyLaunchInHorizon(pass: Pick<PassEntry, 'launch'>, now: number, horizon: number): boolean {
  const net = pass.launch?.t0;
  return isLaunchUtc(net) && Date.parse(net) > now - 30 * 60_000 && Date.parse(net) <= now + horizon;
}

/** Ground ordering/preferences stay upstream; launches never enter those filters. */
export function queueSlots(ground: PassEntry[], launches: LaunchSelection[]): { ground: PassEntry[]; launches: LaunchSelection[] } {
  const selected = launches.slice().sort(compare).slice(0, 2);
  return { ground: ground.slice(0, 5 - selected.length), launches: selected };
}
export function launchCoverageLabel(state: LaunchState, now: number, view: 'upcoming' | 'map' = 'upcoming'): string {
  const a = state.artifact;
  if (!a) return state.availability === 'loading' ? 'LAUNCH: loading' : 'LAUNCH: unavailable; coverage unknown';
  const freshness = !launchFresh(state, now) ? 'STALE / EXPIRED' : state.availability === 'offline' ? 'OFFLINE' : state.availability === 'last-good' ? 'LAST GOOD; refresh unavailable' : 'CURRENT';
  const horizon = view === 'map' ? LAUNCH_MAP_HORIZON_MS : LAUNCH_HORIZON_MS;
  const until = Math.min(Date.parse(a.coverage.until), now + horizon);
  const incomplete = !a.coverage.complete || a.coverage.reasons.length > 0 || Date.parse(a.coverage.until) < now + horizon;
  return `LAUNCH: ${freshness} | Coverage ${incomplete ? 'incomplete' : 'complete'}: ${utc(a.coverage.from)} to ${utc(until)}${a.coverage.reasons.length ? ` | ${a.coverage.reasons.join(', ')}` : ''}`;
}
export function utc(value: string | number): string {
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? `${new Date(t).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC` : 'Unknown';
}
