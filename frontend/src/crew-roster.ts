import rosterJson from '../../data/crew-roster/roster.json?raw';
import { parseTargetCsv } from './csv-parse';
import { isValidProfileName, type PersonalTarget } from './profile';

const siteCsvByPath = import.meta.glob<string>('../../data/crew-roster/*.csv', { query: '?raw', import: 'default', eager: true });

const ROSTER_CREATED_AT = '2026-10-05T00:00:00.000Z';

export type RosterName = string & { readonly __brand: 'RosterName' };

export interface RosterProfile {
  readonly name: RosterName;
  readonly displayName: string;
}

interface RosterEntry {
  readonly displayName: string;
  readonly sites: readonly PersonalTarget[];
}

let registry: ReadonlyMap<string, RosterEntry> | undefined;

export function rosterProfiles(): readonly RosterProfile[] {
  return [...readRegistry()].flatMap(([name, entry]) => (isRosterProfile(name) ? [{ name, displayName: entry.displayName }] : []));
}

export function isRosterProfile(name: string): name is RosterName {
  return readRegistry().has(name);
}

export function rosterSites(name: RosterName): readonly PersonalTarget[] {
  return readRegistry().get(name)?.sites ?? [];
}

function readRegistry(): ReadonlyMap<string, RosterEntry> {
  registry ??= buildRegistry();
  return registry;
}

function buildRegistry(): Map<string, RosterEntry> {
  const csvByName = new Map(Object.entries(siteCsvByPath).map(([path, csv]) => [path.slice(path.lastIndexOf('/') + 1, -'.csv'.length), csv]));
  const entries = new Map<string, RosterEntry>();
  for (const { name, displayName } of parseRosterJson(rosterJson)) {
    const csv = csvByName.get(name);
    if (csv === undefined) throw new Error(`crew roster: ${name} has no ${name}.csv`);
    if (entries.has(name)) throw new Error(`crew roster: ${name} is listed twice in roster.json`);
    entries.set(name, { displayName, sites: parseSites(name, csv) });
  }
  const orphan = [...csvByName.keys()].find((name) => !entries.has(name));
  if (orphan !== undefined) throw new Error(`crew roster: ${orphan}.csv has no roster.json entry`);
  return entries;
}

function parseRosterJson(text: string): { name: string; displayName: string }[] {
  const entries: unknown = JSON.parse(text);
  if (!Array.isArray(entries)) throw new Error('crew roster: roster.json is not an array');
  return entries.map((entry: unknown) => {
    const { name, displayName } = (entry ?? {}) as { name?: unknown; displayName?: unknown };
    if (typeof name !== 'string' || !isValidProfileName(name)) throw new Error(`crew roster: invalid profile name ${JSON.stringify(name)}`);
    if (typeof displayName !== 'string' || displayName.trim() === '') throw new Error(`crew roster: ${name} has no displayName`);
    return { name, displayName };
  });
}

function parseSites(profileName: string, csv: string): PersonalTarget[] {
  const parsed = parseTargetCsv(csv);
  if (parsed.topLevelError) throw new Error(`crew roster: ${profileName}.csv has ${parsed.topLevelError.code}`);
  const [rejected] = parsed.errors;
  if (rejected) throw new Error(`crew roster: ${profileName}.csv line ${rejected.line} is ${rejected.code}`);
  const tokens = new Set<string>();
  return parsed.valid.map((row) => {
    const token = siteToken(row.name);
    if (token === '') throw new Error(`crew roster: ${profileName}.csv line ${row.line} has no letter or digit to make an id`);
    if (tokens.has(token)) throw new Error(`crew roster: ${profileName}.csv line ${row.line} repeats the site id ${token}`);
    tokens.add(token);
    return {
      id: `personal:${profileName}:${token}`,
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      priority: row.priority,
      createdAt: ROSTER_CREATED_AT,
    };
  });
}

/** Mirrors _roster_site_token in generator/multiplex.py. */
function siteToken(siteName: string): string {
  return siteName
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}
