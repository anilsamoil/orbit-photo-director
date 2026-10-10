import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LaunchCatalogStore } from '../src/launch-catalog';
import { parseLaunchArtifact, parseLaunchCatalogPointer, parseLaunchPointer } from '../src/launch-schema';
import { LaunchStore, LAUNCH_STORAGE_KEY, validateLaunchBytes } from '../src/launch-store';
import { catalog, envelope, iso, NOW } from './launch-fixtures';

beforeEach(() => localStorage.clear());

const jsonHeaders = { 'content-type': 'application/json' };

async function catalogEnvelope(body = catalog()) {
  const text = JSON.stringify(body);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (n) => n.toString(16).padStart(2, '0')).join('');
  const pointer = {
    schema_version: 2 as const,
    revision: body.revision,
    generated_at: body.generated_at,
    valid_until: body.geometry_valid_until,
    path: `launch/catalog/v/${body.revision}.json` as const,
    sha256,
  };
  return { pointer, text };
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return input.url;
}

function catalogFetcher(packed: { pointer: { path: string }; text: string }, pointer = packed.pointer) {
  return vi.fn(async (input: RequestInfo | URL) => new Response(
    requestPath(input) === '/launch/catalog/latest.json' ? JSON.stringify(pointer) : packed.text,
    { status: 200, headers: jsonHeaders },
  ));
}

