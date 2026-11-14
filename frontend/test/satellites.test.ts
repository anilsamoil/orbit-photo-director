import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURATED_SATELLITES,
  _clearTLECacheForTests,
  canonicalIntldes,
  lookupMessage,
  metaKey,
  parseCelestrakTLE,
  parseElementSets,
  resolveOrbit,
  type OrbitLookup,
  type SatelliteMeta,
} from '../src/satellites';
import { UNPUBLISHED_TRACKED, UNREAD_TRACKED, type TrackedElements, type TrackedObject, type TrackedRecord, type TrackedUnavailable } from '../src/tracked';

const SAMPLE_ISS_3LE = `ISS (ZARYA)
1 25544U 98067A   24291.00000000  .00018000  00000-0  32500-3 0  9999
2 25544  51.6400  60.0000 0006000  90.0000 270.0000 15.50000000400000`;

const SAMPLE_MULTI_3LE = `STARSHIP FLIGHT 12
1 99001U 26100A   26141.50000000  .00000000  00000-0  00000-0 0  9999
2 99001  26.5000 270.0000 0003000  90.0000 270.0000 16.00000000 00010
STARSHIP IFT-11 DEBRIS
1 99002U 26100B   26141.50000000  .00000000  00000-0  00000-0 0  9990
2 99002  26.5000 270.0000 0003000  90.0000 270.0000 16.00000000 00020
STARSHIP IFT-11 STAGE 2
1 99003U 26100C   26141.50000000  .00000000  00000-0  00000-0 0  9991
2 99003  26.5000 270.0000 0003000  90.0000 270.0000 16.00000000 00030`;

