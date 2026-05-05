import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  artifactUrl,
  fetchArtifact,
  fetchManifest,
} from '../src/manifest';
import type { Manifest } from '../src/types';

const SAMPLE_MANIFEST: Manifest = {
  version: '20241017T120000Z',
  generated_at: '2024-10-17T12:00:00Z',
  tle_epoch: '2024-10-17T00:00:00Z',
  cloud_composite_hour: '2024-10-17T11:00:00Z',
  target_data_version: 'v1',
  build_version: '0.1.0',
  freshness: { tle_hours: 12, cloud_hours: 1, ok: true },
  artifacts: {
    passes: { path: 'v/20241017T120000Z/passes.json', sha256: 'a'.repeat(64), bytes: 100 },
    top5: { path: 'v/20241017T120000Z/top5.json', sha256: 'b'.repeat(64), bytes: 50 },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('artifactUrl', () => {
  it('returns the version-tagged path', () => {
    expect(artifactUrl(SAMPLE_MANIFEST, 'passes')).toBe('/v/20241017T120000Z/passes.json');
  });

  it('throws on unknown artifact', () => {
    expect(() => artifactUrl(SAMPLE_MANIFEST, 'nope')).toThrow();
  });

  it('respects baseUrl prefix', () => {
    expect(artifactUrl(SAMPLE_MANIFEST, 'top5', 'https://x.dev')).toBe(
      'https://x.dev/v/20241017T120000Z/top5.json'
    );
  });
});

describe('fetchManifest', () => {
  it('fetches and parses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(SAMPLE_MANIFEST), { status: 200 }))
    );
    const m = await fetchManifest();
    expect(m.version).toBe('20241017T120000Z');
  });

  it('throws on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('notfound', { status: 404 }))
    );
    await expect(fetchManifest()).rejects.toThrow(/manifest fetch failed/);
  });

  it('uses cache:no-cache to force revalidation (no query-string buster)', async () => {
    // Why no ?cb= buster: the SW NetworkFirst rule for manifest.json does exact
    // URL matching, so a unique query string per request would never hit the
    // cache offline. `cache: 'no-cache'` already forces a conditional revalidate.
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(SAMPLE_MANIFEST), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchManifest();
    const calls: unknown[][] = fetchMock.mock.calls as unknown[][];
    expect(calls.length).toBeGreaterThan(0);
    const url = String(calls[0]?.[0]);
    const init = calls[0]?.[1] as RequestInit | undefined;
    expect(url).toBe('/manifest.json');
    expect(init?.cache).toBe('no-cache');
  });
});

describe('fetchArtifact', () => {
  it('dereferences manifest path and parses JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([{ x: 1 }]), { status: 200 }))
    );
    const r = await fetchArtifact<{ x: number }[]>(SAMPLE_MANIFEST, 'passes');
    expect(r[0]!.x).toBe(1);
  });

  it('propagates fetch errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    await expect(fetchArtifact(SAMPLE_MANIFEST, 'passes')).rejects.toThrow();
  });
});
