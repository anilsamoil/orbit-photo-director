import { authenticateCalibration, type AccessIdentity, type CalibrationAuthEnv } from './calibration-auth';
import { isValidProfileName, jsonResponse } from './shared';

export interface BrowserProfile { name: string; displayName: string }
export type ProfileResolution = { profile: BrowserProfile; profiles: BrowserProfile[]; legacy: boolean } | { denied: Response };

const EMAIL_HASH_KEY = /^email:[a-f0-9]{64}$/;
const MAX_GRANT_CONFIG_CHARS = 65_536;
const MAX_GRANT_ACCOUNTS = 256;
const MAX_GRANTED_PROFILES = 32;

export function isOpaqueProfileName(name: string): boolean {
  return /^u-[a-f0-9]{28}$/.test(name);
}

/** Grants are operator-managed configuration, never user-supplied suggestions.
 * Validate every entry so a broken policy cannot partially authorize requests. */
function parseGrants(raw: string | undefined): Record<string, BrowserProfile[]> {
  if (raw === undefined) return {};
  if (raw.length > MAX_GRANT_CONFIG_CHARS) throw new Error();
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
  const entries = Object.entries(parsed);
  if (entries.length > MAX_GRANT_ACCOUNTS) throw new Error();
  const grants: Record<string, BrowserProfile[]> = {};
  for (const [key, profiles] of entries) {
    if (!EMAIL_HASH_KEY.test(key) || !Array.isArray(profiles) || profiles.length > MAX_GRANTED_PROFILES) throw new Error();
    const seen = new Set<string>();
    grants[key] = profiles.map((profile: unknown) => {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error();
      const value = profile as Record<string, unknown>;
      if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'displayName')
        || typeof value.name !== 'string' || !isValidProfileName(value.name) || seen.has(value.name)
        || typeof value.displayName !== 'string' || !value.displayName || value.displayName.length > 60
        || value.displayName.trim() !== value.displayName || /[@\u0000-\u001f\u007f]/.test(value.displayName)) throw new Error();
      seen.add(value.name);
      return { name: value.name, displayName: value.displayName };
    });
  }
  return grants;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Explicit private email-hash aliases preserve existing named data. Never
 * adopt a legacy profile from ?u=, a local nickname, or the first caller. */
export async function resolveBrowserProfile(identity: AccessIdentity, env: CalibrationAuthEnv): Promise<ProfileResolution> {
  let bindings: Record<string, string> = {};
  let grants: Record<string, BrowserProfile[]>;
  try {
    grants = parseGrants(env.ACCESS_PROFILE_GRANTS);
  } catch {
    return { denied: jsonResponse({ error: 'identity_configuration_unavailable' }, 503) };
  }
  if (env.ACCESS_PROFILE_BINDINGS) {
    try {
      const parsed: unknown = JSON.parse(env.ACCESS_PROFILE_BINDINGS);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      for (const [key, value] of Object.entries(parsed)) {
        if (!EMAIL_HASH_KEY.test(key) || typeof value !== 'string' || !isValidProfileName(value)
          || isOpaqueProfileName(value)) throw new Error();
      }
      bindings = parsed as Record<string, string>;
    } catch {
      return { denied: jsonResponse({ error: 'identity_configuration_unavailable' }, 503) };
    }
  }
  const emailKey = 'email:' + await sha256(identity.email.trim().toLowerCase());
  const alias = bindings[emailKey];
  const name = alias ?? 'u-' + (await sha256(identity.issuer + '\0' + identity.subject)).slice(0, 28);
  // This label is presentation only. The full email/sub never leaves the Worker.
  const suggested = identity.displayName?.trim() || identity.email.split('@')[0]!.replace(/[._+-]+/g, ' ');
  const displayName = suggested.replace(/[@\r\n\t]/g, ' ').trim().slice(0, 60) || 'Your profile';
  const profile = { name, displayName };
  const profiles = [profile, ...(grants[emailKey] ?? []).filter((grant) => grant.name !== name)];
  return { profile, profiles, legacy: alias !== undefined };
}

export async function handleBrowserSession(request: Request, env: CalibrationAuthEnv): Promise<Response> {
  const auth = await authenticateCalibration(request, env, true);
  if ('denied' in auth) return auth.denied;
  if (auth.principal.kind !== 'access') return jsonResponse({ error: 'unauthorized' }, 401);
  const resolved = await resolveBrowserProfile(auth.principal, env);
  if ('denied' in resolved) return resolved.denied;
  return jsonResponse({ ok: true, profile: resolved.profile, profiles: resolved.profiles });
}
