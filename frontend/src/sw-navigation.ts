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

/** Runtime cache that holds the last good index.html. Shared with public/sw-shell.js. */
export const APP_SHELL_CACHE = 'opd-shell';

/**
 * True for navigations the shell worker may answer. Denylisted paths stay on
 * the network so Access redirects and /api/app are not replaced with the app.
 */
export function createAppShellMatcher(denylist: readonly RegExp[]) {
  const checks = denylist.map((rule) => `if (${rule.toString()}.test(path)) return false;`).join('\n');
  return new Function('{ request, url }', `
    if (!request || request.mode !== 'navigate') return false;
    const path = url.pathname + url.search;
    ${checks}
    return true;
  `) as (args: { request: { mode: string } | null; url: { pathname: string; search: string } }) => boolean;
}

/**
 * Online navigations load the current index.html, bypassing the HTTP cache.
 * A hung request falls back to the last good shell after 8s, the same budget
 * the manifest route uses on a slow ISS link. Offline uses that shell.
 * The response is index.html for every app navigation, including /anil.
 */
export function createAppShellHandler() {
  return new Function('{ request }', `
    var cacheName = 'opd-shell';
    var timeoutMs = 8000;
    var network = fetch(new Request('/', { cache: 'reload' })).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(cacheName).then(function (cache) { return cache.put('/', copy); }).catch(function () {});
      }
      return response;
    }).catch(function () { return null; });
    var timeout = new Promise(function (resolve) {
      setTimeout(function () { resolve(null); }, timeoutMs);
    });
    return Promise.race([network, timeout]).then(function (response) {
      if (response && response.ok) return response;
      return caches.open(cacheName).then(function (cache) { return cache.match('/'); }).then(function (cached) {
        return cached || response || fetch(request);
      });
    });
  `) as (args: { request: Request }) => Promise<Response>;
}
