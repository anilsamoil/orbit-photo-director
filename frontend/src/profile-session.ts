/** Browser identity and selectable profiles come only from the verified session. */
export interface AccountProfile {
  name: string;
  displayName: string;
  /** False only when resuming this tab's last verified profile offline. */
  isVerified?: boolean;
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

function resumeOfflineProfile(): AccountProfile | null {
  try {
    const cached: unknown = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null');
    if (validProfile(cached)) {
      account = { name: cached.name, displayName: cached.displayName, isVerified: false };
      return account;
    }
  } catch { /* no usable tab-local offline session */ }
  return null;
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
    if (!response.ok || response.redirected || response.type === 'opaqueredirect') {
      throw new Error('Please sign in again to open your own profile. Your saved data has been kept.');
    }
    const body = await response.json();
    if (body?.ok !== true || !validProfile(body.profile)) {
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
