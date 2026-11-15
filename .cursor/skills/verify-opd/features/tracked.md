# Tracked vehicles

#366 (`037dc1f`) draws Starship from a CelesTrak element set. Satellites, then the Starship checkbox. The checkbox starts checked. The legend still has no Starship row. A published set draws a red diamond, class `tracked-marker`, labeled Starship, and a dotted one-orbit track `sat-track-layer-tracked:starship`. The ISS marker and `iss-track-layer` stay. The two markers are on the map together.

The lookup is the names `STARSHIP` and `SHIP` on Supplemental GP and GP. There is no hard-coded catalog number and no hard-coded COSPAR id. A name matches `^STARSHIP(?:[\s-]|$)` or `^SHIP[\s-]+\d+\b`, case insensitive, and a name with `DEB` does not. `STARSHIP FLIGHT 16` and `SHIP 40` match. `STARLINK`, `STARSHIELD`, `FRIENDSHIP`, `SPACESHIP`, and `DEB` do not.

## Sub-features

- `tracked-fresh` draws the orbit with no age label while the epoch is 12 h old or less. `STARSHIP_FRESH_HOURS` is 12.
- `tracked-stale` still draws when the epoch is over 12 h and at most 72 h. The picker badge is `stale orbit`. The line is `stale orbit, epoch N h old`, and N is whole hours, truncated (`Math.floor`). `STARSHIP_GRACE_HOURS` is 72. Past 72 h the set is dropped.
- `tracked-reentry` drops a set at any age once perigee is under 80 km and more than one period has passed since the epoch. A suborbital set still draws for its first revolution.
- `tracked-none` shows `no public orbit yet` when the feeds answer empty. A failed fetch with no cache shows `orbit lookup failed` and draws nothing. Offline, a last-good set inside the grace stays on the map.
- `tracked-lookup` is the row's own `lookup` in `tracked.json`: `max_age_hours` and `grace_hours`. The browser honours that row. The same two numbers are `STARSHIP_FRESH_HOURS` and `STARSHIP_GRACE_HOURS` in `frontend/src/tracked.ts` and `generator/tracked.py`.

## How to get to it (user POV)

- Open Map on iPhone or iPad, or on the desktop window. Show the chrome. Tap the satellite button.
- Starship is checked. When CelesTrak has a set, the red diamond and the dotted track are already on the map, beside the ISS marker.
- Over 12 h and up to 72 h, the row reads `stale orbit, epoch N h old`. That is a rough position, not a mark to frame a shot on. Along-track SGP4 error is about 23 km at 24 h, 91 km at 48 h, and 206 km at 72 h for B* = 1e-4, and up to about 2100 km at 72 h for B* = 1e-3.
- An empty feed says `no public orbit yet`. A failed fetch with nothing cached says `orbit lookup failed`.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- One process is one viewport. Do not run `drive all`.
- Tile requests use the stub in `isolateSnapRequests` (`scripts/context-state-fixture.mjs`): an image or a WMTS URL gets a 1 pixel PNG, and every other host outside the local origin is aborted. Do not point NASA hosts at `127.0.0.1`. A connection-refused GIBS answer makes WebKit mount the ISS marker and track only after more than 45 s, on this tree and on main `18a38bd`, and `drive map` then times out at `map ready`. That is known Safari slowness on a bad network. It is not a verification failure. Do not fetch NASA tiles, and do not fetch `map.astroanil.dev` or `map.expedition75.com`.

The fictional sets are `frontend/test/fixtures/celestrak-starship-fictional.txt` (`SHIP 91`, `SHIP 92`, debris, Starlink, and the rest). `frontend/test/satellites.test.ts` and `tests/test_tracked.py` stub CelesTrak with those lines. `SHIP 92` is the reentry case.

The diamond is placed by `liveIssPositionSGP4` in `frontend/src/iss-sgp4.ts`. Python uses `Satrec.twoline2rv` in `generator/orbit.py`. The cross-check is `frontend/test/iss-sgp4.test.ts`, `matches the Python SGP4 ground truth within 0.01° at every fixture point`, against `sgp4_truth` in `frontend/test/fixtures/iss-sgp4-fixture.json`.

