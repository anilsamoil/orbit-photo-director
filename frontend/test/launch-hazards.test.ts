import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LaunchCatalogStore, launchCatalog } from '../src/launch-catalog';
import {
  activeHazardFeatures,
  HAZARD_LABEL,
  loadPublishedHazards,
  parseHazardBundle,
  STARSHIP_FLIGHT15_EVENT_ID,
  STARSHIP_FLIGHT15_HAZARD_PATH,
  type HazardBundle,
  type HazardNotice,
} from '../src/launch-hazards';
import { parseLaunchArtifact } from '../src/launch-schema';
import { renderTierCard, openTierDetails } from '../src/launch-tier-card';
import { tiersAt, type TierLaunch } from '../src/launch-tiers';
import { createClock } from '../src/map/map-core/clock';
import { createMapCore } from '../src/map/map-core/core';
import {
  bindAscentPad,
  focusLaunchOnMap,
  launchHazardFillLayer,
  launchHazardOutlineLayer,
  noteLaunchCore,
  reloadLaunchHazards,
  resetLaunchForTest,
  syncLaunchHazards,
  syncMapLaunchMode,
  useHazardBundleForTest,
} from '../src/map/features/launch-corridor';
import { buildTierMapFeatures } from '../src/map/features/launch-corridor/geometry';
import { getMapLaunchMode, setMapLaunchMode } from '../src/map-launch-mode';
import type { TierCatalog } from '../src/launch-tiers';
import type { VendorDouble } from './vendor-map-double';
import { createVendorDouble } from './vendor-map-double';
import capturedCatalog from './fixtures/starship-catalog-2026-11-10.json' with { type: 'json' };

const ROOT = resolve(__dirname, '..');
const HAZARD_FILE = resolve(ROOT, 'public/hazards/v1/0f867f0c-5422-4d44-93b8-d7faaae7019b.json');
const NAVAREA_FILE = resolve(ROOT, 'test/fixtures/notices/navarea-iv-1080-26.txt');
const LNM_FILE = resolve(ROOT, 'test/fixtures/notices/uscg-lnm-45-2026-starship-flight15.txt');
const TFR_FILE = resolve(ROOT, 'test/fixtures/notices/faa-tfr-6-7129.xml');

const PAIR = /(\d{2,3}-\d{2}\.\d{2}[NS])\s+(\d{2,3}-\d{2}\.\d{2}[EW])/g;
const NOV13 = Date.parse('2026-11-13T22:45:00Z');
const WINDOW_END = Date.parse('2026-11-14T00:00:00Z');
const ATTEMPT = { startMs: NOV13, endMs: WINDOW_END };

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function round5(value: number): number {
  const scaled = Math.abs(value) * 1e5;
  return Math.sign(value) * Math.round(scaled) / 1e5;
}

function dm(token: string): number {
  const hemi = token.slice(-1);
  const [degrees, minutes] = token.slice(0, -1).split('-');
  if (degrees === undefined || minutes === undefined) throw new Error(token);
  const value = Number(degrees) + Number(minutes) / 60;
  const signed = hemi === 'S' || hemi === 'W' ? -value : value;
  return round5(signed);
}

function faa(token: string): number {
  const match = /^(\d+(?:\.\d+)?)([NSEW])$/.exec(token.trim());
  if (!match?.[1] || !match[2]) throw new Error(token);
  const value = Number(match[1]);
  return match[2] === 'S' || match[2] === 'W' ? -value : value;
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-8;
}

function pairsBetween(text: string, startMark: string, endMark: string): [number, number][] {
  const start = text.indexOf(startMark);
  if (start < 0) throw new Error(startMark);
  const rest = text.slice(start + startMark.length);
  const end = rest.indexOf(endMark);
  const slice = end < 0 ? rest : rest.slice(0, end);
  const found: [number, number][] = [];
  for (const match of slice.matchAll(PAIR)) {
    const lat = match[1];
    const lon = match[2];
    if (!lat || !lon) throw new Error('pair');
    found.push([dm(lon), dm(lat)]);
  }
  return found;
}

function navareaWindows(text: string): { start: string; end: string }[] {
  if (!text.includes('NOV 26')) throw new Error('year');
  const primary = /(\d{2})(\d{2})(\d{2})Z TO (\d{2})(\d{2})(\d{2})Z NOV/.exec(text);
  const alternate = /(\d{2})(\d{2})Z TO (\d{2})(\d{2})Z DAILY (\d{1,2}) THRU (\d{1,2}) NOV/.exec(text);
  if (!primary?.[1] || !primary[2] || !primary[3] || !primary[4] || !primary[5] || !primary[6]) {
    throw new Error('primary window');
  }
  if (!alternate?.[1] || !alternate[2] || !alternate[3] || !alternate[4] || !alternate[5] || !alternate[6]) {
    throw new Error('alternate window');
  }
  const stamp = (day: number, hour: string, minute: string) => (
    `2026-11-${String(day).padStart(2, '0')}T${hour}:${minute}:00Z`
  );
  const windows = [{
    start: stamp(Number(primary[1]), primary[2], primary[3]),
    end: stamp(Number(primary[4]), primary[5], primary[6]),
  }];
  const from = Number(alternate[5]);
  const thru = Number(alternate[6]);
  for (let day = from; day <= thru; day += 1) {
    const endDay = alternate[3] === '00' ? day + 1 : day;
    windows.push({
      start: stamp(day, alternate[1], alternate[2]),
      end: stamp(endDay, alternate[3], alternate[4]),
    });
  }
  return windows;
}

