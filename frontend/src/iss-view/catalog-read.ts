import type { CatalogPoint } from './place-labels';

const KINDS = ['city', 'town', 'region', 'water'] as const;

function isKind(value: unknown): value is CatalogPoint['kind'] {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

export function readCatalog(value: unknown): readonly CatalogPoint[] {
  if (!Array.isArray(value)) return [];
  const points: CatalogPoint[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [kind, name, lon, lat, maxFovDeg, rank] = row;
    if (!isKind(kind) || typeof name !== 'string' || name.length === 0) continue;
    if (typeof lon !== 'number' || typeof lat !== 'number' || typeof maxFovDeg !== 'number') continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(maxFovDeg)) continue;
    const placeRank = typeof rank === 'number' && Number.isFinite(rank) ? rank : 0;
    points.push({ kind, name, lon, lat, maxFovDeg, rank: placeRank });
  }
  return points;
}
