# Profile

Profile holds the signed-in astronaut, the distance threshold, personal targets, hidden curated targets, and photo lookup.

## Sub-features

- `profile-identity` shows Anil from the session fixture.
- `profile-threshold` moves the viable distance display to 800 km.
- `profile-add` adds a target named Verify Harbor.
- `profile-hidden` shows Hidden curated targets. Restore removes `verify-mesa` from that list, the GET drops that id, and a new Chrome profile shows the card again.
- `profile-lookup` resolves the fixture timestamp and drops a lookup pin on the map. It then resolves a last-good TLE at that TLE's own epoch, and a 2035 timestamp. A 2035 time that still propagates shows `low confidence — TLE age` and `ISS at`. A 2035 time where every element set fails SGP4 shows `orbit data is out of date, reconnect to refresh`.
- `profile-hydration` is #374 (`c431fc4`). A verified account profile whose name starts with `u-` loads personal targets from `GET /api/browser/profiles/<name>/targets`. A failed read does not latch. The next Profile open, with no reload, fetches again. A distance-slider change during that read keeps the new threshold and the server rows. A local target edit during that read keeps the edit and does not add a server-only row. A signed-out 401 shows `Please sign in again to open your own profile. Your saved data has been kept.` and does not fetch targets. An anonymous `?u=` adoption (`isVerified` false) does not fetch. Crew roster targets remain read-only.
- `profile-roster-link` is #386 (`c65abb2b431f7d042f226bdd0a5ee3b4a7623caf`). `data/crew-roster/roster.json` sets `accountProfile` to `josh` on the Kutryk row only. A verified session whose `profiles` include `josh` shows that account's targets on the Kutryk roster. Watkins and Delaney stay bundled-only. `ACCESS_PROFILE_GRANTS` is an owner step outside this repo. This skill does not set it and does not fetch a public host.

## How to get to it (user POV)

- Choose the Profile tab.
- Photo lookup is the last section of the Profile pane, below the sign-in note. The target form, Your targets, hidden curated targets, CSV import, and JSON backup sit above it. It is not its own tab.
- A crew profile from the top-bar menu has no profile select, no New profile, and no Delete this profile. The site list is `Crew roster sites` and those rows have no Edit and no Add target. `drive map` opens that pane for Jessica Watkins (Watty): 12 sites, including Lafayette. Kutryk and Delaney each have 11 sites in `data/crew-roster/`. This drive checks Watkins.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The track fixture includes a TLE. `up` always writes one.

- **Open Profile.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive profile`. The pane text contains Anil and the distance slider exists. Signed-in Anil has the info text and no New profile or Delete this profile button. The profile select is present only when at least two profiles are authorized. `evidence/profile-picker.png` is that section. The script then sets `opd-verify-session=local`, which makes the session a non-JSON 404, and checks that the no-account picker has the select, New profile, and Delete this profile. Entering `watkins` and choosing New profile shows `Crew roster profiles come with the app.` The select options do not include `watkins`, `kutryk`, or `delaney`. `evidence/profile-picker-local.png` is that section. iPhone 17 Pro repeats both checks in landscape. The cookie is cleared and the signed-in pane is restored before the threshold step.
- **Threshold.** Set the slider to 800. The display reads `800 km`.
- **Add a target.** Enter Verify Harbor with the fixture latitude and longitude, then choose Add target. The profile list contains Verify Harbor.
- **Hidden curated targets.** A `.profile-crud-subhead` in `#profile-body` has text `Hidden curated targets`. The stylesheet uppercases subheads, so `innerText` reads `HIDDEN CURATED TARGETS`. `Your targets` is an earlier subhead of the same class. If `verify-mesa` is not already listed, the script opens Or paste an exact id, enters `verify-mesa`, and chooses Hide. Restore on that chip removes it. The script waits until the GET no longer contains `verify-mesa`, then a new Chrome profile shows Verify Mesa on Upcoming.
- **Lookup.** Paste the timestamp from `fixtures/meta.json` field `lookupTimestamp` and choose Resolve. The result text contains `ISS at` and the view switches to the map with `lookup-pin-layer`. Pin on map repeats that drop.
- **Last-good TLE.** The script writes `opd-iss-tle-last-good` with an element set whose epoch is `2026-09-29T04:10:50.460Z`, resolves that timestamp, and requires `TLE age 0.0 h`. That epoch is closer to the photo time than the published track or the bundled set.
- **2035 lookup.** The script then resolves `2035-06-01T00:00:00.000Z`. The fixture's live CelesTrak set still propagates that far, so the chip is `low confidence — TLE age ...` and the line contains `ISS at`. The bundled 2026-09-27 set does not propagate that far. When every candidate fails SGP4, the line is `orbit data is out of date, reconnect to refresh`. Any other failed lookup says `Calculation failed — TLE may be missing or malformed.` The script accepts the low-confidence chip or the stale sentence.
- **Proof.** `evidence/profile-picker.png`, `evidence/profile-picker-local.png`, `evidence/profile.png`, `evidence/profile-target.png`, `evidence/profile-hidden.png`, `evidence/profile-lookup.png`, `evidence/profile-lookup-map.png`, `evidence/profile-lookup-last-good.png`, and `evidence/profile-lookup-2035.png`.
- **Devices.** Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run these steps. iPhone 17 Pro also repeats the signed-in and local picker checks in landscape. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Hydration on a local Vite server

