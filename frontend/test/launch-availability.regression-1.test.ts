import { describe, expect, it } from 'vitest';
import { selectLaunches } from '../src/launch-selectors';
import { NOW, state, supported } from './launch-fixtures';

// Regression: ISSUE-003 - failed launch refresh retained immediate Queue slots.
// Found by /qa on 2026-09-07. Report: docs/launch-qa-2026-09-07.md.
describe('Queue requires a successful current launch refresh', () => {
  it.each(['last-good', 'offline', 'loading', 'unavailable'] as const)('%s preserves discovery, not Queue instructions', (availability) => {
    const snapshot = state([supported()], { availability });
    expect(selectLaunches(snapshot, NOW, 'queue')).toEqual([]);
    expect(selectLaunches(snapshot, NOW, 'map')).toHaveLength(1);
    expect(selectLaunches(snapshot, NOW, 'upcoming')).toHaveLength(1);
  });
  it('restores a Queue slot after successful refresh', () => {
    expect(selectLaunches(state([supported()], { availability: 'ready' }), NOW, 'queue')).toHaveLength(1);
  });
});
