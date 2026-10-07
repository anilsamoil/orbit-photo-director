# Upcoming

Upcoming lists launches with a shooting chance, then future passes from the `top_24h` artifact. The generator writes that artifact from 90 minutes out through the 36 hour window. The page drops a pass once its closest approach is in the past. The pane title starts with Next 36 hours. The fixture puts the Verify Ascent launch card above Verify Mesa. Mesa is about eight hours ahead. Ascent stays after Mesa is hidden. Verify Horizon is the fixture's All launches row. It is not a chance, and Upcoming does not list that name.

## Sub-features

- `upcoming-card` shows Verify Mesa.
- `upcoming-sort` selects Score.
- `upcoming-hide` removes that card and keeps it removed after a re-render and a reload.

## How to get to it (user POV)

- Choose the Upcoming tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Open Upcoming.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive upcoming`. The script requires Verify Ascent above Verify Mesa in the list text, and the list does not include Verify Horizon.
- **Sort.** The Score button gains the active class.
- **Hide.** The Hide control removes Verify Mesa from the list. Time sort paints the list again and the card stays gone. `removedCuratedIds` in localStorage `opd-profile-anil` contains `verify-mesa`.
- **Reload.** The script reloads the page and opens Upcoming again. Verify Mesa stays gone, and the same id is still in `removedCuratedIds`.
- **Another browser.** After `GET /api/browser/profiles/anil/targets` lists `verify-mesa` in `removedCuratedIds`, a new Chrome profile opens the same proxy. Upcoming does not show Verify Mesa, and its localStorage timestamp matches the GET.
- **Proof.** `evidence/upcoming.png` shows Verify Ascent above Verify Mesa. `evidence/upcoming-hidden.png` shows Mesa gone and Ascent still listed. `evidence/upcoming-reloaded.png` shows Mesa still gone.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- Hide writes the target id into `removedCuratedIds` on `opd-profile-anil` and PUTs the list to the profile API. Queue, Upcoming, and the map pins all drop that id on the next paint. The fixture feed still contains Verify Mesa. A new browser that loads after the PUT gets the list from the profile GET and hides it too. This drive opens that browser.
- The proxy keeps the list until `down`. The next drive deletes only the Chrome profile, so it adopts the server list and Verify Mesa starts hidden. Run `down`, then `up`, before a drive that expects the card.
- `drive all` hides Verify Mesa here, after Queue has already hidden Verify Delta. Both stay hidden through the reload in this drive. Profile later restores Verify Mesa on this same page, and a new Chrome profile shows the card again. Verify Delta stays hidden.
- Pad and ascent line of sight is not on this page. `generator/launch_opportunities.py` marks a sight in plan when the chord clears Earth and the slant range is at most 3500 km. The prove gate is `pytest tests/test_launch_opportunities.py`. OA-4 keeps the pad out of sight, puts the Atlas plume in sight at 2900 to 3400 km with light `twilight_plume`, and the ground range to the pad is greater than 500 km. That 500 km figure is not the plan gate. A hidden pad can become an in-plan ascent once the rocket clears the limb. Umbra on ascent stays `night_engine`. Launch direction is `generator/launch_direction.py`. The prove gate is `pytest tests/test_launch_direction.py`. CRS-35 is kind `iss_plane`, azimuth 44.7° within 1°, and off-plane under 1°, from the ISS element set. A non-ISS destination is `none`. A title or a program name does not set the destination. `sample_directed` adds an ascent envelope only for that typed direction. Inclination does not supply the azimuth. This drive does not run those modules.
- Schema 3 stays off this drive. `fixtures.mjs` writes `schema_version` 2, and the publisher still emits schema 2. `parseLaunchArtifact` accepts a schema 3 catalog, with `lens` and `lens_reason` on each shot envelope, and still accepts schema 2. A hash mismatch keeps the last good artifact at availability `last-good`. `selectLaunches` leaves that catalog off the schema 2 chance lists. `launchCoverageLabel` writes `STALE / EXPIRED` when now is before `generated_at` or at or after `schedule_valid_until`, and omits that mark while `generated_at <= now < schedule_valid_until`. The prove gates are `frontend/test/launch-store.test.ts` (`parses schema 3 with a lens and still parses schema 2`, `loads a schema 3 catalog and keeps the last good copy when the hash does not match`) and `frontend/test/launch-selectors.test.ts` (`accepts a schema 3 catalog and does not select it as a v2 chance`). Run them with `cd frontend && bun run test`.
