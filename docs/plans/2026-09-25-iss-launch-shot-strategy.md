# When an ISS launch shot is real

This page is for the crew member who opens the map to decide whether to go to a window with a camera. A launch on a list is not that decision. A shot is a short time when the station's ground track passes near the pad, or along a known ascent track, close enough that the rocket or the plume can fill a frame.

The map should answer with one card, or with none. The code that feeds the map today does not do that. On 25 September 2026 it would have shown six launches for the next week and called none of them possible. Two of those six are the only ones whose orbit, on a stale forecast, comes near a pad. They are buried in the same list as launches that are thousands of kilometres out of view.

The code sequence that gets from this list to one card is in [How to cut the launch list down to a shot](2026-09-25-iss-launch-shot-changes.md).

## The decision

Judge each launch at the time the station is closest to the pad. Treat the published T-0 as one sample inside that pass. Use the rules already in the repo. Do not invent a new score.

Call it a **go** only when every line below is true.

- The Launch Library 2 status is `Go` or `Confirmed`. The published precision is minute or second. The headline NET falls inside the published window. A window that opens before the NET is normal. It is not a conflict. `filter_launches` in `generator/launch_data.py` already requires `Go` or `Confirmed`, and `build_planning_assessment` in `generator/launch_assessment.py` refuses anything else as `TIMING_UNCONFIRMED`.
- The ISS TLE epoch is within 24 hours of the time you are judging. That limit is `EPHEMERIS_HORIZON_SECONDS` in `generator/launch_assessment.py`. Outside it, SGP4 is not a shooting instruction. Say **recheck**, or say nothing. Do not say go.
- During the pad window, from 300 seconds before T-0 until 120 seconds after T-0, the closest ground range from the station to the pad is under 800 km. 800 km is `PASS_MAX_DISTANCE_KM` in `generator/config.py`, the cone the overhead launch search already uses. 300 seconds is `PASS_WINDOW_SECONDS` in `generator/launch_data.py`. The 120 seconds after T-0 is a planning bound so a liftoff that happens during the pass still counts. It is not a measured burn time.
- At that closest instant the line of sight to the pad clears the Earth. The limb range is `_horizon_km` in `generator/launch_assessment.py`. At a station altitude near 420 km that limb is about 2200 km. A pad inside the limb and outside 800 km is above the horizon and still a poor overhead. It is not a go.
- For a daylight look at the ground, the existing cloud sample at the pad is clear. If the sample is missing, the result is recheck, not a go. A night look at engine light does not wait on that sample. The planning assessment does not apply cloud today. The legacy pass scorer does. See the open questions before treating cloud as already enforced.

Call it a **no-go** when the schedule is admitted and the nominal ascent disk stays behind the Earth for the whole early ascent, with the margins `build_planning_assessment` already adds. That reason string is `NOMINAL_ASCENT_TOO_FAR`. A no-go is not a card.

Call everything else **recheck** or omit it. Unknown is not a third kind of opportunity.

One list. Rank by the closest-approach time. If nothing is a go inside the 24 hour TLE limit, the list is empty. At most one recheck line names the next launch whose stale forecast still comes inside 800 km, and the line says the forecast is too old to shoot from.

## What the feed showed on 25 September 2026

`https://map.astroanil.dev/launch/latest.json` answered with a Cloudflare Access login, HTTP 302 to `anilsamoil.cloudflareaccess.com`. The deployed artifact was not readable from this session. The counts below are from the publisher function on the public feed, not from the live JSON.

Command shape. Fetch `https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=100` and the ISS TLE from Celestrak `CATNR=25544`. Call `build_launch_artifact` with `fetched_at` equal to the run time. This run used feed time 2026-09-25T23:33:45Z and TLE epoch 2026-09-25T10:22:03Z. The feed reported 367 launches and returned 100. The first launch after the next 14 days is 31 October 2026, so the 14 day set is complete on that page.

The publisher keeps launches whose NET is inside seven days. `HORIZON_HOURS` in `generator/launch_evidence.py` is `7 * 24`. It does not use `filter_launches`. Every parsed row in that week becomes an item with status `map_only`.

| What | Count |
| --- | --- |
| Launches in the next 7 days, and items the artifact would publish | 6 |
| Launches in the next 14 days on the same page | 9 |
| Items with `net.verdict` of `possible` | 0 |
| Items with a capture interval or a trajectory line | 0 |
| Items the queue can show. Queue requires `geometry_supported` | 0 |
| Items the map lists when Launches is on. Map horizon is 7 days | 6 |
| Items the Upcoming tab lists. Upcoming horizon is 36 hours | 2 |

The six published rows were:

