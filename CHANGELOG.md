# Changelog

All notable changes to Orbit Photo Director.

## [1.6.18.0] - 2026-05-27

### v3 Operator Ergonomics

Three operator-ergonomics features bundled (same-day Anil feedback after
v1.6.17.0). All frontend-only; no daemon / worker changes.

- **Component A — Hide-from-card button.** Every Queue / Upcoming pass card
  for a curated target now gets a "Hide" button next to Shoot / Skip.
  One tap adds the `target_id` to the active profile's `removedCuratedIds`,
  rips the card from the DOM immediately, and surfaces a toast
  ("Hidden 'X' — restore in Profile tab"). Personal-target cards do NOT
  render Hide — the Profile-tab CRUD list already exposes Delete, and
  one-tap delete from the queue is too destructive without a confirm.
  `frontend/src/card.ts` + `frontend/src/main.ts`.
- **Component B — Name-based geocoding for Add Target.** The Profile-tab
  Add form gains a "Search by name" mode toggle. Type "San Diego" → click
  Search → pick from a Nominatim result list → lat/lon fields autofill
  + mode flips back to Manual for review. Solves the
  lat-typed-into-the-name-field UX hazard ("(0,0)" pin Anil hit on his
  first add). 1000ms ToS-compliant debounce, 24-hour localStorage cache
  (LRU, 100 entries), 3-second AbortController timeout, Nominatim
  attribution caption rendered on every result / error state.
  `frontend/src/profile-geocode.ts` (new) + `frontend/src/profile-crud.ts`.
- **Component C — Curated catalog typeahead.** The "Hidden curated targets"
  section now has a typeahead that searches `targets.json` by name +
  partial id (200ms debounce). Operator no longer needs to remember
  `aurora-scandinavia` and paste it exactly — type "aurora" and pick.
  Catalog fetched once per Profile-pane mount via the existing manifest;
  paste-exact-id flow kept as a fallback for catalog-fetch failures so
  the operator is never stuck. `frontend/src/profile-crud.ts` + new
  `fetchCuratedTargets` helper in `frontend/src/manifest.ts`.

51 new tests; 852 → 903 total.

## [1.6.17.0] - 2026-05-27

### v2 Hotfix Bundle

Same-day operator feedback after v1.6.16.0 (Anil). Four surgical fixes, one PR:

- **Terminator night-fill opacity 0.55 → 0.30.** The v2-spec bump to 0.55 obscured
  the basemap too aggressively — labels, coastlines, and city lights vanished under
  the dim layer. 0.30 still reads as "night side" at a glance without smothering
  the underlying features. (`frontend/src/map.ts` + comment in `terminator.ts`.)
- **VIIRS Black Marble: hardcode 2016-01-01.** GIBS publishes `VIIRS_Black_Marble`
  for only two discrete dates — 2012-01-01 and 2016-01-01 — verified via live HTTP
  + GetCapabilities XML. The prior `currentYear - 1` URL with a one-year fallback
  walk silently 404'd and killed the night-lights toggle. We now hardcode 2016 as
  the canonical date and replace the year-fallback machinery with a one-shot
  console.warn for the (now only possible) GIBS-down case. Follow-up if more recent
  imagery is wanted: switch to the daily `VIIRS_SNPP_DayNightBand_ENCC` layer.
- **Pin-to-ISS: `easeTo({duration:500})` → `flyTo({duration:800, essential:true})`.**
  At high zoom, the 500ms linear pan looked frozen because MapLibre couldn't load
  tiles fast enough across the traversal. `flyTo` zooms out, pans, zooms back in,
  which handles any zoom level gracefully. The toggle-off-while-following branch
  is preserved unchanged (no camera op on exit). `essential:true` bypasses
  `prefers-reduced-motion` — the operator explicitly clicked.
- **Profile picker: belt-and-braces self-heal.** The picker now scans
  `localStorage` for `opd-profile-<name>` keys in addition to reading the
  `opd-profile-names` cache list. Profiles that exist on disk but aren't in the
  cache (operator devtools-wipe, fresh device that only visited one URL, partial
  import) now appear in the dropdown. Names are validated via `isValidProfileName`
  before inclusion (defense against hand-edited keys with uppercase / underscores
  / empty segments).

## [1.6.16.0] - 2026-05-27

### v2 Operator Unlock

Bundled v2 batch addressing first-round feedback from both ISS operators after v1.6.14.0:
CEO zoom imagery (Jack's third missing primitive), token-bug fix (Chris's auth footgun),
Chris's three map-polish asks, and a structured Web Push design parked for the next batch.

### Component 1 — CEO zoom imagery on pass cards (Jack feedback 2026-05-27)

Each personal-target pass card now carries a `🌍` icon-button that expands an inline
satellite thumbnail under the card. Tap again to collapse; per-session per-card state
(not persisted). The thumbnail:

- Renders a single Esri World Imagery tile at z=12 (~9.5 km tile-width) centered on
  the target — matches the main Map tab's basemap for visual consistency.
- Overlays the ISS ground-track polyline sampled at 30s intervals across the pass
  AOS → LOS window (closest_approach ± 5 min). Polynomial first (`liveIssPosition`),
  SGP4 fallback (`liveIssPositionSGP4`) for samples past the polynomial window.
- Shows the ISS marker at `iss_at_closest`, target crosshair at the thumbnail center,
  and a caption with "N km nadir · M° off · in P min".
- On Esri tile failure: gray placeholder + "Imagery unavailable — {error}" caption.
  Polyline overlay still renders (orbital geometry is the most load-bearing context).
- Browser HTTP cache only for v1 — no SW pre-cache, no prefetch on card mount.
- "© Esri, Maxar, Earthstar Geographics" attribution per Esri free-tier ToS.

New file `frontend/src/pass-thumbnail.ts`. Wired into `card.ts` via an injected
`renderThumbnail` factory so the card module stays free of satellite/tile dependencies.

### Component 2 — Token-bug fix (Chris feedback 2026-05-27)

`postCalib` no longer calls `clearToken()` on a 401 response. The token field now
stays populated (so the operator can see what they pasted and correct it), the
payload is queued for retry, and a distinct toast surfaces:
`Token rejected — re-paste in Log tab (your current token was not accepted by the server)`.
The per-call 401 handling lives inside `postCalib` itself, NOT in the global
`shouldQueueOnStatus` helper — other endpoints (profile-api, etc.) keep their
existing fail-fast-on-auth behavior. `shouldQueueOnStatus` is now exported so the
scoping guard is testable.

Pre-existing footgun, not a regression from v1.6.14.0 — `calib.ts:71-79`. Today's
CALIB_TOKEN rotation invalidated every previously-pasted token and surfaced it.

### Component 3 — Map polish bundle (Chris feedback 2026-05-27)

Three bundled changes to the map view, all addressing Chris's same-day asks:

- **3a Terminator polish:** Added a night-side polygon fill (`terminator-night-fill-layer`,
  `rgba(0, 0, 0, 0.55)`) plus a 40px line-blur on the existing terminator line so the
  day/night boundary is a soft gradient instead of a hard edge. Matches GoISSWatch's
  clean dark night-side reference. New `terminatorNightPolygonFeatures` helper in
  `terminator.ts` handles antimeridian + polar-night cases.
- **3b VIIRS night lights overlay:** Toggleable map control (default off) sourcing
  NASA GIBS `VIIRS_Black_Marble` annual composite. PNG-transparent on the day side
  so the basemap shows through; renders above the terminator night-fill so city
  lights stay visible. Year fallback: if last year's composite 404/5xx's, walks
  back one year; if both fail, hides the layer silently with one console.warn.
- **3c Esri labels overlay:** New toggleable `Reference/World_Boundaries_and_Places`
  overlay (default on) rendered as the topmost layer so country/state/city/road
  labels stay legible regardless of which basemap is active. No API key.

Two new HTML controls: `toggle-night-lights` and `toggle-labels`. Three new
preference keys persisted to localStorage following the existing cloud/terminator
pattern.

### Component 4 — Real Web Push deferred to TODOs.md

Full architectural spec for next batch (VAPID + Worker push endpoint + daemon
scheduler + frontend opt-in UX) added to `TODOS.md` as a self-contained section.
5-7 days estimated. Refuted: in-app reminders (iPad isn't always app-focused).

### Tests

- Frontend: **795 → 847 vitest pass (+52)**
  - 21 new tests in `test/pass-thumbnail.test.ts` (URL build, lonLat-to-tile,
    projection, polynomial sampling, countdown, DOM scaffold, tile-failure
    placeholder, XSS guard)
  - 9 new tests in `test/calib.test.ts` (3 for the 401 keep-token-and-queue
    behavior, 5 for the `shouldQueueOnStatus` scoping guard, 1 import addition)
  - 7 new tests in `test/card.test.ts` (🌍 gating on personal-target,
    lazy thumbnail render, toggle state, open-across-rerender, forecast variant)
  - 5 new tests in `test/terminator.test.ts` (`terminatorNightPolygonFeatures`
    coverage, antisolar containment, antimeridian handling, polar-night slabs,
    world-copy duplication)
  - 6 new tests in `test/map-night-lights.test.ts` (GIBS Black Marble URL,
    max-zoom constant, year-fallback policy)
  - 6 new tests in `test/map-labels.test.ts` (visibility toggle, persistence
    default-on)

## [1.6.15.0] - 2026-05-27

### GLM concurrency fix — daemon tick reliability

`generator/lightning.py` — `GLMSampler.__init__` previously fetched NOAA GLM granules
serially at a 30s per-granule HTTP timeout. When one GOES bucket was empty and the
other returned its normal ~180 granules (or vice versa), worst-case wall-clock
inflated to 4-7+ minutes — enough to trip the daemon's tick watchdog (which had to
be bumped 600s → 1800s as a band-aid earlier today).

Replaced the serial loop with `concurrent.futures.ThreadPoolExecutor(max_workers=16)`
+ `as_completed(timeout=120)`. The entire granule-fetch phase is now bounded at
120s regardless of NOAA flakes; pending futures are dropped on budget exhaustion
(graceful degradation — partial lightning data is better than a stalled tick).
After a 3-5 day soak the 1800s watchdog can revert to 900s.

Added `decode_seconds` log line so we can verify the "decode is cheap, fetch
dominates" assumption against real production data. If aggregate decode is ever
observed >30s, fold `_decode_glm_granule` into the worker callable.

### Tests

- Python: **596 → 599 pytest pass (+3 in `tests/test_lightning.py`)**
  - `test_glm_sampler_fetches_concurrently` — fetcher records worker thread IDs; asserts >1 distinct thread observed
  - `test_glm_sampler_partial_success_aggregation` — 5 URLs succeed, 5 raise `RequestException`; asserts spatial index gets data from successes + per-failure warning logged
  - `test_glm_sampler_overall_budget_drops_pending` — one URL sleeps past the budget; asserts constructor returns within the budget + timeout warning logged + spatial index has data from fast fetches
  - `test_glm_fetch_budget_constant_is_120s` — pins the design-doc-locked budget

## [1.6.14.0] - 2026-05-27

### Polish bundle — shot-count badge + clickable profile chip + dynamic APP_VERSION + import-wipe warning

Four small UX/quality fixes bundled into one branch because they're tightly scoped and partially co-located in `frontend/src/profile-crud.ts`.

### Slot 8b — per-target shot-count badge in Profile tab

Each personal target row in the Profile tab now carries a small `✓ N` badge when the operator has shot that target at least once. Aggregated from `/api/log` filtered to the active profile. One log fetch fires per profile per session (re-renders consult an in-memory cache); failure paths are silent so a log-fetch glitch can never kill target rendering.

### Bug 1 — topbar profile chip is now a profile switcher

The `👤 jack` chip in the topbar used to be inert. It now carries `role="button" tabindex="0" aria-label="Switch profile"` and a `cursor: pointer` style, and click / Enter / Space all activate the Profile tab + smooth-scroll the picker section into view. The badge bind-once guard prevents stacked listeners across the every-150ms re-renders the `profile-changed` event bus fires.

### app-version — VERSION file wired to JSON export envelope

`frontend/src/profile-crud.ts` no longer hardcodes `APP_VERSION = '1.6.12.0'` (a slot 10 leftover that was already stale by v1.6.13.0). Vite's `define` config injects the repo-root `VERSION` file contents at build time via `__APP_VERSION__`; a `typeof` guard provides a `1.6.x.dev` fallback for vitest (where the define pass does not run). Production export envelopes now stamp the actual shipped version automatically.

### import-wipe-warn — explicit warning when JSON import would shrink the target list

The JSON import preview in `buildJsonIoSection` previously only showed a generic "REPLACES all" notice. It now also surfaces a dedicated `⚠ This import will delete N existing personal targets (your current: M → after import: K).` warning when the imported additions count is strictly less than the active profile's current additions count. Equal-count imports (data churn but no net loss) and net-add imports do not warn. Empty current profile suppresses the warning regardless.

### Tests

- Frontend: **781 → 795 vitest pass (+14)**
  - 4 new tests in `test/profile-shot-badge.test.ts` (shot-count aggregation, silent failure, token-missing, cache reuse on rerender)
  - 4 new tests appended to `test/profile-json-import.test.ts` (wipe-warning shrink + equal + grow + empty branches)
  - 6 new tests in `test/main-profile-chip.test.ts` (a11y attributes, click activation, Enter/Space activation, scroll-into-view, no duplicate listeners)
  - 1 existing test in `test/profile-hydration.test.ts` updated — its assertion was "no fetch fires when local is populated" but slot 8b legitimately fires `/api/log` on the same mount. Narrowed to "no `/api/profiles/` fetch" with a default-resolving stub.
- `tsc --noEmit && vite build` clean; `__APP_VERSION__` substitution verified in `dist/assets/profile-ui-*.js` (literal `1.6.13.0` present, no `__APP_VERSION__` token leaked).
- No new dependencies.

### Decisions

- **Shot-count fetch is independent from the targets hydrate.** Both fire fire-and-forget on `buildCrudSection` first mount with their own once-per-session guard sets (`hydratedProfiles` vs `shotCountsFetched`). If one fails (token missing, 4xx, network), the other still runs. The CRUD section's mount path never blocks on either.
- **`fetchLog(profile=jack, limit=500)` for the shot-count fetch.** Reuses the existing helper (it already swallows token-missing / non-200 / network failures and returns `[]`). Limit raised from the default 100 to 500 so the badge accurately reflects the operator's full history rather than the last 100 calibration events.
- **Wipe warning is strict-less-than, not less-than-or-equal.** An equal count might still churn rows (different ids, different names), but it isn't a net deletion — the existing "REPLACES all" notice already covers the churn case. Adding a warning to equal-count imports would cry wolf.
- **Profile-chip activation uses two `requestAnimationFrame` deferrals before scrolling.** The Profile pane is lazy-loaded via dynamic import, so the picker section may not exist on the same tick as the tab click. Two rAF ticks consistently land after the import + initial render in every fixture; `scrollIntoView` is then a no-op-safe call via `?.` if the picker still hasn't mounted.
- **APP_VERSION fallback is `'1.6.x.dev'`.** Tests don't assert the value of `APP_VERSION` directly (they pass their own string to `exportProfileJson`), so the sentinel is purely operator-facing in any test-harness export. Cleaner than wiring vitest's `define` config to mirror Vite's.

### How to manually test

1. **Shot-count badge:** open `?u=jack` with `opd-calib-token` set. Switch to Profile tab. Personal targets that you've previously shot via the Queue's Shoot button show a small green `✓ N` pill between the coord span and the Delete button. Targets you've never shot have no badge.
2. **Profile chip:** click the `👤 jack` chip in the topbar from any tab. The Profile tab activates and the page scrolls smoothly to the "Active profile" picker. Hover shows `cursor: pointer` and tooltip "Active profile: jack — click to switch". Tab+Enter on the chip from keyboard does the same.
3. **APP_VERSION:** click Export profile. Open the downloaded `.json` in a text editor. `appVersion` field reads `1.6.13.0` (or whatever VERSION currently holds), not `1.6.12.0`.
4. **Import wipe warning:** with a profile that has 12+ targets, click Import and pick a JSON file that has 0–11 targets. Preview shows `⚠ This import will delete N existing personal targets (your current: 12 → after import: K).` above the "REPLACES all" notice. Re-pick a file with 12+ targets — the wipe warning disappears.

## [1.6.13.0] - 2026-05-26

### Slot 6b — API hydration on Profile pane render

Hot-fix follow-up to slot 6. When the Profile pane mounts for the first time per session, it now fires a one-shot GET to `/api/profiles/<name>/targets` and merges the server's list into localStorage when the local additions list is empty. Closes the "open `?u=jack` on a fresh device and see 0 targets even though the server has 39" UX gap surfaced during smoke testing of v1.6.9.0.

### Added

- **`frontend/src/profile-api.ts`** — new `getProfileTargets(profileName, baseUrl?)` helper. Same shape as the existing POST/PUT/DELETE wrappers: reads `opd-calib-token` from localStorage, sends `x-calib-token` header on GET, returns the discriminated `ApiResult` with stable `reason` codes. Normalises a missing `targets` field on a 200 response to `[]` defensively.
- **`frontend/src/profile-crud.ts`** — new exported `hydratePersonalTargets(profileName)` function with a **"preserve local" guard**: only hydrates when local additions are empty. `buildCrudSection` fires the hydrate fire-and-forget on the FIRST mount per profile per session (a small module-scope `Set<string>` tracks which profiles already hydrated). Re-renders after mutations skip the GET — the operator's local state IS the truth after slot 6's optimistic POST/DELETE flows land. Failure modes (token_missing / network / http / validation) are silent no-ops with `console.warn` for debugging; no toast.
- **`frontend/test/profile-hydration.test.ts`** (new, 14 tests): `getProfileTargets` URL/headers/parse paths, all four failure surfaces; `hydratePersonalTargets` populate-when-empty, preserve-local guard, silent fail on token_missing/5xx/network, mid-flight optimistic-add re-check; `buildCrudSection` hydration wiring (fires on mount when empty, suppressed when populated).

### Tests

- Frontend: **767 → 781 vitest pass (+14)**
- `tsc --noEmit && vite build` clean
- No new dependencies

### Decisions

- **"Preserve local" guard is `additions.length === 0`, not a union-merge.** Two reasons: (a) it solves the original bug fully (the fresh-device case has empty local by definition), and (b) a union-merge by id risks deleting in-flight optimistic adds whose id is local-only because POST hasn't completed yet. Operators rarely edit the same profile from two devices simultaneously; when they do, a localStorage clear forces a clean re-hydrate. Trade-off documented in the code comment.
- **Once per profile per session.** A module-scope `Set<string>` (`hydratedProfiles`) tracks which profiles have already hydrated. Without this, every `rerenderCrudSection` call (fired after every add/delete/toggle) would re-fire the GET. Re-renders are local state propagation; the GET is a session-startup concern. `_test.resetHydrationState()` exposes a clear for the test harness.
- **Re-check local state after fetch resolves.** Between firing the GET and the response arriving, the operator might have added a target. The hydrate path re-reads `loadProfile` and bails if local is no longer empty — defends against clobbering an in-flight optimistic add when the network round-trip is slow.
- **Silent on failure.** Spec called for no toast on hydrate failure. We `console.warn` so the failure is debuggable from devtools, but the operator never sees an error from first-render hydration.

### How to manually test

1. On a fresh device with no `opd-profile-jack` in localStorage (or after `localStorage.clear()` in devtools), set the calib token: `localStorage.setItem('opd-calib-token', '<TOKEN>')`. Open `https://map.astroanil.dev/?u=jack`.
2. Switch to the Profile tab. On first render the personal-targets list briefly shows "No personal targets yet" then re-renders with the server's 39 targets within ~200ms. Toast: nothing pops (silent success).
3. Negative path: clear the token (`localStorage.removeItem('opd-calib-token')`), then reload `?u=jack`. Profile tab still renders cleanly with the empty-state message. Open devtools console — verify a single `profile-crud: hydrate failed for "jack" (token_missing)` warn line. No toast.

## [1.6.12.0] - 2026-05-26

### Slot 10 — JSON export/import with schema migration framework

The Profile tab gains Export (download as JSON) and Import (file → preview → Replace all). Schema versioning is formalized: a `MIGRATIONS` table indexed by source version drives `runMigrationChain`, which the import flow calls to upgrade older exports to the current schema. v2+ exports are rejected with an "upgrade the app" message; older schemas (when a migrator is registered) flow through cleanly.

### Added

