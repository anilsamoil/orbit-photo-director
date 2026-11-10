import { afterEach, describe, expect, it, vi } from 'vitest';

import { nightLightsFade, nightLightsMinute, viirsAlphaUrl } from '../src/night-lights';
import {
  colorNightLightsPixels, createViirsAlphaHandler, maskNightLightsPixels,
  renderNightLightsTile, VIIRS_ALPHA_PROTOCOL, VIIRS_CACHE_MAX_TILES,
} from '../src/map/adapters/maplibre/viirs-alpha';

const noon = Date.parse('2026-03-20T12:00:00Z');
const rgba = (value: number, alpha = 255) => new Uint8ClampedArray([value, value, value, alpha]);
const tileUrl = (x = 0, atMs = noon) => viirsAlphaUrl('2016-01-01', atMs)
  .replace('{z}', '8').replace('{y}', '95').replace('{x}', String(x));

afterEach(() => { vi.unstubAllGlobals(); });

describe('night-light color and coverage', () => {
  it('removes the navy background and keeps a dim fringe warm and transparent', () => {
    const navy = new Uint8ClampedArray([4, 5, 15, 255]);
    expect([...colorNightLightsPixels(navy)]).toEqual([255, 179, 95, 0]);
    expect([...colorNightLightsPixels(rgba(40))]).toEqual([255, 195, 117, 36]);
  });

  it('keeps dim towns visible and bright cores warm, below full opacity', () => {
    expect([...colorNightLightsPixels(rgba(30))]).toEqual([255, 190, 110, 22]);
    expect([...colorNightLightsPixels(rgba(50))]).toEqual([255, 198, 122, 49]);
    expect([...colorNightLightsPixels(rgba(100))]).toEqual([255, 211, 139, 102]);
    expect([...colorNightLightsPixels(rgba(200))]).toEqual([255, 226, 161, 188]);
    expect([...colorNightLightsPixels(rgba(255))]).toEqual([255, 233, 170, 230]);
    expect([...colorNightLightsPixels(new Uint8ClampedArray([255, 235, 150, 255]))]).toEqual([255, 230, 166, 212]);
  });

  it('preserves source transparency and proportional partial coverage in place', () => {
    const partial = rgba(150, 64);
    expect(colorNightLightsPixels(partial)).toBe(partial);
    expect([...partial]).toEqual([255, 219, 151, 37]);
    expect([...colorNightLightsPixels(rgba(150))]).toEqual([255, 219, 151, 147]);
    expect([...colorNightLightsPixels(rgba(255, 0))]).toEqual([255, 233, 170, 0]);
  });
});

describe('night-side mask', () => {
  it('has a smooth twilight shoulder, zero daylight and full night at minus three degrees', () => {
    expect(nightLightsFade(15)).toBe(0);
    expect(nightLightsFade(0)).toBe(0);
    expect(nightLightsFade(-1)).toBe(7 / 27);
    expect(nightLightsFade(-1.5)).toBe(0.5);
    expect(nightLightsFade(-3)).toBe(1);
    expect(nightLightsFade(-60)).toBe(1);
    expect(nightLightsFade(-0.01)).toBe(0.000033259259259259265);
    expect(nightLightsFade(-2.99)).toBe(0.9999667407407407);
  });

  it('masks both day quadrants and joins the night side across the antimeridian', () => {
    const pixels = new Uint8ClampedArray(Array.from({ length: 4 }, () => [255, 220, 150, 200]).flat());
    maskNightLightsPixels(pixels, 4, 1, { z: 0, x: 0, y: 0, atMs: noon });
    expect([pixels[3], pixels[7], pixels[11], pixels[15]]).toEqual([200, 0, 0, 200]);
  });

  it('scrubbing twelve hours reverses the lit hemisphere without changing color or raising alpha', () => {
    const pixels = new Uint8ClampedArray(Array.from({ length: 4 }, () => [255, 220, 150, 80]).flat());
    maskNightLightsPixels(pixels, 4, 1, { z: 0, x: 0, y: 0, atMs: noon + 12 * 3600_000 });
    expect([pixels[3], pixels[7], pixels[11], pixels[15]]).toEqual([0, 80, 80, 0]);
    expect([...pixels.slice(4, 7)]).toEqual([255, 220, 150]);
  });

  it('feathers a pixel between 0° and -3° instead of switching it fully on', () => {
    const pixels = new Uint8ClampedArray([255, 220, 150, 200]);
    maskNightLightsPixels(pixels, 1, 1, { z: 6, x: 48, y: 8, atMs: noon });
    expect([...pixels]).toEqual([255, 220, 150, 32]);
  });

  it('uses Mercator pixel latitude for polar day and night', () => {
    const north = rgba(255);
    const south = rgba(255);
    const summer = Date.parse('2026-06-21T12:00:00Z');
    maskNightLightsPixels(north, 1, 1, { z: 2, x: 0, y: 0, atMs: summer });
    maskNightLightsPixels(south, 1, 1, { z: 2, x: 0, y: 3, atMs: summer });
    expect(north[3]).toBe(0);
    expect(south[3]).toBe(255);
  });
});

describe('view-time tile URLs', () => {
  it('keeps the public static source and quantizes only the local mask instant', () => {
    const url = viirsAlphaUrl('2016-01-01', noon + 12345);
    expect(url.startsWith(`${VIIRS_ALPHA_PROTOCOL}://https://gibs.earthdata.nasa.gov/`)).toBe(true);
    expect(url).toContain('/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png');
    expect(url).toContain(`?night=${noon}`);
    expect(nightLightsMinute(noon - 1)).toBe(noon - 60_000);
  });
});

