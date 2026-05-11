import { describe, expect, it } from 'vitest';

import {
  bannerError,
  bannerFromManifest,
  bannerLoading,
  bannerOffline,
  bannerWithLaunchesOverlay,
  bannerWithTleOverlay,
} from '../src/banner';

describe('bannerFromManifest', () => {
  const now = Date.parse('2024-10-17T12:00:00Z');

  it('green when fresh and freshness.ok (5 min old)', () => {
    const result = bannerFromManifest('2024-10-17T11:55:00Z', true, now);
    expect(result.level).toBe('green');
    expect(result.text).toContain('Last updated');
  });

  it('green at 1h old (under 1h30m threshold)', () => {
    const result = bannerFromManifest('2024-10-17T11:00:00Z', true, now);
    expect(result.level).toBe('green');
  });

  it('yellow at 1h45m old (between 1h30m and 2h)', () => {
    const result = bannerFromManifest('2024-10-17T10:15:00Z', true, now);
    expect(result.level).toBe('yellow');
    expect(result.text).toContain('running slow');
  });

  it('red at 3h old (past 2h threshold)', () => {
    const result = bannerFromManifest('2024-10-17T09:00:00Z', true, now);
    expect(result.level).toBe('red');
    expect(result.text).toContain('STALE');
  });

  it('red when freshness.ok is false (degraded inputs)', () => {
    const result = bannerFromManifest('2024-10-17T11:55:00Z', false, now);
    expect(result.level).toBe('red');
    expect(result.text).toContain('degraded');
  });

  it('red on clock skew (server ahead)', () => {
    const result = bannerFromManifest('2024-10-17T12:30:00Z', true, now);
    expect(result.level).toBe('red');
    expect(result.text).toContain('Clock skew');
  });
});

describe('bannerLoading + bannerError', () => {
  it('loading state', () => {
    expect(bannerLoading().level).toBe('loading');
  });

  it('error state echoes reason', () => {
    const r = bannerError('boom');
    expect(r.level).toBe('red');
    expect(r.text).toContain('boom');
  });
});

describe('bannerOffline (snapshot age escalation)', () => {
  it('green when snapshot is < 1h old', () => {
    const r = bannerOffline(15);
    expect(r.level).toBe('green');
    expect(r.text).toContain('LOS');
    expect(r.text).toContain('15 min');
  });

  it('yellow at 1–3h', () => {
    expect(bannerOffline(60).level).toBe('yellow');
    expect(bannerOffline(90).level).toBe('yellow');
    expect(bannerOffline(179).level).toBe('yellow');
  });

  it('orange at 3–12h', () => {
    expect(bannerOffline(180).level).toBe('orange');
    expect(bannerOffline(300).level).toBe('orange');
    expect(bannerOffline(719).level).toBe('orange');
    expect(bannerOffline(300).text).toContain('drifting');
  });

  it('red beyond 12h', () => {
    expect(bannerOffline(720).level).toBe('red');
    expect(bannerOffline(1500).level).toBe('red');
    expect(bannerOffline(1500).text).toContain('very old');
  });

  it('formats hours+minutes for >1h ages', () => {
    expect(bannerOffline(135).text).toContain('2h 15m');
  });
});

describe('bannerWithTleOverlay', () => {
  const greenBase = { level: 'green' as const, text: 'Last updated 5 min ago' };
  const redBase = { level: 'red' as const, text: 'STALE — 4h ago' };

  it('passes through when TLE is fresh (<48h)', () => {
    expect(bannerWithTleOverlay(greenBase, 12).level).toBe('green');
    expect(bannerWithTleOverlay(greenBase, 47).level).toBe('green');
  });

  it('passes through when TLE age is undefined (older manifests)', () => {
    expect(bannerWithTleOverlay(greenBase, undefined).level).toBe('green');
    expect(bannerWithTleOverlay(greenBase, NaN).level).toBe('green');
  });

  it('bumps green to orange and appends TLE note when TLE >48h', () => {
    const r = bannerWithTleOverlay(greenBase, 60);
    expect(r.level).toBe('orange');
    expect(r.text).toContain('Last updated 5 min ago');
    expect(r.text).toContain('TLE 60h old');
  });

  it('keeps red as red but still appends the TLE note', () => {
    const r = bannerWithTleOverlay(redBase, 72);
    expect(r.level).toBe('red');
    expect(r.text).toContain('STALE');
    expect(r.text).toContain('TLE 72h old');
  });
});

describe('bannerWithLaunchesOverlay', () => {
  const greenBase = { level: 'green' as const, text: 'Last updated 5 min ago' };
  const orangeBase = { level: 'orange' as const, text: 'LOS · 5h ago — values may be drifting' };
  const redBase = { level: 'red' as const, text: 'STALE — 4h ago' };

  it('passes through when launches data is fresh (<=24h)', () => {
    expect(bannerWithLaunchesOverlay(greenBase, 12).level).toBe('green');
    expect(bannerWithLaunchesOverlay(greenBase, 24).level).toBe('green');
    expect(bannerWithLaunchesOverlay(greenBase, 0).level).toBe('green');
  });

  it('passes through when hoursStale is undefined (no LL2 fetch ever, or older snapshot)', () => {
    expect(bannerWithLaunchesOverlay(greenBase, undefined).level).toBe('green');
    expect(bannerWithLaunchesOverlay(greenBase, NaN).level).toBe('green');
    expect(bannerWithLaunchesOverlay(greenBase, undefined).text).toBe(greenBase.text);
  });

  it('bumps green to orange and appends note when launches >24h stale', () => {
    const r = bannerWithLaunchesOverlay(greenBase, 30);
    expect(r.level).toBe('orange');
    expect(r.text).toContain('Last updated 5 min ago');
    expect(r.text).toContain('🚀 launches stale 30h');
  });

  it('keeps orange as orange and appends note', () => {
    const r = bannerWithLaunchesOverlay(orangeBase, 36);
    expect(r.level).toBe('orange');
    expect(r.text).toContain('LOS');
    expect(r.text).toContain('🚀 launches stale 36h');
  });

  it('keeps red as red but still appends the note (no downgrade)', () => {
    const r = bannerWithLaunchesOverlay(redBase, 36);
    expect(r.level).toBe('red');
    expect(r.text).toContain('STALE');
    expect(r.text).toContain('🚀 launches stale 36h');
  });

  it('formats long staleness as days past 48h (operator scan-readability)', () => {
    const r = bannerWithLaunchesOverlay(greenBase, 96);
    expect(r.text).toContain('🚀 launches stale 4d');
  });

  it('does not overlay onto the loading state (cold-start guard)', () => {
    // Review 2026-05-10: cold start with stale launches signal would otherwise
    // upgrade "Loading…" to orange and surface the overlay before any data
    // has been fetched, hiding the loading indicator.
    const loadingBase = { level: 'loading' as const, text: 'Loading…' };
    const r = bannerWithLaunchesOverlay(loadingBase, 48);
    expect(r.level).toBe('loading');
    expect(r.text).toBe('Loading…');
  });

  it('composes correctly with bannerWithTleOverlay (TLE drift + launches stale together)', () => {
    // Scenario: LOS for hours, TLE 60h old, launches 30h stale.
    // The user should see all three signals in priority order.
    const composed = bannerWithLaunchesOverlay(
      bannerWithTleOverlay(bannerOffline(300), 60),
      30,
    );
    expect(composed.text).toContain('LOS');
    expect(composed.text).toContain('TLE 60h old');
    expect(composed.text).toContain('🚀 launches stale 30h');
  });
});
