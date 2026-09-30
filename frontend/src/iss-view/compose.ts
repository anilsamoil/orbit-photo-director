import {
  BLACK_MARBLE_2016_TEMPLATE,
  BLUE_MARBLE_TEMPLATE,
  compositeRgba,
  fillTileUrl,
  lightingBucket,
} from '../iss-g1/lighting';
import { subsolarPoint } from '../terminator';

export const ISS_RAW_MAX_BYTES = 48 * 1024 * 1024;
export const ISS_RAW_MAX_ENTRIES = 256;
export const ISS_DERIVED_MAX_BYTES = 32 * 1024 * 1024;
export const ISS_DERIVED_MAX_ENTRIES = 256;
export const ISS_COMPOSE_CONCURRENCY = 2;
export const ISS_TILE_PX = 256;

export type CachePut = 'stored' | 'evicted' | 'rejected';

export type BoundedCache = {
  get(key: string): ArrayBuffer | undefined;
  put(key: string, bytes: ArrayBuffer): CachePut;
  entries(): number;
  bytes(): number;
  has(key: string): boolean;
};

type Slot = { key: string; bytes: ArrayBuffer };

export function createBoundedCache(maxBytes: number, maxEntries: number): BoundedCache {
  const order: Slot[] = [];
  const index = new Map<string, Slot>();

  function drop(key: string): void {
    const slot = index.get(key);
    if (!slot) return;
    index.delete(key);
    const at = order.indexOf(slot);
    if (at >= 0) order.splice(at, 1);
  }

  return {
    get(key) {
      const slot = index.get(key);
      if (!slot) return undefined;
      drop(key);
      order.push(slot);
      index.set(key, slot);
      return slot.bytes;
    },
    put(key, bytes) {
      if (bytes.byteLength > maxBytes || maxEntries < 1) return 'rejected';
      drop(key);
      let evicted = false;
      while (order.length > 0 && (order.length >= maxEntries || used() + bytes.byteLength > maxBytes)) {
        const oldest = order.shift();
        if (!oldest) break;
        index.delete(oldest.key);
        evicted = true;
      }
      if (order.length >= maxEntries || used() + bytes.byteLength > maxBytes) return 'rejected';
      const slot = { key, bytes };
      order.push(slot);
      index.set(key, slot);
      return evicted ? 'evicted' : 'stored';
    },
    entries() {
      return order.length;
    },
    bytes() {
      return used();
    },
    has(key) {
      return index.has(key);
    },
  };

  function used(): number {
    let total = 0;
    for (const slot of order) total += slot.bytes.byteLength;
    return total;
  }
}

export type DecodedTile = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  close: () => void;
};

export type ComposeFailure = 'cancelled' | 'decode' | 'source' | 'offline' | 'size' | 'quota';

export type ComposeResult =
  | { ok: true; rgba: Uint8ClampedArray; width: number; height: number; derived: ArrayBuffer }
  | { ok: false; reason: ComposeFailure; missing?: 'day' | 'night' | 'both' };

export type FetchBytes = (
  url: string,
  signal: AbortSignal,
) => Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; status: number }>;

export type ComposeDeps = {
  fetchBytes: FetchBytes;
  decode: (bytes: ArrayBuffer) => Promise<DecodedTile>;
  encode: (rgba: Uint8ClampedArray, width: number, height: number) => Promise<ArrayBuffer>;
  raw?: BoundedCache;
  derived?: BoundedCache;
  concurrency?: number;
};

export type Composer = {
  compose(z: number, x: number, y: number, bucket: number, signal: AbortSignal): Promise<ComposeResult>;
  rawCache(): BoundedCache;
  derivedCache(): BoundedCache;
  active(): number;
};

