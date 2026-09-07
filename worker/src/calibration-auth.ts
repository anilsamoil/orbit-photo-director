import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { constantTimeEqual, jsonResponse } from './shared';

export interface CalibrationAuthEnv {
  CALIB_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

let cachedIssuer = '';
let cachedKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function authorizeCalibration(
  request: Request, env: CalibrationAuthEnv,
): Promise<Response | null> {
  const assertion = request.headers.get('cf-access-jwt-assertion');
  if (!assertion) {
    // Retain the existing machine/old-client credential, never expose it to
    // a signed-in browser or accept an unverified identity header instead.
    const token = request.headers.get('x-calib-token');
    if (token && env.CALIB_TOKEN && constantTimeEqual(token, env.CALIB_TOKEN)) return null;
    const configured = env.CALIB_TOKEN || (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
    return jsonResponse({ error: configured ? 'unauthorized' : 'service_misconfigured' }, configured ? 401 : 503);
  }
  const issuer = env.ACCESS_TEAM_DOMAIN ?? '';
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !env.ACCESS_AUD) {
    return jsonResponse({ error: 'service_misconfigured' }, 503);
  }
  if (request.method === 'POST' && (
    request.headers.get('origin') !== new URL(request.url).origin
    || request.headers.get('sec-fetch-site') === 'cross-site'
  )) return jsonResponse({ error: 'cross_origin_write' }, 403);
  try {
    if (!cachedKeys || cachedIssuer !== issuer) {
      cachedIssuer = issuer;
      cachedKeys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
    }
    const { payload } = await jwtVerify(assertion, cachedKeys, {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
    });
    if (typeof payload.email !== 'string' || !payload.email.includes('@')
      || typeof payload.sub !== 'string' || !payload.sub) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    return null;
  } catch (error) {
    const invalid = error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout);
    return jsonResponse({ error: invalid ? 'unauthorized' : 'authentication_unavailable' }, invalid ? 401 : 503);
  }
}
