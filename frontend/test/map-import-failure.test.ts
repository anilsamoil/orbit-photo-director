import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bannerAuthExpired } from '../src/banner';
import {
  MAP_IMPORT_RETRY_KEY,
  MAP_IMPORT_URL_KEY,
  MAP_IMPORT_VIEW_KEY,
  chunkProbeUrl,
  isMapLibreVendorUrl,
  mapModuleFromViteDeps,
  nextMapImportStep,
  noteMapImportSuccess,
  readChunkStatus,
  rememberedViewId,
  retryMapHref,
  retryMapModuleUrl,
  stripMapImportParams,
  type MapImportFlagStore,
} from '../src/map-import';

const mapGate = vi.hoisted(() => ({
  mode: 'stale' as 'stale' | 'abort' | 'ok' | 'webkit' | 'delay' | 'delay-stale',
  evaluations: 0,
  wait: null as Promise<void> | null,
  release: () => {},
  arm() {
    this.wait = new Promise<void>((resolveWait) => {
      this.release = resolveWait;
    });
  },
}));

const net = vi.hoisted(() => ({
  chunkStatus: 404,
  hang: false,
}));

const VITE_DEPS = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/index-ENTRY.js","assets/iss-view-X.js","assets/maplibre-vendor-V.js","assets/maplibre-vendor-V.css","assets/satellites-S.js","assets/index-MAP.js"])))=>i.map(i=>d[i]);
__vite__mapDeps([0,1,2,3])
__vite__mapDeps([5,1,2,3,4])`;

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
  mapGate.evaluations += 1;
  if (mapGate.mode === 'delay' || mapGate.mode === 'delay-stale') {
    return (mapGate.wait ?? Promise.resolve()).then(() => {
      if (mapGate.mode === 'delay-stale') {
        throw new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/map-stale.js');
      }
      throw new TypeError('Importing a module script failed.');
    });
  }
  if (mapGate.mode === 'stale') {
    throw new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/map-stale.js');
  }
  if (mapGate.mode === 'webkit') {
    throw new TypeError('Importing a module script failed.');
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
    <nav class="tabs" aria-label="Views">
      <button id="tab-queue" class="tab" type="button">Queue</button>
      <button id="tab-upcoming" class="tab" type="button">Upcoming</button>
      <button id="tab-map" class="tab active" type="button">Map</button>
      <button id="tab-iss" class="tab" type="button">ISS view</button>
      <button id="tab-profile" class="tab" type="button">Profile</button>
      <button id="tab-log" class="tab" type="button">Log<span id="pending-sync-badge" hidden></span></button>
    </nav>
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

type IntervalId = ReturnType<typeof window.setInterval>;

const intervals: IntervalId[] = [];

function resetCachedMapModule(): void {
  const worker = (globalThis as { __vitest_worker__?: { moduleCache?: ModuleCache } }).__vitest_worker__;
  const cache = worker?.moduleCache;
  if (!cache) return;
  for (const [path, mod] of cache) {
    if (String(path).startsWith('mock:')) cache.invalidateModule(mod);
  }
}

interface ModuleCache extends Iterable<[unknown, object]> {
  invalidateModule(mod: object): void;
}

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

function emptyScript(name: string, responseStatus?: number) {
  return {
    name,
    entryType: 'resource',
    initiatorType: 'script',
    responseStatus,
    transferSize: 0,
    encodedBodySize: 0,
    decodedBodySize: 0,
  };
}

function stubResources(entries: ReturnType<typeof emptyScript>[]): void {
  vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) => {
    if (type !== 'resource') return [];
    return entries as unknown as PerformanceEntryList;
  });
}

const staleError = new TypeError(
  'Failed to fetch dynamically imported module: http://localhost/assets/map-stale.js',
);
const webkitError = new TypeError('Importing a module script failed.');

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
    store.setItem(MAP_IMPORT_URL_KEY, 'http://localhost/assets/map-stale.js');
    noteMapImportSuccess(store);
    expect(store.getItem(MAP_IMPORT_RETRY_KEY)).toBeNull();
    expect(store.getItem(MAP_IMPORT_URL_KEY)).toBeNull();
    const again = await nextMapImportStep(
      staleError,
      store,
      'http://localhost/?u=anil',
      async () => 404,
    );
    expect(again.action).toBe('reload-once');
  });

  it('shows the error when the retry flag does not stick', async () => {
    const store: MapImportFlagStore = {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    };
    const action = await nextMapImportStep(staleError, store, 'http://localhost/?u=anil', async () => 404);
    expect(action).toEqual({ action: 'show-error' });
  });

  it('rejects when storing the retry flag throws', async () => {
    const store: MapImportFlagStore = {
      getItem: () => null,
      setItem() { throw new Error('quota'); },
      removeItem() {},
    };
    await expect(nextMapImportStep(staleError, store, 'http://localhost/?u=anil', async () => 404)).rejects.toThrow('quota');
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

  it('reloads a WebKit failure with no URL only when the probe says the chunk is missing', async () => {
    const store = memoryStore();
    const probe = vi.fn(async () => 404);
    const action = await nextMapImportStep(webkitError, store, 'http://localhost/?u=anil', probe);
    expect(probe).toHaveBeenCalledWith(null);
    expect(action).toEqual({
      action: 'reload-once',
      href: 'http://localhost/?u=anil&map-chunk=1',
    });
  });

  it('shows the error for a WebKit failure when the probe is null, 500, or 200', async () => {
    for (const status of [null, 500, 200]) {
      const store = memoryStore();
      const probe = vi.fn(async () => status);
      const action = await nextMapImportStep(webkitError, store, 'http://localhost/?u=anil', probe);
      expect(probe).toHaveBeenCalledWith(null);
      expect(action).toEqual({ action: 'show-error' });
      expect(store.getItem(MAP_IMPORT_RETRY_KEY)).toBeNull();
    }
  });

  it('adds a document cache-bust nonce and the same nonce on the stored chunk URL', () => {
    expect(retryMapHref('http://localhost/?e2e', '17')).toBe('http://localhost/?e2e=&map-retry=17');
    expect(retryMapHref('http://localhost/?u=anil&map-chunk=1', '42')).toBe(
      'http://localhost/?u=anil&map-chunk=1&map-retry=42',
    );
    expect(retryMapModuleUrl('http://127.0.0.1:45175/assets/index-D1lI8Fx4.js', '9')).toBe(
      'http://127.0.0.1:45175/assets/index-D1lI8Fx4.js?map-retry=9',
    );
  });

  it('ignores a renamed retry key', async () => {
    expect(MAP_IMPORT_RETRY_KEY).toBe('opd-map-import-retry');
    expect(MAP_IMPORT_URL_KEY).toBe('opd-map-import-url');
    expect(MAP_IMPORT_VIEW_KEY).toBe('opd-map-import-view');
    const store = memoryStore();
    store.setItem('opd-map-import-retry-renamed', '1');
    const action = await nextMapImportStep(staleError, store, 'http://localhost/?u=anil', async () => 404);
    expect(action.action).toBe('reload-once');
    expect(store.getItem('opd-map-import-retry-renamed')).toBe('1');
    expect(store.getItem(MAP_IMPORT_RETRY_KEY)).toBe('1');
  });

  it('strips map-chunk and map-retry and keeps the rest of the query', () => {
    expect(stripMapImportParams('http://localhost/?e2e=&u=anil&map-chunk=1&map-retry=9')).toBe(
      'http://localhost/?e2e=&u=anil',
    );
  });

  it('does not treat the MapLibre vendor chunk as the map module', () => {
    expect(isMapLibreVendorUrl('http://localhost/assets/maplibre-vendor-V.js')).toBe(true);
    expect(isMapLibreVendorUrl('http://localhost/assets/maplibre-gl-worker-W.js')).toBe(true);
    expect(isMapLibreVendorUrl('http://localhost/assets/index-MAP.js')).toBe(false);
    expect(mapModuleFromViteDeps(VITE_DEPS)).toEqual({
      script: 'assets/index-MAP.js',
      stylesheets: ['assets/maplibre-vendor-V.css'],
    });
  });

  it('returns null when the chunk probe never answers', async () => {
    net.hang = true;
    const result = await readChunkStatus('http://localhost/assets/map-stale.js', 30, 'probe');
    expect(result).toBeNull();
  });

  it('asks for the chunk with a query the service worker precache does not ignore', () => {
    expect(chunkProbeUrl('http://localhost/assets/index-MAP.js', 'probe')).toBe(
      'http://localhost/assets/index-MAP.js?map-probe=probe',
    );
    expect(rememberedViewId('tab-queue')).toBe('tab-queue');
    expect(rememberedViewId('tab-iss')).toBe('tab-iss');
    expect(rememberedViewId('tab-map')).toBeNull();
  });
});

beforeEach(() => {
  mapGate.mode = 'stale';
  mapGate.evaluations = 0;
  mapGate.arm();
  net.chunkStatus = 404;
  net.hang = false;
  document.body.innerHTML = DOM;
  vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) => {
    if (type !== 'resource') return [];
    return [] as unknown as PerformanceEntryList;
  });
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
  resetCachedMapModule();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/assets/index-ENTRY.js')) return new Response(VITE_DEPS, { status: 200 });
    if (net.hang && (url.includes('map-stale.js') || url.includes('map-probe='))) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if (url.includes('map-stale.js') || url.includes('maplibre-vendor')) {
      return new Response('missing', { status: net.chunkStatus });
    }
    return new Response('{"targets":[],"entries":[]}', { status: 200 });
  }));
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  const realSetInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = realSetInterval(handler, timeout, ...args);
    intervals.push(id as unknown as IntervalId);
    return id;
  }) as typeof window.setInterval);
});

afterEach(() => {
  mapGate.release();
  document.head.querySelectorAll('script[src*="/assets/"]').forEach((node) => node.remove());
  document.head.querySelectorAll('link[href*="maplibre-vendor"]').forEach((node) => node.remove());
  for (const id of intervals) window.clearInterval(id);
  intervals.length = 0;
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
    const fetchMock = vi.mocked(globalThis.fetch);
    const probeCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('map-probe='));
    expect(probeCall).toBeTruthy();
    expect(probeCall?.[1]).toMatchObject({ cache: 'no-store' });
    expect((probeCall?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reloads the document when Retry is pressed after the stale chunk fails again', async () => {
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
    expect(retry?.getAttribute('tabindex')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    const href = String(replace.mock.calls[0]?.[0]);
    expect(href).toMatch(/map-retry=\d+/);
    expect(href).not.toContain('map-chunk=');
    expect(sessionStorage.getItem(MAP_IMPORT_RETRY_KEY)).toBe('1');
    expect(retry?.getAttribute('tabindex')).toBeNull();
  });

  it('keeps Map couldn\'t load after the countdown tick', async () => {
    seedSnapshot();
    sessionStorage.setItem(MAP_IMPORT_RETRY_KEY, '1');
    vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(document.getElementById('status-banner')?.textContent).toContain("Map couldn't load");
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const text = document.getElementById('status-banner')?.textContent ?? '';
    expect(text).toContain("Map couldn't load");
    expect(text).not.toContain('Last updated');
  });

  it('shows the error when sessionStorage throws on the retry flag', async () => {
    seedSnapshot();
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const original = sessionStorage.setItem.bind(sessionStorage);
    vi.spyOn(sessionStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === MAP_IMPORT_RETRY_KEY) throw new Error('quota');
      original(key, value);
    });
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(document.getElementById('status-banner')?.textContent).toContain("Map couldn't load");
    });
    expect(replace).not.toHaveBeenCalled();
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

  it('reloads a WebKit failure when the resource timing entry is a 404', async () => {
    mapGate.mode = 'webkit';
    seedSnapshot();
    stubResources([emptyScript('http://localhost/assets/map-stale.js', 404)]);
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(String(replace.mock.calls[0]?.[0])).toContain('map-chunk=1');
    expect(sessionStorage.getItem(MAP_IMPORT_URL_KEY)).toContain('map-stale.js');
  });

  it('reloads a WebKit failure when an earlier empty script is the missing chunk', async () => {
    mapGate.mode = 'webkit';
    seedSnapshot();
    stubResources([
      emptyScript('http://localhost/assets/map-stale.js'),
      emptyScript('http://localhost/assets/satellites.js'),
    ]);
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(String(replace.mock.calls[0]?.[0])).toContain('map-chunk=1');
    expect(sessionStorage.getItem(MAP_IMPORT_URL_KEY)).toContain('map-stale.js');
    expect(sessionStorage.getItem(MAP_IMPORT_URL_KEY)).not.toContain('satellites.js');
  });

  it('shows the error for a WebKit 500 without reloading', async () => {
    mapGate.mode = 'webkit';
    net.chunkStatus = 500;
    seedSnapshot();
    stubResources([emptyScript('http://localhost/assets/map-stale.js', 500)]);
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(document.getElementById('status-banner')?.textContent).toContain("Map couldn't load");
    });
    expect(replace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(MAP_IMPORT_RETRY_KEY)).toBeNull();
  });

  it('clears the retry flag when the map module loads', async () => {
    mapGate.mode = 'ok';
    seedSnapshot();
    sessionStorage.setItem(MAP_IMPORT_RETRY_KEY, '1');
    sessionStorage.setItem(MAP_IMPORT_URL_KEY, 'http://localhost/assets/map-stale.js');
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(sessionStorage.getItem(MAP_IMPORT_RETRY_KEY)).toBeNull();
    });
    expect(sessionStorage.getItem(MAP_IMPORT_URL_KEY)).toBeNull();
    expect(document.getElementById('status-banner')?.textContent ?? '').not.toContain("Map couldn't load");
    const map = await import('../src/map');
    expect(map.renderMap).toHaveBeenCalled();
  });

  it('shows the error when the chunk probe never answers', async () => {
    net.hang = true;
    seedSnapshot();
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(document.getElementById('status-banner')?.textContent).toContain("Map couldn't load");
    }, { timeout: 5000 });
    const text = document.getElementById('status-banner')?.textContent ?? '';
    expect(text).not.toContain('Last updated');
    expect(replace).not.toHaveBeenCalled();
  }, 8000);

  it('remembers the map chunk when WebKit aborts and only the vendor was timed', async () => {
    mapGate.mode = 'webkit';
    seedSnapshot();
    document.head.insertAdjacentHTML('beforeend', '<script type="module" src="/assets/index-ENTRY.js"></script>');
    stubResources([emptyScript('http://localhost/assets/maplibre-vendor-V.js', 404)]);
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(document.getElementById('status-banner')?.textContent).toContain("Map couldn't load");
    }, { timeout: 8000 });
    expect(sessionStorage.getItem(MAP_IMPORT_URL_KEY)).toContain('index-MAP.js');
    expect(sessionStorage.getItem(MAP_IMPORT_URL_KEY)).not.toContain('maplibre-vendor');
    expect(replace).not.toHaveBeenCalled();
    document.querySelector('#status-banner button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    const href = String(replace.mock.calls[0]?.[0]);
    expect(href).toMatch(/map-retry=\d+/);
    expect(mapGate.evaluations).toBe(1);
  }, 15000);

  it('imports the stored map chunk on retry instead of the failed specifier', async () => {
    mapGate.mode = 'ok';
    seedSnapshot();
    document.head.insertAdjacentHTML('beforeend', '<script type="module" src="/assets/index-ENTRY.js"></script>');
    window.history.replaceState({}, '', '/?u=anil&map-retry=17');
    sessionStorage.setItem(MAP_IMPORT_URL_KEY, 'http://localhost/assets/maplibre-vendor-V.js');
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(document.querySelector('link[rel="stylesheet"][href*="maplibre-vendor"]')).not.toBeNull();
    });
    expect(mapGate.evaluations).toBe(0);
    await vi.waitFor(() => {
      expect(sessionStorage.getItem(MAP_IMPORT_URL_KEY)).toContain('index-MAP.js');
    });
  });

  it('leaves SIGN IN AGAIN in place when the map chunk fails later', async () => {
    mapGate.mode = 'delay';
    seedSnapshot();
    const { init, setAuthBanner } = await import('../src/main');
    const pending = init();
    await vi.waitFor(() => {
      expect(mapGate.evaluations).toBeGreaterThan(0);
    }, { timeout: 8000 });
    setAuthBanner(bannerAuthExpired(200));
    expect(document.getElementById('status-banner')?.textContent).toContain('SIGN IN AGAIN');
    mapGate.release();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const text = document.getElementById('status-banner')?.textContent ?? '';
    expect(text).toContain('SIGN IN AGAIN');
    expect(text).not.toContain("Map couldn't load");
  }, 15000);

  it('remembers Queue across the cache-bust reload', async () => {
    mapGate.mode = 'delay-stale';
    seedSnapshot();
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const { init } = await import('../src/main');
    const pending = init();
    await vi.waitFor(() => {
      expect(mapGate.evaluations).toBeGreaterThan(0);
    }, { timeout: 8000 });
    document.getElementById('tab-queue')?.click();
    expect(document.getElementById('view')?.className).toBe('view-queue');
    mapGate.release();
    await pending;
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(String(replace.mock.calls[0]?.[0])).toContain('map-chunk=1');
    expect(sessionStorage.getItem(MAP_IMPORT_VIEW_KEY)).toBe('tab-queue');
  }, 15000);

  it('restores ISS after the cache-bust reload', async () => {
    seedSnapshot();
    sessionStorage.setItem(MAP_IMPORT_RETRY_KEY, '1');
    sessionStorage.setItem(MAP_IMPORT_VIEW_KEY, 'tab-iss');
    vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    const { init } = await import('../src/main');
    await init();
    expect(document.getElementById('view')?.className).toBe('view-iss');
    expect(document.getElementById('tab-iss')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('tab-map')?.classList.contains('active')).toBe(false);
    expect(sessionStorage.getItem(MAP_IMPORT_VIEW_KEY)).toBeNull();
  });

  it('strips map-chunk and map-retry after the map module loads', async () => {
    mapGate.mode = 'ok';
    seedSnapshot();
    window.history.replaceState({}, '', '/?e2e=&u=anil&map-chunk=1&map-retry=9');
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(window.location.href).not.toContain('map-chunk');
    });
    expect(window.location.href).not.toContain('map-retry');
    expect(window.location.href).toContain('u=anil');
    expect(window.location.href).toContain('e2e=');
  });

  it('still reloads the document when remembering the chunk throws', async () => {
    seedSnapshot();
    sessionStorage.setItem(MAP_IMPORT_RETRY_KEY, '1');
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(() => {
      throw new Error('timing');
    });
    const replace = vi.fn();
    vi.spyOn(window.location, 'replace').mockImplementation(replace);
    const { init } = await import('../src/main');
    await init();
    await vi.waitFor(() => {
      expect(document.getElementById('status-banner')?.textContent).toContain("Map couldn't load");
    }, { timeout: 8000 });
    document.querySelector('#status-banner button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(String(replace.mock.calls[0]?.[0])).toMatch(/map-retry=\d+/);
  }, 15000);
});

describe('map load error above the shot list', () => {
  it('keeps Retry above the shot list', () => {
    const css = readFileSync(resolve('src/style.css'), 'utf8');
    const actions = css.match(/body:has\(> #view\.view-map\) > #status-banner:has\(\.banner-actions\)\s*\{[^}]*\}/);
    const bar = css.match(/#shotlist-bar\s*\{[^}]*\}/);
    const actionsZ = Number(actions?.[0].match(/z-index:\s*(\d+)/)?.[1]);
    const barZ = Number(bar?.[0].match(/z-index:\s*(\d+)/)?.[1]);
    expect(actionsZ).toBe(70);
    expect(barZ).toBe(60);
    expect(actionsZ).toBeGreaterThan(barZ);
  });
});
