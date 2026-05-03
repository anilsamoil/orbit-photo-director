import { describe, expect, it } from 'vitest';

import {
  formatCountdown,
  formatScore,
  formatUtcLabel,
  parseUtcIso,
} from '../src/countdown';

describe('parseUtcIso', () => {
  it('parses a valid UTC ISO 8601', () => {
    const d = parseUtcIso('2024-10-17T12:00:00Z');
    expect(d.getUTCHours()).toBe(12);
  });

  it('rejects non-Z timestamps', () => {
    expect(() => parseUtcIso('2024-10-17T12:00:00+00:00')).toThrow(/Z suffix/);
  });

  it('rejects bare local strings', () => {
    expect(() => parseUtcIso('2024-10-17T12:00:00')).toThrow(/Z suffix/);
  });

  it('rejects garbage', () => {
    expect(() => parseUtcIso('not-a-dateZ')).toThrow();
  });
});

describe('formatUtcLabel', () => {
  it('always ends with UTC', () => {
    const label = formatUtcLabel('2024-10-17T14:23:00Z');
    expect(label.endsWith('UTC')).toBe(true);
  });

  it('zero-pads single-digit hours and minutes', () => {
    const label = formatUtcLabel('2024-10-17T04:07:00Z');
    expect(label).toBe('04:07 UTC');
  });

  it('renders the literal UTC clock, not local', () => {
    const label = formatUtcLabel('2024-10-17T22:30:00Z');
    expect(label).toBe('22:30 UTC');
  });
});

describe('formatCountdown', () => {
  const now = Date.parse('2024-10-17T12:00:00Z');

  it('shows hours-and-minutes for far future', () => {
    expect(formatCountdown('2024-10-17T13:30:00Z', now)).toBe('In 1h 30m');
  });

  it('shows minutes for sub-hour', () => {
    expect(formatCountdown('2024-10-17T12:23:00Z', now)).toBe('In 23 min');
  });

  it('shows seconds for sub-minute', () => {
    expect(formatCountdown('2024-10-17T12:00:30Z', now)).toBe('In 30s');
  });

  it('shows Now when within active pass window', () => {
    const result = formatCountdown('2024-10-17T11:58:00Z', now);
    expect(result.startsWith('Now')).toBe(true);
  });

  it('shows Past when beyond pass window', () => {
    expect(formatCountdown('2024-10-17T11:50:00Z', now)).toBe('Past');
  });

  it('handles exactly-now without crashing', () => {
    expect(formatCountdown('2024-10-17T12:00:00Z', now)).toBe('In 0s');
  });
});

describe('formatScore', () => {
  it('rounds to integer', () => {
    expect(formatScore(87.4)).toBe('87');
    expect(formatScore(87.5)).toBe('88');
  });

  it('does not append a percent sign', () => {
    expect(formatScore(50)).toBe('50');
  });
});
