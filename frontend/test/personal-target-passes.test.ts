import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTargetPopupContent, type TargetPopupProps } from '../src/map';
import type { Track } from '../src/types';

const NOW = Date.parse('2024-10-17T12:00:00Z');
const track = {
  tle: {
    line1: '1 25544U 98067A   24291.00000000  .00018000  00000-0  32500-3 0  9999',
    line2: '2 25544  51.6400  60.0000 0006000  90.0000 270.0000 15.50000000400000',
  },
  tle_epoch: '2024-10-17T00:00:00.000Z', tle_age_hours: 12,
} as Track;
const personal: TargetPopupProps = {
  target_id: 'personal:acct-new:tuvalu', target_name: 'Tuvalu',
  lat: -8.52, lon: 179.2, is_personal: true, has_pass: false,
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('saved-target pass lookup for accounts without generated artifacts', () => {
  it('offers real local next-pass predictions without claiming missing artifacts mean no passes', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const body = buildTargetPopupContent(personal, NOW, undefined, track);
    expect(body.textContent).not.toContain('No upcoming pass');
    const button = body.querySelector<HTMLButtonElement>('.map-popup-next-passes');
    expect(button?.textContent).toBe('Next ISS passes');
    button!.click();
    await vi.runAllTimersAsync();
    expect(body.textContent).toContain('ISS — next');
    expect(body.textContent).toContain('Geometric estimate');
    expect(body.textContent).toContain('clouds and window obstructions are not included');
    expect(body.querySelector('.map-popup-score')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves scored generated predictions when they exist', () => {
    const body = buildTargetPopupContent({ ...personal, has_pass: true, score: 74, closest_approach: '2024-10-17T13:00:00Z' }, NOW, undefined, track);
    expect(body.querySelector('.map-popup-score')?.textContent).toBe('score 74');
    expect(body.querySelector('.map-popup-next-passes')).toBeNull();
  });

  it('distinguishes unusable orbit data from a computed no-pass result', async () => {
    const body = buildTargetPopupContent(personal, NOW, undefined, { ...track, tle: undefined });
    body.querySelector<HTMLButtonElement>('.map-popup-next-passes')!.click();
    await vi.runAllTimersAsync();
    expect(body.textContent).toContain('Orbit data is unavailable');
    expect(body.textContent).not.toContain('No ISS passes');
  });

  it('reports a computed empty horizon and warns when cached orbit data is stale', async () => {
    vi.setSystemTime(NOW + 3 * 86_400_000);
    const body = buildTargetPopupContent({ ...personal, lat: 90, lon: 0 }, Date.now(), undefined, track);
    body.querySelector<HTMLButtonElement>('.map-popup-next-passes')!.click();
    await vi.runAllTimersAsync();
    expect(body.textContent).toContain('No ISS passes within 1500 km in the next 36 hours');
    expect(body.textContent).toContain('Orbit data is');
    expect(body.textContent).toContain('hours old');
  });
});
