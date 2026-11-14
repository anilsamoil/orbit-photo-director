import { CURATED_SATELLITES, metaKey, type SatelliteMeta } from '../../../satellites';
import type { TrackedRecord } from '../../../tracked';
import { PREF_KEYS } from '../../map-core/prefs';

function keysIn(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function readSelectedKeys(): string[] {
  try {
    return keysIn(localStorage.getItem(PREF_KEYS.selectedSatellites));
  } catch {
    return [];
  }
}

export function persistSelectedKeys(keys: Iterable<string>): void {
  try {
    localStorage.setItem(PREF_KEYS.selectedSatellites, JSON.stringify([...keys]));
  } catch {}
}

/** A published vehicle is on until the operator unchecks it, so the list
 *  kept is the ones turned off. */
export function readHiddenPublishedKeys(): Set<string> {
  try {
    return new Set(keysIn(localStorage.getItem(PREF_KEYS.hiddenPublishedSatellites)));
  } catch {
    return new Set();
  }
}

export function setPublishedHidden(key: string, hidden: boolean): void {
  const keys = readHiddenPublishedKeys();
  if (hidden) keys.add(key);
  else keys.delete(key);
  try {
    localStorage.setItem(PREF_KEYS.hiddenPublishedSatellites, JSON.stringify([...keys]));
  } catch {}
}

export function isPublished(meta: SatelliteMeta): boolean {
  return meta.resolution.kind === 'published';
}

/** Every published vehicle the picker lists: the curated ones, then each
 *  row of `tracked.json` that no curated satellite already covers. */
export function publishedMetas(records: readonly TrackedRecord[]): SatelliteMeta[] {
  const curated = CURATED_SATELLITES.filter(isPublished);
  const curatedKeys = new Set(curated.map(metaKey));
  const curatedNorads = new Set(
    CURATED_SATELLITES.flatMap(({ resolution }) => (resolution.kind === 'catnr' ? [resolution.catnr] : [])),
  );
  const extra: SatelliteMeta[] = [];
  for (const record of records) {
    const meta: SatelliteMeta = {
      name: record.label,
      short_label: record.label.slice(0, 3),
      track_color: record.color,
      icon: '🚀',
      resolution: { kind: 'published', id: record.id },
    };
    if (curatedKeys.has(metaKey(meta))) continue;
    const norad = record.state === 'elements' ? record.norad : record.lookup.catnr;
    if (norad !== undefined && curatedNorads.has(norad)) continue;
    extra.push(meta);
  }
  return [...curated, ...extra];
}

export function noradMeta(catnr: number): SatelliteMeta {
  return {
    name: `NORAD ${catnr}`,
    short_label: String(catnr).slice(-3),
    track_color: '#888',
    icon: '🛰',
    resolution: { kind: 'catnr', catnr },
  };
}

export function nameSearchMeta(query: string): SatelliteMeta {
  return {
    name: query,
    short_label: query.slice(0, 3),
    track_color: '#aaa',
    icon: '🔍',
    resolution: { kind: 'name', query },
  };
}

/** What the operator typed into the box: digits are a NORAD number,
 *  anything else a CelesTrak name search in upper case. */
export function metaForQuery(query: string): SatelliteMeta {
  if (/^\d+$/.test(query)) return noradMeta(Number(query));
  return nameSearchMeta(query.toUpperCase());
}

const RETIRED_STARSHIP_KEY = 'name:STARSHIP';

/** A persisted selection key back to its meta: curated first, then the
 *  `name:` and numeric shapes the box produces. Anything else is dropped,
 *  and so is the name search Starship used before it was published. */
export function metaForKey(key: string): SatelliteMeta | null {
  const curated = CURATED_SATELLITES.find((meta) => metaKey(meta) === key);
  if (curated) return isPublished(curated) ? null : curated;
  if (key === RETIRED_STARSHIP_KEY) return null;
  if (key.startsWith('name:')) return nameSearchMeta(key.slice(5));
  if (/^\d+$/.test(key)) return noradMeta(Number(key));
  return null;
}
