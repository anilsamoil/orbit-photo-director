import type { LaunchCatalog, LaunchCatalogItem, ShotEnvelope } from './launch-schema';
import { ALL_LAUNCHES_HORIZON_MS } from './iss-view/launches';
import { LAUNCH_HORIZON_MS, LAUNCH_MAP_HORIZON_MS } from './launch-selectors';

export type Tier = LaunchCatalogItem['tier'];

/** Shot or Likely with a top envelope. Watch cannot inhabit this type. */
export interface Highlight extends TierLaunch {
  readonly tier: 'shot' | 'likely';
  readonly top: TierShot;
}

export interface TrackPoint {
  readonly lat: number;
  readonly lon: number;
  readonly altKm: number;
  readonly tOffsetS: number;
}

/** At least two ascent points. It exists only when the item direction is not none. */
export interface Corridor {
  readonly points: readonly [TrackPoint, TrackPoint, ...TrackPoint[]];
}

export interface ShotProvenance {
  readonly evaluatedAt: string;
  readonly direction: {
    readonly kind: LaunchCatalogItem['direction']['kind'];
    readonly azimuthDeg: number | null;
    readonly source: string | null;
    readonly offPlaneDeg: number | null;
  };
}

export interface TierShot {
  readonly subject: 'pad' | 'ascent';
  readonly bestMs: number;
  readonly endMs: number;
  readonly score: { readonly low: number; readonly high: number };
  readonly provenance: ShotProvenance | null;
}

export interface TierSchedule {
  readonly netMs: number;
  readonly windowStartMs: number | null;
  readonly windowEndMs: number | null;
  readonly precision: string | null;
  readonly status: string;
}

export interface TierLaunch {
  readonly eventId: string;
  readonly revision: string;
  readonly name: string;
  readonly site: { readonly name: string; readonly lat: number; readonly lon: number };
  readonly tier: Tier;
  readonly why: string;
  readonly reasons: readonly string[];
  readonly schedule: TierSchedule;
  readonly top: TierShot | null;
  readonly corridor: Corridor | null;
  readonly whenMs: number;
  readonly liveUntilMs: number;
}

export interface TierCatalog {
  readonly revision: string;
  readonly pins: readonly Highlight[];
  readonly upcoming: readonly Highlight[];
  readonly highlights: readonly Highlight[];
  readonly groups: {
    readonly shot: readonly Highlight[];
    readonly likely: readonly Highlight[];
    readonly watch: readonly TierLaunch[];
  };
  readonly all: readonly TierLaunch[];
  readonly closedLabel: string;
  find(eventId: string): TierLaunch | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const SCHEDULE_PRECISION = new Set(['second', 'minute', 'hour']);
const MISSION_CODE = /^[A-Za-z][A-Za-z0-9]*-\d+[A-Za-z0-9]*$/;
const HIGHLIGHT_LIMIT = 3;

export function tierWord(tier: Tier): string {
  if (tier === 'shot') return 'Shot';
  if (tier === 'likely') return 'Likely';
  if (tier === 'watch') return 'Watch';
  if (tier === 'unassessed') return 'Unassessed';
  return 'No shot';
}

export function monthDay(ms: number): string {
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export function missionCode(name: string): string {
  const trimmed = name.trim();
  const tokens = trimmed.split(/\s+/);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token && MISSION_CODE.test(token)) return token;
  }
  return trimmed;
}

export function tierLabel(launch: TierLaunch): string {
  return `${missionCode(launch.name)} · ${tierWord(launch.tier)} · ${monthDay(launch.schedule.netMs)}`;
}

export function scheduleLabel(launch: TierLaunch): string {
  return `${launch.name} · ${launch.site.name} · ${monthDay(launch.schedule.netMs)}`;
}

