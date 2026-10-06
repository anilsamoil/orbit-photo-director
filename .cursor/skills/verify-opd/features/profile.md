# Profile

Profile holds the signed-in astronaut, the distance threshold, personal targets, hidden curated targets, and photo lookup.

## Sub-features

- `profile-identity` shows Anil from the session fixture.
- `profile-threshold` moves the viable distance display to 800 km.
- `profile-add` adds a target named Verify Harbor.
- `profile-hidden` shows Hidden curated targets. Restore removes `verify-mesa` from that list, the GET drops that id, and a new Chrome profile shows the card again.
- `profile-lookup` resolves the fixture timestamp and drops a lookup pin on the map. It then resolves a last-good TLE at that TLE's own epoch, and a 2035 timestamp. A 2035 time that still propagates shows `low confidence — TLE age` and `ISS at`. A 2035 time where every element set fails SGP4 shows `orbit data is out of date, reconnect to refresh`.

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

## Gotchas

- A denied session stops on the sign-in footer and does not open this pane. A failed fetch with no saved session paints a red banner and returns before the tab clicks are wired. The tab buttons are already in the page. A non-JSON 404, or a 200 HTML body that contains `id="status-banner"`, opens Profile as a local account.
- The page's bundled set is `BUNDLED_ISS_TLE` in `frontend/src/iss-tle.ts`. `.cursor/skills/verify-opd/scripts/fixtures.mjs` writes the same 2026-09-27 lines as the published track only when CelesTrak does not answer. Photo lookup tries `opd-iss-tle-last-good`, then `opd-tle-25544`, then the published track, then that bundled set. The choice is the candidate that still propagates and whose epoch is closest to the photo time. A failed first pass asks once for the ISS set, from that 6 hour cache or from CelesTrak, and retries only when the set is not stale.
- Crew sites on the page come from the bundled roster in `data/crew-roster/roster.json` and the three CSVs. Watkins has 12 sites, Kutryk 11, and Delaney 11. `drive map` checks the Watkins list. It does not run `generator/multiplex.py`. That module reads the same CSVs when a roster profile is requested and does not ask the worker for those sites. A crew hide stays on this device. The drive does not assert the absence of a worker PUT.
- `track.tle_epoch` must match the epoch inside the TLE lines within 2 seconds. Photo lookup treats a track whose epoch disagrees as malformed and tries the other candidates. The bundled set always parses, so the malformed chip does not appear while that set is in the page.
- Add target posts to the fixture `/api/browser/profiles/anil/targets`. The name is painted before the response returns. This drive checks that the name is on screen. It does not wait for the toast.
- `drive profile` by itself starts with an empty hidden list only when this proxy has not stored one. The proxy keeps that list, and any personal target from Add target, until `down`. A second `drive profile` on the same proxy already lists Verify Harbor, so the add step does not prove a new row. Run `down`, then `up`, before a drive that expects an empty list. `drive all` reaches this pane after Upcoming has already hidden `verify-mesa`, so the chip is already there and Restore is the step that changes it.
