import type { Manifest, PassEntry, Status, Track } from './types';

/** Fetch manifest.json from the site root and dereference an artifact by logical name. */
export async function fetchManifest(baseUrl = ''): Promise<Manifest> {
  // No ?cb= buster: `cache: 'no-cache'` already forces revalidation, and a
  // unique query string would defeat the SW's NetworkFirst manifest rule
  // (Workbox does exact URL matching by default → cached entry never matches
  // a new ?cb= value, so the offline second-line-of-defense never fires).
  const url = `${baseUrl}/manifest.json`;
  const resp = await fetch(url, { cache: 'no-cache' });
  if (!resp.ok) {
    throw new Error(`manifest fetch failed: ${resp.status}`);
  }
  return (await resp.json()) as Manifest;
}

export function artifactUrl(manifest: Manifest, name: string, baseUrl = ''): string {
  const entry = manifest.artifacts[name];
  if (!entry) {
    throw new Error(`manifest has no artifact "${name}"`);
  }
  return `${baseUrl}/${entry.path}`;
}

/** Hex-encode a SHA-256 digest ArrayBuffer. */
function hexDigest(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) {
    const v = b.toString(16);
    hex += v.length === 1 ? '0' + v : v;
  }
  return hex;
}

export async function fetchArtifact<T>(manifest: Manifest, name: string, baseUrl = ''): Promise<T> {
  const url = artifactUrl(manifest, name, baseUrl);
  const resp = await fetch(url, { cache: 'force-cache' }); // versioned path → safe to cache long
  if (!resp.ok) {
    throw new Error(`artifact ${name} fetch failed: ${resp.status}`);
  }
  // v1.4.5.0: verify the artifact's bytes match the sha256 declared in the
  // manifest before we parse + use it. Defends against (a) partial R2 deploy
  // where the manifest is uploaded before its artifacts settle, (b) a
  // corrupted `force-cache` entry for a versioned URL after a republish
  // collision, (c) any path-level compromise (a tampered artifact at the
  // declared URL would have a different hash). The existing transactional
  // refresh in main.ts treats fetchArtifact failures as "stay on previous
  // snapshot," so a hash mismatch degrades gracefully to the prior good
  // state rather than poisoning the UI with wrong data.
  const buf = await resp.arrayBuffer();
  const expected = manifest.artifacts[name]?.sha256;
  if (expected) {
    // SubtleCrypto requires HTTPS / localhost. map.astroanil.dev is HTTPS;
    // tests run in happy-dom where crypto.subtle is provided.
    const actualBuf = await crypto.subtle.digest('SHA-256', buf);
    const actual = hexDigest(actualBuf);
    if (actual !== expected) {
      throw new Error(
        `artifact ${name} sha256 mismatch: expected ${expected.slice(0, 12)}… got ${actual.slice(0, 12)}…`,
      );
    }
  }
  const text = new TextDecoder('utf-8').decode(buf);
  return JSON.parse(text) as T;
}

export async function fetchTop5(manifest: Manifest, baseUrl = ''): Promise<PassEntry[]> {
  return fetchArtifact<PassEntry[]>(manifest, 'top5', baseUrl);
}

/** Top forecast-scored passes for the next ~24 h, excluding ones already in
 *  top5 (the immediate-now queue). Newer manifests (v1.1+) include this; older
 *  ones won't. Returns an empty array if the artifact is missing — callers
 *  should treat absence as "nothing to render," not an error. */
export async function fetchTop24h(manifest: Manifest, baseUrl = ''): Promise<PassEntry[]> {
  if (!manifest.artifacts.top_24h) return [];
  return fetchArtifact<PassEntry[]>(manifest, 'top_24h', baseUrl);
}

export async function fetchPasses(manifest: Manifest, baseUrl = ''): Promise<PassEntry[]> {
  return fetchArtifact<PassEntry[]>(manifest, 'passes', baseUrl);
}

export async function fetchTrack(manifest: Manifest, baseUrl = ''): Promise<Track> {
  return fetchArtifact<Track>(manifest, 'track', baseUrl);
}

export async function fetchStatus(manifest: Manifest, baseUrl = ''): Promise<Status> {
  return fetchArtifact<Status>(manifest, 'status', baseUrl);
}
