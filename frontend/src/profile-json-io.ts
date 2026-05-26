/** Slot 10 — JSON export/import with schema-version migration.
 *
 *  Two responsibilities:
 *    1. Export: read the active profile from localStorage, package it as a
 *       discriminated envelope ({format, schemaVersion, exportedAt, ...}),
 *       and either return the JSON text (`exportProfileJson`) or trigger a
 *       browser download (`downloadProfileJson`).
 *    2. Import: parse a JSON text blob, validate the envelope shape,
 *       migrate older schemas through the slot 1 framework, and re-validate
 *       every personal target through slot 6's `validatePersonalTargetInput`.
 *       Returns a discriminated `ImportResult` the caller (profile-crud) can
 *       switch on for preview/error rendering.
 *
 *  Why localStorage (not API) as the export source:
 *    The design doc said "pull from API" but the operator's actual view is
 *    localStorage — including their hidden-curated list (which the API does
 *    not store) and the distance threshold (also local-only). Exporting from
 *    localStorage matches what they see in the Profile tab. For the rare
 *    "wipe localStorage + re-pull from server" recovery, the operator can
 *    use slot 6's existing API surface (`/api/profiles/<name>/targets`)
 *    directly via curl; we don't need a second UI affordance for it.
 *
 *  Constraint: pure module. No DOM mutation except in `downloadProfileJson`
 *  (which is the one DOM-side helper). `exportProfileJson` and
 *  `parseProfileImport` are pure functions, so tests can drive them
 *  without happy-dom.
 */

import {
  CURRENT_PROFILE_VERSION,
  isValidProfileName,
  loadProfile,
  migrate,
  validatePersonalTargetInput,
  type PersonalTarget,
  type Profile,
  type ProfileMigrator,
} from './profile';

/** Format discriminator. Prevents accidental import of random JSON. */
export const PROFILE_EXPORT_FORMAT = 'orbit-photo-director-profile';

/** Envelope shape on disk. The format + schemaVersion fields drive
 *  validation + migration; the rest is metadata for the operator. */
export interface ProfileExportEnvelope {
  format: typeof PROFILE_EXPORT_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  profile: Profile;
}

/** Per-target validation error inside an import. The index is into the
 *  imported `additions` array so the UI can surface "Target 3 of 5
 *  failed". */
export interface ImportedTargetError {
  index: number;
  /** Best-effort name pulled from the raw input (may be empty / malformed). */
  rawName: string;
  /** Validation error code from `validatePersonalTargetInput`. */
  code: string;
}

/** Discriminated import result. `ok: true` means the envelope parsed AND
 *  ran through migration; per-target validation errors are surfaced in
 *  `targetErrors` so the operator can decide "import only valid" vs cancel.
 *  `ok: false` means a fatal envelope / migration error — nothing to import. */
export type ImportResult =
  | {
      ok: true;
      /** The migrated, schema-current Profile (with valid targets only). */
      profile: Profile;
      /** Per-target validation errors (operator can still import the valid
       *  subset if they choose). Empty array on a clean import. */
      targetErrors: ImportedTargetError[];
      /** The schema version the export was at, BEFORE migration. Useful for
       *  the preview text ("Imported v1 → migrated to v1"). */
      sourceSchemaVersion: number;
      /** The export's reported `exportedAt` timestamp for preview display. */
      exportedAt: string;
      /** The export's reported `appVersion` for preview display. */
      appVersion: string;
    }
  | {
      ok: false;
      /** Stable error code for branching. Detail string is operator-facing. */
      code:
        | 'malformed_json'
        | 'wrong_format'
        | 'future_schema'
        | 'missing_schema_version'
        | 'missing_profile'
        | 'invalid_profile_name'
        | 'migration_failed';
      detail: string;
      /** When `code === 'future_schema'`, surfaces what version was demanded. */
      demandedSchemaVersion?: number;
    };

