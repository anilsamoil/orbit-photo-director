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
  return !!a && !state.superseded && Date.parse(a.generated_at) <= now && now < Date.parse(a.valid_until);
}
/** Schedule-only display tolerance; never used to admit capture instructions. */
export function launchScheduleFresh(state: LaunchState, now: number): boolean {
  const a = state.artifact;
  if (!a || state.superseded || a.coverage.reasons.some((reason) => ['SOURCE_AGE_UNKNOWN', 'SOURCE_AGE_MTIME_ONLY', 'REPLAY_SOURCE_MISMATCH'].includes(reason))) return false;
  const generated = Date.parse(a.generated_at);
  const recent = (value: string | null) => {
    const fetched = value === null ? NaN : Date.parse(value);
    return fetched <= generated && now - fetched < 3 * 3600_000;
  };
  return generated <= now && recent(a.coverage.fetched_at)
    && a.items.every((item) => item.sources.length > 0 && item.sources.every((source) => recent(source.fetched_at)));
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

/** Permission to show a current camera estimate, independent of schedule health. */
export function launchCameraEvidenceFresh(selection: LaunchSelection, state: LaunchState, now: number): boolean {
  const { item, interval, expired } = selection;
  const a = state.artifact;
  return !!a && !expired && state.availability !== 'offline' && launchFresh(state, now)
    && a.coverage.complete && a.coverage.reasons.length === 0 && sourceFresh(a, a.coverage.fetched_at, now)
    && item.status === 'geometry_supported' && item.reason_codes.length === 0
    && item.trajectory.quality !== 'unknown' && !!item.trajectory.source && item.trajectory.points.length >= 2
    && item.sources.length > 0 && item.sources.every((source) => sourceFresh(a, source.fetched_at, now))
    && !!interval?.look && inCoverage(a, interval.start, interval.end) && Date.parse(interval.end) > now;
}

/** The geometry producer defines ahead/right/aft/left in the orbital frame,
 * not compass or station-body directions. Nadir azimuth is a sentinel. */
export function launchLookDirection(look: CaptureInterval['look']): string | null {
  if (!look || look.frame !== 'orbital-lvlh' || !Number.isFinite(look.azimuth_deg)
    || !Number.isFinite(look.off_nadir_deg)) return null;
  if (look.off_nadir_deg < 0.05) return 'Straight down (nadir)';
  const directions = ['ahead', 'ahead-right', 'right', 'aft-right', 'aft', 'aft-left', 'left', 'ahead-left'];
  const sector = Math.round((((look.azimuth_deg % 360) + 360) % 360) / 45) % 8;
  return `${directions[sector]} of ISS travel; ${look.off_nadir_deg.toFixed(1)}° from straight down`;
}

export interface LaunchBrief {
  verdict: 'chance' | 'no_chance' | 'unknown' | 'passed';
  label: string; reason: string; direction: string | null; scheduleCurrent: boolean;
}

/** Planning verdict is distinct from camera evidence, schedule freshness and
 * Queue eligibility. A visible pad is a possible shot, never a plume promise. */
export function launchBrief(selection: LaunchSelection, state: LaunchState, now: number): LaunchBrief {
  const { item, interval } = selection;
  const scheduleCurrent = launchScheduleFresh(state, now);
  const brief = (verdict: LaunchBrief['verdict'], label: string, reason: string, direction: string | null = null): LaunchBrief => ({
    verdict, label, reason, direction, scheduleCurrent,
  });
  if (selection.expired) return brief('passed', 'Listed time has passed', 'No current shooting window. Check for an updated launch time.');
  if (state.availability === 'offline') return brief('unknown', 'Chance unknown', 'Offline — reconnect to check the launch time and ISS view.');
  if (state.superseded) return brief('unknown', 'Chance unknown', 'A newer launch update is available; it needs checking before assessing a shot.');
  if (!scheduleCurrent) return brief('unknown', 'Chance unknown', 'The launch schedule needs a refresh before assessing a shot.');
  if (hasLaunchTimeConflict(item)) return brief('unknown', 'Chance unknown', 'Launch sources disagree about the time.');
  if (item.reason_codes.includes('LAUNCH_UNCONFIRMED')
    || ['day', 'month', 'year'].includes(item.launch_window.precision?.toLowerCase() ?? '')) {
    return brief('unknown', 'Chance unknown', 'The liftoff time is not confirmed.');
  }
  if (launchCameraEvidenceFresh(selection, state, now)) {
    return brief('chance', 'Possible during capture window', 'Current geometry supports a possible shot; visibility through your window still needs checking.',
      launchLookDirection(interval!.look));
  }
  const assessment = item.assessment;
  if (assessment && Date.parse(assessment.checked_at) <= now && now < Date.parse(assessment.valid_until)) {
    const duration = assessment.model?.duration_seconds;
    const ascentScope = `liftoff and early ascent${duration ? ` (first ${Number((duration / 60).toFixed(1))} minutes)` : ''}`;
    if (assessment.window.verdict === 'too_far') {
      return brief('no_chance', 'Too far in listed window', `The nominal model puts ISS too far away for ${ascentScope} throughout the listed launch window. Later burns are not assessed.`);
    }
    if (Date.parse(assessment.net.at) < now) {
      return brief('unknown', 'Chance unknown', 'The planned liftoff time has passed; an updated time is needed.');
    }
    if (assessment.net.verdict === 'possible' && assessment.net.look) {
      return brief('chance', 'Possible at liftoff', 'The launch pad is in view from ISS. Delays, clouds or your window view may prevent a shot.',
        launchLookDirection(assessment.net.look));
    }
    if (assessment.net.verdict === 'too_far') {
      return brief('no_chance', 'Too far at planned time', `The nominal model puts ${ascentScope} too far from ISS. Delays may change this; later burns unassessed.`);
    }
    const reasons: Record<string, string> = {
      TIMING_UNCONFIRMED: 'The liftoff time is not confirmed.',
      EPHEMERIS_UNAVAILABLE: 'The ISS position forecast is unavailable.',
      EPHEMERIS_OUTSIDE_HORIZON: 'The launch is beyond the reliable ISS position forecast.',
      SOURCE_UNAVAILABLE: 'The launch schedule needs a refresh.',
      PROFILE_UNKNOWN: 'There is not enough information about this rocket’s ascent.',
      EVALUATION_INCOMPLETE: 'The view assessment could not be completed.',
      GEOMETRY_INVALID: 'The viewing geometry could not be established.',
      VIEW_UNCONFIRMED: 'The launch site is not directly in view; the ascent view has not been established.',
    };
    return brief('unknown', 'Chance unknown', reasons[assessment.net.reason] ?? 'The shooting chance has not been established.');
  }
  if (assessment || item.status === 'geometry_supported') {
    return brief('unknown', 'Chance unknown', 'The ISS view estimate needs a refresh; the launch schedule is still available.');
  }
  return brief('unknown', 'Chance unknown', item.trajectory.quality === 'unknown'
    ? 'The rocket’s flight path is unconfirmed, so the shooting chance is unknown.'
    : 'The shooting chance has not been established for this launch.');
}
function compare(a: LaunchSelection, b: LaunchSelection): number {
  return Date.parse(a.interval?.start ?? a.item.launch_window.net) - Date.parse(b.interval?.start ?? b.item.launch_window.net)
    || (a.item.event_id < b.item.event_id ? -1 : a.item.event_id > b.item.event_id ? 1 : 0);
}
export function selectLaunches(state: LaunchState, now: number, view: 'queue' | 'upcoming' | 'map'): LaunchSelection[] {
  const a = state.artifact;
  if (!a || (view === 'queue' && (!launchFresh(state, now) || !a.coverage.complete
    || a.coverage.reasons.length > 0 || !sourceFresh(a, a.coverage.fetched_at, now) || state.availability === 'offline'))) return [];
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
  const scheduleOnly = a.items.every((item) => item.status === 'map_only');
  const fresh = scheduleOnly ? launchScheduleFresh(state, now) : launchFresh(state, now);
  const freshness = [!fresh ? 'STALE / EXPIRED' : scheduleOnly ? 'SCHEDULE CURRENT (MAP ONLY)' : 'CURRENT',
    state.superseded ? 'SUPERSEDED; newer update pending' : '',
    state.availability === 'offline' ? 'OFFLINE' : state.availability === 'last-good' ? 'LAST GOOD; refresh unavailable' : '',
  ].filter(Boolean).join('; ');
  const horizon = view === 'map' ? LAUNCH_MAP_HORIZON_MS : LAUNCH_HORIZON_MS;
  const until = Math.min(Date.parse(a.coverage.until), now + horizon);
  const incomplete = !a.coverage.complete || a.coverage.reasons.length > 0 || Date.parse(a.coverage.until) < now + horizon;
  return `LAUNCH: ${freshness} | Schedule checked ${a.coverage.fetched_at ? utc(a.coverage.fetched_at) : 'Unknown'} | Coverage ${incomplete ? 'incomplete' : 'complete'}: ${utc(a.coverage.from)} to ${utc(until)}${a.coverage.reasons.length ? ` | ${a.coverage.reasons.join(', ')}` : ''}`;
}
export function utc(value: string | number): string {
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? `${new Date(t).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC` : 'Unknown';
}
