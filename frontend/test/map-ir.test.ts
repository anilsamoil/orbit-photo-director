/**
 * Feature C (live geo-IR overlay) invariants. Like map-night-lights.test.ts,
 * these grep the map.ts source for the load-bearing properties — the safest
 * way to pin map behavior without a full MapLibre mock. They lock the
 * design-review fixes (R1/R3/R5/R7/R9) so a refactor can't silently undo them.
 */
import { describe, expect, it } from 'vitest';

async function mapSrc(): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  return fs.readFile(path.resolve(__dirname, '../src/map.ts'), 'utf-8');
}

describe('Feature C — live IR overlay invariants', () => {
  it('geo-ir-layer ships visibility:none → zero tiles until toggled on (R5)', async () => {
    const src = await mapSrc();
    expect(src).toMatch(/id:\s*'geo-ir-layer'[\s\S]*?layout:\s*\{\s*visibility:\s*'none'\s*\}/);
  });

  it('basemap arbiter excludes IR — Esri only with no clouds AND no IR (R1)', async () => {
    const src = await mapSrc();
    expect(src).toMatch(/useEsri\s*=\s*!cloudsVisible\s*&&\s*!irVisible\s*&&\s*!esriTilesFailed/);
    expect(src).toMatch(/cloudsLayerVis\s*=\s*cloudsVisible\s*&&\s*!fcstActive\s*&&\s*!irVisible/);
  });

  it('IR badge carries the low-cloud caveat + no-coverage note (R3/R7/R9)', async () => {
    const src = await mapSrc();
    expect(src).toContain('misses low cloud');
    expect(src).toContain('no geostationary coverage here');
  });

  it('the no-coverage gap HIDES the raster (never blank/stale tiles) (R7)', async () => {
    const src = await mapSrc();
    expect(src).toMatch(/showRaster\s*=\s*irVisible\s*&&\s*currentGeoIRSat\s*!==\s*null/);
  });

  it('moveend re-pick is gated on irVisible → no tiles while off (R5)', async () => {
    const src = await mapSrc();
    expect(src).toMatch(/on\('moveend',[\s\S]*?if\s*\(!irVisible\)\s*return/);
  });

  it('toggles are mutually exclusive (IR on → clouds off, and vice versa)', async () => {
    const src = await mapSrc();
    expect(src).toMatch(/if\s*\(irVisible\s*&&\s*cloudsVisible\)\s*\{[\s\S]*?cloudsVisible\s*=\s*false/);
    expect(src).toMatch(/if\s*\(cloudsVisible\s*&&\s*irVisible\)\s*\{[\s\S]*?irVisible\s*=\s*false/);
  });

  it('IR ships OFF by default (pref reads false on miss)', async () => {
    const src = await mapSrc();
    expect(src).toMatch(/IR_PREF_KEY\s*=\s*'opd-map-ir-visible'/);
    const block = src.match(/function readIrVisible\(\)[\s\S]*?\n\}/);
    expect(block && block[0]).toMatch(/=== '1'/);
  });

  it('the IR button exists in index.html, off by default (no active class)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const html = await fs.readFile(path.resolve(__dirname, '../index.html'), 'utf-8');
    const btn = html.match(/<button id="toggle-ir"[^>]*>/);
    expect(btn).not.toBeNull();
    expect(btn && btn[0]).not.toMatch(/\bactive\b/); // off by default
  });

  it('IR refreshes on the 10-min frame rollover + a ticker, not just on pan (Codex #1)', async () => {
    const src = await mapSrc();
    expect(src).toMatch(/time !== currentGeoIRTime/); // time-based reset
    expect(src).toMatch(/setInterval\([\s\S]*?repickGeoIRForView\(\)/); // periodic advance
  });

  it('IR badge reads LIVE-now (not forecast) under a scrubbed view (Codex #2)', async () => {
    const src = await mapSrc();
    expect(src).toContain('LIVE now (not the scrubbed time)');
  });

  it('badge re-renders after the init IR re-pick (no false no-coverage flash) (Codex #3)', async () => {
    const src = await mapSrc();
    expect(src).toContain('false "no coverage" on first paint');
  });

  it('IR surfaces the frame age in the badge (Codex #1)', async () => {
    const src = await mapSrc();
    expect(src).toMatch(/formatImageryAge\(Date\.parse\(currentGeoIRTime\)/);
  });

  it('uses the source-aware tile URL so Meteosat (RealEarth) fills the gap', async () => {
    const src = await mapSrc();
    expect(src).toMatch(/setTiles\(\[geoIRTileUrl\(sat, time\)\]\)/);
  });

  it('badges RealEarth (Meteosat) freshness as "latest" (honest — no false age)', async () => {
    const src = await mapSrc();
    expect(src).toMatch(/source === 'realearth'\s*\?\s*'latest'/);
  });

  it('surfaces a feed outage ("feed unavailable") instead of fake clear-sky IR (Codex)', async () => {
    const src = await mapSrc();
    expect(src).toContain('feed unavailable');
    // idle with nothing loaded → feed down; a loaded tile clears it.
    expect(src).toMatch(/on\('idle',[\s\S]*?geoIrFeedDown\s*=\s*true/);
    expect(src).toMatch(/ev\.tile\?\.state === 'loaded'[\s\S]*?geoIrAnyLoaded\s*=\s*true/);
  });

  it('help + attribution name Meteosat (no stale GOES/Himawari-only claim)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const help = await fs.readFile(path.resolve(__dirname, '../src/help.ts'), 'utf-8');
    expect(help).toContain('GOES / Himawari / Meteosat');
    expect(help).not.toMatch(/blank over Europe\/Africa/);
    const src = await mapSrc();
    expect(src).toContain('SSEC RealEarth');
  });
});