function lnmWindows(text: string): { start: string; end: string }[] {
  const windows: { start: string; end: string }[] = [];
  const pattern = /(\d{1,2})\/(\d{2})(\d{2})Z Nov 26 to (\d{1,2})\/(\d{2})(\d{2})Z Nov 26/g;
  for (const match of text.matchAll(pattern)) {
    if (!match[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) throw new Error('lnm window');
    const stamp = (day: string, hour: string, minute: string) => (
      `2026-11-${day.padStart(2, '0')}T${hour}:${minute}:00Z`
    );
    windows.push({ start: stamp(match[1], match[2], match[3]), end: stamp(match[4], match[5], match[6]) });
  }
  return windows;
}

function tfrVertices(xml: string): [number, number][] {
  const ring: [number, number][] = [];
  const pattern = /<geoLat>([^<]+)<\/geoLat>\s*<geoLong>([^<]+)<\/geoLong>/g;
  for (const match of xml.matchAll(pattern)) {
    const latToken = match[1];
    const lonToken = match[2];
    if (!latToken || !lonToken) throw new Error('tfr vertex');
    const lon = faa(lonToken);
    const lat = faa(latToken);
    const first = ring[0];
    if (first && ring.length >= 3 && near(lon, first[0]) && near(lat, first[1])) break;
    ring.push([lon, lat]);
  }
  return ring;
}

function tfrWindow(xml: string): { start: string; end: string } {
  if (!xml.includes('2611132230 UTC') || !xml.includes('2611140040 UTC')) throw new Error('tfr narrative');
  const start = /<dateEffective>([^<]+)<\/dateEffective>/.exec(xml)?.[1];
  const end = /<dateExpire>([^<]+)<\/dateExpire>/.exec(xml)?.[1];
  if (start !== '2026-11-13T22:30:00' || end !== '2026-11-14T00:40:00') throw new Error('tfr dates');
  return { start: `${start}Z`, end: `${end}Z` };
}

function sameRing(stored: number[][], expected: readonly [number, number][]): boolean {
  if (stored.length !== expected.length + 1) return false;
  const open = stored.slice(0, -1);
  const first = open[0];
  const closing = stored[stored.length - 1];
  if (!first || !closing || !near(closing[0] ?? NaN, first[0] ?? NaN) || !near(closing[1] ?? NaN, first[1] ?? NaN)) {
    return false;
  }
  const point = (left: number[] | undefined, right: [number, number] | undefined) => (
    !!left && !!right && near(left[0] ?? NaN, right[0]) && near(left[1] ?? NaN, right[1])
  );
  const forward = open.every((position, index) => point(position, expected[index]));
  const reversed = open.every((position, index) => point(position, expected[expected.length - 1 - index]));
  return forward || reversed;
}

function featureRing(bundle: HazardBundle, areaId: string): number[][] {
  const feature = bundle.geojson.features.find((entry) => entry.properties?.area_id === areaId);
  if (!feature || feature.geometry.type !== 'Polygon') throw new Error(areaId);
  return feature.geometry.coordinates[0] as number[][];
}

function coordinatesMatch(
  bundle: HazardBundle,
  navarea: string,
  lnm: string,
  tfrXml: string,
): boolean {
  const areaA = pairsBetween(navarea, 'A. ', 'B. ');
  const areaB = pairsBetween(navarea, 'B. ', '2. CANCEL');
  if (areaA.length !== 30 || areaB.length !== 16) return false;
  const lnmHigh = pairsBetween(lnm, 'High Risk Hazard Area:', '. Hazard Area:');
  const lnmHazard = pairsBetween(lnm, '. Hazard Area:', 'Primary and backup');
  const sameList = (left: [number, number][], right: [number, number][]) => (
    left.length === right.length && left.every((point, index) => {
      const other = right[index];
      return !!other && near(point[0], other[0]) && near(point[1], other[1]);
    })
  );
  if (!sameList(lnmHigh, areaB) || !sameList(lnmHazard, areaA)) return false;
  if (!sameRing(featureRing(bundle, 'A'), areaA) || !sameRing(featureRing(bundle, 'B'), areaB)) return false;
  const tfr = tfrVertices(tfrXml);
  if (tfr.length !== 6 || !sameRing(featureRing(bundle, '6/7129'), tfr)) return false;
  const windows = navareaWindows(navarea);
  if (JSON.stringify(windows) !== JSON.stringify(lnmWindows(lnm))) return false;
  const listed = (notice: HazardNotice) => notice.windows.map((window) => ({ start: window.start, end: window.end }));
  const areaNotice = bundle.notices.find((notice) => notice.area_id === 'A');
  const highNotice = bundle.notices.find((notice) => notice.area_id === 'B');
  const padNotice = bundle.notices.find((notice) => notice.area_id === '6/7129');
  if (!areaNotice || !highNotice || !padNotice) return false;
  if (JSON.stringify(listed(areaNotice)) !== JSON.stringify(windows)) return false;
  if (JSON.stringify(listed(highNotice)) !== JSON.stringify(windows)) return false;
  return JSON.stringify(listed(padNotice)) === JSON.stringify([tfrWindow(tfrXml)]);
}

function moved(bundle: HazardBundle, areaId: string, index: number, delta: number): HazardBundle {
  const copy = structuredClone(bundle);
  const ring = featureRing(copy, areaId);
  const point = ring[index];
  const lon = point?.[0];
  if (!point || lon === undefined) throw new Error('vertex');
  point[0] = lon + delta;
  return copy;
}

function rawBundle(): HazardBundle {
  const parsed = parseHazardBundle(JSON.parse(readFileSync(HAZARD_FILE, 'utf8')) as unknown);
  if (!parsed) throw new Error('hazard file did not parse');
  return parsed;
}

type StarshipItem = {
  event_id: string;
  schedule: {
    net: string;
    window_start: string | null;
    window_end: string | null;
    precision: string;
    status: string;
  };
  reasons: string[];
};

type HazardFile = {
  revision: string;
  checked_at: string;
  valid_until: string;
  status?: string;
  notices: { area_id: string }[];
  geojson: { features: { properties: { area_id: string } }[] };
};

function hazardFile(): HazardFile {
  return JSON.parse(readFileSync(HAZARD_FILE, 'utf8')) as HazardFile;
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function painted(vendor: VendorDouble): GeoJSON.Feature[] {
  const source = vendor.sources.get('launch-hazards');
  if (!source || source.type !== 'geojson' || typeof source.data === 'string') return [];
  return source.data.features;
}

async function catalogStore(now: number, edit?: (item: StarshipItem) => void): Promise<LaunchCatalogStore> {
  const parsed = parseLaunchArtifact(structuredClone(capturedCatalog));
  if (parsed.schema_version !== 3) throw new Error('expected a catalog');
  parsed.generated_at = new Date(now - 60_000).toISOString();
  parsed.geometry_valid_until = new Date(now + 10 * 60_000).toISOString();
  parsed.schedule_valid_until = new Date(now + 60 * 60_000).toISOString();
  const item = parsed.items.find((entry) => entry.event_id === STARSHIP_FLIGHT15_EVENT_ID) as StarshipItem | undefined;
  if (!item) throw new Error('missing starship');
  edit?.(item);
  const text = JSON.stringify(parsed);
  const sha = sha256(Buffer.from(text));
  const pointer = {
    schema_version: 2,
    revision: parsed.revision,
    generated_at: parsed.generated_at,
    valid_until: parsed.geometry_valid_until,
    path: `launch/catalog/v/${parsed.revision}.json`,
    sha256: sha,
  };
  const store = new LaunchCatalogStore(async (input) => new Response(
    String(input).includes('latest.json') ? JSON.stringify(pointer) : text,
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  await store.refresh();
  return store;
}

function followStore(store: LaunchCatalogStore): void {
  vi.spyOn(launchCatalog, 'read').mockImplementation((now: number) => store.read(now));
  vi.spyOn(launchCatalog, 'attempt').mockImplementation((id: string, now: number) => store.attempt(id, now));
}

const STARSHIP_PIN: TierLaunch = {
  eventId: STARSHIP_FLIGHT15_EVENT_ID,
  revision: 'ef57baeda973b070b49f3f9c',
  name: 'Starship | Starlink Group 31-2 (Starship Flight 15)',
  rocket: 'Starship V3',
  site: { name: 'SpaceX Starbase, TX, USA', lat: 25.99677, lon: -97.15799, pad: 'Orbital Launch Pad 2' },
  tier: 'watch',
  why: 'Watch',
  reasons: [],
  schedule: {
    netMs: NOV13,
    windowStartMs: NOV13,
    windowEndMs: WINDOW_END,
    precision: 'Minute',
    status: 'TBC',
  },
  top: null,
  corridor: null,
  whenMs: NOV13,
  liveUntilMs: WINDOW_END,
};

function rect(node: HTMLElement, x: number, y: number, w: number, h: number): void {
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, w, h));
}

function mount(now = '2026-11-13T22:50:00Z') {
  const vendor = createVendorDouble();
  const core = createMapCore(vendor, createClock(() => Date.parse(now)));
  noteLaunchCore(core);
  useHazardBundleForTest(rawBundle());
  return { vendor, core };
}

afterEach(() => {
  resetLaunchForTest();
  setMapLaunchMode(false);
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('Starship Flight 15 hazard notices', () => {
  const navarea = readFileSync(NAVAREA_FILE, 'utf8');
  const lnm = readFileSync(LNM_FILE, 'utf8');
  const tfrXml = readFileSync(TFR_FILE, 'utf8');
  const bundle = rawBundle();

  it('matches every vertex to the notice text, the LNM cross-check, and the FAA XML', () => {
    expect(bundle.event_id).toBe(STARSHIP_FLIGHT15_EVENT_ID);
    expect(bundle.label).toBe(HAZARD_LABEL);
    expect(coordinatesMatch(bundle, navarea, lnm, tfrXml)).toBe(true);
    const raw = JSON.parse(readFileSync(HAZARD_FILE, 'utf8')) as {
      notices: { source_sha256: string; cross_check_sha256?: string; area_id: string }[];
    };
    expect(raw.notices.find((notice) => notice.area_id === 'A')?.source_sha256).toBe(sha256(readFileSync(NAVAREA_FILE)));
    expect(raw.notices.find((notice) => notice.area_id === 'A')?.cross_check_sha256).toBe(sha256(readFileSync(LNM_FILE)));
    expect(raw.notices.find((notice) => notice.area_id === '6/7129')?.source_sha256).toBe(sha256(readFileSync(TFR_FILE)));
    expect(bundle.geojson.features.every((feature) => feature.geometry.type === 'Polygon')).toBe(true);
    expect(JSON.stringify(bundle.geojson)).not.toContain('LineString');
  });

  it('rejects a hazard file whose area A vertex moved', () => {
    expect(coordinatesMatch(moved(bundle, 'A', 3, 0.01), navarea, lnm, tfrXml)).toBe(false);
  });

  it('rejects a hazard file whose TFR vertex moved', () => {
    expect(coordinatesMatch(moved(bundle, '6/7129', 2, -0.01), navarea, lnm, tfrXml)).toBe(false);
  });

  it('rejects the published file when the notice text itself moves a vertex', () => {
    const shifted = navarea.replace('25-58.00N 097-13.00W', '25-59.00N 097-13.00W');
    expect(shifted).not.toBe(navarea);
    expect(coordinatesMatch(bundle, shifted, lnm, tfrXml)).toBe(false);
  });

  it('rejects an open ring and a centreline instead of drawing either', () => {
    const raw = JSON.parse(readFileSync(HAZARD_FILE, 'utf8')) as {
      geojson: { features: { geometry: { type: string; coordinates: number[][][] } }[] };
    };
    const open = structuredClone(raw);
    open.geojson.features[0]?.geometry.coordinates[0]?.pop();
    expect(parseHazardBundle(open)).toBeNull();
    const line = structuredClone(raw);
    const geometry = line.geojson.features[0]?.geometry;
    if (!geometry) throw new Error('missing geometry');
    geometry.type = 'LineString';
    expect(parseHazardBundle(line)).toBeNull();
  });

  it('keeps Starship Watch, TBC, direction none, and an empty shot list', () => {
    const parsed = parseLaunchArtifact(capturedCatalog);
    if (parsed.schema_version !== 3) throw new Error('expected a catalog');
    const before = JSON.stringify(parsed.items.find((item) => item.event_id === STARSHIP_FLIGHT15_EVENT_ID));
    const item = parsed.items.find((entry) => entry.event_id === STARSHIP_FLIGHT15_EVENT_ID);
    if (!item) throw new Error('missing Starship');
    expect(item.tier).toBe('watch');
    expect(item.schedule.status).toBe('TBC');
    expect(item.direction).toEqual({ kind: 'none', azimuth_deg: null, source: null, off_plane_deg: null });
    expect(item.shots).toEqual([]);
    const now = Date.parse('2026-11-10T08:39:00Z');
    const tiers = tiersAt(parsed, now);
    if (!tiers) throw new Error('expected a current catalog');
    expect(tiers.find(STARSHIP_FLIGHT15_EVENT_ID)?.corridor).toBeNull();
    expect(buildTierMapFeatures(tiers, now).lines).toEqual([]);
    expect(activeHazardFeatures(bundle, now, ATTEMPT)).toEqual([]);
    expect(JSON.stringify(parsed.items.find((entry) => entry.event_id === STARSHIP_FLIGHT15_EVENT_ID))).toBe(before);
    const file = JSON.parse(readFileSync(HAZARD_FILE, 'utf8')) as Record<string, unknown>;
    expect(file.shots).toBeUndefined();
    expect(file.direction).toBeUndefined();
    expect(file.tier).toBeUndefined();
    expect(file.azimuth_deg).toBeUndefined();
  });

  it('shows polygons only inside an attempt window and not in the gaps', () => {
    const ids = (now: number, attempt: { startMs: number; endMs: number } | null = ATTEMPT) =>
      activeHazardFeatures(bundle, now, attempt).map((feature) => feature.properties?.area_id);
    expect(ids(Date.parse('2026-11-13T22:29:59Z'))).toEqual([]);
    expect(ids(Date.parse('2026-11-13T22:30:00Z'))).toEqual(['6/7129']);
    expect(ids(Date.parse('2026-11-13T22:44:59Z'))).toEqual(['6/7129']);
    expect(ids(Date.parse('2026-11-13T22:50:00Z')).sort()).toEqual(['6/7129', 'A', 'B']);
    expect(ids(Date.parse('2026-11-14T00:10:00Z')).sort()).toEqual(['6/7129', 'A', 'B']);
    expect(ids(Date.parse('2026-11-14T00:40:00Z'))).toEqual([]);
    expect(ids(Date.parse('2026-11-14T12:00:00Z'))).toEqual([]);
    expect(ids(Date.parse('2026-11-14T23:00:00Z'))).toEqual([]);
    const backup = { startMs: Date.parse('2026-11-14T22:45:00Z'), endMs: Date.parse('2026-11-15T00:00:00Z') };
    expect(ids(Date.parse('2026-11-14T23:00:00Z'), backup).sort()).toEqual(['A', 'B']);
    const last = { startMs: Date.parse('2026-11-19T22:45:00Z'), endMs: Date.parse('2026-11-20T00:00:00Z') };
    expect(ids(Date.parse('2026-11-19T23:10:00Z'), last).sort()).toEqual(['A', 'B']);
    expect(ids(Date.parse('2026-11-20T00:40:00Z'), last)).toEqual([]);
    expect(ids(Date.parse('2026-11-13T22:50:00Z'), null)).toEqual([]);
    const shown = activeHazardFeatures(bundle, Date.parse('2026-11-13T22:50:00Z'), ATTEMPT);
    expect(shown.every((feature) => feature.properties?.label === HAZARD_LABEL)).toBe(true);
    expect(shown.find((feature) => feature.properties?.area_id === 'B')?.properties?.fill_opacity).toBe(0.18);
    expect(shown.find((feature) => feature.properties?.area_id === 'A')?.properties?.fill_opacity).toBe(0.12);
    expect(shown.every((feature) => feature.geometry.type === 'Polygon')).toBe(true);
  });

  it('keeps the hazard file out of the service-worker precache', () => {
    const vite = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
    expect(vite).toContain("'**/hazards/**'");
    expect(STARSHIP_FLIGHT15_HAZARD_PATH.endsWith('.json')).toBe(true);
    expect(STARSHIP_FLIGHT15_HAZARD_PATH.endsWith('.geojson')).toBe(false);
    const patterns = /globPatterns:\s*\[[^\]]+\]/.exec(vite)?.[0] ?? '';
    expect(patterns).not.toContain('hazards');
    expect(patterns).not.toContain('**/*.json');
    const tick = readFileSync(resolve(ROOT, 'src/map/index.ts'), 'utf8');
    const every = tick.slice(tick.indexOf('clock.every(1000'), tick.indexOf('clock.every(30_000'));
    expect(every.indexOf('syncLaunchHazards(nowMs)')).toBeGreaterThan(-1);
    expect(every.indexOf('syncLaunchHazards(nowMs)')).toBeLessThan(every.indexOf('hasIssMarker'));
    expect(every).not.toContain('viewMs');
  });
});

describe('hazard overlay on the map', () => {
  it('paints closed polygons inside the window and none between windows', () => {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [{ eventId: STARSHIP_FLIGHT15_EVENT_ID }],
    } as unknown as TierCatalog);
    const attempt = vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor, core } = mount();
    setMapLaunchMode(true);
    syncLaunchHazards(Date.parse('2026-11-13T22:50:00Z'));
    core.ensureLayer(launchHazardFillLayer());
    core.ensureLayer(launchHazardOutlineLayer());
    const source = vendor.sources.get('launch-hazards');
    if (!source || source.type !== 'geojson' || typeof source.data === 'string') throw new Error('missing hazards');
    expect(source.data.features).toHaveLength(3);
    expect(source.data.features.every((feature) => feature.geometry.type === 'Polygon')).toBe(true);
    expect(source.data.features.some((feature) => feature.geometry.type === 'LineString')).toBe(false);
    expect(source.data.features.every((feature) => {
      if (feature.geometry.type !== 'Polygon') return false;
      const ring = feature.geometry.coordinates[0];
      const first = ring?.[0];
      const last = ring?.[ring.length - 1];
      return !!first && !!last && first[0] === last[0] && first[1] === last[1];
    })).toBe(true);
    expect(vendor.layers.map((layer) => layer.id)).toEqual([
      'launch-hazard-fill-layer',
      'launch-hazard-outline-layer',
    ]);
    expect(vendor.layers.every((layer) => layer.type === 'fill' || layer.type === 'line')).toBe(true);
    expect(vendor.layers.find((layer) => layer.id === 'launch-hazard-outline-layer')).toMatchObject({
      source: 'launch-hazards',
      paint: { 'line-color': '#ffd45c', 'line-width': 1.5 },
    });
    const caption = document.createElement('p');
    caption.id = 'launch-hazard-caption';
    caption.hidden = true;
    document.body.append(caption);
    syncLaunchHazards(Date.parse('2026-11-13T22:50:00Z'));
    expect(caption.hidden).toBe(false);
    expect(caption.textContent).toBe(HAZARD_LABEL);
    syncLaunchHazards(Date.parse('2026-11-14T12:00:00Z'));
    const between = vendor.sources.get('launch-hazards');
    if (!between || between.type !== 'geojson' || typeof between.data === 'string') throw new Error('missing hazards');
    expect(between.data.features).toEqual([]);
    expect(caption.hidden).toBe(true);
    setMapLaunchMode(false);
    syncLaunchHazards(Date.parse('2026-11-13T22:50:00Z'));
    expect(caption.hidden).toBe(true);
    expect(attempt).toHaveBeenCalledWith(STARSHIP_FLIGHT15_EVENT_ID, Date.parse('2026-11-13T22:50:00Z'));
    expect(getMapLaunchMode()).toBe(false);
  });

  it('fits the pad and the polygons without adding a trajectory', () => {
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [{
        eventId: STARSHIP_FLIGHT15_EVENT_ID,
        site: { lon: -97.15799, lat: 25.99677 },
        corridor: null,
      }],
    } as unknown as TierCatalog);
    const { vendor } = mount();
    syncLaunchHazards(Date.parse('2026-11-13T22:50:00Z'));
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    const fit = vendor.cameraCalls.find((call) => call.method === 'fitBounds');
    const box = fit?.args[0] as { west: number; east: number } | undefined;
    if (!box) throw new Error('expected a fit');
    expect(box.east - box.west).toBeGreaterThan(10);
    expect(fit?.args[1]).toMatchObject({ padding: 50, maxZoom: 5, duration: 600, bearing: 0 });
    const lines = vendor.sources.get('ascent-trajectory');
    expect(lines).toBeUndefined();
  });
});