describe('tile lifecycle', () => {
  it('reuses upstream bytes across mask times while transforming each requested instant', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);
    let viewMs = noon;
    const transform = vi.fn(async (bytes: ArrayBuffer, tile: { atMs: number }) => { void tile; return bytes; });
    const handler = createViirsAlphaHandler(() => viewMs, transform);
    const first = new AbortController();
    await handler({ url: tileUrl() }, first);
    viewMs = noon + 60_000;
    await handler({ url: tileUrl(0, viewMs) }, new AbortController());
    viewMs = noon - 60_000;
    await handler({ url: tileUrl(0, viewMs) }, new AbortController());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(tileUrl().replace('viirs-alpha://', '').split('?')[0], { signal: first.signal });
    expect(transform.mock.calls.map(call => call[1].atMs)).toEqual([noon, noon + 60_000, noon - 60_000]);
  });

  it.each([60_000, -60_000])('late completion uses the authoritative view after a %i ms scrub', async delta => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    let viewMs = noon;
    let resume: (() => void) | undefined;
    let started: (() => void) | undefined;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const delayed = new Promise<void>(resolve => { resume = resolve; });
    let calls = 0;
    const handler = createViirsAlphaHandler(() => viewMs, async (_bytes, tile) => {
      calls += 1;
      if (calls === 1) { started?.(); await delayed; }
      return new Float64Array([tile.atMs]).buffer;
    });
    const old = handler({ url: tileUrl() }, new AbortController());
    await firstStarted;
    viewMs += delta;
    const latest = await handler({ url: tileUrl(0, viewMs) }, new AbortController());
    resume?.();
    const late = await old;
    expect(new Float64Array(latest.data as ArrayBuffer)[0]).toBe(viewMs);
    expect(new Float64Array(late.data as ArrayBuffer)[0]).toBe(viewMs);
    const queuedOld = await handler({ url: tileUrl() }, new AbortController());
    expect(new Float64Array(queuedOld.data as ArrayBuffer)[0]).toBe(viewMs);
  });

  it('bounds the raw tile count and evicts least recently used entries', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);
    const handler = createViirsAlphaHandler(() => noon, async bytes => bytes);
    for (let x = 0; x <= VIIRS_CACHE_MAX_TILES; x += 1) await handler({ url: tileUrl(x) }, new AbortController());
    await handler({ url: tileUrl(VIIRS_CACHE_MAX_TILES) }, new AbortController());
    expect(fetchMock).toHaveBeenCalledTimes(VIIRS_CACHE_MAX_TILES + 1);
    await handler({ url: tileUrl(0) }, new AbortController());
    expect(fetchMock).toHaveBeenCalledTimes(VIIRS_CACHE_MAX_TILES + 2);
  });

  it('also bounds bytes when tiles are unusually large', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(3 * 1024 * 1024)));
    vi.stubGlobal('fetch', fetchMock);
    const handler = createViirsAlphaHandler(() => noon, async bytes => bytes);
    for (const x of [0, 1, 2, 0]) await handler({ url: tileUrl(x) }, new AbortController());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not cache an upstream failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);
    const handler = createViirsAlphaHandler(() => noon, async bytes => bytes);
    await expect(handler({ url: tileUrl() }, new AbortController())).rejects.toThrow('503');
    await expect(handler({ url: tileUrl() }, new AbortController())).resolves.toHaveProperty('data');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation before a cached transform and after decode work', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const transform = vi.fn(async (bytes: ArrayBuffer) => { controller.abort(); return bytes; });
    const handler = createViirsAlphaHandler(() => noon, transform);
    await expect(handler({ url: tileUrl() }, controller)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(handler({ url: tileUrl() }, controller)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledOnce();
  });

  it('rejects cancellation after fetch and never caches the aborted response', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      controller.abort();
      return new Response(new Uint8Array([1]));
    }).mockResolvedValue(new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);
    const transform = vi.fn(async (bytes: ArrayBuffer) => bytes);
    const handler = createViirsAlphaHandler(() => noon, transform);
    await expect(handler({ url: tileUrl() }, controller)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transform).not.toHaveBeenCalled();
    await handler({ url: tileUrl() }, new AbortController());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('closes decoded bitmaps when canvas creation fails instead of exposing raw opaque tiles', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close })));
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return null; } });
    await expect(renderNightLightsTile(new ArrayBuffer(0), { z: 0, x: 0, y: 0, atMs: noon }, new AbortController().signal))
      .rejects.toThrow('2D canvas');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes decoded bitmaps on success, and passes only masked pixels to PNG encoding', async () => {
    vi.stubGlobal('Image', class { src = ''; async decode() {} });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:night-lights-test', revokeObjectURL: vi.fn() });
    const close = vi.fn();
    const frame = { data: rgba(255), width: 1, height: 1 };
    const put = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close })));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { drawImage() {}, getImageData: () => frame, putImageData: put }; }
      async convertToBlob() { return new Blob([new Uint8Array([1])]); }
    });
    await renderNightLightsTile(new ArrayBuffer(0), { z: 0, x: 0, y: 0, atMs: noon }, new AbortController().signal);
    expect(put).toHaveBeenCalledOnce();
    expect(frame.data[3]).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });
});
