import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAP_IMPORT_RETRY_KEY,
  nextMapImportStep,
  noteMapImportSuccess,
  type MapImportFlagStore,
} from '../src/map-import';

const mapGate = vi.hoisted(() => ({
  mode: 'stale' as 'stale' | 'abort' | 'ok',
}));

vi.mock('../src/network-status', async () => {
  const actual = await vi.importActual<typeof import('../src/network-status')>('../src/network-status');
  return {
    ...actual,
    createPollScheduler: () => ({ stop() {} }),
  };
});

vi.mock('../src/profile-session', () => ({
  getAccountProfile: () => ({ name: 'anil', displayName: 'Anil', isVerified: true }),
  getSignedInAccountProfile: () => null,
  resolveAccountProfile: async () => ({ name: 'anil', displayName: 'Anil', isVerified: true }),
  SessionSignInRequired: class SessionSignInRequired extends Error {},
}));

vi.mock('../src/manifest', () => ({
  fetchManifest: vi.fn(async () => { throw new Error('manifest missing'); }),
  fetchTop5: vi.fn(async () => []),
  fetchTop24h: vi.fn(async () => []),
  fetchTrack: vi.fn(async () => { throw new Error('track missing'); }),
  fetchStatus: vi.fn(async () => null),
  fetchCupolaWindows: vi.fn(async () => []),
}));

vi.mock('../src/tile-precache', async () => {
  const actual = await vi.importActual<typeof import('../src/tile-precache')>('../src/tile-precache');
  return { ...actual, precacheTilesForTargets: vi.fn(), precacheWorldBaseTiles: vi.fn() };
});

vi.mock('../src/aurora', async () => {
  const actual = await vi.importActual<typeof import('../src/aurora')>('../src/aurora');
  return { ...actual, fetchKpData: vi.fn(async () => null), renderKpWidget: vi.fn(), initKpWidget: vi.fn() };
});

vi.mock('../src/map', () => {
  if (mapGate.mode === 'stale') {
    throw new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/map-stale.js');
  }
  if (mapGate.mode === 'abort') {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    throw error;
  }
  return {
    renderMap: vi.fn(async () => {}),
    resizeMap: vi.fn(),
    focusLaunchOnMap: vi.fn(() => false),
    applyDistanceThreshold: vi.fn(),
    dropLookupPin: vi.fn(),
    getSatelliteTopbarReadouts: vi.fn(() => []),
    applyFollowISS: vi.fn(),
  };
});

const DOM = `
  <header class="topbar">
    <div id="iss-now"></div>
    <button id="tab-queue" type="button"></button>
    <button id="tab-upcoming" type="button"></button>
    <button id="tab-map" class="tab active" type="button">Map</button>
    <button id="tab-iss" type="button"></button>
    <button id="tab-profile" type="button"></button>
    <button id="tab-log" type="button">Log<span id="pending-sync-badge" hidden></span></button>
    <button id="profile-badge" type="button" hidden></button>
  </header>
  <div id="profile-menu"></div>
  <div id="toast" hidden></div>
  <main id="view" class="view-map">
    <section id="queue-pane"><div id="cards"></div><div id="empty" hidden></div></section>
    <section id="upcoming-pane"><div id="upcoming-cards"></div><div id="upcoming-empty" hidden></div></section>
    <section id="map-pane"><div id="map"></div></section>
    <section id="iss-pane"><div id="iss-host"></div></section>
    <section id="profile-pane"><div id="profile-body"></div></section>
    <section id="log-pane"><div id="log-list"></div><div id="log-empty" hidden></div><div id="log-stats"></div></section>
  </main>
  <footer id="status-banner" class="banner banner-loading">Loading…</footer>
`;

function memoryStore(): MapImportFlagStore {
  const bag = new Map<string, string>();
  return {
    getItem: (key) => bag.get(key) ?? null,
    setItem: (key, value) => { bag.set(key, value); },
    removeItem: (key) => { bag.delete(key); },
  };
}

function seedSnapshot(): void {
  localStorage.setItem('opd-snapshot', JSON.stringify({
    manifest: {
      version: '20261007T120000Z',
      generated_at: new Date().toISOString(),
      tle_epoch: '2026-10-07T00:00:00Z',
      cloud_composite_hour: '2026-10-07T11:00:00Z',
      target_data_version: 'v1',
      build_version: '2.0.0.0',
      freshness: { tle_hours: 1, cloud_hours: 0, ok: true },
      artifacts: {},
    },
    top5: [],
    top_24h: [],
    track: {
      iss_polynomial: {
        start: new Date().toISOString(),
        duration_seconds: 7200,
        lat_coeffs: [0, 0, 0, 0, 0.01, 0],
        lon_coeffs: [0, 0, 0, 0, 0.04, 0],
        polynomial_order: 5,
      },
      tle_epoch: '2026-10-07T00:00:00Z',
      tle_age_hours: 1,
      tle_freshness_factor: 1,
    },
    status: null,
    savedAt: Date.now() - 30 * 60_000,
  }));
}

