import { tleEpochMs } from './iss-sgp4';
import { rememberIssTle } from './iss-tle';
import { reentered, type TrackedLookup, type TrackedRecord } from './tracked';

/** Multi-satellite tracking (v1.6.0.0 — Pettit feedback #6).
 *
 *  Curated hot-list + custom NORAD/name search. An orbit comes from the
 *  publisher's `tracked.json` first, then the last good element set in
 *  localStorage, then CelesTrak GP and Supplemental GP when the operator
 *  asks. Nothing here invents an element set.
 *
 *  Per /plan-eng-review 2026-05-22:
 *    A1: never block map render on CelesTrak; fetch lazily on selection
 *    A3: 3-line TLE parser (CelesTrak's FORMAT=TLE returns name + 2 data lines)
 *    A4: surface multi-match count to operator when name-search returns >1
 *    Q1: discriminated union for resolution (explicit > sentinel)
 */

/** TLE pair as the existing iss-sgp4.ts parser expects, plus the
 *  human-readable name from the optional 3-line "name" header. */
export interface TLEPair {
  line1: string;
  line2: string;
  /** Name from the 3LE header line. May differ from the operator's
   *  search query — useful for disambiguation in the picker. */
  name: string;
}

/** How a satellite's TLE is resolved. `published` is a row of the
 *  publisher's `tracked.json`, which also carries how to look it up. */
export type SatelliteResolution =
  | { kind: 'catnr'; catnr: number }
  | { kind: 'name'; query: string }
  | { kind: 'published'; id: string };

export interface SatelliteMeta {
  /** Stable display name in the picker (e.g., "Tiangong (CSS)"). */
  name: string;
  /** Compact label for the topbar readout (≤3 chars). */
  short_label: string;
  /** Track polyline hex color. */
  track_color: string;
  /** Emoji shown in the picker. */
  icon: string;
  resolution: SatelliteResolution;
}

/** Curated hot-list. Order matters — picker renders in this order. */
export const CURATED_SATELLITES: SatelliteMeta[] = [
  {
    name: 'ISS (Zarya)',
    short_label: 'ISS',
    track_color: '#5cd0ff',
    icon: '🛰️',
    resolution: { kind: 'catnr', catnr: 25544 },
  },
  {
    name: 'Tiangong (CSS)',
    short_label: 'Tg',
    track_color: '#ff9e2c',
    icon: '🇨🇳',
    resolution: { kind: 'catnr', catnr: 48274 },
  },
  {
    name: 'Hubble (HST)',
    short_label: 'HST',
    track_color: '#b0ff5c',
    icon: '🔭',
    resolution: { kind: 'catnr', catnr: 20580 },
  },
  {
    name: 'X-37B',
    short_label: 'X37',
    track_color: '#ffd45c',
    icon: '🪐',
    // X-37B uses USA-XXX designations. Searching "USA" returns many
    // hits, but the most recent X-37B mission is usually at the top.
    resolution: { kind: 'name', query: 'USA' },
  },
  {
    name: 'Starship',
    short_label: 'SS',
    track_color: '#ff5c5c',
    icon: '🚀',
    resolution: { kind: 'published', id: 'starship' },
  },
];

/** Stable key for a SatelliteMeta — used as the cache key + the picker
 *  selection key. CATNR resolutions get the integer; name resolutions
 *  get "name:<query>"; published objects get "tracked:<id>". */
