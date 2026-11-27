# Follow-up queue

Product gaps found while maintaining this skill. A maintain run does not change product code. Each entry names the proof that is missing.

## Test gap: bindTabs once

`init` in `frontend/src/main.ts` calls `bindTabs(!sessionFailed)` once. Re-adding the duplicate second `bindTabs()` call in `main.ts` leaves `frontend/test/map-import-failure.test.ts` green. A second call registers another click listener on each tab, so one click runs the handler twice. A product test should assert that `bindTabs` binds once (no double handlers).

Recorded after #269 (`a9df092f486cda4a05c4328d1a5b430047e7bdb9`).

## Deploy note: upload without CLOUDFLARE_API_TOKEN

`scripts/upload_frontend.sh` probes R2 with `wrangler r2 object put`. The rclone fallback (`copyto`, then `cat`) runs only when that probe's error matches a Cloudflare 403 or code 10000. A missing `CLOUDFLARE_API_TOKEN` is not that match. The script prints `R2 write preflight failed without a recognized 403/10000` and exits 3. No frontend file is published, and rclone is not called. `bash scripts/upload_frontend.test.sh` covers a non-403 probe as `generic` and `timeout10000` (exit 3, no publish). This skill does not deploy and does not use real R2.

Recorded after #345 (`5ef2db8c`). The product script stays as it is.

## Test gap: changing only `_bucket_key`

`tests/test_lightning.py` `test_glm_sampler_aggregates_synthetic_flashes` and the strongest-cluster helpers insert flashes with `_bucket_key` and then look them up with the same function inside `GLMSampler.sample`. Changing only `_bucket_key` in `generator/lightning.py` stays green, because the stored key and the lookup key move together. A product test should place a flash at a known latitude and longitude under a literal bucket key, require `sample` to find it, and miss a flash stored one bucket away, without calling `_bucket_key` to build the stored key.

Recorded after #346 (`74ce5a5`).

## Test gap: one invalid flash

`_decode_glm_granule` raises `ValueError` when one flash has an unusable latitude, longitude, or time offset, and the handler returns `None` for the whole granule. `test_decode_glm_granule_synthesizes_in_memory_netcdf` uses three valid flashes. `test_decode_glm_granule_handles_corrupt_buffer` and `test_decode_glm_granule_empty_bytes` are not that granule. A decoder that skips one invalid flash and keeps the rest stays green. A product test should decode a granule with one invalid flash among valid flashes and require `None`.

Recorded after #346 (`74ce5a5`).

## Test gap: a future-dated listing key

`_glm_granule_urls` drops a key whose start is after `when` (`granule_dt.timestamp() <= when.timestamp()`). `test_glm_granule_urls_parses_keys_within_window` covers an in-window key, a key older than the window, and a malformed stamp. It has no future-dated key. Dropping that upper bound stays green. A product test should include a listing key dated after `when` and require that URL to be absent.

Recorded after #346 (`74ce5a5`).

## Product gap: the S3 listing has no continuation token

`_glm_granule_urls` GETs each hour prefix once (`list-type=2`) and reads `<Key>` until the body ends. It does not read `IsTruncated` or `NextContinuationToken`, and it does not send `continuation-token`. A truncated page is treated as the full hour. This skill does not fetch NOAA.

Recorded after #346 (`74ce5a5`).

## Product gap: the ascent caption sits under the launch card (401)

`#launch-ascent-caption` is painted at the bottom of `#map-pane`. On iPad and desktop it sits under `#map-launch-coverage`. `launch-planner.mjs` measures that overlap (`caption-under-card` and `overlap WxH`) and does not fail the drive. A pass of the seven sizes measured no overlap at 402 by 874, 304 by 114 at 874 by 402, 1024 by 768, 1180 by 820, 834 by 1210, and 1440 by 900, and 298 by 114 at 768 by 1024. Follow-up 401. A maintain run does not change the product layout.

Recorded after #368 (`174d761`).

## Deferred: LP1 does not verify a flight trajectory (402)

`TODOS.md` P2: verify the inclination and site tables against primary documents, calibrate modeled early-ascent tracks, sample heading uncertainty, and model coast, insertion, and deployment. LP1 adds conditional T+600 estimates and minute liftoff scans. It does not verify a flight trajectory. Follow-up 402. This skill does not treat those gaps as a failed drive.