- Electron, Mahia, 26 September 2026 00:39Z. `too_far`, `NOMINAL_ASCENT_TOO_FAR`. Ground range at NET about 10934 km. Limb about 2234 km.
- Falcon 9 USSF-385, Vandenberg, 26 September 2026 14:00:54Z. `unknown`, `TIMING_UNCONFIRMED`. The window opens at 11:56Z, before the NET. `_parse_one_result` treats `window_start < net` as `TIME_CONFLICT` even when the NET sits inside the window. A direct range check, which the assessment never reached, puts the pad about 8450 km away and the nominal disk still occulted.
- Starship Flight 14, Starbase, 28 September 2026 12:15Z. `unknown`, `TIMING_UNCONFIRMED`, because status `TBC` is not in `LL2_GO_STATUS_ABBREVS`. The pad is about 9785 km away.
- Crew-13, Cape Canaveral, 1 October 2026 15:10:06Z. `unknown`, `EPHEMERIS_OUTSIDE_HORIZON`. The TLE epoch is about 149 hours before T-0.
- Transporter 18, Vandenberg, 1 October 2026 18:18Z. Same ephemeris refusal. Epoch age about 152 hours.
- Falcon Heavy NROL-97, Kennedy, 2 October 2026 03:53Z. Same ephemeris refusal. The pad at NET is about 7382 km away, outside the limb.

The three launches between day 7 and day 14 stay off the map. None of them is an overhead. Nuri has no ascent profile match. SR75 is a day-precision `TBD`. SDA Tranche 1 is `TBC` and the nominal disk stays occulted on the same stale propagation.

A propagation the publisher will not sign, because it is past 24 hours, changes the reading of two rows. Closest ground range to the pad, sampled every 15 seconds:

- Crew-13. Closest about 146 km at 135 seconds before T-0. Off-nadir about 19 degrees. Orbital azimuth about 80 degrees, which the map's eight-sector labels call right of the direction of travel. At T-0 the range is about 914 km and the off-nadir angle is about 62 degrees. The overhead is before liftoff. The liftoff look is oblique and outside the 800 km cone.
- Transporter 18. Closest about 117 km at 120 seconds before T-0. Off-nadir about 16 degrees. Azimuth about 96 degrees, again the right-hand sector. At T-0 the range is about 845 km and the off-nadir angle is about 61 degrees. Same pattern.

Those two numbers are not a go. A TLE that is six days old can slide an ISS pass by more than a 146 km miss distance. They are the reason a recheck line exists. They are also the reason a test at the single NET instant is the wrong test. At NET, both pads are outside 800 km. The pass that matters is two minutes earlier, and the rocket is still on the pad.

No row has `launch_azimuth_deg` or `trajectory_source`. The parser leaves both empty. `evaluate_liftoff_window` and `predict_ascent_pass` both refuse to build a track without them. Zero plume sightlines were computed. Zero corridor lines would draw.

## Launch, then the corridor

These are different times and different aims. The card names which one it is.

**The pad shot.** You are photographing the site, the engine light, and the first motion. The time that matters is the closest approach in the pad window above, not the NET by itself. On the 1 October examples the closest approach is about two minutes before T-0. You are over the coastline while the vehicle is still on the pad. By T-0 the station has moved on, and the pad is a steep oblique look. If the card's closest time is before T-0, be in the window early. The liftoff itself is the later, steeper look, and only if that later look still clears the limb. If the closest time is after T-0, you are arriving as the vehicle leaves. Stay with the pad until the range opens past 800 km.

The legacy overhead path in `generator/main.py` already searches T-0 plus or minus `PASS_WINDOW_SECONDS` inside 800 km, then scores the pass like a ground target. The artifact the map reads does not use that search. `build_planning_assessment` looks at the pad at the NET instant and asks only whether it is inside the limb. That is how a 914 km oblique at T-0 can look like the whole opportunity, and how a 146 km pass two minutes earlier never becomes a verdict.

**The corridor shot.** You are photographing the vehicle after it has left the pad. The trail, the twilight plume, the upper stage. The time is T-0 plus an offset along a track, on the order of the profile samples in `generator/ascent_profiles.py`. Falcon 9 class profiles in this repo run on the order of 540 seconds to the insertion sample. The instant to shoot is the sample where `predict_ascent_pass` in `generator/ascent.py` finds a line of sight that clears the Earth, a rocket that is not in umbra, and a plume angle of at least `PLUME_ANGLE_NO_CREDIT_MRAD` which is 0.5 milliradians. Full credit in that function is 3 milliradians, described there as a 5 km plume at 1500 km.

That function does not run for the current feed. There is no sourced azimuth, so there is no corridor. Do not draw a generic downrange disk as a line. `build_planning_assessment` uses the disk only to prove a negative. A disk that intersects the limb is unknown, and the module's own text says a disk intersection is not proof the rocket is visible.

Until a sourced azimuth exists, the only honest card is the pad shot. Say that the corridor was not assessed.

## Where to point

Point at the time of closest approach, at the look `look_direction_at` returns for the pad. The frame is `orbital-lvlh`. Azimuth 0, 90, 180, 270 means ahead, right, aft, left of the station's velocity, not a compass bearing and not the station's body axes. `orbital_look_direction` in `generator/launch_geometry.py` says this, and the autoplan on main says an orbital angle does not mean a particular window is free of structure.