export function metaKey(meta: SatelliteMeta): string {
  const resolution = meta.resolution;
  if (resolution.kind === 'catnr') return String(resolution.catnr);
  if (resolution.kind === 'name') return `name:${resolution.query}`;
  return `tracked:${resolution.id}`;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const GP_URL = 'https://celestrak.org/NORAD/elements/gp.php';
const SUPGP_URL = 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php';
const FETCH_TIMEOUT_MS = 15_000;
const HOUR_MS = 3_600_000;

export type Feed = 'gp' | 'supgp';

/** Why a lookup has no answer. `publisher` means the published artifact
 *  reported a failed lookup, and `artifact` that this browser could not load
 *  the artifact; in both, this browser did not ask CelesTrak itself. */
export type LookupFailure = 'timeout' | 'network' | 'http' | 'unreadable' | 'publisher' | 'artifact';

type AskFailure = Exclude<LookupFailure, 'publisher' | 'artifact'>;

/** The outcome of one lookup. `not_found`, `expired` and `reentered` are
 *  answers from a source that replied; `failed` is a source that did not.
 *  `tle` is the object drawn, `also` every other live object of a published
 *  vehicle. `stale` is a last good set, whatever its age.
 *  `stale_epoch_hours` is set when the drawn set is past its fresh window.
 *  `last_good_hours` is set when a failed lookup had only a last good set
 *  past its grace to fall back on. */
export type OrbitLookup =
  | {
      state: 'elements';
      tle: TLEPair;
      also?: readonly TLEPair[];
      match_count: number;
      origin: 'published' | Feed | 'cache';
      stale: boolean;
      stale_epoch_hours?: number;
    }
  | { state: 'not_found' }
  | { state: 'expired' }
  | { state: 'reentered' }
  | { state: 'failed'; cause: LookupFailure; last_good_hours?: number };

/** `published` reads the artifact and the last good cache only. `ask`
 *  also queries CelesTrak, and is for a tap, never a timer. */
export type LookupMode = 'published' | 'ask';

interface CacheEntry {
  tle: TLEPair;
  also?: TLEPair[];
  /** True when this browser got the set from CelesTrak itself. */
  asked?: boolean;
  match_count?: number;
  fetchedAtMs: number;
}

function cacheKey(meta: SatelliteMeta): string {
  return `opd-tle-${metaKey(meta)}`;
}

function isPair(tle: TLEPair | undefined): tle is TLEPair {
  return typeof tle?.line1 === 'string' && typeof tle.line2 === 'string';
}

function readCache(meta: SatelliteMeta): CacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey(meta));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (!isPair(entry?.tle)) return null;
    return { ...entry, also: Array.isArray(entry.also) ? entry.also.filter(isPair) : [] };
  } catch {
    return null;
  }
}

function writeCache(meta: SatelliteMeta, entry: CacheEntry): void {
  try {
    localStorage.setItem(cacheKey(meta), JSON.stringify(entry));
  } catch {
    /* quota exhausted or storage disabled */
  }
}

function forget(meta: SatelliteMeta): void {
  try {
    localStorage.removeItem(cacheKey(meta));
  } catch {
    /* storage disabled */
  }
}

/** Every 2-line or 3-line element set in a CelesTrak FORMAT=TLE body. */
export function parseElementSets(text: string): TLEPair[] {
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const found: TLEPair[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const line1 = lines[i]!;
    const line2 = lines[i + 1]!;
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;
    const before = i > 0 ? lines[i - 1]! : '';
    const named = before !== '' && !before.startsWith('1 ') && !before.startsWith('2 ');
    found.push({ line1, line2, name: named ? before : 'UNKNOWN' });
    i += 1;
  }
  return found;
}

/** The first element set of a body, with how many the body held (A4). */
export function parseCelestrakTLE(text: string): { tle: TLEPair; match_count: number } | null {
  const sets = parseElementSets(text ?? '');
  const first = sets[0];
  return first ? { tle: first, match_count: sets.length } : null;
}

/** COSPAR `2026-159A` and TLE `26159A` compare as the same designator. */
export function canonicalIntldes(value: string): string {
  const text = value.replace(/\s+/g, '').toUpperCase();
  const cospar = /^(\d{4})-(\d{1,3})([A-Z]{1,3})$/.exec(text);
  if (cospar) {
    const year = String(Number(cospar[1]) % 100).padStart(2, '0');
    return `${year}${cospar[2]!.padStart(3, '0')}${cospar[3]}`;
  }
  return text;
}

function matchesLookup(lookup: TrackedLookup, tle: TLEPair): boolean {
  if (lookup.catnr !== undefined && Number(tle.line1.slice(2, 7)) === lookup.catnr) return true;
  if (lookup.intldes && canonicalIntldes(tle.line1.slice(9, 17)) === canonicalIntldes(lookup.intldes)) {
    return true;
  }
  const name = tle.name.replace(/\s+/g, ' ').trim();
  return lookup.patterns.some((source) => {
    try {
      return new RegExp(source, 'i').test(name);
    } catch {
      return false;
    }
  });
}

