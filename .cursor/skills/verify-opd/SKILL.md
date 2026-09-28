---
name: verify-opd
description: Drive the SNAP frontend for Orbit Photo Director in a local browser and prove Queue, Upcoming, Map, Profile, Log, help, the status banner, and the service worker. Use when a frontend change needs a user-level check, before shipping map UI, or when asked to verify SNAP locally.
---

# Verify SNAP

SNAP is the browser app in `frontend/`. This skill starts an isolated Vite server, serves a disposable shot queue at the manifest boundary, and drives the page the way an astronaut would. Read `features/README.md` before a drive, then follow one feature file.

The live site `https://map.astroanil.dev` sits behind Cloudflare Access. An unauthenticated request is not the app. Do not point this skill at that URL. `scripts/verify-sw-upgrade.sh` in the repo root is for a preview build this skill starts, or for an origin that answers without Cloudflare Access. The script sends no Access headers.

## Launch

From the repo root:

```bash
node .cursor/skills/verify-opd/scripts/opd-verify.mjs up
```

The command writes fixtures, checks the launch artifact against `frontend/src/launch-schema.ts`, starts Vite, and starts a proxy in front of it. Ready means `doctor` prints `ok` and `GET /manifest.json` returns JSON with a `version`.

One instance per `OPD_VERIFY_HOME`. The default home is `/tmp/opd-verify/default`. A second run sets a different home and `OPD_VERIFY_PORT`. The default ports are `41731` for the proxy and `41732` for Vite. The browser talks only to the proxy.

`up` is safe to repeat. A healthy instance is reused, and reuse does not rebuild fixtures. A dead pid is replaced. If the launch fixture's `valid_until` has passed, `doctor` fails. Run `down`, then `up`.

The command needs `bun`, installed `frontend/node_modules`, `lsof`, Chrome, and Playwright WebKit. Set `OPD_VERIFY_CHROME` when `google-chrome` is not on `PATH`. Install WebKit from `frontend` with `npx playwright install --with-deps webkit`. A drive fails when WebKit is missing. It does not skip the device pass. The drive uses the Node `WebSocket` global. Node 22 has it.

The proxy signs the browser in as profile `anil` with display name `Anil`. That identity is a fixture. It is not a Google session. The fixture names are `Verify Reef`, `Verify Delta`, `Verify Mesa`, `Verify Keepsake`, and `Verify Ascent`. Reef and Delta are Queue cards. Mesa is an Upcoming card. Keepsake is the Cupola window. Ascent is the launch.

## Doctor

```bash
node .cursor/skills/verify-opd/scripts/opd-verify.mjs doctor
```

Run this before the first drive and again after any drive that fails. It checks that the proxy and Vite pids from this home are alive, that those pids own the ports, that `/` is the SNAP page, that `/manifest.json` has a version, and that the launch fixture has not expired.

## Drive

Open the feature file and run its command. A full browser pass is:

```bash
node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive all
```

One feature is `drive banner`, `drive topbar`, `drive queue`, `drive upcoming`, `drive map`, `drive help`, `drive profile`, `drive log`, `drive phone`, or `drive tracked`.

Each drive deletes `$OPD_VERIFY_HOME/chrome-profile` before Chrome starts. Pressed buttons and the shot list start over with that profile. Hidden curated targets do not, and neither do personal targets added with the form. The proxy keeps `removedCuratedIds` and `personalTargets` until `down`. A fresh Chrome loads that list from `GET /api/browser/profiles/anil/targets` at boot and hides those cards before any click. Run `down`, then `up`, before a drive that expects every fixture card. A second `drive all` on the same proxy inherits the hides from the first. Inside one drive, Hide writes `removedCuratedIds` on localStorage `opd-profile-anil` and PUTs that list. The upcoming step reloads the same Chrome, checks that the card stays hidden, then opens a second Chrome profile and checks that the card is already hidden. Restore on Profile PUTs the shorter list. A third Chrome profile then shows the restored card. The queue and map steps also wait until that GET contains the id they hid.

The service worker is a separate command because Vite dev does not emit `sw.js`:

```bash
node .cursor/skills/verify-opd/scripts/opd-verify.mjs sw
```

`sw` deletes any previous `evidence/service-worker.txt`, builds the frontend into `$OPD_VERIFY_HOME/preview-dist`, serves those files on port 41733 from the same process, and runs `scripts/verify-sw-upgrade.sh` against that origin. It does not use the dev server from `up`. The static server sends `application/javascript` for `.js`, which `verify-sw-upgrade.sh` requires. Vite preview sends `text/javascript`, so this command does not use it. A pass writes the proof file with the origin and the time. A failed run leaves no proof file.

The map drive opens `/?e2e`. That query is how `frontend/src/map/adapters/maplibre/index.ts` publishes `window.__opdMap`. Credits start collapsed to the 44x44 (i) button (`collapseAttribution` in that file). The script checks the collapsed button, opens the credit line, then frames a pin and clicks the canvas with a real mouse event. It also checks the Anil's targets legend swatch and, after the launch dialog, hides Verify Reef and requires that id to leave the targets source.

`drive tracked` reads the Starship legend. The default fixture shows `Starship: no public orbit yet` and draws no diamond. `OPD_VERIFY_TRACKED=elements` on `up` draws the diamond and `sat-track-layer-starship` from the first SupGP Starlink, labeled Starship. `OPD_VERIFY_TRACKED=aged_out` shows `Starship: public orbit expired`. `OPD_VERIFY_TRACKED=lookup_failed` shows `Starship: orbit lookup failed`. `OPD_VERIFY_TRACKED=missing` omits the artifact and the legend falls back to the no-orbit sentence. A mode change needs `down`, then `up`. `drive all` uses whatever fixture `up` already published, and its tracked step is the no-orbit row unless that variable was set.

