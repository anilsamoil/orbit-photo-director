import { afterEach, expect, it, vi } from 'vitest';
import { createVendorDouble } from '../../../../test/vendor-map-double';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';
import { lightning } from './index';
import { flashFeatures, observationLabel, parseLightningFeed } from './feed';

const now = Date.parse('2026-10-26T12:02:00Z');
const raw = {
  schema: 1, start: '2026-10-26T11:55:00Z', end: '2026-10-26T12:00:00Z',
  generated_at: '2026-10-26T12:01:00Z', radius_km: 5500,
  sectors: [
    { satellite: 'GOES-19', center_lon: -75.2, cells: [[-80, 4, 200, 3]] },
    { satellite: 'GOES-18', center_lon: -137, cells: [] },
  ],
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('labels each sector, outside coverage, and a fresh or stale interval', () => {
  const feed = parseLightningFeed(raw, now);
  expect(observationLabel(feed, now, [-95, 4])).toContain('3 observed flashes · 11:55–12:00 UTC · feed 2m old');
  expect(observationLabel(feed, now, [-140, 0])).toContain('0 observed flashes');
  expect(observationLabel(feed, now, [60, 0])).toContain('outside GLM coverage');
  expect(observationLabel(feed, now + 360_000, [-95, 4])).toContain('stale');
  feed.sectors[0]!.cells = null;
  expect(observationLabel(feed, now, [-95, 4])).toContain('GOES-19 sector · unavailable');
});

it('rejects an over-cap, future, repeated-sector or malformed artifact', () => {
  for (const cells of [Array(513).fill([0, 0, 1, 1]), [[0, 0, -1, 1]], [[0, 0, 300, 1]]]) {
    expect(() => parseLightningFeed({ ...raw, sectors: [{ ...raw.sectors[0], cells }, raw.sectors[1]] }, now)).toThrow();
  }
  expect(() => parseLightningFeed({ ...raw, sectors: [raw.sectors[0], raw.sectors[0]] }, now)).toThrow();
  expect(() => parseLightningFeed(raw, now - 300_000)).toThrow();
  const feed = parseLightningFeed(raw, now);
  expect(flashFeatures(feed, now).features[0]?.properties?.ageSeconds).toBe(220);
});

it('fetches only on enable, paints below the ISS, hides on scrub and expires across failed refreshes', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(raw)).mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  document.body.innerHTML = '<button id="toggle-lightning"></button><div id="lightning-status" hidden></div>';
  const button = document.getElementById('toggle-lightning')!;
  const status = document.getElementById('lightning-status')!;
  const vendor = createVendorDouble({
    layers: [{ id: 'iss-track-layer', type: 'line', source: 'iss-track' }],
  });
  const clock = createClock();
  lightning.mount(createMapCore(vendor, clock));
  expect(fetcher).not.toHaveBeenCalled();
  button.click();
  await vi.advanceTimersByTimeAsync(1);
  expect(vendor.paintedLayers()).toEqual(['lightning-layer', 'iss-track-layer']);
  clock.setViewTime({ kind: 'scrubbed', atMs: now + 3_600_000 });
  expect(vendor.visibilityOf('lightning-layer')).toBe('none');
  expect(status.textContent).toContain('hidden at scrubbed time');
  clock.setViewTime({ kind: 'live' });
  expect(vendor.visibilityOf('lightning-layer')).toBe('visible');
  await vi.advanceTimersByTimeAsync(360_000);
  expect(status.textContent).toContain('stale');
  expect(status.textContent).toContain('refresh unavailable');
  expect(vendor.visibilityOf('lightning-layer')).toBe('none');
  button.click();
  expect(status.hidden).toBe(true);
  const calls = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(600_000);
  expect(fetcher).toHaveBeenCalledTimes(calls);
});

it('shows an unavailable feed when the publisher has never run', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
  document.body.innerHTML = '<button id="toggle-lightning"></button><div id="lightning-status" hidden></div>';
  lightning.mount(createMapCore(createVendorDouble({}), createClock()));
  document.getElementById('toggle-lightning')!.click();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.getElementById('lightning-status')?.textContent).toContain('Feed unavailable');
});
