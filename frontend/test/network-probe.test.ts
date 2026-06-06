/** Tests for network-probe.ts — the cache-busting connectivity probe that
 *  disambiguates "offline (LOS)" from "generator slow" when data is stale.
 *
 *  The probe exists because neither navigator.onLine (lies on iOS Airplane
 *  Mode) nor a successful fetchManifest (the SW serves stale cache) proves
 *  we're online. These tests pin: resolve→true, reject→false, abort→false,
 *  and the cache-buster + no-store request shape. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROBE_PATH, probeConnectivity } from '../src/network-probe';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('probeConnectivity', () => {
  it('returns true when the fetch resolves with a real status (online)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    expect(await probeConnectivity('/manifest.json')).toBe(true);
  });

  it('treats any real HTTP status as reachable, even 404/5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503 }));
    expect(await probeConnectivity('/manifest.json')).toBe(true);
  });

  it('returns false when the fetch rejects (network down / offline)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await probeConnectivity('/manifest.json')).toBe(false);
  });

  it('appends a cache-busting _probe query and requests cache:no-store', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await probeConnectivity();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^\/__opd_probe\?_probe=\d+$/);
    expect(opts.cache).toBe('no-store');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults to a dedicated path that matches NO Workbox route (cache-poison guard)', () => {
    // Regression: probing /manifest.json would let the SW cache the throwaway
    // ?_probe= response and (maxEntries:1) evict the real manifest entry,
    // eroding the offline fallback. The default path must not be manifest.json
    // nor a versioned-artifact / tile path.
    expect(PROBE_PATH).toBe('/__opd_probe');
    expect(PROBE_PATH).not.toContain('manifest');
    expect(PROBE_PATH).not.toMatch(/\/v\/|cartocdn|gibs/);
  });

  it('uses & as the separator when the URL already has a query', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await probeConnectivity('/x?a=1');
    expect(fetchMock.mock.calls[0][0]).toMatch(/^\/x\?a=1&_probe=\d+$/);
  });

  it('returns false when the probe times out (abort fires)', async () => {
    // fetch that never resolves until its signal aborts, then rejects.
    const fetchMock = vi.fn((_url: string, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await probeConnectivity('/manifest.json', 30)).toBe(false);
  });
});
