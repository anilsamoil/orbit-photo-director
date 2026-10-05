---
name: verify-opd
description: Drive the SNAP frontend for Orbit Photo Director in a local browser and prove Queue, Upcoming, Map, ISS view, Profile, Log, help, the status banner, and the service worker. Use when a frontend change needs a user-level check, before shipping map UI, or when asked to verify SNAP locally.
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

One feature is `drive banner`, `drive topbar`, `drive queue`, `drive upcoming`, `drive map`, `drive iss`, `drive help`, `drive profile`, `drive log`, `drive phone`, or `drive tracked`.

Each drive deletes `$OPD_VERIFY_HOME/chrome-profile` before Chrome starts. Pressed buttons and the shot list start over with that profile. Hidden curated targets do not, and neither do personal targets added with the form. The proxy keeps `removedCuratedIds` and `personalTargets` until `down`. A fresh Chrome loads that list from `GET /api/browser/profiles/anil/targets` at boot and hides those cards before any click. Run `down`, then `up`, before a drive that expects every fixture card. A second `drive all` on the same proxy inherits the hides from the first. Inside one drive, Hide writes `removedCuratedIds` on localStorage `opd-profile-anil` and PUTs that list. The upcoming step reloads the same Chrome, checks that the card stays hidden, then opens a second Chrome profile and checks that the card is already hidden. Restore on Profile PUTs the shorter list. A third Chrome profile then shows the restored card. The queue and map steps also wait until that GET contains the id they hid.

The service worker is a separate command because Vite dev does not emit `sw.js`:

```bash
node .cursor/skills/verify-opd/scripts/opd-verify.mjs sw
```

`sw` deletes any previous `evidence/service-worker.txt`, builds the frontend into `$OPD_VERIFY_HOME/preview-dist`, serves those files on port 41733 from the same process, and runs `scripts/verify-sw-upgrade.sh` against that origin. It does not use the dev server from `up`. The static server sends `application/javascript` for `.js`, which `verify-sw-upgrade.sh` requires. Vite preview sends `text/javascript`, so this command does not use it. A pass writes the proof file with the origin and the time. A failed run leaves no proof file.

The map drive opens `/?e2e`. That query is how `frontend/src/map/adapters/maplibre/index.ts` publishes `window.__opdMap`. The map opens with the chrome hidden. The script checks that `#map-chrome-toggle` reads `Controls`, that the Show toolbar and the Time strip (`.map-command`) are `display: none`, shows the chrome, reloads to prove `opd-map-chrome` is `shown`, hides it, reloads to prove `hidden`, then shows the chrome again. Once the chrome is shown, the canvas still meets `#map-pane` with a 0px gap and `.map-command` lies on that canvas. Its computed background is `rgba(16, 22, 28, 0.55)`, so the ground shows through. T+45 moves the readout off Now, and Now returns it. The Show group label is `Show`. The word `Launches` is the label of `#filter-launches-map` and stays inside that button. `evidence/map-show-launches.png` is that button. The map ? button and the (i) credit button stay hidden. `#map-chrome-toggle` is 88px by 44px, `right: 12px` from `#map-pane`, and does not move between `Controls` and `Hide`. The script then frames a pin and clicks the canvas with a real mouse event. Those clicks unwrap longitude toward the map center before `project`. The dropped-pin right-click is projected while that popup still holds the inspector open. `elementFromPoint` at that point is the canvas, including on iPhone 13, where a narrow inspector yields so the bottom sheet does not cover the pin. The (i) credit control stays hidden. It also checks the Anil's targets legend swatch and, after the launch dialog, hides Verify Reef and requires that id to leave the targets source. It then opens the profile menu from Queue, switches to Jessica Watkins (Watty), and switches back to Anil from the first menu row. Queue is restored on Watkins. Map is restored on Anil, `u=watkins` is gone, the legend reads `Anil's targets`, and Lafayette is absent from `my-targets`. On Watkins the legend reads `Jessica Watkins (Watty)'s targets` and `my-targets` has her 12 sites. iPhone 17 Pro repeats that round trip in landscape.

`drive tracked` taps `Controls` when the legend is hidden, then reads the Starship legend. The default fixture shows `Starship: no public orbit yet` and draws no diamond. `OPD_VERIFY_TRACKED=elements` on `up` draws the diamond and `sat-track-layer-starship` from the first SupGP Starlink, labeled Starship. `OPD_VERIFY_TRACKED=aged_out` shows `Starship: public orbit expired`. `OPD_VERIFY_TRACKED=lookup_failed` shows `Starship: orbit lookup failed`. `OPD_VERIFY_TRACKED=missing` omits the artifact and the legend falls back to the no-orbit sentence. A mode change needs `down`, then `up`. `drive all` uses whatever fixture `up` already published, and its tracked step is the no-orbit row unless that variable was set.

