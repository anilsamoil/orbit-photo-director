import type { Manifest } from './types';
import { fetchArtifact } from './manifest';

export type TrackedElements = {
  readonly state: 'elements';
  readonly id: string;
  readonly label: string;
  readonly color: string;
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

export type TrackedUnavailable = {
  readonly state: 'unavailable';
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly reason: 'no_public_orbit' | 'aged_out' | 'lookup_failed';
};

export type TrackedRecord = TrackedElements | TrackedUnavailable;

const REASONS = ['no_public_orbit', 'aged_out', 'lookup_failed'] as const;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z0-9-]+$/;

export const UNPUBLISHED_TRACKED: readonly TrackedRecord[] = [
  {
    id: 'starship',
    label: 'Starship',
    color: '#ff5c5c',
    state: 'unavailable',
    reason: 'no_public_orbit',
  },
];

export function statusText(record: TrackedRecord): string {
  if (record.state === 'unavailable') {
    if (record.reason === 'aged_out') return `${record.label}: public orbit expired`;
    if (record.reason === 'lookup_failed') return `${record.label}: orbit lookup failed`;
    return `${record.label}: no public orbit yet`;
  }
  const cached = record.from_cache ? ' (last good)' : '';
  return `${record.label}: ${record.name}${cached}`;
}

/** Mean motion is TLE line 2 columns 53-63, in revolutions per day. */
export function orbitPeriodSeconds(line2: string): number | null {
  if (line2.length < 63) return null;
  const motion = Number(line2.slice(52, 63));
  if (!Number.isFinite(motion) || motion <= 0) return null;
  return 86400 / motion;
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
  return parseTracked(raw) ?? UNPUBLISHED_TRACKED;
}

export async function loadTrackedRecords(manifest: Manifest): Promise<readonly TrackedRecord[]> {
  try {
    return recordsFromArtifact(await fetchArtifact<unknown>(manifest, 'tracked'));
  } catch {
    return UNPUBLISHED_TRACKED;
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
  if (row.state === 'unavailable') {
    if (typeof row.reason !== 'string' || !(REASONS as readonly string[]).includes(row.reason)) {
      return null;
    }
    return {
      state: 'unavailable',
      id,
      label,
      color,
      reason: row.reason as TrackedUnavailable['reason'],
    };
  }
  if (row.state !== 'elements') return null;
  if (row.source !== 'gp' && row.source !== 'supgp') return null;
  if (typeof row.name !== 'string' || row.name.length === 0) return null;
  if (typeof row.norad !== 'number' || !Number.isInteger(row.norad)) return null;
  if (typeof row.intldes !== 'string') return null;
  if (typeof row.line1 !== 'string' || !row.line1.startsWith('1 ')) return null;
  if (typeof row.line2 !== 'string' || !row.line2.startsWith('2 ')) return null;
  if (typeof row.epoch !== 'string' || typeof row.age_hours !== 'number') return null;
  const elements: TrackedElements = {
    state: 'elements',
    id,
    label,
    color,
    source: row.source,
    name: row.name,
    norad: row.norad,
    intldes: row.intldes,
    line1: row.line1,
    line2: row.line2,
    epoch: row.epoch,
    age_hours: row.age_hours,
  };
  if (row.from_cache === true) return { ...elements, from_cache: true };
  return elements;
}
