# Follow-ups

Defects and stale documentation found while writing `ARCHITECTURE_NOW.md`. None of these are fixed in the structural work, because a behavior change hidden inside a refactor cannot be reviewed. Each entry names the evidence so a later change can start from a failing test.

## Behavior defects

**The 1 Hz countdown tick overwrites the offline banner.** `rerenderCountdowns` at `main.ts:643` ends with an unconditional `setBanner(bannerWithLaunchesOverlay(bannerFromManifest(...)))`. It ignores `currentlyOffline` and it ignores the tappable "sign in again" banner that `doRefresh` sets when the Access session has expired. Once a manifest exists, either banner survives for at most one second. Pin the offline banner first, then fix.

**Map pin filtering and queue filtering can disagree for a signed-in crew member.** `readActiveDistanceThresholdKm` at `map.ts:305` resolves the profile with `parseProfileFromURL` only. `main.ts` filters the queue from `currentProfile`, which comes from `resolveAccountProfile`. When those two resolve to different profiles, the map and the queue show different passes for the same operator.

**`applyDistanceFilter` is a silent clone.** `main.ts:427` is line-for-line identical to `filterPassesByDistance` at `map.ts:322`. The comment above it says it delegates to that helper and is tested through it. Neither is true. The clone exists to keep `main.ts` from importing MapLibre, which is a real constraint, so the fix is to move the pure filter out of `map.ts` rather than to add an import.

**GIBS imagery never advances past the date it was built with.** `buildStyle` bakes `yesterdayIso()` into the `gibs-clouds` tile URL at `map.ts:568`, and no code calls `setTiles` on that source. A tab left open across UTC midnight keeps painting the previous day's composite. The imagery badge is the only signal to the operator.

**HTML ships the opposite defaults from the code.** `index.html:122` gives `#bearing-north` the `active` class, while `readBearingMode` at `map.ts:497` defaults to `iss-up`. The follow button ships without `active`, while `followISS` starts `true` at `map.ts:2573`. The first paint therefore shows a control state that does not match the map until the bind functions run.

**The test reset helper disagrees with production.** `_resetMapStateForTest` at `map.ts:517` sets `bearingMode = 'north'`. Production defaults to `iss-up`. Any test that relies on the reset is asserting against a default the app never has.

## Dead code

**Two unused imports from `satellites.ts`.** `fetchTLEByCATNR` and `fetchTLEByName` are imported at `map.ts:40` and never called. The satellite picker builds a `SatelliteMeta` and calls `fetchSatelliteTLE` instead. `frontend/tsconfig.json` does not set `noUnusedLocals`, so nothing catches this.

**The forecast cloud layer is gated off.** `FORECAST_CLOUDS_UI = false` at `map.ts:207` disables a full raster path that still has `nearestForecastFrame`, `refreshForecastCloudLayer`, an `addSource` site, an `addLayer` site, and a test file. Decide whether it is a capability or dead weight before moving it.

## Stale documentation

**`map.ts:3` documents a five-layer stack.** The real stack is 21 layers. The header predates the Esri basemap, the IR raster, the terminator, the coastline, and the labels layer. An agent that trusts the header will insert a layer in the wrong position.

**`docs/TEST_PLAN.md` describes tests that do not exist.** Line 69 claims Playwright E2E flows. No Playwright dependency exists in `frontend/package.json` or `worker/package.json`. Line 70 claims `make test` emits a coverage report. It does not. Line 67 claims a 90% line and 100% branch gate on `score.py`. CI enforces 85% across `generator/`.

## Enforcement gaps

**Coverage thresholds never execute.** `frontend/vite.config.ts:324` sets thresholds of 80/80/75/80 and excludes `src/main.ts` and `src/map.ts`. The frontend CI job runs `vitest run` with no `--coverage`, so neither the thresholds nor the exclusions have any effect today.

**No JavaScript or TypeScript linter runs anywhere.** `eslint-disable` comments exist in `frontend/src` and `worker/src`, but no ESLint config or dependency exists. `ruff` covers `generator/` and `tests/` only, not `scripts/`.
