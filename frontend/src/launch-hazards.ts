/** Published hazard areas for one launch. Not a trajectory and not a catalog field. */

export const STARSHIP_FLIGHT15_EVENT_ID = '0f867f0c-5422-4d44-93b8-d7faaae7019b';

export const STARSHIP_FLIGHT15_HAZARD_PATH = '/hazards/v1/0f867f0c-5422-4d44-93b8-d7faaae7019b.json';

export const HAZARD_LABEL = 'Published hazard areas \u2014 not a flight path';

const MAX_HAZARD_BYTES = 64 * 1024;

const FILL_OPACITY = {
  hazard: 0.12,
  high_risk: 0.18,
  restricted_airspace: 0.12,
} as const;

const PHASES = new Set(['pad', 'ascent']);
const DOMAINS = new Set(['maritime', 'airspace']);
const CLASSES = new Set(['hazard', 'high_risk', 'restricted_airspace']);

export type HazardAttempt = {
  readonly startMs: number;
  readonly endMs: number;
};

export type HazardWindow = {
  readonly start: string;
  readonly end: string;
  readonly startMs: number;
  readonly endMs: number;
};

export type HazardNotice = {
  readonly authority: string;
  readonly notice_id: string;
  readonly area_id: string;
  readonly phase: 'pad' | 'ascent';
  readonly domain: 'maritime' | 'airspace';
  readonly restriction_class: 'hazard' | 'high_risk' | 'restricted_airspace';
  readonly windows: readonly HazardWindow[];
  readonly source_url: string;
  readonly source_sha256: string;
};

export type HazardBundle = {
  readonly schema_version: 1;
  readonly revision: string;
  readonly event_id: string;
  readonly label: string;
  readonly checked_at: string;
  readonly valid_until: string;
  readonly validUntilMs: number;
  readonly notices: readonly HazardNotice[];
  readonly geojson: GeoJSON.FeatureCollection;
};

type Position = [number, number];

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function instant(value: unknown): { text: string; ms: number } | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { text: value, ms } : null;
}

function windowsOf(value: unknown): HazardWindow[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
  const windows: HazardWindow[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const entry of value) {
    const row = record(entry);
    if (!row) return null;
    const start = instant(row.start);
    const end = instant(row.end);
    if (!start || !end || end.ms <= start.ms || start.ms < previousEnd) return null;
    previousEnd = end.ms;
    windows.push({ start: start.text, end: end.text, startMs: start.ms, endMs: end.ms });
  }
  return windows;
}

function ringOf(value: unknown): Position[] | null {
  if (!Array.isArray(value) || value.length < 4 || value.length > 512) return null;
  const ring: Position[] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const lon = point[0];
    const lat = point[1];
    if (typeof lon !== 'number' || typeof lat !== 'number') return null;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    ring.push([lon, lat]);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) return null;
  for (let index = 1; index < ring.length; index += 1) {
    const previous = ring[index - 1];
    const next = ring[index];
    if (!previous || !next) return null;
    if (Math.abs(next[0] - previous[0]) > 180) return null;
    if (index < ring.length - 1 && previous[0] === next[0] && previous[1] === next[1]) return null;
  }
  return counterClockwise(ring);
}

function counterClockwise(ring: readonly Position[]): Position[] {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const start = ring[index];
    const end = ring[index + 1];
    if (!start || !end) return ring.slice();
    sum += start[0] * end[1] - end[0] * start[1];
  }
  if (sum >= 0) return ring.slice();
  const open = ring.slice(0, -1).reverse();
  const first = open[0];
  if (!first) return ring.slice();
  return [...open, [first[0], first[1]]];
}

function noticeOf(value: unknown): HazardNotice | null {
  const row = record(value);
  if (!row) return null;
  const authority = text(row.authority);
  const noticeId = text(row.notice_id);
  const areaId = text(row.area_id);
  const phase = row.phase;
  const domain = row.domain;
  const restriction = row.restriction_class;
  const sourceUrl = text(row.source_url);
  const sourceSha = row.source_sha256;
  const windows = windowsOf(row.windows);
  if (!authority || !noticeId || !areaId || !sourceUrl || !windows) return null;
  if (typeof phase !== 'string' || !PHASES.has(phase)) return null;
  if (typeof domain !== 'string' || !DOMAINS.has(domain)) return null;
  if (typeof restriction !== 'string' || !CLASSES.has(restriction)) return null;
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha)) return null;
  if (!sourceUrl.startsWith('https://')) return null;
  return {
    authority,
    notice_id: noticeId,
    area_id: areaId,
    phase: phase as HazardNotice['phase'],
    domain: domain as HazardNotice['domain'],
    restriction_class: restriction as HazardNotice['restriction_class'],
    windows,
    source_url: sourceUrl,
    source_sha256: sourceSha,
  };
}

