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
