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

// ---------------------------------------------------------------------------
// Slot 6 — Profile tab CRUD helpers (locked 2026-05-26).
//
// Small, additive helpers for the Profile-tab UI. The optimistic-UI flow
// in profile-crud.ts is:
//   1. operator clicks Add/Delete/Toggle
//   2. client-side validation runs (mirrors worker/src/profiles.ts)
//   3. local profile is mutated + persisted via saveProfile()
//   4. API call goes out in the background
//   5. on API failure, the local mutation is rolled back + a toast fires
//
// These helpers own step 3 only. They take + return a Profile so the UI
// layer can hold the "previous" copy for rollback in its caller frame.
// ---------------------------------------------------------------------------

/** Validation result for a personal-target payload. Mirrors the worker
 *  field names so error messages can be surfaced uniformly. */
export type PersonalTargetValidationResult =
  | { ok: true; target: PersonalTarget }
  | { ok: false; error: string };

const TARGET_NAME_MAX_LEN = 200;
// Match the worker's ID_RE exactly. The token portion is generated below.
const PERSONAL_ID_RE = /^personal:[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9_-]{1,128}$/;

/** Mint a stable personal-target id. Format `personal:<profile>:<token>`
 *  with the token from crypto.randomUUID() (32 hex chars + dashes — fits
 *  the worker's `[A-Za-z0-9_-]{1,128}` bound). Falls back to a Math.random
 *  hex string when randomUUID is unavailable (very old browsers, some
 *  test envs) so the function is never the failure point. */
export function makePersonalTargetId(profileName: string): string {
  const token = (() => {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch { /* fall through */ }
    // Fallback: 16 random hex chars. Not crypto-strong but the token is
    // a uniqueness key inside one profile's bucket, not a secret.
    let s = '';
    for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  })();
  return `personal:${profileName}:${token}`;
}

/** Build + validate a PersonalTarget from raw operator input. Mirrors the
 *  worker's `validateTarget()` field-by-field (lat ∈ [-90,90], lon ∈
 *  [-180,180], name 1-200 chars, priority 1-10). On success, returns a
 *  normalized PersonalTarget with id minted (or carried forward) and
 *  createdAt stamped. On failure, returns a per-field error code that the
 *  UI can surface inline. */
export function validatePersonalTargetInput(input: {
  id?: string;
  profileName: string;
  name: string;
  lat: number;
  lon: number;
  priority?: number;
  createdAt?: string;
}): PersonalTargetValidationResult {
  const profileName = input.profileName;
  if (!isValidProfileName(profileName)) {
    return { ok: false, error: 'invalid_profile_name' };
  }
  const name = (input.name ?? '').trim();
  if (name.length === 0) return { ok: false, error: 'name_empty' };
  if (name.length > TARGET_NAME_MAX_LEN) return { ok: false, error: 'name_too_long' };
  const lat = Number(input.lat);
  if (!Number.isFinite(lat)) return { ok: false, error: 'lat_must_be_finite_number' };
  if (lat < -90 || lat > 90) return { ok: false, error: 'lat_out_of_range' };
  const lon = Number(input.lon);
  if (!Number.isFinite(lon)) return { ok: false, error: 'lon_must_be_finite_number' };
  if (lon < -180 || lon > 180) return { ok: false, error: 'lon_out_of_range' };
  const priority = input.priority === undefined ? 5 : Number(input.priority);
  if (!Number.isInteger(priority)) return { ok: false, error: 'priority_must_be_integer' };
  if (priority < 1 || priority > 10) return { ok: false, error: 'priority_out_of_range' };
  const id = input.id ?? makePersonalTargetId(profileName);
  if (!PERSONAL_ID_RE.test(id)) return { ok: false, error: 'invalid_id' };
  if (id.split(':')[1] !== profileName) return { ok: false, error: 'id_profile_mismatch' };
  // createdAt: stamp now if missing; otherwise validate ISO-Z shape so the
  // worker's regex accepts it on PUT/POST.
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(createdAt)) {
    return { ok: false, error: 'invalid_createdAt' };
  }
  return { ok: true, target: { id, name, lat, lon, priority, createdAt } };
}

/** Append a personal target to a profile (immutable — returns a NEW
 *  profile object so the caller can hold the previous one for rollback).
 *  Caller must `saveProfile(next)` to persist. Rejects duplicate ids. */
export function addPersonalTarget(profile: Profile, target: PersonalTarget): Profile {
  if (profile.additions.some((t) => t.id === target.id)) {
    throw new Error(`duplicate target id: ${target.id}`);
  }
  return { ...profile, additions: [...profile.additions, target] };
}

/** Append a batch of personal targets to a profile (immutable). Used by
 *  the slot 9 CSV importer — the operator pastes a spreadsheet's worth
 *  of rows and we add them all in one mutation before kicking off the
 *  parallel API POSTs. Rejects the batch on duplicate id (within the
 *  batch OR against existing additions) so partial-batch corruption
 *  can't happen.
 *
 *  Returns a new Profile; caller must `saveProfile(next)` to persist. */
export function addPersonalTargetsBatch(profile: Profile, targets: PersonalTarget[]): Profile {
  if (targets.length === 0) return profile;
  const existing = new Set(profile.additions.map((t) => t.id));
  const seenInBatch = new Set<string>();
  for (const t of targets) {
    if (existing.has(t.id)) throw new Error(`duplicate target id: ${t.id}`);
    if (seenInBatch.has(t.id)) throw new Error(`duplicate id within batch: ${t.id}`);
    seenInBatch.add(t.id);
  }
  return { ...profile, additions: [...profile.additions, ...targets] };
}

/** Remove a personal target by id. Idempotent — missing id returns the
 *  profile unchanged. Caller must `saveProfile(next)` to persist. */
export function removePersonalTarget(profile: Profile, targetId: string): Profile {
  const next = profile.additions.filter((t) => t.id !== targetId);
  if (next.length === profile.additions.length) return profile;
  return { ...profile, additions: next };
}

/** Flip the "removed for this profile" marker on a curated target id.
 *  Toggle semantics: present → remove from removedCuratedIds (un-hide);
 *  absent → append (hide). Caller must `saveProfile(next)` to persist. */
export function toggleCuratedRemoved(profile: Profile, curatedId: string): Profile {
  if (typeof curatedId !== 'string' || curatedId.length === 0) return profile;
  const isRemoved = profile.removedCuratedIds.includes(curatedId);
  const next = isRemoved
    ? profile.removedCuratedIds.filter((id) => id !== curatedId)
    : [...profile.removedCuratedIds, curatedId];
  return { ...profile, removedCuratedIds: next };
}