function instant(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function provenanceOf(shot: ShotEnvelope): ShotProvenance | null {
  if (shot.evaluated_at === undefined || shot.direction === undefined) return null;
  const direction = shot.direction;
  return {
    evaluatedAt: shot.evaluated_at,
    direction: {
      kind: direction.kind,
      azimuthDeg: direction.azimuth_deg,
      source: direction.source,
      offPlaneDeg: direction.off_plane_deg,
    },
  };
}

function toTierShot(shot: ShotEnvelope): TierShot | null {
  const bestMs = Date.parse(shot.best);
  const endMs = Date.parse(shot.end);
  if (!Number.isFinite(bestMs) || !Number.isFinite(endMs)) return null;
  return {
    subject: shot.subject,
    bestMs,
    endMs,
    score: { low: shot.score.low, high: shot.score.high },
    provenance: provenanceOf(shot),
  };
}

function shotOrder(a: ShotEnvelope, b: ShotEnvelope): number {
  if (a.score.low !== b.score.low) return b.score.low - a.score.low;
  const best = Date.parse(a.best) - Date.parse(b.best);
  if (best !== 0) return best;
  if (a.subject === b.subject) return 0;
  return a.subject < b.subject ? -1 : 1;
}

function corridorOf(item: LaunchCatalogItem): Corridor | null {
  if (item.direction.kind === 'none') return null;
  const ascent = item.shots.filter((shot) => shot.subject === 'ascent' && shot.track.length >= 2).sort(shotOrder);
  const best = ascent[0];
  if (!best) return null;
  const points = best.track.map((point) => ({
    lat: point.lat,
    lon: point.lon,
    altKm: point.alt_km,
    tOffsetS: point.t_offset_s,
  }));
  const [first, second, ...rest] = points;
  if (!first || !second) return null;
  return { points: [first, second, ...rest] };
}

function toTierLaunch(item: LaunchCatalogItem): TierLaunch {
  const shots = item.shots.flatMap((shot) => {
    const tierShot = toTierShot(shot);
    return tierShot ? [tierShot] : [];
  });
  const ranked = item.shots.filter((shot) => toTierShot(shot) !== null).sort(shotOrder);
  const top = ranked[0] ? toTierShot(ranked[0]) : null;
  const netMs = Date.parse(item.schedule.net);
  const windowEndMs = instant(item.schedule.window_end);
  let liveUntilMs = Number.isFinite(netMs) ? netMs : Number.NaN;
  if (windowEndMs !== null && windowEndMs > liveUntilMs) liveUntilMs = windowEndMs;
  for (const shot of shots) if (shot.endMs > liveUntilMs) liveUntilMs = shot.endMs;
  return {
    eventId: item.event_id,
    revision: item.revision,
    name: item.name,
    site: { name: item.site.name, lat: item.site.lat, lon: item.site.lon },
    tier: item.tier,
    why: item.why,
    reasons: item.reasons.slice(),
    schedule: {
      netMs,
      windowStartMs: instant(item.schedule.window_start),
      windowEndMs,
      precision: item.schedule.precision,
      status: item.schedule.status,
    },
    top,
    corridor: corridorOf(item),
    whenMs: top?.bestMs ?? netMs,
    liveUntilMs,
  };
}

function isHighlight(launch: TierLaunch): launch is Highlight {
  return (launch.tier === 'shot' || launch.tier === 'likely') && launch.top !== null;
}

function byRank(a: Highlight, b: Highlight): number {
  if (a.tier !== b.tier) return a.tier === 'shot' ? -1 : 1;
  if (a.top.score.low !== b.top.score.low) return b.top.score.low - a.top.score.low;
  if (a.whenMs !== b.whenMs) return a.whenMs - b.whenMs;
  if (a.eventId < b.eventId) return -1;
  if (a.eventId > b.eventId) return 1;
  return 0;
}

function byWhen(a: TierLaunch, b: TierLaunch): number {
  if (a.whenMs !== b.whenMs) return a.whenMs - b.whenMs;
  if (a.eventId < b.eventId) return -1;
  if (a.eventId > b.eventId) return 1;
  return 0;
}

function byNet(a: TierLaunch, b: TierLaunch): number {
  if (a.schedule.netMs !== b.schedule.netMs) return a.schedule.netMs - b.schedule.netMs;
  if (a.eventId < b.eventId) return -1;
  if (a.eventId > b.eventId) return 1;
  return 0;
}

function passesAll(launch: TierLaunch, now: number): boolean {
  if (launch.tier === 'none') return false;
  if (launch.reasons.includes('LAUNCH_UNCONFIRMED')) return false;
  const precision = launch.schedule.precision?.toLowerCase() ?? '';
  if (!SCHEDULE_PRECISION.has(precision)) return false;
  const net = launch.schedule.netMs;
  if (!Number.isFinite(net) || net < now || net > now + ALL_LAUNCHES_HORIZON_MS) return false;
  const end = launch.schedule.windowEndMs ?? net;
  return end > now;
}

/** The only projection. Null unless both leases hold and generated_at is not still ahead of now. */
export function tiersAt(catalog: LaunchCatalog, now: number): TierCatalog | null {
  const generated = Date.parse(catalog.generated_at);
  const schedule = Date.parse(catalog.schedule_valid_until);
  const geometry = Date.parse(catalog.geometry_valid_until);
  if (!(generated <= now && now < schedule && now < geometry)) return null;
  const live = catalog.items.map(toTierLaunch).filter((launch) => launch.liveUntilMs > now);
  const pins = live
    .filter(isHighlight)
    .filter((launch) => Number.isFinite(launch.schedule.netMs) && launch.schedule.netMs <= now + LAUNCH_MAP_HORIZON_MS)
    .sort(byRank);
  const highlights = pins.slice(0, HIGHLIGHT_LIMIT);
  const upcoming = pins.filter((launch) => launch.schedule.netMs <= now + LAUNCH_HORIZON_MS);
  const watch = live
    .filter((launch) => launch.tier === 'watch' && Number.isFinite(launch.schedule.netMs) && launch.schedule.netMs <= now + ALL_LAUNCHES_HORIZON_MS)
    .sort(byWhen);
  const all = live.filter((launch) => passesAll(launch, now)).sort(byNet);
  const lookup = new Map<string, TierLaunch>();
  for (const launch of [...pins, ...watch, ...all]) lookup.set(launch.eventId, launch);
  const top = highlights[0];
  return {
    revision: catalog.revision,
    pins,
    upcoming,
    highlights,
    groups: {
      shot: pins.filter((launch) => launch.tier === 'shot'),
      likely: pins.filter((launch) => launch.tier === 'likely'),
      watch,
    },
    all,
    closedLabel: top ? tierLabel(top) : 'Choose launch',
    find(eventId: string) {
      return lookup.get(eventId) ?? null;
    },
  };
}
