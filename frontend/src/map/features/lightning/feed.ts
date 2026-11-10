import { greatCircleKm } from '../../../pin-drop';
import type { LngLat } from '../../map-core/geometry';

type Cell = [lon: number, lat: number, offsetSeconds: number, count: number];
type Sector = { satellite: string; centerLon: number; cells: Cell[] | null };
export type LightningFeed = { start: number; end: number; sectors: Sector[]; radiusKm: number };
export const STALE_MS = 8 * 60_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function utc(value: unknown): number {
  return typeof value === 'string' && /(?:Z|\+00:00)$/.test(value) ? Date.parse(value) : NaN;
}

function isCell(value: unknown, duration: number): value is Cell {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [lon, lat, offset, count] = value;
  return Number.isFinite(lon) && Math.abs(lon) <= 180 && Number.isFinite(lat) && Math.abs(lat) <= 90
    && Number.isInteger(offset) && offset >= 0 && offset < duration
    && Number.isSafeInteger(count) && count >= 1;
}

export function parseLightningFeed(raw: unknown, now: number): LightningFeed {
  const invalid = () => new Error('Invalid GLM overlay');
  if (!record(raw) || raw.schema !== 1 || raw.radius_km !== 5500
      || !Array.isArray(raw.sectors) || raw.sectors.length !== 2) throw invalid();
  const start = utc(raw.start);
  const end = utc(raw.end);
  const generated = utc(raw.generated_at);
  if (!(end - start === 300_000 && end <= generated && generated <= now + 60_000 && end <= now)) throw invalid();
  const sectors: Sector[] = [];
  for (const sector of raw.sectors) {
    if (!record(sector)) throw invalid();
    const { satellite, center_lon: centerLon, cells } = sector;
    if (!((satellite === 'GOES-19' && centerLon === -75.2) || (satellite === 'GOES-18' && centerLon === -137))
        || sectors.some(s => s.satellite === satellite)
        || !(cells === null || (Array.isArray(cells) && cells.length <= 512 && cells.every(c => isCell(c, 300))))) throw invalid();
    sectors.push({ satellite, centerLon, cells });
  }
  return { start, end, sectors, radiusKm: raw.radius_km };
}

export function observationLabel(feed: LightningFeed, now: number, [lon, lat]: LngLat): string {
  const sectorDistance = (sector: Sector) => greatCircleKm(lat, lon, 0, sector.centerLon);
  const sector = feed.sectors.reduce((a, b) => sectorDistance(a) <= sectorDistance(b) ? a : b);
  const age = Math.floor((now - feed.end) / 60_000);
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const period = `${hhmm(feed.start)}–${hhmm(feed.end)} UTC · feed ${age}m old`;
  const stale = now - feed.end >= STALE_MS ? ' · stale' : '';
  if (sectorDistance(sector) > feed.radiusKm) return `Map center outside GLM coverage · ${period}${stale}`;
  const count = sector.cells?.reduce((sum, cell) => sum + cell[3], 0);
  const activity = count === undefined ? 'unavailable' : `${count.toLocaleString()} observed flash${count === 1 ? '' : 'es'}`;
  return `${sector.satellite} sector · ${activity} · ${period}${stale}`;
}

export function flashFeatures(feed: LightningFeed, now: number): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: 'FeatureCollection',
    features: feed.sectors.flatMap(sector => (sector.cells ?? []).map(([lon, lat, offset]) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [lon, lat] },
      properties: { ageSeconds: (now - feed.start) / 1000 - offset },
    }))),
  };
}
