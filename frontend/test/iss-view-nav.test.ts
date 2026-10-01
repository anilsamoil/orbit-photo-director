import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Manifest, Track } from '../src/types';
import * as manifestModule from '../src/manifest';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

const startMs = Date.parse(fixture.start);
const whenMs = startMs + 60_000;

const renderer = vi.hoisted(() => ({
  destroyed: 0,
  ready: (): Promise<void> => Promise.resolve(),
}));

const schedulerStops = vi.hoisted(() => new Set<() => void>());

vi.mock('../src/network-status', async () => {
  const actual = await vi.importActual<typeof import('../src/network-status')>('../src/network-status');
  return {
    ...actual,
    createPollScheduler: (options: Parameters<typeof actual.createPollScheduler>[0]) => {
      const scheduler = actual.createPollScheduler(options);
      schedulerStops.add(() => scheduler.stop());
      return scheduler;
    },
  };
});

vi.mock('../src/profile-session', () => ({
  getAccountProfile: () => null,
  getAuthorizedProfiles: () => [],
  getSignedInAccountProfile: () => null,
  canSelectProfile: () => false,
  resolveAccountProfile: async () => ({ name: 'anil', displayName: 'Anil', isVerified: true }),
}));

vi.mock('../src/manifest', async () => {
  const actual = await vi.importActual<typeof import('../src/manifest')>('../src/manifest');
  return {
    ...actual,
    fetchManifest: vi.fn(),
    fetchTop5: vi.fn(async () => []),
    fetchTop24h: vi.fn(async () => []),
    fetchTrack: vi.fn(),
    fetchStatus: vi.fn(async () => null),
  };
});

vi.mock('../src/tile-precache', async () => {
  const actual = await vi.importActual<typeof import('../src/tile-precache')>('../src/tile-precache');
  return { ...actual, precacheTilesForTargets: vi.fn(), precacheWorldBaseTiles: vi.fn() };
});

vi.mock('../src/aurora', async () => {
  const actual = await vi.importActual<typeof import('../src/aurora')>('../src/aurora');
  return { ...actual, fetchKpData: vi.fn(async () => null), renderKpWidget: vi.fn(), initKpWidget: vi.fn() };
});

vi.mock('../src/map', () => ({
  renderMap: vi.fn(async () => {}),
  resizeMap: vi.fn(),
  focusLaunchOnMap: vi.fn(),
  applyDistanceThreshold: vi.fn(),
  dropLookupPin: vi.fn(),
  getSatelliteTopbarReadouts: vi.fn(() => []),
  applyFollowISS: vi.fn(),
}));

vi.mock('../src/map/adapters/maplibre/iss-view', () => ({
  createIssRenderer: () => ({
    ready: () => renderer.ready(),
    aim: async () => {},
    resize: () => {},
    destroy: () => {
      renderer.destroyed += 1;
    },
  }),
}));

const DOM = `
  <header class="topbar">
    <div id="iss-now"></div>
    <button id="tab-queue" class="tab" type="button">Queue</button>
    <button id="tab-upcoming" class="tab" type="button">Upcoming</button>
    <button id="tab-map" class="tab active" type="button">Map</button>
    <button id="tab-iss" class="tab" type="button">ISS view</button>
    <button id="tab-profile" class="tab" type="button">Profile</button>
    <button id="tab-log" class="tab" type="button">Log</button>
  </header>
  <footer id="status-banner" class="banner">Loading…</footer>
  <div id="toast" hidden></div>
  <main id="view" class="view-map">
    <section id="queue-pane"><div id="cards"></div><div id="empty" hidden></div></section>
    <section id="upcoming-pane"><div id="upcoming-cards"></div><div id="upcoming-empty" hidden></div></section>
    <section id="map-pane"><div id="map"></div></section>
    <section id="iss-pane"><div id="iss-host"></div></section>
    <section id="profile-pane"><div id="profile-body"></div></section>
    <section id="log-pane"><div id="log-list"></div><div id="log-empty" hidden></div><div id="log-stats"></div></section>
  </main>
  <button id="help-fab" type="button">?</button>
`;

