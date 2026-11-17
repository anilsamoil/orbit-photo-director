/** Published hazard areas for catalog launches. Not a trajectory and not a catalog field. */

export const HAZARD_PATH = '/hazards/v2/launches.json';

export const HAZARD_LABEL = 'Published hazard areas — not a flight path or navigation guidance';

/** A checked notice stays paintable for two days. The notice cancel time is separate. */
export const REVIEW_MAX_MS = 48 * 60 * 60 * 1000;

const MAX_HAZARD_BYTES = 256 * 1024;
const MAX_LAUNCHES = 32;
const MAX_NOTICES = 16;
const MAX_WINDOWS = 16;
const MAX_INSTRUCTIONS = 4;
const MAX_ALSO = 8;
const MAX_LISTED = 8;

const FILL_OPACITY = {
  hazard: 0.12,
  high_risk: 0.18,
  restricted_airspace: 0.12,
} as const;

const DOMAINS = new Set(['maritime', 'airspace']);
const CLASSES = new Set(['hazard', 'high_risk', 'restricted_airspace']);
const LISTED_REASONS = new Set(['unread_time', 'not_drawn']);

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
  readonly domain: 'maritime' | 'airspace';
  readonly restriction_class: 'hazard' | 'high_risk' | 'restricted_airspace';
  readonly windows: readonly HazardWindow[];
  readonly checked_at: string;
  readonly checkedMs: number;
  readonly valid_until: string;
  readonly validUntilMs: number;
  readonly instructions: readonly string[];
  readonly also: readonly string[];
  readonly source_url: string;
  readonly source_sha256: string;
};

/** A published notice the map does not draw: an unreadable time, or a zone listed as text only. */
export type HazardListedNotice = {
  readonly authority: string;
  readonly notice_id: string;
  readonly reason: 'unread_time' | 'not_drawn';
  readonly text: string;
  readonly checked_at: string;
  readonly checkedMs: number;
  readonly valid_until: string;
  readonly validUntilMs: number;
  readonly source_url: string;
};

export type LaunchHazards = {
  readonly event_id: string;
  readonly notices: readonly HazardNotice[];
  readonly geojson: GeoJSON.FeatureCollection;
  readonly listed: readonly HazardListedNotice[];
};

export type HazardBundle = {
  readonly schema_version: 2;
  readonly revision: string;
  readonly generated_at: string;
  readonly label: string;
  readonly launches: readonly LaunchHazards[];
};

export type HazardNote = {
  readonly eventId: string;
  readonly noticeId: string;
  readonly areaId: string;
  readonly also: string;
  readonly domain: string;
  readonly restriction: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly sourceUrl: string;
  readonly checkedAt: string;
  readonly qualification: string;
};

export type HazardListing = {
  readonly eventId: string;
  readonly noticeId: string;
  readonly reason: 'unread_time' | 'not_drawn';
  readonly text: string;
  readonly sourceUrl: string;
  readonly checkedAt: string;
};

export type HazardLoad =
  | { readonly kind: 'current'; readonly bundle: HazardBundle }
  | { readonly kind: 'withdrawn' }
  | { readonly kind: 'unavailable' };

const NOTE_FIELDS = [
  'eventId', 'noticeId', 'areaId', 'also', 'domain', 'restriction',
  'windowStart', 'windowEnd', 'sourceUrl', 'checkedAt', 'qualification',
] as const;

const LISTING_FIELDS = ['eventId', 'noticeId', 'reason', 'text', 'sourceUrl', 'checkedAt'] as const;

const shownNotes: { notes: HazardNote[]; listings: HazardListing[]; listeners: Set<() => void> } = {
  notes: [],
  listings: [],
  listeners: new Set(),
};

function sameRows<Row, Field extends keyof Row>(
  left: readonly Row[], right: readonly Row[], fields: readonly Field[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    return !!other && fields.every((field) => row[field] === other[field]);
  });
}

/** The cards read what the map last painted, and the notices it knows of and does not draw. */
export function publishHazardNotes(notes: readonly HazardNote[], listings: readonly HazardListing[] = []): void {
  const nextNotes = notes.map((note) => ({ ...note }));
  const nextListings = listings.map((listing) => ({ ...listing }));
  if (sameRows(shownNotes.notes, nextNotes, NOTE_FIELDS)
    && sameRows(shownNotes.listings, nextListings, LISTING_FIELDS)) return;
  shownNotes.notes = nextNotes;
  shownNotes.listings = nextListings;
  for (const listener of [...shownNotes.listeners]) listener();
}

export function subscribeHazardNotes(listener: () => void): () => void {
  shownNotes.listeners.add(listener);
  return () => { shownNotes.listeners.delete(listener); };
}

export function hazardNotesFor(eventId: string): readonly HazardNote[] {
  return shownNotes.notes.filter((note) => note.eventId === eventId);
}

export function hazardListingsFor(eventId: string): readonly HazardListing[] {
  return shownNotes.listings.filter((listing) => listing.eventId === eventId);
}

