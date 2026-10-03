import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyTargetFilter,
  getQueueFilter,
  getTargetFilter,
  isPersonalPass,
  setQueueFilter,
  setTargetFilter,
} from '../src/target-filter-pref';

beforeEach(() => {
  localStorage.clear();
});

describe('getTargetFilter / setTargetFilter', () => {
  it('defaults to "all" on first visit', () => {
    expect(getTargetFilter()).toBe('all');
  });

  it('round-trips "mine" through localStorage', () => {
    setTargetFilter('mine');
    expect(getTargetFilter()).toBe('mine');
  });

  it('round-trips back to "all"', () => {
    setTargetFilter('mine');
    setTargetFilter('all');
    expect(getTargetFilter()).toBe('all');
  });

  it('treats any unrecognized stored value as "all"', () => {
    localStorage.setItem('opd_target_filter_v1', 'garbage');
    expect(getTargetFilter()).toBe('all');
  });
});

describe('getQueueFilter / setQueueFilter', () => {
  it('defaults to "all"', () => {
    expect(getQueueFilter()).toBe('all');
  });

  it('follows a saved Mine choice when the queue has no choice of its own', () => {
    setTargetFilter('mine');
    expect(getQueueFilter()).toBe('mine');
  });

  it('round-trips launches without replacing the shared target filter', () => {
    setTargetFilter('mine');
    setQueueFilter('launches');
    expect(getQueueFilter()).toBe('launches');
    expect(getTargetFilter()).toBe('mine');
  });

  it('writes All and Mine through to the shared target filter', () => {
    setQueueFilter('launches');
    setQueueFilter('mine');
    expect(getQueueFilter()).toBe('mine');
    expect(getTargetFilter()).toBe('mine');
    setQueueFilter('all');
    expect(getTargetFilter()).toBe('all');
  });

  it('treats an unrecognized queue value as the shared target filter', () => {
    localStorage.setItem('opd_queue_filter_v1', 'garbage');
    setTargetFilter('mine');
    expect(getQueueFilter()).toBe('mine');
  });
});

describe('isPersonalPass', () => {
  it('is true for a personal: target_id', () => {
    expect(isPersonalPass({ target_id: 'personal:jack:abc123' })).toBe(true);
  });

  it('is false for a curated kebab-case id', () => {
    expect(isPersonalPass({ target_id: 'starbase-boca-chica' })).toBe(false);
  });

  it('is false when target_id is missing or non-string', () => {
    expect(isPersonalPass({})).toBe(false);
    expect(isPersonalPass({ target_id: undefined })).toBe(false);
  });
});

describe('applyTargetFilter', () => {
  const passes = [
    { target_id: 'personal:jack:aaa', target_name: 'Home' },
    { target_id: 'starbase-boca-chica', target_name: 'Starbase' },
    { target_id: 'personal:jack:bbb', target_name: 'Cabin' },
  ];

  it('returns everything unchanged for "all"', () => {
    expect(applyTargetFilter(passes, 'all')).toEqual(passes);
  });

  it('keeps only personal targets for "mine"', () => {
    const mine = applyTargetFilter(passes, 'mine');
    expect(mine).toHaveLength(2);
    expect(mine.every((p) => p.target_id.startsWith('personal:'))).toBe(true);
  });

  it('returns an empty array for "mine" when there are no personal targets', () => {
    const curatedOnly = [{ target_id: 'ottawa' }, { target_id: 'denali' }];
    expect(applyTargetFilter(curatedOnly, 'mine')).toEqual([]);
  });
});
