import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IssAim } from '../src/iss-view/renderer';

vi.mock('maplibre-gl', () => {
  class LngLat {
    constructor(public lng: number, public lat: number) {}
  }
  class Marker {
    setLngLat(): this { return this; }
    addTo(): this { return this; }
    remove(): void {}
    getElement(): HTMLElement { return document.createElement('div'); }
  }
  class Map {
    constructor(public options: { container: HTMLElement }) {}
    loaded(): boolean {
      return !(globalThis as { __holdIssIdle?: boolean }).__holdIssIdle;
    }
    once(): void {}
    on(): void {}
    setMaxPitch(): void {}
    fov = 36.87;
    roll = 0;
    setVerticalFieldOfView(value: number): void { this.fov = value; }
    getVerticalFieldOfView(): number { return this.fov; }
    getRoll(): number { return this.roll; }
    jumpTo(camera?: { roll?: number }): void {
      if ((globalThis as { __issKeepRoll?: boolean }).__issKeepRoll) return;
      const roll = camera?.roll;
      if (typeof roll === 'number' && Number.isFinite(roll)) this.roll = roll;
    }
    getPixelRatio(): number { return 1; }
    setPixelRatio(): void {}
    resize(): void {}
    getSource(): null { return null; }
    addSource(): void {}
    addLayer(): void {}
    calculateCameraOptionsFromTo(): { center: number[] } { return { center: [0, 0] }; }
    isMoving(): boolean { return false; }
    remove(): void {}
    getCanvas(): { clientWidth: number; clientHeight: number } {
      return { clientWidth: 148, clientHeight: 96 };
    }
    getContainer(): HTMLElement { return this.options.container; }
    project(): { x: number; y: number } { return { x: 40, y: 40 }; }
  }
  return {
    Map,
    LngLat,
    Marker,
    addProtocol() {},
    setWorkerUrl() {},
  };
});

const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('[]', {
  status: 200,
  headers: { 'content-type': 'application/json' },
}));

function sampleAim(): IssAim {
  return {
    pose: {
      preset: 'horizon',
      camera: { latDeg: 10, lonDeg: 20, radiusM: 6_778_000 },
      targetLatDeg: 10,
      targetLonDeg: 20,
      altitudeM: 420_000,
      analyticPitchDeg: 20,
      bearingDeg: 0,
      horizonDepressionDeg: 0,
      limbFromNadirDeg: 0,
      inwardDeg: 0,
    },
    verticalFovDeg: 60,
    widthPx: 148,
    heightPx: 96,
    lightingUtcMs: 1_700_000_000_000,
  };
}

function catalogFetches(): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('label-catalog'));
}

describe('horizon inset labels', () => {
  afterEach(() => {
    fetchMock.mockClear();
    document.body.innerHTML = '';
  });

  it('never fetches a label catalog when the inset turns labels off', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const { createIssRenderer } = await import('../src/map/adapters/maplibre/iss-view');
    const frame = document.createElement('div');
    document.body.append(frame);
    const renderer = createIssRenderer(frame, {
      onImagery() {},
      onContextLost() {},
    }, { labels: false });
    await renderer.aim(sampleAim());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(catalogFetches()).toEqual([]);
    expect(frame.dataset.issPlaceLayers).toBeUndefined();
    expect(frame.querySelector('.iss-place')).toBeNull();
    renderer.destroy();
  });

  it('still fetches the near catalog for the full scene', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const { createIssRenderer } = await import('../src/map/adapters/maplibre/iss-view');
    const frame = document.createElement('div');
    document.body.append(frame);
    const renderer = createIssRenderer(frame, {
      onImagery() {},
      onContextLost() {},
    });
    await renderer.aim(sampleAim());
    await vi.waitFor(() => {
      expect(catalogFetches().some((url) => url.includes('label-catalog.json'))).toBe(true);
    });
    renderer.destroy();
  });

  it('confirms the applied field before map idle', async () => {
    (globalThis as { __holdIssIdle?: boolean }).__holdIssIdle = true;
    try {
      vi.stubGlobal('fetch', fetchMock);
      const { createIssRenderer } = await import('../src/map/adapters/maplibre/iss-view');
      const frame = document.createElement('div');
      document.body.append(frame);
      const renderer = createIssRenderer(frame, {
        onImagery() {},
        onContextLost() {},
      }, { labels: false });
      let applied: number | null = null;
      let epoch = 0;
      let settled = false;
      const pending = renderer.aim({
        ...sampleAim(),
        fovEpoch: 7,
        onCamera(degrees, token) {
          applied = degrees;
          epoch = token;
        },
      });
      void pending.then(() => {
        settled = true;
      }, () => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(epoch).toBe(7);
      expect(applied).toBe(60);
      renderer.destroy();
    } finally {
      delete (globalThis as { __holdIssIdle?: boolean }).__holdIssIdle;
    }
  });

  it('does not confirm the field before the camera roll is applied', async () => {
    (globalThis as { __issKeepRoll?: boolean }).__issKeepRoll = true;
    try {
      vi.stubGlobal('fetch', fetchMock);
      const { createIssRenderer } = await import('../src/map/adapters/maplibre/iss-view');
      const frame = document.createElement('div');
      document.body.append(frame);
      const renderer = createIssRenderer(frame, {
        onImagery() {},
        onContextLost() {},
      }, { labels: false });
      let applied: number | null = null;
      await renderer.aim({
        ...sampleAim(),
        fovEpoch: 4,
        onCamera(degrees) {
          applied = degrees;
        },
      });
      expect(applied).toBeNull();
      renderer.destroy();
    } finally {
      delete (globalThis as { __issKeepRoll?: boolean }).__issKeepRoll;
    }
  });
});