/** A bundle that fails any check is absent. Vertices are not dropped one by one. */
export function parseHazardBundle(value: unknown): HazardBundle | null {
  const row = record(value);
  if (!row || row.schema_version !== 1) return null;
  if (row.event_id !== STARSHIP_FLIGHT15_EVENT_ID || row.label !== HAZARD_LABEL) return null;
  const revision = text(row.revision);
  const checked = instant(row.checked_at);
  const valid = instant(row.valid_until);
  if (!revision || !checked || !valid || valid.ms <= checked.ms) return null;
  if (!Array.isArray(row.notices) || row.notices.length === 0 || row.notices.length > 8) return null;
  const notices: HazardNotice[] = [];
  for (const entry of row.notices) {
    const notice = noticeOf(entry);
    if (!notice) return null;
    notices.push(notice);
  }
  const collection = record(row.geojson);
  if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) return null;
  if (collection.features.length !== notices.length || collection.features.length > 8) return null;
  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const entry of collection.features) {
    const feature = record(entry);
    if (!feature || feature.type !== 'Feature') return null;
    const geometry = record(feature.geometry);
    if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) return null;
    if (geometry.coordinates.length !== 1) return null;
    const ring = ringOf(geometry.coordinates[0]);
    if (!ring) return null;
    const props = record(feature.properties);
    if (!props) return null;
    const noticeId = text(props.notice_id);
    const areaId = text(props.area_id);
    if (!noticeId || !areaId) return null;
    const key = `${noticeId}\u0000${areaId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const notice = notices.find((item) => item.notice_id === noticeId && item.area_id === areaId);
    if (!notice) return null;
    if (props.phase !== notice.phase || props.domain !== notice.domain) return null;
    if (props.restriction_class !== notice.restriction_class) return null;
    const id = text(feature.id) ?? key;
    features.push({
      type: 'Feature',
      id,
      properties: {
        notice_id: notice.notice_id,
        area_id: notice.area_id,
        name: text(props.name) ?? `${notice.notice_id} ${notice.area_id}`,
        phase: notice.phase,
        domain: notice.domain,
        restriction_class: notice.restriction_class,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  if (features.length !== notices.length) return null;
  return {
    schema_version: 1,
    revision,
    event_id: STARSHIP_FLIGHT15_EVENT_ID,
    label: HAZARD_LABEL,
    checked_at: checked.text,
    valid_until: valid.text,
    validUntilMs: valid.ms,
    notices,
    geojson: { type: 'FeatureCollection', features },
  };
}

function overlaps(attempt: HazardAttempt, window: HazardWindow): boolean {
  return attempt.startMs < window.endMs && attempt.endMs > window.startMs;
}

function contains(window: HazardWindow, nowMs: number): boolean {
  return window.startMs <= nowMs && nowMs < window.endMs;
}

/** Polygons whose published window contains now and overlaps this attempt. */
export function activeHazardFeatures(
  bundle: HazardBundle,
  nowMs: number,
  attempt: HazardAttempt | null,
): GeoJSON.Feature[] {
  if (!attempt || nowMs >= bundle.validUntilMs) return [];
  const features: GeoJSON.Feature[] = [];
  for (const feature of bundle.geojson.features) {
    const props = feature.properties;
    if (!props) return [];
    const notice = bundle.notices.find((item) => (
      item.notice_id === props.notice_id && item.area_id === props.area_id
    ));
    if (!notice || feature.geometry.type !== 'Polygon') return [];
    const open = notice.windows.some((window) => contains(window, nowMs) && overlaps(attempt, window));
    if (!open) continue;
    const restriction = notice.restriction_class;
    features.push({
      type: 'Feature',
      id: feature.id,
      properties: {
        ...props,
        event_id: bundle.event_id,
        label: HAZARD_LABEL,
        fill_opacity: FILL_OPACITY[restriction],
      },
      geometry: feature.geometry,
    });
  }
  return features;
}

/** Same-origin hazard file. HTML, the wrong event, or a bad ring yields nothing. */
export async function loadPublishedHazards(fetcher: typeof fetch): Promise<HazardBundle | null> {
  try {
    const response = await fetcher(STARSHIP_FLIGHT15_HAZARD_PATH, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/html')) return null;
    const body = await response.text();
    if (body.length > MAX_HAZARD_BYTES || body.trimStart().startsWith('<')) return null;
    return parseHazardBundle(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}
