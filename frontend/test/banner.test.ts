import { describe, expect, it } from 'vitest';

import { bannerError, bannerFromManifest, bannerLoading } from '../src/banner';

describe('bannerFromManifest', () => {
  const now = Date.parse('2024-10-17T12:00:00Z');

  it('green when fresh and freshness.ok (5 min old)', () => {
    const result = bannerFromManifest('2024-10-17T11:55:00Z', true, now);
    expect(result.level).toBe('green');
    expect(result.text).toContain('Last updated');
  });

  it('green at 2h old (under 2h30m threshold)', () => {
    const result = bannerFromManifest('2024-10-17T10:00:00Z', true, now);
    expect(result.level).toBe('green');
  });

  it('yellow at 2h45m old (between 2h30m and 3h)', () => {
    const result = bannerFromManifest('2024-10-17T09:15:00Z', true, now);
    expect(result.level).toBe('yellow');
    expect(result.text).toContain('running slow');
  });

  it('red at 4h old (past 3h threshold)', () => {
    const result = bannerFromManifest('2024-10-17T08:00:00Z', true, now);
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