`drive banner` sets the cookie `opd-verify-tle=stale` and reloads before the held sign-in step. The proxy then points the manifest track entry at `v/verify/track-stale.json` with `tle_age_hours` 72 and that body's sha256. The footer contains `TLE 72h old — live track may drift` and the class `banner-orange`. The script waits past one countdown tick and requires that same sentence to stay. It clears the cookie and reloads the fresh-age footer. `evidence/banner-tle.png` is that orange footer. A proxy started before this cookie existed needs `down`, then `up`.

`drive banner` also sets the cookie `opd-verify-session=expired` and reloads. The proxy then serves a manifest whose `generated_at` is 200 minutes ago, and `GET /api/app` redirects. The footer starts with `SIGN IN AGAIN`. The script waits past one countdown tick, rejects the next manifest fetch, fires `visibilitychange`, and requires that same sentence to stay. A click on the footer opens `/api/app` with `u=anil`. The script clears the cookie and reloads the signed-in app before the next feature. `evidence/banner-hold.png` is that footer. The boot deny footer (`Please sign in again`, Sign in, Reload) is a different hold. `init` returns before the countdown on that one.

`drive queue` presses Mine, which writes `opd_target_filter_v1=mine` and `opd_queue_filter_v1=mine`. Upcoming and the map follow that shared key. Launches writes only `opd_queue_filter_v1=launches` and leaves `opd_target_filter_v1` at `mine`. All then writes both keys to `all`. The same drive hides Verify Delta while Verify Reef remains, and `#empty` stays hidden. It then hides Verify Reef. On that click `#empty` shows `No passes in the next 90 minutes.` The script scrolls `#empty` into view before `evidence/queue-empty.png`. The shot has to show that sentence. The script then restores Verify Reef and leaves Verify Delta hidden, so the map step can hide Reef itself.

`drive iss` selects the fixture launch from the menu beside Telemetry soon after the surface starts. The pad coordinates are frozen at `up`. The menu starts at `Choose launch`. The card names the launch and the site, a launch window or a tentative NET, and one visibility line. The drive presses the menu and waits until the on-screen UTC second changes. The same option and the same launch are still selected. Desktop Chrome sees the menu open on the press and closes it about 120ms later, before that second. This Playwright WebKit build rejects the `:open` selector, so the phone and iPad passes do not report a painted-open menu. A menu that stays painted open across the tick is not live-forced. `None` clears the pad and the card. A reload returns the menu to `Choose launch`. The site button reads `Look toward` and the site name. `evidence/iss-launch-site.png` is that button. After the pad press, the drive sets `opd-verify-launch=hold`. The proxy publishes `verifyrev-hold`, half a second newer, and parks the body. While that request is parked, the menu stays on the selected launch and the card does not say the launch is gone. The drive then releases the body, which has no launches. The menu returns to `Choose launch` and the card keeps `Selected launch is no longer available` outside the Earth frame. `evidence/iss-launch-lost.png` is that card. The cookie then becomes `back`. The proxy publishes `verifyrev-back`, two seconds newer, with Verify Ascent again. The menu stays on `Choose launch` and the card keeps that sentence. Publishing the launch again does not restore the choice. The cookie stays on `back` so the later reload in that browser accepts the pointer. The 44px hit area on the gold pin and a menu that stays painted open across a tick are named from source and are not live-forced. The still-downloading pointer is live-forced.

`drive iss` also reads `Expedition 75 Beta Edition` on `[data-iss-edition]`, a paragraph off the Earth frame. On a window wider than 720px it sits under the toolbar `?` (Keyboard shortcuts), not under Horizon or Straight down. At 720px and below it is the last toolbar row. `evidence/iss-edition.png` is that line. The 874 by 402 landscape step keeps that rule for its width and does not scroll with telemetry open. `evidence/iss-landscape-telemetry.png` is that pane. The four lines under the UTC clock stay as they are. They match that UTC instant after the second changes and after Straight down. Houston is `America/Chicago` as `HH:MM:SS` with `CDT` or `CST`. The GMT day is `GMT` plus three digits and no space. The date line is the GMT day and a short month, like `4 oct`. The weekday is a full name. Those four lines are text: the clock block ignores pointer events, and each line box is shorter than 44px. The map Time strip does not move them. The cookie `opd-verify-tle=missing` serves the fixture track with no element set. The card then contains `Orbit unavailable` and all five clock texts are empty. The drive clears that cookie and reloads before the next feature. A proxy started before this cookie existed needs `down`, then `up`.

After Straight down is stored, `drive iss` opens `#profile-menu`, focuses the frame, and presses Escape. The menu closes. Straight down stays pressed and both `opd-iss-aim` strings stay. `evidence/iss-profile-menu.png` is the open menu.

