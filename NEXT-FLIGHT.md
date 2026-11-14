# Starship orbit for the next flight

The Starship checkbox in the Satellites panel draws the next Starship flight as soon as CelesTrak publishes an element set for it. No code change and no flight-specific NORAD number or international designator is needed. When CelesTrak lists no element set, the map draws nothing and the panel says "no public orbit yet".

## How the next launch is chosen

The publisher (`generator/tracked.py`) and the browser (`frontend/src/satellites.ts`) apply the same four rules.

1. **Search by name.** Both ask CelesTrak Supplemental GP and GP for `NAME=STARSHIP` and `NAME=SHIP`. A reply counts when its name starts with `STARSHIP` or with `SHIP <number>`. That covers `STARSHIP S41`, `SHIP 41`, `STARSHIP R/B`, and `SHIP 41 R/B`. Names that contain `DEB` are debris and do not count. `STARLINK-*`, `STARSHIELD`, and other names that only contain "ship" do not count.
2. **One set per object.** Matches are grouped by catalog number. The newest epoch wins, and Supplemental GP wins a tie.
3. **Only live objects.** An object is hidden when its epoch is older than 72 h, or when it has reentered. Reentered means a perigee below 80 km and more than one orbital period since the epoch, so a suborbital set still draws for its first revolution.
4. **Rank.** Ships come before rocket bodies (`R/B` in the name). Then the newest launch comes first, read from the international designator. A blank designator counts as newest, because the object is not catalogued yet. The higher catalog number breaks a tie. Epoch is not part of the rank, so the drawn object does not flip between two live ships.

The first object is drawn. The others are named under the checkbox as "Also in orbit", with their NORAD numbers. `tracked.json` carries them in an `also` list on the Starship row.

## Fresh, stale, and gone

Two named limits apply to a Starship element set, counted from its epoch. `generator/tracked.py` defines them as `STARSHIP_FRESH_HOURS` and `STARSHIP_GRACE_HOURS`, and `frontend/src/tracked.ts` mirrors them. `tracked.json` carries them on the Starship row as `lookup.max_age_hours` and `lookup.grace_hours`.

- **Fresh, up to 12 h.** The set is drawn with no age label.
- **Stale, from 12 h to 72 h.** The set is still drawn, whether it comes from a feed, the publisher, or a last good cache. The panel shows a `stale orbit` badge and the line "stale orbit, epoch N h old", where N is whole hours since the epoch.
- **Past 72 h.** The set is not drawn.

The grace exists so that a CelesTrak outage or a late update does not erase a ship that still propagates and has not reentered. Reentry and a confirmed empty answer still remove a ship at any age. An object the operator adds in `tracked-objects.json` has no grace beyond its own `max_age_hours`.

The panel keeps four cases apart.

| Case | What is drawn | What the panel says |
| --- | --- | --- |
| Fresh | The orbit | "drawing SHIP 41" |
| Stale | The orbit | "stale orbit, epoch N h old" |
| No public orbit | Nothing | "no public orbit yet", only after every feed answered or the publisher confirmed none |
| Lookup failed | Nothing | "orbit lookup failed" with the cause. When a last good set exists but is past 72 h, the line adds "The last good orbit, epoch N h old, is too old to draw." |

A failed lookup never hides a last good set that is still inside the grace. That set is drawn as fresh or stale.

## When an object goes away

- CelesTrak removes a decayed object from its feeds. When every query answers and an object is missing, the publisher drops it from `tracked-starship.json`, and a later throttled tick does not bring it back.
- When a feed fails or is resting, the cached list still serves, inside the 72 h grace and the reentry rule.
- The row reports `no_public_orbit`, `aged_out`, `reentered`, or `lookup_failed`. The panel has one sentence for each. When a feed failed and every known set is past the grace, the publisher reports `lookup_failed`, because the failed feed may hold a newer set.
- The browser stops drawing a ship it got from the publisher once the publisher says `no_public_orbit` or `reentered`. A ship the browser got by asking CelesTrak itself stays until it ages out, reenters, or a later tap finds it gone.

## Run the tests

The fixture `frontend/test/fixtures/celestrak-starship-fictional.txt` holds made-up objects (`SHIP 90`, `SHIP 91`, `SHIP 91 R/B`, debris, Starlink, and others, catalog numbers 90001 to 90014). Both suites read it.

```sh
# Python, from the repo root, with an interpreter that has the project's dev dependencies
python -m pytest tests/test_tracked.py -q

# Frontend
cd frontend
npx tsc --noEmit
npx vitest run test/satellites.test.ts test/tracked.test.ts \
  src/map/features/satellites/satellites.test.ts \
  test/map-satellites-contract.test.ts test/help.test.ts
```

## Not done

- Only the first object gets a track and a marker. The others are listed, not drawn.
- `.cursor/skills/verify-opd/features/tracked.md` still describes the three older reasons and a 12 h cutoff.
- An older flight's objects stay in "Also in orbit" for up to 72 h, with no stale mark of their own. Only the drawn object carries the stale label.
- The age checks in `frontend/scripts/verify-map-pins.mjs` look for source lines that no longer exist. They were already out of date before the grace was added.
