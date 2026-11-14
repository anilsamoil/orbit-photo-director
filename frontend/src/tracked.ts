import type { Manifest } from './types';
import { fetchArtifact } from './manifest';

/** A Starship set is fresh for 12 h after its epoch. Past that it is still
 *  drawn, labelled stale, until 72 h: a feed outage or a late update must
 *  not erase a ship that still propagates and has not reentered.
 *  `generator/tracked.py` holds the same two values. */
export const STARSHIP_FRESH_HOURS = 12;
export const STARSHIP_GRACE_HOURS = 72;

/** How the publisher found this object, so a browser can repeat the same
 *  lookup against the same two feeds. A set is fresh until `max_age_hours`
 *  after its epoch and drawn until `grace_hours`. */
export type TrackedLookup = {
  readonly names: readonly string[];
  readonly patterns: readonly string[];
  readonly max_age_hours: number;
  readonly grace_hours: number;
  readonly catnr?: number;
  readonly intldes?: string;
};

export type TrackedObject = {
  readonly source: 'gp' | 'supgp';
  readonly name: string;
  readonly norad: number;
  readonly intldes: string;
  readonly line1: string;
  readonly line2: string;
  readonly epoch: string;
  readonly age_hours: number;
  readonly from_cache?: boolean;
};

/** The row's own element set is the object drawn. `also` is every other
 *  live object the lookup matched. */
export type TrackedElements = TrackedObject & {
  readonly state: 'elements';
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly lookup: TrackedLookup;
  readonly also?: readonly TrackedObject[];
};

export type TrackedUnavailable = {
  readonly state: 'unavailable';
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly lookup: TrackedLookup;
  /** `unread` is never published. It is this browser failing to load the artifact. */
  readonly reason: 'no_public_orbit' | 'aged_out' | 'reentered' | 'lookup_failed' | 'unread';
};

export type TrackedRecord = TrackedElements | TrackedUnavailable;

const REASONS = ['no_public_orbit', 'aged_out', 'reentered', 'lookup_failed'] as const;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z0-9-]+$/;

/** The generator's own no-data artifact, and the built-in lookup rules. */
export const UNPUBLISHED_TRACKED: readonly TrackedRecord[] = [
  {
    id: 'starship',
    label: 'Starship',
    color: '#ff5c5c',
    state: 'unavailable',
    reason: 'lookup_failed',
    lookup: {
      names: ['STARSHIP', 'SHIP'],
      patterns: ['^STARSHIP(?:[\\s-]|$)(?!.*\\bDEB\\b)', '^SHIP[\\s-]+\\d+\\b(?!.*\\bDEB\\b)'],
      max_age_hours: STARSHIP_FRESH_HOURS,
      grace_hours: STARSHIP_GRACE_HOURS,
    },
  },
];

/** What the map assumes when `tracked.json` cannot be read. An unread
 *  artifact is a failed lookup by this browser, never a confirmed absence
 *  and never the publisher's failure. */
export const UNREAD_TRACKED: readonly TrackedRecord[] = UNPUBLISHED_TRACKED.map((record) => ({
  id: record.id,
  label: record.label,
  color: record.color,
  lookup: record.lookup,
  state: 'unavailable',
  reason: 'unread',
}));

const NO_LOOKUP: TrackedLookup = { names: [], patterns: [], max_age_hours: 12, grace_hours: 12 };

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** A row from a publisher that predates `lookup` keeps the built-in rules
 *  for its id, and one that predates `grace_hours` the built-in grace. */
function parseLookup(id: string, raw: unknown): TrackedLookup {
  const builtIn = UNPUBLISHED_TRACKED.find((record) => record.id === id)?.lookup ?? NO_LOOKUP;
  if (!raw || typeof raw !== 'object') return builtIn;
  const row = raw as Record<string, unknown>;
  if (!isStrings(row.names) || !isStrings(row.patterns)) return builtIn;
  if (typeof row.max_age_hours !== 'number' || !(row.max_age_hours > 0)) return builtIn;
  const lookup: { -readonly [K in keyof TrackedLookup]: TrackedLookup[K] } = {
    names: row.names,
    patterns: row.patterns,
    max_age_hours: row.max_age_hours,
    grace_hours:
      typeof row.grace_hours === 'number' && row.grace_hours >= row.max_age_hours
        ? row.grace_hours
        : Math.max(row.max_age_hours, builtIn.grace_hours),
  };
  if (typeof row.catnr === 'number' && Number.isInteger(row.catnr) && row.catnr > 0) lookup.catnr = row.catnr;
  if (typeof row.intldes === 'string' && row.intldes.length > 0) lookup.intldes = row.intldes;
  return lookup;
}

