import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { insetTrackBounds } from '../src/insets/bounds';
import { boxesIntersect } from '../src/insets/collide';
import { INSET_MIN_HEIGHT_PX, INSET_MIN_WIDTH_PX, insetViewportFits } from '../src/insets/gate';

describe('inset viewport gate', () => {
  it('uses width 800 and height 600', () => {
    expect(INSET_MIN_WIDTH_PX).toBe(800);
    expect(INSET_MIN_HEIGHT_PX).toBe(600);
    expect(insetViewportFits(834, 1194)).toBe(true);
    expect(insetViewportFits(1194, 834)).toBe(true);
    expect(insetViewportFits(1194, 710)).toBe(true);
    expect(insetViewportFits(1194, 700)).toBe(true);
    expect(insetViewportFits(1280, 800)).toBe(true);
    expect(insetViewportFits(1280, 700)).toBe(true);
    expect(insetViewportFits(1400, 900)).toBe(true);
    expect(insetViewportFits(800, 600)).toBe(true);
    expect(insetViewportFits(874, 402)).toBe(false);
    expect(insetViewportFits(844, 390)).toBe(false);
    expect(insetViewportFits(932, 430)).toBe(false);
    expect(insetViewportFits(402, 874)).toBe(false);
    expect(insetViewportFits(390, 664)).toBe(false);
    expect(insetViewportFits(390, 844)).toBe(false);
    expect(insetViewportFits(799, 900)).toBe(false);
    expect(insetViewportFits(1280, 599)).toBe(false);
    expect(insetViewportFits(800, 599)).toBe(false);
  });

  it('matches the stylesheet media query and the host', () => {
    const css = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8');
    const host = readFileSync(resolve(__dirname, '../src/insets/host.ts'), 'utf8');
    const drive = readFileSync(resolve(__dirname, '../../.cursor/skills/verify-opd/scripts/drive.mjs'), 'utf8');
    const trackInset = readFileSync(resolve(__dirname, '../src/map/adapters/maplibre/track-inset.ts'), 'utf8');
    expect(css).toContain(`@media (min-width: ${INSET_MIN_WIDTH_PX}px) and (min-height: ${INSET_MIN_HEIGHT_PX}px)`);
    expect(css).toContain('#map-pane.map-chrome-hidden .pip-horizon');
    expect(css).toContain('--horizon-width: 222px');
    expect(css).toContain('--horizon-height: 144px');
    expect(css).toContain('--horizon-right: 12px');
    expect(css).toContain('--horizon-span: calc(var(--horizon-right) + var(--horizon-width) + var(--horizon-gap))');
    expect(css).toContain('bottom: calc(var(--map-command-bottom, 0px) + var(--map-command-height) + 36px)');
    expect(css).toContain('bottom: calc(var(--map-command-bottom) + var(--map-command-height) + 36px)');
    expect(css).toContain('max-width: calc(100% - var(--horizon-span))');
    expect(css).toContain('--map-command-height: calc(96px + env(safe-area-inset-bottom, 0px))');
    expect(css).not.toContain('right: 112px');
    expect(css).not.toContain('272px');
    expect(drive).toContain('#shotlist-bar');
    expect(drive).toContain('Math.abs(box.width - 222)');
    expect(drive).toContain('Math.abs(rightGap - 12)');
    expect(drive).toContain('#map-legend-panel');
    expect(drive).toContain('legendCentersMissInset');
    expect(css).toContain('grid-template-columns: minmax(300px, 36%) minmax(0, 1fr)');
    expect(trackInset).toContain('inset-labels');
    expect(trackInset).toContain('World_Boundaries_and_Places');
    expect(host).toContain('INSET_MIN_WIDTH_PX');
    expect(host).toContain('INSET_MIN_HEIGHT_PX');
    expect(host).not.toContain('min-height: 800px');
    expect(drive).toContain(`width >= ${INSET_MIN_WIDTH_PX} && height >= ${INSET_MIN_HEIGHT_PX}`);
  });
});

describe('inset collision', () => {
  it('treats separated boxes as clear and overlapping boxes as a hit', () => {
    const inset = { left: 1046, top: 524, right: 1268, bottom: 668 };
    const hide = { left: 1180, top: 720, right: 1268, bottom: 764 };
    const slider = { left: 8, top: 704, right: 1034, bottom: 800 };
    expect(boxesIntersect(inset, hide)).toBe(false);
    expect(boxesIntersect(inset, slider)).toBe(false);
    expect(boxesIntersect(inset, { left: 1100, top: 540, right: 1200, bottom: 600 })).toBe(true);
    expect(boxesIntersect(inset, { left: 1268, top: 524, right: 1300, bottom: 668 })).toBe(false);
  });
});

describe('inset track bounds', () => {
  it('drops world-shifted copies and keeps the live longitude', () => {
    const bounds = insetTrackBounds([
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[10, 20], [12, 22]] },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[370, 20], [372, 22]] },
      },
    ], { lon: 11, lat: 21 });
    expect(bounds).toEqual([[10, 20], [12, 22]]);
  });
});
