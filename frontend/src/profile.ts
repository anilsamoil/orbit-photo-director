/** Per-astronaut profile layer (Slot 1 of design rev 2 — 2026-05-26).
 *
 *  Each astronaut (Chris, Jack, Anil, ...) gets a localStorage-namespaced
 *  profile that holds their personal target list, hide-from-curated list,
 *  preferences, and an instant-buffer for targets added between daemon
 *  ticks. Profile identity is URL-routed (`?u=jack`), not Settings-buried,
 *  so per-astronaut manifest fetches in later slots can route correctly.
 *
 *  This slot ships data model + URL routing ONLY. No UI, no Worker API,
 *  no daemon multiplex — those land in later slots. The existing rendering
 *  pipeline keeps working unchanged; slot 5 wires the variant manifest
 *  fetch that consumes the profile name.
 */

/** Per-profile schema. Versioned for migration safety (premise 8 of the
 *  design doc). Bump `version` + add a migrator in MIGRATIONS when the
 *  shape changes. */
export interface Profile {
  /** Schema version. Migrations chain runs `version → version+1` until
   *  CURRENT_VERSION on every load. */
  version: number;
  /** URL-safe identifier. Must match the `?u=<name>` query param + the
   *  R2 path `profiles/<name>/targets.json` in later slots. */
  name: string;
  /** Personal targets the operator adds. In slot 6+ these mirror to the
   *  Worker API; in slot 1 they're localStorage-only. Each entry holds
   *  the same fields a curated target carries (name, lat, lon, optional
   *  priority) so the daemon can score them identically in slot 4. */
  additions: PersonalTarget[];
  /** Curated target IDs the operator has chosen to hide from their view.
   *  Renders apply this as a filter against the curated 137. v2 may add
   *  per-target version-fingerprint matching to handle curated renames. */
  removedCuratedIds: string[];
  /** Distance horizon for the queue/upcoming filter (km). 1500 km matches
   *  the existing ISS_HORIZON_KM. Lower values prune oblique grazing
   *  passes. v1: hidden in the Profile tab settings panel (Slot 7). */
  distanceThresholdKm: number;
  /** Targets the operator added between the most recent daemon tick and
   *  now. Computed client-side via the existing pin-drop SGP4 walk
   *  (Slot 5). Once the daemon picks them up on a later tick, they
   *  migrate out of `instantBuffer` and merge into the manifest-served
   *  passes. v1 ships with this empty — the merge logic is Slot 5. */
  instantBuffer: PersonalTarget[];
}

/** A target a single astronaut added (not curated by Anil). The shape
 *  mirrors the curated `targets.json` entry so the daemon's scoring loop
 *  can iterate over union(curated, additions) without special-casing. */
export interface PersonalTarget {
  /** Stable identifier. Generated client-side when the operator creates
   *  the target. Format: `personal:<profile-name>:<uuid>`. Never reused
   *  across renames/deletes so calib logs stay consistent. */
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Operator-assigned priority 1-10. Default 5 (matches curated default).
   *  Used by scoring in Slot 4 once the daemon picks the target up. */
  priority: number;
  /** ISO 8601 timestamp the operator added the target. Used to track
   *  instant-buffer ordering + "is this newer than the latest tick?". */
  createdAt: string;
}

/** Schema version this build writes. Increment when changing Profile
 *  shape. Add a migrator to MIGRATIONS so older profiles roundtrip. */
export const CURRENT_PROFILE_VERSION = 1;

/** Schema migrators. Indexed by source version → next version. Composed
 *  in `migrate()` until `version === CURRENT_PROFILE_VERSION`. Empty in
 *  v1; populates as the schema evolves. Example future entry:
 *
 *    1: (profile) => ({...profile, version: 2, gotIt: undefined})
 *
 *  Migrators must be pure functions: same input → same output. They run
 *  every page load for stale profiles, so they cannot have side effects.
 */
const MIGRATIONS: Record<number, (profile: Record<string, unknown>) => Record<string, unknown>> = {};

