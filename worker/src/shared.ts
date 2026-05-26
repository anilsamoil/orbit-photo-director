/**
 * Shared helpers across worker routes.
 *
 * Centralized so the per-route handler files (index.ts, profiles.ts, ...) all
 * use the same token-compare + JSON-response shape + profile-name regex,
 * avoiding drift between endpoints.
 */

/** Constant-time string compare; avoids token-timing leaks across requests. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Build a JSON Response with `cache-control: no-store` and the right
 *  content-type. Extra headers (CORS) are merged downstream in the router. */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

/** Profile name validation. URL-safe, R2-key-safe, no path traversal.
 *  Mirrors `frontend/src/profile.ts:isValidProfileName` exactly — both
 *  sides MUST agree on what's a legal name or the client and server can
 *  disagree about which URL maps to which profile. */
const VALID_PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidProfileName(name: string): boolean {
  if (typeof name !== 'string') return false;
  return VALID_PROFILE_NAME_PATTERN.test(name);
}
