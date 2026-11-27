import { rosterProfiles, type RosterProfile } from './crew-roster';
import { isOnline } from './network-status';
import { ROSTER_READ_SCOPE_INVALIDATED } from './profile-events';

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
const ROSTER_SESSION_RECHECK_MS = 60_000;
let account: AccountProfile | null = null;
let signedInAccount: AccountProfile | null = null;
let authorizedProfiles: AccountProfile[] | undefined;
let rosterReadScope: { account: AccountProfile; profileName: string; displayName: string; viewerName: string } | undefined;
let rosterReadRevision = 0;
let lastRosterSessionCheck = -Infinity;

/** Active profile; all personal caches, writes and ratings use this scope. */
export function getAccountProfile(): AccountProfile | null { return account; }
/** The Google account's own profile, distinct from a crew profile it manages. */
export function getSignedInAccountProfile(): AccountProfile | null { return signedInAccount; }
/** Offline cache never supplies permissions to switch into another profile. */
export function getAuthorizedProfiles(): AccountProfile[] {
  return (authorizedProfiles ?? (signedInAccount ? [signedInAccount] : [])).map((profile) => ({ ...profile }));
}
export function canSelectProfile(name: string): boolean {
  return account?.isVerified === true && (authorizedProfiles ?? [account]).some((profile) => profile.name === name);
}

export function getRosterReadScope(name: string) {
  if (rosterReadScope?.account === account && account?.name === name && isOnline()) return rosterReadScope;
}

export function invalidateRosterReadScope(): void {
  rosterReadRevision += 1;
  if (rosterReadScope) {
    rosterReadScope = undefined;
    window.dispatchEvent(new Event(ROSTER_READ_SCOPE_INVALIDATED));
  }
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
  signedInAccount = profile;
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
  const profile = {
    name: cached.name,
    displayName: cached.displayName,
    isVerified: false,
    ...(cached.localOnly ? { localOnly: true } : {}),
  };
  if (profile.localOnly) {
    signedInAccount = profile;
  }
  return profile;
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

export function revalidateRosterReadScope(urlHref: string): Promise<AccountProfile> | undefined {
  if (performance.now() - lastRosterSessionCheck < ROSTER_SESSION_RECHECK_MS) return;
  return resolveAccountProfile(urlHref, { preserveRosterReadScope: true });
}

export async function resolveAccountProfile(
  urlHref = window.location.href,
  { preserveRosterReadScope = false } = {},
): Promise<AccountProfile> {
  const roster = requestedRosterProfile(urlHref);
  if (!roster || account?.name !== roster.name || account.isVerified !== false) account = null;
  const previousScope = preserveRosterReadScope && roster ? getRosterReadScope(roster.name) : undefined;
  if (!previousScope) invalidateRosterReadScope();
  const revision = rosterReadRevision;
  const isCurrent = () => !roster || revision === rosterReadRevision;
  if (roster?.accountProfile) lastRosterSessionCheck = performance.now();
  let session: AccountProfile;
  try {
    session = await resolveSessionProfile(roster ? sessionHref(urlHref) : urlHref, isCurrent);
  } catch (error) {
    if (previousScope && isCurrent()) invalidateRosterReadScope();
    throw error;
  }
  if (!roster) {
    account = session;
    return account;
  }
  const rosterAccount = account?.name === roster.name
    ? account : { name: roster.name, displayName: roster.displayName, isVerified: false };
  if (!isCurrent()) return rosterAccount;
  account = rosterAccount;
  const profileName = roster.accountProfile;
  const viewer = signedInAccount;
  const granted = profileName && viewer?.isVerified && !viewer.localOnly
    && authorizedProfiles?.some((profile) => profile.name === profileName);
  if (previousScope && (!granted || previousScope.viewerName !== viewer?.name)) invalidateRosterReadScope();
  if (granted && !rosterReadScope) {
    rosterReadScope = { account, profileName, displayName: roster.displayName, viewerName: viewer.name };
  }
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

async function resolveSessionProfile(urlHref: string, isCurrent: () => boolean): Promise<AccountProfile> {
  signedInAccount = null;
  authorizedProfiles = undefined;
  // Tab-local storage avoids selecting another account merely because it used
  // this browser previously. Never resume a cache after an HTTP/auth failure.
  if (navigator.onLine === false) {
    const cached = resumeOfflineProfile();
    if (cached) return cached;
    throw new Error('Connect once to verify your Google account. Your saved data is still on this device.');
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      settled = true;
      controller.abort();
      reject(new Error('The session request timed out'));
    }, 10_000);
  });
  const forgetLate = <T>(error: unknown): Promise<T> => {
    if (settled) return new Promise<T>(() => {});
    return Promise.reject(error);
  };
  const headers = fetch('/api/browser/session', {
    credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
    signal: controller.signal,
  }).catch((error: unknown) => forgetLate<Response>(error));
  try {
    let response: Response;
    try {
      response = await Promise.race([headers, deadline]);
    } catch (error) {
      settled = true;
      // iOS can report online during LOS. A transport failure can resume this
      // tab read-only; an actual HTTP denial or malformed response cannot.
      if (!isCurrent()) throw error;
      const cached = resumeOfflineProfile();
      if (cached) return cached;
      throw error;
    }
    const decision = decideSessionResponse(response, urlHref)
      .catch((error: unknown) => forgetLate<SessionDecision>(error));
    let decided: SessionDecision;
    try {
      decided = await Promise.race([decision, deadline]);
      settled = true;
    } catch (error) {
      settled = true;
      if (!isCurrent() || !(error instanceof Error) || error.message !== 'The session request timed out') throw error;
      const cached = resumeOfflineProfile();
      if (cached) return cached;
      throw error;
    }
    if (!isCurrent()) throw new Error('The session request was superseded');
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
    const profile = profiles.find((candidate) => candidate.name === requested) ?? own;
    signedInAccount = own;
    authorizedProfiles = body.profiles === undefined ? undefined : profiles;
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(profile)); } catch { /* storage disabled */ }
    return profile;
  } catch (error) {
    // An expired or changed account must not resume an older offline identity.
    if (isCurrent()) {
      try { sessionStorage.removeItem(CACHE_KEY); } catch { /* storage disabled */ }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
