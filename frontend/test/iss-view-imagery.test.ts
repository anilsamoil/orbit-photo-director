import { describe, expect, it } from 'vitest';

import {
  createBoundedCache,
  createComposer,
  type DecodedTile,
} from '../src/iss-view/compose';

const TILE = 256;

function pixels(value: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0; i < TILE * TILE; i += 1) {
    rgba[i * 4] = value;
    rgba[i * 4 + 1] = value;
    rgba[i * 4 + 2] = value;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function tile(value: number, closed: { n: number }): DecodedTile {
  return {
    rgba: pixels(value),
    width: TILE,
    height: TILE,
    close: () => {
      closed.n += 1;
    },
  };
}

function encoded(): ArrayBuffer {
  return new Uint8Array([4, 5, 6, 7]).buffer;
}

describe('ISS tile cache', () => {
  it('evicts the oldest entry and rejects a buffer larger than the budget', () => {
    const entries = createBoundedCache(5, 10);
    expect(entries.put('a', new Uint8Array(3).buffer)).toBe('stored');
    expect(entries.put('b', new Uint8Array(3).buffer)).toBe('evicted');
    expect(entries.has('a')).toBe(false);
    expect(entries.bytes()).toBe(3);
    const count = createBoundedCache(100, 2);
    expect(count.put('a', new Uint8Array([1]).buffer)).toBe('stored');
    expect(count.put('b', new Uint8Array([2]).buffer)).toBe('stored');
    expect(count.put('c', new Uint8Array([3]).buffer)).toBe('evicted');
    expect(count.has('a')).toBe(false);
    expect(count.entries()).toBe(2);
    const quota = createBoundedCache(4, 8);
    expect(quota.put('big', new Uint8Array(8).buffer)).toBe('rejected');
    expect(quota.entries()).toBe(0);
  });
});

describe('ISS tile composition', () => {
  it('mixes both marbles, caches the raw bytes, and closes each bitmap', async () => {
    const closed = { n: 0 };
    let fetches = 0;
    const composer = createComposer({
      fetchBytes: async (url) => {
        fetches += 1;
        const value = url.includes('BlueMarble') ? 20 : 200;
        return { ok: true, bytes: new Uint8Array([value]).buffer };
      },
      decode: async (bytes) => tile(new Uint8Array(bytes)[0] ?? 0, closed),
      encode: async () => encoded(),
    });
    const signal = new AbortController().signal;
    const first = await composer.compose(0, 0, 0, 10, signal);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.width).toBe(256);
    expect(first.height).toBe(256);
    expect(new Uint8Array(first.derived)).toEqual(new Uint8Array([4, 5, 6, 7]));
    expect(first.rgba[3]).toBe(255);
    expect(Array.from(new Uint8Array(first.derived))).toEqual([4, 5, 6, 7]);
    expect(closed.n).toBe(2);
    expect(fetches).toBe(2);
    const again = await composer.compose(0, 0, 0, 11, signal);
    expect(again.ok).toBe(true);
    expect(fetches).toBe(2);
    expect(composer.rawCache().entries()).toBe(2);
  });

  it('cancels an in-flight job and a queued job without decoding', async () => {
    const closed = { n: 0 };
    const composer = createComposer({
      concurrency: 2,
      fetchBytes: (_url, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      }),
      decode: async () => tile(1, closed),
      encode: async () => encoded(),
    });
    const first = new AbortController();
    const second = new AbortController();
    const third = new AbortController();
    const pending = [
      composer.compose(0, 0, 0, 1, first.signal),
      composer.compose(0, 1, 0, 1, second.signal),
      composer.compose(0, 2, 0, 1, third.signal),
    ];
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
    expect(composer.active()).toBe(2);
    third.abort();
    const queued = await pending[2];
    expect(queued).toEqual({ ok: false, reason: 'cancelled' });
    expect(composer.active()).toBe(2);
    first.abort();
    const cancelled = await pending[0];
    expect(cancelled?.ok).toBe(false);
    if (cancelled && !cancelled.ok) expect(cancelled.reason).toBe('cancelled');
    second.abort();
    await pending[1];
    expect(closed.n).toBe(0);
  });

  it('reports a decode failure and a single missing source without returning the original bytes', async () => {
    const broken = createComposer({
      fetchBytes: async () => ({ ok: true, bytes: new Uint8Array([9, 9, 9]).buffer }),
      decode: async () => {
        throw new Error('bad image');
      },
      encode: async () => encoded(),
    });
    const failed = await broken.compose(0, 0, 0, 1, new AbortController().signal);
    expect(failed).toEqual({ ok: false, reason: 'decode', missing: 'both' });

    const partial = createComposer({
      fetchBytes: async (url) => {
        if (url.includes('BlueMarble')) return { ok: false, status: 404 };
        return { ok: true, bytes: new Uint8Array([1]).buffer };
      },
      decode: async () => tile(1, { n: 0 }),
      encode: async () => encoded(),
    });
    const degraded = await partial.compose(0, 0, 0, 1, new AbortController().signal);
    expect(degraded).toEqual({ ok: false, reason: 'source', missing: 'day' });
  });

  it('reports offline when the fetch throws and does not store a derived tile', async () => {
    const composer = createComposer({
      fetchBytes: async () => {
        throw new TypeError('network');
      },
      decode: async () => tile(1, { n: 0 }),
      encode: async () => encoded(),
    });
    const result = await composer.compose(0, 0, 0, 1, new AbortController().signal);
    expect(result).toEqual({ ok: false, reason: 'offline', missing: 'both' });
    expect(composer.derivedCache().entries()).toBe(0);
  });
});
