import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import { mailboxKey, parseEmailAllowlist } from './email-allowlist.mjs';
import { constantTimeEqual, jsonResponse } from './shared';

export interface CalibrationAuthEnv {
  CALIB_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_PROFILE_BINDINGS?: string;
  ACCESS_PROFILE_GRANTS?: string;
  ACCESS_SERVICE_TOKEN_CLIENT_IDS?: string;
  ACCESS_ALLOWED_EMAILS?: string;
}

let cachedIssuer = '';
let cachedKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

declare const admittedEmail: unique symbol;

export type AdmittedEmail = string & { readonly [admittedEmail]: true };

export interface AccessIdentity {
  kind: 'access';
  issuer: string;
  subject: string;
  email: AdmittedEmail;
  displayName?: string;
}

export interface ServiceIdentity {
  kind: 'service';
  issuer: string;
  commonName: string;
}

export type CalibrationPrincipal = AccessIdentity | ServiceIdentity | { kind: 'machine' };
export type AuthenticationResult = { principal: CalibrationPrincipal } | { denied: Response };

type VerifiedAccess = { payload: JWTPayload; issuer: string } | { denied: Response };

function serviceClientIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  const ids = raw.split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  return new Set(ids);
}

interface VerifiedHumanClaim {
  issuer: string;
  subject: string;
  email: string;
  displayName?: string;
}

type EmailAllowlist = ReadonlySet<string>;

function humanClaim(payload: JWTPayload, issuer: string): VerifiedHumanClaim | null {
  if (typeof payload.email !== 'string' || !payload.email.includes('@')
    || typeof payload.sub !== 'string' || !payload.sub) return null;
  return {
    issuer, subject: payload.sub, email: payload.email,
    ...(typeof payload.name === 'string' ? { displayName: payload.name } : {}),
  };
}

function emailAllowlist(raw: string | undefined): EmailAllowlist {
  return new Set(parseEmailAllowlist(raw));
}

function admitHuman(
  claim: VerifiedHumanClaim,
  rawAllowlist: string | undefined,
): { principal: AccessIdentity } | { denied: Response } {
  if (!emailAllowlist(rawAllowlist).has(mailboxKey(claim.email))) {
    return { denied: jsonResponse({ error: 'email_not_allowlisted' }, 403) };
  }
  return {
    principal: {
      kind: 'access',
      issuer: claim.issuer,
      subject: claim.subject,
      email: claim.email as AdmittedEmail,
      ...(claim.displayName !== undefined ? { displayName: claim.displayName } : {}),
    },
  };
}

async function verifyAccessJwt(
  request: Request, env: CalibrationAuthEnv, assertion: string, requiredClaims: string[],
): Promise<VerifiedAccess> {
  const issuer = env.ACCESS_TEAM_DOMAIN ?? '';
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !env.ACCESS_AUD) {
    return { denied: jsonResponse({ error: 'service_misconfigured' }, 503) };
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (
    request.headers.get('origin') !== new URL(request.url).origin
    || request.headers.get('sec-fetch-site') === 'cross-site'
  )) return { denied: jsonResponse({ error: 'cross_origin_write' }, 403) };
  try {
    if (!cachedKeys || cachedIssuer !== issuer) {
      cachedIssuer = issuer;
      cachedKeys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
    }
    const { payload } = await jwtVerify(assertion, cachedKeys, {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'],
      requiredClaims,
    });
    return { payload, issuer };
  } catch (error) {
    const invalid = error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout);
    return { denied: jsonResponse({ error: invalid ? 'unauthorized' : 'authentication_unavailable' }, invalid ? 401 : 503) };
  }
}

/** Authenticate once and retain verified identity for ownership decisions.
 * Plain identity headers and client-selected profile names never establish identity. */
export async function authenticateCalibration(
  request: Request, env: CalibrationAuthEnv, requireAccess = false,
): Promise<AuthenticationResult> {
  const assertion = request.headers.get('cf-access-jwt-assertion');
  if (!assertion) {
    // Retain the existing machine/old-client credential, never expose it to
    // a signed-in browser or accept an unverified identity header instead.
    const token = request.headers.get('x-calib-token');
    if (!requireAccess && token && env.CALIB_TOKEN && constantTimeEqual(token, env.CALIB_TOKEN)) return { principal: { kind: 'machine' } };
    const configured = env.CALIB_TOKEN || (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
    return { denied: jsonResponse({ error: configured ? 'unauthorized' : 'service_misconfigured' }, configured ? 401 : 503) };
  }
  const verified = await verifyAccessJwt(request, env, assertion, ['exp', 'iat', 'sub', 'email']);
  if ('denied' in verified) return verified;
  const claim = humanClaim(verified.payload, verified.issuer);
  if (!claim) return { denied: jsonResponse({ error: 'unauthorized' }, 401) };
  return admitHuman(claim, env.ACCESS_ALLOWED_EMAILS);
}

export async function authenticateHealth(
  request: Request, env: CalibrationAuthEnv,
): Promise<AuthenticationResult> {
  const assertion = request.headers.get('cf-access-jwt-assertion');
  if (!assertion) {
    const configured = env.CALIB_TOKEN || (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
    return { denied: jsonResponse({ error: configured ? 'unauthorized' : 'service_misconfigured' }, configured ? 401 : 503) };
  }
  const verified = await verifyAccessJwt(request, env, assertion, ['exp', 'iat']);
  if ('denied' in verified) return verified;
  const claim = humanClaim(verified.payload, verified.issuer);
  if (claim) return admitHuman(claim, env.ACCESS_ALLOWED_EMAILS);
  const commonName = typeof verified.payload.common_name === 'string'
    ? verified.payload.common_name.trim() : '';
  if (commonName && serviceClientIds(env.ACCESS_SERVICE_TOKEN_CLIENT_IDS).has(commonName)) {
    return { principal: { kind: 'service', issuer: verified.issuer, commonName } };
  }
  return { denied: jsonResponse({ error: 'unauthorized' }, 401) };
}

/** Compatibility guard for callers that need authentication but no identity. */
export async function authorizeCalibration(request: Request, env: CalibrationAuthEnv): Promise<Response | null> {
  const auth = await authenticateCalibration(request, env);
  return 'denied' in auth ? auth.denied : null;
}
