import { describe, expect, it } from 'vitest';
import { NAVIGATION_FALLBACK_DENYLIST } from '../src/sw-navigation';

const fallsBackToApp = (path: string) => !NAVIGATION_FALLBACK_DENYLIST.some((rule) => rule.test(path));

describe('standalone research page navigation', () => {
  it.each([
    '/profile-research/jessica.html',
    '/profile-research/jessica.html?from=profile',
    '/profile-research/jessica.html?utm_source=map',
    '/profile-research/missing.html',
  ])('never replaces %s with the map shell when its static route is unavailable', (path) => {
    expect(fallsBackToApp(path)).toBe(false);
  });

  it.each(['/', '/?u=jessica', '/?u=anil'])('keeps offline map navigation available for %s', (path) => {
    expect(fallsBackToApp(path)).toBe(true);
  });
});
