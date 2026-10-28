// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAP_CHUNK_PROBE_TIMEOUT_MS,
  MAP_MODULE_DOWNLOAD_TIMEOUT_MS,
  MAP_MODULE_IDLE_TIMEOUT_MS,
  loadFreshMapModule,
  nextMapImportStep,
  readModuleSource,
} from '../src/map-import';

const dependency = 'https://example.test/assets/maplibre-vendor.js';
const encoder = new TextEncoder();

function streamedResponse(signal: AbortSignal | null | undefined) {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return { response: new Response(stream), body };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('recovery module downloads', () => {
  it('accepts a 200 dependency whose final bytes arrive after the diagnostic 2s budget', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const transfer = streamedResponse(init.signal);
      body = transfer.body;
      body.enqueue(encoder.encode('export const vendor = "'));
      return transfer.response;
    }));
    const result = readModuleSource(dependency);
    const completed = expect(result).resolves.toBe('export const vendor = "ready";');
    await vi.advanceTimersByTimeAsync(2300);
    body.enqueue(encoder.encode('ready";'));
    body.close();
    await completed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets the idle budget on real byte progress and decodes split UTF-8', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const transfer = streamedResponse(init.signal);
      body = transfer.body;
      return transfer.response;
    }));
    const result = readModuleSource(dependency);
    const completed = expect(result).resolves.toBe('export default "🌍";');
    await vi.advanceTimersByTimeAsync(0);
    const bytes = encoder.encode('export default "🌍";');
    body.enqueue(bytes.slice(0, 17));
    await vi.advanceTimersByTimeAsync(MAP_MODULE_IDLE_TIMEOUT_MS - 1);
    body.enqueue(bytes.slice(17, 18));
    await vi.advanceTimersByTimeAsync(MAP_MODULE_IDLE_TIMEOUT_MS - 1);
    body.enqueue(bytes.slice(18));
    body.close();
    await completed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a hung 200 body within the idle budget without consuming reload/Retry state', async () => {
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      requestSignal = init.signal;
      return streamedResponse(init.signal).response;
    }));
    const store = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const result = readModuleSource(dependency);
    const failed = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(MAP_MODULE_IDLE_TIMEOUT_MS - 1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await failed;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
    expect(await nextMapImportStep(error, store, 'https://example.test/', async () => 200))
      .toEqual({ action: 'show-error' });
    expect(store.setItem).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('export default "restored";')));
    await expect(readModuleSource(dependency)).resolves.toBe('export default "restored";');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not count empty body chunks as progress', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const transfer = streamedResponse(init.signal);
      body = transfer.body;
      return transfer.response;
    }));
    const result = readModuleSource(dependency);
    const failed = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(MAP_MODULE_IDLE_TIMEOUT_MS - 1);
    body.enqueue(new Uint8Array());
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps an endless progressing transfer overall', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const transfer = streamedResponse(init.signal);
      body = transfer.body;
      return transfer.response;
    }));
    const result = readModuleSource(dependency);
    const failed = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    for (let elapsed = 0; elapsed < MAP_MODULE_DOWNLOAD_TIMEOUT_MS; elapsed += 1000) {
      body.enqueue(encoder.encode(' '));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the short deadline for a server that never sends headers', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })));
    const result = readModuleSource(dependency);
    const failed = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(MAP_CHUNK_PROBE_TIMEOUT_MS);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('evicts a failed graph load so the same Retry identity can download again', async () => {
    const shell = 'https://example.test/assets/shell.js';
    const entry = 'https://example.test/assets/map.js';
    let hung = true;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url === shell) return new Response('export {};');
      if (url.startsWith(entry)) return new Response('import "./maplibre-vendor.js";');
      return hung ? streamedResponse(init.signal).response : new Response('export const ready = true;');
    });
    vi.stubGlobal('fetch', fetcher);
    const first = loadFreshMapModule(entry, 'same-retry', shell);
    const failed = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(MAP_MODULE_IDLE_TIMEOUT_MS);
    await failed;
    hung = false;
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (!(blob instanceof Blob)) throw new Error('Expected a module Blob');
      blobs.push(blob);
      return 'data:text/javascript,export const ready = true;';
    });
    const retry = loadFreshMapModule<{ ready: boolean }>(entry, 'same-retry', shell);
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toMatchObject({ ready: true });
    expect(await Promise.all(blobs.map((blob) => blob.text())))
      .toContain('export const ready = true;');
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith(dependency))).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