/** localStorage key prefix. Each profile lives at `opd-profile-<name>`.
 *  The picker reads `opd-profile-names` as the list of known profiles. */
const PROFILE_KEY_PREFIX = 'opd-profile-';
const PROFILE_LIST_KEY = 'opd-profile-names';

/** Default profile name used when the URL carries no `?u=` parameter.
 *  Anil's view by convention. Astronauts always bookmark `?u=<name>`. */
export const DEFAULT_PROFILE_NAME = 'anil';

/** Profile name validation. URL-safe, R2-key-safe, no path traversal.
 *  Allow lowercase a-z + digits + hyphen, length 1-32. Reject everything
 *  else (matches a typical username pattern + filesystem safety). */
const VALID_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidProfileName(name: string): boolean {
  return VALID_NAME_PATTERN.test(name);
}

/** Read the profile name from the current URL. Order of precedence:
 *  1. `?u=<name>` query parameter (primary, easiest to share)
 *  2. First path segment `/jack` (reserved for Slot 4 router config)
 *  3. DEFAULT_PROFILE_NAME if neither is present or both are invalid
 *
 *  Pure function — accepts a URL or `location.href` directly to keep
 *  testable. Returns the validated name; invalid names fall back to
 *  DEFAULT_PROFILE_NAME with no error (defensive — a typo in the URL
 *  shouldn't break the page). */
export function parseProfileFromURL(url: string | URL): string {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return DEFAULT_PROFILE_NAME;
  }
  const q = parsed.searchParams.get('u');
  if (q && isValidProfileName(q)) return q;
  // Path segment fallback: `/<name>` (single segment, root-relative).
  // Strip leading slash, ignore any trailing slash or further segments.
  const seg = parsed.pathname.replace(/^\//, '').split('/')[0];
  if (seg && isValidProfileName(seg)) return seg;
  return DEFAULT_PROFILE_NAME;
}

/** Build the localStorage key for a profile. Centralized so callers
 *  can't typo the prefix. */
function profileKey(name: string): string {
  return `${PROFILE_KEY_PREFIX}${name}`;
}

/** Construct a fresh profile with the locked defaults. Used when the
 *  operator picks a brand-new profile name from the URL or the picker
 *  (Slot 2). Empty additions/removals/instantBuffer; threshold matches
 *  the existing ISS horizon. */
export function createDefaultProfile(name: string): Profile {
  if (!isValidProfileName(name)) {
    throw new Error(`invalid profile name: ${name}`);
  }
  return {
    version: CURRENT_PROFILE_VERSION,
    name,
    additions: [],
    removedCuratedIds: [],
    distanceThresholdKm: 1500,
    instantBuffer: [],
  };
}

/** Run the migration chain on a stored profile. Each migrator handles
 *  one version step. If the input is already at CURRENT_PROFILE_VERSION,
 *  it's returned unchanged. If the version is unknown (corrupted or from
 *  a future build), the migrator throws with a clear message so the
 *  caller can decide whether to discard + recreate. */
export function migrate(raw: Record<string, unknown>): Profile {
  let working = { ...raw };
  let version = typeof working.version === 'number' ? working.version : 0;
  while (version < CURRENT_PROFILE_VERSION) {
    const migrator = MIGRATIONS[version];
    if (!migrator) {
      throw new Error(
        `no migration from profile version ${version}; ` +
        `current=${CURRENT_PROFILE_VERSION}. ` +
        `Delete the localStorage entry and let it auto-recreate.`,
      );
    }
    working = migrator(working);
    version = typeof working.version === 'number' ? working.version : version + 1;
  }
  if (version > CURRENT_PROFILE_VERSION) {
    throw new Error(
      `profile version ${version} is newer than this build's ` +
      `CURRENT_PROFILE_VERSION=${CURRENT_PROFILE_VERSION}. ` +
      `Refusing to downgrade; the operator should upgrade the app.`,
    );
  }
  // After migration the working object should match Profile shape.
  // Cast is safe because each migrator is responsible for producing
  // a structurally-valid Profile at its target version.
  return working as unknown as Profile;
}

