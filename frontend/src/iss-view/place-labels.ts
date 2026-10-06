import { RENDER_RADIUS_M } from '../iss-g1/model';
import { GROUND_SHAPES, type GroundShape } from './place-shapes';

export type PlaceKind = 'country' | 'city' | 'town' | 'region' | 'water';

export type CatalogPoint = {
  kind: 'city' | 'town' | 'region' | 'water';
  name: string;
  lon: number;
  lat: number;
  maxFovDeg: number;
};

export type PlaceLabel = {
  kind: PlaceKind;
  name: string;
  lon: number;
  lat: number;
};

export const PLACE_CITIES: readonly PlaceLabel[] = [
  { kind: 'city', name: 'Beijing', lon: 116.39, lat: 39.9 },
  { kind: 'city', name: 'Bogota', lon: -74.09, lat: 4.6 },
  { kind: 'city', name: 'Cairo', lon: 31.25, lat: 30.05 },
  { kind: 'city', name: 'Cape Town', lon: 18.43, lat: -33.92 },
  { kind: 'city', name: 'Hong Kong', lon: 114.18, lat: 22.31 },
  { kind: 'city', name: 'Istanbul', lon: 28.97, lat: 41.02 },
  { kind: 'city', name: 'Jakarta', lon: 106.83, lat: -6.17 },
  { kind: 'city', name: 'Kolkata', lon: 88.37, lat: 22.57 },
  { kind: 'city', name: 'Lagos', lon: 3.39, lat: 6.45 },
  { kind: 'city', name: 'London', lon: -0.12, lat: 51.5 },
  { kind: 'city', name: 'Los Angeles', lon: -118.23, lat: 34.05 },
  { kind: 'city', name: 'Mexico City', lon: -99.13, lat: 19.44 },
  { kind: 'city', name: 'Moscow', lon: 37.61, lat: 55.75 },
  { kind: 'city', name: 'Mumbai', lon: 72.88, lat: 19.07 },
  { kind: 'city', name: 'Nairobi', lon: 36.81, lat: -1.28 },
  { kind: 'city', name: 'New York', lon: -74.0, lat: 40.72 },
  { kind: 'city', name: 'Paris', lon: 2.35, lat: 48.86 },
  { kind: 'city', name: 'Rio de Janeiro', lon: -43.21, lat: -22.91 },
  { kind: 'city', name: 'Riyadh', lon: 46.72, lat: 24.63 },
  { kind: 'city', name: 'Rome', lon: 12.48, lat: 41.9 },
  { kind: 'city', name: 'Santiago', lon: -70.65, lat: -33.44 },
  { kind: 'city', name: 'Shanghai', lon: 121.43, lat: 31.22 },
  { kind: 'city', name: 'Singapore', lon: 103.85, lat: 1.29 },
  { kind: 'city', name: 'Sydney', lon: 151.21, lat: -33.87 },
  { kind: 'city', name: 'São Paulo', lon: -46.63, lat: -23.56 },
  { kind: 'city', name: 'Tokyo', lon: 139.75, lat: 35.69 },
  { kind: 'city', name: 'Washington D.C.', lon: -77.01, lat: 38.9 },
];

const DEG = Math.PI / 180;

export function namesAt(latDeg: number, lonDeg: number): { country: string; water: string } {
  const country = firstHit('country', latDeg, lonDeg);
  return { country, water: country ? '' : firstHit('water', latDeg, lonDeg) };
}

/** Straight down sees only a few degrees, so the subsatellite point is always included. */
export function placesOnDisk(
  latDeg: number,
  lonDeg: number,
  altitudeM: number,
  bearingDeg: number,
  pitchDeg: number,
  fovDeg = 90,
  catalog: readonly CatalogPoint[] = [],
): PlaceLabel[] {
  const reach = limbDeg(altitudeM) - 2;
  if (!(reach > 1)) return [];
  const labels: PlaceLabel[] = [];
  pushGround(labels, latDeg, lonDeg);
  for (let dLat = -reach; dLat <= reach; dLat += 2) {
    for (let dLon = -reach; dLon <= reach; dLon += 2) {
      const lat = latDeg + dLat;
      const lon = wrapLon(lonDeg + dLon);
      if (lat < -85 || lat > 85) continue;
      const sep = separationDeg(latDeg, lonDeg, lat, lon);
      if (sep < 0.8 || sep > reach) continue;
      if (pitchDeg > 45 && bearingDelta(bearingDeg, bearingTo(latDeg, lonDeg, lat, lon)) > 100) continue;
      pushGround(labels, lat, lon);
    }
  }
  pushOnDisk(labels, PLACE_CITIES, latDeg, lonDeg, reach, bearingDeg, pitchDeg);
  const tiered = catalog.filter((point) => fovDeg <= point.maxFovDeg);
  pushOnDisk(labels, tiered, latDeg, lonDeg, reach, bearingDeg, pitchDeg);
  return labels;
}

function pushOnDisk(
  labels: PlaceLabel[],
  places: readonly PlaceLabel[],
  latDeg: number,
  lonDeg: number,
  reach: number,
  bearingDeg: number,
  pitchDeg: number,
): void {
  for (const place of places) {
    const sep = separationDeg(latDeg, lonDeg, place.lat, place.lon);
    if (sep > reach) continue;
    if (pitchDeg > 45 && sep > 0.8 && bearingDelta(bearingDeg, bearingTo(latDeg, lonDeg, place.lat, place.lon)) > 100) continue;
    labels.push(place);
  }
}

function pushGround(labels: PlaceLabel[], lat: number, lon: number): void {
  const named = namesAt(lat, lon);
  if (named.country) labels.push({ kind: 'country', name: named.country, lon, lat });
  if (named.water) labels.push({ kind: 'water', name: named.water, lon, lat });
}

function firstHit(kind: 'country' | 'water', lat: number, lon: number): string {
  for (const shape of GROUND_SHAPES) {
    if (shape.kind !== kind || !shapeContains(shape, lon, lat)) continue;
    return shape.name;
  }
  return '';
}

function shapeContains(shape: GroundShape, lon: number, lat: number): boolean {
  const [minLon, minLat, maxLon, maxLat] = shape.bounds;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return false;
  const [outer, ...holes] = shape.rings;
  if (!outer || !ringContains(outer, lon, lat)) return false;
  return holes.every((hole) => !ringContains(hole, lon, lat));
}

function ringContains(ring: readonly number[], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i] ?? 0;
    const yi = ring[i + 1] ?? 0;
    const xj = ring[j] ?? 0;
    const yj = ring[j + 1] ?? 0;
    if ((yi > lat) === (yj > lat) || yj === yi) continue;
    const x = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (lon < x) inside = !inside;
  }
  return inside;
}

function limbDeg(altitudeM: number): number {
  const ratio = RENDER_RADIUS_M / (RENDER_RADIUS_M + Math.max(0, altitudeM));
  if (!(ratio > 0) || ratio >= 1) return 0;
  return (Math.acos(ratio) * 180) / Math.PI;
}

function separationDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return (Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))) * 2) / DEG;
}

function bearingTo(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
  const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

function bearingDelta(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function wrapLon(lon: number): number {
  return (((lon + 180) % 360) + 360) % 360 - 180;
}
