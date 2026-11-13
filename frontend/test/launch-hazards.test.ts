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
import { tiersAt } from '../src/launch-tiers';
import { createClock } from '../src/map/map-core/clock';
import { createMapCore } from '../src/map/map-core/core';
import {
  focusLaunchOnMap,
  launchHazardFillLayer,
  launchHazardOutlineLayer,
  noteLaunchCore,
  resetLaunchForTest,
  syncLaunchHazards,
  useHazardBundleForTest,
} from '../src/map/features/launch-corridor';
import { buildTierMapFeatures } from '../src/map/features/launch-corridor/geometry';
import { getMapLaunchMode, setMapLaunchMode } from '../src/map-launch-mode';
import type { TierCatalog } from '../src/launch-tiers';
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
  const bundle = rawBundle();

  function mount(now = '2026-11-13T22:50:00Z') {
    const vendor = createVendorDouble();
    const core = createMapCore(vendor, createClock(() => Date.parse(now)));
    noteLaunchCore(core);
    useHazardBundleForTest(bundle);
    return { vendor, core };
  }

  it('paints closed polygons inside the window and none between windows', () => {
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
    const lines = vendor.sources.get('ascent-trajectory');
    expect(lines).toBeUndefined();
  });
});

describe('catalog attempt after the map pin drops', () => {
  it('still reads the Starship window at 00:10Z and does not put the pin back', async () => {
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
    expect(store.attempt(STARSHIP_FLIGHT15_EVENT_ID, now)).toEqual({
      startMs: Date.parse('2026-11-13T22:45:00Z'),
      endMs: Date.parse('2026-11-14T00:00:00Z'),
    });
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
    expect(await loadPublishedHazards(html)).toBeNull();
    const missing = vi.fn(async () => new Response('nope', { status: 404, headers: { 'content-type': 'application/json' } }));
    expect(await loadPublishedHazards(missing)).toBeNull();
    const body = JSON.parse(readFileSync(HAZARD_FILE, 'utf8')) as { event_id: string };
    body.event_id = 'other-event';
    const wrong = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    expect(await loadPublishedHazards(wrong)).toBeNull();
    expect(html).toHaveBeenCalledWith(STARSHIP_FLIGHT15_HAZARD_PATH, expect.objectContaining({
      cache: 'no-store',
      redirect: 'error',
    }));
  });
});