`drive profile` does not prove #374. One Chromium process, context created at 1440 by 900:

```bash
OPD_VERIFY_VIEWPORT=1440x900 node .cursor/skills/verify-opd/scripts/profile-hydration.mjs
```

The script uses the verify origin and `isolateSnapRequests`. It does not fetch a public host. Identities are synthetic: profile `u-pilot`, display `Pilot Example`, mailbox `pilot@example.com`. The anonymous page is `?u=guest`. No real name is required.

Stub `GET /api/browser/session` and `/api/browser/profiles/<name>/targets` on that local server, or with `page.route` in front of it:

- `401` on the session shows the sign-in sentence in `#status-banner`, leaves `#tab-profile` disabled, and records zero targets requests.
- A non-JSON `404` on the session with `?u=guest` opens Profile and records zero targets requests.
- The first targets read for `u-pilot` returns `503`. Opening Profile retries. The server row `Harbor Example` appears. The document was not reloaded.
- Hold the first targets read, set `#profile-threshold-slider` to 800, and let the 150ms debounce save. Releasing the read keeps `800 km` and `Harbor Example`.
- Seed `opd-profile-u-pilot` with `Harbor Local`. Hold the first read, edit that row to `Harbor Kept`, and save. Releasing a response that also contains `Server Only` leaves `Harbor Kept` on the list and does not add `Server Only`.

Stdout is `profile hydration signed-out 401 sign-in message targets 0`, `profile hydration anonymous ?u= targets 0`, `profile hydration retry reads <n> harbor kept`, `profile hydration slider 800 km harbor kept`, and `profile hydration local edit kept server-only absent`. Shots are `profile-hydration-signed-out.png`, `profile-hydration-anonymous.png`, `profile-hydration-retry.png`, `profile-hydration-slider.png`, and `profile-hydration-edit.png`.

Known issues, not passes: a server target whose name is only whitespace fails `validatePersonalTargetInput` (`name_empty` after trim) and `hydrateUnchangedProfile` returns before adding any row, so that one field blocks the list. `handleAdd` still toasts `after the next hourly update` for a `u-` profile. Do not treat either as a green check.

## Josh roster link on a local Vite server

Use the verify origin and `isolateSnapRequests`. Create a fresh Chromium context with service workers blocked for each case. Before navigation, stub `GET /api/browser/session` and record all requests to `/api/browser/profiles/josh/targets`.

Use this synthetic viewer in the session responses.

```json
{"name":"test-viewer","displayName":"Fixture Viewer"}
```

In both cases, open `/?e2e` without a `u` parameter. Open the top-bar profile badge and choose **Josh Kutryk** (`#profile-menu [data-profile="kutryk"]`). Wait for `u=kutryk`, then open **Profile**.

### Viewer with the grant

