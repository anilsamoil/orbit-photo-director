import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Manifest, Track } from '../src/types';
import * as manifestModule from '../src/manifest';

type IssSceneModule = {
  mountIssScene: (host: HTMLElement) => { update: () => void; dispose: () => void };
};

const gate = vi.hoisted(() => {
  let release: (mod: IssSceneModule) => void = () => {};
  let pending: Promise<IssSceneModule> = Promise.resolve({
    mountIssScene: () => ({ update() {}, dispose() {} }),
  });
  function reset(): void {
    pending = new Promise<IssSceneModule>((resolve) => {
      release = resolve;
    });
  }
  return {
    mounts: { n: 0 },
    reset,
    release(mod: IssSceneModule) {
      release(mod);
    },
    promise(): Promise<IssSceneModule> {
      return pending;
    },
  };
});

const schedulerStops = vi.hoisted(() => new Set<() => void>());

vi.mock('../src/iss-view', () => gate.promise());

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
  getSignedInAccountProfile: () => null,
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

const DOM = `
  <div id="iss-now"></div>
  <button id="tab-queue" type="button">Queue</button>
  <button id="tab-upcoming" type="button">Upcoming</button>
  <button id="tab-map" type="button">Map</button>
  <button id="tab-iss" type="button">ISS view</button>
  <button id="tab-log" type="button">Log</button>
  <footer id="status-banner">Loading…</footer>
  <main id="view" class="view-map">
    <div id="cards"></div><div id="empty" hidden></div>
    <div id="upcoming-cards"></div><div id="upcoming-empty" hidden></div>
    <div id="iss-host"></div>
  </main>
`;

function manifest(): Manifest {
  return {
    version: 'm-race',
    generated_at: '2024-10-17T12:01:00Z',
    tle_epoch: '2024-10-16T18:58:11.999Z',
    cloud_composite_hour: '2024-10-17T11:00:00Z',
    target_data_version: 'v1',
    build_version: '2.0.0.0',
    freshness: { tle_hours: 1, cloud_hours: 0, ok: true },
    artifacts: {},
  };
}

beforeEach(() => {
  document.body.innerHTML = DOM;
  localStorage.clear();
  gate.mounts.n = 0;
  gate.reset();
  vi.resetModules();
  vi.doMock('../src/iss-view', () => gate.promise());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"targets":[]}')));
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

function track(): Track {
  return {
    iss_polynomial: {
      start: '2024-10-17T12:00:00Z',
      duration_seconds: 60,
      lat_coeffs: [0],
      lon_coeffs: [0],
      polynomial_order: 0,
    },
    tle_epoch: '2024-10-16T18:58:11.999Z',
    tle_age_hours: 1,
    tle_freshness_factor: 1,
  };
}

async function boot(): Promise<void> {
  vi.mocked(manifestModule.fetchManifest).mockResolvedValue(manifest());
  vi.mocked(manifestModule.fetchTrack).mockResolvedValue(track());
  const { init } = await import('../src/main');
  await init();
}

async function releasePage(): Promise<void> {
  for (const stop of schedulerStops) stop();
  schedulerStops.clear();
  const { stopCountdown } = await import('../src/main');
  stopCountdown();
}

afterEach(async () => {
  await releasePage();
  gate.release({
    mountIssScene: () => ({ update() {}, dispose() {} }),
  });
  await vi.dynamicImportSettled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ISS view import lifetime', () => {
  it('does not mount a scene whose import finishes after the operator leaves', async () => {
    await boot();
    (document.getElementById('tab-iss') as HTMLElement).click();
    await Promise.resolve();
    expect(gate.mounts.n).toBe(0);
    (document.getElementById('tab-queue') as HTMLElement).click();
    expect(document.getElementById('view')?.className).toBe('view-queue');
    gate.release({
      mountIssScene(host) {
        gate.mounts.n += 1;
        const node = document.createElement('section');
        node.dataset.issScene = '';
        host.append(node);
        return {
          update() {},
          dispose() {
            node.remove();
          },
        };
      },
    });
    await gate.promise();
    await vi.dynamicImportSettled();
    expect(gate.mounts.n).toBe(0);
    expect(document.querySelector('[data-iss-scene]')).toBeNull();
  });

  it('does not call updateIssNow after the page is released', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await boot();
      const readout = document.getElementById('iss-now');
      if (!readout) throw new Error('missing iss-now');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(readout.textContent).toContain('ISS');
      readout.innerHTML = 'sentinel';
      await releasePage();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(readout.innerHTML).toBe('sentinel');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second init leaves one manifest poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await boot();
      await boot();
      const stops = [...schedulerStops];
      expect(stops.length).toBe(2);
      const latest = stops[1];
      if (!latest) throw new Error('missing poll stop');
      latest();
      const before = vi.mocked(manifestModule.fetchManifest).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.mocked(manifestModule.fetchManifest).mock.calls.length - before).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

});
