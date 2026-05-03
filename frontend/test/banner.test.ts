import { describe, expect, it } from 'vitest';

import { bannerError, bannerFromManifest, bannerLoading } from '../src/banner';

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
