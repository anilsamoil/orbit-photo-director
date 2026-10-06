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
    loaded(): boolean { return true; }
    once(): void {}
    on(): void {}
    setMaxPitch(): void {}
    setVerticalFieldOfView(): void {}
    getPixelRatio(): number { return 1; }
    setPixelRatio(): void {}
    resize(): void {}
    getSource(): null { return null; }
    addSource(): void {}
    addLayer(): void {}
    calculateCameraOptionsFromTo(): { center: number[] } { return { center: [0, 0] }; }
    jumpTo(): void {}
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

const fetchMock = vi.fn(async () => new Response('[]', {
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
});
