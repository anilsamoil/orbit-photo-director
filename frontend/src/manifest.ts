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

export async function fetchArtifact<T>(manifest: Manifest, name: string, baseUrl = ''): Promise<T> {
  const url = artifactUrl(manifest, name, baseUrl);
  const resp = await fetch(url, { cache: 'force-cache' }); // versioned path → safe to cache long
  if (!resp.ok) {
    throw new Error(`artifact ${name} fetch failed: ${resp.status}`);
  }
  return (await resp.json()) as T;
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
