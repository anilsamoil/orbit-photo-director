/**
 * Tests for frontend/src/photo-conditions.ts — the Photo Conditions
 * framework (Unit 1) + camera line.
 *
 * All math is imported from the real module — never re-implemented locally
 * (prior learning [contract-test-local-copies]). Anchor cases pin the
 * Pettit-guide cross-checks the plan documents:
 *   - footprint 400mm @ nadir/420km ≈ 38km (guide Fig. 23: 5.2° × 420km)
 *   - tracked floors (Z9-modernized 1.5/f): 400→1/640, 800→1/1250, 1200→1/2000
 *   - untracked physics floors @ nadir/420km: 400→1/1250, 800→1/2500, 1200→1/4000
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ALT_KM,
  KIT_FOCAL_LENGTHS_MM,
  MAX_VISIBLE_ROWS,
  SHUTTER_LADDER,
  buildConditionRows,
  cameraConditionProvider,
  footprintKm,
  renderConditionBlock,
  slantRangeKm,
  snapToFasterStop,
  trackedFloorSec,
  untrackedFloorSec,
  type ConditionCtx,
  type ConditionRow,
} from '../src/photo-conditions';
import type { PassEntry } from '../src/types';

function passWith(over: Partial<PassEntry> = {}): PassEntry {
  return {
    nadir_distance_km: 0,
    iss_at_closest: { lat: 0, lon: 0, alt_km: 420 },
    ...over,
  } as PassEntry;
}

function ctxWith(over: Partial<PassEntry> = {}): ConditionCtx {
  return { pass: passWith(over), manifest: null, nowMs: Date.parse('2026-06-11T12:00:00Z') };
}

describe('slantRangeKm (law of cosines — nadir distance is arc length)', () => {
  it('equals altitude at the nadir point', () => {
    expect(slantRangeKm(0, 420)).toBeCloseTo(420, 6);
  });

  it('matches the flat chord closely near nadir but exceeds it when oblique', () => {
    const flat = (n: number, a: number): number => Math.sqrt(a * a + n * n);
    // 100km ground distance: spherical ≈ flat within 0.2%.
    expect(slantRangeKm(100, 420) / flat(100, 420)).toBeCloseTo(1, 2);
    // 1500km ground distance: the chord geometry diverges measurably.
    const ratio = slantRangeKm(1500, 420) / flat(1500, 420);
    expect(ratio).not.toBeCloseTo(1, 3);
  });

  it('is monotonic in ground distance', () => {
    let prev = 0;
    for (const n of [0, 200, 500, 1000, 1500, 2000]) {
      const d = slantRangeKm(n, 420);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });
});

describe('shutter floors', () => {
  it('tracked floors hit the guide-validated stops: 400→640, 800→1250, 1200→2000', () => {
    expect(snapToFasterStop(trackedFloorSec(400))).toBe(640);
    expect(snapToFasterStop(trackedFloorSec(800))).toBe(1250);
    expect(snapToFasterStop(trackedFloorSec(1200))).toBe(2000);
  });

  it('untracked physics floors at nadir/420km: 400→1250, 800→2500, 1200→4000', () => {
    const d = slantRangeKm(0, 420);
    expect(snapToFasterStop(untrackedFloorSec(400, d))).toBe(1250);
    expect(snapToFasterStop(untrackedFloorSec(800, d))).toBe(2500);
    expect(snapToFasterStop(untrackedFloorSec(1200, d))).toBe(4000);
  });

  it('untracked floors RELAX (slower allowed) as slant range grows', () => {
    expect(untrackedFloorSec(400, 1500)).toBeGreaterThan(untrackedFloorSec(400, 420));
  });

  it('tracking buys about a stop at the kit lengths (documented claim)', () => {
    const d = slantRangeKm(0, 420);
    for (const f of KIT_FOCAL_LENGTHS_MM) {
      const ratio = trackedFloorSec(f) / untrackedFloorSec(f, d);
      expect(ratio).toBeGreaterThan(1.5); // at least ~2/3 stop
      expect(ratio).toBeLessThan(3); // under 1.6 stops
    }
  });
});

describe('snapToFasterStop (third-stop ladder)', () => {
  it('snaps DOWN (faster), never to the nearest stop', () => {
    // 1/1124 → 1/1250 even though 1/1000 is numerically nearer.
    expect(snapToFasterStop(1 / 1124)).toBe(1250);
  });

  it('an exact ladder stop stays put', () => {
    expect(snapToFasterStop(1 / 640)).toBe(640);
    expect(snapToFasterStop(1 / 8000)).toBe(8000);
  });

  it('clamps at both ladder ends', () => {
    expect(snapToFasterStop(10)).toBe(SHUTTER_LADDER[0]); // very slow floor → slowest stop
    expect(snapToFasterStop(1 / 20000)).toBe(8000); // beyond fastest → clamp
  });

  it('rejects garbage', () => {
    expect(snapToFasterStop(NaN)).toBeNull();
    expect(snapToFasterStop(0)).toBeNull();
    expect(snapToFasterStop(-1)).toBeNull();
  });
});

describe('footprintKm', () => {
  it('matches the guide FOV cross-check: 400mm @ nadir/420km ≈ 38km', () => {
    const d = slantRangeKm(0, 420);
    expect(footprintKm(400, d)).toBeGreaterThan(36);
    expect(footprintKm(400, d)).toBeLessThan(40);
  });

  it('halves with doubled focal length and widens with slant range', () => {
    expect(footprintKm(800, 420)).toBeCloseTo(footprintKm(400, 420) / 2, 6);
    expect(footprintKm(400, 1000)).toBeGreaterThan(footprintKm(400, 420));
  });
});

describe('cameraConditionProvider', () => {
  it('renders the kit trio with footprint + tracked floor per lens', () => {
    const row = cameraConditionProvider(ctxWith());
    expect(row).not.toBeNull();
    expect(row!.icon).toBe('📷');
    expect(row!.label).toBe('tracked floors · hand-track');
    expect(row!.value).toBe('400mm ≈38km ≥1/640 · 800mm ≈19km ≥1/1250 · 1200mm ≈13km ≥1/2000');
    expect(row!.almanacAnchor).toBe('almanac-camera');
  });

  it('widens footprints on an oblique pass (slant range grows)', () => {
    const row = cameraConditionProvider(ctxWith({ nadir_distance_km: 1000 }));
    const m = row!.value.match(/400mm ≈(\d+)km/);
    expect(Number(m![1])).toBeGreaterThan(38);
  });

  it('falls back to 420km altitude when the pass carries none', () => {
    const noAlt = cameraConditionProvider(
      ctxWith({ iss_at_closest: undefined as never }),
    );
    const withDefault = cameraConditionProvider(
      ctxWith({ iss_at_closest: { lat: 0, lon: 0, alt_km: DEFAULT_ALT_KM } }),
    );
    expect(noAlt!.value).toBe(withDefault!.value);
  });

  it('returns null (silence) on missing/NaN/negative nadir distance', () => {
    expect(cameraConditionProvider(ctxWith({ nadir_distance_km: NaN }))).toBeNull();
    expect(cameraConditionProvider(ctxWith({ nadir_distance_km: -5 }))).toBeNull();
    expect(
      cameraConditionProvider(ctxWith({ nadir_distance_km: undefined as never })),
    ).toBeNull();
  });
});

describe('buildConditionRows (provider isolation)', () => {
  it('a throwing provider loses its row, logs a warning, and never breaks the rest', async () => {
    const mod = await import('../src/photo-conditions');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = (): ConditionRow | null => {
      throw new Error('ephemeris exploded');
    };
    mod.PROVIDERS.unshift(boom);
    try {
      const rows = buildConditionRows(ctxWith());
      expect(rows).toHaveLength(1); // camera survived
      expect(rows[0]!.id).toBe('camera');
      expect(warn).toHaveBeenCalledOnce(); // NOT silent (Codex #11)
    } finally {
      mod.PROVIDERS.shift();
      warn.mockRestore();
    }
  });

  it('null providers are skipped without noise', () => {
    const rows = buildConditionRows(ctxWith({ nadir_distance_km: NaN }));
    expect(rows).toHaveLength(0);
  });
});

describe('renderConditionBlock', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
  });

  const fakeRow = (id: string): ConditionRow => ({
    id,
    icon: '✨',
    label: `label ${id}`,
    value: `value ${id}`,
    almanacAnchor: `anchor-${id}`,
  });

  it('zero rows → nothing at all, not even the divider (silence is a feature)', () => {
    renderConditionBlock([], host);
    expect(host.children).toHaveLength(0);
  });

  it('renders divider + rows as buttons; tap opens the almanac at the anchor', () => {
    const opened: string[] = [];
    renderConditionBlock([fakeRow('a')], host, (anchor) => opened.push(anchor));
    expect(host.querySelector('.photo-conditions-divider')).not.toBeNull();
    const btn = host.querySelector<HTMLButtonElement>('.photo-condition-row');
    expect(btn).not.toBeNull();
    expect(btn!.tagName).toBe('BUTTON'); // real button, not a span (Codex #5)
    btn!.click();
    expect(opened).toEqual(['anchor-a']);
  });

  it('caps visible rows at MAX_VISIBLE_ROWS with a "▸ N more" disclosure', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map(fakeRow);
    renderConditionBlock(rows, host, () => {});
    expect(host.querySelectorAll('.photo-condition-row')).toHaveLength(MAX_VISIBLE_ROWS);
    const more = host.querySelector<HTMLButtonElement>('.photo-conditions-more');
    expect(more!.textContent).toBe('▸ 2 more');
    more!.click();
    expect(host.querySelectorAll('.photo-condition-row')).toHaveLength(5);
    expect(host.querySelector('.photo-conditions-more')).toBeNull();
  });

  it('exactly MAX_VISIBLE_ROWS rows → no disclosure button', () => {
    renderConditionBlock(['a', 'b', 'c'].map(fakeRow), host, () => {});
    expect(host.querySelector('.photo-conditions-more')).toBeNull();
  });
});
