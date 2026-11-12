# Night lights

`#toggle-night-lights` is the city-lights button in the map dock, beside the terminator. It is off until clicked. #357 (`0d1fdcce`) keeps that overlay on the night side of a static 2016 VIIRS composite. The button title is the operator-facing line: `Night-side city lights — static 2016 VIIRS composite (off by default)` in `frontend/index.html`, `Show night-side city lights (static 2016 VIIRS composite)` while off, and `Night-side city lights — static 2016 VIIRS composite; click to hide` while on (`reflectButton` in `frontend/src/map/features/night-lights/index.ts`). The raster source credit in `buildStyle` is `Night lights: NASA GIBS VIIRS Black Marble (static 2016)`.

`drive map` only waits until `#toggle-night-lights` has class `active`. That click is not this proof. Do not fetch `gibs.earthdata.nasa.gov` or any other NASA tile host. The proofs below use the vitest doubles and synthetic bytes already in the repo.

From `frontend`:

```bash
bun run test \
  src/map/features/night-lights/night-lights.test.ts \
  src/map/features/terminator/terminator.test.ts \
  src/map/features/lightning/lightning.test.ts \
  test/viirs-alpha.test.ts \
  test/map-night-lights.test.ts \
  test/terminator.test.ts \
  test/map-catalog.test.ts \
  test/map-mount-order.test.ts \
  test/map-render-contract.test.ts \
  test/map-style-contract.test.ts
```

## Night side only

`nightLightsFade` in `frontend/src/night-lights.ts` is a smoothstep. Solar elevation at 0° and in daylight is 0. Elevation of −1.5° is 0.5. Elevation of −3° and darker is 1. `maskNightLightsPixels` in `frontend/src/map/adapters/maplibre/viirs-alpha.ts` uses the same subsolar model as the terminator and does not read whether the terminator guides are visible. A pixel whose sine of elevation is at least 0 has alpha 0. A pixel at or below sine of −3° keeps full alpha. Between those angles the smoothstep scales alpha. `colorNightLightsPixels` paints warm cores: a bright source becomes red 255 with green and blue lifted toward amber, and a navy background (`[4, 5, 15]`) becomes alpha 0. The tile URL stays the 2016 composite; `?night=` is the view instant quantized to a minute.

`frontend/test/viirs-alpha.test.ts` is that proof. `has a smooth twilight shoulder, zero daylight and full night at minus three degrees` checks the fade. `masks both day quadrants and joins the night side across the antimeridian` leaves night alpha at 200 and day alpha at 0 at noon on a z0 tile. `scrubbing twelve hours reverses the lit hemisphere` swaps those quadrants and does not recolor the RGB. `feathers a pixel between 0° and -3° instead of switching it fully on` takes alpha 200 down to 32. `removes the navy background and keeps a dim fringe warm and transparent` and `keeps dim towns visible and bright cores warm, below full opacity` are the warm-core checks. `frontend/test/map-night-lights.test.ts` `keeps the current night-only mask when terminator guides are hidden and time is scrubbed` turns the terminator off and still carries `?night=` on `viirs-night-lights`.

## Zoom 8 over zoom 4

`viirs-night-lights-layer` paint in `frontend/src/map/features/night-lights/layers.ts` is `['interpolate', ['linear'], ['zoom'], 2, 0.95, 4, 0.95, 6, 0.85, 8, 0.74]`. Zoom 4 is the flat 0.95 stop. Zoom 8 is 0.74. `0.74 / 0.95` is about 0.779. `frontend/test/map-night-lights.test.ts` `keeps overview lights vivid while reducing source overzoom glare` pins those stops. The same expression is in `frontend/src/map/features/night-lights/night-lights.test.ts`. `frontend/scripts/verify-map-pins.mjs` mutates the zoom-8 stop from 0.74 to 1 under `night lights preserve overview intensity and restrain high-zoom glare` and that pin must go red. Do not run that mutator while editing this skill.

A Chrome window at 1280 that samples zoom 8 against zoom 4 must wait until the raster tile has painted and the camera has settled. A sample taken during the fade is not the stop ratio. That sample is not this recipe and must not request a real NASA tile. The local ratio is the paint stops above.

## Seam weld and night fill