/** One undrawn notice in plain words. An unreadable time is quoted as published. */
export function hazardListingText(
  listing: Pick<HazardListing, 'eventId' | 'noticeId' | 'reason' | 'text' | 'checkedAt'>,
): string {
  const hasDrawnArea = hazardNotesFor(listing.eventId).some((note) => (
    note.noticeId === listing.noticeId || note.also.split(', ').includes(listing.noticeId)
  ));
  const coverage = hasDrawnArea ? 'is partly drawn.' : 'is not drawn.';
  const what = listing.reason === 'unread_time'
    ? `publishes a time the map could not read: "${listing.text}". Nothing is drawn for that time.`
    : `${coverage} ${listing.text}`;
  return `${listing.noticeId} ${what} Checked ${listing.checkedAt}.`;
}

/** The notice facts in one sentence, the same on the card and on the polygon. */
export function hazardFactText(
  fact: Pick<HazardNote, 'noticeId' | 'areaId' | 'also' | 'domain' | 'restriction' | 'checkedAt' | 'qualification'>,
  when: string,
): string {
  const also = fact.also ? ` (also ${fact.also})` : '';
  return `${fact.noticeId}${also} area ${fact.areaId}, ${fact.domain} ${fact.restriction}. ${when} Checked ${fact.checkedAt}. ${fact.qualification}`;
}

type Position = [number, number];

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function texts(value: unknown, limit: number, length: number): string[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const found: string[] = [];
  for (const entry of value) {
    const item = text(entry);
    if (!item || item.length > length) return null;
    found.push(item);
  }
  return found;
}

function instant(value: unknown): { text: string; ms: number } | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { text: value, ms } : null;
}

function windowsOf(value: unknown): HazardWindow[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WINDOWS) return null;
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
  if (!Array.isArray(value) || value.length < 4 || value.length > 513) return null;
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
  const domain = row.domain;
  const restriction = row.restriction_class;
  const sourceUrl = text(row.source_url);
  const sourceSha = row.source_sha256;
  const windows = windowsOf(row.windows);
  const checked = instant(row.checked_at);
  const valid = instant(row.valid_until);
  const instructions = texts(row.instructions, MAX_INSTRUCTIONS, 400);
  const also = texts(row.also, MAX_ALSO, 80);
  if (!authority || !noticeId || !areaId || !sourceUrl || !windows) return null;
  if (!checked || !valid || !instructions || !also) return null;
  if (typeof domain !== 'string' || !DOMAINS.has(domain)) return null;
  if (typeof restriction !== 'string' || !CLASSES.has(restriction)) return null;
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha)) return null;
  if (!sourceUrl.startsWith('https://')) return null;
  return {
    authority,
    notice_id: noticeId,
    area_id: areaId,
    domain: domain as HazardNotice['domain'],
    restriction_class: restriction as HazardNotice['restriction_class'],
    windows,
    checked_at: checked.text,
    checkedMs: checked.ms,
    valid_until: valid.text,
    validUntilMs: valid.ms,
    instructions,
    also,
    source_url: sourceUrl,
    source_sha256: sourceSha,
  };
}

function listedOf(value: unknown): HazardListedNotice | null {
  const row = record(value);
  if (!row) return null;
  const authority = text(row.authority);
  const noticeId = text(row.notice_id);
  const words = text(row.text);
  const reason = row.reason;
  const sourceUrl = text(row.source_url);
  const checked = instant(row.checked_at);
  const valid = instant(row.valid_until);
  if (!authority || !noticeId || !words || words.length > 400 || !sourceUrl || !checked || !valid) return null;
  if (typeof reason !== 'string' || !LISTED_REASONS.has(reason)) return null;
  if (!sourceUrl.startsWith('https://')) return null;
  return {
    authority,
    notice_id: noticeId,
    reason: reason as HazardListedNotice['reason'],
    text: words,
    checked_at: checked.text,
    checkedMs: checked.ms,
    valid_until: valid.text,
    validUntilMs: valid.ms,
    source_url: sourceUrl,
  };
}

