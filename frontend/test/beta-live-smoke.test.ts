/** LIVE-DATA smoke (not committed as a permanent fixture-free test —
 *  uses the generator's current track.json when present, skips cleanly
 *  otherwise). Prints the 14-day forecast for eyeball verification. */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { scanBetaForecast } from '../src/beta-angle';
import type { Track } from '../src/types';

describe('beta forecast — live TLE smoke', () => {
  it('produces a plausible 14-day forecast from the real current TLE', () => {
    let track: Track;
    try {
      const vdir = '/Users/astroanil/orbit-photo-director/out/v';
      const latest = readdirSync(vdir).sort().at(-1)!;
      track = JSON.parse(readFileSync(`${vdir}/${latest}/track.json`, 'utf8'));
    } catch {
      console.warn('live track unavailable — skipping');
      return;
    }
    const fc = scanBetaForecast(track, Date.now());
    expect(fc).not.toBeNull();
    for (const d of fc!.days) {
      const date = new Date(d.dayStartMs).toISOString().slice(0, 10);
      console.log(`${date}  β=${d.betaDeg.toFixed(1).padStart(6)}°  night=${d.nightMin.toFixed(1)}min`);
      expect(Math.abs(d.betaDeg)).toBeLessThan(75.6);
      expect(d.nightMin).toBeGreaterThanOrEqual(0);
      expect(d.nightMin).toBeLessThanOrEqual(40);
    }
    console.log('windows:', JSON.stringify(fc!.windows));
  });
});