const staleError = new TypeError(
  'Failed to fetch dynamically imported module: http://localhost/assets/map-stale.js',
);

describe('map import recovery', () => {
  it('reloads once on the first stale chunk, shows the error if that retry fails, and does not reload again', async () => {
    const store = memoryStore();
    const href = 'http://localhost/?u=anil';
    const probe = vi.fn(async () => 404);
    const first = await nextMapImportStep(staleError, store, href, probe);
    expect(first).toEqual({
      action: 'reload-once',
      href: 'http://localhost/?u=anil&map-chunk=1',
    });
    expect(store.getItem(MAP_IMPORT_RETRY_KEY)).toBe('1');
    const second = await nextMapImportStep(staleError, store, href, probe);
    const third = await nextMapImportStep(staleError, store, href, probe);
    expect(second).toEqual({ action: 'show-error' });
    expect(third).toEqual({ action: 'show-error' });
    expect(store.getItem(MAP_IMPORT_RETRY_KEY)).toBe('1');
  });

  it('clears the retry flag after the map module loads, so a later stale chunk may reload once', async () => {
    const store = memoryStore();
    store.setItem(MAP_IMPORT_RETRY_KEY, '1');
    noteMapImportSuccess(store);
    expect(store.getItem(MAP_IMPORT_RETRY_KEY)).toBeNull();
    const again = await nextMapImportStep(
      staleError,
      store,
      'http://localhost/?u=anil',
      async () => 404,
    );
    expect(again.action).toBe('reload-once');
  });

  it('shows the error for an aborted load and for a chunk request that does not complete', async () => {
    const store = memoryStore();
    const aborted = new Error('The operation was aborted.');
    aborted.name = 'AbortError';
    const probe = vi.fn(async () => 404);
    expect(await nextMapImportStep(aborted, store, 'http://localhost/', probe)).toEqual({ action: 'show-error' });
    expect(probe).not.toHaveBeenCalled();
    expect(store.getItem(MAP_IMPORT_RETRY_KEY)).toBeNull();
    const dropped = await nextMapImportStep(staleError, store, 'http://localhost/?u=anil', async () => null);
    expect(dropped).toEqual({ action: 'show-error' });
    expect(store.getItem(MAP_IMPORT_RETRY_KEY)).toBeNull();
  });
});

beforeEach(() => {
  mapGate.mode = 'stale';
  document.body.innerHTML = DOM;
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('map-stale.js')) return new Response('missing', { status: 404 });
    return new Response('{"targets":[],"entries":[]}', { status: 200 });
  }));
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
  sessionStorage.clear();
});

describe('map pane when the chunk fails', () => {
  it('reloads once when the hashed chunk 404s', async () => {
    seedSnapshot();
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(String(replace.mock.calls[0]?.[0])).toContain('map-chunk=1');
    expect(sessionStorage.getItem(MAP_IMPORT_RETRY_KEY)).toBe('1');
    expect(document.getElementById('status-banner')?.textContent ?? '').not.toContain("Map couldn't load");
  });

  it('shows Map couldn\'t load and Retry when the stale chunk fails again', async () => {
    seedSnapshot();
    sessionStorage.setItem(MAP_IMPORT_RETRY_KEY, '1');
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(document.getElementById('status-banner')?.textContent).toContain("Map couldn't load");
    });
    const retry = document.querySelector('#status-banner button');
    expect(retry?.textContent).toBe('Retry');
    expect(replace).not.toHaveBeenCalled();
    const errors = vi.spyOn(console, 'error');
    const logged = errors.mock.calls.length;
    retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(errors.mock.calls.length).toBeGreaterThan(logged);
    });
    expect(document.getElementById('status-banner')?.textContent).toContain("Map couldn't load");
    expect(replace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(MAP_IMPORT_RETRY_KEY)).toBe('1');
  });

  it('shows the error for an aborted load without reloading', async () => {
    mapGate.mode = 'abort';
    seedSnapshot();
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(document.getElementById('status-banner')?.textContent).toContain("Map couldn't load");
    });
    expect(document.querySelector('#status-banner button')?.textContent).toBe('Retry');
    expect(replace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(MAP_IMPORT_RETRY_KEY)).toBeNull();
  });

  it('clears the retry flag when the map module loads', async () => {
    mapGate.mode = 'ok';
    seedSnapshot();
    sessionStorage.setItem(MAP_IMPORT_RETRY_KEY, '1');
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(sessionStorage.getItem(MAP_IMPORT_RETRY_KEY)).toBeNull();
    });
    expect(document.getElementById('status-banner')?.textContent ?? '').not.toContain("Map couldn't load");
    const map = await import('../src/map');
    expect(map.renderMap).toHaveBeenCalled();
  });
});