The window name is the existing split. Under 30 degrees off nadir, WORF, the Destiny nadir window. At 30 degrees and above, Cupola. `angle_off_nadir_deg` in `generator/orbit.py` states that split. `photoWindow` in `frontend/src/launch-card.ts` uses the same number. For the stale Crew-13 closest approach, about 19 degrees, that rule says WORF. For the same launch at T-0, about 62 degrees, it says Cupola, and the range is already outside the 800 km cone, so that later look is not the go.

Frame the pad and the coastline you already use as a landmark from the nadir window. The card should name the site string from the feed, for example Cape Canaveral or Vandenberg, and the off-nadir angle. It should not name a town or a road. The repo does not compute one.

Lens and exposure, only where the repo already states them. The photography almanac in `frontend/src/help.ts` is for Earth passes, from Don Pettit's guide. Hand-tracked shutter floors for the flown long lenses are 400 mm at 1/640 or faster, 800 mm at 1/1250 or faster, and 1200 mm at 1/2000 or faster. Daylight Earth starting point in that same entry is ISO 200 to 400 and f5.6 to f8. Telephoto longer than 85 mm wants the Russian-segment windows or the Cupola bump-shield panes, because scratch panes ruin long-lens work. Use those numbers when the go is a daylight framing of the ground around the pad. They are the wrong starting point for a night plume. This repo does not state a plume exposure. Do not invent one on the card.

## What the map should stop showing

Stop putting these in front of the crew.

- The six-row list, and the Upcoming cards, for launches that are `unknown` or `too_far`. `selectLaunches` in `frontend/src/launch-selectors.ts` keeps every artifact item inside the horizon. The map horizon is seven days. The Upcoming horizon is 36 hours. On this feed that is six cards and two cards, and zero gos.
- Pad pins for those same rows. `buildLaunchMapFeatures` in `frontend/src/map/features/launch-corridor/geometry.ts` drops a pin for every map selection. With no sourced track it correctly draws no line. The pins are the noise.
- The details dialog as the thing you see first. `renderLaunchFacts` in `frontend/src/launch-card.ts` still lists status codes, model altitude, model downrange, revisions, and reason strings. PR 143 moved that off the summary. Leave it off the summary. Do not expand it to compensate for a vague Chance line.
- A corridor with no `trajectory.source`. The layer is already gated. Keep the gate.
- Legacy overhead launch passes inside the shot queue once an artifact exists. `renderUpcoming` in `frontend/src/main.ts` already drops them when the artifact is present, and the queue path requires `geometry_supported`, which `build_launch_artifact` never sets. It always writes `map_only` and `VALIDATION_PENDING`. Leave the queue as ground targets until a go also has camera evidence.

The Launches control can stay opt-in. PR 137 made it start off. Opt-in does not fix the list you see after you turn it on.

## What the map should show instead

With Launches on, one of these.

- No card, and the sentence that no launch shot is inside the trusted orbit forecast.
- One go card. Shoot time is the closest-approach UTC and the offset from T-0. Window is WORF or Cupola from the 30 degree rule. Direction is the orbital sector and the off-nadir angle. Launch window is the feed window. Chance is Possible. If the overhead is before T-0, the Shoot line says so in the same line, including the off-nadir angle at T-0 when that look still clears the limb.
- At most one recheck sentence for the next inside-800 km pass that fails only the 24 hour TLE test. It is not a Possible card and it has no pin.

A sourced corridor, when one exists, is a second line on that same card. It carries its own time offset and the look toward the rocket. The pad look stays on the first line.

## Why the current list fails

The published assessment can say `possible` only for `SITE_IN_VIEW_AT_NET`, which means the pad is inside the limb at the single NET time. On this feed that fired zero times. The two passes that come inside 800 km do it before T-0, and the 24 hour TLE rule then labels them with the same `unknown` as a launch that is on the other side of the Earth. `launchBrief` turns `unknown` into the word Unknown and still renders the card. The crew member sees launches, not a shot.

Cloud, lightning, and the Cupola finder do not enter this decision. `build_launch_artifact` does not call them. `find_cupola_windows` in `generator/cupola.py` ranks daylight keepsake windows. `generator/lightning.py` is the sprite watch. They are real products. They are not a launch go.

## Open questions

- The 120 seconds after T-0 is a bound chosen so the pass can include liftoff. It is not in the code today. If a vehicle is still a useful pad target later than that, the bound should move, with a profile sample as the reason.
- A daylight go should require the existing cloud sample. The first code change should not add that sample until the list is already empty of non-shots. If a night engine-light shot must ignore pad cloud, say so before writing the check. The repo's plume path treats umbra as no reflected-sun shot, which is a different test.
- Six-day SGP4 error is large enough to create or erase a 146 km pass. The recheck line can false-alarm. If that line causes another trip to the window for nothing, delete the line and keep only the fresh-TLE go.
- Physical window access is not modeled. The 30 degree split is a hint from `generator/orbit.py`, repeated in the help panel. It does not know which pane is blocked, and it does not apply the almanac's 85 mm Russian-window rule. The card should keep the hint and should not say the window is clear.
- No plume exposure lives in the repo. Do not add a guessed ISO on the launch card.
- This page does not say the deployed artifact matches the local run. Access blocked the read. A ground check of `launch/latest.json` from an allowed client is the missing confirmation.
