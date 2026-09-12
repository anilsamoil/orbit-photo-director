import { authenticateCalibration, type AccessIdentity, type CalibrationAuthEnv } from './calibration-auth';
import { isValidProfileName, jsonResponse } from './shared';

export interface BrowserProfile { name: string; displayName: string }
export type ProfileResolution = { profile: BrowserProfile; legacy: boolean } | { denied: Response };

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Explicit private email-hash aliases preserve existing named data. Never
 * adopt a legacy profile from ?u=, a local nickname, or the first caller. */
export async function resolveBrowserProfile(identity: AccessIdentity, env: CalibrationAuthEnv): Promise<ProfileResolution> {
  let bindings: Record<string, string> = {};
  if (env.ACCESS_PROFILE_BINDINGS) {
    try {
      const parsed: unknown = JSON.parse(env.ACCESS_PROFILE_BINDINGS);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      for (const [key, value] of Object.entries(parsed)) {
        if (!/^email:[a-f0-9]{64}$/.test(key) || typeof value !== 'string' || !isValidProfileName(value)
          || /^u-[a-f0-9]{28}$/.test(value)) throw new Error();
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
  return { profile: { name, displayName }, legacy: alias !== undefined };
}

export async function handleBrowserSession(request: Request, env: CalibrationAuthEnv): Promise<Response> {
  const auth = await authenticateCalibration(request, env, true);
  if ('denied' in auth) return auth.denied;
  if (auth.principal.kind !== 'access') return jsonResponse({ error: 'unauthorized' }, 401);
  const resolved = await resolveBrowserProfile(auth.principal, env);
  if ('denied' in resolved) return resolved.denied;
  return jsonResponse({ ok: true, profile: resolved.profile });
}