type Query = { feed: Feed; url: string };

function query(feed: Feed, param: string, value: string | number): Query {
  const base = feed === 'supgp' ? SUPGP_URL : GP_URL;
  return { feed, url: `${base}?${param}=${encodeURIComponent(String(value))}&FORMAT=TLE` };
}

/** The publisher's queries, in the publisher's order: Supplemental GP
 *  before GP, for the catalog number, the designator, then each name. */
export function lookupQueries(lookup: TrackedLookup): Query[] {
  const out: Query[] = [];
  const both = (param: string, value: string | number): void => {
    out.push(query('supgp', param, value), query('gp', param, value));
  };
  if (lookup.catnr !== undefined) both('CATNR', lookup.catnr);
  if (lookup.intldes) both('INTDES', lookup.intldes);
  for (const name of lookup.names) both('NAME', name);
  return out;
}

type Reply =
  | { kind: 'sets'; feed: Feed; sets: TLEPair[] }
  | { kind: 'empty' }
  | { kind: 'error'; cause: AskFailure };

async function ask({ feed, url }: Query): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (resp.status === 404) return { kind: 'empty' };
    if (!resp.ok) return { kind: 'error', cause: 'http' };
    const body = await resp.text();
    const lowered = body.toLowerCase();
    if (body.trim() === '' || lowered.includes('no gp data found') || lowered.includes('no supgp data found')) {
      return { kind: 'empty' };
    }
    const sets = parseElementSets(body);
    return sets.length > 0 ? { kind: 'sets', feed, sets } : { kind: 'error', cause: 'unreadable' };
  } catch {
    return { kind: 'error', cause: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const CAUSE_ORDER: readonly AskFailure[] = ['timeout', 'network', 'http', 'unreadable'];

function worstCause(replies: readonly Reply[]): AskFailure | null {
  const causes = replies.flatMap((reply) => (reply.kind === 'error' ? [reply.cause] : []));
  return CAUSE_ORDER.find((cause) => causes.includes(cause)) ?? null;
}

function fromCache(entry: CacheEntry, stale: boolean): OrbitLookup {
  return { state: 'elements', tle: entry.tle, match_count: entry.match_count ?? 1, origin: 'cache', stale };
}

function keep(meta: SatelliteMeta, tle: TLEPair, matchCount: number, nowMs: number, also: TLEPair[] = [], asked = false): void {
  writeCache(meta, { tle, also, asked, match_count: matchCount, fetchedAtMs: nowMs });
  if (meta.resolution.kind === 'catnr' && meta.resolution.catnr === 25544) rememberIssTle(tle);
}

/** A set as a feed sent it. One read back from this browser's cache has no feed. */
type Candidate = { tle: TLEPair; feed?: Feed };

const order = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);

/** Ships before rocket bodies, then the newest launch, then the higher
 *  catalog number. Epoch is left out, so the first object does not flip
 *  between two live ships as each gets a fresh set. A blank designator is a
 *  launch not yet catalogued, which is the newest. */
function rank({ name, line1 }: TLEPair): [number, number, number, number] {
  const launch = /^(\d{2})(\d{3})/.exec(line1.slice(9, 17).trim());
  const year = launch ? Number(launch[1]) + (Number(launch[1]) < 57 ? 2000 : 1900) : Infinity;
  const number = launch ? Number(launch[2]) : Infinity;
  return [/\bR\/B\b/i.test(name) ? 0 : 1, year, number, Number(line1.slice(2, 7)) || 0];
}

function byRank(a: Candidate, b: Candidate): number {
  const ra = rank(a.tle);
  const rb = rank(b.tle);
  return order(rb[0], ra[0]) || order(rb[1], ra[1]) || order(rb[2], ra[2]) || order(rb[3], ra[3]);
}

function newestPerObject<T extends Candidate>(sets: readonly T[]): { set: T; epochMs: number }[] {
  const newest = new Map<string, { set: T; epochMs: number }>();
  for (const set of sets) {
    const epochMs = tleEpochMs(set.tle);
    if (epochMs === null) continue;
    const catalog = set.tle.line1.slice(2, 7);
    const held = newest.get(catalog);
    const wins = !held || epochMs > held.epochMs || (epochMs === held.epochMs && set.feed === 'supgp' && held.set.feed !== 'supgp');
    if (wins) newest.set(catalog, { set, epochMs });
  }
  return [...newest.values()];
}

/** The objects of a lookup that are in orbit now, the one to draw first:
 *  the newest set of each catalog number, Supplemental GP winning a tie,
 *  inside the lookup's grace and not reentered. */
export function liveObjects<T extends Candidate>(lookup: TrackedLookup, sets: readonly T[], nowMs: number): T[] {
  return newestPerObject(sets)
    .filter(({ set, epochMs }) =>
      nowMs - epochMs <= lookup.grace_hours * HOUR_MS && !reentered(set.tle.line2, epochMs, nowMs))
    .map(({ set }) => set)
    .sort(byRank);
}

/** Why sets that matched a lookup draw nothing. */
function gone(lookup: TrackedLookup, sets: readonly Candidate[], nowMs: number): OrbitLookup {
  const kept = newestPerObject(sets).some(({ epochMs }) => nowMs - epochMs <= lookup.grace_hours * HOUR_MS);
  return kept ? { state: 'reentered' } : { state: 'expired' };
}

/** A failed lookup, saying so when the only last good set is past its grace. */
function failed(cause: LookupFailure, lookup: TrackedLookup | undefined, cached: readonly Candidate[], nowMs: number): OrbitLookup {
  const epochs = newestPerObject(cached).map(({ epochMs }) => epochMs);
  const hours = (nowMs - Math.max(...epochs)) / HOUR_MS;
  return lookup && epochs.length > 0 && hours > lookup.grace_hours
    ? { state: 'failed', cause, last_good_hours: Math.floor(hours) }
    : { state: 'failed', cause };
}

function drawn(
  lookup: TrackedLookup,
  live: readonly Candidate[],
  origin: 'published' | Feed | 'cache',
  stale: boolean,
  nowMs: number,
): OrbitLookup {
  const [first, ...rest] = live.map(({ tle }) => tle) as [TLEPair, ...TLEPair[]];
  const hours = (nowMs - (tleEpochMs(first) ?? nowMs)) / HOUR_MS;
  return {
    state: 'elements',
    tle: first,
    ...(rest.length > 0 ? { also: rest } : {}),
    match_count: live.length,
    origin,
    stale,
    ...(hours > lookup.max_age_hours ? { stale_epoch_hours: Math.floor(hours) } : {}),
  };
}

function keepLive(meta: SatelliteMeta, live: readonly Candidate[], nowMs: number, asked: boolean): void {
  const [first, ...rest] = live.map(({ tle }) => tle) as [TLEPair, ...TLEPair[]];
  keep(meta, first, live.length, nowMs, rest, asked);
}

/** The label of a drawn set that is past its fresh window. */
export function staleOrbit(lookup: OrbitLookup): string | null {
  if (lookup.state !== 'elements' || lookup.stale_epoch_hours === undefined) return null;
  return `stale orbit, epoch ${lookup.stale_epoch_hours} h old`;
}

/** `NAME (NORAD n)` for each live object that is not the one drawn. */
export function alsoInOrbit(lookup: OrbitLookup): string | null {
  if (lookup.state !== 'elements' || !lookup.also?.length) return null;
  const listed = lookup.also.map((tle) => `${tle.name} (NORAD ${Number(tle.line1.slice(2, 7))})`);
  return `Also in orbit: ${listed.join(', ')}`;
}

function publishedRow(meta: SatelliteMeta, published: readonly TrackedRecord[]): TrackedRecord | undefined {
  const resolution = meta.resolution;
  if (resolution.kind === 'published') return published.find((record) => record.id === resolution.id);
  if (resolution.kind === 'catnr') {
    return published.find((record) => record.state === 'elements' && record.norad === resolution.catnr);
  }
  return undefined;
}

type PublishedSet = { tle: TLEPair; feed: Feed; stale: boolean };

/** The row's object, and for a published vehicle every other live object.
 *  A catalog number names one object, so it never takes another in its place. */
function publishedSets(meta: SatelliteMeta, row: TrackedRecord | undefined): PublishedSet[] {
  if (row?.state !== 'elements') return [];
  const objects = meta.resolution.kind === 'published' ? [row, ...(row.also ?? [])] : [row];
  return objects.map((object) => ({
    tle: { line1: object.line1, line2: object.line2, name: object.name },
    feed: object.source,
    stale: object.from_cache === true,
  }));
}

/** What the artifact alone says about a vehicle it holds no live element
 *  set for. */
function publisherVerdict(meta: SatelliteMeta, row: TrackedRecord | undefined, nowMs: number): OrbitLookup {
  if (!row || (row.state === 'unavailable' && row.reason === 'unread')) return { state: 'failed', cause: 'artifact' };
  if (row.state === 'elements') return gone(row.lookup, publishedSets(meta, row), nowMs);
  if (row.reason === 'aged_out') return { state: 'expired' };
  if (row.reason === 'reentered') return { state: 'reentered' };
  if (row.reason === 'lookup_failed') return { state: 'failed', cause: 'publisher' };
  return { state: 'not_found' };
}

async function resolvePublished(
  meta: SatelliteMeta,
  row: TrackedRecord | undefined,
  mode: LookupMode,
  nowMs: number,
): Promise<OrbitLookup> {
  const lookup = row?.lookup;
  const entry = readCache(meta);
  const publisherSays = publisherVerdict(meta, row, nowMs);
  // A set the publisher gave is no newer than what the publisher says now,
  // so it does not outlive a publisher that says the object is gone. A set
  // this browser asked CelesTrak for can be newer than a resting publisher.
  const gonePerPublisher = publisherSays.state === 'not_found' || publisherSays.state === 'reentered';
  const trusted = entry && (entry.asked === true || !gonePerPublisher);
  const cached: Candidate[] = trusted ? [entry.tle, ...(entry.also ?? [])].map((tle) => ({ tle })) : [];
  const lastGood = lookup ? liveObjects(lookup, cached, nowMs) : [];

  const verdict = publisherSays.state === 'failed' ? failed(publisherSays.cause, lookup, cached, nowMs) : publisherSays;
  if (!lookup) return verdict;
  if (mode === 'published') return lastGood.length > 0 ? drawn(lookup, lastGood, 'cache', true, nowMs) : verdict;

  const replies = await Promise.all(lookupQueries(lookup).map(ask));
  const matches: Candidate[] = replies.flatMap((reply) =>
    reply.kind === 'sets'
      ? reply.sets.filter((tle) => matchesLookup(lookup, tle)).map((tle) => ({ tle, feed: reply.feed }))
      : [],
  );
  const cause = worstCause(replies);
  // CelesTrak drops a decayed object. When every feed answered, an object
  // missing from the answers is gone and must not come back from the cache.
  const live = liveObjects(lookup, cause === null ? matches : [...matches, ...cached], nowMs);
  const first = live[0];
  if (first) {
    keepLive(meta, live, nowMs, true);
    return drawn(lookup, live, first.feed ?? 'cache', first.feed === undefined, nowMs);
  }
  if (cause === null) forget(meta);
  if (matches.length > 0) return gone(lookup, matches, nowMs);
  if (cause === null) return { state: 'not_found' };
  return publisherSays.state === 'failed' ? failed(cause, lookup, cached, nowMs) : publisherSays;
}

async function resolveDirect(meta: SatelliteMeta, param: string, value: string | number, nowMs: number): Promise<OrbitLookup> {
  const cached = readCache(meta);
  if (cached && nowMs - cached.fetchedAtMs < CACHE_TTL_MS) return fromCache(cached, false);
  const reply = await ask(query('gp', param, value));
  if (reply.kind === 'sets') {
    const tle = reply.sets[0]!;
    keep(meta, tle, reply.sets.length, nowMs);
    return { state: 'elements', tle, match_count: reply.sets.length, origin: 'gp', stale: false };
  }
  if (reply.kind === 'empty') {
    forget(meta);
    return { state: 'not_found' };
  }
  return cached ? fromCache(cached, true) : { state: 'failed', cause: reply.cause };
}

/** Find the orbit of one satellite. A row of `tracked.json` with elements
 *  wins while it is inside its grace and has not reentered, checked
 *  here as well as by the publisher, because the artifact can sit in an
 *  open map for hours. When the row's own object is no longer live, the
 *  first of its other live objects is drawn. A
 *  published object otherwise falls back to its last good element
 *  set while that is inside the grace, and in `ask` mode to the publisher's own
 *  CelesTrak queries. A catalog number or a name the publisher does not
 *  carry is asked of CelesTrak GP, with the 6 h cache in front. */
export async function resolveOrbit(
  meta: SatelliteMeta,
  published: readonly TrackedRecord[],
  mode: LookupMode,
  nowMs: number = Date.now(),
): Promise<OrbitLookup> {
  const row = publishedRow(meta, published);
  const live = row ? liveObjects(row.lookup, publishedSets(meta, row), nowMs) : [];
  const first = live[0];
  if (row && first) {
    keepLive(meta, live, nowMs, false);
    return drawn(row.lookup, live, 'published', first.stale, nowMs);
  }
  const resolution = meta.resolution;
  if (resolution.kind === 'published') return resolvePublished(meta, row, mode, nowMs);
  if (resolution.kind === 'catnr') {
    if (!Number.isInteger(resolution.catnr) || resolution.catnr <= 0) return { state: 'not_found' };
    return resolveDirect(meta, 'CATNR', resolution.catnr, nowMs);
  }
  if (resolution.query.trim() === '') return { state: 'not_found' };
  return resolveDirect(meta, 'NAME', resolution.query, nowMs);
}

const FAILURE_TEXT: Record<LookupFailure, string> = {
  timeout: 'CelesTrak did not answer within 15 s',
  network: 'CelesTrak could not be reached from this browser',
  http: 'CelesTrak answered with an error',
  unreadable: 'CelesTrak sent a reply that is not an element set',
  publisher: 'the publisher could not reach CelesTrak',
  artifact: 'this browser could not load the published orbit list',
};

/** One sentence for the picker. A failed lookup never reads as a miss,
 *  and a last good orbit never reads as a current one. */
export function lookupMessage(meta: SatelliteMeta, lookup: OrbitLookup): string {
  const resolution = meta.resolution;
  if (lookup.state === 'elements') {
    if (resolution.kind === 'published') {
      const also = alsoInOrbit(lookup);
      const set = [lookup.stale ? `drawing the last good orbit, ${lookup.tle.name}` : `drawing ${lookup.tle.name}`, staleOrbit(lookup)];
      const drawing = `${meta.name}: ${set.filter(Boolean).join(', ')}`;
      return also ? `${drawing}. ${also}` : drawing;
    }
    return 'Tracking added';
  }
  if (lookup.state === 'failed') {
    const drawing = lookup.last_good_hours === undefined
      ? 'No orbit is drawn.'
      : `The last good orbit, epoch ${lookup.last_good_hours} h old, is too old to draw.`;
    return `${meta.name}: orbit lookup failed, ${FAILURE_TEXT[lookup.cause]}. ${drawing}`;
  }
  if (lookup.state === 'expired') return `${meta.name}: the last public orbit is too old to draw.`;
  if (lookup.state === 'reentered') return `${meta.name}: the last public orbit has reentered. No orbit is drawn.`;
  if (resolution.kind === 'published') {
    return `${meta.name}: no public orbit yet. CelesTrak GP and Supplemental GP list no element set for it.`;
  }
  if (resolution.kind === 'name') return `No satellite found for "${resolution.query}"`;
  return `NORAD ${resolution.catnr} is not in CelesTrak GP.`;
}

/** Test-only helper — clear all cached TLEs from localStorage. */
export function _clearTLECacheForTests(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('opd-tle-')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* noop */
  }
}