1. Return HTTP 200 with `ok: true`, the synthetic viewer in `profile`, and both the viewer and `{"name":"josh","displayName":"Fixture Account"}` in `profiles`.
2. Return HTTP 200 on the linked GET with this body.

   ```json
   {"targets":[{"id":"personal:josh:fixture-ridge","name":"Fixture Ridge","lat":12.5,"lon":24.5,"priority":5,"createdAt":"2026-11-16T12:00:00Z"}]}
   ```

3. Follow the top-bar steps. Verify that **Crew roster sites** lists 11 bundled sites. Check that **Josh Kutryk’s account profile** lists **Fixture Ridge** without an edit button.
4. Open **Map**. Pan and zoom to the fixture coordinates. With `?e2e`, you can use `window.__opdMap.jumpTo({ center: [24.5, 12.5], zoom: 4 })`. Wait for the ring on `my-targets-layer`, then click it.
5. Check that the popup shows **Fixture Ridge** and **From Josh Kutryk’s account profile**. Confirm that the request log contains exactly one linked GET.

### Viewer without the grant

1. Return HTTP 200 with `ok: true` and the same synthetic viewer in `profile` and as the sole entry in `profiles`. Return an error if the linked endpoint is called, and count that request.
2. Follow the top-bar steps. Verify that **Crew roster sites** lists 11 bundled sites and that `#profile-roster-account-targets` is hidden.
3. Open **Map** and check that the `my-targets` source contains only the 11 bundled sites. Confirm that the linked request count is zero across the menu switch and both tabs.

The same zero-request result holds for the default verify session (it never lists `josh`), a 401 on `/?u=kutryk`, and a grant whose name is not `josh`. `#profile-roster-account-targets` stays hidden. The heading uses U+2019: `Josh Kutryk’s account profile`. The popup line is `From Josh Kutryk’s account profile`. The row has no button. `handleAdd` on that roster answers `read-only`.

### Revocation and a public 503

`ROSTER_SESSION_RECHECK_MS` in `frontend/src/profile-session.ts` is 60 seconds. `refresh` calls `pollLinkedRosterTargets` when the browser is online and the sign-in banner is not held. After that window, a session whose `profiles` no longer include `josh` drops the scope. `clearLinkedRosterTargets` removes the row, the map ring, and the open popup. The page does not reload. The linked GET count stays at the one read from the grant. A second session GET is the recheck, not another targets GET.

A `GET /manifest.json` that answers 503 after a snapshot is on screen throws in `fetchManifest`. `renderOfflineBanner` calls `setLinkedRosterTargetsOffline(true)`. That clears the same row and ring and paints the LOS banner from the snapshot age. While that latch is set, `pollLinkedRosterTargets` returns before the session read, so a still-valid grant stays hidden until a later successful refresh calls `setLinkedRosterTargetsOffline(false)`. That pause is the Astra r4 P3 in `follow-ups.md`. Do not fail the 503 case for it.

### Worker gate and pins

`handleProfilesRequest` in `worker/src/profiles.ts` authenticates first. A missing `cf-access-jwt-assertion`, when Access is configured, is 401 `{error: unauthorized}` before the profile list is read. An Access JWT whose `resolved.profiles` does not include the path name is 403 `{error: profile_forbidden}` at `resolved.profiles.some(...)`. Use synthetic `example.com` identities in the worker file. Do not copy a mailbox into this skill.

```bash
cd frontend && bunx vitest run test/profile-roster-link.test.ts
cd frontend && bunx vitest run test/main-integration.test.ts -t "clears revoked linked rows, rings and popup while the public feed has a 503"
cd worker && bunx vitest run test/browser-identity.test.ts
```

`profile-roster-link.test.ts` is 23 tests, including `suppresses the roster overlay with zero target requests when ungranted` and `clears the mounted overlay when the grant is revoked`. `browser-identity.test.ts` is 19 tests. These files mock `profile-session` and must export `invalidateRosterReadScope`: `frontend/test/map-import-failure.test.ts`, `profile-hydration.test.ts`, `account-storage.test.ts`, `iss-view-nav-race.test.ts`, `iss-view-nav.test.ts`, and `log-load-state.test.ts`.

Two mutants must go red. Restore the file after each one. Do not commit either edit.

