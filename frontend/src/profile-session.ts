/** Browser identity comes only from the Worker's verified Google session. */
export interface AccountProfile {
  name: string;
  displayName: string;
  /** False only when resuming this tab's last verified profile offline. */
  isVerified?: boolean;
}

const CACHE_KEY = 'opd-account-session-v1';
let account: AccountProfile | null = null;

export function getAccountProfile(): AccountProfile | null { return account; }

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

export async function resolveAccountProfile(): Promise<AccountProfile> {
  account = null;
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
    account = { name: body.profile.name, displayName: body.profile.displayName, isVerified: true };
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