/** Load a profile from localStorage. Three outcomes:
 *  - Profile exists + parses + migrates cleanly → return it
 *  - Profile is missing → return null (caller decides: auto-create or prompt)
 *  - Profile is corrupted / future-versioned → throws with context
 *
 *  Callers in v1 (Slot 1: just main.ts boot) treat null as "auto-create
 *  a default." Later slots may prompt instead. */
export function loadProfile(name: string): Profile | null {
  if (!isValidProfileName(name)) return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(profileKey(name));
  } catch {
    // localStorage can throw in private-mode Safari or when quota is hit
    // on read (rare but possible). Treat as "no profile" and let the
    // caller decide whether to auto-create.
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return migrate(parsed);
  } catch (err) {
    // Re-throw with context. main.ts handles by logging + auto-create.
    throw new Error(
      `failed to load profile "${name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Write a profile to localStorage and fire the 'profile-changed' event
 *  so subscribers (Map tab, topbar, Queue list builder) can refresh.
 *  Subscribers debounce at 150ms per Issue 7 of the eng review; this
 *  function fires synchronously and lets the debouncers coalesce.
 *
 *  Quota-exceeded errors are caught and surfaced as a thrown Error so
 *  the calling UI can show a clear "couldn't save" toast (Slot 6).
 */
export function saveProfile(profile: Profile): void {
  if (!isValidProfileName(profile.name)) {
    throw new Error(`refusing to save profile with invalid name: ${profile.name}`);
  }
  if (profile.version !== CURRENT_PROFILE_VERSION) {
    throw new Error(
      `refusing to save profile at version ${profile.version}; ` +
      `expected ${CURRENT_PROFILE_VERSION}. Did you forget to migrate?`,
    );
  }
  const serialized = JSON.stringify(profile);
  try {
    localStorage.setItem(profileKey(profile.name), serialized);
  } catch (err) {
    throw new Error(
      `failed to save profile "${profile.name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Update the known-profiles list so the picker (Slot 2) can find it.
  const known = listProfiles();
  if (!known.includes(profile.name)) {
    try {
      localStorage.setItem(PROFILE_LIST_KEY, JSON.stringify([...known, profile.name].sort()));
    } catch {
      // List update failure is non-fatal — the profile itself is saved,
      // the picker just won't auto-discover it. Caller can retry.
    }
  }
  // Fire the event. Subscribers re-read; cross-tab uses 'storage' (Slot 11).
  try {
    window.dispatchEvent(new CustomEvent('profile-changed', {
      detail: { name: profile.name },
    }));
  } catch {
    // CustomEvent unavailable (very old browser or test env without
    // a real window). Subscribers won't refresh; not fatal.
  }
}

/** List all known profile names from localStorage. Returns sorted ASCII
 *  order so the picker dropdown is stable. Returns [] if no profiles
 *  have ever been saved (first launch). */
export function listProfiles(): string[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(PROFILE_LIST_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (n): n is string => typeof n === 'string' && isValidProfileName(n),
    ).sort();
  } catch {
    return [];
  }
}

/** Load the profile named by the URL, auto-creating a default if it
 *  doesn't exist yet. Convenience for main.ts boot: one call gets you
 *  a usable Profile object regardless of first-launch vs returning
 *  visitor. Throws only on corrupted localStorage (which a future-version
 *  profile or malformed JSON would cause); main.ts catches + logs +
 *  recreates. */
export function loadOrCreateProfileFromURL(urlHref: string): Profile {
  const name = parseProfileFromURL(urlHref);
  const existing = loadProfile(name);
  if (existing) return existing;
  const fresh = createDefaultProfile(name);
  saveProfile(fresh);
  return fresh;
}

/** Test-only helper to reset module state. Used by vitest beforeEach to
 *  ensure test isolation when many tests touch localStorage. NOT for
 *  production code. */
export function _resetForTests(): void {
  // No module-level state to reset in v1 (loaders are pure). Tests
  // wipe their own localStorage. Provided so callers don't have to
  // import a no-op stub.
}
