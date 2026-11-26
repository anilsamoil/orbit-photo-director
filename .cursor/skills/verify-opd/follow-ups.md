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

## Deferred: hosted verification wording still says pending (W-02)

`docs/ios/STATUS.md` line 9 says W-01 hosted verification is pending. `docs/ios/W-01-VERIFICATION.md` line 3 says the hosted workflow, simulator launches, and downloadable artifacts are pending CI. #381 (`26746c9e51b523c0dca4efb25ad7cf5c71429ee2`) is the commit those sentences describe. Updating the sentences is W-02. This skill does not edit `docs/ios/`.

Recorded after #381 (`26746c9e51b523c0dca4efb25ad7cf5c71429ee2`).

## Verification gap: the merge-SHA iPad launch PNG is white

`iOS unsigned` run `45877212976` on `26746c9e51b523c0dca4efb25ad7cf5c71429ee2` succeeded for `SNAP simulator launch (iPad Pro 11-inch (M5))`. The log ends with `** TEST SUCCEEDED **`, and the export step accepts the nonempty file `4DDD39AA-3505-497C-A09C-3B882C0BF88D.png`. That PNG is 1668 by 2420 and the center pixel is white. The heading is absent. The iPhone PNG from the same run shows `SNAP placeholder ready` on the dark page. The pull-request run `45870433702` attached an iPad PNG that shows the placeholder. The workflow does not read the pixels. This skill does not rerun the job and does not edit the test.

Recorded after #381 (`26746c9e51b523c0dca4efb25ad7cf5c71429ee2`).

## Deferred: template code-sign identity in the Xcode project (W-02)

`app/ios/App/App.xcodeproj/project.pbxproj` line 248 sets `CODE_SIGN_IDENTITY = "iPhone Developer"` on the Debug project configuration. The Release project configuration carries the same template string. The hosted test passes `CODE_SIGNING_ALLOWED=NO`, `CODE_SIGNING_REQUIRED=NO`, and `CODE_SIGN_IDENTITY=''`. The project has no `DEVELOPMENT_TEAM`. Replacing the template identity is W-02. This skill does not edit the project.

Recorded after #381 (`26746c9e51b523c0dca4efb25ad7cf5c71429ee2`).

## Resolved

### Product gap: the wrap case still uses the old 60-character title

`frontend/test/pass-row-fit.test.ts` line 315 is still `keeps a 60-character unbroken heading inside the inspector`. #361 (`55295b0`) added `keeps a 60-character heading clear of a fully reachable Close at and above 260px` and left the earlier title in place. The earlier case checks wrap of `heading60` inside the inspector. Close clearance, the 44 by 44 box, and the 260 and 260.5 caps are the later case. This skill cites the later title. A maintain run does not rename the product test.

Recorded after #361 (`55295b0`).

Resolved by renaming the earlier product test to `wraps a 60-character unbroken heading inside the inspector` to match its wrap assertion.