/** Build the export JSON text for the named profile. Reads from
 *  localStorage via `loadProfile`. Throws if the profile doesn't exist OR
 *  the name is invalid — UI catches and surfaces a toast.
 *
 *  Returned string is pretty-printed (2-space indent) so an operator who
 *  opens the file in a text editor sees a readable layout. The size cost
 *  is negligible (~20% larger than minified) since profiles are tiny. */
export function exportProfileJson(
  profileName: string,
  appVersion: string,
  now: Date = new Date(),
): string {
  if (!isValidProfileName(profileName)) {
    throw new Error(`invalid profile name: ${profileName}`);
  }
  const profile = loadProfile(profileName);
  if (!profile) {
    throw new Error(`no profile in localStorage for "${profileName}"`);
  }
  const envelope: ProfileExportEnvelope = {
    format: PROFILE_EXPORT_FORMAT,
    schemaVersion: profile.version,
    exportedAt: now.toISOString(),
    appVersion,
    profile,
  };
  return JSON.stringify(envelope, null, 2);
}

/** Parse + validate an import payload. The flow:
 *    1. JSON.parse the text (catch + return `malformed_json`)
 *    2. Check the `format` discriminator
 *    3. Read `schemaVersion`; reject if > CURRENT_PROFILE_VERSION
 *    4. Run migration chain via `migrate()` (older versions migrate up;
 *       missing migrator throws `migration_failed`)
 *    5. Re-validate every target in `additions` through
 *       `validatePersonalTargetInput`; collect invalid ones into
 *       `targetErrors`, keep valid ones in the returned profile.
 *
 *  `migrations` arg is for tests — production callers pass no second
 *  argument and pick up the module-level `MIGRATIONS` table. */