describe('catalog attempt after the map pin drops', () => {
  it('drops the Starship window when the Watch pin drops and does not put the pin back', async () => {
    const parsed = parseLaunchArtifact(structuredClone(capturedCatalog));
    if (parsed.schema_version !== 3) throw new Error('expected a catalog');
    const now = Date.parse('2026-11-14T00:10:00Z');
    parsed.generated_at = new Date(now - 60_000).toISOString();
    parsed.geometry_valid_until = new Date(now + 10 * 60_000).toISOString();
    parsed.schedule_valid_until = new Date(now + 60 * 60_000).toISOString();
    const text = JSON.stringify(parsed);
    const sha = sha256(Buffer.from(text));
    const pointer = {
      schema_version: 2,
      revision: parsed.revision,
      generated_at: parsed.generated_at,
      valid_until: parsed.geometry_valid_until,
      path: `launch/catalog/v/${parsed.revision}.json`,
      sha256: sha,
    };
    const store = new LaunchCatalogStore(async (input) => new Response(
      String(input).includes('latest.json') ? JSON.stringify(pointer) : text,
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await store.refresh();
    expect(store.attempt(STARSHIP_FLIGHT15_EVENT_ID, now)).toBeNull();
    expect(activeHazardFeatures(rawBundle(), now, store.attempt(STARSHIP_FLIGHT15_EVENT_ID, now))).toEqual([]);
    expect(activeHazardFeatures(rawBundle(), now, ATTEMPT).length).toBeGreaterThan(0);
    const tiers = store.read(now);
    if (!tiers) throw new Error('expected a current catalog');
    expect(tiers.mapPins.some((pin) => pin.eventId === STARSHIP_FLIGHT15_EVENT_ID)).toBe(false);
    const item = parsed.items.find((entry) => entry.event_id === STARSHIP_FLIGHT15_EVENT_ID);
    expect(item?.direction.kind).toBe('none');
    expect(item?.shots).toEqual([]);
    expect(item?.tier).toBe('watch');
    expect(item?.schedule.status).toBe('TBC');
  });
});

describe('hazard fetch', () => {
  it('refuses HTML, a miss, and a body for a different event', async () => {
    const html = vi.fn(async () => new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    expect(await loadPublishedHazards(html)).toEqual({ kind: 'withdrawn' });
    const missing = vi.fn(async () => new Response('nope', { status: 404, headers: { 'content-type': 'application/json' } }));
    expect(await loadPublishedHazards(missing)).toEqual({ kind: 'withdrawn' });
    const body = JSON.parse(readFileSync(HAZARD_FILE, 'utf8')) as { event_id: string };
    body.event_id = 'other-event';
    const wrong = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    expect(await loadPublishedHazards(wrong)).toEqual({ kind: 'withdrawn' });
    expect(html).toHaveBeenCalledWith(STARSHIP_FLIGHT15_HAZARD_PATH, expect.objectContaining({
      cache: 'no-store',
      redirect: 'error',
    }));
    const down = vi.fn(async () => new Response('down', { status: 503, headers: { 'content-type': 'application/json' } }));
    expect(await loadPublishedHazards(down)).toEqual({ kind: 'unavailable' });
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await loadPublishedHazards(offline)).toEqual({ kind: 'unavailable' });
  });
});

describe('hazards and the Watch pin share one cutoff', () => {
  it('shows both at 23:59:59Z and neither at 00:00:00Z', async () => {
    const before = Date.parse('2026-11-13T23:59:59Z');
    const cutoff = Date.parse('2026-11-14T00:00:00Z');
    const store = await catalogStore(before);
    followStore(store);
    const { vendor } = mount();
    setMapLaunchMode(true);
    syncLaunchHazards(before);
    expect(store.read(before)?.mapPins.some((pin) => pin.eventId === STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    expect(store.attempt(STARSHIP_FLIGHT15_EVENT_ID, before)).toEqual(ATTEMPT);
    expect(painted(vendor)).toHaveLength(3);
    syncLaunchHazards(cutoff);
    expect(store.read(cutoff)?.mapPins.some((pin) => pin.eventId === STARSHIP_FLIGHT15_EVENT_ID)).toBe(false);
    expect(store.attempt(STARSHIP_FLIGHT15_EVENT_ID, cutoff)).toBeNull();
    expect(painted(vendor)).toEqual([]);
    expect(activeHazardFeatures(rawBundle(), cutoff, ATTEMPT).length).toBeGreaterThan(0);
  });

  it('hides polygons when the launch is cancelled or its NET leaves the map horizon', async () => {
    const now = Date.parse('2026-11-13T22:50:00Z');
    const cancelled = await catalogStore(now, (item) => {
      item.schedule.status = 'Cancelled';
    });
    expect(cancelled.read(now)?.mapPins.some((pin) => pin.eventId === STARSHIP_FLIGHT15_EVENT_ID)).toBe(false);
    expect(cancelled.attempt(STARSHIP_FLIGHT15_EVENT_ID, now)).toBeNull();
    followStore(cancelled);
    const { vendor } = mount();
    setMapLaunchMode(true);
    syncLaunchHazards(now);
    expect(painted(vendor)).toEqual([]);
    expect(activeHazardFeatures(rawBundle(), now, ATTEMPT)).toHaveLength(3);

    const slipped = await catalogStore(now, (item) => {
      item.schedule.net = '2026-11-21T22:45:00Z';
      item.schedule.window_start = '2026-11-21T22:45:00Z';
      item.schedule.window_end = '2026-11-22T00:00:00Z';
    });
    expect(slipped.attempt(STARSHIP_FLIGHT15_EVENT_ID, now)).toBeNull();
    followStore(slipped);
    syncLaunchHazards(now);
    expect(painted(vendor)).toEqual([]);
  });

  it('hides polygons while another launch is selected', () => {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [STARSHIP_PIN, { ...STARSHIP_PIN, eventId: 'other-launch', site: { ...STARSHIP_PIN.site, lon: -80.6, lat: 28.6 } }],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor } = mount();
    setMapLaunchMode(true);
    syncLaunchHazards(Date.parse('2026-11-13T22:50:00Z'));
    expect(painted(vendor)).toHaveLength(3);
    expect(focusLaunchOnMap('other-launch')).toBe(true);
    expect(painted(vendor)).toEqual([]);
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    expect(painted(vendor)).toHaveLength(3);
  });
});

describe('hazard file freshness', () => {
  const now = Date.parse('2026-11-13T22:50:00Z');

  function ready(): VendorDouble {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [{ eventId: STARSHIP_FLIGHT15_EVENT_ID }],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor } = mount();
    setMapLaunchMode(true);
    return vendor;
  }

  it('drops a drawn bundle on 404, expiry, and a replacement, and keeps it across a 503', async () => {
    const vendor = ready();
    const current = hazardFile();
    await reloadLaunchHazards(() => jsonResponse(current));
    expect(painted(vendor)).toHaveLength(3);
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A', 'B']);

    await reloadLaunchHazards(() => jsonResponse('missing', 404));
    expect(painted(vendor)).toEqual([]);
    expect(activeHazardFeatures(rawBundle(), now, ATTEMPT)).toHaveLength(3);

    await reloadLaunchHazards(() => jsonResponse(current));
    expect(painted(vendor)).toHaveLength(3);
    const expired = hazardFile();
    expired.valid_until = '2026-11-13T22:00:00Z';
    await reloadLaunchHazards(() => jsonResponse(expired));
    expect(painted(vendor)).toEqual([]);

    await reloadLaunchHazards(() => jsonResponse(current));
    const replaced = hazardFile();
    replaced.revision = 'replaced-revision';
    replaced.notices = replaced.notices.filter((notice) => notice.area_id !== 'B');
    replaced.geojson.features = replaced.geojson.features.filter((feature) => feature.properties.area_id !== 'B');
    await reloadLaunchHazards(() => jsonResponse(replaced));
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A']);

    await reloadLaunchHazards(async () => new Response('down', { status: 503 }));
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A']);
    expect(current.checked_at).toBe('2026-11-13T10:02:00Z');
  });

  it('does not latch an initial failure, and a stale reply cannot replace a newer one', async () => {
    const vendor = ready();
    useHazardBundleForTest(null);
    syncLaunchHazards(now);
    await reloadLaunchHazards(async () => new Response('down', { status: 503 }));
    expect(painted(vendor)).toEqual([]);
    await reloadLaunchHazards(() => jsonResponse(hazardFile()));
    expect(painted(vendor)).toHaveLength(3);

    useHazardBundleForTest(null);
    let releaseFirst: (response: Response) => void = () => {};
    let releaseSecond: (response: Response) => void = () => {};
    const first = reloadLaunchHazards(() => new Promise((resolve) => {
      releaseFirst = resolve;
    }));
    const replaced = hazardFile();
    replaced.revision = 'newer-revision';
    replaced.notices = replaced.notices.filter((notice) => notice.area_id !== 'B');
    replaced.geojson.features = replaced.geojson.features.filter((feature) => feature.properties.area_id !== 'B');
    const second = reloadLaunchHazards(() => new Promise((resolve) => {
      releaseSecond = resolve;
    }));
    releaseSecond(new Response(JSON.stringify(replaced), { status: 200, headers: { 'content-type': 'application/json' } }));
    await second;
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A']);
    releaseFirst(new Response(JSON.stringify(hazardFile()), { status: 200, headers: { 'content-type': 'application/json' } }));
    await first;
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A']);
  });
});

describe('hazard notice facts', () => {
  it('puts the notice on the polygon and on the launch card', () => {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [STARSHIP_PIN],
      find: (eventId: string) => eventId === STARSHIP_FLIGHT15_EVENT_ID ? STARSHIP_PIN : { ...STARSHIP_PIN, eventId },
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor, core } = mount();
    bindAscentPad(core);
    setMapLaunchMode(true);
    syncLaunchHazards(Date.parse('2026-11-13T22:50:00Z'));
    vendor.fireLayer('click', 'launch-hazard-fill-layer', {
      point: { x: 4, y: 4 },
      lngLat: [-97.1, 26],
      features: [{
        properties: {
          notice_id: 'NAVAREA IV 1080/26',
          area_id: 'B',
          domain: 'maritime',
          restriction_class: 'high_risk',
          window_start: '2026-11-13T22:45:00Z',
          window_end: '2026-11-14T00:40:00Z',
          source_url: 'https://msi.nga.mil/Navarea',
        },
        geometry: { type: 'Polygon', coordinates: [] },
      }],
    });
    const popup = vendor.popups.at(-1);
    if (!popup) throw new Error('expected a popup');
    const text = popup.content.textContent ?? '';
    expect(text).toContain('not a flight path or navigation guidance');
    expect(text).toContain('NAVAREA IV 1080/26 area B, maritime high_risk');
    expect(popup.content.querySelector('a')?.getAttribute('href')).toBe('https://msi.nga.mil/Navarea');
    const card = renderTierCard(STARSHIP_PIN, () => {});
    expect(card.querySelector('button.btn')?.textContent).toBe('Show published hazard areas');
    expect(card.textContent).toContain('not a flight path or navigation guidance');
    const plain = renderTierCard({ ...STARSHIP_PIN, eventId: 'other-launch' }, () => {});
    expect(plain.querySelector('button.btn')?.textContent).toBe('Show launch site');
    expect(plain.textContent).not.toContain('hazard areas');
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function open() { this.setAttribute('open', ''); };
    openTierDetails({ ...STARSHIP_PIN, eventId: 'other-launch' });
    expect(document.querySelector('[data-tier-track]')?.textContent).toBe('Pad only');
    openTierDetails(STARSHIP_PIN);
    expect(document.querySelector('[data-tier-track]')?.textContent).toContain('not a flight path or navigation guidance');
    HTMLDialogElement.prototype.showModal = showModal;
  });
});

describe('hazard focus', () => {
  const when = Date.parse('2026-11-13T22:50:00Z');

  function pins() {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [STARSHIP_PIN],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
  }

  it('frames hazards that arrive after the focus, once', () => {
    pins();
    const vendor = createVendorDouble();
    const core = createMapCore(vendor, createClock(() => when));
    noteLaunchCore(core);
    bindAscentPad(core);
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    expect(vendor.cameraCalls.some((call) => call.method === 'fitBounds')).toBe(false);
    useHazardBundleForTest(rawBundle());
    syncLaunchHazards(when);
    const fits = vendor.cameraCalls.filter((call) => call.method === 'fitBounds');
    expect(fits).toHaveLength(1);
    const box = fits[0]?.args[0] as { west: number; east: number };
    expect(box.east - box.west).toBeGreaterThan(10);
    const before = vendor.cameraCalls.length;
    syncLaunchHazards(when);
    expect(vendor.cameraCalls).toHaveLength(before);
  });

  it('cancels the deferred fit after a pan, a user zoom, a mode exit, or a different launch', () => {
    pins();
    const vendor = createVendorDouble();
    const core = createMapCore(vendor, createClock(() => when));
    noteLaunchCore(core);
    bindAscentPad(core);
    syncMapLaunchMode();
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    vendor.fire('dragstart', undefined);
    useHazardBundleForTest(rawBundle());
    syncLaunchHazards(when);
    expect(vendor.cameraCalls.some((call) => call.method === 'fitBounds')).toBe(false);

    resetLaunchForTest();
    noteLaunchCore(core);
    bindAscentPad(core);
    focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID);
    vendor.fire('zoomstart', { byUser: true });
    useHazardBundleForTest(rawBundle());
    syncLaunchHazards(when);
    expect(vendor.cameraCalls.some((call) => call.method === 'fitBounds')).toBe(false);

    resetLaunchForTest();
    noteLaunchCore(core);
    bindAscentPad(core);
    syncMapLaunchMode();
    setMapLaunchMode(false);
    focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID);
    setMapLaunchMode(false);
    useHazardBundleForTest(rawBundle());
    syncLaunchHazards(when);
    expect(vendor.cameraCalls.some((call) => call.method === 'fitBounds')).toBe(false);
  });

  it('fits inside the chrome and holds a non-zero bearing', () => {
    pins();
    const pane = document.createElement('div');
    pane.id = 'map-pane';
    const toolbar = document.createElement('div');
    toolbar.className = 'map-toolbar';
    const dock = document.createElement('div');
    dock.className = 'map-control-dock';
    const command = document.createElement('div');
    command.className = 'map-controls-time';
    const card = document.createElement('div');
    card.id = 'map-launch-coverage';
    document.body.append(pane, toolbar, dock, command, card);
    rect(pane, 0, 0, 874, 402);
    rect(toolbar, 8, 8, 420, 48);
    rect(dock, 810, 70, 64, 220);
    rect(command, 0, 350, 874, 52);
    rect(card, 8, 100, 640, 80);
    const { vendor } = mount();
    vendor.setBearing(40);
    setMapLaunchMode(true);
    syncLaunchHazards(when);
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    const fit = vendor.cameraCalls.find((call) => call.method === 'fitBounds');
    expect(fit?.args[1]).toEqual({
      padding: { top: 192, right: 76, bottom: 64, left: 16 },
      maxZoom: 5,
      duration: 0,
      bearing: 40,
    });
    rect(card, 8, 120, 280, 500);
    vendor.setBearing(40);
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    const again = vendor.cameraCalls.filter((call) => call.method === 'fitBounds').at(-1);
    expect(again?.args[1]).toMatchObject({
      padding: { top: 68, right: 76, bottom: 64, left: 300 },
      duration: 0,
      bearing: 40,
    });
  });
});