export function createComposer(deps: ComposeDeps): Composer {
  const raw = deps.raw ?? createBoundedCache(ISS_RAW_MAX_BYTES, ISS_RAW_MAX_ENTRIES);
  const derived = deps.derived ?? createBoundedCache(ISS_DERIVED_MAX_BYTES, ISS_DERIVED_MAX_ENTRIES);
  const limit = deps.concurrency ?? ISS_COMPOSE_CONCURRENCY;
  const jobs = {
    active: 0,
    waiting: [] as Array<() => void>,
  };

  function acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (jobs.active < limit) {
      jobs.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const start = (): void => {
        signal.removeEventListener('abort', cancel);
        jobs.active += 1;
        resolve();
      };
      const cancel = (): void => {
        const at = jobs.waiting.indexOf(start);
        if (at >= 0) jobs.waiting.splice(at, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', cancel, { once: true });
      jobs.waiting.push(start);
    });
  }

  function release(): void {
    jobs.active -= 1;
    const next = jobs.waiting.shift();
    if (next) next();
  }

  return {
    rawCache: () => raw,
    derivedCache: () => derived,
    active: () => jobs.active,
    async compose(z, x, y, bucket, signal) {
      const key = `${bucket}/${z}/${x}/${y}`;
      const cached = derived.get(key);
      if (cached) {
        try {
          const rgba = await deps.decode(cached);
          try {
            return { ok: true, rgba: rgba.rgba, width: rgba.width, height: rgba.height, derived: cached };
          } finally {
            rgba.close();
          }
        } catch (error) {
          if (isAbort(error)) return { ok: false, reason: 'cancelled' };
          return { ok: false, reason: 'decode' };
        }
      }
      try {
        await acquire(signal);
      } catch (error) {
        if (isAbort(error)) return { ok: false, reason: 'cancelled' };
        throw error;
      }
      try {
        if (signal.aborted) return { ok: false, reason: 'cancelled' };
        const dayUrl = fillTileUrl(BLUE_MARBLE_TEMPLATE, z, x, y);
        const nightUrl = fillTileUrl(BLACK_MARBLE_2016_TEMPLATE, z, x, y);
        const [day, night] = await Promise.all([
          loadRaw(raw, deps, dayUrl, signal),
          loadRaw(raw, deps, nightUrl, signal),
        ]);
        if (signal.aborted) return { ok: false, reason: 'cancelled' };
        const missing = missingSide(day, night);
        if (missing) return { ok: false, reason: failureReason(day, night), missing };
        if (!day.ok || !night.ok) return { ok: false, reason: 'source', missing: 'both' };
        if (day.tile.width !== ISS_TILE_PX || day.tile.height !== ISS_TILE_PX || night.tile.width !== day.tile.width || night.tile.height !== day.tile.height) {
          return { ok: false, reason: 'size' };
        }
        const sunMs = bucket * 60_000;
        const sun = subsolarPoint(new Date(sunMs));
        const rgba = compositeRgba(day.tile.rgba, night.tile.rgba, z, x, y, { latDeg: sun.lat, lonDeg: sun.lon }, ISS_TILE_PX);
        const encoded = await deps.encode(rgba, ISS_TILE_PX, ISS_TILE_PX);
        if (signal.aborted) return { ok: false, reason: 'cancelled' };
        const put = derived.put(key, encoded);
        if (put === 'rejected') return { ok: false, reason: 'quota' };
        return { ok: true, rgba, width: ISS_TILE_PX, height: ISS_TILE_PX, derived: encoded };
      } catch (error) {
        if (isAbort(error)) return { ok: false, reason: 'cancelled' };
        return { ok: false, reason: 'decode' };
      } finally {
        release();
      }
    },
  };
}

export function bucketFor(utcMs: number): number {
  return lightingBucket(utcMs);
}

type Loaded =
  | { ok: true; tile: DecodedTile }
  | { ok: false; reason: ComposeFailure };

async function loadRaw(cache: BoundedCache, deps: ComposeDeps, url: string, signal: AbortSignal): Promise<Loaded> {
  if (signal.aborted) return { ok: false, reason: 'cancelled' };
  let bytes = cache.get(url);
  if (!bytes) {
    let fetched: { ok: true; bytes: ArrayBuffer } | { ok: false; status: number };
    try {
      fetched = await deps.fetchBytes(url, signal);
    } catch (error) {
      if (isAbort(error)) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: 'offline' };
    }
    if (!fetched.ok) return { ok: false, reason: fetched.status === 0 ? 'offline' : 'source' };
    const put = cache.put(url, fetched.bytes);
    if (put === 'rejected') return { ok: false, reason: 'quota' };
    bytes = fetched.bytes;
  }
  let decoded: DecodedTile;
  try {
    decoded = await deps.decode(bytes);
  } catch (error) {
    if (isAbort(error)) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'decode' };
  }
  try {
    if (signal.aborted) return { ok: false, reason: 'cancelled' };
    return { ok: true, tile: decoded };
  } finally {
    decoded.close();
  }
}

function missingSide(day: Loaded, night: Loaded): 'day' | 'night' | 'both' | null {
  if (day.ok && night.ok) return null;
  if (!day.ok && !night.ok) return 'both';
  if (!day.ok) return 'day';
  return 'night';
}

function failureReason(day: Loaded, night: Loaded): ComposeFailure {
  if (!day.ok && day.reason === 'cancelled') return 'cancelled';
  if (!night.ok && night.reason === 'cancelled') return 'cancelled';
  if (!day.ok && day.reason === 'decode') return 'decode';
  if (!night.ok && night.reason === 'decode') return 'decode';
  if (!day.ok && day.reason === 'quota') return 'quota';
  if (!night.ok && night.reason === 'quota') return 'quota';
  if (!day.ok && day.reason === 'offline') return 'offline';
  if (!night.ok && night.reason === 'offline') return 'offline';
  if (!day.ok && day.reason === 'size') return 'size';
  if (!night.ok && night.reason === 'size') return 'size';
  return 'source';
}

function abortError(): DOMException {
  return new DOMException('The lighting tile was cancelled', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