beforeEach(() => {
  _clearTLECacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('parseCelestrakTLE (A3 — 3-line + multi-result handling)', () => {
  it('parses a single 3-line TLE block', () => {
    const result = parseCelestrakTLE(SAMPLE_ISS_3LE);
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('ISS (ZARYA)');
    expect(result!.tle.line1.startsWith('1 25544')).toBe(true);
    expect(result!.tle.line2.startsWith('2 25544')).toBe(true);
    expect(result!.match_count).toBe(1);
  });

  it('returns first match + count when multiple satellites in response (A4)', () => {
    const result = parseCelestrakTLE(SAMPLE_MULTI_3LE);
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('STARSHIP FLIGHT 12');
    expect(result!.match_count).toBe(3);
  });

  it('returns null for empty input', () => {
    expect(parseCelestrakTLE('')).toBeNull();
  });

  it('returns null for non-TLE garbage', () => {
    expect(parseCelestrakTLE('No satellites match the given criteria.')).toBeNull();
  });

  it('returns null when missing the line 2 partner', () => {
    expect(parseCelestrakTLE('ORPHAN\n1 12345U 98067A   24291.00000000  .00018000  00000-0  32500-3 0  9999')).toBeNull();
  });

  it('parses a 2-line response (no name header) with name=UNKNOWN', () => {
    const lines = SAMPLE_ISS_3LE.split('\n').slice(1).join('\n');
    const result = parseCelestrakTLE(lines);
    expect(result).not.toBeNull();
    expect(result!.tle.name).toBe('UNKNOWN');
  });
});

describe('metaKey', () => {
  it('returns the CATNR for catnr-resolved satellites', () => {
    expect(metaKey(CURATED_SATELLITES[0]!)).toBe('25544'); // ISS
    expect(metaKey(CURATED_SATELLITES[1]!)).toBe('48274'); // Tiangong
  });

  it('returns "name:<query>" for name-resolved satellites', () => {
    const x37b = CURATED_SATELLITES.find((s) => s.name === 'X-37B')!;
    expect(metaKey(x37b)).toBe('name:USA');
  });
});

describe('CURATED_SATELLITES', () => {
  it('contains the 5 expected satellites in order', () => {
    expect(CURATED_SATELLITES.map((s) => s.name)).toEqual([
      'ISS (Zarya)',
      'Tiangong (CSS)',
      'Hubble (HST)',
      'X-37B',
      'Starship',
    ]);
  });

  it('ISS resolves by CATNR 25544', () => {
    expect(CURATED_SATELLITES[0]!.resolution).toEqual({ kind: 'catnr', catnr: 25544 });
  });

  it('Starship is the published vehicle, keyed apart from a name search', () => {
    expect(STARSHIP.resolution).toEqual({ kind: 'published', id: 'starship' });
    expect(metaKey(STARSHIP)).toBe('tracked:starship');
  });
});

const NOW = Date.parse('2026-11-13T18:00:00Z');
const GP = 'https://celestrak.org/NORAD/elements/gp.php';
const SUPGP = 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php';
const STARSHIP = CURATED_SATELLITES.find((s) => s.name === 'Starship')!;
const TIANGONG = CURATED_SATELLITES[1]!;

/** Epoch day 317.5 of 2026 is 2026-11-13T12:00Z, six hours before NOW. */
function lines(norad: string, intldes: string, epoch = '26317.50000000'): [string, string] {
  return [
    `1 ${norad}U ${intldes.padEnd(8)} ${epoch}  .00000000  00000-0  00000-0 0  9990`,
    `2 ${norad}  26.5000 270.0000 0003000  90.0000 270.0000 16.00000000    10`,
  ];
}

function body(name: string, norad = '67001', intldes = '26210A', epoch?: string): string {
  const [line1, line2] = lines(norad, intldes, epoch);
  return `${name}\n${line1}\n${line2}\n`;
}

const FAILED_ROW = UNPUBLISHED_TRACKED[0] as TrackedUnavailable;
const NO_ORBIT_ROW: TrackedUnavailable = { ...FAILED_ROW, reason: 'no_public_orbit' };
const AGED_ROW: TrackedUnavailable = { ...FAILED_ROW, reason: 'aged_out' };
const [PUB1, PUB2] = lines('67001', '26210A');
const ELEMENTS_ROW: TrackedElements = {
  state: 'elements',
  id: 'starship',
  label: 'Starship',
  color: '#ff5c5c',
  lookup: FAILED_ROW.lookup,
  source: 'supgp',
  name: 'STARSHIP S39',
  norad: 67001,
  intldes: '26210A',
  line1: PUB1,
  line2: PUB2,
  epoch: '2026-11-13T12:00:00Z',
  age_hours: 6,
};

type Answer = string | number | 'throw' | 'hang';

/** Answers by URL substring. A string is a 200 body, a number a status,
 *  `throw` a network error, `hang` never answers until aborted. */
function celestrak(answers: Record<string, Answer>, fallback: Answer = 404) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const hit = Object.keys(answers).find((part) => url.includes(part));
    const answer = hit === undefined ? fallback : answers[hit]!;
    if (answer === 'throw') throw new TypeError('Failed to fetch');
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    if (typeof answer === 'number') return new Response('', { status: answer });
    return new Response(answer, { status: 200 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function asked(mock: ReturnType<typeof celestrak>): string[] {
  return mock.mock.calls.map(([url]) => String(url));
}

async function ask(meta: SatelliteMeta, published: readonly TrackedRecord[] = [FAILED_ROW]): Promise<OrbitLookup> {
  return resolveOrbit(meta, published, 'ask', NOW);
}

describe('parseElementSets', () => {
  it('keeps every set in a body with its name', () => {
    expect(parseElementSets(SAMPLE_MULTI_3LE).map((tle) => tle.name)).toEqual([
      'STARSHIP FLIGHT 12',
      'STARSHIP IFT-11 DEBRIS',
      'STARSHIP IFT-11 STAGE 2',
    ]);
  });

  it('reads the COSPAR and the TLE form of a designator as one', () => {
    expect(canonicalIntldes('2026-210A')).toBe('26210A');
    expect(canonicalIntldes('26210A  ')).toBe('26210A');
    expect(canonicalIntldes('1998-67A')).toBe('98067A');
  });
});

describe('a published vehicle', () => {
  it('draws the publisher element set without asking CelesTrak', async () => {
    const fetchMock = celestrak({});

    const lookup = await ask(STARSHIP, [ELEMENTS_ROW]);

    expect(lookup).toEqual({
      state: 'elements',
      tle: { line1: PUB1, line2: PUB2, name: 'STARSHIP S39' },
      match_count: 1,
      origin: 'published',
      stale: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks a publisher last-good element set as stale', async () => {
    celestrak({});
    expect(await ask(STARSHIP, [{ ...ELEMENTS_ROW, from_cache: true }])).toMatchObject({ origin: 'published', stale: true });
  });

  it('does not draw a publisher element set that has passed its 12 h limit since it was published', async () => {
    const fetchMock = celestrak({}, 'No GP data found');
    const later = NOW + 7 * 3_600_000;

    expect(await resolveOrbit(STARSHIP, [ELEMENTS_ROW], 'published', later - 3_600_000)).toMatchObject({ state: 'elements' });
    expect(await resolveOrbit(STARSHIP, [ELEMENTS_ROW], 'published', later)).toEqual({ state: 'expired' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await resolveOrbit(STARSHIP, [ELEMENTS_ROW], 'ask', later)).toEqual({ state: 'not_found' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('blames this browser, not the publisher, when the artifact could not be loaded', async () => {
    celestrak({}, 'throw');

    expect(await resolveOrbit(STARSHIP, UNREAD_TRACKED, 'published', NOW)).toEqual({ state: 'failed', cause: 'artifact' });
    expect(await resolveOrbit(STARSHIP, [], 'published', NOW)).toEqual({ state: 'failed', cause: 'artifact' });
    expect(await resolveOrbit(STARSHIP, UNREAD_TRACKED, 'ask', NOW)).toEqual({ state: 'failed', cause: 'network' });
  });

  it('in published mode reports the publisher verdict and never asks CelesTrak', async () => {
    const fetchMock = celestrak({ NAME: body('STARSHIP S39') });

    expect(await resolveOrbit(STARSHIP, [FAILED_ROW], 'published', NOW)).toEqual({ state: 'failed', cause: 'publisher' });
    expect(await resolveOrbit(STARSHIP, [NO_ORBIT_ROW], 'published', NOW)).toEqual({ state: 'not_found' });
    expect(await resolveOrbit(STARSHIP, [AGED_ROW], 'published', NOW)).toEqual({ state: 'expired' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asked, sends the publisher queries: Supplemental GP and GP, for STARSHIP and for SHIP', async () => {
    const fetchMock = celestrak({});

    await ask(STARSHIP);

    expect(asked(fetchMock)).toEqual([
      `${SUPGP}?NAME=STARSHIP&FORMAT=TLE`,
      `${GP}?NAME=STARSHIP&FORMAT=TLE`,
      `${SUPGP}?NAME=SHIP&FORMAT=TLE`,
      `${GP}?NAME=SHIP&FORMAT=TLE`,
    ]);
  });

  it('finds a ship catalogued as SHIP 39 in Supplemental GP when GP has nothing', async () => {
    celestrak({ 'sup-gp.php?NAME=SHIP&': body('SPACESHIP TWO', '50001', '21001A') + body('SHIP 39') }, 'No GP data found');

    expect(await ask(STARSHIP)).toEqual({
      state: 'elements',
      tle: { line1: PUB1, line2: PUB2, name: 'SHIP 39' },
      match_count: 1,
      origin: 'supgp',
      stale: false,
    });
  });

  it('does not take Starlink or another ship for Starship', async () => {
    celestrak({ NAME: body('STARLINK-1234') + body('SHIPPING CONTAINER') + body('STARSHIPS') });

    expect(await ask(STARSHIP)).toEqual({ state: 'not_found' });
  });

  it('takes the newest element set, and Supplemental GP on a tie', async () => {
    celestrak({
      'elements/gp.php?NAME=STARSHIP': body('STARSHIP GP NEWER', '67001', '26210A', '26317.60000000'),
      'sup-gp.php?NAME=STARSHIP': body('STARSHIP SUP'),
      'elements/gp.php?NAME=SHIP&': body('SHIP 39'),
    });
    expect(await ask(STARSHIP)).toMatchObject({ tle: { name: 'STARSHIP GP NEWER' }, origin: 'gp', match_count: 1 });

    _clearTLECacheForTests();
    celestrak({ 'elements/gp.php?NAME=STARSHIP': body('STARSHIP GP'), 'sup-gp.php?NAME=STARSHIP': body('STARSHIP SUP') });
    expect(await ask(STARSHIP)).toMatchObject({ tle: { name: 'STARSHIP SUP' }, origin: 'supgp' });
  });

  it('says not found only when every feed answered and none listed it', async () => {
    celestrak({}, 'No GP data found');
    expect(await ask(STARSHIP)).toEqual({ state: 'not_found' });

    celestrak({}, 404);
    expect(await ask(STARSHIP)).toEqual({ state: 'not_found' });
  });

  it.each([
    ['throw', 'network'],
    [503, 'http'],
    ['<html>Service Unavailable</html>', 'unreadable'],
  ] as const)('a feed answering %s is a failed lookup with cause %s, not a miss', async (answer, cause) => {
    celestrak({}, answer);

    expect(await ask(STARSHIP)).toEqual({ state: 'failed', cause });
  });

  it('a feed that never answers is a timeout after 15 s', async () => {
    vi.useFakeTimers();
    celestrak({}, 'hang');

    const pending = ask(STARSHIP);
    await vi.advanceTimersByTimeAsync(14_999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ state: 'failed', cause: 'timeout' });
  });

  it('one failed feed among empty ones is still a failed lookup', async () => {
    celestrak({ 'sup-gp.php?NAME=SHIP&': 'throw' }, 'No GP data found');

    expect(await ask(STARSHIP)).toEqual({ state: 'failed', cause: 'network' });
  });

  it('keeps the publisher answer when the publisher answered and this browser could not ask', async () => {
    celestrak({}, 'throw');

    expect(await ask(STARSHIP, [NO_ORBIT_ROW])).toEqual({ state: 'not_found' });
    expect(await ask(STARSHIP, [AGED_ROW])).toEqual({ state: 'expired' });
  });

  it('an element set older than the publisher limit of 12 h is expired, not drawn', async () => {
    celestrak({ NAME: body('STARSHIP S39', '67001', '26210A', '26316.90000000') });

    expect(await ask(STARSHIP)).toEqual({ state: 'expired' });
  });

  it('an element set just inside 12 h is drawn', async () => {
    celestrak({ NAME: body('STARSHIP S39', '67001', '26210A', '26317.25100000') });

    expect(await ask(STARSHIP)).toMatchObject({ state: 'elements' });
  });

  it('keeps the last good element set through a failed lookup until it is 12 h old', async () => {
    celestrak({ NAME: body('STARSHIP S39') });
    await ask(STARSHIP);
    const fetchMock = celestrak({}, 'throw');

    expect(await resolveOrbit(STARSHIP, [FAILED_ROW], 'published', NOW + 3_600_000)).toEqual({
      state: 'elements',
      tle: { line1: PUB1, line2: PUB2, name: 'STARSHIP S39' },
      match_count: 1,
      origin: 'cache',
      stale: true,
    });
    expect(await resolveOrbit(STARSHIP, [FAILED_ROW], 'ask', NOW + 3_600_000)).toMatchObject({ origin: 'cache', stale: true });
    expect(await resolveOrbit(STARSHIP, [FAILED_ROW], 'published', NOW + 7 * 3_600_000)).toEqual({ state: 'failed', cause: 'publisher' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('remembers the publisher element set as the last good one', async () => {
    celestrak({});
    await ask(STARSHIP, [ELEMENTS_ROW]);

    expect(await resolveOrbit(STARSHIP, [FAILED_ROW], 'published', NOW)).toMatchObject({
      tle: { name: 'STARSHIP S39' },
      origin: 'cache',
    });
  });

  it('an object added by catalog number and designator is asked for by both, and matched without a name', async () => {
    const meta: SatelliteMeta = { ...STARSHIP, name: 'Ship 40', resolution: { kind: 'published', id: 'ship-40' } };
    const row: TrackedUnavailable = {
      ...FAILED_ROW,
      id: 'ship-40',
      label: 'Ship 40',
      lookup: { names: [], patterns: [], max_age_hours: 48, catnr: 67002, intldes: '2026-211A' },
    };
    const fetchMock = celestrak({ 'INTDES=2026-211A': body('OBJECT A', '67002', '26211A') });

    expect(await ask(meta, [row])).toMatchObject({ state: 'elements', tle: { name: 'OBJECT A' } });
    expect(asked(fetchMock)).toEqual([
      `${SUPGP}?CATNR=67002&FORMAT=TLE`,
      `${GP}?CATNR=67002&FORMAT=TLE`,
      `${SUPGP}?INTDES=2026-211A&FORMAT=TLE`,
      `${GP}?INTDES=2026-211A&FORMAT=TLE`,
    ]);
  });
});

/** Fictional objects, every epoch 2026-11-16T12:00Z. */
const CATALOGUE = readFileSync('test/fixtures/celestrak-starship-fictional.txt', 'utf8');
const FLIGHT_DAY = Date.parse('2026-11-16T12:00:00Z');

/** One object of the catalogue, its epoch `hours` before FLIGHT_DAY. */
function aged(name: string, hours: number): string {
  const rows = CATALOGUE.split('\n');
  const at = rows.indexOf(name);
  const line1 = rows[at + 1]!;
  return `${name}\n${line1.slice(0, 18)}26${(320.5 - hours / 24).toFixed(8)}${line1.slice(32)}\n${rows[at + 2]}\n`;
}

function publishedObject(name: string, hours: number): TrackedObject {
  const [, line1, line2] = aged(name, hours).split('\n') as [string, string, string];
  return { source: 'supgp', name, norad: Number(line1.slice(2, 7)), intldes: line1.slice(9, 17).trim(), line1, line2, epoch: '', age_hours: hours };
}

function row(primary: TrackedObject, ...also: TrackedObject[]): TrackedElements {
  return { ...ELEMENTS_ROW, ...primary, ...(also.length > 0 ? { also } : {}) };
}

function drawnNames(lookup: OrbitLookup): string[] {
  if (lookup.state !== 'elements') throw new Error(`nothing drawn: ${lookup.state}`);
  return [lookup.tle.name, ...(lookup.also ?? []).map((tle) => tle.name)];
}

function tap(at = FLIGHT_DAY, published: readonly TrackedRecord[] = [FAILED_ROW]): Promise<OrbitLookup> {
  return resolveOrbit(STARSHIP, published, 'ask', at);
}

describe('several Starship objects in the feeds', () => {
  it('draws the next flight and does not list the aged-out one', async () => {
    celestrak({ NAME: aged('SHIP 90', 30) + aged('SHIP 91', 1) });

    expect(await tap()).toMatchObject({ tle: { name: 'SHIP 91' }, match_count: 1 });
    expect(drawnNames(await tap())).toEqual(['SHIP 91']);
  });

  it.each([[1, 5], [5, 1]])('draws the newer launch when the older flight is %i h old and the newer %i h', async (older, newer) => {
    celestrak({ NAME: aged('SHIP 90', older) + aged('SHIP 91', newer) });

    expect(drawnNames(await tap())).toEqual(['SHIP 91', 'SHIP 90']);
  });

  it('draws a ship before its rocket body, even when the rocket body has the newer set', async () => {
    celestrak({ NAME: aged('SHIP 91 R/B', 1) + aged('SHIP 91', 5) });

    expect(await tap()).toMatchObject({ tle: { name: 'SHIP 91' }, also: [{ name: 'SHIP 91 R/B' }], match_count: 2 });
  });

  it('reads the whole catalogue as the newest live ship, then the older ship, then the rocket body', async () => {
    celestrak({ NAME: CATALOGUE });

    expect(drawnNames(await tap(FLIGHT_DAY + 3 * 3_600_000))).toEqual(['SHIP 91', 'SHIP 90', 'SHIP 91 R/B']);
  });

  it('does not take Starlink, Starshield, debris or another ship for Starship', async () => {
    const others = ['STARLINK-90011', 'STARSHIELD 12', 'STARSHIP DEB', 'SHIP 91 DEB', 'SPACESHIP NINE', 'FRIENDSHIP 7'];
    celestrak({ NAME: others.map((name) => aged(name, 1)).join('') });

    expect(await tap()).toEqual({ state: 'not_found' });
  });

  it('hides a set with a perigee under 80 km once it is a revolution old, and says it reentered', async () => {
    celestrak({ NAME: aged('SHIP 92', 3) });
    expect(await tap()).toEqual({ state: 'reentered' });

    celestrak({ NAME: aged('SHIP 92', 0.5) });
    expect(drawnNames(await tap())).toEqual(['SHIP 92']);
  });

  it('stops keeping a low-perigee set as the last good one once it has reentered', async () => {
    celestrak({ NAME: aged('SHIP 92', 0.5) });
    await tap();

    expect(await resolveOrbit(STARSHIP, [FAILED_ROW], 'published', FLIGHT_DAY)).toMatchObject({ tle: { name: 'SHIP 92' }, origin: 'cache' });
    expect(await resolveOrbit(STARSHIP, [FAILED_ROW], 'published', FLIGHT_DAY + 2 * 3_600_000)).toEqual({ state: 'failed', cause: 'publisher' });
  });

  it('forgets a ship that every feed answers without, and a later failed lookup does not bring it back', async () => {
    celestrak({ NAME: aged('SHIP 91', 1) });
    expect(drawnNames(await tap())).toEqual(['SHIP 91']);

    celestrak({}, 'No GP data found');
    expect(await tap()).toEqual({ state: 'not_found' });
    expect(localStorage.getItem('opd-tle-tracked:starship')).toBeNull();

    celestrak({}, 'throw');
    expect(await tap()).toEqual({ state: 'failed', cause: 'network' });
  });

  it('drops a cached older flight when the feeds answer with only the next one', async () => {
    celestrak({ NAME: aged('SHIP 90', 2) });
    expect(drawnNames(await tap())).toEqual(['SHIP 90']);

    celestrak({ NAME: aged('SHIP 91', 1) });
    expect(drawnNames(await tap())).toEqual(['SHIP 91']);
    expect(drawnNames(await resolveOrbit(STARSHIP, [FAILED_ROW], 'published', FLIGHT_DAY))).toEqual(['SHIP 91']);
  });

  it('serves every cached object, marked last good, while the feeds cannot be reached', async () => {
    celestrak({ NAME: aged('SHIP 90', 2) + aged('SHIP 91', 1) });
    await tap();

    celestrak({}, 'throw');
    const lookup = await tap();
    expect(drawnNames(lookup)).toEqual(['SHIP 91', 'SHIP 90']);
    expect(lookup).toMatchObject({ origin: 'cache', stale: true, match_count: 2 });
  });
});

describe('a published row with several objects', () => {
  const published = (records: TrackedRecord[], at = FLIGHT_DAY): Promise<OrbitLookup> => resolveOrbit(STARSHIP, records, 'published', at);

  it('draws the row and lists its other live objects', async () => {
    const lookup = await published([row(publishedObject('SHIP 91', 1), publishedObject('SHIP 90', 2), publishedObject('SHIP 91 R/B', 1))]);

    expect(drawnNames(lookup)).toEqual(['SHIP 91', 'SHIP 90', 'SHIP 91 R/B']);
    expect(lookup).toMatchObject({ origin: 'published', stale: false, match_count: 3 });
  });

  it('draws another live object once the row\'s own has aged out in an open map', async () => {
    const records = [row(publishedObject('SHIP 91', 10), publishedObject('SHIP 90', 2))];

    expect(drawnNames(await published(records))).toEqual(['SHIP 91', 'SHIP 90']);
    expect(drawnNames(await published(records, FLIGHT_DAY + 3 * 3_600_000))).toEqual(['SHIP 90']);
  });

  it('draws another live object once the row\'s own has reentered in an open map', async () => {
    const records = [row(publishedObject('SHIP 92', 0.5), { ...publishedObject('SHIP 91', 1), from_cache: true })];

    expect(drawnNames(await published(records))).toEqual(['SHIP 92', 'SHIP 91']);
    expect(await published(records, FLIGHT_DAY + 2 * 3_600_000)).toMatchObject({ tle: { name: 'SHIP 91' }, match_count: 1, stale: true });
  });

  it('says reentered for a row inside its age limit that has reentered, and for a reentered status row', async () => {
    expect(await published([row(publishedObject('SHIP 92', 3))])).toEqual({ state: 'reentered' });
    expect(await published([{ ...FAILED_ROW, reason: 'reentered' }])).toEqual({ state: 'reentered' });
    expect(await published([row(publishedObject('SHIP 92', 13))])).toEqual({ state: 'expired' });
  });

  it('stops drawing a ship the publisher gave once the publisher says CelesTrak lists none', async () => {
    const none: TrackedRecord = { ...FAILED_ROW, reason: 'no_public_orbit' };
    expect(drawnNames(await published([row(publishedObject('SHIP 91', 1))]))).toEqual(['SHIP 91']);

    expect(await published([FAILED_ROW])).toMatchObject({ tle: { name: 'SHIP 91' }, origin: 'cache' });
    expect(await published([none])).toEqual({ state: 'not_found' });
    expect(await published([{ ...FAILED_ROW, reason: 'reentered' }])).toEqual({ state: 'reentered' });
  });

  it('keeps a ship this browser asked CelesTrak for while the publisher still lists none', async () => {
    celestrak({ NAME: aged('SHIP 91', 1) });
    await tap();

    expect(drawnNames(await published([{ ...FAILED_ROW, reason: 'no_public_orbit' }]))).toEqual(['SHIP 91']);
  });

  it('a catalog number never takes another object of the row in its place', async () => {
    celestrak({}, 'No GP data found');
    const meta: SatelliteMeta = { ...TIANGONG, resolution: { kind: 'catnr', catnr: 90003 } };
    const records = [row(publishedObject('SHIP 91', 13), publishedObject('SHIP 90', 2))];

    expect(await resolveOrbit(meta, records, 'ask', FLIGHT_DAY)).toEqual({ state: 'not_found' });
  });
});

describe('a satellite by catalog number or name', () => {
  it('uses the cached TLE within 6 h without asking', async () => {
    localStorage.setItem('opd-tle-48274', JSON.stringify({
      tle: { line1: 'cached1', line2: 'cached2', name: 'CACHED' },
      fetchedAtMs: NOW - 60_000,
    }));
    const fetchMock = celestrak({});

    expect(await ask(TIANGONG)).toMatchObject({ tle: { name: 'CACHED' }, origin: 'cache', stale: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks CelesTrak GP once and caches the reply', async () => {
    const fetchMock = celestrak({ 'CATNR=25544': SAMPLE_ISS_3LE });

    expect(await ask(CURATED_SATELLITES[0]!)).toMatchObject({ tle: { name: 'ISS (ZARYA)' }, origin: 'gp', stale: false });
    expect(asked(fetchMock)).toEqual([`${GP}?CATNR=25544&FORMAT=TLE`]);
    expect(JSON.parse(localStorage.getItem('opd-tle-25544')!).tle.name).toBe('ISS (ZARYA)');
  });

  it('draws a publisher row with the same catalog number without asking', async () => {
    const fetchMock = celestrak({});
    const row: TrackedElements = { ...ELEMENTS_ROW, id: 'tiangong', label: 'Tiangong', name: 'CSS (TIANHE)', norad: 48274 };

    expect(await ask(TIANGONG, [row])).toMatchObject({ tle: { name: 'CSS (TIANHE)' }, origin: 'published' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a stale cached TLE when CelesTrak cannot be reached', async () => {
    localStorage.setItem('opd-tle-48274', JSON.stringify({
      tle: { line1: 'old1', line2: 'old2', name: 'STALE CSS' },
      fetchedAtMs: NOW - 7 * 3_600_000,
    }));
    celestrak({}, 'throw');

    expect(await ask(TIANGONG)).toMatchObject({ tle: { name: 'STALE CSS' }, origin: 'cache', stale: true });
  });

  it('stops drawing a cached TLE once CelesTrak answers that the object is gone', async () => {
    localStorage.setItem('opd-tle-48274', JSON.stringify({
      tle: { line1: 'old1', line2: 'old2', name: 'DECAYED' },
      fetchedAtMs: NOW - 7 * 3_600_000,
    }));
    celestrak({}, 'No GP data found');

    expect(await ask(TIANGONG)).toEqual({ state: 'not_found' });
    expect(localStorage.getItem('opd-tle-48274')).toBeNull();
  });

  it.each([
    ['throw', { state: 'failed', cause: 'network' }],
    [503, { state: 'failed', cause: 'http' }],
    ['garbage that is not a TLE', { state: 'failed', cause: 'unreadable' }],
    [404, { state: 'not_found' }],
    ['No GP data found', { state: 'not_found' }],
    ['', { state: 'not_found' }],
  ] as const)('with no cache, an answer of %s is %o', async (answer, want) => {
    celestrak({}, answer);

    expect(await ask(TIANGONG)).toEqual(want);
  });

  it('a name search takes the first match and counts the rest', async () => {
    const fetchMock = celestrak({ 'NAME=USA': SAMPLE_MULTI_3LE });
    const meta: SatelliteMeta = { ...TIANGONG, resolution: { kind: 'name', query: 'USA' } };

    expect(await ask(meta)).toMatchObject({ tle: { name: 'STARSHIP FLIGHT 12' }, match_count: 3 });
    expect(asked(fetchMock)).toEqual([`${GP}?NAME=USA&FORMAT=TLE`]);
  });

  it('rejects a catalog number that is not a positive integer, and an empty name, without asking', async () => {
    const fetchMock = celestrak({});
    const catnr = (n: number): SatelliteMeta => ({ ...TIANGONG, resolution: { kind: 'catnr', catnr: n } });

    expect(await ask(catnr(-1))).toEqual({ state: 'not_found' });
    expect(await ask(catnr(Number.NaN))).toEqual({ state: 'not_found' });
    expect(await ask({ ...TIANGONG, resolution: { kind: 'name', query: '  ' } })).toEqual({ state: 'not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('lookupMessage', () => {
  const typed: SatelliteMeta = { ...TIANGONG, name: 'NOSUCH', resolution: { kind: 'name', query: 'NOSUCH' } };
  const norad: SatelliteMeta = { ...TIANGONG, name: 'NORAD 99999', resolution: { kind: 'catnr', catnr: 99999 } };

  it('a failed lookup names its cause and never reads as a miss', () => {
    expect(lookupMessage(STARSHIP, { state: 'failed', cause: 'timeout' }))
      .toBe('Starship: orbit lookup failed, CelesTrak did not answer within 15 s. No orbit is drawn.');
    expect(lookupMessage(STARSHIP, { state: 'failed', cause: 'network' }))
      .toBe('Starship: orbit lookup failed, CelesTrak could not be reached from this browser. No orbit is drawn.');
    expect(lookupMessage(STARSHIP, { state: 'failed', cause: 'http' }))
      .toBe('Starship: orbit lookup failed, CelesTrak answered with an error. No orbit is drawn.');
    expect(lookupMessage(STARSHIP, { state: 'failed', cause: 'unreadable' }))
      .toBe('Starship: orbit lookup failed, CelesTrak sent a reply that is not an element set. No orbit is drawn.');
    expect(lookupMessage(STARSHIP, { state: 'failed', cause: 'publisher' }))
      .toBe('Starship: orbit lookup failed, the publisher could not reach CelesTrak. No orbit is drawn.');
    expect(lookupMessage(STARSHIP, { state: 'failed', cause: 'artifact' }))
      .toBe('Starship: orbit lookup failed, this browser could not load the published orbit list. No orbit is drawn.');
    expect(lookupMessage(typed, { state: 'failed', cause: 'network' }))
      .toBe('NOSUCH: orbit lookup failed, CelesTrak could not be reached from this browser. No orbit is drawn.');
  });

  it('a miss says which feeds answered', () => {
    expect(lookupMessage(STARSHIP, { state: 'not_found' }))
      .toBe('Starship: no public orbit yet. CelesTrak GP and Supplemental GP list no element set for it.');
    expect(lookupMessage(typed, { state: 'not_found' })).toBe('No satellite found for "NOSUCH"');
    expect(lookupMessage(norad, { state: 'not_found' })).toBe('NORAD 99999 is not in CelesTrak GP.');
    expect(lookupMessage(STARSHIP, { state: 'expired' })).toBe('Starship: the last public orbit is too old to draw.');
    expect(lookupMessage(STARSHIP, { state: 'reentered' }))
      .toBe('Starship: the last public orbit has reentered. No orbit is drawn.');
  });

  it('a drawn orbit names its element set', () => {
    const tle = { line1: PUB1, line2: PUB2, name: 'STARSHIP S39' };
    expect(lookupMessage(STARSHIP, { state: 'elements', tle, match_count: 1, origin: 'published', stale: false }))
      .toBe('Starship: drawing STARSHIP S39');
    expect(lookupMessage(STARSHIP, { state: 'elements', tle, match_count: 1, origin: 'cache', stale: true }))
      .toBe('Starship: drawing the last good orbit, STARSHIP S39');
    expect(lookupMessage(STARSHIP, { state: 'elements', tle, match_count: 1, origin: 'published', stale: true }))
      .toBe('Starship: drawing the last good orbit, STARSHIP S39');
    expect(lookupMessage(norad, { state: 'elements', tle, match_count: 1, origin: 'gp', stale: false })).toBe('Tracking added');
  });

  it('a drawn published orbit names the other objects in orbit', () => {
    const tle = { line1: PUB1, line2: PUB2, name: 'SHIP 91' };
    const [body1, body2] = lines('90004', '26310B');
    const also = [{ line1: body1, line2: body2, name: 'SHIP 91 R/B' }, { line1: PUB1, line2: PUB2, name: 'SHIP 90' }];

    expect(lookupMessage(STARSHIP, { state: 'elements', tle, also, match_count: 3, origin: 'published', stale: false }))
      .toBe('Starship: drawing SHIP 91. Also in orbit: SHIP 91 R/B (NORAD 90004), SHIP 90 (NORAD 67001)');
    expect(lookupMessage(STARSHIP, { state: 'elements', tle, also: [], match_count: 1, origin: 'published', stale: false }))
      .toBe('Starship: drawing SHIP 91');
  });
});