Recorded after #368 (`174d761`).

## Deferred: Astra P3s (404)

#370 left `prove PASS, Astra and green CI on the same head` unchecked. Astra is the crs35-astra review fixture in `tests/test_launch_catalog_forecast.py` (the Oct 9 TLE copied for that review). The P3 rows in `TODOS.md` stay deferred: verified window attitude, a high-fidelity trajectory, photo ingestion, and Web Push. This toggle drive does not prove them. Do not fail the drive for that gap.

Recorded after #370 (`d9516ca`).

## Product gap: pointer focus draws no ring, and a hazard tap can miss (405)

After a pointer, focus lands on the brief summary and `:focus-visible` is false, so no ring is painted. Measured false at 1024 by 768, 402 by 874, 874 by 402, and 1440 by 900. `launch-planner.mjs` records `focus-visible 0` and does not fail.

A clear-point tap or click on a published hazard polygon is recorded and is not a pass/fail. On this pass a click opened the popup at 1440 by 900, and a tap opened it at 874 by 402. A tap at 1024 by 768 left it closed. At 402 by 874 the framed polygons had no clear point (`hazard-popup none`). Do not fail the drive when that popup stays closed.

Recorded after #370 (`d9516ca`).

## Open: iOS 27.2 simulator results are not G1 sign-off

The owner's Mac has iOS 27.2 simulators from Xcode 27.2. Those simulators can run G1 checks 2, 3, 4, 5, 9 and 10 on a real GPU. A result labelled `iOS 27.2 simulator` is evidence. It does not close the on-device gate in `docs/ios/DECISIONS.md` under `## G1 on-device gate`. This skill reads hosted `ios.yml` artifacts from Linux and cannot read that local simulator. Check 5 on iPad, including a null horizon limb, stays open, with checks 2, 3, 4, 9 and 10 and iPad check 7. `ios-release` dispatch still waits on the owner's G0 device registration and team ID. This skill does not dispatch that workflow.

Recorded after #390 (`309049acf2f49485da92777e2906958d6127a72d`).

## P3: the release decision says the proof artifact is kept one day

`docs/ios/DECISIONS.md` says the unsigned `snap-proof-web` artifact is kept for one day. `.github/workflows/ios-release.yml` sets `retention-days: 3` on that artifact. The owner-approval window in `docs/ios/OWNER_STEPS.md` is three days. This skill follows the workflow. It does not edit the decision.

Recorded after #390 (`309049acf2f49485da92777e2906958d6127a72d`).

## P3: grant polling stops after a public 503 (Astra r4)

A `GET /manifest.json` 503 after the snapshot is on screen throws in `fetchManifest`. `renderOfflineBanner` calls `setLinkedRosterTargetsOffline(true)`, which clears the linked Kutryk row and ring and paints the LOS banner. `pollLinkedRosterTargets` then returns before the session read, because `reverifyLinkedRosterTargets` returns while that latch is set. A grant that is still valid stays hidden until a later successful refresh calls `setLinkedRosterTargetsOffline(false)`. The 503 case in `frontend/test/main-integration.test.ts` proves the clear. It does not prove that the 60s poll restores the row by itself. This skill does not edit `frontend/src/main.ts`.

Recorded after #386 (`c65abb2b431f7d042f226bdd0a5ee3b4a7623caf`).

## Product gap: ISS inset labels from the 2026-11-27 spot check

A read-only look at the ISS plan inset on 2026-11-27, not reproduced in this skill. Brazil's country label is missing while Argentina's renders. Country labels sit on continent labels: Canada over NORTH AMERICA, Nigeria over AFRICA, France over EUROPE, and SOUTH AMERICA is garbled. Pacific and Atlantic are doubled, probably from wrapped world copies. That doubling is low priority. The likely cause is that #264's dedupe compares country with country only. A root-cause repro is queued after W-03. This skill does not edit `track-inset.ts` and does not fetch the public hosts.

Recorded after the 2026-11-27 spot check.

## P3: a zero-width-only target name is accepted

`validateTarget` uses `name.trim()`. U+200B is not whitespace, so a name that is only U+200B has length 1 after trim and POST and PUT accept it. The client trim does the same. A product test should reject that name. This skill does not edit `worker/src/profiles.ts`.

Recorded after #388 (`15573790a0f73c83d414b4e4064211fa76d7438d`).