`drive help` checks the map ? button and the (i) credit button are hidden, then opens the ? dialog from Queue and requires the section `Aiming the ISS view` to name `n / N`, `W, A, S, and D`, `#iss=`, the Launch line (`The Launch menu sits beside Telemetry`, `None clears it.`), a pad beside Telemetry, about 18°, a gold pin, an edge arrow, and a gold path only when that launch includes a trajectory. The dialog text has no `Reset`, no `double-tap`, and no `Horizon opens first`.

Every `drive` command, including `drive all` and a single feature, runs the selected steps on desktop Chrome and then the same steps on WebKit `iPhone 13`, `iPhone 17 Pro`, and `iPad Pro 11`, unless `OPD_VERIFY_SURFACE` names one of `desktop`, `iphone-13`, `iphone-17-pro`, or `ipad-pro-11`. One value is one process. A combined process that fails with `page.goto: WebKit encountered an internal error` inside `proveHeldSignIn` is not the surface verdict. Each of those devices starts its own WebKit process. The descriptors live in `scripts/webkit-devices.mjs`. iPhone 17 Pro is a 402 by 874 CSS viewport at DPR 3, because Playwright has no built-in iPhone 17 Pro descriptor. iPhone 13 and iPhone 17 Pro run as a standalone home-screen app (`navigator.standalone`). iPad Pro 11 runs as a browser tab. Each device pass clears the fixture profile lists first, so Hide can run again. Desktop does not clear them. After the signed-in steps, each device opens a denied session (`opd-verify-session=deny`, HTTP 401). That pass requires Sign in and Reload on the footer, proves `elementFromPoint` at each control's center is that control, taps one of them through to `/api/app` (keeping `?u=` when the page has it), and checks the rating queue is still in localStorage. Device shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`, including `banner-auth.png`. Each surface rewrites the launch fixture clock so `valid_until` stays inside the 15-minute schema cap for that surface. Target coordinates stay the ones from `up`.

`drive phone` uses a 390x844 portrait viewport and then an 844x390 landscape viewport. It checks 44px targets, that the map ? button and the (i) credit button are hidden, that the hide control stays 88 by 44 and 12px from the right of `#map-pane`, and that a long press on a whole-degree point keeps the pin popup open through the following click. Popups are closed before that press. The click that dismisses the popup is on the dropped pin. Below zoom 6 the pin snaps to whole degrees, so the press uses the rounded point. `drive all` includes this pass and restores the 1400x900 viewport afterwards. When Chrome accepts a safe-area override, the top bar padding includes it. Stdout says `safe-area applied` or `safe-area unsupported`.

`frontend/scripts/verify-map-pins.mjs` rewrites product source and runs unit tests. Do not run it from this skill. `frontend/scripts/verify-popup-scroll.mjs` drives a synthetic popup page, not SNAP. The live popup proof is `drive map`.

## Evidence

Screenshots and the service-worker pass stamp go to `$OPD_VERIFY_HOME/evidence`, which defaults to `/tmp/opd-verify/default/evidence`. Capture the action and the next screen. A screenshot of the final tab alone does not prove the click.

Browser proof is a PNG plus the script's stdout line for that feature. Service-worker proof is `evidence/service-worker.txt` and a zero exit from `scripts/verify-sw-upgrade.sh`. A shoot is proved twice: the toast on the queue card, and the same target on the Log tab. An added profile target is proved by the name appearing in the profile list. The pane paints the name before the POST returns.

The fixture answers `/manifest.json`, versioned artifacts, `/launch/latest.json`, `/api/browser/session`, `/api/kp`, `/api/log`, and `/api/browser/profiles/anil/targets`. Map tiles, the sun image, and a live CelesTrak TLE are real network calls. If CelesTrak is unreachable, the fixture uses the 2026-09-27 ISS TLE in `scripts/fixtures.mjs`. Photo lookup on the Profile tab collects the last-good TLE in localStorage `opd-iss-tle-last-good`, the satellite cache `opd-tle-25544`, the published track, and the bundled element set in `frontend/src/iss-tle.ts`. It uses the candidate that still propagates and whose epoch is closest to the photo time. If none propagate, it asks once for the ISS set, from that 6 hour cache or from CelesTrak, and retries only when the set is not stale. When every candidate fails SGP4, the result line says `orbit data is out of date, reconnect to refresh`. A timestamp that still propagates shows a confidence chip and `ISS at`. The chip is `high confidence` under 24 hours from the chosen epoch, `medium confidence` under 72 hours, and `low confidence` after that. That sentence is not on the top bar. `drive profile` checks a last-good element set whose epoch matches the photo time, then resolves `2035-06-01T00:00:00.000Z` and accepts either the low-confidence chip or the stale result line. `doctor` still passes on the fallback.

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