- In `frontend/src/profile-session.ts`, set `granted` from the roster `accountProfile` alone and skip `authorizedProfiles?.some(...)`. `suppresses the roster overlay with zero target requests when ungranted` then requests `/api/browser/profiles/josh/targets`.
- Make `clearLinkedRosterTargets` return before it clears `state`. `clears the mounted overlay when the grant is revoked` keeps the linked row, and the main-integration 503 case keeps the ring.

## Gotchas

- A denied session (HTTP 401) paints the sign-in footer and does not open this pane. `init` calls `bindTabs(false)` before it returns. `#tab-profile` is `disabled` and `aria-disabled` is `true`. A click does not render stored profiles or personal targets, and it does not delete them. A second `init` after a successful session enables Profile, removes `aria-disabled`, and the pane names that account. The probe stores `opd-calib-queue` as `[{"private":"unsent"}]` and does not write `opd-profile-anil`. A version-0 JSON value at that key throws `failed to load profile "anil"` after the session succeeds. `init` sets its local `sessionFailed` for that call, so Profile stays disabled. The account is already set, so the footer is the red `setBanner` text and not the Sign in recovery. `maybeFlagExpiredSession` in `frontend/src/main.ts` clears `sessionBannerHeld` when the manifest age is under 150 minutes. The footer returns to the update age. The ready banner includes `Last updated` and does not include Sign in. WebKit at 402 by 874 and at 834 by 1210 measured `Last updated 8 min ago`. `frontend/test/account-session.test.ts` is `a denied session keeps Queue and does not render or enable Profile` and `a later sign-in enables Profile after a denied session`. A failed fetch with no saved session takes that same lock. It does not return before the tab clicks are wired. `OPD_VERIFY_LOCK=profile node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive session-lock` is one WebKit process. `OPD_VERIFY_SURFACE=iphone-17-pro OPD_VERIFY_VIEWPORT=402x874` and `OPD_VERIFY_SURFACE=ipad-pro-11 OPD_VERIFY_VIEWPORT=834x1210` are the two drives. The first load uses `opd-verify-session=deny`. The same document then calls `init` again with the cookie cleared. Stdout is `session lock profile <id> locked true after-signin-disabled false view view-profile`. `locked` is the first load. `after-signin-disabled` is `#tab-profile` `disabled` after the later `init`. Shots are `evidence/session-lock-profile-<id>.png` and `evidence/session-lock-profile-ready-<id>.png`. `drive profile` and `drive all` leave this probe out. A non-JSON 404, or a 200 HTML body that contains `id="status-banner"`, opens Profile as a local account.
- The page's bundled set is `BUNDLED_ISS_TLE` in `frontend/src/iss-tle.ts`. `.cursor/skills/verify-opd/scripts/fixtures.mjs` writes the same 2026-09-27 lines as the published track only when CelesTrak does not answer. Photo lookup tries `opd-iss-tle-last-good`, then `opd-tle-25544`, then the published track, then that bundled set. The choice is the candidate that still propagates and whose epoch is closest to the photo time. A failed first pass asks once for the ISS set, from that 6 hour cache or from CelesTrak, and retries only when the set is not stale.
- Crew sites on the page come from the bundled roster in `data/crew-roster/roster.json` and the three CSVs. Watkins has 12 sites, Kutryk 11, and Delaney 11. `drive map` checks the Watkins list. It does not run `generator/multiplex.py`. That module reads the same CSVs when a roster profile is requested and does not ask the worker for those sites. A crew hide stays on this device. The drive does not assert the absence of a worker PUT.
- `track.tle_epoch` must match the epoch inside the TLE lines within 2 seconds. Photo lookup treats a track whose epoch disagrees as malformed and tries the other candidates. The bundled set always parses, so the malformed chip does not appear while that set is in the page.
- Add target posts to the fixture `/api/browser/profiles/anil/targets`. The name is painted before the response returns. This drive checks that the name is on screen. It does not wait for the toast.
- Every drive start, including desktop, PUTs `{ targets: [], removedCuratedIds: [] }` before the page loads. `drive profile` by itself therefore starts with an empty hidden list and no Verify Harbor row. Inside one drive the proxy keeps what this pane adds. `drive all` reaches this pane after Upcoming has already hidden `verify-mesa`, so the chip is already there and Restore is the step that changes it.
