import { describe, expect, it } from 'vitest';

import { parseLaunchArtifact } from '../src/launch-schema';
import { selectLaunches } from '../src/launch-selectors';
import { selectAllLaunches } from '../src/iss-view/launches';
import { artifact } from './launch-fixtures';
import type { LaunchState } from '../src/launch-store';

import censusRaw from './fixtures/g1-census-artifact.json' with { type: 'json' };

const NOW = Date.parse('2026-10-06T07:22:53Z');
const G1_NAMES = [
  'Nuri | NeonSat-2 to 6',
  'Falcon 9 Block 5 | SDA Tranche 1 Transport Layer A',
  'Long March 12 | Unknown Payload',
  'Falcon 9 Block 5 | Starlink Group 15-25',
  'Falcon 9 Block 5 | Dragon CRS-2 SpX-35',
  'Falcon 9 Block 5 | USSF-xxx ("TH-2")',
  'H3-24 | Martian Moon eXplorer (MMX)',
];

describe('g1 census', () => {
  it('parses the current v2 artifact and the producer artifact', () => {
    expect(parseLaunchArtifact(artifact()).schema_version).toBe(2);
    expect(parseLaunchArtifact(censusRaw).items).toHaveLength(9);
    expect(() => parseLaunchArtifact({ ...artifact(), extra: true })).toThrow(/Invalid launch schema/);
  });

  it('puts the seven schedule launches in All launches and none on the map or Upcoming', () => {
    const parsed = parseLaunchArtifact(censusRaw);
    const state: LaunchState = { artifact: parsed, pointer: null, availability: 'ready' };
    expect(selectAllLaunches(state, NOW).map((selection) => selection.item.name)).toEqual(G1_NAMES);
    expect(selectLaunches(state, NOW, 'map')).toEqual([]);
    expect(selectLaunches(state, NOW, 'upcoming')).toEqual([]);
    expect(selectAllLaunches(state, NOW).every((selection) => selection.item.trajectory.source === null)).toBe(true);
  });

  it('keeps a coarse row out of All launches', () => {
    const parsed = parseLaunchArtifact(censusRaw);
    const state: LaunchState = { artifact: parsed, pointer: null, availability: 'ready' };
    const names = selectAllLaunches(state, NOW).map((selection) => selection.item.name);
    expect(names).not.toContain('synthetic: year placeholder');
    expect(names).not.toContain('synthetic: day precision');
  });
});
