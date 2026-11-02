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

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function mountFeed(at = now) {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  const fetcher = vi.fn().mockResolvedValue(Response.json(raw));
  vi.stubGlobal('fetch', fetcher);
  document.body.innerHTML = '<button id="toggle-lightning"></button><div id="lightning-status" hidden></div>';
  const vendor = createVendorDouble({});
  const clock = createClock();
  lightning.mount(createMapCore(vendor, clock));
  return {
    vendor, clock, fetcher,
    button: document.getElementById('toggle-lightning')!,
    status: document.getElementById('lightning-status')!,
  };
}

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

it.each([false, true])('hides cached observations after a backward clock change, previously expired %s', async expired => {
  const { button, vendor, status } = mountFeed();
  button.click();
  await vi.advanceTimersByTimeAsync(1);
  if (expired) await vi.advanceTimersByTimeAsync(390_000);
  vi.setSystemTime(Date.parse(raw.end) - 60_000);
  vendor.fire('moveend', {});
  expect(vendor.visibilityOf('lightning-layer')).toBe('none');
  expect(status.textContent).toContain('ahead of clock');
  expect(status.textContent).not.toContain('feed -');
});

it('expires at the observation deadline between periodic ticks', async () => {
  const { button, vendor, status } = mountFeed(Date.parse(raw.end) + 479_000);
  button.click();
  await vi.advanceTimersByTimeAsync(999);
  expect(vendor.visibilityOf('lightning-layer')).toBe('visible');
  await vi.advanceTimersByTimeAsync(1);
  expect(vendor.visibilityOf('lightning-layer')).toBe('none');
  expect(status.textContent).toContain('stale');
});

it.each(['visibilitychange', 'pageshow'])('rechecks cached expiry on %s after a suspended page resumes', async event => {
  const { button, vendor } = mountFeed();
  button.click();
  await vi.advanceTimersByTimeAsync(1);
  vi.setSystemTime(Date.parse(raw.end) + 480_000);
  (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
  expect(vendor.visibilityOf('lightning-layer')).toBe('none');
});

it('does not upload data or replace unchanged status on camera moves within an age bucket', async () => {
  const { button, vendor, status } = mountFeed();
  button.click();
  await vi.advanceTimersByTimeAsync(1);
  const setData = vi.spyOn(vendor, 'setGeoJson');
  const observer = new MutationObserver(() => {});
  observer.observe(status, { childList: true });
  for (let i = 0; i < 60; i++) vendor.fire('moveend', {});
  expect(setData).toHaveBeenCalledTimes(0);
  expect(observer.takeRecords()).toHaveLength(0);
  vendor.setCenter([-140, 0]);
  vendor.fire('moveend', {});
  expect(status.textContent).toContain('GOES-18 sector · 0 observed flashes');
  expect(setData).toHaveBeenCalledTimes(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(setData).toHaveBeenCalledTimes(1);
  observer.disconnect();
});

it('ignores a prior loading request after the overlay is toggled off and back on', async () => {
  const { button, vendor, status, fetcher } = mountFeed();
  const oldRequest = Promise.withResolvers<Response>();
  const newRequest = Promise.withResolvers<Response>();
  fetcher.mockReset().mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  button.click();
  const oldSignal = fetcher.mock.calls[0]?.[1]?.signal;
  button.click();
  expect(oldSignal.aborted).toBe(true);
  button.click();
  newRequest.resolve(Response.json(raw));
  await vi.advanceTimersByTimeAsync(1);
  expect(vendor.visibilityOf('lightning-layer')).toBe('visible');
  const accepted = status.textContent;
  oldRequest.resolve(new Response('', { status: 404 }));
  await vi.advanceTimersByTimeAsync(1);
  expect(status.textContent).toBe(accepted);
  expect(vendor.visibilityOf('lightning-layer')).toBe('visible');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
