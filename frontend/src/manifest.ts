import type {
  ArtifactEntry,
  CuratedTarget,
  Manifest,
  PassEntry,
  ProfileArtifactsBlock,
  Status,
  Track,
} from './types';

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

/** Type guard: is this an ArtifactEntry (flat) vs a ProfilesBlock (nested)?
 *  Used by the resolver to disambiguate `manifest.artifacts.<key>` at
 *  runtime since TypeScript can't narrow on the union without help. */
function isArtifactEntry(
  v: ArtifactEntry | ProfileArtifactsBlock | undefined,
): v is ArtifactEntry {
  return typeof v === 'object' && v !== null && 'path' in v && 'sha256' in v;
}

/** Resolve an artifact entry to its canonical or per-profile variant.
 *  Order of precedence (Slot 5 of the design rev 2 — 2026-05-26):
 *    1. If `profileName` is supplied AND the manifest has a `profiles`
 *       block AND that profile has the named artifact → return the
 *       per-profile variant (gets full daemon scoring).
 *    2. Otherwise fall back to the top-level canonical entry.
 *    3. If nothing matches, return null. Callers throw a clear error
 *       at the URL-building / fetch step.
 *
 *  Why the fallback chain: pre-v1.6.7 manifests don't have `profiles`.
 *  v1.6.7 manifests have `profiles` ONLY when the daemon has
 *  `OPD_CALIB_TOKEN` set (the multiplex env-gate). So one operator
 *  could ship a manifest with the block, another without, and the
 *  same frontend code reads either cleanly. The variant is preferred
 *  when present so Jack sees daemon-scored Boston; the canonical is
 *  the safety net so the page never breaks on a missing variant.
 *
 *  Track + targets are profile-agnostic — they always live at top
 *  level only. The resolver still falls through correctly because the
 *  `profiles.<name>` block doesn't contain them.
 *
 *  Exported for testing. Most callers should use the typed fetch
 *  helpers (fetchPasses / fetchStatus / etc.) which thread profile
 *  name + this resolver internally. */
export function resolveArtifactEntry(
  manifest: Manifest,
  name: string,
  profileName?: string,
): ArtifactEntry | null {
  if (profileName) {
    const profilesValue = manifest.artifacts.profiles;
    // profilesValue is `undefined | ArtifactEntry | ProfileArtifactsBlock`
    // because `profiles` shares the same Record value type as every other
    // artifact key. The block is "nested" — its values are themselves
    // objects keyed by profile name. Narrow with `!isArtifactEntry`.
    // Defense: a hand-edited or attacker-tampered manifest might set
    // `profiles: null`. JS quirk: `typeof null === 'object'`, so we need
    // an explicit `!== null` guard before treating it as a block, or
    // the `(profilesValue as ProfileArtifactsBlock)[profileName]` access
    // below would throw TypeError instead of falling through to canonical.
    if (
      profilesValue !== undefined &&
      profilesValue !== null &&
      !isArtifactEntry(profilesValue) &&
      typeof profilesValue === 'object'
    ) {
      const block = (profilesValue as ProfileArtifactsBlock)[profileName];
      if (block && typeof block === 'object' && block[name] && isArtifactEntry(block[name])) {
        return block[name];
      }
    }
  }
  const top = manifest.artifacts[name];
  return isArtifactEntry(top) ? top : null;
}

/** Build the URL for an artifact, preferring per-profile variant when
 *  available. Accepts an optional `profileName`; pass
 *  `getCurrentProfile()?.name` from `main.ts` to get Jack's variant
 *  when on `?u=jack`. */
export function artifactUrl(
  manifest: Manifest,
  name: string,
  baseUrl = '',
  profileName?: string,
): string {
  const entry = resolveArtifactEntry(manifest, name, profileName);
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

export async function fetchArtifact<T>(
  manifest: Manifest,
  name: string,
  baseUrl = '',
  profileName?: string,
): Promise<T> {
  const entry = resolveArtifactEntry(manifest, name, profileName);
  if (!entry) {
    throw new Error(`manifest has no artifact "${name}"`);
  }
  const url = `${baseUrl}/${entry.path}`;
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
  //
  // v1.6.7.0+ slot 5: when profileName is supplied, the entry is the
  // per-profile variant, so the sha256 we check against is the variant's
  // sha256 — not the canonical's. resolveArtifactEntry already returned
  // the right entry, so the verification is automatic.
  const buf = await resp.arrayBuffer();
  const expected = entry.sha256;
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

export async function fetchTop5(
  manifest: Manifest,
  baseUrl = '',
  profileName?: string,
): Promise<PassEntry[]> {
  return fetchArtifact<PassEntry[]>(manifest, 'top5', baseUrl, profileName);
}

/** Top forecast-scored passes for the next ~24 h, excluding ones already in
 *  top5 (the immediate-now queue). Newer manifests (v1.1+) include this; older
 *  ones won't. Returns an empty array if the artifact is missing — callers
 *  should treat absence as "nothing to render," not an error.
 *
 *  v1.6.7.0+ slot 5: when profileName is supplied and the per-profile
 *  variant exists, fetches that one; falls back to canonical otherwise. */
export async function fetchTop24h(
  manifest: Manifest,
  baseUrl = '',
  profileName?: string,
): Promise<PassEntry[]> {
  if (!resolveArtifactEntry(manifest, 'top_24h', profileName)) return [];
  return fetchArtifact<PassEntry[]>(manifest, 'top_24h', baseUrl, profileName);
}

export async function fetchPasses(
  manifest: Manifest,
  baseUrl = '',
  profileName?: string,
): Promise<PassEntry[]> {
  return fetchArtifact<PassEntry[]>(manifest, 'passes', baseUrl, profileName);
}

/** Track (ISS ground-track polynomial + raw SGP4 samples + TLE) is
 *  profile-agnostic — the ISS orbit is the same regardless of which
 *  astronaut is looking. Stays at canonical top-level; no profileName
 *  parameter on this helper. */
export async function fetchTrack(manifest: Manifest, baseUrl = ''): Promise<Track> {
  return fetchArtifact<Track>(manifest, 'track', baseUrl);
}

export async function fetchStatus(
  manifest: Manifest,
  baseUrl = '',
  profileName?: string,
): Promise<Status> {
  return fetchArtifact<Status>(manifest, 'status', baseUrl, profileName);
}

/** Fetch the curated targets catalog (`targets.json`) via the manifest.
 *  v3 — Component C (Anil 2026-05-26): the Profile-tab "Hidden curated"
 *  typeahead needs the catalog to search by name. Curated targets are
 *  profile-agnostic (Anil curates the master list for everyone), so we
 *  don't thread profileName through. Returns [] if the artifact is
 *  missing from the manifest — callers should fall back to the
 *  paste-id flow rather than break the section. */
export async function fetchCuratedTargets(
  manifest: Manifest,
  baseUrl = '',
): Promise<CuratedTarget[]> {
  if (!resolveArtifactEntry(manifest, 'targets')) return [];
  return fetchArtifact<CuratedTarget[]>(manifest, 'targets', baseUrl);
}
