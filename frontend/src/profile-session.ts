import { rosterProfiles, type RosterProfile } from './crew-roster';

export interface AccountProfile {
  name: string;
  displayName: string;
  isVerified?: boolean;
  /** This origin served the app shell instead of an account API. */
  localOnly?: boolean;
}

export class SessionSignInRequired extends Error {
  constructor() {
    super('Please sign in again to open your own profile. Your saved data has been kept.');
    this.name = 'SessionSignInRequired';
  }
}

const CACHE_KEY = 'opd-account-session-v1';
let account: AccountProfile | null = null;
let signedInAccount: AccountProfile | null = null;
let authorizedProfiles: AccountProfile[] = [];

/** Active profile; all personal caches, writes and ratings use this scope. */
export function getAccountProfile(): AccountProfile | null { return account; }
/** The Google account's own profile, distinct from a crew profile it manages. */
export function getSignedInAccountProfile(): AccountProfile | null { return signedInAccount; }
/** Offline cache never supplies permissions to switch into another profile. */
export function getAuthorizedProfiles(): AccountProfile[] {
  return authorizedProfiles.map((profile) => ({ ...profile }));
}
export function canSelectProfile(name: string): boolean {
  return account?.isVerified === true && authorizedProfiles.some((profile) => profile.name === name);
}

const LOCAL_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

function profileNameFromUrl(urlHref: string): string {
  try {
    const requested = new URL(urlHref).searchParams.get('u');
    if (requested && LOCAL_NAME.test(requested)) return requested;
  } catch { /* keep the device default */ }
  return 'anil';
}

function adoptLocalProfile(name: string): AccountProfile {
  const profile: AccountProfile = { name, displayName: name, isVerified: false, localOnly: true };
  account = profile;
  signedInAccount = profile;
  authorizedProfiles = [profile];
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(profile)); } catch { /* storage disabled */ }
  return profile;
}

type SessionDecision =
  | { kind: 'local'; name: string }
  | { kind: 'sign-in' }
  | { kind: 'json'; body: unknown };

async function decideSessionResponse(response: Response, urlHref: string): Promise<SessionDecision> {
  if (response.type === 'opaqueredirect' || response.redirected
    || response.status === 302 || response.status === 401 || response.status === 403) {
    return { kind: 'sign-in' };
  }
  const type = response.headers?.get('content-type') ?? '';
  if (response.status === 404 && !type.includes('json')) return { kind: 'local', name: profileNameFromUrl(urlHref) };
  if (response.ok && type.includes('text/html')) {
    const html = await response.text();
    if (html.includes('id="status-banner"')) return { kind: 'local', name: profileNameFromUrl(urlHref) };
    return { kind: 'sign-in' };
  }
  if (!response.ok) return { kind: 'sign-in' };
  return { kind: 'json', body: await response.json() };
}

function cachedSessionProfile(): AccountProfile | null {
  try {
    const cached: unknown = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null');
    return validProfile(cached) ? cached : null;
  } catch { return null; }
}

function resumeOfflineProfile(): AccountProfile | null {
  const cached = cachedSessionProfile();
  if (!cached) return null;
  account = {
    name: cached.name,
    displayName: cached.displayName,
    isVerified: false,
    ...(cached.localOnly ? { localOnly: true } : {}),
  };
  if (account.localOnly) {
    signedInAccount = account;
    authorizedProfiles = [account];
  }
  return account;
}

function sessionJson(value: unknown): { profile: unknown; profiles: unknown } | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as { ok?: unknown; profile?: unknown; profiles?: unknown };
  if (body.ok !== true) return null;
  return { profile: body.profile, profiles: body.profiles };
}

function validProfile(value: unknown): value is AccountProfile {
  if (!value || typeof value !== 'object') return false;
  const p = value as AccountProfile;
  return typeof p.name === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(p.name)
    && typeof p.displayName === 'string' && p.displayName.trim().length > 0
    && p.displayName.length <= 200;
}

function validateAuthorizedProfiles(value: unknown, own: AccountProfile): AccountProfile[] {
  // Old Workers return only the account profile. An explicitly malformed list
  // must fail closed instead of silently retaining earlier permissions.
  if (value === undefined) return [own];
  if (!Array.isArray(value) || value.length < 1 || value.length > 100
    || !value.every(validProfile)) throw new Error('Could not verify your profiles. Please reload when connected.');
  const profiles = value as AccountProfile[];
  if (new Set(profiles.map((profile) => profile.name)).size !== profiles.length
    || !profiles.some((profile) => profile.name === own.name && profile.displayName === own.displayName)) {
    throw new Error('Could not verify your profiles. Please reload when connected.');
  }
  return [own, ...profiles.filter((profile) => profile.name !== own.name)].map((profile) => ({
    name: profile.name, displayName: profile.displayName, isVerified: true,
  }));
}

export async function resolveAccountProfile(urlHref = window.location.href): Promise<AccountProfile> {
  const roster = requestedRosterProfile(urlHref);
  const session = await resolveSessionProfile(roster ? sessionHref(urlHref) : urlHref);
  if (!roster) return session;
  account = { name: roster.name, displayName: roster.displayName, isVerified: false };
  return account;
}

function requestedRosterProfile(urlHref: string): RosterProfile | undefined {
  let requested: string | null = null;
  try { requested = new URL(urlHref).searchParams.get('u'); } catch {}
  return rosterProfiles().find((profile) => profile.name === requested);
}

function sessionHref(urlHref: string): string {
  const url = new URL(urlHref);
  const cached = cachedSessionProfile();
  if (cached) url.searchParams.set('u', cached.name);
  else url.searchParams.delete('u');
  return url.href;
}

async function resolveSessionProfile(urlHref: string): Promise<AccountProfile> {
  account = null;
  signedInAccount = null;
  authorizedProfiles = [];
  // Tab-local storage avoids selecting another account merely because it used
  // this browser previously. Never resume a cache after an HTTP/auth failure.
  if (navigator.onLine === false) {
    const cached = resumeOfflineProfile();
    if (cached) return cached;
    throw new Error('Connect once to verify your Google account. Your saved data is still on this device.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let response: Response;
    try {
      response = await fetch('/api/browser/session', {
        credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      // iOS can report online during LOS. A transport failure can resume this
      // tab read-only; an actual HTTP denial or malformed response cannot.
      const cached = resumeOfflineProfile();
      if (cached) return cached;
      throw error;
    }
    const decided = await decideSessionResponse(response, urlHref);
    if (decided.kind === 'local') return adoptLocalProfile(decided.name);
    if (decided.kind === 'sign-in') throw new SessionSignInRequired();
    const body = sessionJson(decided.body);
    if (!body || !validProfile(body.profile)) {
      throw new Error('Could not verify your profile. Please reload when connected.');
    }
    const own = { name: body.profile.name, displayName: body.profile.displayName, isVerified: true };
    const profiles = validateAuthorizedProfiles(body.profiles, own);
    let requested: string | null = null;
    try { requested = new URL(urlHref).searchParams.get('u'); } catch { /* use own profile */ }
    account = profiles.find((profile) => profile.name === requested) ?? own;
    signedInAccount = own;
    authorizedProfiles = profiles;
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(account)); } catch { /* storage disabled */ }
    return account;
  } catch (error) {
    // An expired or changed account must not resume an older offline identity.
    try { sessionStorage.removeItem(CACHE_KEY); } catch { /* storage disabled */ }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