- **`frontend/src/profile-json-io.ts`** (new, ~290 lines) — pure module. `exportProfileJson(name, appVersion, now?)` returns a pretty-printed envelope `{format: "orbit-photo-director-profile", schemaVersion, exportedAt, appVersion, profile}`. `parseProfileImport(text, {migrations?, currentVersion?})` returns a discriminated `ImportResult` with stable error codes (`malformed_json`, `wrong_format`, `future_schema`, `missing_schema_version`, `missing_profile`, `invalid_profile_name`, `migration_failed`) plus `targetErrors[]` for per-target validation failures. `downloadProfileJson(name, appVersion)` is the DOM-side helper (Blob + anchor click + revoke); `readProfileImportFile(file)` wraps `File.text()` + `parseProfileImport`.
- **`frontend/src/profile.ts`** — `MIGRATIONS` map + `runMigrationChain(working, from, to, migrations?)` + `ProfileMigrator` type are now exported. `migrate()` accepts an optional `migrations` arg for test injection. Existing behavior unchanged at v1 (no migrators in the production map yet).
- **`frontend/src/profile-crud.ts`** — `buildJsonIoSection(profileName)` is appended inside `buildCrudSection` under the CSV import section. Renders Export button + Import file picker + preview area + Replace / Cancel buttons. `handleJsonImportReplace` does optimistic local save + PUT-replace-server + rollback-on-failure (reuses slot 6's `putProfileTargets` — no new API surface).
- **`frontend/src/style.css`** — `.profile-crud-jsonio` / `.profile-json-preview` / `.profile-json-summary` / `.profile-json-errors` styles, matching the existing CSV section's visual rhythm.
- **`frontend/test/profile-json-io.test.ts`** (new, 25 tests): export envelope shape, malformed JSON / wrong format / future schema rejection, hypothetical v0 → v1 migration via injected migrator, target validation (valid + invalid split), `downloadProfileJson` blob URL + anchor click, `readProfileImportFile` happy + reject paths.
- **`frontend/test/profile-json-import.test.ts`** (new, 13 tests): DOM rendering, Export button click → blob URL, import preview shows count + cross-profile warning, future-schema preview error, malformed JSON preview error, Replace triggers PUT, Replace rollback on 5xx, cross-profile name handling (active name preserved), distanceThresholdKm + removedCuratedIds adoption, Cancel resets preview.

### Tests

- Frontend: **729 → 767 vitest pass (+38)**
- `tsc --noEmit && vite build` clean
- No new dependencies (native `Blob` + `URL.createObjectURL` + `FileReader`/`File.text`).

### Decisions

- **Export source is localStorage, not the API.** The design doc said "pull from API" but localStorage holds the operator's actual view (including `removedCuratedIds` and `distanceThresholdKm`, neither of which the API stores). Operators backing up their view want what they see; "wipe local + re-pull from server" is a recovery path the slot 6 API already covers.
- **Cross-profile import KEEPS the active profile name.** Importing Jack's file into Anil's profile copies Jack's targets / hidden curated / threshold into Anil's bucket; the active profile's `name` is preserved. A warning surfaces in the preview so the operator can cancel if that's not what they meant.
- **Replace semantics for the server side.** PUT replaces the entire server list rather than diff-merging, matching the existing `putProfileTargets` contract. The local save is also a full replace (with current name preserved).
- **v0 schema is hypothetical/testing-only.** v0 → v1 migrator lives in the test fixture, not the production `MIGRATIONS` map. Production today has no migrators; the framework is in place so the next schema bump (v2) plugs in as a single map entry.

### How to manually test

1. Open `https://map.astroanil.dev/?u=jack` with `opd-calib-token` set in localStorage. Add 2-3 personal targets via the Profile tab.
2. Scroll to **Backup / Restore (JSON)**. Click **Export profile**. Browser downloads `jack-profile.json`. Open it in a text editor — verify the envelope (`format`, `schemaVersion`, `exportedAt`, `appVersion`, `profile`) and that the profile contents match what you see in the Profile tab.
3. Edit the downloaded file: change one target's `name` field (e.g., "Boston" → "Boston Edited"). Save.
4. Back in the app, **Import file** → pick the edited file. Preview shows "N valid targets" + "REPLACES all personal targets" warning + the meta line (schema v1, exported timestamp). Click **Replace personal targets**. Toast confirms the import; the personal-targets list re-renders with the edited name.
5. Negative path: download the export, then edit the file to set `"schemaVersion": 999`. Re-import. Preview shows "This export needs app v999+. You have v1." with the action row hidden — no Replace button.

## [1.6.11.0] - 2026-05-26

### Slot 9 — CSV import to Profile tab

The Profile tab gains a bulk-import surface. Operators paste a CSV (or pick a `.csv` file), preview row-by-row outcomes with line numbers, and import all valid rows in one shot. The flow is transactional in the UX sense (preview-then-confirm) but uses per-row POSTs under the hood so partial network failures degrade gracefully: successful rows persist, failed rows roll back locally to keep the operator's view consistent with what the server actually accepted.

### Added

- **`frontend/src/csv-parse.ts`** — new pure parser (no DOM, no localStorage, no async). State-machine implementation handles double-quoted fields with embedded commas, escaped quotes (`""`), and embedded newlines. Format spec lives in the header comment. Reuses slot 6's `validatePersonalTargetInput` row-by-row so the error codes match the rest of the validation surface (`lat_out_of_range`, `name_empty`, `priority_out_of_range`, …). Returns `{ valid, errors, topLevelError? }`.
- **`frontend/src/profile.ts`** — `addPersonalTargetsBatch(profile, targets)` helper for the optimistic bulk-add. Immutable, rejects duplicate ids within the batch or against existing additions.
- **`frontend/src/profile-crud.ts`** — `buildCsvImportSection(profileName)` renders the file picker + paste textarea + Preview/Import/Cancel buttons + preview area. Mounted under "Hidden curated targets" inside `buildCrudSection`. Bulk-import flow saves locally first, fires `postProfileTarget` per row via `Promise.allSettled`, then reconciles: successful rows stay, failed rows roll back, one summary toast at the end.
- **`frontend/test/csv-parse.test.ts`** — 33 new parser tests: happy path, quoting (embedded commas, escaped quotes, embedded newlines), per-row validation (lat/lon/name/priority/column-count) with line numbers preserved, top-level header errors, edge cases (empty input, CRLF, blank-line + `#` comment skipping, tab-separated rejection).
- **`frontend/test/profile-csv-import.test.ts`** — 17 new integration tests covering `addPersonalTargetsBatch`, the DOM rendering for the new section, Preview button parsing, Import-disabled state when no valid rows, top-level header error rendering, XSS-via-textContent discipline, bulk POST + per-row rollback, mixed success/failure paths, optimistic-before-settle ordering.

### Tests

- Frontend: **679 → 729 vitest pass (+50)**
- `tsc --noEmit && vite build` clean
- No new dependencies (state-machine parser in ~280 lines beats pulling in `papaparse`)

### CSV format spec

Header row REQUIRED. First non-blank, non-comment row must be `name,lat,lon` or `name,lat,lon,priority`. Body rows match the header column count; priority is per-row-optional and defaults to 5 (matches the slot 6 add form). Double-quoted fields support embedded commas, embedded newlines, and `""` to escape a literal quote. Lines starting with `#` are comments; blank lines are skipped. LF and CRLF line endings both work. Tab-separated is NOT supported. `id` and `createdAt` are minted client-side (the operator's Excel paste won't have them).

### How to manually test

1. Open `https://map.astroanil.dev/?u=jack` with `opd-calib-token` set in localStorage. Switch to the **Profile** tab.
2. Scroll to **Bulk import from CSV**. Paste:
   ```
   name,lat,lon,priority
   Boston Aerial,42.3601,-71.0589,8
   Bad Row,999,0,5
   Lago di Como,46.0,9.25
   ```
3. Click **Preview**. Summary reads `2 valid, 1 errors`, and the error list shows `Line 3: Latitude must be between -90 and 90` with the raw row content rendered as `<code>`.
4. Click **Import 2 valid**. Toast shows `Imported 2 targets.` and the **Your targets** list above gains both rows. Reload the page → the rows persist (localStorage + `/api/profiles/jack/targets` POST went through for each).

## [1.6.10.0] - 2026-05-26

### Slot 8 — Per-profile Log tab filter (frontend half)

The Log tab now reflects the active astronaut's records, not Anil's. The backend half of slot 8 shipped in v1.6.4.0 (worker validates + filters by `profile`); the frontend was still calling `/api/log?limit=100` without a `profile` query, so Jack's Log tab fell through to the Worker's legacy-default filter (`profile === 'anil' OR missing`) and showed Anil's records.

### Added

- **`frontend/src/log.ts`** — `fetchLog(baseUrl, limit, profileName?)` gains an optional `profileName` argument. When supplied, the helper appends `&profile=<encoded-name>` to the URL. When omitted, the URL is unchanged (back-compat — the Worker's legacy-default filter handles pre-v1.6.3.0 records). Defensive `encodeURIComponent` mirrors the slot 6 precedent in `profile-api.ts`.
- **`frontend/src/main.ts:loadLogPane()`** — passes `getCurrentProfile()?.name` as the third arg to `fetchLog()`. One-line change. Mirrors the `buildPayload()` discipline in `calib.ts`.
- **`frontend/test/log.test.ts`** — four new tests cover the per-profile branch + back-compat + URL-encoding + custom-baseUrl-and-limit interaction.

### Tests

- Frontend: **675 → 679 vitest pass (+4)** in `test/log.test.ts`
- `tsc --noEmit && vite build` clean
- Backend: untouched (worker shipped in v1.6.4.0)

### Deferred to slot 8b

- "Mark shot" / "got it" status badge on Profile tab personal-target rows (read-side aggregation from `fetchLog(profileName)`). Skipped to keep this slot tight; the calib-log POST plumbing already records the data, so the badge is purely a read-time UI add when a future slot picks it up.

### How to manually test

1. Open `https://map.astroanil.dev/?u=jack` with `opd-calib-token` set in localStorage. Click **Shoot** on any pass card. DevTools → Network → `/api/log` POST shows `"profile": "jack"` in the body (already true since v1.6.4.0).
2. Switch to the **Log** tab. The GET request is now `/api/log?limit=100&profile=jack` (not `/api/log?limit=100`). The list shows ONLY Jack's records — Anil's shoots from `?u=anil` no longer leak in.
3. Open `?u=anil` in another tab. The Log tab there issues `/api/log?limit=100&profile=anil` and shows Anil's records (including legacy records missing a `profile` field — the worker's filter accepts both). Cross-confirm Jack's and Anil's lists are disjoint.

## [1.6.9.0] - 2026-05-26

### Slot 6 — Profile tab CRUD with optimistic UI + API sync

The Profile tab gains add/remove/hide controls. Each mutation goes optimistic-local first (`saveProfile()` → re-render), then fires the corresponding `/api/profiles/<name>/targets` call in the background; failures roll back the local change and surface a toast. Curated-removal toggles stay local-only — the daemon multiplexer (slot 4) already reads `removedCuratedIds` from the profile JSON it fetches, so no second API surface is needed for that path.

### Added

- **`frontend/src/profile.ts`** — new pure helpers (don't touch existing exports):
  - `validatePersonalTargetInput()` — mirrors `worker/src/profiles.ts:validateTarget` field-by-field (lat ∈ [-90,90], lon ∈ [-180,180], name 1-200 chars, priority integer 1-10, id matches the worker's `^personal:[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9_-]{1,128}$` pattern). Runs BEFORE the optimistic write so invalid input never reaches localStorage or the network.
  - `makePersonalTargetId(profileName)` — mints `personal:<profile>:<crypto.randomUUID()>` with a Math.random fallback for ancient browsers.
  - `addPersonalTarget` / `removePersonalTarget` / `toggleCuratedRemoved` — immutable profile mutators (return NEW profile so caller can hold the previous copy for rollback).
- **`frontend/src/profile-api.ts`** (new, ~130 lines) — thin wrapper over the Worker CRUD routes. `putProfileTargets` / `postProfileTarget` / `deleteProfileTarget`. Reads `opd-calib-token` from localStorage (same shared secret as `/api/log`); returns `{ok:true, data}` or `{ok:false, reason, status?, detail?}` with stable `reason` discriminant (`token_missing` / `network` / `validation` / `http`).
- **`frontend/src/profile-crud.ts`** (new, ~380 lines) — Profile-tab CRUD UI. Three sub-sections: add-target form (name + lat + lon + priority), personal-targets list (delete per row), and curated-hidden chip list (paste-id-to-hide + restore-per-chip). All operator strings flow through `textContent` — premise 12, no new XSS surfaces.
- **`frontend/src/profile-ui.ts`** — single line: `container.appendChild(buildCrudSection(activeName))` inside `renderProfilePane()`. CRUD section lives below the picker + threshold sections, same `.profile-section` scaffolding.
- **`frontend/src/style.css`** — ~50 lines of styling for the CRUD form (matches existing `.profile-row` / `.profile-btn` scaffolding; adds `.profile-crud-row` / `.profile-crud-chip` / `.profile-input-coord`).
- **`frontend/test/profile-crud.test.ts`** (new, 46 tests):
  - `validatePersonalTargetInput`: 17 tests covering happy + every error code (name_empty, name_too_long, lat/lon out_of_range, priority not_integer / out_of_range, id_profile_mismatch, invalid_id, invalid_profile_name, invalid_createdAt)
  - Pure mutators: 5 tests (add immutable, add duplicate-throws, remove + idempotent no-op, toggle round-trip)
  - API client: 7 tests (token_missing short-circuit, header + body shape, 400/validation, 503/http, network throw, DELETE URL-encoding, PUT payload shape)
  - Optimistic UI: 7 tests (add persists BEFORE fetch resolves, rollback on 5xx / offline / 401, delete persists then DELETE, delete rollback, curated toggle round-trip without API call)
  - DOM: 6 tests (add form inputs present, empty-state copy, one row per personal target, chip per `removedCuratedIds`, textContent-XSS-escape, rerender swaps node in place)

### Tests

- Frontend: **612 → 658 vitest pass (+46)** in `test/profile-crud.test.ts`
- `tsc --noEmit && vite build` clean
- Backend: 595 pytest unchanged (no worker code in this slot)

### Decisions

- **`profile-crud.ts` as a new file** (not extending `profile-ui.ts`). The picker + threshold sections are tightly coupled (both subscribe to `profile-changed`); the CRUD section has its own optimistic+rollback discipline. Splitting keeps each file scoped per design-doc slot and matches the precedent set by `photo-lookup.ts` living separately from `profile-ui.ts`.
- **Curated-toggle UI is paste-id-then-hide rather than per-row-toggle.** The frontend doesn't currently load the full curated catalog (slot 5 dual-source will expose it). Rather than gold-plate a fetch path that's about to land, the v1 surface exposes the raw `removedCuratedIds` interface the daemon already consumes. Restore-per-chip + paste-id-to-hide covers the operator workflow (Anil knows the ids; astronauts hit Restore on chips). Slot 5 can swap in a per-row picker once curated metadata is client-side.
- **Curated removal makes NO API call.** It's a profile-local setting; the daemon multiplexer (slot 4) reads `removedCuratedIds` from the profile JSON it pulls from the Worker. saveProfile() is the persistence boundary; the daemon picks the change up on the next tick.
- **No event-bus emission** — `saveProfile()` already dispatches `'profile-changed'` (slot 11 will gain debouncing). When the debounced bus lands, this module benefits for free.
- **Toast reuse** — calls into the existing `#toast` element from index.html rather than building a parallel toast system.

### How to manually test

1. Open `https://map.astroanil.dev/?u=jack`, click **Profile** tab → Personal targets → fill in name + lat + lon + priority → click **Add target**. Toast says "Added target ...". Refresh the page; the row persists (localStorage) AND the daemon scoring picks it up on the next tick (Worker R2).
2. Click **Delete** on a personal target row → row disappears immediately (optimistic), DELETE fires, toast confirms. Open DevTools → Network and throttle to Offline before clicking Delete: the row vanishes, the API call fails, the row REAPPEARS (rollback) + the toast says "Delete failed: network unreachable".
3. In the **Hidden curated targets** input, type `aurora-scandinavia` → click **Hide**. Chip appears. Click **Restore** on the chip → chip vanishes. Verify in DevTools → Application → localStorage → `opd-profile-jack` that `removedCuratedIds` reflects each click.

## [1.6.8.0] - 2026-05-26

### Frontend dual-source manifest fetch — Jack sees Jack's scoring (slot 5).

The v1.6.7.0 daemon writes per-profile `passes/status/top5/top_24h` to `artifacts.profiles.<name>.*` in the manifest. This release teaches the frontend to read them: when `?u=jack` is set, the manifest resolver prefers the per-profile variant for `passes`, `status`, `top5`, `top_24h` and falls back to the canonical top-level entry when the variant is missing. Together with the v1.6.7.0 daemon, Jack now sees his Boston targets scored by the FULL pipeline (weather, clouds, lightning, regime, freshness) instead of the curated 137. `track` stays canonical (the ISS orbit is profile-agnostic).

### Added

- **`frontend/src/manifest.ts`**:
  - `resolveArtifactEntry(manifest, name, profileName?)` — central dual-source resolver. Per-profile variant wins when present; falls back to canonical. Used by every fetch helper.
  - `isArtifactEntry()` type guard — disambiguates `ArtifactEntry` (flat) from `ProfileArtifactsBlock` (nested) in the widened `Record<string, ArtifactEntry | ProfileArtifactsBlock | undefined>` value type. Includes an explicit `!== null` guard so a hand-edited `profiles: null` falls through to canonical instead of throwing (JS `typeof null === 'object'` quirk).
  - `fetchArtifact`, `fetchPasses`, `fetchTop5`, `fetchTop24h`, `fetchStatus` now accept an optional `profileName` and thread it through `resolveArtifactEntry`. SHA-256 verification automatically targets the variant's hash (not the canonical's) because the resolver returns the right entry.
  - `fetchTrack` is explicitly profile-agnostic (no `profileName` parameter) — the ISS ground-track polynomial + raw SGP4 samples + TLE are the same regardless of which astronaut is looking.
- **`frontend/src/types.ts`**:
  - `Manifest.artifacts` widened to `Record<string, ArtifactEntry | ProfileArtifactsBlock | undefined>` so the `profiles` key can hold the nested per-astronaut block without breaking flat consumers.
  - `ProfileArtifactsBlock` type alias for the `Record<profileName, Record<artifactName, ArtifactEntry>>` shape.
- **`frontend/src/main.ts`**:
  - `doRefresh()` passes `currentProfile?.name` to `fetchPasses` / `fetchTop24h` / `fetchStatus` so Jack's refresh path pulls Jack's variant.
- **`frontend/src/map.ts`**:
  - `renderMap()` reads `parseProfileFromURL(window.location.href)` and threads the profile name through `fetchArtifact<PassEntry[]>(manifest, 'passes', '', profileName)`.

### Tests

- **`frontend/test/manifest.test.ts`**: +17 tests covering the resolver:
  - Variant precedence when present
  - Canonical fallback when variant is missing
  - Pre-v1.6.7 manifest compatibility (no `profiles` key)
  - Mixed manifests (some artifacts have variants, some don't)
  - SHA-256 verification against the variant's hash, not the canonical's
  - Plus 2 regression tests added during /review for the null-guard bug:
    - `tolerates manifest.artifacts.profiles === null without throwing`
    - `tolerates a profile entry that is not an object (corrupted block)`
- Frontend suite: 612 → 629 passing. typecheck clean.

### Notes

- Pre-v1.6.7 manifests (no `profiles` block) and v1.6.7+ manifests without `OPD_CALIB_TOKEN` set on the daemon (empty `profiles` block) both fall through cleanly to canonical — no flag, no migration. The frontend is forward-and-backward compatible.
- This completes the dual-source read path. Slot 6 (Profile tab CRUD with API sync) is next; slot 7+ are deferred to the next batch.

## [1.6.7.0] - 2026-05-26

### Daemon multiplexer — per-astronaut passes/status/top5/top_24h (Lane C: slot 4).

The daemon now produces per-profile pass artifacts so Jack and Chris see their own scored views. Jack's personal targets (uploaded to R2 via `/api/profiles/jack/targets` in v1.6.4.0 + v1.6.6.0) finally get the FULL daemon scoring: weather, clouds, lightning, regime, freshness — same pipeline that scores the curated 137.

This is the slot that makes Jack's personal targets useful instead of just stored. Together with slot 5 (frontend dual-source, pending) and slot 6 (Profile tab CRUD, pending), it completes the per-astronaut feature.

### Added

- **`generator/multiplex.py`** (new, 340 lines):
  - `fetch_profile_targets(name)` — GETs `/api/profiles/<name>/targets` from the Worker with `x-calib-token` from `OPD_CALIB_TOKEN`. Validates each row (id pattern, lat/lon bounds, priority 1-10, name length, profile match) mirroring `worker/src/profiles.ts` validation. Drops malformed rows with per-row warnings. Falls through to empty list on any fetch failure (network/HTTP/JSON/shape error) so one bad profile doesn't fail the tick.
  - `build_profile_target_list(curated, personal, removed_curated_ids)` — union math. Personal targets win on id collision (defense in depth).
  - `multiplex_enabled()` — env gate. Returns False if `OPD_CALIB_TOKEN` is unset, with a clear warning.
  - `validate_personal_target(raw)` — exported for tests.
- **`generator/main.py`**:
  - Extracted `_write_view_artifacts(...)` — handles next-90 / top25 / upcoming / status build + write for any target set
  - Extracted `_run_profile_multiplex(...)` — fetch → union → find_passes + score → write
  - Canonical pipeline (`passes.json` + friends at top-level) is unchanged for back-compat
  - Multiplex loop runs after the canonical write, per profile in `PROFILE_NAMES`
  - Launches are scored once and shared across all profiles (cheap)
  - Each `_run_profile_multiplex` wrapped in try/except — one bad profile fails locally, the tick still completes
- **`generator/manifest.py`**:
  - `write_manifest()` gains optional `profile_artifacts: dict[str, dict[str, Path]]` kwarg
  - When provided, emits `artifacts.profiles.<name>.{passes,top5,top_24h,status}` block
  - Empty/missing → legacy single-tenant manifest (no `profiles` key) — pre-v1.6.7 frontends keep working unchanged
- **`generator/config.py`**:
  - `PROFILE_NAMES: tuple[str, ...] = ("anil", "chris", "jack")` — static config, intentional. Add a 4th name → one-line PR.
  - `PROFILE_API_BASE = "https://map.astroanil.dev"`
  - `PROFILE_FETCH_TIMEOUT_SECONDS = 10`
- **`ops/com.astroanil.orbit-photo-director.plist`**:
  - `multiplex.py` added to `WatchPaths` (matches existing pattern for generator/*.py — file change triggers launchd restart with fresh modules)
  - Commented-out `OPD_CALIB_TOKEN` block with operator instructions: `launchctl setenv OPD_CALIB_TOKEN <secret>` then reload the daemon. Token can't safely live in the plist (committed to repo).
- **`tests/test_multiplex.py`** (new, 35 tests):
  - `validate_personal_target` happy + 10 parametrized malformed mutations + non-dict rejection
  - `build_profile_target_list` union + removedCuratedIds exclude + personal-wins-on-collision
  - `fetch_profile_targets` no-token / ConnectionError / HTTP-500 / malformed-row-skipped / removedCuratedIds parse / non-object body / missing-targets-key
  - `multiplex_enabled` env gate
  - Integration via `run_tick`: 0 profiles → no per-profile artifacts (single-tenant unchanged); 1 profile + 0 personals → `passes_jack.json == passes.json`; 2 profiles with distinct personals → both in manifest; Worker unreachable → still writes per-profile artifacts (curated-only fallback); malformed target → dropped, others survive; score parity for curated targets across canonical vs per-profile; `removedCuratedIds` excludes targets

### Tests

- Backend: **560 → 595 pytest pass (+35)** in `tests/test_multiplex.py`
- `ruff check` clean
- Frontend: 612 vitest pass unchanged (no frontend code in this slot)

### Decisions / deviations

- **Priority clamp 6-10 → 5**: Worker accepts 1-10 but curated scoring uses 1-5. Daemon collapses 6-10 → 5 at the validation boundary so existing scoring math stays untouched. Documented in `validate_personal_target`.
- **Test mocking strategy**: integration tests patch `generator.main.fetch_profile_targets` (not `requests.get`) to avoid polluting other `requests.get` callers like `fetch_upcoming_launches`. Unit tests for `fetch_profile_targets` itself still patch at the module level.
- **OPD_CALIB_TOKEN unset**: daemon logs clear warning + falls through to single-tenant mode. Existing single-profile output stays the canonical fallback. Operator MUST set it via `launchctl setenv` to enable multiplex.
- **Path A vs Path B for profile storage**: chose Path A (daemon calls Worker API for profile data). Path B (daemon talks to R2 directly via rclone/boto3) deferred — Worker is the system of record.

### Operator action required after deploy

```bash
# 1. Set the CALIB_TOKEN in the daemon's launchctl env (one-time)
launchctl setenv OPD_CALIB_TOKEN <the-secret>

# 2. Reload the daemon so it picks up the env var
launchctl bootout gui/$UID/com.astroanil.orbit-photo-director
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.astroanil.orbit-photo-director.plist
```

After this, the next tick produces `passes_jack.json` + `passes_chris.json` + `passes_anil.json` alongside the existing `passes.json`. Frontend slot 5 will consume them.

If `OPD_CALIB_TOKEN` is NOT set, the daemon logs a one-line warning per tick and produces only the canonical single-profile artifacts. Site keeps working in single-tenant mode.

## [1.6.6.0] - 2026-05-26

### Photo Lookup moves under Profile + Jack's 39 targets bootstrapped + v2 TODOs captured.

Three things in one drop, all small. The big work happens earlier in the day with slots 1-3, 7-8, 11; this is operator-feedback cleanup before Anil takes a break.

### Changed

- **Photo Lookup moved under Profile tab** (Anil 2026-05-26: *"photo look up can be moved to under profile to save some space on top bar. it's kind of a side feature or extra setting."*). Topbar now has 5 tabs (Queue / Upcoming / Map / Profile / Log) instead of 6. The lookup widget renders inside the Profile pane as a sub-section, separated by a thin border. Lazy-load behavior preserved — the `exifr` bundle still only loads when the operator opens the Profile tab. CSS view-state rules simplified (lookup-pane no longer needs its own view-class because it inherits visibility from its parent #profile-pane).

### Added

- **`data/profiles/jack/bootstrap.json`** — 39 of Jack's 42 personal targets, geocoded from his xlsx (`example earth obs table.xlsx`) via Nominatim. Each entry has the v1 API fields (id, name, lat, lon, priority, createdAt) PLUS `_v2_rating` (`unshot` | `rough` | `great`) and `_v2_notes` for v2 rating-UX migration. 2 entries skipped (ambiguous: "Wine country Italy?" and the carrier op zone); 1 entry was a blank row.
- **`scripts/bootstrap_profile.py`** — one-shot uploader. Reads `data/profiles/<name>/bootstrap.json`, strips `_v2_*` fields, PUTs to `/api/profiles/<name>/targets` on the live Worker. Requires `OPD_CALIB_TOKEN` env var (same shared secret as `/api/log`). Has a `--dry-run` flag for sanity-checking before the network call.
- **`TODOS.md` updates**:
  - Jack section added under operator-feedback tracker (slot status, v2 rating options A/B/C with recommendation, v2 CEO targets feature stub awaiting screenshot, spreadsheet column improvements from Jack's first paragraph)
  - CEO targets captured per Jack's note: "set of zoomed-in pictures, with ISS track up, with notated landmarks. Updates daily on ISS, no historical look-back." Implementation likely needs vision model + landmark matching against curated targets. Spec waits on a real screenshot.

### How to upload Jack's targets to the live profile

```
OPD_CALIB_TOKEN=<the-wrangler-secret> python scripts/bootstrap_profile.py jack
```

This PUTs all 39 targets to `https://map.astroanil.dev/api/profiles/jack/targets`. After that, opening `https://map.astroanil.dev/?u=jack` will show Jack's queue scored by the daemon once slot 4 (daemon multiplexer) ships. In the meantime, the Worker API stores the data and Jack's profile is ready for slot 5 + 6 integration.

## [1.6.5.0] - 2026-05-26

### Per-astronaut profile layer — Profile tab UI + picker + distance slider + event bus (Lane A: slots 2 + 7 + 11).

Frontend half of the multi-astronaut feature. Adds the **Profile** tab to the topbar nav with a profile picker (dropdown to switch between Anil/Chris/Jack/etc.), a distance threshold slider, and a profile-changed event bus that subscribers debounce at 150ms + auto-syncs across tabs via `storage` events.

Backend half (`/api/profiles/<name>/targets` Worker API + `/api/log` profile scoping) shipped in v1.6.4.0 (Lane B, PR #56). Together these unblock slots 5 + 6 (frontend dual-source + Profile tab CRUD with API sync).

### Added

- **`frontend/src/profile-ui.ts`** (new module): Profile pane renderer
  - Profile picker dropdown (lists `listProfiles()`, selected = `getCurrentProfile()?.name`)
  - "New profile" button + name input with `isValidProfileName` validation
  - "Delete this profile" with confirm
  - Distance threshold slider (100-2000 km, default 1500, `oninput` debounced 150ms)
  - Switching profile mutates URL via `history.pushState` then `location.reload()`
- **`frontend/src/profile-events.ts`** (new module): `subscribeProfileChanged(handler)`
  - Wraps `addEventListener('profile-changed')` AND `addEventListener('storage')` (filtered to `opd-profile-*` keys)
  - 150ms leading-edge + trailing-coalesce debounce
  - Returns an unsubscribe function
- **`frontend/index.html`**: new Profile tab button + pane container + topbar profile badge (`👤 Jack`)
- **`frontend/src/style.css`**: Profile pane styles, badge, slider, view-profile hide rules
- **`frontend/src/main.ts`**: `loadProfilePane()` lazy-imports profile-ui, `renderTopbarProfileBadge()` updates on 'profile-changed', `applyDistanceFilter()` applied to queue/upcoming list builders
- **`frontend/src/map.ts`**: `filterPassesByDistance()`, `readActiveDistanceThresholdKm()` (reads profile fresh from localStorage to avoid circular import), `applyDistanceThreshold()`, `bindProfileChangedListener()` one-time bind in `renderMap()`. `refreshTargetsSource()` honors the threshold.

### Tests

- Frontend: **562 → 610 (+48)** across three new test files
  - `profile-ui.test.ts`: 22 + 7 = 29 tests (picker, new/delete, slider integration)
  - `map-distance-filter.test.ts`: 8 tests (filter pure logic + map integration)
  - `profile-events.test.ts`: 11 tests (local event, cross-tab storage, debounce coalesce, unsubscribe)
- `tsc --noEmit` + `vitest run` green per slot

### Decisions

- Threshold reader uses `loadProfile(parseProfileFromURL(href))` directly instead of calling `main.ts:getCurrentProfile()`. Avoids a circular import and keeps the map authoritative on every render (the in-memory `currentProfile` in main.ts only refreshes on the bus subscriber's fire).
- Topbar badge shipped in slot 2 (a one-liner in `init()`) instead of slot 11 — kept the diff focused.

### Not in this drop

- Personal-target compute via browser-Worker SGP4 (slot 5)
- Profile tab add/remove with API sync (slot 6) — picker only manages profile identity in v1.6.5.0, not target lists
- gotIt UI (slot 8 backend exists in v1.6.4.0; UI lands later)
- CSV / JSON import (slots 9 + 10)

## [1.6.4.0] - 2026-05-26

### Per-astronaut profile layer — Worker API + calib scoping (Lane B: slots 3 + 8).

Second drop in the multi-astronaut feature. Backend half of the personal-target storage + photo-log scoping. No visible UI change yet — Lane A (slots 2 + 7 + 11) lands the frontend tabs/picker/slider in the next PR.

### Added

- **`worker/src/profiles.ts`** (new): CRUD handlers for `/api/profiles/<name>/targets`
  - `GET` returns the profile's `PersonalTarget[]` from R2 at `profiles/<name>/targets.json`; empty list for missing object (the "no targets yet" state, NOT 404)
  - `PUT` replaces the entire list; validates each entry (name, lat/lon in bounds, priority 1-10, id format `personal:<name>:<token>`)
  - `POST` appends one target; 409 on duplicate id
  - `DELETE /api/profiles/<name>/targets/<id>` removes one entry; 200 idempotent on non-existent id (retry-safe)
  - Per-profile cap of 500 targets (`too_many_targets` 400 on overflow)
- **`worker/src/shared.ts`** (new): hoisted helpers — `constantTimeEqual`, `jsonResponse`, `isValidProfileName` (regex matches `frontend/src/profile.ts:isValidProfileName` exactly, single source of truth)
- **`worker/src/index.ts`**: profiles route wired in; PUT/DELETE added to CORS + allowed methods; legacy endpoints keep 405 on unsupported verbs
- **`/api/log` (slot 8)**: payload gains optional `profile` field. Stored with each log entry; GET supports `?profile=<name>` query filter; backward-compat: missing field defaults to `"anil"` so pre-v1.6.4.0 entries surface for the canonical operator
- **`frontend/src/calib.ts`**: `buildPayload()` stamps `profile` from `getCurrentProfile()?.name`, default `"anil"`
- **`frontend/src/types.ts`**: `CalibPayload.profile?: string` typed (optional for back-compat)

### Auth

All `/api/profiles/*` routes require the existing `x-calib-token` header validated against `CALIB_TOKEN` env via `constantTimeEqual`. Single shared secret for all astronauts (locked in eng review premise 12 — trust model justifies; per-profile HMAC tokens deferred to v2 TODO).

### Tests

- Worker: 68 → 109 (+41). Profiles: 33 new in `worker/test/profiles.test.ts`. Calib: 8 new in `worker/test/index.test.ts` for slot 8.
- Frontend: 562 → 564 (+2) in `calib.test.ts` covering the profile field in payload.

### Decisions (deviations from the design doc, all matching existing repo conventions)

- **R2 binding**: reused existing `CALIB` bucket (no new `R2_BUCKET` binding needed in v1; profiles share the operator-mutable bucket with calib).
- **Endpoint name**: extended `/api/log` (the actual existing endpoint) instead of `/api/calib` (which doesn't exist in this repo). Design doc had the wrong name.
- **DELETE idempotency**: chose 200 + `{ok:true, removed:false}` over 404 on non-existent id (retry-safe under network flake).
- **id format**: accepts `personal:<profile-name>:<token>` where token is 1-128 chars of `[A-Za-z0-9_-]` (less strict than UUID-v4 to avoid rejecting legitimate client variants; tenant isolation still enforced via the profile segment).

## [1.6.3.0] - 2026-05-26

### Per-astronaut profile foundation (slot 1 of 11).

First slot of the per-astronaut profile layer designed during /office-hours and /plan-eng-review on 2026-05-26 (see `~/.gstack/projects/anilsamoil-orbit-photo-director/astroanil-main-design-20260526-083510.md`). This slot ships data model + URL routing only — no UI change, no behavior change. Foundation for Jack's onboarding.

The full feature lets a new astronaut (Jack) pick up the tool with his own targets + photo log isolated from Chris's view, via `map.astroanil.dev/?u=jack`. Architecture: daemon-side overlay (per-astronaut `passes_<name>.json`) with browser-Worker instant-buffer for additions between ticks. Hybrid auth via existing `CALIB_TOKEN`.

### Added

- **`frontend/src/profile.ts`** (new module, 230 lines): `Profile` + `PersonalTarget` types with schema version field; `parseProfileFromURL()` reads `?u=jack` or `/jack` path with strict name validation (lowercase + digits + hyphens, length 1-32, no path traversal); `loadProfile(name)`, `saveProfile(profile)`, `listProfiles()` with sorted ASCII order; `migrate(raw)` chain framework (no migrators yet at v1); `createDefaultProfile(name)`; `loadOrCreateProfileFromURL(urlHref)` one-call boot entry; fires `'profile-changed'` CustomEvent on every save with `{detail: {name}}` so future subscribers (Map tab refresh, topbar badge, Queue list builder) can react.
- **`frontend/src/main.ts`**: `init()` resolves the active profile from the URL before any manifest fetch. Exports `getCurrentProfile()` for downstream modules. Failure path (corrupted localStorage from a future-versioned profile) auto-recreates the default.
- **`frontend/test/profile.test.ts`** (35 new tests): URL parsing across `?u=`, path segment, malformed URLs, validation patterns; save/load roundtrip + namespace isolation between two profiles; corruption + future-version handling; `listProfiles()` filtering corrupt entries; `'profile-changed'` event dispatch contract.

### Not in this slot

- No UI surface yet (Profile tab + picker land in slot 2)
- No daemon multiplex yet (slot 4)
- No Worker API for personal targets (slot 3)
- No browser-Worker pass computation (slot 5)
- No `/api/calib` profile field (slot 8)

Existing single-profile manifest fetch is unchanged — slot 5 makes it profile-aware.

## [1.6.2.0] - 2026-05-23

### Pin-drop popup now tells you where to point the camera.

Drop a dot anywhere on the map; the popup gains a "shoot from" hint for every upcoming pass — the angle off ISS nadir, which window to use (WORF vs Cupola), and which direction relative to ISS direction-of-travel (fore / aft / port / starboard). Matches the same hint format the score-sorted cards already use.

Old popup:
```
+12m  2026-05-29 23:33Z  450 km  twilight
```

New popup:
```
+12m  23:33Z  450 km  28° · WORF · starboard  twilight
```

### Added

- `frontend/src/pin-drop.ts`:
  - `UpcomingPass` now carries optional `issAltKm`, `angleOffNadirDeg`, `relativeBearingDeg`. Older builds without these render the legacy 4-column layout.
  - `angleOffNadirDeg()` — spherical-Earth formula matching `generator/orbit.py`. <30° → WORF (Destiny lab nadir window). ≥30° → Cupola (panoramic dome).
  - `greatCircleBearingDeg()` — inlined to avoid a pin-drop ↔ map import cycle.
  - `findUpcomingPasses()` now computes the new fields at closest approach: one extra `issPositionWithAltSGP4` for the altitude + a +30s sample for the ISS heading; falls back to optional-undefined when SGP4 returns null.
- `frontend/src/map.ts`:
  - `formatShootHint(pass)` — formats `28° · WORF · starboard`, omits direction when bearing missing, returns "" for legacy passes (graceful back-compat).
  - `formatUtcClock(ms)` — clock-only formatter (`23:33Z` instead of `2026-05-29 23:33Z`).
  - Pin-drop popup grid is now 5-column (was 4): rel-time, UTC clock, distance, shoot hint, regime.
  - Popup min-width 280 → 320px to fit the new column.

### Changed

- Pin-drop popup row layout. The UTC column now shows clock-time only (HH:MMZ) — the leading `+12m` / `+1d3h` relative-time chip already implies the day, so the date portion was redundant. This frees the space for the new shoot-hint column without overall popup growth.

### Tests

- `frontend/test/pin-drop.test.ts`: +11 tests covering greatCircleBearingDeg (5 cardinals + range check), angleOffNadirDeg (zero, small-distance formula, WORF/Cupola boundary, horizon), enriched findUpcomingPasses (every pass populates new fields, angle correlates with formula).
- `frontend/test/pin-drop-popup.test.ts`: +12 new tests covering formatShootHint (missing data, WORF, Cupola, boundary, rounding, all 4 directions, no-bearing fallback) and formatUtcClock (example, zero-padding, midnight, no date components).

Suite count: 504 → **527 frontend tests pass** (+23).

## [1.6.1.1] - 2026-05-23

### Loosen ASCENT NET-window filter so the new map layer has launches to render.

Day-after v1.6.1.0 ship: tested the new ascent-trajectory layer on the live site and found `launches_count_upcoming: 0` despite LL2 returning 7+ Falcon 9 / Atlas V / Long March launches in the next week. Cause: `filter_launches()` uses `NET_WINDOW_MAX_SECONDS = 300` (5 min), and every "Go" launch in LL2 right now has a NET window of 15min–2h — they all get rejected. The 5-min cap was correct for OVERHEAD (the geometry depends on knowing the exact ISS-overhead instant) but wrong for ASCENT (the trajectory's ground track shape is t0-independent).

### Added

- `generator/launch_data.py:ASCENT_NET_WINDOW_MAX_SECONDS = 21600` (6h) — covers all SpaceX / ULA pre-day-of windows.
- `generator/launch_data.py:filter_ascent_launches()` — same status gate as `filter_launches`, but with the looser NET window.
- `generator/main.py` — ASCENT pipeline now uses `filter_ascent_launches(launch_fetch.launches)` instead of sharing the tight-filtered `actionable_launches` list. The reserved-slot logic + log line + the new `status.json:launches_count_ascent_eligible` field were updated to match.
- `frontend/src/types.ts` — `Status.launches_count_ascent_eligible?` typed (optional back-compat).
- `tests/test_launch_data.py` — 4 new tests covering constant value, status gate parity, OVERHEAD-vs-ASCENT divergence on a wide-NET fixture, and the 6h boundary.

### Backward-compatibility

- `launches_count_upcoming` keeps its v1.6.0.x semantics (overhead-eligible count). Older readers see no change.
- OVERHEAD pipeline is unchanged — 5-min NET filter still gates the find_passes window.

### Operator impact

After the daemon's next tick, `passes.json` should include ascent entries for the upcoming Falcon 9 / Atlas V launches, and the 🚀 map layer will finally have data to render. Test with the **Atlas V Amazon Leo LA-07** launch at **2026-05-29 23:33 UTC** (NET ±15min, well inside the new 6h window) or any of the Falcon 9 Starlinks in the same window.

## [1.6.1.0] - 2026-05-22

### ASCENT trajectory map layer + plist drift fix.

User reported Starship launched and asked whether the map captured it / showed an ascent trajectory toggle. Investigation found two gaps:

1. `OPD_ENABLE_ASCENT=1` was set in the installed launchd plist (active since 2026-05-17 soak) but the repo template still showed it off — config drift.
2. The ASCENT pipeline produced photo-card entries but no map layer; no visual indication of a launching rocket's predicted ground track.

This ships both fixes.

### Added

- **`generator/ascent.py:build_ascent_trajectory()`** — walks a matched rocket profile at 15s cadence from T+0 to nominal orbit insertion (~9 min). Returns `list[AscentTrajectoryPoint(t_offset_seconds, lat, lon, alt_km)]`.
- **`generator/main.py:_build_ascent_pass_entry()`** — emits the trajectory polyline + pad coords + launch azimuth into the PassEntry's `launch` field. ~35 points × 4 floats ≈ 1KB per ascent entry.
- **`frontend/src/types.ts`** — `PassEntry.launch.trajectory?` typed as `Array<{t_offset_s, lat, lon, alt_km}>`, plus `pad_lat`, `pad_lon`, `launch_azimuth_deg` optionals for back-compat with v1.6.0.x manifests.
- **`frontend/src/map.ts:refreshAscentTrajectorySource()`** — builds two geojson sources (`ascent-trajectory` line + `ascent-pad` point) from every PassEntry with `launch.kind === 'ascent'`. Segments are split antimeridian-safe; per-segment `alt_km` drives the color expression.
- **`frontend/src/map.ts:ascent-trajectory-layer`** — altitude-coded polyline: red at surface (pre-Max-Q), orange through stratosphere, yellow at stage-sep regime, cyan near orbit insertion. Line-width 3, opacity 0.9.
- **`frontend/src/map.ts:ascent-pad-layer`** — red pad-pin circle at T+0. Click opens a popup with launch name, site, and T-0 time.
- **`frontend/index.html`** — new 🚀 toggle button in the topbar overlay-controls row (between the multi-orbit and satellite-picker buttons). Persisted to `localStorage`, default ON.

### Sync (was drifted)

- **`ops/com.astroanil.orbit-photo-director.plist`** — added `OPD_ENABLE_ASCENT=1` and `OPD_ENABLE_WEATHER=1` to the repo template plist. Both were already in the installed copy at `~/Library/LaunchAgents/...`, set during the 2026-05-17 / 2026-05-19 soaks respectively. Template was lagging the live config.

### Operator notes

When a launch with a matched ASCENT profile is upcoming (Falcon 9, Falcon Heavy, Atlas V, Vulcan, Soyuz 2, Long March 5/7, SLS, New Glenn, Ariane 6, Starship) AND the generator's ascent pipeline finds at least one viewable instant, the map shows:

- A red pad-pin at liftoff coordinates.
- A polyline of the predicted climb path, color-coded by altitude (red→orange→yellow→cyan).
- Click the pad pin for a popup with launch details.

If you don't see anything for a launch you expected: either the rocket type doesn't have a profile in `generator/ascent_profiles.py`, the trajectory was rejected by visibility gates (e.g., ISS in shadow throughout the climb), or LL2 hasn't published the launch yet.

## [1.6.0.2] - 2026-05-22

### Housekeeping round 2 — topbar multi-sat readouts + dead-code + log noise.

End-of-marathon polish surfaced by self-QA:

- **Topbar multi-sat readouts** wired (was an unused export from v1.6.0.0). When you select Tiangong / Hubble / etc. via 🛰, the topbar now shows compact `Tg 32.5°N, 118.3°E` next to the existing ISS readout, each in the satellite's track color. Hidden on iPhone-width (<430px) to keep the topbar tight.
- **Removed `export` from `tickSatelliteTracks`** in `map.ts` — only called internally via the 60s setInterval.
- **Downgraded `console.info('[photo-lookup] EXIF fields found:')`** → `console.debug`. Was firing on every photo drop; not useful at the default log level.

Live QA spot-check (browse on prod): zero console messages, picker + follow buttons present, ISS-now showing live SGP4 position.

## [1.6.0.1] - 2026-05-22

### Housekeeping pass.

Strip the v1.5.4.0 diagnostic `console.info` logs added during Chris's follow-ISS bug debug session. They're no longer needed and were leaking to the browser console on every click + every track refresh.

### Changed

- `frontend/src/map.ts`:
  - Removed `console.info('[track]', ...)` from `refreshGroundTrackSource` (was firing on every Now/scrub/multi-orbit toggle).
  - Removed `console.info('[follow-iss] click', ...)` from the follow toggle click handler.
  - Removed `console.info('[follow-iss] easeTo', ...)` from the first-click easeTo path.
- `TODOS.md` — synced to reflect the recent shipping spree:
  - Pettit's 12-ask wishlist now shows 12/12 SHIPPED ✅ (added v1.5.6.0 pin-drop + v1.6.0.0 multi-satellite)
  - Dominick's 3 asks tracker (2/3 — OPTIMIS deferred on cross-astronaut tension)
  - Chris's asks summary (all shipped)
  - Weather v1.3.2 marked SHIPPED with the GLM + GFS-CAPE wiring details

### NOT in scope

- No behavior change. No new feature. No bug fix. Strictly cleanup.

## [1.6.0.0] - 2026-05-22

### Multi-satellite tracking (Pettit ask #6) — finishes the Pettit wishlist (12/12).

Don Pettit's #6 from `project_pettit_feedback_2026_05_19.md`: *"Multi-satellite tracking — Starship, Chinese station (Tiangong), others. Architectural — affects TLE fetch + target picking + scoring."*

Operator picks satellites beyond ISS via a new 🛰 picker button. Each selected satellite gets:
- Distinct-colored ground-track polyline (~1 orbit, refreshed every 60s)
- Live marker at current sub-point (1Hz refresh, SGP4-propagated)
- Section in the pin-drop popup with next 5 passes over the pinned point

### Curated hot-list

| Pick | NORAD ID | Track color |
|---|---|---|
| 🛰️ ISS (Zarya) | 25544 | cyan `#5cd0ff` (existing, always-on, drives scoring) |
| 🇨🇳 Tiangong (CSS) | 48274 | orange `#ff9e2c` |
| 🔭 Hubble (HST) | 20580 | lime `#b0ff5c` |
| 🪐 X-37B | name-resolved | gold `#ffd45c` |
| 🚀 Starship | name-resolved | red `#ff5c5c` |

**+ "Other…" input** for any custom NORAD ID or name fragment. Resolves via CelesTrak.

### Data source: CelesTrak GP API

Free, CORS-enabled, no auth. 6h localStorage cache with stale-fallback on network failure. Never blocks map render (A1 from /plan-eng-review — initial fetch is lazy on selection).

### Implementation

- **`frontend/src/satellites.ts`** (new): `CURATED_SATELLITES`, `SatelliteMeta` with discriminated union `Resolution` (Q1 — explicit over sentinel), `parseCelestrakTLE` 3-line parser (A3) with multi-match count (A4), `fetchSatelliteTLE` with cache + stale-fallback, custom CATNR/name resolvers.
- **`frontend/src/map.ts`**:
  - Multi-satellite state (Map keyed by `metaKey()`)
  - Picker UI with checkboxes + custom-input + multi-match badge
  - Per-satellite track source/layer (sequential 30s polyline samples over 1 orbit)
  - Live markers (CSS-styled circles, color per-satellite)
  - `buildPinDropPopup` refactored to take `PinDropSection[]` (Q2)
  - Pin-drop popup now iterates over ISS + all selected satellites
  - `max-height: 60vh; overflow-y: auto` on popup body (A2)
  - 60s track polyline refresh ticker (P1)
  - 1Hz marker refresh via existing `updateIssNow` tick (P1)
- **`frontend/src/main.ts`** — 1Hz tick now also calls `mapModule.tickSatelliteMarkers()`.
- **`frontend/index.html`** — new 🛰 button + picker panel.
- **`frontend/src/style.css`** — picker panel layout, satellite marker style.

### Pettit's 12 wishlist asks — final tally

| # | Ask | Status |
|---|---|---|
| 1 | Multi-orbit display | ✅ v1.5.0.0 |
| 2 | Day-night terminator | ✅ v1.4.2.0 |
| 3 | Cloud overlay toggle | ✅ existing |
| 4 | Validated Kp aurora widget | ✅ v1.2.3.0 |
| 5 | Sun/sunspot widget | ✅ v1.4.x |
| 6 | **Multi-satellite tracking** | ✅ **v1.6.0.0 (this PR)** |
| 7 | Country boundaries | ✅ v1.2.6.0 |
| 8 | Photo timestamp reverse lookup | ✅ v1.3.0.0 |
| 9 | Offline mode | ✅ Lane F SW |
| 10 | Pin-anywhere → best next pass | ✅ v1.5.6.0 |
| 11 | Map pan/scroll continuity | ✅ existing renderWorldCopies |
| 12 | Time scrubbing | ✅ v1.4.0.0 |

### Tests

- `frontend/test/satellites.test.ts` (new) — 24 cases: TLE parser (2-line + 3-line + multi-result), cache hit / miss / 6h expiry / stale-fallback, CelesTrak 404/5xx/timeout/corrupt-body, custom CATNR validation, custom name search, metaKey discriminated union.
- 498 frontend tests total passing (was 474; +24).

### NOT in scope (deferred)

- Per-satellite pass scoring (different Cupola direction / lighting / photographer windows per crewed station). MVP keeps ISS as the canonical scoring path; Queue / Upcoming tabs still ISS-only.
- Multi-orbit display for non-ISS satellites — single-orbit track only.
- Sub-orbital Starship tracking (no stable TLE during the ~10min ascent).
- Vast Haven-1, Blue Origin Orbital Reef — not yet launched; will work via name-search the moment CelesTrak indexes them.
- Generator-side TLE integration — all client-side. Daemon stays as-is.
- Space-Track auth fallback — CelesTrak is good enough.

## [1.5.6.0] - 2026-05-21

### Pin-drop pass lookup (Pettit ask #10) — drop a pin, get the next 5 ISS passes.

Don Pettit's #10 from `project_pettit_feedback_2026_05_19.md`: *"Pin-anywhere on map → 'best next pass' — fundamental shift from fixed targets to ad-hoc target plotting. Currently only pre-defined targets get scored."* This is the inverse of the existing Lookup tab:

- **Lookup tab** (v1.3.0.0): timestamp → ISS position. Reverse-lookup.
- **Map pin-drop** (this PR): location → ISS pass times. Forward-lookup.

### How it works

- **Desktop:** right-click anywhere on the map. Pin drops at that lat/lon, popup shows the next 5 passes.
- **iPhone / iPad:** long-press (≥500ms) anywhere on the map. Same result.
- **Dismiss:** click the pin again. Pin + popup clear.

Each pass row in the popup:

```
+47m   2026-05-21 22:14Z    12 km  day
+2h40  2026-05-22 00:10Z   423 km  night
+4h12  2026-05-22 01:42Z    89 km  twilight
+5h45  2026-05-22 03:15Z   891 km  day
+19h   2026-05-22 15:30Z   156 km  day
```

Columns: relative time, UTC, closest-approach nadir distance, illumination regime (day / twilight / night, color-coded matching the v1.5.3.0 track legend).

### Implementation

- **`frontend/src/pin-drop.ts`** (new):
  - `findUpcomingPasses(track, pinLat, pinLon, nowMs, horizonHours)` — SGP4 walk over 36h at 30s cadence, local-minima detection, parabolic interpolation for closest-approach refinement (A1 from /plan-eng-review — cheaper + more accurate than 5s grid refine), filter ≤ 1500 km ISS horizon, sort + cap at 5.
  - `greatCircleKm()` — haversine, antimeridian-safe.
  - `roundForZoom()` — pin lat/lon precision adapts to map zoom (A3: whole degrees at z<6, tenths z=6-10, hundredths z>10).
- **`frontend/src/map.ts`**:
  - Activation: `contextmenu` (desktop right-click) + `touchstart`/`touchmove`/`touchend` long-press (≥500ms with 8px move threshold to disambiguate from pan).
  - Module-level state for the pin survives Map-tab re-entry within a session (A4); clears on full page reload.
  - `dropped-pin-layer` cyan circle marker, click to dismiss.
  - `buildPinDropPopup()` DOM builder using `textContent`/`createElement` only (Q1 from review — no innerHTML).
  - `bindPinDrop()` wired alongside the other map toggle bindings.
- **Cost:** ~4320 SGP4 calls per pin drop × ~0.1ms = ~432ms. Imperceptible.

### Tests

- `frontend/test/pin-drop.test.ts` — 19 cases: haversine math (antipodal, antimeridian, equatorial), zoom-aware precision rounding, happy-path pass detection, sort order (T5), cap at 5 (T6), filter at ISS_HORIZON_KM, polar-exclusion (no passes at 89°S since ISS doesn't reach polar latitudes), **antimeridian crossing pin at (0°, 180°)** (A2/T4), shorter horizon respects bound, regime classification, malformed-TLE graceful failure.
- 474 frontend tests total passing.

### NOT in scope (deferred)

- **Scoring** (cloud forecast + lighting fit + obstruction at the pin) — basic version surfaces only closest-approach time + nadir + regime. Scoring would need either client-side GFS-cloud lookup or a Worker proxy. Defer until Pettit/Chris use the basic version.
- **Multi-pin / pin history** — single pin only. Replacing a pin replaces the previous.
- **Persist across reloads** — ephemeral by design (matches the operator mental model of "active query," not "saved bookmark").
- **Past-pass lookup at this point** — forward-only; historical is the Lookup tab via timestamp.
- **Photo upload at the pin** — Lookup tab is the photo workflow.

## [1.5.5.0] - 2026-05-21

### Weather v1.3.2 — real lightning samplers (GLM + GFS-CAPE).

v1.3.1 shipped the framework with a `PlaceholderLightningSampler` returning 0.0. v1.3.2 wires real data sources. **Live smoke test confirmed working** — `make glm-smoke` returned 22,297 flashes ingested from 116 spatial buckets across the last 60 min of GOES-East + GOES-West coverage.

### Added

- **`GLMSampler`** (`generator/lightning.py`) — observed-lightning sampler via NOAA GLM L2 LCFA NetCDF granules on AWS S3 public buckets (`noaa-goes16` + `noaa-goes18`). Per /plan-eng-review 2026-05-21:
  - A1: 60-min window per tick (~18MB/tick total egress)
  - A2: skip targets outside GOES coverage (lat∈[-60,60], lon∈[-180,-25]) — returns `lightning_source="glm-out-of-coverage"` immediately
  - A4: granule age in source attribution (e.g., `"glm-45m"`) so operator sees freshness
  - A5: warns to log when listing returns 0 results in a window where data is expected
  - P2: 5°×5° spatial bucket index — per-target lookup is O(1) bucket retrieval + O(k) flash-distance check across ≤9 adjacent buckets
  - Direct HTTPS + `netCDF4.Dataset.fromMemory` (no new deps)
- **`GFSCAPELightningSampler`** — wraps the existing `GFSForecastSampler` to extract CAPE (J/kg) and convert to lightning_potential. Saturates at 2500 J/kg = potential 1.0 (severe-thunderstorm threshold per D5).
- **`CombinedLightningSampler`** — fuses observed + forecast per the D5 rule (`max(observed, forecast × 0.7)`). Observed-zero is REAL DATA (Q3: don't fall back to forecast just because GLM reports no flashes nearby). Cascading-failure fallback to placeholder when both samplers have no data.
- **`scripts/glm_smoke.py`** + **`make glm-smoke`** — live-S3 verification hook. Builds a GLMSampler at "now" and reports flash ingestion, age, and sample lookups across 4 test targets. Used to validate the live path; passes existing unit-test mocks.
- **`GFSForecastSampler.cape_at(lat, lon, when)`** in `generator/cloud.py` — new public method returning forecast CAPE J/kg or None.

### Wired

- `generator/main.py:select_lightning_sampler` now builds `GFSCAPELightningSampler` + `GLMSampler` + `CombinedLightningSampler` when `OPD_ENABLE_WEATHER=1`. `PlaceholderLightningSampler` remains the final fallback when both real samplers fail.

### Tests

- 11 new cases in `tests/test_lightning.py`: GOES coverage envelope, no-data path, synthetic flash aggregation + spatial indexing, GFS-CAPE conversion + clamping, observed-zero-is-real-data (T2), cascading failure → placeholder (T3), exception isolation, observed-high-wins-over-forecast (D5).
- 542 generator tests total passing (was 531).

### Live validation

`make glm-smoke` against NOAA S3 — real-time check:

```
GLM-SMOKE @ 2026-05-21T18:51:50+00:00
  total flashes ingested: 22297
  oldest granule age: 59 min
  spatial buckets populated: 116

  New Orleans                  ( 30.00,  -90.00): source=glm-59m, potential=0.011, flashes/min=0.33
  New York                     ( 40.70,  -74.00): source=glm-59m, potential=0.000, flashes/min=0.00
  Santiago                     (-33.00,  -70.00): source=glm-59m, potential=0.000, flashes/min=0.00
  London (outside coverage)    ( 51.50,    0.00): source=glm-out-of-coverage, potential=0.000, flashes/min=0.00
```

### NOT in scope (deferred to v1.3.3)

- Blitzortung WebSocket sampler (long-lived connection doesn't fit hourly batch architecture)
- MTG-LI, JTWC, Vaisala GLD360 — see plan doc for rationale

## [1.5.4.0] - 2026-05-21

### Five bug fixes from Chris's iPhone/Chrome testing.

Chris 2026-05-21 reported four real bugs + one cosmetic ask after testing v1.5.3.x:
1. ☁ "Now" button doesn't recenter on ISS (intentional in original v1.4.0.0 design; flipped per operator mental model)
2. Twilight/day color differentiation vanishes when scrubbing to T+45 and back to Now
3. Multi-orbit display vanishes when scrubbing future and back
4. Per-orbit color shifts would help tell orbits apart
5. Follow-ISS button (🛰) still doesn't appear clickable — possible confusion with the brand mark 🛰️ in the topbar

### Fixed

- **`Now` button now recenters on ISS** (`recenter=true`). Original v1.4.0.0 design passed `recenter=false` to "not disrupt the operator's pan," but operator expectation is "Now = back to current ISS view." Matches T+/T- button behavior.
- **Future view (T+45/T+90) is illumination-aware.** Previously `futureOrbitGroundTrackFeatures` returned plain `LineString` features without illumination tagging → fell back to default cyan at 0.85 opacity, losing the day/twilight/eclipse signal. Now the future-window samples are tagged with `[t_seconds, lat, lon]` triples and run through `splitByIllumination` so cyan/magenta/grey-blue persists at any lookahead.
- **Per-orbit color shift** stacked on top of illumination signal. Layer paint is now a 3 × 4 matrix (3 illumination states × 4 orbit indices = 12 cells). Day orbits shift cyan → cyan-teal → soft-green → yellow-green from orbit 0 to orbit 3. Twilight orbits shift magenta → soft-pink → muted-mauve → dusty-pink. Eclipse orbits shift grey-blue → cooler → teal → dusty-teal. Combined with the existing opacity ramp, orbits are now distinguishable both by hue and brightness.
- **Follow button icon** changed from 🛰 (matched the brand mark 🛰️ in the topbar) to 📍 (pin) — visually distinct from the brand decoration. Reduces clicker-confusion ("which one is the recenter button?").
- **`refreshGroundTrackSource` now logs** `[track]` diagnostic to the browser console showing `{lookahead, multiOrbitVisible, feature_count, orbit_indices, illumination_states}`. If multi-orbit or illumination is missing after a scrub-back-to-Now, the log will tell us exactly what's bailing. Remove after Chris's bug report is resolved.

### NOT yet diagnosed

- Follow toggle (📍) still not clickable in Chris's report. The v1.5.3.1 fix removed the `!map` guard but Chris reports the button still does nothing on Chrome AND Safari AND computer. Possibilities: (a) Chris was clicking the brand mark 🛰️ in the topbar mistaking it for the follow button — addressed by the icon change above. (b) Stale SW cache serving v1.5.3.0 — addressed by reload. (c) Real bug we haven't isolated — `console.info('[follow-iss] click', ...)` will surface what's bailing if it still misbehaves.

### Tests

- 455/455 still passing.

## [1.5.3.1] - 2026-05-21

### Patch: follow-ISS dead button + illumination legend.

Chris 2026-05-21 (post-v1.5.3.0): clicking 🛰 doesn't highlight or pan toward ISS. And: "is there a smart way to add a legend for magenta?"

### Fixed

- **Follow-ISS button now binds unconditionally.** `bindFollowToggle()` had `if (!btn || !map) return;` — if `map` happened to be null at bind time (shouldn't be, but apparently was for Chris), the click handler never attached and the button was permanently dead. Removed the `!map` guard. Click handler attaches as long as the DOM button exists; the dragstart/zoomstart listeners are now wrapped in their own `if (map)` block. Other toggles (clouds, multi-orbit) never had this guard — that's why they worked while follow didn't.
- Added `console.info('[follow-iss] click', ...)` + `console.info('[follow-iss] easeTo', ...)` for live-browser diagnostics in case the button still doesn't behave after this fix.

### Added

- **ISS-illumination legend** under the cloud/terminator/multi-orbit toggle row. Three colored dots + labels (day / twilight / eclipse) so the magenta "twilight" warning state is interpretable at a glance. Tucked into the bottom-left of the map pane, semi-transparent background, `pointer-events: none` so clicks pass through to the map underneath.

### Tests

- 455/455 still passing.

## [1.5.3.0] - 2026-05-21

### ISS-illumination-aware track coloring (Chris ask 3 of 3).

Chris 2026-05-21: *"One thing that our GOISSWatch app does that is nice is that it changes our ISS track line for when the ISS is illuminated by the sun versus not (which is slightly different than when the ground is illuminated by the sun versus not). When the ISS is still in sun, but it is dark on the ground, it is generally a very poor time for photos."*

The ground-track polyline now colors three different ways depending on whether ISS itself is in sunlight, in Earth's shadow, or in the in-between "twilight" zone where ISS is sunlit but the ground below is dark (cabin glare against a dark backdrop — the "poor photo" warning Chris flagged):

| Color | State | Photo conditions |
|---|---|---|
| Cyan `#5cd0ff` | `iss-day` — ISS sunlit + ground sunlit | Daylight pass — best for general earth-obs |
| **Magenta `#d65cff`** | `iss-twilight` — ISS sunlit + ground dark | **Cabin glare reflections; poor for photos** |
| Grey-blue `#7a8aa8` | `iss-eclipse` — ISS in Earth's shadow + ground dark | Night pass — best for city lights, aurora |

The fourth combination (ground sunlit + ISS eclipsed) is geometrically impossible.

### Implementation

- **`frontend/src/terminator.ts`**: new `classifyIssIllumination(when, lat, lon)` returns the illumination state. Math: great-circle angle θ between subsolar point and (lat, lon). θ ≤ 90° → day; 90° < θ < 110° → twilight (the ~19.9° band between ground-terminator and ISS-horizon-from-Earth-center); θ ≥ 110° → eclipse. The 110° threshold is `arccos(R/(R+h)) + 90°` with R=6378.137 km and h=408 km. Frontend-only math; not ported to generator/cloud.py (yet).
- **`frontend/src/map.ts`**:
  - `splitTrackByOrbit()` return type widened to keep `[t, lat, lon]` triples so the illumination split has access to sample times.
  - New `splitByIllumination(samples, trackStartMs)` walks sample times and groups consecutive same-state samples into segments. 1-sample boundary overlap stitches the visual at color transitions (no gap).
  - `buildOrbitLineFeatures()` now stamps both `orbit_index` AND `illumination` on each feature.
  - `iss-track-layer` paint adds a second data-driven `match` expression on `illumination` for line color, alongside the existing `orbit_index` opacity ramp.
- **A7 from /plan-eng-review:** the 90° day-boundary uses `<=` so consecutive samples crossing the terminator land deterministically on the day side. No flicker.

### Tests

- `frontend/test/terminator.test.ts` — 7 new cases for `classifyIssIllumination`: subsolar = day, antipodal = eclipse, 95° = twilight, boundary policy, polar sub-point at equinox, twilight band width sweep.
- `frontend/test/map-orbit-split.test.ts` — 6 new cases for `splitByIllumination` + updated to new `splitTrackByOrbit` return type. Multi-state run, boundary overlap, antipodal eclipse.
- 455/455 tests passing (was 441; +14 new).

### Composition with v1.5.0.0 multi-orbit display

Both data-driven expressions compose. Orbit 0 daylight = solid cyan; orbit 2 twilight = dim magenta; orbit 3 eclipse = very-dim grey-blue. 4 orbits × 3 illumination states = 12 possible visual treatments per track sample.

### NOT in scope

- Generator-side illumination tag on `score_components` (defer until scoring needs it)
- Card-side "twilight pass" badge alongside the track coloring (TODO follow-up if Chris asks)
- Custom colorblind-friendly palette (default magenta is the warning color; iterate if Chris notes contrast issues)
- Per-illumination-state opacity (we use orbit_index for opacity, illumination for color — independent dimensions)

## [1.5.2.0] - 2026-05-21

### Recenter / follow-ISS toggle (Chris ask 2 of 3).

Chris 2026-05-21: *"On the map page, have a button to re-center your view on the ISS (and maybe a button to lock to follow the ISS if you are zoomed in)."*

Single toggle button 🛰 next to the N↑/ISS↑ bearing controls. Click once → ease-pan to the ISS sub-point AND enter follow mode (the 1Hz live-position tick keeps re-centering). Click again, or pan, or zoom, → exit follow silently.

### Added

- **`#toggle-follow-iss` button** in `.map-controls-bearing` (frontend/index.html). Active-state styling reuses `.time-btn` so it matches the rest of the toggle row.
- **`applyFollowISS(pos)`** exported from `frontend/src/map.ts`. Called from the existing 1Hz `updateIssNow()` tick in `frontend/src/main.ts`. No-op when follow is off OR the map module hasn't been loaded yet (Map tab never opened) — preserves the lazy MapLibre bundle load.
- **`bindFollowToggle()`** in map.ts:
  - First click: enters follow + calls `map.easeTo({ duration: 500 })` for a visible jump animation.
  - Subsequent 1Hz updates: `map.setCenter()` (instant, no animation queue) per A5 from /plan-eng-review — easeTo at 1Hz queues animations and jitters.
  - `map.on('dragstart', ...)` and `map.on('zoomstart', ...)` listeners exit follow silently when the user interacts. Only user-initiated zooms (with `originalEvent`) break follow; programmatic moves don't.

### Ephemeral by design (not persisted)

Follow state is NOT saved to localStorage. Other map toggles (clouds, terminator, multi-orbit) persist because they're preferences; follow is a session-local view mode. Most map sessions start by surveying the broader orbit envelope then narrowing to a target; auto-resuming follow would force the operator to manually break it every reload.

### Tests

- `frontend/test/map-follow.test.ts` — 7 cases including the **T2 race test** from /plan-eng-review (dragstart fires before pending tick → tick is a no-op), instant-vs-animated assertion (setCenter not easeTo on recurring), and the user-vs-programmatic zoomstart distinction.
- 441/441 tests passing.

### NOT in scope

- Persisting follow across reloads (ephemeral by design — see above)
- Auto-zoom adjustments while following (operator chose their zoom intentionally)
- Special handling when follow + ISS-up-bearing are both on (compose naturally; user can disable either if it's too busy)

## [1.5.1.0] - 2026-05-21

### Satellite imagery basemap when clouds are hidden (Chris ask 1 of 3).

Chris 2026-05-21 (post-v1.5.0.0): *"When you hide the 'clouds' layer, have it show the Google Maps satellite data (or even just detailed Google Maps map data). This is super useful for picking out features that can guide you on to the right spot for your photo."*

When the ☁ cloud toggle is OFF, the map now swaps from the dark Carto basemap to **Esri World Imagery** — free, no auth, sub-meter resolution in many regions. The operator can now zoom in on a target's predicted overflight area, switch off clouds, and see actual shoreline / mountain / pad geography to orient by.

### Added

- **Esri World Imagery** raster source in `frontend/src/map.ts` (`buildStyle()`). URL: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`. Attribution: Esri, Maxar, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN, GIS User Community.
- New `esri-imagery-layer` (initially hidden) under the existing `carto-dark-layer`. Both basemap layers stay in the style at all times; visibility toggles based on cloud state — no `setStyle()` rebuild required (P1 from /plan-eng-review).
- **`vite.config.ts` runtime cache rule** for `server.arcgisonline.com` — CacheFirst, 100 entries × 7 days, `statuses: [0, 200]`. Matches existing Carto/GIBS pattern.
- **Silent fallback to Carto Dark** if Esri tiles fail to load (A2 from review). One-shot session flag `esriTilesFailed` flips on the first `error` event whose `sourceId === 'esri-imagery'`. After that, clouds-off shows Carto Dark instead of leaving the operator on a blank map. Resets on page reload.

### Changed

- Cloud toggle (☁) tooltip text now describes the basemap swap: *"Clouds shown (dark basemap) — click to hide clouds and show satellite imagery"* and vice versa.
- `applyCloudsVisibility()` now flips three layers per toggle (carto / esri / gibs) instead of just gibs.

### Tests

- `frontend/test/map-basemap.test.ts` — 5 cases: clouds-on visibility, clouds-off visibility, **clouds-off + Esri-failed → Carto fallback** (T3 from review), toggle-clouds-back-on-after-Esri-failed, and error-event source discrimination.
- 434/434 tests passing.

### NOT in scope

- Tile precache for Esri imagery (defer to follow-up if LOS soak surfaces slowness)
- Custom track / pin outlines for higher contrast on bright Esri imagery (cyan track + pin colors are still legible at zoom levels Chris uses; iterate if he reports contrast issues)
- Esri tile error UX (silent fallback was the explicit ship decision)

## [1.5.0.0] - 2026-05-21

### Multi-orbit ground-track display (Pettit Tier B follow-up).

Pettit 2026-05-19 asked for a "multi-orbit display" — show the next 3–4 future ISS orbits on the map simultaneously, not just the next 95-min orbit. Operator gets the full ~6h forward envelope at a glance; pin colors at scrubbed-forward times now sit on visible ground-track lines instead of empty space.

### Added

- **Toggle button ↻ next to ☁ and ☀** in the map control row. Default OFF (existing single-orbit look is preserved for users who haven't reached for it). Persisted to `localStorage['opd-map-multi-orbit-visible']`. Title text flips between "Showing 4 future orbits — click to show just the current orbit" and the reverse.
- **Generator now emits 372 min of track_points** (was 200 min). 372 ≈ 4 × ISS orbital period (92.8 min). Payload grows from ~9.6 KB JSON / ~3 KB gzipped to ~17.8 KB JSON / ~5 KB gzipped — still tiny.
- **Frontend splits track_points into per-orbit segments** via the new `splitTrackByOrbit()` helper. Each segment becomes a separate MapLibre Feature with an `orbit_index` property. The `iss-track-layer` paint uses a data-driven `'line-opacity': ['match', ['coalesce', ['get', 'orbit_index'], 0], 0, 0.85, 1, 0.55, 2, 0.35, 3, 0.2, 0.12]` so orbit 0 stays solid and +1/+2/+3 fade out progressively. Current orbit dominates; future orbits are context, not noise.

### Implementation

- `generator/main.py:914` — `minutes=200` → `minutes=372`. The existing `sample_track_points()` function is unchanged; only the call site widens.
- `frontend/src/map.ts` — new `MULTI_ORBIT_PREF_KEY`, `multiOrbitVisible` state, `ISS_ORBIT_PERIOD_SECONDS = 5568`, exported `splitTrackByOrbit()`, refactored `groundTrackFeatures()` to optionally bucket by orbit, `buildOrbitLineFeatures()` helper, new `bindMultiOrbitToggle()`. Layer paint switched to a data-driven `match` expression.
- `frontend/index.html` — new `<button id="toggle-multi-orbit">↻</button>` after the terminator toggle.

### Tests

- `frontend/test/map-orbit-split.test.ts` — 6 new unit tests covering empty input, exact-period bucketing, custom period, single-orbit input, realistic 4-orbit synthetic input, and index-stability across sparse samples.
- 429 frontend tests total passing (was 423).
- Python: existing 5 `sample_track_points` tests still pass (they parameterize their own `minutes=200`; not coupled to main.py's caller).

### NOT in scope

- ISS-up bearing rotation with multi-orbit display can get visually busy near the poles. v1 ships north-up as the only fully-tested combination; if multi-orbit + ISS-up reveals confusion we'll iterate. The bearing toggle continues to work; the visual interaction is just untested as a combination.

## [1.4.6.0] - 2026-05-21

### Live ISS dot now SGP4-first (fixes ~120 km drift inside the polynomial window).

`/review` measured the order-11 polynomial fit at up to 1.1° lat error vs SGP4 truth — about 120 km on the map. The live ISS dot was visibly off-truth INSIDE the 120-min polynomial window, even though the ground-track polyline (SGP4-driven) and pin geometry agreed. v1.4.6.0 inverts the priority: SGP4 is now the primary path, polynomial is the legacy fallback for pre-V2 snapshots without a TLE.

### Changed

- `frontend/src/iss.ts:liveIssNow()` — tries `liveIssPositionSGP4()` first; only falls back to `liveIssPosition()` (polynomial) when SGP4 returns null (track has no TLE, TLE is malformed, or epoch mismatch).
- Test `frontend/test/iss.test.ts` — "returns the polynomial result inside the window (cheap path)" replaced with "returns the SGP4 result when TLE is available (accurate path)", which also asserts SGP4 disagrees with the polynomial (proves we're actually exercising the new primary path).

### Why SGP4 was the "expensive" framing before

`satellite.js`'s `propagate()` is sub-millisecond per call once the satrec is cached — and we already cache it by `(line1, line2)` string equality in `iss-sgp4.ts`. The "SGP4 is too expensive for 1Hz" caveat in the V2 plan was about the Python generator daemon on the unattended Mac, where the cost framing was speculative. In the browser, 1Hz SGP4 is free.

### TODOS marked shipped

- V2-P2 polynomial fit fix → shipped (Path 2 taken: drop poly, use SGP4)

## [1.4.5.0] - 2026-05-21

### Tier 1 hardening: sha256 verify on artifacts + `make ll2-diff` diagnostic.

Two small ops-hardening items from the V2-P2 / V3-P3 backlog. Both individually cheap but they close real "silently wrong data" failure modes that would be painful to debug mid-mission.

### Added

- **`fetchArtifact()` now verifies sha256** against the value declared in `manifest.json`. `crypto.subtle.digest('SHA-256')` runs on the response bytes; mismatch throws `artifact <name> sha256 mismatch`. The existing transactional refresh in `main.ts` catches the exception and keeps the prior snapshot, so a poisoned fetch degrades to last-good instead of feeding wrong scoring into the UI. Covers: partial R2 deploy where manifest is uploaded before artifacts settle, force-cache holding a corrupted body for a republished version slug, path-level tampering at the artifact URL.
- **`make ll2-diff`** Makefile target diffs the live LL2 (`https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=1`) jq-path set against `tests/fixtures/ll2-response-2026-05.json`. Prints removed/renamed paths with `-`, new paths with `+`. Saves full live response to `/tmp/ll2-live.json` for deeper inspection. Fires manually when the frontend's stale-launches banner appears (driven by `status.launches_schema_hash` ≠ pinned hash).

### Tests

- 3 new `manifest.test.ts` cases: sha256 match → parses normally, mismatch → throws `/sha256 mismatch/`, missing-hash entry → skips verification defensively (older manifests / third-party artifacts).
- 423 frontend tests total passing (was 421, swapped one stub-hash test for three real-hash tests).

### TODOS marked shipped

- V2-P2 sha256 verification → shipped
- V3-P3 `make ll2-diff` → shipped
- V4-P2 per-pin forecast tooltip → noted as already shipped v1.4.1.0 (`buildTargetPopupContent` in `map.ts:971`)

## [1.4.4.0] - 2026-05-17

### File-picker button on the Lookup tab + NEF/RAW coverage advertised.

Anil 2026-05-17: HEIC drop works now, but the operator (on-orbit, mostly iPad/iPhone with the Nikon D5/D6 NEFs as primary) needs a tap-to-upload path in addition to drag-and-drop — and explicit confirmation that NEF files will parse.

### Added

- **"Choose file…" button** beside the dropzone in the Lookup tab. Opens the OS file picker, which on iPad/iPhone surfaces the camera roll directly (no Files-app drag dance). Same ingestion path as drag-and-drop — same EXIF error chip, same resolve→pin flow.
- **Format hint line** under the dropzone: "JPG · HEIC · NEF · CR2/CR3 · ARW · DNG · TIFF". Sets expectations explicitly for the on-orbit Nikon NEF workflow.
- **Explicit `accept` attribute** on the hidden file input: `image/*,.heic,.heif,.nef,.cr2,.cr3,.arw,.dng,.tif,.tiff,.raf,.orf,.rw2`. iOS/macOS pickers respect this and grey out non-matching files.

### NEF / RAW notes

Full `exifr` (shipped v1.4.3.0) reads TIFF natively, and NEF/CR2/CR3/ARW/DNG/RAF/ORF/RW2 are all TIFF-based RAW containers — so the parser was already capable; v1.4.4.0 just advertises that and adds the picker entry point. EXIF IFD lives at the start of these files so `firstChunkSize` defaults are sufficient even for 40MB NEFs.

### Implementation

- `frontend/index.html` — dropzone now contains a hint, a `Choose file…` button, a hidden `<input type="file">`, and a format-list line.
- `frontend/src/photo-lookup.ts` — factored `ingestFile()` so drag-drop and the button share one error/resolve path. Button → `fileInput.click()` → change event → `ingestFile`. Resets the input's value after each ingestion so picking the same file twice re-fires `change`.
- `frontend/src/style.css` — minimal styling for `.lookup-dropzone-hint` and `.lookup-dropzone-formats`.

### Tests

- 421/421 still pass. No new tests; the ingestion path was already exercised via the existing drop handler unit-test fixtures, and the button is a thin one-line `click()` indirection.

## [1.4.3.0] - 2026-05-17

### Operator-observed fixes: HEIC EXIF + offline coastline.

Anil 2026-05-17: a known-good photo (taken today, valid EXIF, parses fine in other tools) failed in the Lookup tab. Root cause: photo-lookup imported `exifr/dist/lite.esm.js`, which is JPG-only. iPhone defaults to HEIC, so every HEIC drop was silently rejected and surfaced the same generic "no EXIF" message. Same release fixes a related but separate gap discovered while looking: the coastline GeoJSON wasn't part of the SW precache, so the world-outline disappeared as soon as connectivity dropped.

### Fixed

- **HEIC EXIF parsing in the Lookup tab.** Swap `exifr/dist/lite.esm.js` (JPG-only, ~8KB gz) for the full `exifr` (~25KB gz). Covers JPEG + HEIC + TIFF. iPhone HEIC drops now resolve normally. Net app shell impact: photo-lookup chunk grew ~15KB gz (28.5 KB total), still lazy-loaded on Lookup-tab open.
- **Coastline works offline.** Added `geojson` to `workbox.globPatterns` in `frontend/vite.config.ts`. `ne_110m_coastline.geojson` (~80KB) is now part of the precached app shell; precache count went 9 → 10 entries. Verified: the new `sw.js` includes `ne_110m_coastline.geojson` in the precache manifest.

### Diagnostic improvement

- `extractExifTimestamp()` now returns an `ExifExtractResult` with a `reason` enum (`ok` / `no-exif` / `no-datetime-original` / `invalid-date` / `parser-error`), the EXIF tags actually found, and file metadata. The dropzone error chip now tells the operator *which* failure mode hit — e.g. "EXIF present but no DateTimeOriginal/CreateDate/DateTime tags" vs "No EXIF metadata in {file}" — so a future regression here surfaces something actionable instead of the old "No EXIF DateTimeOriginal" boilerplate.
- Falls back through DateTimeOriginal → CreateDate → DateTime, so HEICs that store the capture time only on `CreateDate` also resolve.

### Tests

- Existing 421-test suite still passes. No new tests added for the exifr swap (it's a one-line dependency change; vitest's happy-dom doesn't carry a HEIC fixture). Real-iPhone verification is on Anil after deploy.

### NOT in scope

- Forecast-tile overlay (V4-P2), photo-lookup v1.1 historical archive, multi-orbit display, weather v1.3.2 real lightning samplers — all stay deferred.

## [1.4.2.0] - 2026-05-20

### Day-night terminator on the map (Pettit Tier B follow-up).

Pettit 2026-05-19: *"day-night shading"* as part of his map-first workflow. v1.4.0.0 time-scrub answered "what's happening at +6h?" but the operator couldn't visually tell if that future orbit was day-side or night-side. This closes that loop.

### Added

- **Terminator line** drawn as a warm-gold dashed great circle that updates with the operator's time-scrub. Scrub to T+6h → the terminator shifts to where day/night sit at that future moment.
- **Subsolar dot** (gold-filled circle) marks where the sun is directly overhead at the current view time. Operator can read at a glance which hemisphere is in sunlight.
- **Toggle button (☀)** next to the cloud-overlay toggle. Persisted to `localStorage` like the cloud toggle. Default ON.
- **Auto-refresh:** at Now (lookahead=0) the terminator updates every 30s as the wall clock advances. Scrubbed views update on each click.

### Implementation

- `frontend/src/terminator.ts` — new module with `subsolarPoint()`, `equationOfTimeMinutes()`, `terminatorLonAtLat()`, `terminatorFeatures()`, `subsolarFeature()`. Math is a TypeScript port of the existing `generator/cloud.py:sun_subpoint` + `_equation_of_time_minutes` — kept in sync so the JS terminator agrees with the Python `lighting_regime` that drives pin scoring.
- `frontend/src/map.ts` — new `terminator-line-layer` (dashed gold line) + `subsolar-point-layer` (gold dot). `refreshTerminatorSources()` called from `setLookahead()` (scrub) and the 30s wall-clock tick.
- `frontend/index.html` — new ☀ toggle button next to the ☁ cloud toggle.

### Tests

- `frontend/test/terminator.test.ts` — 17 new tests: EoT zero-crossings, solstice/equinox subsolar latitudes (±23.4° at solstices, ~0° at equinoxes), subsolar longitude vs UTC hour, polar-day/night detection, terminator-feature shape + world-copy duplication.
- Full suite: 421 frontend tests passing.

### NOT in scope

- Full polygon fill (semi-transparent dark over the night hemisphere). Requires antimeridian + pole crossings handling that doesn't fit a one-evening implementation. Captured as a follow-up in TODOS.

## [1.4.1.0] - 2026-05-20

### Forecast-cloud tooltip on map pin clicks.

Operator question 2026-05-20 after v1.4.0.0 shipped: *"If I skip forward on the map and look forward in time and it shows a green dot for something to shoot, will that represent potentially things that are good shots based on future probability?"* The answer is yes — the pin colors are already pre-computed forecast scores. This release surfaces the underlying forecast number on demand.

### Added

- **Click any map pin and see:** target name + score + UTC pass time (with relative "in 6h 20m" suffix) + predicted cloud percentage with the data source labeled (e.g., "Cloud: 18% (GFS forecast)" for future passes, "Cloud: 35% (GOES16 observed)" for imminent ones) + pass regime + obstruction class.
- **`cloudSourceLabel()`** helper translates the generator's technical source strings (`gfs-forecast`, `geo-ir-goes16`, `gibs`, `meteosat-ir108`, `himawari-nict`, `combined-no-coverage`) into operator-facing labels.

### Implementation

- `frontend/src/map.ts` — new exported `buildTargetPopupContent()` + `cloudSourceLabel()` + `TargetPopupProps` interface. Old inline click handler replaced with a 2-line call to the helper.
- `refreshTargetsSource()` now carries `closest_approach`, `cloud_fraction`, `cloud_source`, `pass_regime`, `obstruction_class`, `sample_time` through to each feature's GeoJSON properties so the click handler can read them without re-fetching `passes.json`.
- 20 new tests in `frontend/test/map-popup.test.ts` covering each source label translation, relative-time formatting, XSS defense (target names with HTML-meta characters render as literal text via `textContent`), and graceful handling of missing optional fields.
- Full suite: 404 frontend tests passing.

### Why this and not the full forecast-tile overlay?

The full Worker-rendered GFS forecast tile overlay (cloud raster that shifts when you scrub forward) is queued as V4-P2 in `TODOS.md` — ~2-3 days CC of new infrastructure. This release ships the lower-effort half: surface the forecast number that ALREADY exists in `passes.json` so the operator can validate any specific pin in one click. The full raster overlay can come as a dedicated `/plan-eng-review` cycle later.

## [1.4.0.0] - 2026-05-20

### Orbit time-scrub on the Map view (Pettit Tier B).

Pettit asked 2026-05-19: *"Being able to jump ahead or behind in time/date is really handy."* The old `[Now] [+90 min]` two-button toggle covered "what about the next orbit" but nothing past that. This release replaces it with a 5-button orbit scrubber:

```
[← T-90 08:30Z]  [← T-45 09:15Z]  [Now 10:00Z]  [T+45 → 10:45Z]  [T+90 → 11:30Z]
```

Each button shows the UTC time you would land at if you clicked. Hit `T+90 →` three times and the chip on the next-up `T+90 →` button shows three orbits ahead. The chips refresh every 30s so the time stays accurate as the wall clock advances.

### Added

- **45- and 90-minute step sizes**: half-orbit (`T-45` / `T+45`) and full-orbit (`T-90` / `T+90`).
- **Forward bound**: 36 hours = the upcoming-passes horizon set in v1.2.8.0. Past that we'd be scrubbing into orbits with no target data, so the buttons disable themselves with a dimmed `time-step-noop` style.
- **Back floor at Now**: clicking back from the current orbit stays at Now (per the 2026-05-20 spec decision). The buttons render dimmed when they would be a no-op.
- **Future-orbit ground track**: at lookahead > 0 the map renders ONLY a ±45min track centered on the future time, SGP4-derived from the cached TLE. The current 2-orbit polynomial track only shows at Now.
- **Frozen ISS marker at the future time**: at lookahead > 0 the marker stops updating per second and parks at where ISS will be at the start of that orbit (Q2 → A).
- **Pin filter + dim**: target pins outside ±45min of the current view time dim to 25% opacity; in-window pins stay at 95%. Operator can still see "there's a great target 2 orbits later" at a glance (Q3 → C).

### Implementation

- `frontend/src/map.ts` — new `clampLookahead()`, `formatUtcHm()`, `futureOrbitGroundTrackFeatures()`, `refreshGroundTrackSource()`, `refreshTargetsSource()`, `updateTimeStepLabels()`. Old `bindTimeToggle()` rewritten to scan all `.time-step-btn` elements and apply delta clamping.
- `frontend/src/map.ts` — `markerPositionFor()` now uses `issPositionWithAltSGP4()` when lookahead > 0 (polynomial only covers ~120min; future orbits need SGP4 directly).
- `frontend/src/style.css` — `.time-step-btn` with stacked label + UTC chip, `.time-step-noop` dim state for out-of-bounds buttons.
- `frontend/index.html` — 5 button elements (one per step) with `data-step` + `data-time-utc` chips.

### Tests

- `frontend/test/time-scrub.test.ts` — 15 new tests covering clamp semantics, UTC formatting, and step-from-current logic. Full suite: 384 frontend tests passing.

### NOT in scope

- Sliding scrub (drag a slider). Stepwise buttons are honest about orbit boundaries and match operator mental model better.
- Date input (jump to "next Tuesday morning"). The 36h horizon is mostly tomorrow already; full date picker becomes interesting once v1.1 historical TLE archive lands.

## [1.3.1.0] - 2026-05-19

### Weather v1.3 framework + NHC hurricane tracker.

Dominick (NASA Crew-8) emailed 2026-05-19 asking for lightning predictions on cards. Pettit's Tier B feedback the same day added "major storms or weather events" for the iconic ISS hurricane shot (e.g., Christina Koch's Hurricane Dorian 2019, Loral O'Hara's Hurricane Lee 2023).

Architecture locked 2026-05-19 in `/plan-eng-review`. Design doc: `~/.gstack/projects/anilsamoil-orbit-photo-director/anilsamoilenko-weather-v1.3-eng-review-2026-05-19.md`. Pragmatic staged ship: v1.3.1 (this release) ships the integration framework + real NHC hurricane tracker; v1.3.2 will replace the placeholder lightning sampler with real GLM (NOAA S3) + Blitzortung (WebSocket) + GFS CAPE samplers.

### Added

- **`OPD_ENABLE_WEATHER` feature flag** in `generator/config.py`. Off by default for the 1-week Anil soak (D6 in the design doc). Same parsing as `OPD_ENABLE_ASCENT`.
- **`generator/lightning.py`** — new module with `LightningSampler` Protocol, `PlaceholderLightningSampler` (always returns 0.0 potential), `lightning_bonus()` helper for the additive +30 score bonus path, and `NHCHurricaneTracker` that fetches NHC `CurrentStorms.json` hourly + checks per-pass proximity within 1500km. NHC payload parsing handles lat/lon strings (`"26.5N"`, `"78.2W"`), Saffir-Simpson category derivation from intensity in knots, and graceful degradation when NHC API is down (uses cached storms).
- **PassEntry weather fields** (all optional — emitted only when `enable_weather=True`): `lightning_potential` (0-1), `flash_rate_per_min` (observed-only), `lightning_source` (`placeholder` | `glm` | `blitzortung` | `gfs-cape`), `lightning_bonus` (0-30 raw points), `hurricane_nearby` (`{name, classification, distance_km, nhc_id}`).
- **Score model:** `final = min(100, multiplicative_base + 30 * lightning_potential)`. Cap at 100 prevents star overflow. v1.3.1 placeholder always returns 0 so the bonus is 0 in production; the wiring exists for v1.3.2.
- **Frontend tags** in `frontend/src/card.ts`: `⚡ lightning observed` / `⚡ lightning forecast` (only when potential > 0.05; silent in v1.3.1 since placeholder always returns 0) + `🌀 Hurricane Dorian Cat 4` style tag (real-data even in v1.3.1 from NHC). Both sit between the launch-kind tag and regime/obstruction tags in the eye-scan band. Yellow for lightning, purple for hurricane.

### Implementation

- New: `generator/lightning.py` (~280 lines) + `tests/test_lightning.py` (37 tests covering placeholder, bonus, NHC parsing, tracker proximity, cache fallback, stale-cache fetch path).
- Modified: `generator/config.py` (flag), `generator/main.py` (instantiate samplers + thread into `score_pass_for_target`), `ops/com.astroanil.orbit-photo-director.plist` (WatchPaths includes lightning.py), `frontend/src/types.ts` (optional fields), `frontend/src/card.ts` (tag rendering), `frontend/src/style.css` (`.weather-lightning` + `.weather-hurricane`).
- Tests: 531 Python (+37 new) and 369 frontend pass.

### NOT in this release (deferred to v1.3.2 + V4-P3)

- Real GLM (NOAA S3 + NetCDF) lightning sampler — Slice 1 part 1
- Real Blitzortung WebSocket lightning sampler — Slice 1 part 2
- GFS CAPE forecast sampler — Slice 1 part 3 (extends existing `GFSForecastSampler`)
- MTG-LI, JTWC, classification-tiered proximity — V4-P3 in TODOS.md

The placeholder sampler in v1.3.1 means `lightning_potential` always reports 0 and the `⚡` tag never renders. The named-storm `🌀` tag is real and active from this release. Soak this week to validate the hurricane integration before v1.3.2 lights up the lightning samplers.

### Operational

- Anil enables locally via `OPD_ENABLE_WEATHER=1` in the launchd plist's `EnvironmentVariables`. Daemon picks it up via the v1.2.5.2 mtime hook or a `launchctl bootout`/`bootstrap`.
- NHC API is freely accessible (no auth). Hourly tick fetches with a 1-hour TTL cache; matches NHC's advisory cycle.

## [1.3.0.0] - 2026-05-19

### Photo-timestamp reverse lookup — Pettit's "where was I when I shot this?" feature.

Don Pettit (Expeditions 6/30/31/35/36, the most-published ISS photographer in NASA history) emailed 2026-05-19: *"Showing where station was from a photo time stamp is really handy to figure out what your photo is of (you will have a lot of these). Linking any time stamp/location to Google Earth for perhaps a better eval would be great. (I have trained Claude on my desk computer so I type in a photo time stamp and get a .kml pin straight to Google Earth)."* Pettit built a private version on his desk Claude — strongest possible validation.

Architecture locked 2026-05-19 in `/plan-eng-review`. Design doc: `~/.gstack/projects/anilsamoil-orbit-photo-director/anilsamoilenko-photo-lookup-v1-eng-review-2026-05-19.md`.

### Added

- **New "Lookup" tab** (5th tab next to Queue / Upcoming / Map / Log). Single-shot timestamp resolution.
- **Two input paths:** paste a UTC timestamp (ISO 8601 with or without Z, space-separated also works) OR drag and drop a photo with EXIF `DateTimeOriginal`. EXIF parsing via the `exifr/lite` ESM bundle (~8KB gz).
- **Three output paths:** (1) pin auto-drops on the Map tab with the operator switched there immediately; (2) "Download .kml" button generates a KML 2.2 doc with `altitudeMode=relativeToGround` for Google Earth Desktop; (3) "Open in Google Earth" link opens Google Earth Web at the same lat/lon. All three live on the result card.
- **Confidence chip** based on TLE age at lookup time: high (< 24h), medium (24-72h), low (> 72h). SGP4 accuracy degrades past ~3 days from TLE epoch; the chip surfaces the trade-off honestly.
- **`issPositionWithAltSGP4()`** sibling to existing `liveIssPositionSGP4()` in `iss-sgp4.ts` — same propagation but also returns altitude in km for the KML render.
- **`dropLookupPin()`** in `map.ts` — magenta pin distinct from the existing red-yellow-green target gradient. Auto-centers + ensures zoom ≥ 4. Popup shows timestamp + altitude.

### Implementation

- New: `frontend/src/photo-lookup.ts` (parseTimestamp, extractExifTimestamp, resolveTimestampToIssPosition, renderLookupTab) and `frontend/src/kml.ts` (buildKml, googleEarthWebUrl, kmlFilename, downloadKml). Photo-lookup module lazy-imported via `import('./photo-lookup')` so the exifr dependency only loads when the operator opens the Lookup tab.
- Stateless by design: each lookup is fresh. The downloaded `.kml` is the durable per-photo record.
- 29 new tests (`photo-lookup.test.ts` + `kml.test.ts`). Full suite: 369 frontend tests passing.

### NOT in scope (deferred to V4-P3)

- Historical TLE archive (Space-Track or CelesTrak archive for photos older than ~3-4 days from the cached TLE epoch). V4-P3 in TODOS.md.
- Batch upload (multiple photos in one drop) — single-shot per session matches Pettit's described workflow.
- Lookup history / persistence — the `.kml` file is the persistence.
- Camera-attitude solve (where was ISS *looking*) — needs orientation telemetry we don't have.

## [1.2.9.0] - 2026-05-19

### Tier A bundle from Don Pettit's feedback.

Don Pettit (Expeditions 6/30/31/35/36, the most celebrated ISS photographer in NASA history) emailed 2026-05-19 with 12 asks. This bundle ships the three lowest-friction items as quick wins; Tier B (multi-orbit display, photo-timestamp reverse lookup, multi-satellite) goes through `/plan-eng-review` next.

### Added

- **Sun + sunspots topbar widget.** Small circular thumbnail of the latest NASA SDO HMI continuum image (visible-light sun disk; sunspots clearly visible). Click opens NOAA SWPC's solar dashboard. Mirrors the v1.2.3.0 Kp widget pattern: graceful hide on fetch error, no banner spam. 7 new tests. Direct image embed in v1 (no Worker proxy); add Worker caching if the operator needs offline access. Hidden below 430px viewport (same threshold as the brand-name hide rule).
- **Cloud overlay toggle button on the map.** Third control row below the bearing toggle. Click to hide/show the GIBS cloud raster layer. Persisted to `localStorage` so the preference is sticky across reloads. Default = visible (matches v1.0+ behavior). Pettit asked specifically for this.

### Fixed

- **Ground track now renders continuously across world copies.** Pettit reported the orbit clips at the antimeridian: *"if near right hand side map not to have orbit clipped where you have to piece together with the left hand side."* MapLibre's `renderWorldCopies: true` (now made explicit) only repeats tile layers, not GeoJSON line features. Fix: `groundTrackFeatures()` now duplicates each polyline segment at lon ±360 offsets so the line spans all visible world copies when the user pans east/west past the antimeridian.

### Changed

- **"Next 24 hours" → "Next 36 hours" copy** on the Upcoming pane header. The v1.2.8.0 bump extended the actual horizon; this catches the copy up to match the reality the operator sees.

### Cross-astronaut tension noted

Pettit explicitly refutes Dominick's OPTIMIS-timeline overlay (the V4-P3 stretch goal). `TODOS.md` now flags the 1-1 split — defer the eng-review until a third operator votes either way. If built, must be opt-in.

## [1.2.8.0] - 2026-05-19

### Upcoming horizon bumped 24 → 36 hours (operator feedback from astronaut).

Matthew Dominick (NASA Crew-8) emailed 2026-05-19 asking for *"lookahead for the entire next OPTIMIS window — more than 90 minute orbit lookahead"* so the operator can plan their next day before bed. Loral O'Hara CC'd as *"an earth obs photo machine."*

Old behavior: `OPD_PASS_WINDOW_HOURS=24` meant the upcoming-passes window could fall short of "all of tomorrow" depending on when the operator checked. Checking at 11pm Pacific (06:00 UTC) showed tomorrow's passes 1-25h out — fine — but checking at 8am Pacific (15:00 UTC) only covered through ~07:00 UTC tomorrow, missing tomorrow night.

### Changed

- `generator/config.py:DEFAULT_PASS_WINDOW_HOURS` bumped from 24 to 36. Guarantees the full next OPTIMIS shift is always in the Upcoming queue regardless of check time.
- The `top_24h.json` artifact filename is kept as a stable identifier — its horizon is now wider than its label. Renaming is deferred (would break stored snapshots + existing clients).

### Tests

- New `test_default_pass_window_hours_is_36` in `tests/test_config.py`.

## [1.2.7.0] - 2026-05-17

### V3-P2 ASCENT geometry — integration slice (gated by feature flag).

Completes the V3-P2 ASCENT work after slices 1 (#22, profile data) and 2 (#24, geometry math). Wires the ASCENT pipeline into `run_tick` behind a feature flag, adds the operator-visible `🚀 ASCENT plume` tag, and includes new files in the daemon's WatchPaths so on-disk code changes auto-restart the daemon.

### Added

- **`OPD_ENABLE_ASCENT` flag in `generator/config.py`.** Off by default for the 1-week Anil self-test soak (D6 in the design doc). Accepts `1`/`true`/`yes`/`on`.
- **ASCENT loop in `generator/main.py:run_tick`.** When `settings.enable_ascent` is True, calls `predict_ascent_pass()` for every actionable launch with a matched rocket profile and appends the best-instant prediction as a separate `PassEntry` with `launch.kind="ascent"`. Reuses the existing reserved-slot guarantee (ARCH-4) so ASCENT entries can also be slotted into the upcoming/queue if score loses to ground passes.
- **`_build_ascent_pass_entry()` helper.** Shapes an `AscentPrediction` into a `PassEntry` dict the existing sort/render pipeline consumes. Score = `100 × ascent_score_multiplier(prediction)` so it integrates cleanly with the existing 0-100 scale. The "target" coordinates are the rocket's projected position at the best instant, not the launch pad.
- **`launch.kind` field on PassEntry.** New discriminator (`"overhead"` | `"ascent"`); the existing `geometry` field is kept for backward-compat with v1.2.6.x readers and also receives the same value.
- **Frontend `🚀 OVERHEAD pass` / `🚀 ASCENT plume` tag.** `card.ts` reads `launch.kind` (falls back to `geometry` for older manifests). ASCENT tag gets its own warm-yellow color (`launch-ascent` CSS class) so the operator can visually distinguish the two photo opportunities for the same launch (per D7: show both as separate cards).
- **`ops/com.astroanil.orbit-photo-director.plist`: `ascent.py` + `ascent_profiles.py`** added to the WatchPaths array. New generator files now trigger the same daemon-restart flow when modified.

### Operational notes

- ASCENT is dead-code in production until `OPD_ENABLE_ASCENT=1` is set in the launchd plist environment. Set it locally for the 1-week Anil self-test, then promote default-on by changing `enable_ascent: bool = False` → `True` in `generator/config.py` once geometry sanity is confirmed.
- One known approximation in the integration: the ASCENT mission inclination is currently hardcoded to 51.6° (ISS rendezvous default) because `Launch` doesn't yet surface LL2's `mission.orbit.inclination`. Polar/SSO launches will compute a slightly off launch azimuth → slightly off rocket lat/lon projection. Surfacing inclination from LL2 is deferred to V3-P3 or beyond; the 1-week soak data will tell us if it matters in practice.

### Tests

- 9 new `tests/test_config.py` tests covering the flag's truthy/falsy parsing.
- 3 new `tests/test_main.py` tests covering `_build_ascent_pass_entry` shape + the disabled-by-default path through `run_tick`.
- 3 new `frontend/test/card.test.ts` tests covering the kind-aware tag (ascent class, overhead label, fallback to geometry on older manifests).
- 2 existing `launch-card.test.ts` tests updated to the new `🚀 OVERHEAD pass` literal.

## [1.2.6.0] - 2026-05-17

### Operator-feedback batch from iPhone in-flight testing.

Three pieces of feedback from Anil's in-flight testing today, bundled.

### Fixed

- **Map pan/zoom no longer feels locked.** Operator reported the map was hard to pan/zoom in north-up mode but worked in ISS-up. Pragmatic defensive fixes: `touch-action: none` on `.map` so iOS Safari stops stealing two-finger gestures; explicit `dragPan/dragRotate/scrollZoom/touchZoomRotate/touchPitch: true` in the MapLibre constructor (defense against silent default changes); `applyBearing()` is now idempotent (skips the 600ms `easeTo` animation when bearing already matches target, which had been eating in-flight pan/zoom gestures); initial zoom bumped from 1.5 to 2 so panning has visible effect; bearing only re-animated on first map creation, not on every Map-tab click.

### Added

- **Direction-of-look on the angle/window tag.** Operator asked: "when it says 35° I need to know if that's forward, starboard, port, or aft." Card meta now renders `35° · Cupola · 90° starboard` (or `fore` / `aft` / `port` / `starboard` for cardinal directions within ±15°). Backed by a new `iss_relative_bearing_deg` field on PassEntry — generator samples ISS heading at closest_approach from the existing pass-detection loop (one extra great-circle bearing call per pass, no new propagations) and computes the target's bearing relative to direction-of-travel. `find_passes` now attaches the field automatically; old manifests gracefully omit the tag.
- **Coastline outlines on the map** so continents stay visible under thick cloud cover. Natural Earth 110m coastlines shipped as a static asset (~94KB raw / ~31KB gzipped), drawn as a thin warm-toned line layer above the 55%-opacity GIBS cloud overlay. The existing Carto basemap's coastlines were getting washed out by the cloud overlay; the new dedicated layer survives.

### Tests

- 11 new generator tests covering `great_circle_bearing_deg` (cardinal directions, antimeridian crossing), `relative_bearing_deg` (all four quadrants + wrap), and `find_passes` attaching the new field on real ISS TLE data.
- 13 new frontend tests covering `formatRelativeBearing` (cardinal collapsing, off-cardinal degree formatting, quadrant naming, input normalization) and `renderCard` direction-tag rendering.

## [1.2.5.2] - 2026-05-17

### Generator daemon now auto-restarts when code on disk changes.

Validation 2026-05-17 caught a silent 13-day operational gap: the launchd daemon was a long-lived Python process that imported generator.* modules ONCE on startup, then looped forever. V3.0 launches integration (PR #5, 2026-05-10) and the v1.2.5.1 scoring fixes (PR #20, 2026-05-17) had been sitting on disk doing nothing. Frontend redeployed constantly via R2 upload; generator never restarted.

### Fixed

- `generator/daemon.py`: `supervisor_loop` now polls `generator/*.py` mtimes after each tick. If any file is newer than the process's start-time snapshot, exits non-zero so launchd's `KeepAlive.SuccessfulExit=false` triggers a respawn. New code gets loaded automatically on the next launchd-managed start.
- `ops/com.astroanil.orbit-photo-director.plist`: added `WatchPaths` array listing all generator/*.py files (belt-and-suspenders for crash/manual-kill scenarios; the in-process mtime check is the primary mechanism since launchd's WatchPaths only **starts** on-demand jobs, doesn't **restart** running ones).
- 2 new daemon tests covering the exit-on-change and no-exit-on-stable paths.

### Operational notes

- Adding new `generator/*.py` files requires updating the WatchPaths array in the plist (launchd doesn't watch recursively or auto-discover). The in-process mtime check picks up new files automatically because it globs `*.py` at runtime.
- ThrottleInterval=30s in the plist prevents thrashing if many files change in quick succession (e.g., a `git pull` touching 10 files restarts the daemon at most once per 30 s).
- Verified live: edited `generator/config.py`, daemon completed its current tick, logged "generator code changed on disk … exiting non-zero so launchd restarts with fresh modules", launchd respawned. Total time from edit to new process: ~52 s.

## [1.2.5.1] - 2026-05-17

### Cheap-wins batch 2: scoring correctness fixes + frontend perf.

Four P3 items from TODOS.md bundled. None changes user-facing UI; all improve the data flowing INTO the UI or the wattage burned rendering it.

### Fixed

- **Hawaii no longer flagged as sun-glint risk.** `cloud.py:is_water` Pacific band (lat -70 to 70, lon 140-180 or -180 to -110) was catching the Hawaiian Islands and triggering `sun_glint_risk` evaluation on land. Added explicit Hawaii exception (lat 18-23, lon -161 to -154). 4 new tests.
- **Vandenberg launch site no longer flagged as sun-glint risk.** Same Pacific band caught Vandenberg SLC-4E (lat 34.6, lon -120.6), causing asymmetric scoring vs Kennedy LC-39A (sits outside band). Pacific east boundary shrunk from -110 to -125 — excludes CA coast + Baja, keeps deep Pacific coverage. ARCH-4's reserved-slot logic was masking the symptom; this removes the underlying asymmetry.
- **`sun_subpoint` now applies Equation of Time.** Previous formula used mean solar time and had up to ±4° error in sub_lon, enough to flip the ±5° sun-glint proximity check across its boundary near the threshold. Added Spencer's approximation (~30 sec accuracy across the year). 2 new tests covering Feb (EoT negative) and Nov (EoT positive).
- **TLE cache corruption now logs a warning.** `fetch_tle` was silently swallowing `ValueError`/`OSError` when parsing the prior cache; if a real reboost coincided with a partial-write corruption, the reboost would go undetected with no operator signal. Now logs "TLE cache parse failed … reboost detection skipped for this tick" so ground support sees the signal.

### Performance

- **Card re-render fast path on the 1Hz countdown tick.** `rerenderCountdowns` used to call `renderQueue()` every second, rebuilding every Queue + Upcoming card DOM (`replaceChildren` + full rebuild). On Chris's 8-month unattended mission that's ~21M wasted DOM rebuilds. Now updates the countdown text node in place; only falls back to full rebuild when a card crosses the past-boundary (every ~15-30 min) or unexpected DOM state appears. Score-breakdown panel state (OPEN_BREAKDOWNS) is preserved naturally since cards aren't replaced.

## [1.2.5.0] - 2026-05-17

### Card scores show as 5★ instead of 0-100 — aligns with the calibration rating scale.

Operator feedback (anilsamoilenko, in-flight 2026-05-16): "the score 26 on Blue Origin … is low better? It might be better to convert the score to a five-star rating so it corresponds to the set token rating we give it, then if it learns from that the final ratings are comparable and five-star is easier to understand."

Three problems the 0-100 score had: direction ambiguous (is high or low better?), mismatched with the 1-5 calibration rating scale the operator uses after shooting, and no intuitive anchor ("is 26 good?"). This release converts the card headline to 5★ display. The raw 0-100 score stays in the artifact and the calibration log; only the display layer changes.

### Added

- New `src/score-stars.ts` module: `scoreToStars()`, `renderStarBlock()`, `starsToLabel()`, threshold constants. Pure functions, defensive on invalid input (NaN, null, negative, >100 all collapse safely).
- 17 new unit tests in `test/score-stars.test.ts` covering threshold boundaries, defensive guards, glyph composition, aria-label, role=img, custom maxStars.
- Breakdown panel header (visible on expand) now shows `★★★★☆ solid · score 65` so the operator gets the verbal anchor + raw score for diagnostic use. Component percentages stay in the table below.

### Changed

- Card headline: numeric `Score 26` → `★★☆☆☆` block. Tap still expands the breakdown panel.
- The `· P(unobstructed) 50` suffix stays in the headline for an at-a-glance read on the dominant component.

### How it's wired

- **Thresholds** (locked via /plan-eng-review 2026-05-17): score ≥ 75 → 5★, [50, 75) → 4★, [30, 50) → 3★, [15, 30) → 2★, < 15 → 1★. Named constants in `score-stars.ts`, tunable as calibration data accumulates.
- **Render-time conversion**: generator continues to emit `.score` (0-100) and `.score_components` unchanged. Frontend calls `scoreToStars(p.score)` at render. Re-tuning thresholds requires no artifact regeneration. Calibration log keeps `score_at_time` in 0-100 for full historical resolution.
- **Accessibility**: every star block has `aria-label="N of 5 stars"` and `role="img"` so screen readers don't read the unicode glyphs literally.
- **Sort behavior unchanged**: v1.2.4.0's Score sort continues to use raw 0-100 under the hood. Tiers are monotonic buckets of raw score, so sort-by-tier with raw tiebreaker = sort-by-raw (visual grouping comes for free since the headline shows stars).

### Phased rollout (per design doc)

- **v1.2.5.0** (this release): 5★ alignment + collect aligned data. Predicted and rated are now both 1-5★.
- **v1.2.5.1** (after ≥10 rated entries): comparison banner in Log tab — "you rate X higher than predicted at terminator passes."
- **v1.3.0.0** (after ≥50 rated entries): server-side weight adjustment with minimum-N gate, bounded adjustment, reset-to-defaults, diagnostic surface.

## [1.2.4.2] - 2026-05-17

### Aurora Kp badge: render on every page load, not only on manifest version change.

Reported by anilsamoilenko on iPhone 2026-05-17: the Kp badge wasn't visible despite `/api/kp` returning valid data. Root cause from v1.2.3.0: I gated `fetchKpData()` inside the `if (isNewer)` block in `refresh()` along with the tile precache. That meant Kp only fetched when the manifest version changed (~hourly). On any return visit within the same manifest hour, the widget stayed hidden in its HTML-default state until the next generator tick — sometimes up to an hour away.

Wrong call originally. Precache makes sense gated (same tiles for same manifest version, no need to re-fetch). The Kp badge is different — it's a live indicator the operator expects to see on every page load.

### Fixed

- Moved `fetchKpData()` out of the `if (isNewer)` block in `main.ts:refresh()`. Now fires on every refresh tick (~60s), regardless of manifest version. The worker's edge cache (5-min TTL) bounds upstream SWPC load to ~12 fetches/hour. Cost: ~80 bytes per refresh on the operator's link.
- Precache stays gated on `isNewer` (correct behavior; same top-3 tiles for same manifest version).

## [1.2.4.1] - 2026-05-17

### iPhone topbar overlap fix.

Reported by anilsamoilenko while testing in-flight 2026-05-17: the Queue/Upcoming/Map/Log tab nav bar overlaid text content on iPhone Safari and Chrome. Root cause: 4 inflexible flex children (brand, iss-now coordinates, Kp badge added in v1.2.3.0, tabs row) couldn't fit in 375–430px iPhone viewports because `.topbar` was `flex-wrap: nowrap`. The Kp badge from v1.2.3.0 made the squeeze worse — there was no headroom left.

### Fixed

- `.topbar` now allows `flex-wrap: wrap` with a gap, so the tabs row drops to a second line gracefully on any narrow viewport rather than overlapping siblings.
- New media query at `max-width: 500px`: hides the verbose ISS region suffix ("over Pacific Ocean"); keeps the coordinates. Tightens padding.
- New media query at `max-width: 430px`: hides the brand text ("Orbit Photo Director"); keeps the 🛰️ emoji as a visual anchor. Tightens tab padding so all four tabs stay on one row.

Verified across iPhone SE (375px), iPhone 14 (390px), iPhone Pro Max (430px), and desktop (1280px regression check). No JS changes; no test regressions.

## [1.2.4.0] - 2026-05-16

### Queue + Upcoming sort toggle: chronological by default, score as opt-in.

Operator feedback while testing on an iPhone in-flight (2026-05-16): "the order to shoot it is interesting, the Blue Origin was first up in queue but next was something 14 minutes away. It wasn't chronological. It seems like chronological in queue would be better." First-time operator intuition for a list of upcoming passes is timeline order, not score-descending. Generator-side selection still picks best-by-score within the 90-min window; only the display order changes.

Both Queue and Upcoming panes now show a **Time / Score** pill toggle in their headers. Default is Time. Preference persists across reloads in `localStorage`. When scoring is well-tuned and the operator wants "best opportunities first" behavior, one tap switches to Score and stays there.

### Added

- New `src/sort-pref.ts` module with `getSortOrder() / setSortOrder() / sortPassesByOrder()`. Pure functions, fully testable, defensive on `localStorage` failure modes (private-mode Safari, quota exceeded) and malformed input.
- 15 new unit tests covering: default, round-trip, malformed values, storage exceptions, immutability, time-asc / score-desc orderings, NaN-timestamp sinking, missing-score = 0 fallback, empty/single-element edge cases.

### How it's wired

- Generator continues to emit `top5.json` (next 90 min) and `top_24h.json` score-descending — selection logic unchanged.
- Frontend re-sorts the already-filtered pool at render time based on `getSortOrder()`. The SELECTION (which passes appear in Queue at all) is preserved; only the DISPLAY ORDER changes.
- Single preference applies to both panes since they share the same scoring model and operator mental model. Toggling on one pane updates the other.
- Toggle pill mirrors the visual treatment of the existing Now / +90min map control for consistency.

## [1.2.3.3] - 2026-05-13

### Cheap-wins batch: forecast-horizon tag + pulse-animation pause + TODOS hygiene.

Three small operator-facing polish items bundled into one release.

### Added

- **Forecast horizon tag.** Upcoming cards used to show a generic `forecast` tag for GFS-sourced cloud predictions, dropping the "obs Nh ago" tag because the sample time was future-dated. Operator couldn't tell a 1h-ahead forecast from a 23h-ahead one. New `formatForecastHorizon()` helper in `card.ts` renders the lookahead as `+Nm` / `+Nh` / `+Nd`, so the card shows e.g. `forecast +6h` or `forecast +18h`. 7 unit tests covering boundaries (sub-hour, 10h-decimal switch, multi-day) + clock-skew defenses.

### Changed

- **Pulse animation pauses when Map pane is hidden.** The ISS marker's `.iss-pulse` halo animation infinite-looped while the marker DOM was alive, including when the user was on Queue/Upcoming/Log tabs. MapLibre keeps the marker DOM in memory even with `#map-pane` `display: none`, so the browser's "display-none pauses animations" optimization didn't kick in. CSS rule now explicitly forces `animation: none` on `.iss-pulse` when `#view` is not `.view-map`. Belt-and-suspenders; tiny CPU/battery win on Chris's ISS laptop.

### Internal

- TODOS.md hygiene: annotated 3 previously-shipped items (V4-P2 map zoom v1.2.1.1, ISS-up toggle v1.2.1.0, scoring explainer v1.2.0.1) that had been completed but not marked.

## [1.2.3.2] - 2026-05-13

### Map tiles broken: SW cache filter rejected MapLibre's opaque responses.

User testing exposed a regression from v1.2.2.0's hardening: with `cacheableResponse.statuses: [200]` only, MapLibre's natural `<img>`-based tile fetches (which are no-cors → opaque status 0) were being rejected by the service worker route. Result: `opd-tiles-carto` and `opd-tiles-gibs` caches never populated, and on second-load with the SW controlling the page, the map rendered blank.

The original v1.2.2.0 narrowing was guarding against a theoretical cached-429 scenario flagged by /review's Codex pass. In production at our request volume, that risk is negligible; the operational failure (no map tiles at all) is total. Reverting the filter is the right tradeoff.

### Fixed

- `frontend/vite.config.ts`: SW route `cacheableResponse.statuses` reverted from `[200]` to `[0, 200]` for both `opd-tiles-carto` and `opd-tiles-gibs`. MapLibre's opaque tile responses now cache correctly. The V4-P2 precache (which uses `fetch()` with default CORS) still produces real status-200 responses; both paths populate the same caches.

### Diagnostic notes (for v1.1 OVATION work or future SW changes)

- MapLibre `RasterTileSource` doesn't support `crossOrigin` directly in the style spec.
- Setting CORS on tile fetches requires either a `transformRequest` callback (which lacks `mode` in `RequestParameters`) or custom source loading.
- For now, the SW route accepts both opaque and CORS responses; a future hardening could use Workbox's `cacheKeyWillBeUsed` plugin to dedup or `cacheWillUpdate` to filter cached-error 429s explicitly.

## [1.2.3.1] - 2026-05-13

### Aurora Kp: normalize Z-less SWPC timestamps to UTC (latent age_min bug fix).

SWPC's `planetary_k_index_1m.json` returns timestamps without a `Z` suffix (`2026-05-13T15:51:00`). ECMAScript's behavior for parsing date-time strings without a timezone offset is engine-defined: V8 (Cloudflare's runtime) happens to treat it as UTC, but Safari and older engines treat it as local time, which would shift `age_min` by the runtime's UTC offset.

Today on Cloudflare this is fine; the bug surfaces if Cloudflare ever migrates the worker to a non-UTC runtime, or if a future caller re-parses the returned timestamp on a different engine.

### Fixed

- `worker/src/aurora.ts`: new `normalizeSwpcTimestamp()` helper appends `Z` when no offset is present. Z-suffixed and `+HH:MM` / `-HHMM` offsets pass through unchanged.
- Returned `KpResponse.timestamp` is now always UTC-explicit, so frontend tooltip text (and any future caller) can re-parse safely.
- 4 new unit tests covering pass-through, Z-append, and offset preservation.

## [1.2.3.0] - 2026-05-13

### V4-P2 aurora indicator: Kp index in the topbar with click-through to SWPC.

Chris visits NOAA SWPC's experimental aurora dashboard daily to check the Kp index (geomagnetic activity, 0-9 quasi-log scale; Kp 5+ = storm worth knowing about). This release surfaces Kp on map.astroanil.dev so he doesn't have to open a tab. Topbar widget shows "Kp 4.2" color-coded by storm level — green/yellow/orange/red — and clicks through to SWPC for the full oval map when the number is interesting.

### Architecture (locked down via /plan-eng-review + Codex outside voice)

The original plan included consuming the full OVATION oval (899KB) + computing "is aurora visible from ISS right now?" via look-angle geometry to 150km altitude. Codex's review flagged the visibility math as wrong — naive ISS-subpoint lookup ignores limb visibility (ISS sees auroras hundreds of km off-nadir) and daylight/twilight. Honest visibility math is a 6h project with a real test burden; the headline Kp number alone solves 80% of Chris's "save me a tab" need. v1 ships Kp-only. The oval + visibility prediction is deferred to v1.1 with Codex's findings baked in as known requirements (see TODOS.md V4-P2 entry).

### Added

- New `worker/src/aurora.ts` — `/api/kp` route handler. Proxies SWPC's `planetary_k_index_1m.json`, parses the latest valid row, edge-caches the response 5 minutes. ~80-byte JSON body (`{kp, timestamp, age_min}`).
- New `frontend/src/aurora.ts` — `fetchKpData()` + `kpToColorClass()` + `renderKpWidget()` + `initKpWidget()`. Pure module, fully unit-testable.
- New `worker/test/aurora.test.ts` (13 tests): parseKp schema-drift tolerance, edge-cache hit/miss, SWPC outage/parse/empty-array failure modes.
- New `frontend/test/aurora.test.ts` (21 tests): fetch failure modes, all 4 color-class boundaries, render null-state, tooltip age formatting (minute / hour-minute), click + keyboard activation, a11y attributes.

### How it's wired

- Worker route `/api/kp` registers next to the existing `/api/log` + `/api/health` handlers. CORS open (`access-control-allow-origin: *`) since Kp is public data.
- Edge cache TTL 300s for `200-299`; `400-599` capped at 60s so SWPC blips don't lock the edge for 5 minutes.
- Frontend fetches `/api/kp` from inside `refresh()`'s `if (isNewer)` block — same gate as tile-precache. Kp is a 3-hour smoothed value so hourly cadence is well over-spec on freshness. Worker's edge cache is the real freshness budget.
- Widget hides itself when `/api/kp` returns null (network error, SWPC outage past TTL, malformed JSON, parse failure). It's optional UI — never load-bearing, never throws a banner.
- Click and keyboard (Enter / Space) open `https://www.swpc.noaa.gov/communities/aurora-dashboard-experimental` in a new tab. `role="button"` + `tabindex="0"` for screen readers.
- Color thresholds match NOAA G-scale: 0-3 quiet (green), 3-5 active (yellow), 5-7 storm (orange), 7+ severe (red).

### Architectural decisions (recorded in design doc)

- **Data fetch path:** Cloudflare Worker proxy (not generator hourly cron, not frontend-direct). Decouples aurora's natural cadence from the existing hourly manifest tick.
- **Response shape:** Server-computed summary only (~80 bytes/refresh) — not the 10KB compact grid or 899KB raw OVATION. v1.1 will need the grid for live LOS-tolerant visibility lookups; v1 doesn't.
- **Failure mode:** Hide widget. Static SWPC link in HTML is the fallback. No banner, no toast.
- **ISS link budget:** ~80 bytes per hourly refresh ≈ 2KB/day. Negligible on Chris's Ku-band uplink.

## [1.2.2.1] - 2026-05-13

### Empty-Queue disambiguator: "why empty?" hint when the manifest is stale.

An empty Queue can mean two very different things to the operator: there genuinely are no qualifying passes in the next 90 minutes (orbital geometry), OR the manifest is so stale that every pick it once contained has aged past the Queue's 90-min window (generator lag). Before this release both showed the same "No passes in the next 90 minutes." copy, leaving Chris guessing whether to wait or check if the page is broken.

Now, when the manifest is 90+ minutes old AND the Queue is empty, the empty-state copy switches to: "Manifest is 1h 42m stale — generator has been slow. Next update due in 18m." Age + next-tick projection both surface, so the operator knows exactly what's happening and when to retry.

### Added

- New `src/empty-hint.ts` module with pure `emptyQueueHint(manifest, nowMs)` function. Returns the hint string when staleness is the unambiguous cause, else null.
- 8 unit tests covering threshold edges, hour-boundary formatting (`2h` not `2h 0m`), multi-hour ages, NaN-tolerance on `generated_at`, and clock-skew (future-dated manifest) cases.

### How it's wired

- 90-min threshold is intentionally higher than the existing `isStaleManifest` banner (60 min). The banner says "data may be slightly stale"; this hint says "Queue emptiness is BECAUSE of staleness, not geometry." Picks have a max 90-min Queue lifetime, so 90+ min old manifests have by definition outlived every pick they could serve.
- Next-tick projection assumes hourly generator cadence (`GENERATOR_TICK_INTERVAL_MIN = 60`). Computes `60 - (ageMin % 60)` so the figure is meaningful even at 2h+ ages — wraps to the next expected boundary instead of going negative.
- `renderQueue()` sets `empty.textContent` on every render, so the message updates live as the manifest ages or refreshes.

## [1.2.2.0] - 2026-05-13

### Tile pre-cache: the map works during LOS over Queue targets.

Chris (operator, 2026-05-05) reported the dropout: "the map doesn't work when you are LOS but you still get the upcoming targets." Loss-of-signal blacks out networking on the ISS side for stretches between passes, and the existing service-worker tile cache only held tiles the operator had already panned to. So a fresh target the operator hadn't looked at yet = blank map exactly when it matters.

This release pre-caches basemap and cloud tiles for the top-3 Queue targets at z6/z8/z10 (continent → region → metro) on every manifest version change. Eighteen tiles per refresh, fire-and-forget. When the operator next opens Map during LOS over one of those targets, the wider-context tiles are already in the service-worker cache.

### Added

- New `src/tile-precache.ts` module owning the precache logic + the GIBS/yesterday URL helpers (moved out of `map.ts` so `main.ts` doesn't drag the MapLibre vendor chunk into the main bundle).
- 23 unit tests covering slippy-map projection, top-N capping, GIBS zoom clamp, subdomain match, NaN guards, offline-skip, and in-flight dedup.

### How it's wired

- Pre-cache fires inside `refresh()`'s `if (isNewer)` branch — same gate that protects `saveSnapshot`. Manifests republish hourly, but the poll runs every 60s, so without the gate the precache would fire 60× more than budgeted. Now it fires once per version change, ~hourly.
- Carto subdomain matches MapLibre's deterministic `(x+y) % 4` pick. The service-worker Cache API keys by full URL including hostname, so a tile pre-cached as `a.basemaps...` would be a miss when MapLibre rotates to `b/c/d`. Now they agree, ~100% hit rate instead of ~25%.
- CORS mode (not `no-cors`) so the service worker sees real HTTP status codes. With opaque responses, status is always 0 — a 429 rate-limit from carto would have been cached as a "valid" tile for 7 days, blanking the map. The Lane F service-worker route's `cacheableResponse.statuses` is also tightened to `[200]` only.
- In-flight Set dedupes concurrent refresh ticks (visibility-resume can stack with the poll interval). Response bodies are explicitly cancelled to release ~450 KB of buffer per refresh instead of waiting on GC.
- `Number.isFinite` guard on lat/lon skips targets with bad coords. Tests in `main-integration.test.ts` mock the precache module so they don't fire real cross-origin fetches during CI.

The behavior change is invisible to the operator until they hit LOS over an imminent target — then the map renders instead of staying black. The risk surfaces caught by the multi-specialist /review (subdomain mismatch, 60× polling, opaque-cache failures) would all have defeated the feature within day one of deployment.

## [1.2.1.1] - 2026-05-11

### Map zoom-in for terrain detail (no more blank tiles past z20).

Chris (operator, 2026-05-05) asked: "can you allow it to zoom in a bit more for detail (and maybe even orient the map relative to ISS track)? The use case is to help you zero in on the target — I will sometimes have Google Maps up when I'm in WORF to try to pick out mountains or features that can lead me to my desired shot."

Root cause: the carto basemap source had no explicit `maxzoom`. MapLibre defaults to fetching tiles at every zoom up to the map's max (22). Carto's `dark_all` retina raster only serves up to z20; above that the requests 404 and MapLibre rendered blank squares. From the operator's POV: try to zoom in past a certain point, the map goes black.

### Fixed

- `carto-dark` source: `maxzoom: 20`. MapLibre now overzooms the z20 tile beyond that (slightly pixelated, but always shows terrain rather than blanks). Operator can zoom freely without hitting black tiles.
- `gibs-clouds` source: `maxzoom: 9`. GIBS true-color VIIRS at GoogleMapsCompatible_Level9 caps at z9. Same overzoom logic — cloud overlay stays visible (pixelated) above z9 instead of going blank.

Two-line config change. Pairs with v1.2.1.0's ISS-up toggle as the V4-P2 map polish round informed by Chris's WhatsApp feedback.

## [1.2.1.0] - 2026-05-11

### ISS-up toggle on the map: rotate so direction-of-travel points up.

Chris (operator, 2026-05-05) described his mental model in WORF as "I'm looking down, this is what's coming next." North-up is the geographic convention but it's the wrong frame for an operator scanning for a target as the ISS approaches it. This release adds a toggle next to the existing Now / +90 min controls.

Tap **ISS↑** and the map rotates so the ISS's current direction-of-travel is at the top of the screen. The bearing updates every second so the rotation stays accurate as ISS arcs around the planet (heading drifts ~1°/min). Tap **N↑** to return to the standard north-up view.

The preference persists to localStorage, so once Chris flips it on it stays on across reloads. Default is N↑ — operators new to the page see the conventional view first.

### How it's wired

- `greatCircleBearingDeg(lat1, lon1, lat2, lon2)` — standard spherical formula. Sample the polynomial fit at `now` and `now + 30s`, compute the great-circle bearing between the two positions. ISS travels great circles, so the right formula avoids antimeridian + polar weirdness that flat-Earth `atan2(Δlat, Δlon)` would introduce.
- The 1Hz live-marker tick now also calls `applyBearing(false)` when ISS-up is on. No animation on the per-tick update — the per-second rotation is sub-degree and would jitter visibly.
- User-initiated toggle uses `map.easeTo({ bearing })` for a smooth 600ms rotation so the operator sees it as intentional, not a glitch.

### Verified

- 7 new tests on `greatCircleBearingDeg`: cardinal directions, range invariants (0..360, finite), antimeridian + near-pole, realistic ISS-pair sample.
- 227/227 frontend tests pass.

### Added

- `ISS↑` / `N↑` toggle in the map controls (top-right, below the existing time toggle).
- `greatCircleBearingDeg` exported helper in `map.ts`.
- `BEARING_PREF_KEY` localStorage entry to persist operator preference.

### Changed

- The map's 1Hz live tick now calls `applyBearing` when ISS-up is on so the rotation tracks the live ISS heading.

## [1.2.0.2] - 2026-05-11

### Score breakdown panel now stays open across the 1Hz tick.

Caught immediately after v1.2.0.1 went live: tapping the score breakdown opened the panel for ~1 second, then the next `rerenderCountdowns` tick rebuilt all the cards from scratch and silently closed it. The user would have seen the breakdown flash open and disappear — a worse UX than not having the feature at all.

### Fixed

- `card.ts` now tracks open-breakdown state in a module-level `OPEN_BREAKDOWNS` Set keyed by `(target_id, closest_approach)`. Each card render (including the 1Hz tick) checks the Set and re-applies the open state. Toggle handler updates the Set on click.
- 3 new tests cover the persistence behavior: open survives re-render, close removes the persistent state, open state is per-card (different target_ids keep their own panel state).

220/220 tests pass. Same root cause as TODOS:111 ("Per-second full re-render of all cards") but solved locally for this feature without rewriting the render loop.

## [1.2.0.1] - 2026-05-11

### Queue and Upcoming now explain themselves; tap any score for the breakdown.

Chris (operator, 2026-05-10): "I think I don't fully understand the queue vs upcoming and the scoring, but it generally makes sense!" This release answers both questions inline so he doesn't have to remember.

Each tab now has a header explaining what it shows and how scoring works:
- **Queue** — "Next 90 min — what to shoot now. Cloud: observed (MODIS / GOES-IR / Meteosat / Himawari)."
- **Upcoming** — "Next 24 hours — what to plan for. Cloud: forecast (GFS, hourly). Less certain by design."

Each card's score line is now a button. Tap it and a breakdown panel expands underneath with all 5 components: p(unobstructed), regime fit, nadir proximity, priority weight, TLE freshness. Each component shows the value (0-100) plus a one-line plain-English context — "ISS 234 km off target," "target priority 5/5," "track confidence; 1.0 = fresh, 0.5 = days old," etc. The composite score is shown as the table footer so the math arrives at the score line above.

No new data fetched. Everything in the breakdown was already on `PassEntry.score_components` from the generator; we're just exposing it.

### Verified

- 217/217 frontend tests pass (was 210 + 7 new breakdown tests).
- Local headless preview confirms the new pane headers render on both Queue and Upcoming.
- Backward compat: older PassEntries with `score_components` (every version since V1) work unchanged.

### Added

- Pane header on the Queue tab (matching the Upcoming pane header introduced in V2).
- Click-to-expand score breakdown table on every card. Button-style score line, chevron rotates 180° when open, breakdown panel renders inline below.
- 7 new tests in `frontend/test/card.test.ts`: button shape, default-hidden, click-to-open, double-click-toggle, 5-component table + composite footer, dynamic nadir-km contextualization, regime='any' wording.

### Changed

- Upcoming pane header copy: now matches the Queue pane structure ("Next 24 hours — what to plan for" + cloud-source clarification + tap-for-breakdown hint).
- `.card-score` is now a `<button>` with focus styles + cursor pointer + faint hover background. Same visual rhythm as before, plus discoverable interactivity.

## [1.2.0.0] - 2026-05-11

### **V3.0 ships rocket-launch photography. The ISS planner now surfaces overhead launches in the Queue.**

When a Falcon 9, Soyuz, or any other rocket launches AND the ISS happens to be passing within ~800 km of the launch site at T-0 ±5 min, you'll see a 🚀 LAUNCH card in the Queue (or Upcoming for launches more than 90 min out). The card shows the rocket name, the NET-window confidence (`T-0 exact` or `Window: ±15 min`), and the same nadir-distance + WORF/Cupola tags every other pass card carries. Launches go through the same pass-finding + cloud-scoring pipeline as ground targets, so an overhead launch with clear skies scores the same way an overhead Tokyo pass does.

The product reason: launch shots are visually iconic and inherently rare (3-10 per year geometrically qualify for ISS). They were the obvious next thing to surface after V2's offline-resilience work landed. Chris (operator) and the rest of the crew can plan a launch shot the same way they plan any other.

### What changed for the user

- **🚀 LAUNCH cards in Queue + Upcoming.** Orange tag, leftmost in the meta row. Adjacent chips show the rocket family and NET-window confidence.
- **Reserved-slot guarantee** in both Queue (next 90 min) and Upcoming (next 24 h). If a launch qualifies geometrically and falls in the time window, it appears even when 5 priority-5 ground targets outscore it. The product would lose its purpose otherwise: a once-a-year overhead Falcon 9 buried under 5 Tokyo passes is the worst-case product failure.
- **Stale-launches banner overlay.** When the LL2 (Launch Library 2) feed has been unreachable for >24 h, the topbar gets a `🚀 launches stale Nh` suffix on top of whatever banner is showing (LOS, TLE drift, etc.). Operator knows the launches feature is degraded without having to inspect anything.
- **Banner copy: `Offline · X ago` → `LOS · X ago`.** Chris asked: LOS (Loss of Signal) is the operational term on ISS, reads more clearly at a glance during a real LOS window than the generic `Offline`.

### How it's wired

Each upcoming launch from LL2 gets treated as a synthetic target: launch site coords + priority=5 + the existing `find_passes` window of ±5 min around T-0. If pass geometry qualifies, the pass goes through the same `score_pass_for_target` pipeline as ground targets and gets tagged with a `launch` field on the resulting `PassEntry`. The frontend renders the 🚀 LAUNCH chip when `launch` is present; older v1.0/v1.1 snapshots without the field render normally.

LL2 health (last_successful_fetch + count_upcoming + schema_hash) folds into the existing `status.json` artifact rather than a separate `launches-health.json`. One source of truth for "did the last tick succeed at fetching X." The schema_hash is a depth-2 sorted-keys fingerprint that catches added or removed top-level / per-result fields without false-positiving on value-only changes.

### The numbers that matter

Verified by running the full 480-test suite (270 generator + 210 frontend) on merged HEAD, and `scripts/verify-sw-upgrade.sh` against the live deploy.

| Metric | v1.1.0.2 | v1.2.0.0 | Δ |
|---|---|---|---|
| Generator tests | 197 | 270 | +73 (V3 + LL2 hardening) |
| Frontend tests | 190 | 210 | +20 (launch-card + banner overlay + queue-filter) |
| Total tests | 387 | 480 | +93 |
| New generator module | — | `launch_data.py` | +281 lines |
| Status.json fields | 12 | 16 | +4 (launches_*) |
| Frontend bundle (gzip, app chunk) | 18.70 kB | ~18.9 kB | +0.2 kB (1%) |
| New banner overlay tier | — | `bannerWithLaunchesOverlay` | matches `bannerWithTleOverlay` precedent |

The bundle growth is the launch-tag rendering + Status type extension + banner overlay factory. 1% gzip cost for a new feature with full backward compat for older snapshots is honest.

### Adversarial review caught + fixed (in same PR)

The /review pipeline ran four specialists (testing, maintainability, security, adversarial). Two MULTI-SPECIALIST-CONFIRMED findings + 5 high-confidence single-source findings auto-fixed before ship:

- **NaN/Inf coordinate parsing.** `float("NaN")` parses cleanly but breaks `json.dumps` AND silently drops launches from filtering (NaN < N is always False). Fixed: `math.isfinite` + bounds check on lat/lon in `_parse_one_result`.
- **NET window vs PASS window mismatch.** Original 1800s NET cap allowed launches with ±30 min uncertainty into the pipeline, but `find_passes` searches only ±5 min around T-0. A 30-min-uncertain launch's real T-0 could fall outside the searched window. Tightened `NET_WINDOW_MAX_SECONDS = PASS_WINDOW_SECONDS` so the cap can never exceed search reach.
- **Past-t0 rejection.** LL2 occasionally surfaces completed launches in the upcoming feed; cache-fallback after weeks of LL2 downtime would re-publish them. Added past-t0 filter at parse time.
- **Cache-fallback re-filter.** _from_cache now uses `now=n` to drop past-t0 rows on every cache read.
- **bannerWithLaunchesOverlay loading-state guard.** Cold start with stale launches signal would have upgraded `Loading…` → orange and surfaced the overlay before any data fetched. Now passes loading state through unchanged.
- **ARCH-4 extension to Queue.** Original eng-review locked reserved-slot to Upcoming; adversarial caught that imminent launches (the highest-stakes case) would still get buried by score in Queue. Added `_reserve_launch_slot_in_queue` + 5 tests.

### V2-P0 SW upgrade verification piggybacks on this deploy

The V3 deploy is the natural "v2 deploy" for the V2-P0 SW upgrade test recipe in TODOS. New artifacts ship with this PR:

- `scripts/verify-sw-upgrade.sh` — 6-section / 15-check headless verifier. Validates against the live URL post-deploy: SW shape (skipWaiting yes, clientsClaim no), runtime cache strategies + names, PWA manifest reachability, registerSW.js auto-injection. Already validated against current live (15/15 PASS pre-V3 deploy).
- `docs/SW_UPGRADE_VERIFY.md` — 6-section eyes-on-glass checklist for the things headless can't see (multi-tab controller race, snapshot survival across upgrade, tile cache survival, PWA install drift).

### Verified

- 270/270 generator tests pass on merged HEAD.
- 210/210 frontend tests pass.
- `bun run build` clean: dist/sw.js still has `skipWaiting()` ×1, zero `clientsClaim()`.
- Live `map.astroanil.dev` (currently v1.1.0.2): `/qa` smoke against all 4 tabs, 0 console errors, queue-filter hotfix working as designed.
- `scripts/verify-sw-upgrade.sh` against live: 15/15 PASS.

### Known follow-ups (NOT in this PR)

- V3.1 ASCENT geometry (rocket climbing through atmosphere): per-rocket profiles, terminator gate, slant-range cap, multi-point cloud sampling. Filed as V3-P2 in TODOS. Revisit after V3.0 has run for ~4 weeks against real launches.
- V3-P3 `make ll2-diff` for schema-drift diagnosis when the alert fires.
- V4 operator wishlist from Chris (filed as V4-P2): map zoom-in for terrain detail, rotate-to-ISS-track toggle, NOAA SWPC aurora indicator, pre-cache tiles for upcoming targets.
- V4-P2 explainer copy + click-to-expand score breakdown ("I think I don't fully understand the queue vs upcoming and the scoring" — Chris).
- V4-P3 stale-manifest hint when Queue is empty.
- V2-P3 launch-site water heuristic override (Vandenberg-as-water artifact in `cloud.py:138`).

### Itemized changes

#### Added

- `generator/launch_data.py`: LL2 fetcher + `Launch` dataclass + filters + `compute_schema_hash` + cache-fallback discipline matching `fetch_tle`. NaN/Inf coordinate guards. Past-t0 rejection.
- `generator/main.py`: launch pipeline integration in `run_tick`. `_synthesize_launch_target` + `_reserve_launch_slot` + `_reserve_launch_slot_in_queue` + `_insert_soonest_if_missing` shared helper.
- `tests/fixtures/ll2-response-2026-05.json`: pinned LL2 schema fixture (4 launches, exercises filter rules).
- `tests/test_launch_data.py`: 30 tests covering parse, filter, schema-hash drift detection, cache-fallback, NaN/Inf rejection, past-t0 rejection, NET window invariant.
- `tests/test_main.py`: 12 new integration tests covering the launch pipeline + status.json fields + reserved-slot logic for both Queue and Upcoming.
- `frontend/src/types.ts`: `PassEntry.launch?` + 4 optional `Status` launches_* fields. Backward-compatible with v1.0/v1.1 snapshots.
- `frontend/src/card.ts`: 🚀 LAUNCH + rocket name + window confidence chips. New `formatLaunchWindow` helper.
- `frontend/src/banner.ts`: `bannerWithLaunchesOverlay` matching the `bannerWithTleOverlay` precedent. Pass-through on loading state.
- `frontend/src/style.css`: `.tag.launch-overhead`, `.tag.launch-rocket`, `.tag.launch-window` (orange-on-dark to match the rocket-flame mental model).
- `frontend/test/launch-card.test.ts`: 12 new tests (formatLaunchWindow + render + backward compat).
- `frontend/test/banner.test.ts`: +7 launches-overlay tests including loading-state guard + three-way composition (offline + TLE + launches).
- `scripts/verify-sw-upgrade.sh` + `docs/SW_UPGRADE_VERIFY.md`: V2-P0 SW upgrade verification artifacts.

#### Changed

- Banner copy: `"Offline · X ago"` → `"LOS · X ago"` across 4 messages. Red-state copy `"data may be very stale"` → `"data may be very old"` to avoid the redundant "stale" reading.
- Banner state machine: `bannerOffline`'s 4 levels (green / yellow / orange / red) now use LOS terminology throughout including doc-comments.
- `frontend/src/main.ts:refresh()`: now fetches `status` alongside the other artifacts (Promise.all with .catch fallthrough so older manifests without status.json don't break the path). Threads `launchesStaleHours(status, now)` through all 4 `setBanner` sites.
- `frontend/src/snapshot.ts`: status field now populated (was always null pre-V3).
- `generator/main.py:run_tick`: `status_data` gains `launches_last_successful_fetch`, `launches_count_upcoming`, `launches_count_pass_opportunities`, `launches_schema_hash`.

#### Fixed

- `frontend/src/main.ts`: `renderQueue` and `renderUpcoming` filter past `closest_approach` entries at render time. Was shipped as v1.1.0.2 hotfix; included here for completeness of the v1.1 → v1.2 release notes.
- `frontend/src/manifest.ts:fetchManifest`: dropped `?cb=${Date.now()}` query buster (silently defeated SW NetworkFirst manifest cache via Workbox's exact URL match). Was shipped as v1.1.0.1.
- TODOS.md: 3 V3-related (ASCENT V3.1, ll2-diff, Lane H V2-P0 overlap note) + 5 V4-P2/P3 (Chris's WhatsApp feedback) + 1 V2-P3 (Vandenberg-as-water).

#### For contributors

- New `compute_schema_hash` module pattern: depth-2 sorted-keys fingerprint of an external API response. Reusable for any feed where you want to catch shape drift without false-positiving on value changes.
- New `_insert_soonest_if_missing` shared helper: parameterizes the reserved-slot pattern across Queue and Upcoming filters. If V3.1 ASCENT lands, the same helper handles "reserve a slot for the next ASCENT" without needing a third specialized function.
- `scripts/verify-sw-upgrade.sh` is repeatable for V4/V5 deploys — V2-P0 becomes "just a thing we always run" rather than a one-off recipe.

## [1.1.0.2] - 2026-05-10

### Hide already-happened passes from Queue + Upcoming

Chris (operator) reported via WhatsApp 2026-05-10: "Occasionally, all of the queue items will be in the past — not sure why." Screenshot showed 4 cards in the Queue tab, every one tagged "Past." Confirmed expected behavior of the existing code: the generator publishes top5 as the next-90-min slice from when the manifest tick ran. By the time the user looks 30-60 min later, the highest-scored picks have happened. The cards rendered with a "Past" countdown text but stayed visible — the user (correctly) wondered what they were supposed to do with cards they could no longer shoot.

### Fixed

- `renderQueue` and `renderUpcoming` now filter out passes whose `closest_approach` is in the past before rendering. The 1Hz `rerenderCountdowns` tick re-evaluates the filter, so the moment a pass transitions to past it disappears from the list (no flicker of "Past" text first).
- When the entire Queue is past-filtered to empty, the existing "No passes in the next 90 minutes." empty state shows — accurate now since they really have all happened.
- Upcoming gets the same filter as defense-in-depth for very stale manifests (>90 min old, where Upcoming entries can also leak into the past).

3 new tests in `frontend/test/main-integration.test.ts` (past-only Queue → empty state; mixed Queue → only future renders; Upcoming filter symmetry). 190/190 tests pass.

Note: the `Offline → LOS` banner rename Chris also asked for is bundled into the V3.0 ship (`feat/v3-rocket-launches`), not this hotfix.

## [1.1.0.1] - 2026-05-05

### Workbox service worker — the V2 offline story now works on first visit too.

V2 made the page survive LOS by booting from a localStorage snapshot. That works for any user who's loaded the page once. This release adds a Workbox-generated service worker so the precached app shell, the live manifest.json, the versioned artifacts, and the basemap tiles all stay reachable when the network is dead — including on a fresh tab where there is no snapshot yet.

### What changed for the user

- **First-visit-then-LOS recovery.** With the SW installed, opening a fresh tab during LOS now serves the cached app shell + manifest + last-known artifacts instead of a blank page. The snapshot path still wins on returning visits (single-digit-ms render); the SW path fills the gap on the first one.
- **Tile cache survives LOS.** Carto basemap tiles cached for 7 days, GIBS true-color tiles for 24 h. The map keeps rendering tiles you've panned over even with the network off.
- **Multi-tab safety.** `skipWaiting: true` + `clientsClaim: false` means new SWs activate on install but only take over a tab on its next navigation. Two tabs open across a deploy: the new one gets the new code, the old one keeps the code it loaded with. No "new SW + old JS in same tab" race.

### How it's wired

- `vite-plugin-pwa` in `generateSW` mode. Routing rules: manifest NetworkFirst (2 s timeout), versioned artifacts CacheFirst, Carto/GIBS tiles CacheFirst LRU-bounded, `POST /api/log` NetworkOnly (so the existing offline-queue in calib.ts keeps owning the queue path).
- Adversarial review caught two issues that were fixed in the same PR: `fetchManifest()` was sending `?cb=${Date.now()}`, which silently defeated the SW NetworkFirst rule via Workbox's exact-URL match — fixed by relying on the existing `cache: 'no-cache'` header. `workbox-window` was a declared runtime dep but never imported — dropped to transitive only.

### Numbers

| Metric | v1.1.0.0 | v1.1.0.1 |
|---|---|---|
| Generated SW | none | dist/sw.js (2.4 KB) + workbox-*.js (23 KB) |
| Precached app-shell entries | 0 | 8 (~909 KB) |
| Runtime cache rules | 0 | 5 (manifest, versioned artifacts, Carto, GIBS, /api/log opt-out) |
| Frontend test count | 187 | 187 (manifest test updated for the no-cb contract) |
| Bundle (gzip, app chunk) | 18.71 kB | 18.70 kB (unchanged) |

### Verified

- 187/187 vitest tests pass on merged HEAD.
- Real-Chrome SW lifecycle: registers + activates, caches populate (workbox-precache=8, opd-manifest=1, opd-versioned-artifacts=3), offline reload renders 15 cards from SW + snapshot, upgrade lifecycle keeps existing tabs on their old SW until navigation.
- Static SW analysis: `dist/sw.js` contains `skipWaiting()` (1×), zero `clientsClaim()` calls.

### Added

- `vite-plugin-pwa` with Workbox-generated service worker (`frontend/vite.config.ts`).
- PWA manifest (`dist/manifest.webmanifest`) with inline-SVG icon (real PNG icons remain V2-P3 polish).
- Runtime caches: `opd-manifest`, `opd-versioned-artifacts`, `opd-tiles-carto`, `opd-tiles-gibs`.

### Fixed

- `fetchManifest()` no longer appends `?cb=${Date.now()}` — defeated the SW NetworkFirst manifest cache because Workbox does exact URL matching by default.
- Removed `workbox-window` from declared dependencies (was never imported; vite-plugin-pwa pulls it in transitively for the build pipeline).

### Known follow-ups (NOT in this PR)

- V2-P3 polish: real PNG icons (192×192, 512×512, maskable) for full PWA installability across Chrome / iOS Safari validators.
- Lane G: kill-switch DNS (needs DNS write access).
- Lane H: pre-launch e2e checklist (manual; blocked by F + G complete).

## [1.1.0.0] - 2026-05-04

### **V2 ships — the page works when the network doesn't.**
### Open the tab on the ISS during a 30-minute LOS window and the queue still renders.

The frontend now boots from a localStorage snapshot before manifest.json comes back. If the fetch fails, the snapshot keeps showing. If the fetch only half-succeeds (manifest loads but a track artifact 404s mid-deploy), the previous snapshot stays intact — no torn writes. The live ISS dot keeps moving past the 120-min polynomial window via client-side SGP4 propagation. The banner color escalates with snapshot age (green<1h → yellow<3h → orange<12h → red beyond) so the user always knows how trustworthy what they're looking at actually is.

The shipped V1 had a single failure mode: tab refresh during LOS = blank page. V2 makes that an "Offline · 23 min ago" badge with the full last-known-good queue rendered from disk. For an 8-month unattended mission with routine 30-60 min LOS windows, that's the difference between "the page is dead for hours" and "the page is honest about being a few minutes stale."

### The numbers that matter

Measured from the locked V2 plan (`~/Desktop/orbit-photo-director-offline-v2-plan.md`) and verified by `/qa` against `localhost:5173` (vite dev) and `localhost:4173` (vite preview, production build).

| Metric | V1 | V2 | Δ |
|---|---|---|---|
| Page after LOS refresh | Blank "Loading..." | Snapshot UI in <50ms | ∞ |
| Live ISS dot past 120 min | Frozen ("track expired") | SGP4 propagation, no horizon | unbounded |
| Manifest poll while tab hidden | Every 60s wasted | Paused; resumes immediately on visible | -100% bandwidth on hidden tabs |
| Snapshot writes per 60-min tick | Every 60s = 60 writes | 1 (skip-if-version-unchanged) | -98% localStorage churn |
| Frontend test count | 113 | 187 | +65% |
| Bundle (gzip) | 17.92 kB | 18.71 kB | +0.79 kB (4%) |
| Bundle (raw, satellite.js v6) | 42.79 kB | 43.83 kB | +1.04 kB |

The bundle growth is satellite.js v6 (~30 kB raw, ~6 kB gzip) plus the V2 modules (snapshot, network-status, banner state machine, the boot orchestration). 4% gzip cost for a fully-offline-resilient frontend is a good trade.

### Real bugs caught + fixed during the ship cycle

`/review` and `/qa` together caught and fixed:
- A hostile/torn-write snapshot would have permanently bricked the page across reloads (boot threw inside `bootFromSnapshot`, `pollScheduler` never started, reload re-read same poison). Recovery: try/catch + `clearSnapshot`.
- Snapshot version monotonicity: a CDN edge serving a stale manifest could overwrite a newer snapshot with older data. Fix: only save when manifest.version > on-disk version.
- SGP4 NaN propagation would render "NaN°N, NaN°W over Pacific Ocean" in the topbar from a degenerate propagation. Fix: NaN guards + roughRegion fallback.
- TLE epoch verification: an attacker-swapped TLE for a different object that parsed cleanly would produce confidently-wrong ISS positions. Fix: cross-check satrec epoch against manifest's tle_epoch within 2s.
- `obs Nm ago` tag was functionally dead — generator was shipping the future pass time as `sample_time`, so frontend's age formatter silently hid the tag. Fix in generator: ship the imagery composite hour for observed sources.
- Pending-sync badge rendered as a "_" / "•" artifact next to the Log tab (CSS `display: inline-block` overrode `hidden`). Fix: explicit `[hidden] { display: none }`.
- satellite.js v7 added a top-level-await WASM path that broke `vite build`. Pinned to v6 (same JS API, no WASM).

### What this means for the 8-month mission

The realistic worst case used to be: ISS in LOS, user refreshes the tab, page goes blank, user has no idea what's about to be photographable. After V2: page renders the previous snapshot in <50ms with a banner saying "Offline · 23 min ago — last sync recent" (green). The user keeps planning. When network comes back, the snapshot transparently updates. If the Mac on Earth dies entirely, the snapshot keeps the queue alive for hours; SGP4 keeps the live ISS dot moving even days past the polynomial window, with a TLE>48h overlay banner warning of drift.

V2-P1 (still deferred): Workbox service worker (Lane F), kill-switch DNS at reset.astroanil.dev (Lane G), pre-launch e2e checklist (Lane H). See TODOS.md.

### Itemized changes

#### Added

- **Boot from localStorage snapshot** — synchronous queue + map render before manifest.json comes back. First paint shows the previous-known-good UI within milliseconds instead of "Loading..." until the network resolves (or never resolves during LOS).
- **SGP4 client-side fall-through** — when the polynomial window expires (120 min past manifest), the live ISS dot keeps moving via satellite.js SGP4 propagation against the source TLE shipped in `track.json`. Coordinate frame matches the Python generator (geocentric spherical from ECEF) so the handoff is seamless.
- **Visibility-aware poll scheduler** — `createPollScheduler` pauses manifest fetches when the tab is hidden, fires immediately on visible-again. Saves ISS bandwidth on tabs nobody is watching.
- **Offline-confidence banner** — color escalates with snapshot age: green (<1h, "Offline · Nm ago — last sync recent"), yellow (1–3h), orange (3–12h, "values may be drifting"), red (>12h, "data may be very stale"). TLE>48h adds an orange overlay ("TLE 72h old — live track may drift").
- **`obs Nm ago` cloud-age tag on cards** — shows how recent the cloud reading is so the user can weight day-old MODIS vs 10-min GOES-IR appropriately. Hidden silently when the cloud_source is a no-observation placeholder (the existing "no cloud obs" tag handles that case).
- **Pending-sync badge in Log tab** — "Log [3]" when calibration writes are queued offline. Updates immediately on every Shoot/Skip click and after `drainQueue`.
- **Map imagery-date badge** — "Imagery: 2026-05-03" overlay in the bottom-right of the map so a GIBS tile cached past midnight doesn't read as today's clouds.

#### Changed

- **Generator ships source TLE in `track.json`** — alongside the polynomial fit, so the frontend can SGP4-propagate client-side without a separate fetch.
- **Generator ships per-pass `sample_time`** — the actual imagery composite hour (not the pass time) for observed sources, so the frontend's `obs Nm ago` tag works. Forecast samples keep the forecast valid-time.
- **Transactional refresh** — `refresh()` in main.ts mutates `currentManifest`/`Top5`/`Track` only AFTER all artifacts resolve (`Promise.all`). A partial fetch failure leaves the previous snapshot untouched. Idempotent saveSnapshot: skips writes when manifest.version is unchanged (~98% fewer localStorage writes per 60-min tick).
- **`refresh()` short-circuits when `navigator.onLine` is false** — saves the doomed fetch + the error-banner flash on every poll while LOS.
- **Polynomial accuracy documented** — the existing order-11 fit has up to 1.1° lat error vs SGP4 truth (Runge wobble near window edges). SGP4 fall-through is provably the more accurate path. Documented inline in `frontend/test/iss-sgp4.test.ts`; tracked as V2-P2 ("tighten polynomial OR drop for SGP4-only") in TODOS.md.

#### Fixed

- **Hostile/torn-write snapshot brick recovery** — `init()` now wraps `bootFromSnapshot` in try/catch + `clearSnapshot` on failure. A malformed snapshot (Chrome crash mid-setItem, browser extension, schema drift) used to permanently brick the page across reloads.
- **Snapshot version monotonicity** — only writes when `manifest.version > existing snapshot version`. A CDN edge serving stale data couldn't overwrite a newer snapshot before this.
- **SGP4 NaN guards + TLE epoch verification + whitespace tolerance** — NaN-typed positions from degenerate propagations no longer render "NaN°N, NaN°W"; satrec epoch is cross-checked against manifest's `tle_epoch` (defends against attacker-swapped TLEs); TLE lines are trimmed before parsing (defends against `\r` from Windows-edited cache files).
- **Safe card lookup** — `onCardAction` uses dataset comparison instead of CSS-selector interpolation; a target_id with `"` would have crashed `querySelector` and silently swallowed the toast.
- **Clock-rollback clamp on snapshot age** — backward NTP correction during long offline period no longer renders "Offline · -50 min ago" misleading text.
- **`obs Nm ago` tag now actually renders** — generator shipped pass time (always future) as sample_time; tag was silently hidden for every observed source. See "Changed" above.
- **Pending-sync badge "_" artifact** — CSS `display: inline-block` overrode `hidden`. Explicit `.pending-badge[hidden] { display: none }` rule fixes it.

#### For contributors

- **187 frontend tests** (was 113) — `iss-sgp4.test.ts` (10), `snapshot.test.ts` (15), `network-status.test.ts` (10), `main-integration.test.ts` (11) for boot/refresh/banner/badge integration. `iss.test.ts` extended with `liveIssNow` combined-path tests. `card.test.ts` extended with `formatObsAge` boundary tests + `obs-age` tag rendering tests. `banner.test.ts` extended with offline + TLE overlay tests. `calib.test.ts` extended with `queuedCalibCount` tests. `map-imagery-date.test.ts` for the new badge.
- **228 python tests** (was 162) — `test_main.py::test_run_tick_track_includes_tle` for the new generator field, `test_score_pass_for_target_uses_composite_hour_for_observed_sample_time` regression test for the obs-age fix, plus expanded coverage in `tests/test_main.py`.
- **satellite.js pinned to v6.0.2** — v7 added a WASM-pthreads runtime with top-level-await that broke `vite build` (iife output doesn't support TLA). The v6 JS API is identical for the four functions we use.
- **`frontend/src/vite-env.d.ts` added** — so TypeScript knows about `import.meta.env.MODE` for the test-mode auto-init guard in `main.ts`.
- **TODOS.md restructured** — V3 → V2 naming aligned with what shipped. Lanes F/G/H captured as V2-P1; sha256 verification + polynomial tightening as V2-P2; forecast-horizon UI tag + periodic satrec re-parse as V2-P3.
- **`frontend/public/` and `uv.lock` gitignored** — public/ is a dev-only artifact mirror used by /qa; uv.lock is the Python lockfile that was supposed to be ignored per V1 checkpoint intent.

## [1.0.0.0] - 2026-05-03

### V1 ships — Earth-photography planner for the ISS, end to end.

A Mac on Earth runs a 60-min loop: pull the ISS TLE, propagate every pass over your target list for the next 24 hours, sample observed cloud cover from four satellite sources, score every pass against the GFS forecast for far passes, and atomically publish a manifest to Cloudflare R2. A glanceable web app at map.astroanil.dev tells you what's about to be under the station, what you can plan for tonight + tomorrow, and whether it's worth raising the camera. Calibration writes flow back to a token-gated Cloudflare Worker so a second-pass scoring model can be tuned from the post-mission archive.

### Added

- **Shot queue** — top 5 imminent passes (next 90 min), scored on regime fit (day / night / terminator), nadir proximity, target priority, and probability of a clear shot. Each card shows countdown, observed cloud class, score, and a colored badge marking whether the pass is a WORF shot (nadir window, <30° off-nadir, purple) or Cupola shot (≥30°, panoramic dome, orange). Shoot/Skip emits a calibration record; toast confirmation tells you whether it synced or queued offline.
- **Upcoming tab** — top 10 passes spanning the next 24 hours, scored against the GFS cloud forecast at each pass time. Forecast cards have a soft yellow countdown and a "forecast" tag so you can tell observed-now from forecast-later at a glance. Lets you set an alarm for the 4am pass over the Himalayas tomorrow.
- **Map view** — MapLibre canvas with Carto dark basemap, NASA GIBS true-color overlay, 2-orbit ISS ground track polyline (200 min, raw SGP4 samples — no fit drift past the polynomial window), target markers colored by score, and a stylized ISS-silhouette marker (central white truss + cyan solar arrays + pulsing halo) updated every 1s from a 120-min polynomial fit. A "Now / +90 min" toggle scrubs the ISS marker forward to preview future passes.
- **Calibration log** — list of recent Shoot / Skip / Rate events grouped per pass. Each unrated Shoot exposes a Rate button that opens a modal with 1–5 stars and an obstruction-class dropdown (clear, cloudy, sun-glint, thin cirrus, haze). The calibration-token field uses an in-page password-input modal (no shoulder-surfing, no autofill capture, value wiped on close).
- **Live ISS sub-point in topbar** — every-1s "ISS 35.6°N, 140.2°E · over Asia" updates from the polynomial fit. Solves "is the queue empty because of geography or because it's stale?" without making you open the Map tab.
- **Globally complete day+night cloud sampling** with honest no-observation fallback —
  - Tier 1: NASA GIBS MODIS Aqua/Terra Day/Night (direct cloud fraction, 0–100 from the published colormap)
  - Tier 2: GOES-East/GOES-West infrared Band 13 (brightness → cloud-fraction proxy, day + night, Americas + adjacent oceans)
  - Tier 3: EUMETSAT Meteosat IR108 via WMS (day + night, Africa/Europe)
  - Tier 4: NICT Himawari-9 true-color tiles (daytime Asia/Western-Pacific, replaces the broken GIBS Himawari layer)
  - Tier 5 (forecast): NOAA GFS via Open-Meteo for any pass >90 min ahead — same data underneath the more-authoritative NOMADS GRIB2 path, but pure HTTP+JSON so no eccodes binary deps to break in the field
  - Fallback: if all four observed tiers miss, the card shows a dashed "no cloud obs" tag so you know the score is a placeholder, not a measurement.
- **137 targets** — 106 curated (aurora ovals, night-lit megacities, iconic-shape regions, big-terrain features, volcanoes, lightning hotspots, dynamic events) plus 32 personal targets (hometown, SpaceX/Blue Origin/NASA launch sites, university alumni, current crew hometowns). A CSV importer (`scripts/import_personal_targets.py`) merges personal targets into the curated list without conflicts.
- **Atomic publish to Cloudflare R2** via rclone (`scripts/deploy.sh`) with manifest pointer flip last so readers never see a partial deploy. Deploys are versioned under `out/v/{tick_ts}/`; old versions prune on a 6h horizon. A wrangler-only fallback (`scripts/deploy_wrangler.sh`) handles the case where R2 API keys aren't available. `upload_frontend.sh` surfaces wrangler errors with `✓`/`✗` per file and exits non-zero on partial failure.
- **Cloudflare Worker** at the same origin: token-gated POST /api/log (8 KB body cap, atomic R2 dedupe via `onlyIf: { etagDoesNotMatch: '*' }`, strict ISO-8601 pass_time regex, sanitized keys, 200/day rate limit per token via R2 counter — and only first-time writes count, so dedupe-replays don't burn the budget). GET /api/log (paginated list, capped at 50 to stay under Workers Free subrequest budget). GET /api/health (manifest freshness). R2 static fallback that serves the published site with proper cache headers (`immutable` on hashed assets, short TTL on `index.html`). 503 instead of 500 if `CALIB_TOKEN` is ever undefined.
- **launchd daemon** with stall watchdog (10-min cap per tick), exponential backoff on consecutive failures (30s → 1h), Popen + thread-drain + killpg subprocess wrapper around the deploy script so a stuck child can't wedge the supervisor, flock around `run_tick` so two concurrent ticks fail fast with a clear error, and supervisor exits non-zero on KeyboardInterrupt so launchd's `KeepAlive: Crashed=true` actually restarts the daemon.
- **Mac hardening script** (`scripts/harden-mac.sh`, idempotent + `--verify` mode): persistent power management (sleep 0, autorestart 1, tcpkeepalive 1, womp 1), screen lock disabled, App Store auto-updates off. Plus credential-rotation runbook (`docs/RUNBOOK.md`) covering Earthdata password, Cloudflare R2 keys, and CALIB_TOKEN rotation procedures, plus a documented daemon cold-start smoke test.
- **325 tests** across the three runtimes — 162 pytest + 113 vitest frontend + 50 vitest worker — covering orbit propagation, polynomial fits, all four observed cloud samplers + GFS forecast sampler, scoring, manifest publish, daemon supervisor + watchdog + deploy_to_r2 (subprocess timeout / kill-on-hang / rclone-missing / wrangler-fallback), tick lock contention, Worker /api/log POST + GET + atomic dedupe + token gating + rate limit (incl. dedupe-no-op-doesn't-burn-budget) + handleStatic R2 fallback, card render with all badges, in-page token modal flow, openRateModal star-picker, ISS-silhouette SVG marker, and the openRateModal fetch-mock submit flow.

### V1 boundaries (intentionally deferred, tracked in TODOS.md)

- **V3 — offline-resilient frontend** (full /plan-eng-review'd plan persisted): service worker via vite-plugin-pwa, localStorage snapshot, satellite.js client-side SGP4 for the live dot past the polynomial window, kill-switch on a different origin, atomic-set artifact handling. Targets full offline operation through 30-60 min ISS LOS windows.
- SatCORPS NetCDF fetcher (V2 — current GIBS + GOES + Meteosat + Himawari path covers the same use case)
- Calibration-driven model retuning loop (post-mission V2)
- Filterable WORF / Cupola queue view (V2)
- A handful of P3 polish items: per-second card re-render diffing, SVG pulse pause when tab hidden, sampler inter-tick caching, Hawaii false-positive in the sun-glint heuristic, sun-subpoint Equation of Time correction.

### What this means

You can put a Mac on Earth, walk away for 8 months, and the queue at map.astroanil.dev will tell you when to raise the camera — for the next 90 minutes (observed cloud, 4 satellite sources) and for the next 24 hours (GFS forecast). The cold-start cycle has been verified end-to-end: kill the LaunchAgent, restart, watch the next tick fetch the TLE, sample four cloud sources, fetch GFS forecasts for 137 targets, score 297 passes, publish to R2 — all in ~10 seconds. The daemon survives a watchdog SIGINT (launchd restarts on non-zero exit), a corrupt CDN response (TLE cache only writes after parse succeeds), a wedged deploy script (Popen + killpg, not subprocess.run), a stale CALIB_TOKEN (clean 503), a leaked CALIB_TOKEN (rate-limited at 200/day, dedupe-replays free), an XSS attempt via personal-targets.csv (popup uses textContent, not setHTML), and 30-60 min stretches with stale satellite imagery (banner shows imagery age explicitly).
