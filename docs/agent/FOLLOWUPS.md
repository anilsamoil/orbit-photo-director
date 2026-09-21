# Follow-ups

Defects and stale documentation found while writing `ARCHITECTURE_NOW.md`. None of these are fixed in the structural work, because a behavior change hidden inside a refactor cannot be reviewed. Each entry names the evidence so a later change can start from a failing test.

## Behavior defects

**The 1 Hz countdown tick overwrites the offline banner.** `rerenderCountdowns` at `main.ts:643` ends with an unconditional `setBanner(bannerWithLaunchesOverlay(bannerFromManifest(...)))`. It ignores `currentlyOffline` and it ignores the tappable "sign in again" banner that `doRefresh` sets when the Access session has expired. Once a manifest exists, either banner survives for at most one second. Pin the offline banner first, then fix.

**Map pin filtering and queue filtering can disagree for a signed-in crew member.** `readActiveDistanceThresholdKm` in `map.ts` resolves the profile with `parseProfileFromURL` only. `main.ts` filters the queue from `currentProfile`, which comes from `resolveAccountProfile`. When those two resolve to different profiles, the map and the queue show different passes for the same operator. The structural work made this visible rather than fixing it: both callers now share one predicate in `pass-filter.ts`, and each still reads its own threshold. `queueDistanceThresholdKm` in `main.ts` is the other half. Deciding which read is correct is a product call.

**GIBS imagery never advances past the date it was built with.** `buildStyle` bakes `yesterdayIso()` into the `gibs-clouds` tile URL at `map.ts:568`, and no code calls `setTiles` on that source. A tab left open across UTC midnight keeps painting the previous day's composite. The imagery badge is the only signal to the operator.

**HTML ships the opposite defaults from the code.** `index.html:122` gives `#bearing-north` the `active` class, while `readBearingMode` at `map.ts:497` defaults to `iss-up`. The follow button ships without `active`, while `followISS` starts `true` at `map.ts:2573`. The first paint therefore shows a control state that does not match the map until the bind functions run.

**The test reset helper disagrees with production.** `_resetMapStateForTest` at `map.ts:517` sets `bearingMode = 'north'`. Production defaults to `iss-up`. Any test that relies on the reset is asserting against a default the app never has.

**The pin popup's add-to-targets controls paint light text on a light button.** `.pin-add-button` and `.pin-add-cancel` in `style.css` set `background: #f2f5f9` and `font: inherit` with no `color`, so they inherit the dark popup's light text. In a real browser the labels "➕ Add to my targets" and "Cancel" are near-invisible; only the ➕ glyph and the blue Save button read. Seen in the slice 4 walkthrough screenshots, identical on the build before the move, so it is a styling defect and not a regression. Fix is one `color` rule in each selector, after a pin on the computed color.

## Dead code

**Six Earth radius constants carry two different values.** `iss-sgp4.ts`, `pin-drop.ts` and `terminator.ts` use 6378.137, the equatorial radius. `photo-conditions.ts`, `moon.ts` and `beta-angle.ts` use 6371, the mean radius. Distances computed in one module are therefore not comparable with the other, and the 0.11% difference is large enough to move a nadir distance by kilometres near the threshold. Collapsing them would change output numbers, so it cannot ride inside a structural change. Decide which radius each computation should use, then pin the new numbers.

**The forecast cloud layer is gated off.** `FORECAST_CLOUDS_UI = false` at `map.ts:207` disables a full raster path that still has `nearestForecastFrame`, `refreshForecastCloudLayer`, an `addSource` site, an `addLayer` site, and a test file. Decide whether it is a capability or dead weight before moving it.

## Stale documentation

**`docs/TEST_PLAN.md` describes tests that do not exist.** Line 69 claims Playwright E2E flows. No Playwright dependency exists in `frontend/package.json` or `worker/package.json`. Line 70 claims `make test` emits a coverage report. It does not. Line 67 claims a 90% line and 100% branch gate on `score.py`. CI enforces 85% across `generator/`.

## Enforcement gaps

**Coverage thresholds never execute.** `frontend/vite.config.ts:324` sets thresholds of 80/80/75/80 and excludes `src/main.ts` and `src/map.ts`. The frontend CI job runs `vitest run` with no `--coverage`, so neither the thresholds nor the exclusions have any effect today.

**No JavaScript or TypeScript linter runs anywhere.** `eslint-disable` comments exist in `frontend/src` and `worker/src`, but no ESLint config or dependency exists. `ruff` covers `generator/` and `tests/` only, not `scripts/`.