function launchOf(value: unknown): LaunchHazards | null {
  const row = record(value);
  const eventId = row ? text(row.event_id) : null;
  if (!row || !eventId) return null;
  if (!Array.isArray(row.listed) || row.listed.length > MAX_LISTED) return null;
  const listed: HazardListedNotice[] = [];
  for (const entry of row.listed) {
    const item = listedOf(entry);
    if (!item) return null;
    listed.push(item);
  }
  if (!Array.isArray(row.notices) || row.notices.length > MAX_NOTICES) return null;
  if (row.notices.length + listed.length === 0) return null;
  const notices: HazardNotice[] = [];
  for (const entry of row.notices) {
    const notice = noticeOf(entry);
    if (!notice) return null;
    notices.push(notice);
  }
  const collection = record(row.geojson);
  if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) return null;
  if (collection.features.length !== notices.length) return null;
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
    if (props.domain !== notice.domain || props.restriction_class !== notice.restriction_class) return null;
    features.push({
      type: 'Feature',
      id: text(feature.id) ?? key,
      properties: {
        notice_id: notice.notice_id,
        area_id: notice.area_id,
        name: text(props.name) ?? `${notice.notice_id} area ${notice.area_id}`,
        domain: notice.domain,
        restriction_class: notice.restriction_class,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  return { event_id: eventId, notices, geojson: { type: 'FeatureCollection', features }, listed };
}

/** A file that fails any check is absent, for every launch. Vertices are not dropped one by one. */
export function parseHazardBundle(value: unknown): HazardBundle | null {
  const row = record(value);
  if (!row || row.schema_version !== 2 || row.label !== HAZARD_LABEL) return null;
  const revision = text(row.revision);
  const generated = instant(row.generated_at);
  if (!revision || !generated) return null;
  if (!Array.isArray(row.launches) || row.launches.length > MAX_LAUNCHES) return null;
  const launches: LaunchHazards[] = [];
  const seen = new Set<string>();
  for (const entry of row.launches) {
    const launch = launchOf(entry);
    if (!launch || seen.has(launch.event_id)) return null;
    seen.add(launch.event_id);
    launches.push(launch);
  }
  return {
    schema_version: 2,
    revision,
    generated_at: generated.text,
    label: HAZARD_LABEL,
    launches,
  };
}

/** An instantaneous attempt counts as the instant it names, also at the first moment of a window. */
function overlaps(attempt: HazardAttempt, window: HazardWindow): boolean {
  const attemptEnd = Math.max(attempt.endMs, attempt.startMs + 1);
  return attempt.startMs < window.endMs && attemptEnd > window.startMs;
}

function contains(window: HazardWindow, nowMs: number): boolean {
  return window.startMs <= nowMs && nowMs < window.endMs;
}

/** One launch's polygons whose published window contains now and overlaps this attempt. */
export function activeHazardFeatures(
  bundle: HazardBundle,
  eventId: string,
  nowMs: number,
  attempt: HazardAttempt | null,
): GeoJSON.Feature[] {
  const launch = bundle.launches.find((entry) => entry.event_id === eventId);
  if (!launch || !attempt) return [];
  const features: GeoJSON.Feature[] = [];
  for (const feature of launch.geojson.features) {
    const props = feature.properties;
    if (!props) return [];
    const notice = launch.notices.find((item) => (
      item.notice_id === props.notice_id && item.area_id === props.area_id
    ));
    if (!notice || feature.geometry.type !== 'Polygon') return [];
    if (nowMs >= notice.validUntilMs || nowMs >= notice.checkedMs + REVIEW_MAX_MS) continue;
    const openWindow = notice.windows.find((window) => contains(window, nowMs) && overlaps(attempt, window));
    if (!openWindow) continue;
    features.push({
      type: 'Feature',
      id: feature.id,
      properties: {
        ...props,
        event_id: launch.event_id,
        label: HAZARD_LABEL,
        fill_opacity: FILL_OPACITY[notice.restriction_class],
        source_url: notice.source_url,
        window_start: openWindow.start,
        window_end: openWindow.end,
        checked_at: notice.checked_at,
        also: notice.also.join(', '),
        qualification: notice.instructions.join(' '),
      },
      geometry: feature.geometry,
    });
  }
  return features;
}

/** One launch's undrawn notices that are still in force and reviewed, while the launch has an attempt. */
export function activeHazardListings(
  bundle: HazardBundle,
  eventId: string,
  nowMs: number,
  attempt: HazardAttempt | null,
): HazardListing[] {
  const launch = bundle.launches.find((entry) => entry.event_id === eventId);
  if (!launch || !attempt) return [];
  return launch.listed
    .filter((item) => nowMs < item.validUntilMs && nowMs < item.checkedMs + REVIEW_MAX_MS)
    .map((item) => ({
      eventId: launch.event_id,
      noticeId: item.notice_id,
      reason: item.reason,
      text: item.text,
      sourceUrl: item.source_url,
      checkedAt: item.checked_at,
    }));
}

/** Same-origin hazard file. A 404 or a bad body is withdrawal. A 5xx is unavailable. */
export async function loadPublishedHazards(fetcher: typeof fetch): Promise<HazardLoad> {
  try {
    const response = await fetcher(HAZARD_PATH, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (response.status === 404) return { kind: 'withdrawn' };
    if (!response.ok) return { kind: 'unavailable' };
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/html')) return { kind: 'withdrawn' };
    const body = await response.text();
    if (body.length > MAX_HAZARD_BYTES || body.trimStart().startsWith('<')) return { kind: 'withdrawn' };
    const parsed: unknown = JSON.parse(body);
    const row = record(parsed);
    if (row?.status === 'withdrawn') return { kind: 'withdrawn' };
    const bundle = parseHazardBundle(parsed);
    return bundle ? { kind: 'current', bundle } : { kind: 'withdrawn' };
  } catch {
    return { kind: 'unavailable' };
  }
}
