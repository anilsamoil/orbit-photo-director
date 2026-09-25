# How to cut the launch list down to a shot

Use this when you are changing the publisher or the map so a crew member sees a go, or an empty list. The decision you are implementing is in [When an ISS launch shot is real](2026-09-25-iss-launch-shot-strategy.md). Do these units in order. Finish the proof for one unit before you start the next. Do not add a map layer, a new score, or a second list.

The baseline to beat is the 25 September 2026 run in that page. Six published items, zero `possible`, two Upcoming cards, six map rows when Launches is on.

## Hide every card that is not a go

`selectLaunches` in `frontend/src/launch-selectors.ts` returns every artifact item inside the view horizon. Change the map view and the upcoming view so they return an item only when `launchBrief` would say `chance`.

Leave the queue rule as it is. It already requires `geometry_supported` and a capture interval, and `build_launch_artifact` never sets that status.

`buildLaunchMapFeatures` already pins whatever `selectLaunches` returns for the map. After this change the pins follow the list. Do not add a filter in the layer.

You see an empty launch brief when every item is `unknown` or `too_far`, and the existing empty sentence from `renderMapLaunchBrief`. A fixture with `net.verdict` of `possible` and a fresh schedule still renders one card.

Prove it with `cd frontend && bun test test/launch-selectors.test.ts test/launch-map-brief.test.ts test/launch-brief.test.ts`. Add one case whose artifact matches the six-row shape, all non-possible, and assert the map selection length is 0. Add one case with a single `possible` item and assert the length is 1.

## Stop treating an early window as a time conflict

In `_parse_one_result` in `generator/launch_data.py`, `TIME_CONFLICT` is set when `window_start < net`, including when the NET lies inside the window. Delete that clause. Keep the conflict when the window ends before it starts, or when the NET lies outside the window.

You see USSF-385, window 11:56Z to 14:56Z and NET 14:00:54Z, parse with an empty `timing_reasons`. A NET after `window_end` still gets `TIME_CONFLICT`.

Prove it with `pytest tests/test_launch_data.py tests/test_launch_assessment.py`. Add the USSF window shape. Re-run `build_launch_artifact` on a saved copy of that feed row and assert the net reason is `NOMINAL_ASCENT_TOO_FAR`, not `TIMING_UNCONFIRMED`.

## Judge the closest pass, not the NET instant

In `build_planning_assessment` in `generator/launch_assessment.py`, keep `possible` behind the 24 hour TLE gate. Replace the positive test. Today `possible` means the pad is inside `_horizon_km` at the NET instant, reason `SITE_IN_VIEW_AT_NET`.

The new positive test samples the pad from 300 seconds before T-0 until 120 seconds after T-0. 300 seconds is `PASS_WINDOW_SECONDS`. 800 km is `PASS_MAX_DISTANCE_KM`. The 120 second tail is the planning bound named in the strategy page. Step 15 seconds, the same cadence as `INTERPOLATION_CADENCE_SECONDS` in `generator/ascent.py`.

Set `possible` only when the closest ground range in that window is under 800 km, the line of sight at that instant clears the limb, and the TLE epoch is within 24 hours of that instant. Store the look from `look_direction_at` at that instant, and store the offset from T-0 on the net object. If the closest range is 800 km or more, do not use the limb at NET as a fallback go.

Keep `NOMINAL_ASCENT_TOO_FAR` as the negative, on the early-ascent disk the function already builds. Do not run that negative past the 24 hour gate. A stale TLE can invent a miss. Outside the gate, leave the reason `EPHEMERIS_OUTSIDE_HORIZON`.

You see a launch whose closest approach is 150 km at 120 seconds before T-0, with a fresh TLE, get `possible` and that offset. The same geometry with a TLE older than 24 hours stays `unknown`. A launch whose closest approach in the window is 900 km stays off `possible` even if the pad is inside the limb at NET.

Prove it with `pytest tests/test_launch_assessment.py`. Use a fixed TLE and a fixed pad. Do not call the network from the test.

## Point the five lines at that instant

`operatorLaunchLines` in `frontend/src/launch-card.ts` already has Shoot, Window, Direction, Launch window, and Chance. Fill them from the closest-approach look.

- Shoot is the closest-approach time and the offset from T-0. When the offset is negative, the same line says the overhead is before liftoff.
- Window uses `photoWindow`. Under 30 degrees is WORF. At 30 and above is Cupola.
- Direction uses `launchLookDirection`.
- Chance stays Possible only for `chance`.

Do not add a row. Do not put shutter numbers on the launch card. The almanac already covers daylight Earth framing. A plume exposure is not in the repo.

You see a card whose Direction contains an orbital sector and an off-nadir angle, and whose Window is WORF when the stored angle is 19. A non-possible item does not appear, because the first unit hid it.

Prove it with `cd frontend && bun test test/launch-card.test.ts test/launch-map-brief.test.ts`.

## Add one recheck sentence, then stop

After the closest-approach test exists, `renderMapLaunchBrief` may show one sentence when no go is in the list and exactly one item failed only `EPHEMERIS_OUTSIDE_HORIZON` while a side computation, using the same 800 km window, would have passed. The sentence names the launch, the NET date, and that the orbit forecast is older than 24 hours. It is not a Possible card, and it does not add a pin.

If you cannot compute that side result without a second propagation policy, skip this unit. An empty list is the right ship. The strategy page records the false-alarm risk.

Prove a skip by the absence of the sentence in `launch-map-brief.test.ts`. Prove the sentence, if you ship it, with one fixture and `bun test test/launch-map-brief.test.ts`.

## Confirm the census moved

Save the Launch Library page and the TLE you judged. Run `build_launch_artifact`, then the same selection rule as the map view. On the 25 September 2026 inputs the expected map length is 0. The two 1 October rows stay `EPHEMERIS_OUTSIDE_HORIZON`.

Then run the repo bar for the files you touched.

```
cd frontend && bun run typecheck && bun test test/launch-selectors.test.ts test/launch-brief.test.ts test/launch-card.test.ts test/launch-map-brief.test.ts
pytest tests/test_launch_data.py tests/test_launch_assessment.py tests/test_launch_evidence.py
```

A go card is verified only when a fixture with a fresh TLE and a sub-800 km closest approach renders Shoot, Window, and Direction, and the 25 September feed still renders no Possible card.
