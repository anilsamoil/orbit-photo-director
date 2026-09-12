/** API/data routes and standalone pages must never become app-shell navigation. */
export const NAVIGATION_FALLBACK_DENYLIST = [
  /^\/cdn-cgi(?:\/|$)/,
  /^\/__opd_probe(?:\?|$)/,
  /^\/launch\//,
  /^\/profile-research\//,
  /^\/api\//,
  /^\/v\//,
  /\/manifest\.json/,
];