function manifest(): Manifest {
  return {
    version: 'm-nav',
    generated_at: new Date(whenMs).toISOString(),
    tle_epoch: '2024-10-16T18:58:11.999Z',
    cloud_composite_hour: '2024-10-17T11:00:00Z',
    target_data_version: 'v1',
    build_version: '2.0.0.0',
    freshness: { tle_hours: 1, cloud_hours: 0, ok: true },
    artifacts: {
      top5: { path: 'v/X/top5.json', sha256: 'a'.repeat(64), bytes: 10 },
      top_24h: { path: 'v/X/top_24h.json', sha256: 'b'.repeat(64), bytes: 10 },
      track: { path: 'v/X/track.json', sha256: 'c'.repeat(64), bytes: 10 },
    },
  };
}

function track(): Track {
  return {
    iss_polynomial: fixture.iss_polynomial,
    tle: fixture.tle,
    tle_epoch: '2024-10-16T18:58:11.999Z',
    tle_age_hours: 17,
    tle_freshness_factor: 1,
  };
}

const liveIntervals = new Set<ReturnType<typeof window.setInterval>>();

async function until(label: string, check: () => void): Promise<void> {
  let last = 'not ready';
  for (let step = 0; step < 40; step += 1) {
    try {
      check();
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`${label}: ${last}`);
}

beforeEach(() => {
  document.body.innerHTML = DOM;
  localStorage.clear();
  sessionStorage.clear();
  renderer.destroyed = 0;
  renderer.ready = () => Promise.resolve();
  vi.resetModules();
  vi.spyOn(Date, 'now').mockReturnValue(whenMs);
  const realSetInterval = window.setInterval.bind(window) as (
    ...args: Parameters<typeof window.setInterval>
  ) => ReturnType<typeof window.setInterval>;
  vi.spyOn(window, 'setInterval').mockImplementation((...args) => {
    const id = realSetInterval(...args);
    liveIntervals.add(id);
    return id;
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"targets":[],"entries":[]}')));
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

afterEach(() => {
  for (const stop of schedulerStops) stop();
  schedulerStops.clear();
  for (const id of liveIntervals) window.clearInterval(id);
  liveIntervals.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function boot(): Promise<void> {
  vi.mocked(manifestModule.fetchManifest).mockResolvedValue(manifest());
  vi.mocked(manifestModule.fetchTrack).mockResolvedValue(track());
  const { init } = await import('../src/main');
  await init();
}

describe('ISS view tab', () => {
  it('opens on Horizon with the accepted snapshot, switches to Straight down, and disposes on leave', async () => {
    await boot();
    (document.getElementById('tab-iss') as HTMLElement).click();
    await until('horizon card', () => {
      const text = document.querySelector('[data-iss-status]')?.textContent ?? '';
      expect(text).toContain('ISS perspective');
      expect(text).toContain('Horizon locked · ground-track forward');
    });
    expect(document.getElementById('view')?.className).toBe('view-iss');
    expect(document.getElementById('tab-iss')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('tab-map')?.classList.contains('active')).toBe(false);
    expect(document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-iss-status]')?.textContent).toContain('14 mm · full frame');
    expect(document.querySelector('[data-iss-status]')?.textContent).toContain('Cloud-free · Blue Marble + Black Marble 2016');
    expect(document.querySelector('[data-iss-utc]')?.textContent).toBe('12:01:00 UTC');
    expect(document.querySelector('[data-iss-detail]')?.textContent).toContain('manifest m-nav');
    expect(document.querySelector('[data-iss-detail]')?.textContent).toContain('spherical Earth model');

    (document.querySelector('[data-iss-preset="nadir"]') as HTMLElement).click();
    await until('straight down', () => {
      expect(document.querySelector('[data-iss-status]')?.textContent).toContain('Nadir locked · ground-track forward');
    });
    expect(document.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed')).toBe('true');

    const destroyed = renderer.destroyed;
    (document.getElementById('tab-queue') as HTMLElement).click();
    expect(document.getElementById('view')?.className).toBe('view-queue');
    expect(document.querySelector('[data-iss-scene]')).toBeNull();
    expect(renderer.destroyed).toBeGreaterThan(destroyed);

    (document.getElementById('tab-iss') as HTMLElement).click();
    await until('session preset', () => {
      expect(document.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed')).toBe('true');
    });
    (document.getElementById('tab-map') as HTMLElement).click();
    expect(document.getElementById('view')?.className).toBe('view-map');
    expect(document.querySelector('[data-iss-scene]')).toBeNull();
    (document.getElementById('tab-upcoming') as HTMLElement).click();
    expect(document.getElementById('view')?.className).toBe('view-upcoming');
    expect(document.getElementById('tab-upcoming')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('tab-iss')?.classList.contains('active')).toBe(false);
  });

  it('restores the last Cupola window, then Horizon, after leaving the tab', async () => {
    await boot();
    (document.getElementById('tab-iss') as HTMLElement).click();
    await until('cupola mounted', () => {
      expect(document.querySelector('[data-iss-cupola]')).toBeTruthy();
    });
    const cupola = document.querySelector('[data-iss-cupola]') as HTMLSelectElement;
    cupola.value = '3';
    cupola.dispatchEvent(new Event('change'));
    expect(document.querySelector('[data-iss-window]')?.textContent).toBe('W3');
    expect(document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('false');

    (document.getElementById('tab-map') as HTMLElement).click();
    expect(document.querySelector('[data-iss-scene]')).toBeNull();
    (document.getElementById('tab-iss') as HTMLElement).click();
    await until('window restored', () => {
      const select = document.querySelector('[data-iss-cupola]') as HTMLSelectElement | null;
      const chip = document.querySelector('[data-iss-window]');
      expect(select?.value).toBe('3');
      expect(chip?.textContent).toBe('W3');
      expect(chip?.hasAttribute('hidden')).toBe(false);
      expect(document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('false');
    });

    (document.querySelector('[data-iss-preset="horizon"]') as HTMLElement).click();
    expect((document.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('');
    expect(document.querySelector('[data-iss-window]')?.hasAttribute('hidden')).toBe(true);
    (document.getElementById('tab-queue') as HTMLElement).click();
    expect(document.querySelector('[data-iss-scene]')).toBeNull();
    (document.getElementById('tab-iss') as HTMLElement).click();
    await until('horizon restored', () => {
      expect(document.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('true');
      expect((document.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('');
      expect(document.querySelector('[data-iss-window]')?.hasAttribute('hidden')).toBe(true);
    });
  });

  it('stays on Loading until the accepted manifest arrives, then paints that snapshot', async () => {
    let resolveManifest: (value: Manifest) => void = () => {};
    vi.mocked(manifestModule.fetchManifest).mockReturnValue(new Promise((resolve) => {
      resolveManifest = resolve;
    }));
    vi.mocked(manifestModule.fetchTrack).mockResolvedValue(track());
    const { init } = await import('../src/main');
    const pending = init();
    await until('tabs bound', () => {
      if (document.querySelector('.help-modal')) return;
      document.getElementById('help-fab')?.click();
      if (!document.querySelector('.help-modal')) throw new Error('tabs are not bound yet');
    });
    (document.querySelector('.help-close') as HTMLElement | null)?.click();
    (document.getElementById('tab-iss') as HTMLElement).click();
    await until('loading', () => {
      expect(document.querySelector('[data-iss-status]')?.textContent).toBe('Loading ISS view');
    });
    resolveManifest(manifest());
    await pending;
    await until('snapshot', () => {
      expect(document.querySelector('[data-iss-detail]')?.textContent).toContain('manifest m-nav');
    });
    expect(document.querySelector('[data-iss-status]')?.textContent).toContain('Horizon locked · ground-track forward');
  });

  it('drops a renderer that finishes after the operator has left', async () => {
    let release = (): void => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderer.ready = () => pending;
    await boot();
    (document.getElementById('tab-iss') as HTMLElement).click();
    await until('scene mounted', () => {
      expect(document.querySelector('[data-iss-scene]')).toBeTruthy();
    });
    (document.getElementById('tab-queue') as HTMLElement).click();
    expect(document.querySelector('[data-iss-scene]')).toBeNull();
    release();
    await pending;
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('[data-iss-scene]')).toBeNull();
    expect(document.getElementById('iss-host')?.childElementCount).toBe(0);
    expect(renderer.destroyed).toBeGreaterThan(0);
  });
});