Every `drive` command, including `drive all` and a single feature, runs the selected steps on desktop Chrome and then the same steps on WebKit `iPhone 13`, `iPhone 17 Pro`, and `iPad Pro 11`. The descriptors live in `scripts/webkit-devices.mjs`. iPhone 17 Pro is a 402 by 874 CSS viewport at DPR 3, because Playwright has no built-in iPhone 17 Pro descriptor. iPhone 13 and iPhone 17 Pro run as a standalone home-screen app (`navigator.standalone`). iPad Pro 11 runs as a browser tab. Each device pass clears the fixture profile lists first, so Hide can run again. Desktop does not clear them. After the signed-in steps, each device opens a denied session (`opd-verify-session=deny`, HTTP 401). That pass requires Sign in and Reload on the footer, proves `elementFromPoint` at each control's center is that control, taps one of them through to `/api/app`, and checks the rating queue is still in localStorage. Device shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`, including `banner-auth.png`. Each surface rewrites the launch fixture clock so `valid_until` stays inside the 15-minute schema cap for that surface. Target coordinates stay the ones from `up`.

`drive phone` uses a 390x844 portrait viewport and then an 844x390 landscape viewport. It checks 44px targets, that the control dock stays above the (i) and ? buttons while the credits are collapsed and again while they are expanded, and that a long press on a whole-degree point keeps the pin popup open through the following click on that pin. Below zoom 6 the pin snaps to whole degrees, so the press uses the rounded point. `drive all` includes this pass and restores the 1400x900 viewport afterwards. When Chrome accepts a safe-area override, the top bar padding includes it. Stdout says `safe-area applied` or `safe-area unsupported`.

`frontend/scripts/verify-map-pins.mjs` rewrites product source and runs unit tests. Do not run it from this skill. `frontend/scripts/verify-popup-scroll.mjs` drives a synthetic popup page, not SNAP. The live popup proof is `drive map`.

## Evidence

Screenshots and the service-worker pass stamp go to `$OPD_VERIFY_HOME/evidence`, which defaults to `/tmp/opd-verify/default/evidence`. Capture the action and the next screen. A screenshot of the final tab alone does not prove the click.

Browser proof is a PNG plus the script's stdout line for that feature. Service-worker proof is `evidence/service-worker.txt` and a zero exit from `scripts/verify-sw-upgrade.sh`. A shoot is proved twice: the toast on the queue card, and the same target on the Log tab. An added profile target is proved by the name appearing in the profile list. The pane paints the name before the POST returns.

The fixture answers `/manifest.json`, versioned artifacts, `/launch/latest.json`, `/api/browser/session`, `/api/kp`, `/api/log`, and `/api/browser/profiles/anil/targets`. Map tiles, the sun image, and a live CelesTrak TLE are real network calls. If CelesTrak is unreachable, the fixture uses the 2026-09-27 ISS TLE in `scripts/fixtures.mjs`. Photo lookup on the Profile tab collects the last-good TLE in localStorage `opd-iss-tle-last-good`, the satellite cache `opd-tle-25544`, the published track, and the bundled element set in `frontend/src/iss-tle.ts`. It uses the candidate that still propagates and whose epoch is closest to the photo time. If none propagate, it asks once for the ISS set, from that 6 hour cache or from CelesTrak, and retries only when the set is not stale. When every candidate fails SGP4, the lookup chip says `orbit data is out of date, reconnect to refresh`. A timestamp that still propagates shows `low confidence — TLE age ...` plus `ISS at`. That sentence is not on the top bar. `drive profile` checks a last-good element set whose epoch matches the photo time, then resolves `2035-06-01T00:00:00.000Z` and accepts whichever of those two chips the page shows. `doctor` still passes on the fallback.

## Cleanup

```bash
node .cursor/skills/verify-opd/scripts/opd-verify.mjs down
```

`down` signals the proxy pid, the Vite pid, and a Chrome pid this run recorded. It removes the Chrome profile and `state.json`. It leaves `$OPD_VERIFY_HOME/evidence` in place. Confirm a screenshot path still exists after `down` before you treat the run as finished.

Do not kill Chrome or Node by name. A failed drive should still end in `down` if you are done with the instance, or in another `doctor` if you will drive again.

## Helpers

The executable entry is `.cursor/skills/verify-opd/scripts/opd-verify.mjs`. It loads `fixtures.mjs` and `drive.mjs` from that same directory. Invoke only `opd-verify.mjs`. The repo-root script this skill calls is `scripts/verify-sw-upgrade.sh`.

```bash
node .cursor/skills/verify-opd/scripts/opd-verify.mjs up
node .cursor/skills/verify-opd/scripts/opd-verify.mjs doctor
node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive all
node .cursor/skills/verify-opd/scripts/opd-verify.mjs sw
node .cursor/skills/verify-opd/scripts/opd-verify.mjs down
node .cursor/skills/verify-opd/scripts/opd-verify.mjs check
```

`check` confirms every feature file is linked from `features/README.md`, uses the four headings below, and names both iPhone and iPad. Run it after editing the map. A feature file that omits iPhone or iPad fails `check`.

## Feature map

`features/README.md` is the index. Each feature file has four headings, in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with opd-verify`, `Gotchas`.

## Maintenance

When the app changes, run `/maintain-verification-skill` so the map stays aligned with the page. A behavior the app no longer has is either a map fix or a product bug. Report the bug. Do not change product code from this skill.
