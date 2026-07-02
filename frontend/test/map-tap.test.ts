/**
 * Tests for pickTargetAtTap — the unified tap hit-test that fixes Jack's
 * "works sometimes but not always". Pins three invariants:
 *   - merge-dedup: a personal target that ALSO has a pass (one id, two layers)
 *     resolves to ONE hit whose props carry BOTH the pass data and is_personal
 *     (review R1/R2);
 *   - nearest-to-tap: when the bbox catches two DIFFERENT targets, the nearest
 *     pin wins (review R10/R16);
 *   - empty: nothing point-like under the tap → null (handler returns, other
 *     handlers run — review R11).
 */
import { describe, it, expect } from 'vitest';
import { pickTargetAtTap } from '../src/map';

// Identity-ish projector: pin lng/lat map straight to screen x/y for the test.
const project = (ll: [number, number]): { x: number; y: number } => ({ x: ll[0], y: ll[1] });
const feat = (
  coords: [number, number],
  properties: Record<string, unknown>,
): { properties: Record<string, unknown>; geometry: { type: string; coordinates: number[] } } => ({
  properties,
  geometry: { type: 'Point', coordinates: coords },
});

describe('pickTargetAtTap', () => {
  it('returns null when nothing point-like was hit', () => {
    expect(pickTargetAtTap([], { x: 0, y: 0 }, project)).toBeNull();
    const line = { properties: { target_id: 'x' }, geometry: { type: 'LineString', coordinates: [0, 0] } };
    expect(pickTargetAtTap([line], { x: 0, y: 0 }, project)).toBeNull();
  });

  it('merge-dedups a personal-target-with-a-pass across both layers into one hit', () => {
    // Same target_id in BOTH sources: targets (pass data) + my-targets (ring).
    const fromTargets = feat([10, 10], {
      target_id: 'personal:default:gw',
      target_name: 'Great Wall',
      has_pass: true,
      score: 72,
      closest_approach: '2024-10-17T18:00:00Z',
      cloud_fraction: 20,
    });
    const fromMyTargets = feat([10, 10], {
      target_id: 'personal:default:gw',
      target_name: 'Great Wall',
      has_pass: false,
      is_personal: true,
      priority: 3,
    });
    const hit = pickTargetAtTap([fromMyTargets, fromTargets], { x: 10, y: 10 }, project);
    expect(hit).not.toBeNull();
    // Union: pass data survives, is_personal derived from the ring feature,
    // has_pass derived from the targets feature (NOT the ring's false).
    expect(hit!.props.has_pass).toBe(true);
    expect(hit!.props.is_personal).toBe(true);
    expect(hit!.props.score).toBe(72);
    expect(hit!.props.priority).toBe(3);
    expect(hit!.props.closest_approach).toBe('2024-10-17T18:00:00Z');
    expect(hit!.lngLat).toEqual([10, 10]);
  });

  it('treats a personal:-prefixed id as personal even if only the pass layer was hit', () => {
    const only = feat([5, 5], { target_id: 'personal:default:typo', has_pass: true, score: 10 });
    const hit = pickTargetAtTap([only], { x: 5, y: 5 }, project);
    expect(hit!.props.is_personal).toBe(true);
  });

  it('curated (non-personal) target stays non-personal — no Edit affordance', () => {
    const curated = feat([5, 5], { target_id: 'pettit:tokyo', has_pass: true, score: 80 });
    const hit = pickTargetAtTap([curated], { x: 5, y: 5 }, project);
    expect(hit!.props.is_personal).toBe(false);
    expect(hit!.props.has_pass).toBe(true);
  });

  it('nearest pin wins when the bbox catches two DIFFERENT targets', () => {
    const near = feat([11, 10], { target_id: 'A', target_name: 'Near', has_pass: true, score: 1 });
    const far = feat([16, 10], { target_id: 'B', target_name: 'Far', has_pass: true, score: 2 });
    const hit = pickTargetAtTap([far, near], { x: 10, y: 10 }, project);
    expect(hit!.props.target_id).toBe('A');
    expect(hit!.props.target_name).toBe('Near');
  });

  it('does not pull a second target\'s props into the winner (group is per-id)', () => {
    const winner = feat([10, 10], { target_id: 'A', has_pass: true, score: 1 });
    const other = feat([13, 10], { target_id: 'B', has_pass: false, is_personal: true, priority: 9 });
    const hit = pickTargetAtTap([winner, other], { x: 10, y: 10 }, project);
    expect(hit!.props.target_id).toBe('A');
    expect(hit!.props.is_personal).toBe(false); // B's is_personal must NOT leak in
    expect(hit!.props.priority).toBeUndefined();
  });
});
