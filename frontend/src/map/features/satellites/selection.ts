import { CURATED_SATELLITES, metaKey, type SatelliteMeta } from '../../../satellites';
import { PREF_KEYS } from '../../map-core/prefs';

export function readSelectedKeys(): string[] {
  try {
    const raw = localStorage.getItem(PREF_KEYS.selectedSatellites);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function persistSelectedKeys(keys: Iterable<string>): void {
  try {
    localStorage.setItem(PREF_KEYS.selectedSatellites, JSON.stringify([...keys]));
  } catch {}
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

/** A persisted selection key back to its meta: curated first, then the
 *  `name:` and numeric shapes the box produces. Anything else is dropped. */
export function metaForKey(key: string): SatelliteMeta | null {
  const curated = CURATED_SATELLITES.find((meta) => metaKey(meta) === key);
  if (curated) return curated;
  if (key.startsWith('name:')) return nameSearchMeta(key.slice(5));
  if (/^\d+$/.test(key)) return noradMeta(Number(key));
  return null;
}
