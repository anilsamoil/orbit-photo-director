# Launch shooting brief: investigation and acceptance

## Problem and cause

The September 13 live map had a current launch schedule, but its entire launch
strip was yellow and led with `MAP ONLY`, pagination and validation reasons.
The card supplied an unknown capture interval rather than answering whether the
launch was worth looking for. The producer deliberately marked all events
map-only, and the display used that camera-admission state as the shooting
verdict. This was not a stuck publisher: its 08:56 UTC artifact correctly used
the authenticated 08:52 UTC source receipt.

## Change

The nearest launch now has a compact banner with time, site and a plain shooting
verdict. Details and other launches are collapsed; a later possible shot is
flagged on the other-launches summary. The map action focuses the current
revision's site and only a supplied corridor, releases ISS-follow, and preserves
the map's selected time.

The independent planning assessment can identify a directly visible launch site
at NET or a nominal early-ascent exclusion even without a known launch heading.
NET and the full launch window remain separate. The V2 contract documents the
model, freshness, source and ephemeris bounds, and the unchanged camera gates.
Directions describe the launch site in the ISS orbital frame, with clouds and
physical window access explicitly unresolved.

Review additionally identified a stale-revision hazard: after observing a newer
pointer, a failed body download could retain the old concrete verdict. The
consumer must withdraw superseded planning and camera evidence, including after
reload or an old-pointer response, until a coherent replacement validates.

## Today's independent check

[SpaceX's O3b mission page](https://www.spacex.com/launches/mpower-f), checked
September 13 around 09:25 UTC, lists 18:49 UTC with an 87-minute launch window.
The site's timeline includes a later second-stage burn about thirty minutes
after liftoff, outside the nominal first-nine-minute assessment.

The cached ISS TLE and the [NASA public ISS ephemeris](https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt)
agree within 2.17 km over the window plus early ascent. The NASA file was created
September 11 at 15:11:13 UTC and covers September 11–26. At the opening NET the
ISS-to-Cape ground distance is about 14,627 km. Even a sensitivity model allowing
1,000 km altitude and 5,000 km downrange remains Earth-occulted for the first nine
minutes. This supports the nominal **too far at the planned time** verdict.
Around 19:46 UTC the geometry is much closer, so a delayed launch must be
reassessed; the whole-window verdict remains unknown. No camera direction is
inferred for this event.

Numerical research uses a spherical Earth, NASA OEM interpolation, approximate
Earth rotation and one-second samples. These assumptions are sufficient for the
large opening-time exclusion margin; they do not certify optical visibility or
borderline actual trajectories. Research files and reproducible calculations
are retained in the local `launch-brief-research-20260913` artifact directory.

## Release and verification

Deploy the accepting frontend before the separate pinned publisher. Older strict
clients need to reopen `/api/app` to load this version; preserve personal site
data. Publisher policy 2 intentionally recomputes once for the same receipt,
without replacing the owner state or adding a source fetcher or sender.

Frontend: 1,610 tests across 88 files passed; typecheck and production build
passed after the final integration fixes. Backend: 1,177 tests passed, 90.02% generator coverage (85% required), new
assessment module 100%; Ruff passed. Focused frontend cases include positive,
negative, unknown, NET/window distinction, expired/offline evidence, parser
admission parity, superseding-pointer failure/replay/reload/recovery, dateline
focus and pending map loading. Independent review
checked geometry and cross-language artifact admission. Final frontend, CI,
runtime and live UI receipts are recorded in canonical OpenClaw shared state.

Browser-tool local navigation was blocked before the fixture page loaded;
synthetic verdict branches are covered by automated tests. Production UI checks
must verify the deployed banner and mobile layout. The current hourly-cadence
48-hour observation period cannot be called complete before September 14 at
07:53:10 UTC. No long-term optical or unattended reliability claim is made here.

Rollback should retain the current owner receipt. Reverting publisher code can
publish a new-generation artifact without assessment; the accepting frontend
supports it. Do not replay an older pointer or clear publication ownership to
bypass a conflict. Existing frontend assets are retained for reversible UI
rollback; no personal targets, ratings or login state are changed.