```bash
cd frontend && bun run test test/satellites.test.ts test/tracked.test.ts src/map/features/satellites/satellites.test.ts test/map-satellites-contract.test.ts test/iss-sgp4.test.ts
python3 -m pytest tests/test_tracked.py -q
```

These go red if the fresh or grace constants move, if the stale line changes, if a reentered set inside the grace is kept, or if a failed fetch with no cache is treated as a miss:

- `is 12 h and 72 h, as the publisher has them`
- `a drawn orbit past its fresh window says stale orbit and the epoch age`
- `drops a last good set that reenters inside the grace`
- `an outage with no last good set is a failed lookup, not a miss`
- `test_starship_is_fresh_for_12_h_and_kept_as_last_good_for_72_h`
- `test_a_cached_set_that_reenters_inside_the_grace_is_dropped`

`frontend/scripts/verify-map-pins.mjs` pins `a CelesTrak request that fails is a failed lookup, not a miss`. Do not run that mutator while editing this skill. It rewrites product source. #370 (`d9516ca`) re-anchored the six `frontend/src/satellites.ts` finds and added two contracts: `showing a launch collapses its expanded brief before refresh` and `hiding a selected ascent clears its geometry and caption`. The file has 51 anchors. A scan of those find strings against current source reports 0 missing, so a run reports 0 `STALE` and 51 `pinned`.

The device pass is one WebKit context created at the size. It publishes fictional `SHIP 91` at 13 h, so the badge reads `stale orbit`, and it frames the ISS marker and the Starship diamond together.

```bash
OPD_VERIFY_VIEWPORT=402x874 node .cursor/skills/verify-opd/scripts/starship-orbit.mjs
OPD_VERIFY_VIEWPORT=874x402 node .cursor/skills/verify-opd/scripts/starship-orbit.mjs
OPD_VERIFY_VIEWPORT=1024x768 node .cursor/skills/verify-opd/scripts/starship-orbit.mjs
OPD_VERIFY_VIEWPORT=1180x820 node .cursor/skills/verify-opd/scripts/starship-orbit.mjs
OPD_VERIFY_VIEWPORT=834x1210 node .cursor/skills/verify-opd/scripts/starship-orbit.mjs
OPD_VERIFY_VIEWPORT=1440x900 node .cursor/skills/verify-opd/scripts/starship-orbit.mjs
```

iPhone is 402 by 874 and 874 by 402. iPad is 1024 by 768, 1180 by 820, and 834 by 1210. Desktop WebKit is 1440 by 900. `1180x820` is not an allowed `drive map` viewport. This script accepts it. Physical iPad Safari is unverified.

Stdout is `starship orbit <WxH> iss 1 starship 1 stale "stale orbit, epoch 13 h old" hits 0`. Shots are `evidence/starship-orbit-<WxH>.png`.

`drive tracked` on the default fixture still expects no Starship diamond and no legend row. `OPD_VERIFY_TRACKED=elements` still publishes a stand-in TLE, and that drive still looks for `sat-track-layer-starship`. The layer id is now `sat-track-layer-tracked:starship`. Use `starship-orbit.mjs` for the orbit.

## Gotchas

- The stale label is not a framing aid. The along-track figures above are the reason.
- `frontend/scripts/verify-map-pins.mjs` has 51 anchors and the six `frontend/src/satellites.ts` finds match the current guards. A `STALE` or `UNPINNED` line is a real failure. Do not run the mutator from this skill.
- A hosts-file blackhole of `gibs.earthdata.nasa.gov` to `127.0.0.1` is connection refused. WebKit then takes more than 45 s to mount the ISS marker and track. `drive map` times out at `map ready`. Stub the tile with `isolateSnapRequests` instead.
- The built-in Starship lookup has names and patterns only. A row may also carry `catnr` or `intldes`, and the browser will use them, but the published Starship search does not hard-code either.
- Fresh includes the instant at 12 h. The stale label starts once the age is over 12 h. The grace includes the instant at 72 h. The next millisecond is dropped.
- `drive map` and `drive all` do not open this probe. There is no `drive all` form of it.
