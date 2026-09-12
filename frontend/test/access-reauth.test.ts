import { describe, it, expect } from 'vitest';
import { ACCESS_REAUTH_PATH, bannerAuthExpired } from '../src/banner';
import { NAVIGATION_FALLBACK_DENYLIST } from '../src/sw-navigation';

async function readSrc(rel: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  return fs.readFile(path.resolve(__dirname, rel), 'utf-8');
}
const mainSrc = () => readSrc('../src/main.ts');
const swCfg = () => readSrc('../vite.config.ts');

describe('Cloudflare Access re-auth escape hatch', () => {
  it('the reauth path is denylisted in the SW navigation route', async () => {
    // The whole bug: NavigationRoute serves the precached shell for every
    // navigation, so a reload never sees the 302 to the Access login and the
    // operator can never sign back in. Only denylisted prefixes reach the
    // network. If ACCESS_REAUTH_PATH stops matching one, the escape hatch is
    // silently dead and the app is unrecoverable from inside.
    expect(NAVIGATION_FALLBACK_DENYLIST.some((rx) => rx.test(ACCESS_REAUTH_PATH))).toBe(true);
    // And the SW config must still declare that denylist.
    expect(await swCfg()).toMatch(/navigateFallbackDenylist:\s*NAVIGATION_FALLBACK_DENYLIST/);
  });

  it.each([
    '/cdn-cgi/access/authorized?nonce=synthetic',
    '/cdn-cgi/access/login',
    '/cdn-cgi/challenge-platform/test',
    '/__opd_probe',
    '/__opd_probe?_probe=123',
    '/launch/latest.json',
    '/api/app?u=jessica',
    '/v/test/track.json',
    '/manifest.json',
  ])('keeps the network-owned navigation %s out of the app shell', (path) => {
    expect(NAVIGATION_FALLBACK_DENYLIST.some((rx) => rx.test(path))).toBe(true);
  });

  it.each(['/', '/anil', '/anil?tab=map', '/kikina', '/cdn-cgi-not-a-route'])
    ('retains offline app-shell navigation for %s', (path) => {
      expect(NAVIGATION_FALLBACK_DENYLIST.some((rx) => rx.test(path))).toBe(false);
    });

  it('probes with redirect:manual so the 302 is detectable', async () => {
    // A default fetch follows the cross-origin redirect and dies on CORS, which
    // is indistinguishable from a real LOS. Only redirect:'manual' surfaces the
    // 302 as an inspectable opaqueredirect.
    const src = await mainSrc();
    expect(src).toMatch(/redirect:\s*'manual'/);
    expect(src).toMatch(/opaqueredirect/);
    expect(src).toMatch(/cache:\s*'no-store'/);
  });

  it('probes a path the service worker does not intercept', () => {
    // Probing /manifest.json would be answered from the NetworkFirst cache —
    // the exact blindness the probe exists to defeat.
    expect(ACCESS_REAUTH_PATH).not.toMatch(/manifest\.json/);
    expect(ACCESS_REAUTH_PATH.startsWith('/api/')).toBe(true);
  });

  it('treats probe failure as NOT-expired', async () => {
    // A genuine LOS must not be reported as a login problem, or the operator
    // taps through to a login page that cannot load.
    expect(await mainSrc()).toMatch(/catch\s*\{\s*return false;\s*\}/);
  });

  it('does not overwrite the auth banner with the ordinary STALE banner', async () => {
    // "STALE" reads as a comms gap to wait out. That framing is what let this
    // sit for 26h on 2026-09-01. When it is an expired session the banner must
    // tell the operator to act.
    expect(await mainSrc()).toMatch(/await maybeFlagExpiredSession\(/);
  });

  it('the auth banner says sign in, not stale', () => {
    const b = bannerAuthExpired(1599);
    expect(b.level).toBe('red');
    expect(b.text).toMatch(/SIGN IN AGAIN/);
    expect(b.text).toMatch(/Tap here/);
    expect(b.text).not.toMatch(/STALE/);
    expect(b.text).toContain('26h 39m'); // the real observed value
  });

  it('only probes once the manifest is well past one generator tick', async () => {
    // Generator ticks hourly. Probing on every refresh would add a request per
    // poll over a link where that actually costs something.
    expect(await mainSrc()).toMatch(/AUTH_PROBE_AGE_MINUTES\s*=\s*150/);
  });
});