## Deploy note: the whitespace 400 is not checked live

The 400 `name_empty` cases run against the in-memory worker in `worker/test/profiles.test.ts`. A live POST or PUT needs an Access session. This skill does not fetch `https://map.astroanil.dev` or `https://map.expedition75.com` and does not send a credential.

Recorded after #388 (`15573790a0f73c83d414b4e4064211fa76d7438d`).

## Resolved

### P2: passing checks 6 and 8 skip evidence content (W-03)

`validate_passing_evidence` in `app/scripts/export-host-proof.py` now calls `validate_bridge` for check 6 and `validate_lifecycle` for check 8. Check 7 calls `validate_tile_routes`. Check 5 requires nadir `nested` `object` and 256 by 256 NASA tiles. Check 10 requires the RSS sample, gap, and duration rules. `test_passing_selected_row_with_invalid_evidence_fails` no longer accepts a placeholder dict for those rows.

Recorded after #383 (`cb0bbd2b35a829e13ac8923e49ef0d3624a3169d`).

Resolved by #390 (`309049acf2f49485da92777e2906958d6127a72d`).

### P3: D-1 still describes a full simulator proof (W-03)

`docs/designs/ios-app.md` line 91 now says the hosted simulators lose WebGL, and that W-03 verifies checks 2 through 5, 9, 10, and iPad check 7 on signed devices. The open gate remains `docs/ios/DECISIONS.md` under `## G1 on-device gate`.

Recorded after #383 (`cb0bbd2b35a829e13ac8923e49ef0d3624a3169d`).

Resolved by #390 (`309049acf2f49485da92777e2906958d6127a72d`).

### Verification gap: the merge-SHA iPad launch PNG is white

`iOS unsigned` run `45877212976` on `26746c9e51b523c0dca4efb25ad7cf5c71429ee2` attached a 1668 by 2420 white iPad PNG while the job stayed green. The export step only required a nonempty file.

#383 calls `validate_screenshot(png, launch=True)` in `.github/workflows/ios.yml`. #390 aligns that test with `RenderedScreenshot.swift`: luminance standard deviation at least 6, and either two color clusters or at least 95% fixture-marker coverage. A launch frame has no marker, so one cluster still fails. A 64 by 64 white PNG exits 1 with `luminance std-dev 0.00, color clusters 1`. That white frame fails the launch job.

Recorded after #381 (`26746c9e51b523c0dca4efb25ad7cf5c71429ee2`).

Resolved by #383 (`cb0bbd2b35a829e13ac8923e49ef0d3624a3169d`).

### Deferred: hosted verification wording still says pending

`docs/ios/STATUS.md` and `docs/ios/W-01-VERIFICATION.md` no longer say hosted verification is pending. STATUS records the W-01 launches and the scoped G1 runs. W-01-VERIFICATION records hosted run `45870433702` as passed.

Recorded after #381 (`26746c9e51b523c0dca4efb25ad7cf5c71429ee2`).

Resolved by #383 (`cb0bbd2b35a829e13ac8923e49ef0d3624a3169d`).

### Deferred: template code-sign identity in the Xcode project

`project.pbxproj` no longer sets `CODE_SIGN_IDENTITY = "iPhone Developer"`. The configurations use `CODE_SIGN_STYLE = Automatic`. #390 checks the signed archive's team and requires `ITSAppUsesNonExemptEncryption` false. The hosted test still passes `CODE_SIGNING_ALLOWED=NO`.

Recorded after #381 (`26746c9e51b523c0dca4efb25ad7cf5c71429ee2`).

Resolved by #383 (`cb0bbd2b35a829e13ac8923e49ef0d3624a3169d`).

### Product gap: the wrap case still uses the old 60-character title

`frontend/test/pass-row-fit.test.ts` line 315 is still `keeps a 60-character unbroken heading inside the inspector`. #361 (`55295b0`) added `keeps a 60-character heading clear of a fully reachable Close at and above 260px` and left the earlier title in place. The earlier case checks wrap of `heading60` inside the inspector. Close clearance, the 44 by 44 box, and the 260 and 260.5 caps are the later case. This skill cites the later title. A maintain run does not rename the product test.

Recorded after #361 (`55295b0`).

Resolved by renaming the earlier product test to `wraps a 60-character unbroken heading inside the inspector` to match its wrap assertion.
