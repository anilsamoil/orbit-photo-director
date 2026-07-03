#!/usr/bin/env python3
"""Launch-visibility (OVERHEAD + ASCENT) pathway smoke test.

Runs the SAME synthesis the daemon runs (filter_launches / find_passes for
OVERHEAD, filter_ascent_launches / predict_ascent_pass for ASCENT) against
the on-disk LL2 cache and the cached ISS TLE, and prints a per-launch verdict
explaining WHY each launch does or does not produce a card. This answers the
recurring "is the launch pathway broken, or is +0 just correct right now?"
question without needing a live tick or LL2 quota.

It is read-only: it touches only data/cache/{launches.json,iss.tle} and never
writes published output. Cloud scoring is stubbed to clear-sky so the ONLY
thing that can reject an ASCENT instant is the geometry (tangent clearance +
umbra + plume) — which is exactly the pathway logic under test.

Usage:
    .venv/bin/python -m scripts.ascent_smoke          # uses real wall clock
    .venv/bin/python -m scripts.ascent_smoke --now 2026-06-10T13:50:00Z

Exit status is always 0 (it is a diagnostic, not a gate); read the output.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from generator.ascent import predict_ascent_pass
from generator.cloud import CloudSample
from generator.launch_data import (
    ASCENT_NET_WINDOW_MAX_SECONDS,
    LL2_GO_STATUS_ABBREVS,
    NET_WINDOW_MAX_SECONDS,
    PASS_WINDOW_SECONDS,
    filter_ascent_launches,
    filter_launches,
    parse_response,
)
from generator.orbit import TLE, find_passes
from generator.config import Settings

import json


@dataclass(frozen=True)
class _ClearSky:
    """A CloudSampler that always reports clear skies, so geometry — not
    cloud cover — decides whether an ASCENT instant survives."""

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        return CloudSample(cloud_fraction=0.0, sample_time=when, source="mock")


# Mirror main.py's OVERHEAD find_passes constants. Kept local so the smoke
# stays runnable even if main.py's module-level constants move.
PASS_SAMPLE_STEP_SECONDS = 5
PASS_MAX_DISTANCE_KM = 800.0


def _synth_target(la) -> dict:
    # Use the PRODUCTION target builder so this harness can never drift from
    # the schema find_passes expects again (2026-07-03: a hand-rolled copy
    # here predated the geom{} target shape and crashed the whole smoke).
    from generator.main import _synthesize_launch_target

    return _synthesize_launch_target(la)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--now", help="ISO8601 UTC override for 'now' (e.g. 2026-06-10T13:50:00Z)")
    args = ap.parse_args()

    settings = Settings.from_env()
    now = (
        datetime.fromisoformat(args.now.replace("Z", "+00:00"))
        if args.now
        else datetime.now(timezone.utc)
    )

    cache = settings.cache_dir / "launches.json"
    tle_path = settings.cache_dir / "iss.tle"
    payload = json.loads(cache.read_text())
    launches = parse_response(payload, now=now)
    tle = TLE.from_text(tle_path.read_text())

    print(f"now            : {now.isoformat()}")
    print(f"enable_ascent  : {settings.enable_ascent}")
    print(f"TLE epoch      : {tle.epoch.isoformat() if hasattr(tle, 'epoch') else '?'}")
    print(f"OVERHEAD gate  : status in {sorted(LL2_GO_STATUS_ABBREVS)} AND "
          f"net_window<= {NET_WINDOW_MAX_SECONDS}s (=PASS_WINDOW {PASS_WINDOW_SECONDS}s)")
    print(f"ASCENT gate    : status Go/Confirmed AND net_window<= {ASCENT_NET_WINDOW_MAX_SECONDS}s (6h)")
    print(f"future launches: {len(launches)}\n")

    overhead = {id(la): la for la in filter_launches(launches)}
    ascent = {id(la): la for la in filter_ascent_launches(launches)}

    sampler = _ClearSky()
    n_overhead_cards = 0
    n_ascent_cards = 0

    for la in launches:
        dh = (la.t0 - now).total_seconds() / 3600.0
        print(f"• {la.name[:48]:48} T0 {la.t0.isoformat()[:16]} ({dh:+.1f}h)")
        print(f"    status={la.status_abbrev!s:10} net_window={la.net_window_seconds}s "
              f"pad=({la.site_lat:.2f},{la.site_lon:.2f})")

        # OVERHEAD
        if id(la) in overhead:
            passes = find_passes(
                tle=tle,
                target=_synth_target(la),
                window_start=la.t0 - timedelta(seconds=PASS_WINDOW_SECONDS),
                window_end=la.t0 + timedelta(seconds=PASS_WINDOW_SECONDS),
                step_seconds=PASS_SAMPLE_STEP_SECONDS,
                max_distance_km=PASS_MAX_DISTANCE_KM,
            )
            if passes:
                n_overhead_cards += len(passes)
                print(f"    OVERHEAD: ✅ {len(passes)} pass(es) — ISS over pad within ±{PASS_WINDOW_SECONDS}s")
            else:
                print("    OVERHEAD: — eligible, but ISS does not pass over the pad in window")
        else:
            why = ("status not Go/Confirmed"
                   if la.status_abbrev not in LL2_GO_STATUS_ABBREVS
                   else f"net_window {la.net_window_seconds}s > {NET_WINDOW_MAX_SECONDS}s (window too wide to pin T0)")
            print(f"    OVERHEAD: skip — {why}")

        # ASCENT
        if settings.enable_ascent and id(la) in ascent:
            pred = predict_ascent_pass(
                launch={
                    "rocket": {"configuration": {"full_name": la.rocket_type}},
                    "mission": {"orbit": {"inclination": 51.6}},
                },
                pad_lat_deg=la.site_lat,
                pad_lon_deg=la.site_lon,
                t0_utc=la.t0,
                iss_tle=tle,
                cloud_sampler=sampler,
            )
            if pred is not None:
                n_ascent_cards += 1
                print(f"    ASCENT  : ✅ viewable instant found (score basis ok)")
            else:
                print("    ASCENT  : — eligible, but no instant clears geometry "
                      "(rocket eclipsed, ISS too far / below horizon, or no profile match)")
        elif id(la) in ascent and not settings.enable_ascent:
            print("    ASCENT  : skip — OPD_ENABLE_ASCENT disabled")
        else:
            print("    ASCENT  : skip — outside 6h NET window or status not Go")
        print()

    print(f"SUMMARY: {n_overhead_cards} OVERHEAD card(s), {n_ascent_cards} ASCENT card(s) "
          f"from {len(launches)} future launches.")
    print("Pathway is WORKING if filters/predict ran without error; +0 cards just means "
          "no launch currently satisfies the visibility geometry.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
