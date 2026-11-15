import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LaunchCatalogStore, launchCatalog } from '../src/launch-catalog';
import { renderMapLaunchBrief } from '../src/launch-map-brief';
import {
  activeHazardFeatures,
  activeHazardListings,
  HAZARD_LABEL,
  HAZARD_PATH,
  loadPublishedHazards,
  parseHazardBundle,
  publishHazardNotes,
  type HazardBundle,
  type HazardNotice,
  type LaunchHazards,
} from '../src/launch-hazards';
import { parseLaunchArtifact } from '../src/launch-schema';
import { renderTierCard, openTierDetails } from '../src/launch-tier-card';
import { tiersAt, type TierLaunch } from '../src/launch-tiers';
import { createClock } from '../src/map/map-core/clock';
import { createMapCore } from '../src/map/map-core/core';
import {
  bindAscentPad,
  bindLaunchStore,
  clearLaunchOnMap,
  focusLaunchOnMap,
  onHazardCatalogRefresh,
  launchHazardFillLayer,
  launchHazardOutlineLayer,
  noteLaunchCore,
  reloadLaunchHazards,
  resetLaunchForTest,
  refreshAscentTrajectorySource,
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
import { catalog, NOW, plannerItem } from './launch-fixtures';

const STARSHIP_FLIGHT15_EVENT_ID = '0f867f0c-5422-4d44-93b8-d7faaae7019b';
const VULCAN_EVENT_ID = 'ef9850ad-1096-425b-9d27-f7bbd186e61a';
const USSF_317_EVENT_ID = '76617033-4dc0-4448-b50c-e5b0d5a18539';
const ROOT = resolve(__dirname, '..');
const HAZARD_FILE = resolve(ROOT, 'test/fixtures/hazards-v2-2026-11-13.json');
const SCHEMA_1_FILE = resolve(ROOT, 'test/fixtures/hazards-v1-starship-flight15.json');
const USCG_FILE = resolve(ROOT, 'test/fixtures/notices/uscg-space-ops-2026-11-13.geojson');
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

function launchOf(bundle: HazardBundle, eventId = STARSHIP_FLIGHT15_EVENT_ID): LaunchHazards {
  const launch = bundle.launches.find((entry) => entry.event_id === eventId);
  if (!launch) throw new Error(eventId);
  return launch;
}

function featureRing(bundle: HazardBundle, areaId: string, eventId = STARSHIP_FLIGHT15_EVENT_ID): number[][] {
  const feature = launchOf(bundle, eventId).geojson.features.find((entry) => entry.properties?.area_id === areaId);
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
  const areaNotice = launchOf(bundle).notices.find((notice) => notice.area_id === 'A');
  const highNotice = launchOf(bundle).notices.find((notice) => notice.area_id === 'B');
  const padNotice = launchOf(bundle).notices.find((notice) => notice.area_id === '6/7129');
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

type HazardFileLaunch = {
  event_id: string;
  notices: {
    notice_id: string;
    area_id: string;
    checked_at: string;
    valid_until: string;
    source_sha256: string;
    cross_check_sha256?: string;
    instructions: string[];
    also: string[];
  }[];
  geojson: { features: { id?: string; properties: { notice_id: string; area_id: string }; geometry: { type: string; coordinates: number[][][] } }[] };
  listed: {
    authority: string;
    notice_id: string;
    reason: string;
    text: string;
    checked_at: string;
    valid_until: string;
    source_url: string;
    source_sha256: string;
  }[];
};

type HazardFile = {
  schema_version: number;
  revision: string;
  generated_at: string;
  status?: string;
  launches: HazardFileLaunch[];
};

function hazardFile(): HazardFile {
  return JSON.parse(readFileSync(HAZARD_FILE, 'utf8')) as HazardFile;
}

function entryOf(file: HazardFile, eventId = STARSHIP_FLIGHT15_EVENT_ID): HazardFileLaunch {
  const launch = file.launches.find((entry) => entry.event_id === eventId);
  if (!launch) throw new Error(eventId);
  return launch;
}

function without(file: HazardFile, areaId: string): HazardFile {
  const launch = entryOf(file);
  launch.notices = launch.notices.filter((notice) => notice.area_id !== areaId);
  launch.geojson.features = launch.geojson.features.filter((feature) => feature.properties.area_id !== areaId);
  return file;
}

function reviewed(file: HazardFile, checkedAt: string, eventId = STARSHIP_FLIGHT15_EVENT_ID): HazardFile {
  for (const notice of entryOf(file, eventId).notices) notice.checked_at = checkedAt;
  for (const listed of entryOf(file, eventId).listed) listed.checked_at = checkedAt;
  return file;
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
  direction: { kind: 'none' },
  ascent: null,
  shots: [],
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
    expect(launchOf(bundle).event_id).toBe(STARSHIP_FLIGHT15_EVENT_ID);
    expect(bundle.label).toBe(HAZARD_LABEL);
    expect(coordinatesMatch(bundle, navarea, lnm, tfrXml)).toBe(true);
    const raw = entryOf(hazardFile());
    expect(raw.notices.find((notice) => notice.area_id === 'A')?.source_sha256).toBe(sha256(readFileSync(NAVAREA_FILE)));
    expect(raw.notices.find((notice) => notice.area_id === 'A')?.cross_check_sha256).toBe(sha256(readFileSync(USCG_FILE)));
    expect(raw.notices.find((notice) => notice.area_id === '6/7129')?.source_sha256).toBe(sha256(readFileSync(TFR_FILE)));
    expect(bundle.launches.every((launch) => launch.geojson.features.every((feature) => feature.geometry.type === 'Polygon'))).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain('LineString');
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
    const open = hazardFile();
    expect(parseHazardBundle(open)).not.toBeNull();
    entryOf(open).geojson.features[0]?.geometry.coordinates[0]?.pop();
    expect(parseHazardBundle(open)).toBeNull();
    const line = hazardFile();
    const geometry = entryOf(line, VULCAN_EVENT_ID).geojson.features[0]?.geometry;
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
    expect(activeHazardFeatures(bundle, STARSHIP_FLIGHT15_EVENT_ID, now, ATTEMPT)).toEqual([]);
    expect(JSON.stringify(parsed.items.find((entry) => entry.event_id === STARSHIP_FLIGHT15_EVENT_ID))).toBe(before);
    const file = readFileSync(HAZARD_FILE, 'utf8');
    for (const field of ['shots', 'direction', 'tier', 'azimuth_deg', 'trajectory']) {
      expect(file).not.toContain(`"${field}"`);
    }
  });

  it('shows polygons only inside an attempt window and not in the gaps', () => {
    const ids = (now: number, attempt: { startMs: number; endMs: number } | null = ATTEMPT) =>
      activeHazardFeatures(bundle, STARSHIP_FLIGHT15_EVENT_ID, now, attempt).map((feature) => feature.properties?.area_id);
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
    expect(ids(Date.parse('2026-11-19T23:10:00Z'), last)).toEqual([]);
    expect(ids(Date.parse('2026-11-20T00:40:00Z'), last)).toEqual([]);
    expect(ids(Date.parse('2026-11-13T22:50:00Z'), null)).toEqual([]);
    const shown = activeHazardFeatures(bundle, STARSHIP_FLIGHT15_EVENT_ID, Date.parse('2026-11-13T22:50:00Z'), ATTEMPT);
    expect(shown.every((feature) => feature.properties?.label === HAZARD_LABEL)).toBe(true);
    expect(shown.find((feature) => feature.properties?.area_id === 'B')?.properties?.fill_opacity).toBe(0.18);
    expect(shown.find((feature) => feature.properties?.area_id === 'A')?.properties?.fill_opacity).toBe(0.12);
    expect(shown.every((feature) => feature.geometry.type === 'Polygon')).toBe(true);
  });

  it('keeps the hazard file out of the service-worker precache', () => {
    const vite = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
    expect(vite).toContain("'**/hazards/**'");
    expect(HAZARD_PATH).toBe('/hazards/v2/launches.json');
    expect(HAZARD_PATH.endsWith('.json')).toBe(true);
    expect(HAZARD_PATH.endsWith('.geojson')).toBe(false);
    expect(/\/hazards\/.*\.json(\?.*)?$/.test(HAZARD_PATH)).toBe(true);
    expect(existsSync(resolve(ROOT, 'public/hazards'))).toBe(false);
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
  it('keeps published hazards and cancels delayed framing when a modeled selection clears', () => {
    const projected = tiersAt(catalog([plannerItem()]), NOW);
    if (!projected) throw new Error('missing modeled catalog');
    const modeled = { ...STARSHIP_PIN, ascent: plannerItem().ascent ?? null };
    vi.spyOn(launchCatalog, 'read').mockReturnValue({ ...projected, mapPins: [modeled] });
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor, core } = mount();
    document.body.innerHTML = '<div id="map-pane"></div><p id="launch-hazard-caption"></p>';
    bindAscentPad(core);
    refreshAscentTrajectorySource();
    setMapLaunchMode(true);
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    expect(painted(vendor)).toHaveLength(3);
    expect(clearLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    expect(painted(vendor)).toHaveLength(3);
    expect(document.getElementById('launch-hazard-caption')?.hidden).toBe(false);
    expect(document.getElementById('launch-ascent-caption')?.hidden).toBe(true);
    const fits = vendor.cameraCalls.filter((call) => call.method === 'fitBounds').length;
    core.setBearing(42);
    vendor.fire('moveend', undefined);
    syncLaunchHazards(NOV13 + 5 * 60_000);
    expect(vendor.cameraCalls.filter((call) => call.method === 'fitBounds')).toHaveLength(fits);
  });
  it('preserves published hazards until the photographer explicitly selects a modeled launch', () => {
    const projected = tiersAt(catalog([plannerItem()]), NOW);
    const modeled = projected?.mapPins[0];
    if (!projected || !modeled) throw new Error('missing modeled pin');
    vi.spyOn(launchCatalog, 'read').mockReturnValue({ ...projected, mapPins: [modeled, STARSHIP_PIN] });
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor } = mount();
    setMapLaunchMode(true);
    syncLaunchHazards(NOV13 + 5 * 60_000);
    expect(painted(vendor)).toHaveLength(3);
    refreshAscentTrajectorySource();
    expect(painted(vendor)).toHaveLength(3);
    expect(focusLaunchOnMap(modeled.eventId)).toBe(true);
    expect(painted(vendor)).toHaveLength(0);
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    expect(painted(vendor)).toHaveLength(3);
  });

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
    expect(fit?.args[1]).toMatchObject({ padding: 50, maxZoom: 6, duration: 0, bearing: 0 });
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
    expect(activeHazardFeatures(rawBundle(), STARSHIP_FLIGHT15_EVENT_ID, now, store.attempt(STARSHIP_FLIGHT15_EVENT_ID, now))).toEqual([]);
    expect(activeHazardFeatures(rawBundle(), STARSHIP_FLIGHT15_EVENT_ID, now, ATTEMPT).length).toBeGreaterThan(0);
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
  it('refuses HTML, a miss, a schema 1 body, and a file with one malformed launch', async () => {
    const html = vi.fn(async () => new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    expect(await loadPublishedHazards(html)).toEqual({ kind: 'withdrawn' });
    const missing = vi.fn(async () => new Response('nope', { status: 404, headers: { 'content-type': 'application/json' } }));
    expect(await loadPublishedHazards(missing)).toEqual({ kind: 'withdrawn' });
    const old = vi.fn(async () => new Response(readFileSync(SCHEMA_1_FILE, 'utf8'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    expect(await loadPublishedHazards(old)).toEqual({ kind: 'withdrawn' });
    const damaged = hazardFile();
    entryOf(damaged, VULCAN_EVENT_ID).notices[0]!.checked_at = 'yesterday';
    expect(await loadPublishedHazards(() => jsonResponse(damaged))).toEqual({ kind: 'withdrawn' });
    const withdrawn = await loadPublishedHazards(() => jsonResponse({ schema_version: 2, status: 'withdrawn' }));
    expect(withdrawn).toEqual({ kind: 'withdrawn' });
    const current = await loadPublishedHazards(() => jsonResponse(hazardFile()));
    expect(current.kind === 'current' && current.bundle.launches.map((launch) => launch.event_id)).toEqual([
      STARSHIP_FLIGHT15_EVENT_ID, USSF_317_EVENT_ID, VULCAN_EVENT_ID,
    ]);
    const none = await loadPublishedHazards(() => jsonResponse({ ...hazardFile(), launches: [] }));
    expect(none.kind === 'current' && none.bundle.launches).toEqual([]);
    expect(html).toHaveBeenCalledWith(HAZARD_PATH, expect.objectContaining({
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
    expect(activeHazardFeatures(rawBundle(), STARSHIP_FLIGHT15_EVENT_ID, cutoff, ATTEMPT).length).toBeGreaterThan(0);
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
    expect(activeHazardFeatures(rawBundle(), STARSHIP_FLIGHT15_EVENT_ID, now, ATTEMPT)).toHaveLength(3);

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
    expect(activeHazardFeatures(rawBundle(), STARSHIP_FLIGHT15_EVENT_ID, now, ATTEMPT)).toHaveLength(3);

    await reloadLaunchHazards(() => jsonResponse(current));
    expect(painted(vendor)).toHaveLength(3);
    const expired = hazardFile();
    for (const notice of entryOf(expired).notices) notice.valid_until = '2026-11-13T22:00:00Z';
    await reloadLaunchHazards(() => jsonResponse(expired));
    expect(painted(vendor)).toEqual([]);

    await reloadLaunchHazards(() => jsonResponse(current));
    const gone = hazardFile();
    gone.launches = gone.launches.filter((launch) => launch.event_id !== STARSHIP_FLIGHT15_EVENT_ID);
    await reloadLaunchHazards(() => jsonResponse(gone));
    expect(painted(vendor)).toEqual([]);

    await reloadLaunchHazards(() => jsonResponse(current));
    const replaced = without(hazardFile(), 'B');
    replaced.revision = 'replaced-revision';
    await reloadLaunchHazards(() => jsonResponse(replaced));
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A']);

    await reloadLaunchHazards(async () => new Response('down', { status: 503 }));
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A']);
    expect(entryOf(current).notices.map((notice) => notice.checked_at)).toEqual(Array(3).fill('2026-11-13T10:02:00Z'));
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
    const replaced = without(hazardFile(), 'B');
    replaced.revision = 'newer-revision';
    const second = reloadLaunchHazards(() => new Promise((resolve) => {
      releaseSecond = resolve;
    }));
    releaseSecond(new Response(JSON.stringify(replaced), { status: 200, headers: { 'content-type': 'application/json' } }));
    await second;
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A']);
    releaseFirst(new Response(JSON.stringify(hazardFile()), { status: 200, headers: { 'content-type': 'application/json' } }));
    await first;
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A']);
    syncLaunchHazards(now + 1000);
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A']);
  });

  it('repaints after a 404 when the catalog asks for the file again', async () => {
    const vendor = ready();
    let status = 200;
    const fetcher: typeof fetch = () => status === 404 ? jsonResponse('missing', 404) : jsonResponse(hazardFile());
    await reloadLaunchHazards(fetcher);
    expect(painted(vendor)).toHaveLength(3);
    status = 404;
    await onHazardCatalogRefresh(fetcher);
    expect(painted(vendor)).toEqual([]);
    status = 200;
    await onHazardCatalogRefresh(fetcher);
    expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A', 'B']);
  });

  it('notifies a hazard reload when a second catalog refresh keeps the same pins', async () => {
    const now = Date.parse('2026-11-13T22:50:00Z');
    const store = await catalogStore(now);
    let notices = 0;
    store.subscribeRefresh(() => { notices += 1; });
    await store.refresh();
    await store.refresh();
    expect(notices).toBe(2);
  });

  it('drops the pin and the polygons when only the NET leaves the published window', async () => {
    const now = Date.parse('2026-11-13T23:00:00Z');
    const slipped = await catalogStore(now, (item) => {
      item.schedule.net = '2026-11-14T22:45:00Z';
    });
    expect(slipped.read(now)?.mapPins.some((pin) => pin.eventId === STARSHIP_FLIGHT15_EVENT_ID)).toBe(false);
    expect(slipped.attempt(STARSHIP_FLIGHT15_EVENT_ID, now)).toBeNull();
    followStore(slipped);
    const { vendor } = mount();
    setMapLaunchMode(true);
    syncLaunchHazards(now);
    expect(painted(vendor)).toEqual([]);
    expect(activeHazardFeatures(rawBundle(), STARSHIP_FLIGHT15_EVENT_ID, now, ATTEMPT).length).toBeGreaterThan(0);
    const later = await catalogStore(now, (item) => {
      item.schedule.net = '2026-11-19T22:45:00Z';
    });
    expect(later.attempt(STARSHIP_FLIGHT15_EVENT_ID, now)).toBeNull();
    expect(later.read(now)?.mapPins.some((pin) => pin.eventId === STARSHIP_FLIGHT15_EVENT_ID)).toBe(false);
  });

  it('stops painting once the Nov 13 review is more than two days old', () => {
    const bundle = rawBundle();
    const backup = {
      startMs: Date.parse('2026-11-19T22:45:00Z'),
      endMs: Date.parse('2026-11-20T00:00:00Z'),
    };
    expect(activeHazardFeatures(bundle, STARSHIP_FLIGHT15_EVENT_ID, Date.parse('2026-11-19T22:50:00Z'), backup)).toEqual([]);
    expect(activeHazardFeatures(bundle, STARSHIP_FLIGHT15_EVENT_ID, Date.parse('2026-11-13T22:50:00Z'), ATTEMPT)).toHaveLength(3);
  });

  it('repaints moved geometry when the feature ids stay the same', async () => {
    const vendor = ready();
    const original = hazardFile();
    await reloadLaunchHazards(() => jsonResponse(original));
    const before = painted(vendor).find((feature) => feature.properties?.area_id === 'A');
    if (!before || before.geometry.type !== 'Polygon') throw new Error('missing area A');
    const oldLon = before.geometry.coordinates[0]?.[0]?.[0];
    const moved = hazardFile();
    const area = entryOf(moved).geojson.features.find((feature) => feature.properties.area_id === 'A');
    const point = area?.geometry.coordinates[0]?.[0];
    if (!point || oldLon === undefined) throw new Error('missing vertex');
    point[0] = oldLon + 0.25;
    const close = area?.geometry.coordinates[0];
    const last = close?.[close.length - 1];
    if (last) last[0] = oldLon + 0.25;
    await reloadLaunchHazards(() => jsonResponse(moved));
    const after = painted(vendor).find((feature) => feature.properties?.area_id === 'A');
    if (!after || after.geometry.type !== 'Polygon') throw new Error('missing amended area A');
    const lons = (after.geometry.coordinates[0] ?? []).flatMap((position) => {
      const lon = position[0];
      return typeof lon === 'number' ? [lon] : [];
    });
    expect(lons.some((lon) => Math.abs(lon - (oldLon + 0.25)) < 1e-6)).toBe(true);
  });

  it('shows the new checked time on the polygon popup when only the review time changes', async () => {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [{ eventId: STARSHIP_FLIGHT15_EVENT_ID }],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor, core } = mount();
    bindAscentPad(core);
    setMapLaunchMode(true);
    const show = async (body: ReturnType<typeof hazardFile>) => {
      await reloadLaunchHazards(() => jsonResponse(body));
      const feature = painted(vendor).find((item) => item.properties?.area_id === '6/7129');
      if (!feature) throw new Error('missing painted TFR');
      vendor.fireLayer('click', 'launch-hazard-fill-layer', {
        point: { x: 2, y: 2 },
        lngLat: [-97.1, 26],
        features: [{ properties: feature.properties, geometry: feature.geometry }],
      });
      return vendor.popups.at(-1)?.content.textContent ?? '';
    };
    const first = await show(hazardFile());
    expect(first).toContain('Checked 2026-11-13T10:02:00Z');
    expect(first).toContain('SFC-UNL.');
    expect(first).toContain('EXCLUDING AIRSPACE OVER INTERNATIONAL WATERS.');
    const second = await show(reviewed(hazardFile(), '2026-11-13T23:00:00Z'));
    expect(second).toContain('Checked 2026-11-13T23:00:00Z');
    expect(second).not.toContain('Checked 2026-11-13T10:02:00Z');
  });

  it('rewrites the open polygon popup when only the review time changes', async () => {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [{ eventId: STARSHIP_FLIGHT15_EVENT_ID }],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor, core } = mount();
    bindAscentPad(core);
    setMapLaunchMode(true);
    await reloadLaunchHazards(() => jsonResponse(hazardFile()));
    const feature = painted(vendor).find((item) => item.properties?.area_id === '6/7129');
    if (!feature) throw new Error('missing painted TFR');
    vendor.fireLayer('click', 'launch-hazard-fill-layer', {
      point: { x: 2, y: 2 },
      lngLat: [-97.1, 26],
      features: [{ properties: feature.properties, geometry: feature.geometry }],
    });
    const popup = vendor.popups.at(-1);
    expect(popup?.removed).toBe(false);
    expect(popup?.content.textContent).toContain('Checked 2026-11-13T10:02:00Z');
    const amended = hazardFile();
    reviewed(amended, '2026-11-13T23:00:00Z');
    await reloadLaunchHazards(() => jsonResponse(amended));
    expect(popup?.removed).toBe(false);
    expect(vendor.popups.filter((item) => !item.removed)).toHaveLength(1);
    expect(popup?.content.textContent).toContain('Checked 2026-11-13T23:00:00Z');
    expect(popup?.content.textContent).not.toContain('Checked 2026-11-13T10:02:00Z');
  });

  it('closes the open polygon popup when its feature is withdrawn', async () => {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [{ eventId: STARSHIP_FLIGHT15_EVENT_ID }],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor, core } = mount();
    bindAscentPad(core);
    setMapLaunchMode(true);
    await reloadLaunchHazards(() => jsonResponse(hazardFile()));
    const feature = painted(vendor).find((item) => item.properties?.area_id === '6/7129');
    if (!feature) throw new Error('missing painted TFR');
    vendor.fireLayer('click', 'launch-hazard-fill-layer', {
      point: { x: 2, y: 2 },
      lngLat: [-97.1, 26],
      features: [{ properties: feature.properties, geometry: feature.geometry }],
    });
    const popup = vendor.popups.at(-1);
    expect(popup?.removed).toBe(false);
    await reloadLaunchHazards(() => jsonResponse('missing', 404));
    expect(popup?.removed).toBe(true);
    expect(painted(vendor)).toEqual([]);
  });

  const INDEPENDENT_NOTICE = 'HYDROPAC 999/26';

  function withSecondAreaA(body: HazardFile): HazardFile {
    const copy = structuredClone(body);
    const launch = entryOf(copy);
    const notice = launch.notices.find((item) => item.area_id === 'A');
    const feature = launch.geojson.features.find((item) => item.properties.area_id === 'A');
    if (!notice || !feature) throw new Error('missing area A');
    launch.notices.push({ ...notice, notice_id: INDEPENDENT_NOTICE });
    launch.geojson.features.push({
      ...feature,
      id: `${INDEPENDENT_NOTICE}\u0000A`,
      properties: { ...feature.properties, notice_id: INDEPENDENT_NOTICE },
    });
    return copy;
  }

  function withoutIndependentNotice(body: HazardFile): HazardFile {
    const copy = structuredClone(body);
    const launch = entryOf(copy);
    launch.notices = launch.notices.filter((item) => item.notice_id !== INDEPENDENT_NOTICE);
    launch.geojson.features = launch.geojson.features.filter((item) => item.properties.notice_id !== INDEPENDENT_NOTICE);
    return copy;
  }

  async function openBothAreaA(vendor: VendorDouble): Promise<NonNullable<VendorDouble['popups'][number]>> {
    await reloadLaunchHazards(() => jsonResponse(withSecondAreaA(hazardFile())));
    const areas = painted(vendor).filter((item) => item.properties?.area_id === 'A');
    if (areas.length !== 2) throw new Error('expected two area A notices');
    vendor.fireLayer('click', 'launch-hazard-fill-layer', {
      point: { x: 2, y: 2 },
      lngLat: [-90, 24],
      features: areas.map((feature) => ({ properties: feature.properties, geometry: feature.geometry })),
    });
    const popup = vendor.popups.at(-1);
    if (!popup) throw new Error('expected an open popup');
    return popup;
  }

  it('keeps both area A notices in the open popup when only the review time changes', async () => {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [{ eventId: STARSHIP_FLIGHT15_EVENT_ID }],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor, core } = mount();
    bindAscentPad(core);
    setMapLaunchMode(true);
    const popup = await openBothAreaA(vendor);
    expect(popup.removed).toBe(false);
    const amended = withSecondAreaA(hazardFile());
    reviewed(amended, '2026-11-13T23:00:00Z');
    await reloadLaunchHazards(() => jsonResponse(amended));
    const text = popup.content.textContent ?? '';
    expect(popup.removed).toBe(false);
    expect(text.split('NAVAREA IV 1080/26 area A').length - 1).toBe(1);
    expect(text.split(`${INDEPENDENT_NOTICE} area A`).length - 1).toBe(1);
    expect(text).toContain('Checked 2026-11-13T23:00:00Z');
    expect(text).not.toContain('Checked 2026-11-13T10:02:00Z');
  });

  it('closes the open popup when one area A notice is withdrawn', async () => {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [{ eventId: STARSHIP_FLIGHT15_EVENT_ID }],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const { vendor, core } = mount();
    bindAscentPad(core);
    setMapLaunchMode(true);
    const popup = await openBothAreaA(vendor);
    expect(popup.removed).toBe(false);
    await reloadLaunchHazards(() => jsonResponse(withoutIndependentNotice(withSecondAreaA(hazardFile()))));
    expect(popup.removed).toBe(true);
    const left = painted(vendor).filter((item) => item.properties?.area_id === 'A');
    expect(left.map((item) => item.properties?.notice_id)).toEqual(['NAVAREA IV 1080/26']);
  });

  it('paints the polygons when a catalog refresh finishes', async () => {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      mapPins: [{ eventId: STARSHIP_FLIGHT15_EVENT_ID }],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const vendor = createVendorDouble();
    noteLaunchCore(createMapCore(vendor, createClock(() => Date.parse('2026-11-13T22:50:00Z'))));
    setMapLaunchMode(true);
    vi.stubGlobal('fetch', (input: RequestInfo) => (
      String(input).includes('/hazards/')
        ? jsonResponse(hazardFile())
        : Promise.reject(new Error('catalog miss'))
    ));
    bindLaunchStore();
    await launchCatalog.refresh();
    await vi.waitFor(() => {
      expect(painted(vendor).map((feature) => feature.properties?.area_id).sort()).toEqual(['6/7129', 'A', 'B']);
    });
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
    publishHazardNotes([]);
    expect(document.querySelector('[data-tier-track]')?.textContent).toBe('Pad only');
    expect(document.querySelector('.launch-dialog')?.textContent ?? '').not.toContain('NAVAREA');
    HTMLDialogElement.prototype.showModal = showModal;
  });

  it('adds the notice block to the map card when the polygons arrive', () => {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      highlights: [],
      mapPins: [STARSHIP_PIN],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const brief = document.createElement('div');
    brief.id = 'map-launch-coverage';
    document.body.append(brief);
    renderMapLaunchBrief(brief, { artifact: null, availability: 'ready' } as never, Date.parse('2026-11-13T22:50:00Z'), () => {});
    expect(brief.querySelector('[data-hazard-note]')).toBeNull();
    mount();
    setMapLaunchMode(true);
    syncLaunchHazards(Date.parse('2026-11-13T22:50:00Z'));
    const noteText = brief.querySelector('[data-hazard-note]')?.textContent ?? '';
    expect(noteText).toContain('NAVAREA IV 1080/26 area B');
    expect(noteText).toContain('high_risk');
    expect(noteText).toContain('UTC');
    expect(noteText).toMatch(/CST|CDT/);
    expect(noteText).toContain('Checked 2026-11-13T10:02:00Z');
    expect(noteText).toContain('three hours prior to the earliest launch');
    expect(noteText).toContain('Mariners should avoid waters within the defined hazard areas during the scheduled launch window.');
    expect(noteText).toContain('SFC-UNL.');
    expect(noteText).toContain('EXCLUDING AIRSPACE OVER INTERNATIONAL WATERS.');
    expect(brief.querySelector('[data-hazard-note] a')?.textContent).toMatch(/^https:\/\//);
  });
  it('keeps the latest map action and pressed state through a hazard redraw', () => {
    const modeled = { ...STARSHIP_PIN, ascent: plannerItem().ascent ?? null };
    vi.spyOn(launchCatalog, 'read').mockReturnValue({ highlights: [], mapPins: [modeled] } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const brief = document.createElement('div');
    document.body.append(brief);
    const previous = vi.fn();
    const current = vi.fn();
    renderMapLaunchBrief(brief, { artifact: null, availability: 'ready' } as never, NOV13, previous, () => false);
    renderMapLaunchBrief(brief, { artifact: null, availability: 'ready' } as never, NOV13, current, () => true);
    mount();
    setMapLaunchMode(true);
    syncLaunchHazards(NOV13 + 5 * 60_000);
    const button = brief.querySelector<HTMLButtonElement>('.launch-brief-actions button')!;
    expect(button.textContent).toBe('Hide modeled ascent');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    button.click();
    expect(current).toHaveBeenCalledWith(STARSHIP_FLIGHT15_EVENT_ID);
    expect(previous).not.toHaveBeenCalled();
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

  it('leaves the camera where the user put it when hazards arrive after a wheel zoom or an arrow key', () => {
    pins();
    const pane = document.createElement('div');
    pane.id = 'map-pane';
    const surface = document.createElement('div');
    pane.append(surface);
    document.body.append(pane);
    const vendor = createVendorDouble();
    const recorded = vendor.fitBounds.bind(vendor);
    vendor.fitBounds = (box, options) => {
      recorded(box, options);
      const span = Math.max(box.east - box.west, box.north - box.south, 1e-9);
      vendor.easeTo({
        center: [(box.west + box.east) / 2, (box.south + box.north) / 2],
        zoom: Math.min(options.maxZoom, Math.log2(360 / span)),
        duration: 0,
      });
    };
    const core = createMapCore(vendor, createClock(() => when));
    noteLaunchCore(core);
    bindAscentPad(core);
    const held = (before: { lng: number; lat: number; zoom: number }) => {
      const [lng, lat] = vendor.center();
      expect(lng).toBeCloseTo(before.lng, 8);
      expect(lat).toBeCloseTo(before.lat, 8);
      expect(vendor.zoom()).toBeCloseTo(before.zoom, 8);
    };
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    const beforeWheel = { lng: vendor.center()[0], lat: vendor.center()[1], zoom: vendor.zoom() };
    surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }));
    useHazardBundleForTest(rawBundle());
    syncLaunchHazards(when);
    held(beforeWheel);

    resetLaunchForTest();
    noteLaunchCore(core);
    bindAscentPad(core);
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    const beforeArrow = { lng: vendor.center()[0], lat: vendor.center()[1], zoom: vendor.zoom() };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    useHazardBundleForTest(rawBundle());
    syncLaunchHazards(when);
    held(beforeArrow);
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
      maxZoom: 6,
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

  it('keeps the pad clear of an expanded card that is wider than 46 percent of the map', () => {
    pins();
    const pane = document.createElement('div');
    pane.id = 'map-pane';
    const card = document.createElement('div');
    card.id = 'map-launch-coverage';
    document.body.append(pane, card);
    rect(pane, 0, 0, 1024, 768);
    rect(card, 8, 120, 500, 520);
    const { vendor } = mount();
    vendor.setBearing(0);
    setMapLaunchMode(true);
    syncLaunchHazards(when);
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    const fit = vendor.cameraCalls.find((call) => call.method === 'fitBounds');
    const padding = fit?.args[1] as { padding: { left: number } };
    expect(padding.padding.left).toBeGreaterThanOrEqual(520);
  });
});

describe('hazard areas for every catalog launch', () => {
  const VULCAN_NOW = Date.parse('2026-11-14T17:40:00Z');
  const VULCAN_ATTEMPT = { startMs: Date.parse('2026-11-14T17:32:00Z'), endMs: Date.parse('2026-11-14T18:01:00Z') };
  const FALCON_NOW = Date.parse('2026-11-18T03:30:00Z');
  const FALCON_ATTEMPT = { startMs: Date.parse('2026-11-18T03:14:00Z'), endMs: Date.parse('2026-11-18T07:14:00Z') };
  const VULCAN_PIN: TierLaunch = {
    ...STARSHIP_PIN,
    eventId: VULCAN_EVENT_ID,
    name: 'Vulcan VC6L | Amazon Leo (LV-01)',
    rocket: 'Vulcan VC6L',
    site: { name: 'Cape Canaveral SFS, FL, USA', lat: 28.58341025, lon: -80.58303644, pad: 'Space Launch Complex 41' },
  };

  function areaIds(features: GeoJSON.Feature[]): string[] {
    return features.map((feature) => String(feature.properties?.area_id)).sort();
  }

  function parsed(file: HazardFile): HazardBundle {
    const bundle = parseHazardBundle(file);
    if (!bundle) throw new Error('hazard file did not parse');
    return bundle;
  }

  function sameWindows(file: HazardFile, eventId: string): HazardFile {
    const windows = [{ start: '2026-11-13T22:45:00Z', end: '2026-11-14T00:40:00Z' }];
    for (const notice of entryOf(file, eventId).notices) Object.assign(notice, { windows });
    return file;
  }

  function bothPins(): void {
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      highlights: [],
      mapPins: [STARSHIP_PIN, VULCAN_PIN],
      find: (eventId: string) => (eventId === VULCAN_EVENT_ID ? VULCAN_PIN : STARSHIP_PIN),
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
  }

  it('matches the Vulcan and Vandenberg vertices to their notice text', () => {
    const bundle = rawBundle();
    const vulcan = readFileSync(resolve(ROOT, 'test/fixtures/notices/navarea-iv-1099-26.txt'), 'utf8');
    const expected = {
      A: pairsBetween(vulcan, 'A. ', 'B. '),
      B: pairsBetween(vulcan, 'B. ', 'C. '),
      C: pairsBetween(vulcan, 'C. ', '2. CANCEL'),
    };
    expect([expected.A.length, expected.B.length, expected.C.length]).toEqual([12, 4, 6]);
    for (const area of ['A', 'B', 'C'] as const) {
      expect(sameRing(featureRing(bundle, area, VULCAN_EVENT_ID), expected[area])).toBe(true);
    }
    const cape = tfrVertices(readFileSync(resolve(ROOT, 'test/fixtures/notices/faa-tfr-6-7111.xml'), 'utf8'));
    expect(cape).toHaveLength(36);
    expect(sameRing(featureRing(bundle, '6/7111', VULCAN_EVENT_ID), cape)).toBe(true);
    const bulletin = readFileSync(resolve(ROOT, 'test/fixtures/notices/navarea-xii-in-force-2026-11-13.txt'), 'utf8');
    const falcon = bulletin.slice(bulletin.indexOf('NAVAREA XII 801/26.'), bulletin.indexOf('NAVAREA XII 799/26.'));
    const chunks = falcon.split('IN AREA BOUND BY').slice(1);
    expect(chunks).toHaveLength(3);
    ['A', 'B', 'C'].forEach((area, index) => {
      const pairs = pairsBetween(chunks[index] ?? '', '', index < 2 ? `${'BC'[index]}. ` : '2. CANCEL');
      expect(sameRing(featureRing(bundle, area, USSF_317_EVENT_ID), pairs)).toBe(true);
    });
    const shifted = structuredClone(bundle);
    const vertex = featureRing(shifted, 'C', VULCAN_EVENT_ID)[2];
    if (!vertex || vertex[1] === undefined) throw new Error('vertex');
    vertex[1] += 0.01;
    expect(sameRing(featureRing(shifted, 'C', VULCAN_EVENT_ID), expected.C)).toBe(false);
    expect(sameRing(featureRing(bundle, 'A', VULCAN_EVENT_ID), pairsBetween(vulcan.replace('31-23.00N', '31-24.00N'), 'A. ', 'B. '))).toBe(false);
  });

  it('paints each launch in its own window under its own event id', () => {
    const bundle = rawBundle();
    const vulcan = activeHazardFeatures(bundle, VULCAN_EVENT_ID, VULCAN_NOW, VULCAN_ATTEMPT);
    expect(areaIds(vulcan)).toEqual(['6/7111', 'A', 'B', 'C']);
    expect(vulcan.every((feature) => feature.properties?.event_id === VULCAN_EVENT_ID)).toBe(true);
    const airspace = vulcan.find((feature) => feature.properties?.area_id === '6/7111')?.properties;
    expect(airspace?.also).toBe('TFR 6/7112');
    expect(airspace?.qualification).toBe('SFC-FL180. EXCLUDING AIRSPACE BEYOND 12 MILE COASTAL LIMIT OVER INTERNATIONAL WATERS.');
    expect(vulcan.find((feature) => feature.properties?.area_id === 'C')?.properties?.qualification).toBe('');
    expect(activeHazardFeatures(bundle, VULCAN_EVENT_ID, Date.parse('2026-11-14T17:21:59Z'), VULCAN_ATTEMPT)).toEqual([]);
    expect(areaIds(activeHazardFeatures(bundle, VULCAN_EVENT_ID, Date.parse('2026-11-14T17:22:00Z'), VULCAN_ATTEMPT))).toEqual(['6/7111']);
    expect(activeHazardFeatures(bundle, VULCAN_EVENT_ID, Date.parse('2026-11-14T19:11:00Z'), VULCAN_ATTEMPT)).toEqual([]);
    expect(activeHazardFeatures(bundle, STARSHIP_FLIGHT15_EVENT_ID, VULCAN_NOW, VULCAN_ATTEMPT)).toEqual([]);
    expect(activeHazardFeatures(bundle, VULCAN_EVENT_ID, NOV13, ATTEMPT)).toEqual([]);
    expect(activeHazardFeatures(bundle, 'not-in-the-file', VULCAN_NOW, VULCAN_ATTEMPT)).toEqual([]);
    const instant = (iso: string) => ({ startMs: Date.parse(iso), endMs: Date.parse(iso) });
    const atOpen = Date.parse('2026-11-14T17:32:00Z');
    expect(areaIds(activeHazardFeatures(bundle, VULCAN_EVENT_ID, atOpen, instant('2026-11-14T17:32:00Z')))).toEqual(['6/7111', 'A', 'B', 'C']);
    expect(areaIds(activeHazardFeatures(bundle, VULCAN_EVENT_ID, atOpen, instant('2026-11-14T19:10:59Z')))).toEqual(['6/7111', 'A', 'B', 'C']);
    expect(activeHazardFeatures(bundle, VULCAN_EVENT_ID, atOpen, instant('2026-11-14T19:11:00Z'))).toEqual([]);
    expect(areaIds(activeHazardFeatures(bundle, VULCAN_EVENT_ID, atOpen, instant('2026-11-14T17:31:59Z')))).toEqual(['6/7111']);
    expect(activeHazardFeatures(bundle, VULCAN_EVENT_ID, atOpen, instant('2026-11-14T17:21:59Z'))).toEqual([]);
    const typo = { startMs: Date.parse('2026-11-16T16:50:00Z'), endMs: Date.parse('2026-11-16T18:28:00Z') };
    expect(activeHazardFeatures(parsed(reviewed(hazardFile(), '2026-11-16T12:00:00Z', VULCAN_EVENT_ID)), VULCAN_EVENT_ID, Date.parse('2026-11-16T17:00:00Z'), typo)).toEqual([]);
  });

  it('drops only the notice whose own review is older than two days', () => {
    expect(activeHazardFeatures(rawBundle(), USSF_317_EVENT_ID, FALCON_NOW, FALCON_ATTEMPT)).toEqual([]);
    const fresh = parsed(reviewed(hazardFile(), '2026-11-17T12:00:00Z', USSF_317_EVENT_ID));
    const falcon = activeHazardFeatures(fresh, USSF_317_EVENT_ID, FALCON_NOW, FALCON_ATTEMPT);
    expect(areaIds(falcon)).toEqual(['A', 'B', 'C']);
    expect(falcon[0]?.properties?.qualification).toBe('Mariners are advised to remain clear of these areas for the duration of operations.');
    expect(falcon.map((feature) => feature.properties?.window_end)).toEqual(['2026-11-18T07:37:00Z', '2026-11-18T07:38:00Z', '2026-11-18T07:57:00Z']);
    const mixed = hazardFile();
    const maritime = entryOf(mixed, VULCAN_EVENT_ID).notices.find((notice) => notice.area_id === 'B');
    if (!maritime) throw new Error('missing area B');
    maritime.checked_at = '2026-11-12T17:40:00Z';
    expect(areaIds(activeHazardFeatures(parsed(mixed), VULCAN_EVENT_ID, VULCAN_NOW, VULCAN_ATTEMPT))).toEqual(['6/7111', 'A', 'C']);
    maritime.checked_at = '2026-11-12T17:40:01Z';
    expect(areaIds(activeHazardFeatures(parsed(mixed), VULCAN_EVENT_ID, VULCAN_NOW, VULCAN_ATTEMPT))).toEqual(['6/7111', 'A', 'B', 'C']);
    maritime.valid_until = '2026-11-14T17:40:00Z';
    expect(areaIds(activeHazardFeatures(parsed(mixed), VULCAN_EVENT_ID, VULCAN_NOW, VULCAN_ATTEMPT))).toEqual(['6/7111', 'A', 'C']);
  });

  it('paints every eligible launch with nothing selected and only the selected launch after a choice', () => {
    bothPins();
    const { vendor } = mount();
    useHazardBundleForTest(parsed(sameWindows(hazardFile(), VULCAN_EVENT_ID)));
    setMapLaunchMode(true);
    syncLaunchHazards(NOV13 + 5 * 60_000);
    expect(painted(vendor)).toHaveLength(7);
    expect(new Set(painted(vendor).map((feature) => feature.properties?.event_id))).toEqual(new Set([STARSHIP_FLIGHT15_EVENT_ID, VULCAN_EVENT_ID]));
    expect(focusLaunchOnMap(VULCAN_EVENT_ID)).toBe(true);
    expect(areaIds(painted(vendor))).toEqual(['6/7111', 'A', 'B', 'C']);
    expect(painted(vendor).every((feature) => feature.properties?.event_id === VULCAN_EVENT_ID)).toBe(true);
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    expect(areaIds(painted(vendor))).toEqual(['6/7129', 'A', 'B']);
    expect(painted(vendor).every((feature) => feature.properties?.event_id === STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    vi.spyOn(launchCatalog, 'read').mockReturnValue({ mapPins: [VULCAN_PIN] } as unknown as TierCatalog);
    syncLaunchHazards(NOV13 + 5 * 60_000);
    expect(areaIds(painted(vendor))).toEqual(['6/7111', 'A', 'B', 'C']);
  });

  it('frames the selected launch and leaves the other launch out of the fit', () => {
    bothPins();
    const { vendor } = mount();
    useHazardBundleForTest(parsed(sameWindows(hazardFile(), VULCAN_EVENT_ID)));
    setMapLaunchMode(true);
    syncLaunchHazards(NOV13 + 5 * 60_000);
    expect(focusLaunchOnMap(VULCAN_EVENT_ID)).toBe(true);
    const vulcan = vendor.cameraCalls.filter((call) => call.method === 'fitBounds').at(-1)?.args[0] as { west: number; east: number; north: number };
    expect(vulcan.west).toBeCloseTo(-80.84556, 4);
    expect(vulcan.east).toBeCloseTo(-55.33333, 4);
    expect(vulcan.north).toBeCloseTo(44.88333, 4);
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    const starship = vendor.cameraCalls.filter((call) => call.method === 'fitBounds').at(-1)?.args[0] as { west: number; east: number };
    expect(starship.west).toBeCloseTo(-97.21667, 4);
    expect(starship.east).toBeCloseTo(-81.05, 4);
  });

  it('gives each card its own launch notices, with both ids where two notices publish one area', () => {
    bothPins();
    const { vendor, core } = mount();
    bindAscentPad(core);
    useHazardBundleForTest(parsed(sameWindows(hazardFile(), VULCAN_EVENT_ID)));
    setMapLaunchMode(true);
    syncLaunchHazards(NOV13 + 5 * 60_000);
    const vulcan = renderTierCard(VULCAN_PIN, () => {});
    const starship = renderTierCard(STARSHIP_PIN, () => {});
    expect(vulcan.querySelector('button.btn')?.textContent).toBe('Show published hazard areas');
    const text = vulcan.querySelector('[data-hazard-note]')?.textContent ?? '';
    expect(text).toContain('TFR 6/7111 (also TFR 6/7112) area 6/7111, airspace restricted_airspace.');
    expect(text).toContain('SFC-FL180. EXCLUDING AIRSPACE BEYOND 12 MILE COASTAL LIMIT OVER INTERNATIONAL WATERS.');
    expect(text).toContain('NAVAREA IV 1099/26 area C, maritime hazard.');
    expect(text).toContain('Checked 2026-11-13T23:27:32Z');
    expect(text).not.toContain('1080/26');
    expect(vulcan.querySelectorAll('[data-hazard-note] a')).toHaveLength(6);
    expect(text).toContain('Published for this launch and not drawn on the map:');
    expect(text).toContain('NAVAREA IV 1099/26 publishes a time the map could not read: "1616550Z TO 161828". Nothing is drawn for that time. Checked 2026-11-13T23:27:32Z.');
    expect(text).toContain('USCG LNM 58225 is not drawn. Active RNA. Space Operations/Active RNA/Government Supported (RNA) 1. SPACE LAUNCH OPERATIONS');
    expect([...vulcan.querySelectorAll('[data-hazard-listed]')].map((node) => (node as HTMLElement).dataset.hazardListed)).toEqual(['unread_time', 'not_drawn']);
    expect(painted(vendor).some((feature) => /5829[68]|58225/.test(String(feature.properties?.notice_id)))).toBe(false);
    const other = starship.querySelector('[data-hazard-note]')?.textContent ?? '';
    expect(other).toContain('NAVAREA IV 1080/26 area A, maritime hazard.');
    expect(other).not.toContain('1099/26');
    expect(other).not.toContain('6/7111');
    expect(other).toContain('USCG LNM 58296 is not drawn. Safety Zone. Gulf of America');
    expect(other).toContain('USCG LNM 58298 is not drawn. Safety Zone. South Bay');
    expect(other).not.toContain('58225');
    const feature = painted(vendor).find((item) => item.properties?.area_id === '6/7111');
    if (!feature) throw new Error('missing Cape airspace');
    vendor.fireLayer('click', 'launch-hazard-fill-layer', {
      point: { x: 2, y: 2 },
      lngLat: [-80.5, 28.6],
      features: [{ properties: feature.properties, geometry: feature.geometry }],
    });
    const popup = vendor.popups.at(-1)?.content.textContent ?? '';
    expect(popup).toContain(HAZARD_LABEL);
    expect(popup).toContain('TFR 6/7111 (also TFR 6/7112) area 6/7111, airspace restricted_airspace.');
    expect(popup).toContain('SFC-FL180.');
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    expect(renderTierCard(VULCAN_PIN, () => {}).querySelector('[data-hazard-note]')).toBeNull();
    expect(renderTierCard(VULCAN_PIN, () => {}).querySelector('button.btn')?.textContent).toBe('Show launch site');
  });

  it('refuses a file over the size limit or with more notices than the map accepts', async () => {
    const big = hazardFile();
    const launch = entryOf(big, VULCAN_EVENT_ID);
    const notice = launch.notices[0];
    const feature = launch.geojson.features[0];
    if (!notice || !feature) throw new Error('missing notice');
    for (let index = 0; index < 13; index += 1) {
      launch.notices.push({ ...notice, area_id: `X${index}` });
      launch.geojson.features.push({ ...feature, properties: { ...feature.properties, area_id: `X${index}` } });
    }
    expect(launch.notices).toHaveLength(17);
    expect(parseHazardBundle(big)).toBeNull();
    launch.notices.pop();
    launch.geojson.features.pop();
    expect(parseHazardBundle(big)).not.toBeNull();
    const padded = { ...hazardFile(), padding: 'x'.repeat(256 * 1024) };
    expect(await loadPublishedHazards(() => jsonResponse(padded))).toEqual({ kind: 'withdrawn' });
    const twice = hazardFile();
    twice.launches.push(entryOf(twice));
    expect(parseHazardBundle(twice)).toBeNull();
  });

  it('paints two launches with overlapping windows, hides both for a third, and brings both back on deselect', () => {
    const quiet: TierLaunch = { ...STARSHIP_PIN, eventId: 'launch-without-notices', name: 'Electron | No notices' };
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      highlights: [],
      mapPins: [STARSHIP_PIN, VULCAN_PIN, quiet],
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockReturnValue(ATTEMPT);
    const caption = document.createElement('p');
    caption.id = 'launch-hazard-caption';
    caption.hidden = true;
    document.body.append(caption);
    const { vendor, core } = mount();
    bindAscentPad(core);
    syncMapLaunchMode();
    useHazardBundleForTest(parsed(sameWindows(hazardFile(), VULCAN_EVENT_ID)));
    setMapLaunchMode(true);
    const at = NOV13 + 5 * 60_000;
    const keys = () => painted(vendor).map((feature) => `${feature.properties?.event_id}/${feature.properties?.area_id}`).sort();
    syncLaunchHazards(at);
    const everything = keys();
    expect(everything).toEqual([
      `${STARSHIP_FLIGHT15_EVENT_ID}/6/7129`, `${STARSHIP_FLIGHT15_EVENT_ID}/A`, `${STARSHIP_FLIGHT15_EVENT_ID}/B`,
      `${VULCAN_EVENT_ID}/6/7111`, `${VULCAN_EVENT_ID}/A`, `${VULCAN_EVENT_ID}/B`, `${VULCAN_EVENT_ID}/C`,
    ].sort());
    expect(document.querySelectorAll('#launch-hazard-caption')).toHaveLength(1);
    expect(caption.hidden).toBe(false);
    expect(caption.textContent).toBe(HAZARD_LABEL);
    expect(focusLaunchOnMap(VULCAN_EVENT_ID)).toBe(true);
    expect(keys()).toEqual(everything.filter((key) => key.startsWith(VULCAN_EVENT_ID)));
    expect(focusLaunchOnMap('launch-without-notices')).toBe(true);
    expect(keys()).toEqual([]);
    expect(caption.hidden).toBe(true);
    syncLaunchHazards(at + 60_000);
    expect(keys()).toEqual([]);
    setMapLaunchMode(false);
    setMapLaunchMode(true);
    syncLaunchHazards(at + 120_000);
    expect(keys()).toEqual(everything);
    expect(caption.hidden).toBe(false);
  });

  it('names each launch once in a popup that covers polygons of two launches', () => {
    bothPins();
    const { vendor, core } = mount();
    bindAscentPad(core);
    useHazardBundleForTest(parsed(sameWindows(hazardFile(), VULCAN_EVENT_ID)));
    setMapLaunchMode(true);
    syncLaunchHazards(NOV13 + 5 * 60_000);
    const pick = (eventId: string, areaId: string) => {
      const feature = painted(vendor).find((item) => item.properties?.event_id === eventId && item.properties?.area_id === areaId);
      if (!feature) throw new Error(`${eventId} ${areaId}`);
      return { properties: feature.properties, geometry: feature.geometry };
    };
    const open = (features: ReturnType<typeof pick>[]) => {
      vendor.fireLayer('click', 'launch-hazard-fill-layer', { point: { x: 3, y: 3 }, lngLat: [-90, 27], features });
      const content = vendor.popups.at(-1)?.content;
      if (!content) throw new Error('expected a popup');
      return content;
    };
    const one = open([pick(VULCAN_EVENT_ID, 'A'), pick(VULCAN_EVENT_ID, '6/7111')]);
    expect([...one.querySelectorAll('[data-hazard-launch]')].map((node) => node.textContent)).toEqual([VULCAN_PIN.name]);
    expect(one.textContent).not.toContain(STARSHIP_PIN.name);
    const both = open([pick(STARSHIP_FLIGHT15_EVENT_ID, 'B'), pick(VULCAN_EVENT_ID, 'A'), pick(STARSHIP_FLIGHT15_EVENT_ID, 'A')]);
    expect([...both.querySelectorAll('[data-hazard-launch]')].map((node) => node.textContent)).toEqual([STARSHIP_PIN.name, VULCAN_PIN.name]);
    expect(both.textContent).toContain('NAVAREA IV 1080/26 area B, maritime high_risk.');
    expect(both.textContent).toContain('NAVAREA IV 1099/26 area A, maritime hazard.');
    expect(both.querySelectorAll('a')).toHaveLength(3);
  });

  it('refreshes the selected launch popup and closes it when only that launch withdraws the same notice and area', async () => {
    bothPins();
    const { vendor, core } = mount();
    bindAscentPad(core);
    const file = hazardFile();
    const starship = entryOf(file);
    const vulcan = entryOf(file, VULCAN_EVENT_ID);
    vulcan.notices = structuredClone(starship.notices);
    vulcan.geojson = structuredClone(starship.geojson);
    setMapLaunchMode(true);
    await reloadLaunchHazards(() => jsonResponse(file));
    const area = painted(vendor).find((feature) => feature.properties?.event_id === VULCAN_EVENT_ID && feature.properties?.area_id === 'A');
    if (!area) throw new Error('missing Vulcan area A');
    vendor.fireLayer('click', 'launch-hazard-fill-layer', {
      point: { x: 2, y: 2 }, lngLat: [-90, 24],
      features: [{ properties: area.properties, geometry: area.geometry }],
    });
    const popup = vendor.popups.at(-1);
    expect(popup?.content.textContent).toContain(VULCAN_PIN.name);
    expect(popup?.content.textContent).not.toContain(STARSHIP_PIN.name);
    reviewed(file, '2026-11-13T23:00:00Z', VULCAN_EVENT_ID);
    await reloadLaunchHazards(() => jsonResponse(file));
    expect(popup?.removed).toBe(false);
    expect(popup?.content.textContent).toContain(VULCAN_PIN.name);
    expect(popup?.content.textContent).not.toContain(STARSHIP_PIN.name);
    expect(popup?.content.textContent).toContain('Checked 2026-11-13T23:00:00Z');
    expect(popup?.content.textContent).not.toContain('Checked 2026-11-13T10:02:00Z');
    file.launches = file.launches.filter((launch) => launch.event_id !== VULCAN_EVENT_ID);
    await reloadLaunchHazards(() => jsonResponse(file));
    expect(popup?.removed).toBe(true);
    expect(areaIds(painted(vendor))).toEqual(['6/7129', 'A', 'B']);
    expect(painted(vendor).every((feature) => feature.properties?.event_id === STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
  });

  it('closes the popup when a stable feature id is reassigned to a different notice', async () => {
    bothPins();
    const { vendor, core } = mount();
    bindAscentPad(core);
    const file = hazardFile();
    setMapLaunchMode(true);
    await reloadLaunchHazards(() => jsonResponse(file));
    const area = painted(vendor).find((feature) => feature.properties?.area_id === 'A');
    if (!area) throw new Error('missing area A');
    vendor.fireLayer('click', 'launch-hazard-fill-layer', {
      point: { x: 2, y: 2 }, lngLat: [-90, 24],
      features: [{ properties: area.properties, geometry: area.geometry }],
    });
    const popup = vendor.popups.at(-1);
    const launch = entryOf(file);
    const notice = launch.notices.find((item) => item.area_id === 'A');
    const feature = launch.geojson.features.find((item) => item.properties.area_id === 'A');
    if (!notice || !feature) throw new Error('missing area A');
    notice.notice_id = 'NAVAREA IV 1081/26';
    feature.properties.notice_id = notice.notice_id;
    await reloadLaunchHazards(() => jsonResponse(file));
    expect(popup?.removed).toBe(true);
    expect(painted(vendor).find((item) => item.properties?.area_id === 'A')?.properties?.notice_id).toBe('NAVAREA IV 1081/26');
  });

  it('paints nothing for the unreadable 16 Nov window and says so on the card', () => {
    const NOV16 = Date.parse('2026-11-16T17:00:00Z');
    const attempt = { startMs: Date.parse('2026-11-16T16:50:00Z'), endMs: Date.parse('2026-11-16T17:19:00Z') };
    const notice = readFileSync(resolve(ROOT, 'test/fixtures/notices/navarea-iv-1099-26.txt'), 'utf8');
    expect(notice).toContain('1616550Z TO 161828,');
    const whole = parsed(reviewed(hazardFile(), '2026-11-16T12:00:00Z', VULCAN_EVENT_ID));
    expect(activeHazardFeatures(whole, VULCAN_EVENT_ID, NOV16, attempt)).toEqual([]);
    expect(areaIds(activeHazardFeatures(whole, VULCAN_EVENT_ID, Date.parse('2026-11-17T17:00:00Z'), {
      startMs: Date.parse('2026-11-17T16:28:00Z'), endMs: Date.parse('2026-11-17T17:00:00Z'),
    }))).toEqual(['A', 'B', 'C']);
    const listed = activeHazardListings(whole, VULCAN_EVENT_ID, NOV16, attempt);
    expect(listed.map((item) => [item.noticeId, item.reason, item.text])).toEqual([
      ['NAVAREA IV 1099/26', 'unread_time', '1616550Z TO 161828'],
      ['USCG LNM 58225', 'not_drawn', expect.stringContaining('Active RNA.')],
    ]);
    expect(activeHazardListings(whole, VULCAN_EVENT_ID, NOV16, null)).toEqual([]);
    expect(activeHazardListings(whole, STARSHIP_FLIGHT15_EVENT_ID, NOV16, attempt).map((item) => item.noticeId)).toEqual([]);
    expect(activeHazardListings(whole, VULCAN_EVENT_ID, Date.parse('2026-11-18T12:00:00Z'), attempt)).toEqual([]);
    expect(activeHazardListings(whole, VULCAN_EVENT_ID, Date.parse('2026-11-18T11:59:59Z'), attempt)).toHaveLength(2);

    const sixteenth = reviewed(hazardFile(), '2026-11-16T12:00:00Z', VULCAN_EVENT_ID);
    const entry = entryOf(sixteenth, VULCAN_EVENT_ID);
    entry.notices = [];
    entry.geojson.features = [];
    entry.listed = entry.listed.filter((item) => item.reason === 'unread_time');
    expect(activeHazardListings(parsed(sixteenth), VULCAN_EVENT_ID, Date.parse('2026-11-19T18:24:00Z'), attempt)).toEqual([]);
    vi.spyOn(launchCatalog, 'read').mockReturnValue({
      highlights: [],
      mapPins: [VULCAN_PIN, STARSHIP_PIN],
      find: (eventId: string) => (eventId === VULCAN_EVENT_ID ? VULCAN_PIN : STARSHIP_PIN),
    } as unknown as TierCatalog);
    vi.spyOn(launchCatalog, 'attempt').mockImplementation((eventId: string) => (eventId === VULCAN_EVENT_ID ? attempt : null));
    const caption = document.createElement('p');
    caption.id = 'launch-hazard-caption';
    document.body.append(caption);
    const vendor = createVendorDouble();
    const core = createMapCore(vendor, createClock(() => NOV16));
    noteLaunchCore(core);
    bindAscentPad(core);
    useHazardBundleForTest(parsed(sixteenth));
    setMapLaunchMode(true);
    syncLaunchHazards(NOV16);
    expect(painted(vendor)).toEqual([]);
    expect(caption.hidden).toBe(true);
    const card = renderTierCard(VULCAN_PIN, () => {});
    const block = card.querySelector('[data-hazard-note]');
    expect(block?.textContent).toBe(
      'Published for this launch and not drawn on the map:'
      + 'NAVAREA IV 1099/26 publishes a time the map could not read: "1616550Z TO 161828". Nothing is drawn for that time. Checked 2026-11-16T12:00:00Z. '
      + 'https://space-notices.com/notice/nav-warning-NAVAREA%20IV%201099%2F26',
    );
    expect(block?.querySelector('a')?.getAttribute('href')).toBe('https://space-notices.com/notice/nav-warning-NAVAREA%20IV%201099%2F26');
    expect(block?.textContent).not.toContain('not a flight path');
    expect(card.querySelector('button.btn')?.textContent).toBe('Show launch site');
    expect(renderTierCard(STARSHIP_PIN, () => {}).querySelector('[data-hazard-note]')).toBeNull();
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function open() { this.setAttribute('open', ''); };
    openTierDetails(VULCAN_PIN);
    expect(document.querySelector('[data-tier-track]')?.textContent).toBe('Pad only');
    expect(document.querySelector('.launch-dialog [data-hazard-listed="unread_time"]')?.textContent).toContain('"1616550Z TO 161828"');
    expect(focusLaunchOnMap(STARSHIP_FLIGHT15_EVENT_ID)).toBe(true);
    expect(document.querySelector('.launch-dialog [data-hazard-listed]')).toBeNull();
    HTMLDialogElement.prototype.showModal = showModal;
    expect(vendor.cameraCalls.some((call) => call.method === 'fitBounds')).toBe(false);
  });

  it('refuses a file whose undrawn list is malformed, and a launch with nothing to show', () => {
    const edits: ((launch: HazardFileLaunch) => void)[] = [
      (launch) => { launch.listed[0]!.reason = 'hazard'; },
      (launch) => { launch.listed[0]!.text = ''; },
      (launch) => { launch.listed[0]!.text = 'x'.repeat(401); },
      (launch) => { launch.listed[0]!.checked_at = 'yesterday'; },
      (launch) => { launch.listed[0]!.source_url = 'http://example.invalid/'; },
      (launch) => { launch.listed = Array(9).fill(launch.listed[0]); },
      (launch) => { (launch as unknown as { listed: unknown }).listed = null; },
      (launch) => { launch.listed = []; launch.notices = []; launch.geojson.features = []; },
    ];
    for (const edit of edits) {
      const file = hazardFile();
      expect(parseHazardBundle(file)).not.toBeNull();
      edit(entryOf(file, VULCAN_EVENT_ID));
      expect(parseHazardBundle(file)).toBeNull();
    }
    const textOnly = hazardFile();
    const launch = entryOf(textOnly, VULCAN_EVENT_ID);
    launch.notices = [];
    launch.geojson.features = [];
    expect(parseHazardBundle(textOnly)?.launches.find((entry) => entry.event_id === VULCAN_EVENT_ID)?.listed).toHaveLength(2);
  });
});