describe('launch catalog store', () => {
  it('treats an HTML 200 as no catalog and leaves a ready v2 store untouched', async () => {
    const packed = await envelope();
    const v2Fetcher = vi.fn(async (input: RequestInfo | URL) => new Response(
      requestPath(input) === '/launch/latest.json' ? JSON.stringify(packed.pointer) : packed.body,
      { status: 200, headers: jsonHeaders },
    ));
    const v2 = new LaunchStore(v2Fetcher);
    await v2.refresh();
    expect(v2.getState().availability).toBe('ready');
    const stateBefore = JSON.stringify(v2.getState());
    const stored = localStorage.getItem(LAUNCH_STORAGE_KEY);
    expect(stored).toContain(packed.pointer.revision);
    v2Fetcher.mockClear();
    const fetcher = vi.fn(async () => new Response('<!doctype html><html><body>missing</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    const store = new LaunchCatalogStore(fetcher);
    await expect(store.refresh(true)).resolves.toBeUndefined();
    expect(store.read(NOW)).toBeNull();
    expect(JSON.stringify(v2.getState())).toBe(stateBefore);
    expect(localStorage.getItem(LAUNCH_STORAGE_KEY)).toBe(stored);
    expect(v2Fetcher).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith('/launch/catalog/latest.json', expect.objectContaining({
      cache: 'no-store',
      redirect: 'error',
      credentials: 'same-origin',
    }));
  });

  it('treats a 200 text/plain body as no catalog', async () => {
    const store = new LaunchCatalogStore(vi.fn(async () => new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })));
    await expect(store.refresh(true)).resolves.toBeUndefined();
    expect(store.read(NOW)).toBeNull();
  });

  it('rejects a non-object JSON body and a leading angle bracket', async () => {
    const arrayStore = new LaunchCatalogStore(vi.fn(async () => new Response('[]', { status: 200, headers: jsonHeaders })));
    await arrayStore.refresh(true);
    expect(arrayStore.read(NOW)).toBeNull();
    const markup = new LaunchCatalogStore(vi.fn(async () => new Response('  <html></html>', {
      status: 200,
      headers: jsonHeaders,
    })));
    await markup.refresh(true);
    expect(markup.read(NOW)).toBeNull();
  });

  it('holds a schema 3 body addressed by the catalog pointer', async () => {
    const packed = await catalogEnvelope();
    const fetcher = catalogFetcher(packed);
    const store = new LaunchCatalogStore(fetcher);
    await store.refresh(true);
    const tiers = store.read(NOW);
    expect(tiers?.groups.watch.map((launch) => launch.eventId)).toEqual(['event-1']);
    expect(tiers?.pins).toEqual([]);
    expect(fetcher).toHaveBeenCalledWith(`/${packed.pointer.path}`, expect.objectContaining({ cache: 'force-cache' }));
    expect(parseLaunchCatalogPointer(packed.pointer).path).toBe('launch/catalog/v/r1.json');
    expect(() => parseLaunchPointer(packed.pointer)).toThrow();
    expect(() => parseLaunchCatalogPointer({ ...packed.pointer, path: 'launch/v/r1.json' })).toThrow();
  });

  it('does not hold a schema 2 body or a hash mismatch', async () => {
    const v2 = await envelope();
    const pointer = {
      ...v2.pointer,
      path: `launch/catalog/v/${v2.pointer.revision}.json` as const,
    };
    const schema2 = new LaunchCatalogStore(vi.fn(async (input: RequestInfo | URL) => new Response(
      requestPath(input) === '/launch/catalog/latest.json' ? JSON.stringify(pointer) : v2.body,
      { status: 200, headers: jsonHeaders },
    )));
    await schema2.refresh(true);
    expect(schema2.read(NOW)).toBeNull();
    const packed = await catalogEnvelope();
    const mismatch = new LaunchCatalogStore(vi.fn(async (input: RequestInfo | URL) => new Response(
      requestPath(input) === '/launch/catalog/latest.json' ? JSON.stringify(packed.pointer) : `${packed.text} `,
      { status: 200, headers: jsonHeaders },
    )));
    await mismatch.refresh(true);
    expect(mismatch.read(NOW)).toBeNull();
    await expect(validateLaunchBytes(packed.pointer, new TextEncoder().encode(`${packed.text} `).buffer)).rejects.toThrow(/hash/i);
  });

  it('ignores an older pointer and drops the hold when the pointer changes during download', async () => {
    const current = await catalogEnvelope(catalog([], { revision: 'r2', generated_at: iso(-1) }));
    const older = await catalogEnvelope(catalog([], { revision: 'r1', generated_at: iso(-5) }));
    const next = await catalogEnvelope(catalog([], { revision: 'r3', generated_at: iso(0) }));
    const later = await catalogEnvelope(catalog([], { revision: 'r4', generated_at: iso(0) }));
    let phase: 'current' | 'older' | 'race' = 'current';
    let raceReads = 0;
    const store = new LaunchCatalogStore(vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input);
      const packed = phase === 'older' ? older : current;
      if (path === '/launch/catalog/latest.json') {
        if (phase === 'race') {
          raceReads += 1;
          const pointer = raceReads === 1 ? next.pointer : later.pointer;
          return new Response(JSON.stringify(pointer), { status: 200, headers: jsonHeaders });
        }
        return new Response(JSON.stringify(packed.pointer), { status: 200, headers: jsonHeaders });
      }
      const body = phase === 'race' ? next.text : packed.text;
      return new Response(body, { status: 200, headers: jsonHeaders });
    }));
    await store.refresh(true);
    expect(store.read(NOW)?.revision).toBe('r2');
    phase = 'older';
    await store.refresh(true);
    expect(store.read(NOW)?.revision).toBe('r2');
    phase = 'race';
    await store.refresh(true);
    expect(store.read(NOW)).toBeNull();
    expect(raceReads).toBe(2);
  });

  it('aborts only its own request when refresh is offline', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const store = new LaunchCatalogStore(fetcher);
    const pending = store.refresh(true);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await expect(store.refresh(false)).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    await pending;
    expect(store.read(NOW)).toBeNull();
  });

  it('treats a pointer 404 as a miss', async () => {
    const store = new LaunchCatalogStore(vi.fn(async () => new Response('', { status: 404 })));
    await store.refresh(true);
    expect(store.read(NOW)).toBeNull();
  });

  it('reads null when one lease is spent and when both are spent', async () => {
    const geometry = await catalogEnvelope(catalog([], { geometry_valid_until: iso(-1) }));
    const geometryStore = new LaunchCatalogStore(catalogFetcher(geometry));
    await geometryStore.refresh(true);
    expect(geometryStore.read(NOW)).toBeNull();
    expect(geometryStore.read(Date.parse(iso(-2)))?.revision).toBe('r1');
    const schedule = await catalogEnvelope(catalog([], { schedule_valid_until: iso(-1) }));
    const scheduleStore = new LaunchCatalogStore(catalogFetcher(schedule));
    await scheduleStore.refresh(true);
    expect(scheduleStore.read(NOW)).toBeNull();
    expect(scheduleStore.read(Date.parse(iso(-2)))?.revision).toBe('r1');
    const both = await catalogEnvelope(catalog([], { geometry_valid_until: iso(-1), schedule_valid_until: iso(-1) }));
    const bothStore = new LaunchCatalogStore(catalogFetcher(both));
    await bothStore.refresh(true);
    expect(bothStore.read(NOW)).toBeNull();
    expect(bothStore.read(Date.parse(iso(-2)))?.revision).toBe('r1');
  });

  it('ticks only when the read signature changes', async () => {
    const packed = await catalogEnvelope();
    const store = new LaunchCatalogStore(catalogFetcher(packed));
    await store.refresh(true);
    store.tick(NOW);
    let notes = 0;
    store.subscribe(() => { notes += 1; });
    store.tick(NOW);
    expect(notes).toBe(0);
    store.tick(Date.parse(catalog().geometry_valid_until));
    expect(notes).toBe(1);
    store.tick(Date.parse(catalog().geometry_valid_until) + 1_000);
    expect(notes).toBe(1);
  });

  it('keeps launch/catalog out of the v2 store and storage out of the catalog module', () => {
    const storeText = readFileSync(resolve('src/launch-store.ts'), 'utf8');
    const catalogText = readFileSync(resolve('src/launch-catalog.ts'), 'utf8');
    const cardText = readFileSync(resolve('src/launch-tier-card.ts'), 'utf8');
    expect(storeText).not.toContain('launch/catalog');
    expect(catalogText).not.toContain('localStorage');
    expect(catalogText).not.toContain('opd-');
    expect(cardText).not.toContain('selectLaunches');
    expect(parseLaunchArtifact(catalog()).schema_version).toBe(3);
  });
});