export function parseProfileImport(
  text: string,
  options: {
    /** Override the migrations table (tests only). */
    migrations?: Record<number, ProfileMigrator>;
    /** Override CURRENT_PROFILE_VERSION (tests only — simulates a future
     *  schema bump without changing production constants). */
    currentVersion?: number;
  } = {},
): ImportResult {
  const currentVersion = options.currentVersion ?? CURRENT_PROFILE_VERSION;

  // Step 1: JSON.parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      code: 'malformed_json',
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'wrong_format',
      detail: 'Top-level JSON must be an object.',
    };
  }
  const envelope = parsed as Record<string, unknown>;

  // Step 2: format discriminator
  if (envelope.format !== PROFILE_EXPORT_FORMAT) {
    return {
      ok: false,
      code: 'wrong_format',
      detail: `Not an ${PROFILE_EXPORT_FORMAT} export (got format=${JSON.stringify(envelope.format)}).`,
    };
  }

  // Step 3: schemaVersion
  const schemaVersion = envelope.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 0) {
    return {
      ok: false,
      code: 'missing_schema_version',
      detail: `schemaVersion must be a non-negative integer (got ${JSON.stringify(schemaVersion)}).`,
    };
  }
  if (schemaVersion > currentVersion) {
    return {
      ok: false,
      code: 'future_schema',
      detail:
        `This export needs app v${schemaVersion}+. You have v${currentVersion}. ` +
        `Upgrade the app, then re-import.`,
      demandedSchemaVersion: schemaVersion,
    };
  }

  // Step 4: profile object present + run migration
  if (
    !envelope.profile ||
    typeof envelope.profile !== 'object' ||
    Array.isArray(envelope.profile)
  ) {
    return {
      ok: false,
      code: 'missing_profile',
      detail: 'Envelope is missing the `profile` object.',
    };
  }
  // Stamp the version onto the inner profile so `migrate()` sees what the
  // envelope claimed — the inner profile may carry a stale `version` field
  // (older exports might have omitted it; legitimate exports duplicate it
  // for redundancy).
  const innerProfile: Record<string, unknown> = {
    ...(envelope.profile as Record<string, unknown>),
    version: schemaVersion,
  };

  let migrated: Profile;
  try {
    migrated = migrate(innerProfile, options.migrations);
  } catch (e) {
    return {
      ok: false,
      code: 'migration_failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  // Step 5: profile.name must be valid (we don't enforce match with the
  // active profile here — the UI layer surfaces a cross-profile warning).
  if (typeof migrated.name !== 'string' || !isValidProfileName(migrated.name)) {
    return {
      ok: false,
      code: 'invalid_profile_name',
      detail: `Imported profile name is invalid: ${JSON.stringify(migrated.name)}.`,
    };
  }

  // Step 6: re-validate every target through the slot 6 validator. Targets
  // that fail validation get collected into `targetErrors`; valid ones go
  // into the returned profile.additions. The operator picks "import valid
  // only" or "cancel" from the preview.
  const rawAdditions = Array.isArray(migrated.additions) ? migrated.additions : [];
  const validTargets: PersonalTarget[] = [];
  const targetErrors: ImportedTargetError[] = [];
  for (let i = 0; i < rawAdditions.length; i++) {
    const raw = rawAdditions[i] as Partial<PersonalTarget>;
    const result = validatePersonalTargetInput({
      id: typeof raw?.id === 'string' ? raw.id : undefined,
      profileName: migrated.name,
      name: typeof raw?.name === 'string' ? raw.name : '',
      lat: typeof raw?.lat === 'number' ? raw.lat : NaN,
      lon: typeof raw?.lon === 'number' ? raw.lon : NaN,
      priority: typeof raw?.priority === 'number' ? raw.priority : undefined,
      createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : undefined,
    });
    if (result.ok) {
      validTargets.push(result.target);
    } else {
      targetErrors.push({
        index: i,
        rawName: typeof raw?.name === 'string' ? raw.name : '',
        code: result.error,
      });
    }
  }

  // Defensive: make sure removedCuratedIds is a string[]; coerce
  // distanceThresholdKm to a finite number.
  const removedCuratedIds = Array.isArray(migrated.removedCuratedIds)
    ? migrated.removedCuratedIds.filter((s): s is string => typeof s === 'string')
    : [];
  const distanceThresholdKm =
    typeof migrated.distanceThresholdKm === 'number' && Number.isFinite(migrated.distanceThresholdKm)
      ? migrated.distanceThresholdKm
      : 1500;

  const profile: Profile = {
    version: migrated.version,
    name: migrated.name,
    additions: validTargets,
    removedCuratedIds,
    distanceThresholdKm,
    instantBuffer: [],
  };

  return {
    ok: true,
    profile,
    targetErrors,
    sourceSchemaVersion: schemaVersion,
    exportedAt: typeof envelope.exportedAt === 'string' ? envelope.exportedAt : '',
    appVersion: typeof envelope.appVersion === 'string' ? envelope.appVersion : '',
  };
}

/** DOM-side download helper. Creates a Blob from the export JSON,
 *  programmatically clicks an anchor with `download={name}-profile.json`,
 *  then revokes the blob URL after the click resolves.
 *
 *  Falls back to throwing if `document` isn't available (e.g., running in
 *  a worker). Tests can stub `document.createElement('a')` to capture the
 *  generated href + filename. */
export function downloadProfileJson(
  profileName: string,
  appVersion: string,
  now: Date = new Date(),
): { filename: string; url: string } {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('downloadProfileJson requires a DOM environment with URL.createObjectURL');
  }
  const json = exportProfileJson(profileName, appVersion, now);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const filename = `${profileName}-profile.json`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Some browsers require the anchor in the document for the click to fire.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on next microtask so the click handler has time to dispatch.
  Promise.resolve().then(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Some test envs lack revokeObjectURL — non-fatal.
    }
  });
  return { filename, url };
}

/** Read a `File` (from a file input) as text and return the parsed
 *  ImportResult. Convenience for profile-crud's file picker. Returns
 *  the `malformed_json` shape on read failure so the caller's switch
 *  is uniform. */
export async function readProfileImportFile(file: File): Promise<ImportResult> {
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    return {
      ok: false,
      code: 'malformed_json',
      detail: `Could not read file: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return parseProfileImport(text);
}