`terminatorNightPolygonFeatures` in `frontend/src/terminator.ts` builds the night shade in 2° latitude bands, then `weldNightBands` joins rings that share a latitude edge and drops that edge. `frontend/test/terminator.test.ts` `crosses interior 2° band edges inside one polygon` uses `2024-09-22T12:00:00Z`, longitude 150, and each even latitude from −86 to 86. The points 0.2° south and 0.2° north of that latitude belong to the same polygon. `terminator-night-fill-layer` paints `fill-opacity` 0.30 and `fill-antialias` false (`frontend/src/map/features/terminator/layers.ts`). `frontend/src/map/features/terminator/terminator.test.ts` `opens shown, with a line, a night fill, and a subsolar point at the view instant` matches both paint keys, so a leftover edge does not antialias a seam.

## Layer order

`LAYER_ORDER` in `frontend/src/map/map-core/catalog.ts` paints, bottom first, `terminator-night-fill-layer`, then `viirs-night-lights-layer`, then `lightning-layer`, then `iss-track-layer`. The lights-only dim `night-lights-global-dim-layer` sits under the fill. Lightning is absent until `#toggle-lightning` is on, so the first `renderMap` stack in `frontend/test/map-render-contract.test.ts` is fill, then VIIRS, then the ISS track. `frontend/src/map/features/lightning/lightning.test.ts` `paints lightning above night lights and the terminator, and below the ISS and labels` places `lightning-layer` above the fill and VIIRS and below `iss-track-layer`. `frontend/test/map-catalog.test.ts` `places the night overlays under the ISS track and everything else on top, by catalog position alone` requires the dim, the fill, and VIIRS to insert before `iss-track-layer`. `frontend/scripts/verify-map-pins.mjs` moves the ISS track under VIIRS for `night overlays stay below the ISS ground track` and that pin must go red.

## Decode cache

`createViirsAlphaHandler` fetches the raw tile, then runs the decode transform. The LRU stores that 200 body only after the transform resolves, and only when the body is at most 8 MiB (`VIIRS_CACHE_MAX_BYTES`) and the cache stays within 96 tiles. A 200 whose decode throws is not stored. The next request for that tile fetches again. `frontend/test/viirs-alpha.test.ts` `refetches a repaired 200 after a bad 200 fails to decode, on retry and on toggle` stubs two bodies: a bad 200 whose first byte is 9 and whose transform throws `decode failed`, then a good 200 whose first byte is 4. The same tile URL fails, then succeeds, and `fetch` has been called twice. A second tile repeats that pair, so a later show of the overlay also refetches, and `fetch` has been called four times. `does not cache an upstream failure` refetches after a 503. `rejects cancellation after fetch and never caches the aborted response` refetches after an abort that lands before the transform.

## Harness notes

- Before each `drive map-lightning`, run `down`, then `up`. The home `launchValidUntil` is the fixture pointer from `up`: `generated_at` is one minute behind the build and `valid_until` is fourteen minutes after that `generated_at`. A private drive does not extend the home clock. `FIXTURE_RETENTION_MS` in `.cursor/skills/verify-opd/scripts/fixtures.mjs` is 15 minutes. After the home clock passes, `doctor` fails with `launch fixture expired. Run down, then up.`
- `up` finishes by calling `doctor`. `doctor` runs `checkRasterOcr`, which is `raster-ocr.py --doctor`. That probe needs the `tesseract` binary from `tesseract-ocr` on `PATH` (or `OPD_VERIFY_TESSERACT`) and Pillow in the OCR Python. Without tesseract, `up` fails the OCR probe.
- A Chrome 1280 zoom-8 sample must wait for tile paint and for the view to settle before sampling. See the zoom section above.
- The WebKit 820 day-night lightning negative control is a known sampling-race flake. `frontend/scripts/verify-lightning-day-night.mjs` walks Chromium 1440 by 900, then WebKit 820 by 1180, then WebKit 1210 by 834, one browser at a time. `The pixel test detects a removed night-side strike` on WebKit 820 by 1180 can fail once inside that combined run and pass when the command is rerun alone. Rerun `node frontend/scripts/verify-lightning-day-night.mjs` once, with no other WebKit process. If that assertion is still red, treat it as a real failure. Do not edit that script from this skill. Do not run WebKit concurrently.
