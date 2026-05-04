import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SNAPSHOT_KEY,
  _clearSnapshotForTests,
  readSnapshot,
  saveSnapshot,
  snapshotAgeMinutes,
  type Snapshot,
} from '../src/snapshot';
import type { Manifest, PassEntry, Status, Track } from '../src/types';

const MANIFEST: Manifest = {
  version: '20260504T120000Z',
  generated_at: '2026-05-04T12:00:00Z',
  tle_epoch: '2026-05-04T00:00:00Z',
  cloud_composite_hour: '2026-05-04T12:00:00Z',
  target_data_version: 'v1',
  build_version: '2.0.0.0',
  freshness: { tle_hours: 12, cloud_hours: 0, ok: true },
  artifacts: {
    top5: { path: 'v/20260504T120000Z/top5.json', sha256: 'a'.repeat(64), bytes: 100 },
    track: { path: 'v/20260504T120000Z/track.json', sha256: 'b'.repeat(64), bytes: 200 },
  },
};

const TRACK: Track = {
  iss_polynomial: {
    start: '2026-05-04T12:00:00Z',
    duration_seconds: 7200,
    lat_coeffs: [0, 0, 0, 0, 0.01, 0],
    lon_coeffs: [0, 0, 0, 0, 0.04, 0],
    polynomial_order: 5,
  },
  tle_epoch: '2026-05-04T00:00:00Z',
  tle_age_hours: 12,
  tle_freshness_factor: 1,
};

const STATUS: Status = {
  last_run: '2026-05-04T12:00:00Z',
  tick_minutes: 60,
  tle_age_hours: 12,
  tle_freshness_factor: 1,
  cloud_source: 'gibs',
  cloud_composite_hour: '2026-05-04T12:00:00Z',
  target_count: 33,
  pass_count: 12,
  version: '20260504T120000Z',
  build_version: '2.0.0.0',
};

const PASS: PassEntry = {
  target_id: 'tokyo-night',
  target_name: 'Tokyo at night',
  target_regime: 'night',
  target_priority: 5,
  target_lat: 35.68,
  target_lon: 139.69,
  closest_approach: '2026-05-04T13:30:00Z',
  nadir_distance_km: 200,
  pass_regime: 'night',
  obstruction_class: 'clear',
  p_unobstructed: 0.85,
  cloud_fraction: 15,
  cloud_source: 'gibs',
  score: 0.78,
  score_components: {
    p_unobstructed: 0.85,
    regime_fit: 1,
    nadir_proximity: 0.75,
    priority_weight: 1,
    tle_freshness: 1,
  },
  iss_at_closest: { lat: 35.7, lon: 139.7, alt_km: 410 },
};

function buildSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    manifest: MANIFEST,
    top5: [PASS],
    top_24h: [],
    track: TRACK,
    status: STATUS,
    savedAt: Date.parse('2026-05-04T12:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => _clearSnapshotForTests());
afterEach(() => _clearSnapshotForTests());

describe('saveSnapshot', () => {
  it('writes the snapshot under opd-snapshot', () => {
    expect(saveSnapshot(buildSnapshot())).toBe(true);
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).manifest.version).toBe('20260504T120000Z');
  });

  it('returns false on quota exceeded without throwing', () => {
    const original = Object.getOwnPropertyDescriptor(localStorage, 'setItem')
      ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(localStorage), 'setItem');
    Object.defineProperty(localStorage, 'setItem', {
      configurable: true,
      writable: true,
      value: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    });
    try {
      expect(saveSnapshot(buildSnapshot())).toBe(false);
    } finally {
      if (original) Object.defineProperty(localStorage, 'setItem', original);
    }
  });
});

describe('readSnapshot', () => {
  it('round-trips a saved snapshot', () => {
    const snap = buildSnapshot();
    saveSnapshot(snap);
    const back = readSnapshot();
    expect(back).not.toBeNull();
    expect(back!.manifest.version).toBe(snap.manifest.version);
    expect(back!.top5[0].target_id).toBe('tokyo-night');
    expect(back!.savedAt).toBe(snap.savedAt);
  });

  it('returns null when nothing is saved', () => {
    expect(readSnapshot()).toBeNull();
  });

  it('returns null on corrupted JSON without throwing', () => {
    localStorage.setItem(SNAPSHOT_KEY, '{not valid json');
    expect(readSnapshot()).toBeNull();
  });

  it('returns null on shape mismatch (missing manifest)', () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ savedAt: 123 }));
    expect(readSnapshot()).toBeNull();
  });

  it('returns null on shape mismatch (missing savedAt)', () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ manifest: MANIFEST }));
    expect(readSnapshot()).toBeNull();
  });

  it('never discards an old snapshot — 25h-old is still readable', () => {
    const ancient = buildSnapshot({ savedAt: Date.parse('2026-05-03T11:00:00Z') });
    saveSnapshot(ancient);
    const back = readSnapshot();
    expect(back).not.toBeNull();
    expect(back!.savedAt).toBe(ancient.savedAt);
  });
});

describe('snapshotAgeMinutes', () => {
  it('returns Infinity when no snapshot is saved', () => {
    expect(snapshotAgeMinutes()).toBe(Infinity);
  });

  it('returns minutes since savedAt', () => {
    const savedAt = Date.parse('2026-05-04T12:00:00Z');
    saveSnapshot(buildSnapshot({ savedAt }));
    const now = savedAt + 23 * 60_000;
    expect(snapshotAgeMinutes(now)).toBe(23);
  });

  it('returns a fractional value for sub-minute ages', () => {
    const savedAt = Date.parse('2026-05-04T12:00:00Z');
    saveSnapshot(buildSnapshot({ savedAt }));
    expect(snapshotAgeMinutes(savedAt + 30_000)).toBeCloseTo(0.5, 5);
  });
});
