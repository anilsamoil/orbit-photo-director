/** Network-owned routes must never become an offline app-shell navigation. */
export const NAVIGATION_FALLBACK_DENYLIST = [
  /^\/cdn-cgi(?:\/|$)/,
  /^\/__opd_probe(?:\?|$)/,
  /^\/launch\//,
  /^\/api\//,
  /^\/v\//,
  /\/manifest\.json/,
];
