import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  artifactUrl,
  fetchArtifact,
  fetchManifest,
  resolveArtifactEntry,
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

// Compute the real sha256 hex of a body string. Used by fetchArtifact tests
// so they can build a manifest whose declared hash matches the response.
async function sha256Hex(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('fetchArtifact', () => {
  it('dereferences manifest path and parses JSON when sha256 matches', async () => {
    const body = JSON.stringify([{ x: 1 }]);
    const hash = await sha256Hex(body);
    const manifest: Manifest = {
      ...SAMPLE_MANIFEST,
      artifacts: { passes: { path: 'v/2024/passes.json', sha256: hash, bytes: body.length } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const r = await fetchArtifact<{ x: number }[]>(manifest, 'passes');
    expect(r[0]!.x).toBe(1);
  });

  it('propagates fetch errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    await expect(fetchArtifact(SAMPLE_MANIFEST, 'passes')).rejects.toThrow();
  });

  it('throws when the response body sha256 does not match the manifest', async () => {
    // SAMPLE_MANIFEST declares sha256: 'aaaa…' but the body hash is different.
    const body = JSON.stringify([{ x: 1 }]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    await expect(fetchArtifact(SAMPLE_MANIFEST, 'passes')).rejects.toThrow(/sha256 mismatch/);
  });

  it('skips verification when the manifest entry has no sha256 (defensive)', async () => {
    // Older manifests or third-party-published artifacts might omit sha256.
    // The verify step should treat missing-hash as "trust", not crash.
    const body = JSON.stringify([{ x: 1 }]);
    const manifest: Manifest = {
      ...SAMPLE_MANIFEST,
      artifacts: { passes: { path: 'v/2024/passes.json', sha256: '', bytes: body.length } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const r = await fetchArtifact<{ x: number }[]>(manifest, 'passes');
    expect(r[0]!.x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactEntry + per-profile variant selection (Slot 5, v1.6.7.0+)
//
// The daemon multiplexer (slot 4) emits per-astronaut variant artifacts
// nested under `manifest.artifacts.profiles.<name>`. The resolver picks
// the variant when a profileName is supplied AND the manifest declares it;
// falls back to the canonical top-level entry otherwise. Tests pin every
// branch of that decision so a future refactor can't silently break
// Jack's view by dropping a fallback path.
// ---------------------------------------------------------------------------

const MANIFEST_WITH_PROFILES: Manifest = {
  version: '20260526T120000Z',
  generated_at: '2026-05-26T12:00:00Z',
  tle_epoch: '2026-05-26T00:00:00Z',
  cloud_composite_hour: '2026-05-26T11:00:00Z',
  target_data_version: 'v1',
  build_version: '1.6.7.0',
  freshness: { tle_hours: 12, cloud_hours: 1, ok: true },
  artifacts: {
    // Canonical (= anil) artifacts at top level
    passes: { path: 'v/2026/passes.json', sha256: 'a'.repeat(64), bytes: 100 },
    status: { path: 'v/2026/status.json', sha256: 'c'.repeat(64), bytes: 200 },
    top5: { path: 'v/2026/top5.json', sha256: 'd'.repeat(64), bytes: 50 },
    top_24h: { path: 'v/2026/top_24h.json', sha256: 'e'.repeat(64), bytes: 300 },
    track: { path: 'v/2026/track.json', sha256: 'f'.repeat(64), bytes: 400 },
    // Per-profile variants nested. Jack has all four; Chris has only
    // passes + status (sparse profile — tests the "fall through for
    // missing variant" path).
    profiles: {
      anil: {
        passes: { path: 'v/2026/passes_anil.json', sha256: '1'.repeat(64), bytes: 100 },
        status: { path: 'v/2026/status_anil.json', sha256: '2'.repeat(64), bytes: 200 },
        top5: { path: 'v/2026/top5_anil.json', sha256: '3'.repeat(64), bytes: 50 },
        top_24h: { path: 'v/2026/top_24h_anil.json', sha256: '4'.repeat(64), bytes: 300 },
      },
      jack: {
        passes: { path: 'v/2026/passes_jack.json', sha256: '5'.repeat(64), bytes: 110 },
        status: { path: 'v/2026/status_jack.json', sha256: '6'.repeat(64), bytes: 210 },
        top5: { path: 'v/2026/top5_jack.json', sha256: '7'.repeat(64), bytes: 60 },
        top_24h: { path: 'v/2026/top_24h_jack.json', sha256: '8'.repeat(64), bytes: 310 },
      },
      chris: {
        passes: { path: 'v/2026/passes_chris.json', sha256: '9'.repeat(64), bytes: 105 },
        status: { path: 'v/2026/status_chris.json', sha256: 'a'.repeat(64), bytes: 205 },
        // Note: no top5 / top_24h for chris — tests sparse-variant fallback
      },
    },
  },
};

describe('resolveArtifactEntry', () => {
  it('returns top-level entry when no profileName supplied', () => {
    const entry = resolveArtifactEntry(MANIFEST_WITH_PROFILES, 'passes');
    expect(entry?.path).toBe('v/2026/passes.json');
    expect(entry?.sha256).toBe('a'.repeat(64));
  });

  it('returns the per-profile variant when supplied + variant exists', () => {
    const entry = resolveArtifactEntry(MANIFEST_WITH_PROFILES, 'passes', 'jack');
    expect(entry?.path).toBe('v/2026/passes_jack.json');
    expect(entry?.sha256).toBe('5'.repeat(64));
  });

  it('falls back to top-level when the named profile has no variant for this artifact', () => {
    // Chris doesn't have a top5 variant — resolver should hit canonical.
    const entry = resolveArtifactEntry(MANIFEST_WITH_PROFILES, 'top5', 'chris');
    expect(entry?.path).toBe('v/2026/top5.json');
    expect(entry?.sha256).toBe('d'.repeat(64));
  });

  it('falls back to top-level when the profile name is unknown', () => {
    // Someone visits ?u=newbie before their profile has been seeded.
    const entry = resolveArtifactEntry(MANIFEST_WITH_PROFILES, 'passes', 'newbie');
    expect(entry?.path).toBe('v/2026/passes.json');
  });

  it('falls back to top-level when the manifest has no profiles block (pre-v1.6.7)', () => {
    const entry = resolveArtifactEntry(SAMPLE_MANIFEST, 'passes', 'jack');
    expect(entry?.path).toBe('v/20241017T120000Z/passes.json');
  });

  it('returns null when the artifact does not exist at top level either', () => {
    expect(resolveArtifactEntry(MANIFEST_WITH_PROFILES, 'nope')).toBeNull();
    expect(resolveArtifactEntry(MANIFEST_WITH_PROFILES, 'nope', 'jack')).toBeNull();
  });

  it('tolerates manifest.artifacts.profiles === null without throwing', () => {
    // JS quirk: typeof null === 'object'. A hand-edited or tampered
    // manifest with profiles=null would crash the resolver if we didn't
    // explicitly guard. Falls through to canonical instead.
    const manifest: Manifest = {
      ...SAMPLE_MANIFEST,
      artifacts: {
        passes: { path: 'v/2024/passes.json', sha256: 'a'.repeat(64), bytes: 100 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        profiles: null as any,
      },
    };
    const entry = resolveArtifactEntry(manifest, 'passes', 'jack');
    expect(entry?.path).toBe('v/2024/passes.json');
  });

  it('tolerates a profile entry that is not an object (corrupted block)', () => {
    // Defensive: if someone wrote `profiles: { jack: "garbage" }`, the
    // resolver should not crash on `block[name]` access.
    const manifest: Manifest = {
      ...SAMPLE_MANIFEST,
      artifacts: {
        passes: { path: 'v/2024/passes.json', sha256: 'a'.repeat(64), bytes: 100 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        profiles: { jack: 'corrupted' as any },
      },
    };
    const entry = resolveArtifactEntry(manifest, 'passes', 'jack');
    expect(entry?.path).toBe('v/2024/passes.json');
  });

  it('returns variant sha256 (not canonical) when picking a variant', () => {
    // Defense: if we mistakenly returned canonical's sha256 with the
    // variant's URL, fetchArtifact would throw sha256 mismatch on every
    // load. Lock this contract.
    const entry = resolveArtifactEntry(MANIFEST_WITH_PROFILES, 'status', 'jack');
    expect(entry?.sha256).toBe('6'.repeat(64));
    expect(entry?.sha256).not.toBe('c'.repeat(64));
  });
});

describe('artifactUrl with profileName', () => {
  it('builds the variant URL when supplied', () => {
    expect(
      artifactUrl(MANIFEST_WITH_PROFILES, 'passes', '', 'jack'),
    ).toBe('/v/2026/passes_jack.json');
  });

  it('builds the canonical URL when profileName omitted', () => {
    expect(artifactUrl(MANIFEST_WITH_PROFILES, 'passes')).toBe('/v/2026/passes.json');
  });

  it('respects baseUrl with profileName', () => {
    expect(
      artifactUrl(MANIFEST_WITH_PROFILES, 'top5', 'https://x.dev', 'jack'),
    ).toBe('https://x.dev/v/2026/top5_jack.json');
  });

  it('throws on unknown artifact even with profileName', () => {
    expect(() => artifactUrl(MANIFEST_WITH_PROFILES, 'nope', '', 'jack')).toThrow();
  });
});

describe('fetchArtifact with profileName', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies the VARIANT sha256, not the canonical', async () => {
    // Body matches jack's variant sha256 — should accept.
    // The mock returns the same body for any URL; if the resolver were
    // picking canonical, sha256 check would fail because canonical
    // expects a different hash.
    const body = JSON.stringify([{ target_id: 'personal:jack:boston' }]);
    const expectedHash = await sha256Hex(body);
    const manifest: Manifest = {
      ...MANIFEST_WITH_PROFILES,
      artifacts: {
        ...MANIFEST_WITH_PROFILES.artifacts,
        passes: { path: 'v/2026/passes.json', sha256: 'wrong'.repeat(13), bytes: body.length },
        profiles: {
          jack: {
            passes: { path: 'v/2026/passes_jack.json', sha256: expectedHash, bytes: body.length },
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    // Should succeed — variant hash matches.
    const result = await fetchArtifact(manifest, 'passes', '', 'jack');
    expect(result).toEqual([{ target_id: 'personal:jack:boston' }]);
  });

  it('falls back to canonical when profile has no variant for this artifact', async () => {
    const body = JSON.stringify([{ x: 1 }]);
    const hash = await sha256Hex(body);
    const manifest: Manifest = {
      ...SAMPLE_MANIFEST,
      artifacts: {
        passes: { path: 'v/2024/passes.json', sha256: hash, bytes: body.length },
        profiles: {
          chris: {
            // chris has no `passes` variant — resolver falls back to canonical
            status: { path: 'v/2024/status_chris.json', sha256: 'a'.repeat(64), bytes: 50 },
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const result = await fetchArtifact(manifest, 'passes', '', 'chris');
    expect(result).toEqual([{ x: 1 }]);
  });

  it('falls back to canonical when manifest has no profiles block at all', async () => {
    const body = JSON.stringify([{ x: 1 }]);
    const hash = await sha256Hex(body);
    const manifest: Manifest = {
      ...SAMPLE_MANIFEST,
      artifacts: {
        passes: { path: 'v/2024/passes.json', sha256: hash, bytes: body.length },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    // Profile name is supplied but irrelevant — no profiles block.
    const result = await fetchArtifact(manifest, 'passes', '', 'jack');
    expect(result).toEqual([{ x: 1 }]);
  });

  it('throws when neither variant nor canonical artifact exists', async () => {
    await expect(
      fetchArtifact(MANIFEST_WITH_PROFILES, 'doesnt-exist', '', 'jack'),
    ).rejects.toThrow(/has no artifact/);
  });
});