/** Mean motion is TLE line 2 columns 53-63, in revolutions per day. */
export function orbitPeriodSeconds(line2: string): number | null {
  if (line2.length < 63) return null;
  const motion = Number(line2.slice(52, 63));
  if (!Number.isFinite(motion) || motion <= 0) return null;
  return 86400 / motion;
}

export const REENTRY_PERIGEE_KM = 80;
const EARTH_MU_KM3_S2 = 398600.4418;
const EARTH_RADIUS_KM = 6378.137;

/** A perigee this low does not survive its next pass. The set is real until
 *  then, so a suborbital flight-day set still draws for its first
 *  revolution. Eccentricity is line 2 columns 27-33 with an implied decimal
 *  point. An unreadable field counts as not reentered. */
export function reentered(line2: string, epochMs: number, nowMs: number): boolean {
  const periodS = orbitPeriodSeconds(line2);
  const eccentricity = line2.slice(26, 33);
  if (periodS === null || !/^\d{7}$/.test(eccentricity)) return false;
  const rate = (2 * Math.PI) / periodS;
  const perigeeKm = Math.cbrt(EARTH_MU_KM3_S2 / rate ** 2) * (1 - Number(`0.${eccentricity}`)) - EARTH_RADIUS_KM;
  return perigeeKm < REENTRY_PERIGEE_KM && nowMs - epochMs > periodS * 1000;
}

export function parseTracked(raw: unknown): TrackedRecord[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const objects = (raw as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) return null;
  const rows: TrackedRecord[] = [];
  for (const item of objects) {
    const row = parseOne(item);
    if (row) rows.push(row);
  }
  return rows.length > 0 ? rows : null;
}

export function recordsFromArtifact(raw: unknown): readonly TrackedRecord[] {
  return parseTracked(raw) ?? UNREAD_TRACKED;
}

export async function loadTrackedRecords(manifest: Manifest): Promise<readonly TrackedRecord[]> {
  try {
    return recordsFromArtifact(await fetchArtifact<unknown>(manifest, 'tracked'));
  } catch {
    return UNREAD_TRACKED;
  }
}

function parseOne(item: unknown): TrackedRecord | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const id = row.id;
  const label = row.label;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof label !== 'string' || label.length === 0) return null;
  const color = typeof row.color === 'string' && COLOR.test(row.color) ? row.color : '#ff5c5c';
  const lookup = parseLookup(id, row.lookup);
  if (row.state === 'unavailable') {
    if (typeof row.reason !== 'string' || !(REASONS as readonly string[]).includes(row.reason)) {
      return null;
    }
    return {
      state: 'unavailable',
      id,
      label,
      color,
      lookup,
      reason: row.reason as TrackedUnavailable['reason'],
    };
  }
  if (row.state !== 'elements') return null;
  const primary = parseObject(row);
  if (!primary) return null;
  const also = (Array.isArray(row.also) ? row.also : []).flatMap((entry) => parseObject(entry) ?? []);
  const elements: TrackedElements = { state: 'elements', id, label, color, lookup, ...primary };
  return also.length > 0 ? { ...elements, also } : elements;
}

function parseObject(item: unknown): TrackedObject | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  if (row.source !== 'gp' && row.source !== 'supgp') return null;
  if (typeof row.name !== 'string' || row.name.length === 0) return null;
  if (typeof row.norad !== 'number' || !Number.isInteger(row.norad)) return null;
  if (typeof row.intldes !== 'string') return null;
  if (typeof row.line1 !== 'string' || !row.line1.startsWith('1 ')) return null;
  if (typeof row.line2 !== 'string' || !row.line2.startsWith('2 ')) return null;
  if (typeof row.epoch !== 'string' || typeof row.age_hours !== 'number') return null;
  const object: TrackedObject = {
    source: row.source,
    name: row.name,
    norad: row.norad,
    intldes: row.intldes,
    line1: row.line1,
    line2: row.line2,
    epoch: row.epoch,
    age_hours: row.age_hours,
  };
  return row.from_cache === true ? { ...object, from_cache: true } : object;
}
