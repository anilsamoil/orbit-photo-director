"""Bounded minute sampling and full early-ascent estimate tracks."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from .ascent import rocket_position_at
from .ascent_profiles import AscentProfile
from .launch_data import Launch
from .launch_direction import ModeledDirection, NoDirection
from .launch_evidence import MAX_LIFTOFF_SECONDS, EvaluationBudget
from .launch_opportunities import (
    CLIMB_AFTER_S,
    PREP_BEFORE_S,
    Ascent,
    LiftoffScenario,
    Pad,
    sample_liftoff,
)
from .orbit import EARTH_RADIUS_KM, TLE, Position, great_circle_km, propagate

ISS_GROUND_SPEED_BOUND_KM_S = 8.5


@dataclass(frozen=True)
class ModeledSample:
    scenario: LiftoffScenario
    direction: ModeledDirection


@dataclass(frozen=True)
class LiftoffScan:
    samples: tuple[ModeledSample, ...]
    checked: int
    total: int
    prescreened: int
    incomplete: bool


class ScanIncompleteError(Exception):
    pass


def scan_liftoffs(launch: Launch) -> tuple[datetime, ...]:
    start, end = launch.window_start, launch.window_end
    if start is None or end is None or end < start:
        return ()
    start = max(start, launch.t0)
    if end < start or (end - start).total_seconds() > MAX_LIFTOFF_SECONDS:
        return ()
    values = [
        start + timedelta(seconds=offset)
        for offset in range(0, int((end - start).total_seconds()) + 1, 60)
    ]
    if not values or values[-1] != end:
        values.append(end)
    return tuple(values)


def _horizon_km(altitude: float) -> float:
    return EARTH_RADIUS_KM * math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + max(0, altitude)))


def too_far_to_sample(
    liftoff: datetime,
    observer: Callable[[datetime], Position],
    pad: Pad,
    profile: AscentProfile,
) -> bool:
    """Exclude only beyond both horizons, maximum travel and ISS motion margin."""
    end = min(CLIMB_AFTER_S, profile.insertion_t_seconds)
    offsets = (-PREP_BEFORE_S, 0, end / 2, end)
    positions = [observer(liftoff + timedelta(seconds=offset)) for offset in offsets]
    max_gap = max(right - left for left, right in zip(offsets, offsets[1:], strict=False))
    motion_margin = max_gap / 2 * ISS_GROUND_SPEED_BOUND_KM_S + 300
    max_altitude = max(sample.altitude_km for sample in profile.samples)
    max_downrange = max(sample.downrange_km for sample in profile.samples)
    bound = (
        _horizon_km(max(position.alt_km for position in positions) + 100)
        + _horizon_km(max_altitude)
        + max_downrange
        + motion_margin
    )
    return all(great_circle_km(pos.lat, pos.lon, pad.lat, pad.lon) > bound for pos in positions)


def scan_modeled_liftoffs(
    launch: Launch,
    tle: TLE,
    profile: AscentProfile,
    direction: ModeledDirection,
    budget: EvaluationBudget,
) -> LiftoffScan:
    liftoffs = scan_liftoffs(launch)
    pad = Pad(launch.site_lat, launch.site_lon)
    samples: list[ModeledSample] = []
    checked = 0
    prescreened = 0

    def observer(when: datetime) -> Position:
        if not budget.take():
            raise ScanIncompleteError
        return propagate(tle, when)

    try:
        for liftoff in liftoffs:
            if too_far_to_sample(liftoff, observer, pad, profile):
                prescreened += 1
            else:
                for fan in direction.fans:
                    if fan.azimuth_deg is None:
                        raise ValueError("modeled fan needs a nominal azimuth")
                    candidate = replace(direction, azimuth_deg=fan.azimuth_deg)
                    scenario = sample_liftoff(
                        liftoff,
                        observer,
                        pad,
                        Ascent(profile, fan.azimuth_deg),
                    )
                    samples.append(ModeledSample(scenario, candidate))
            checked += 1
    except ScanIncompleteError:
        return LiftoffScan(tuple(samples), checked, len(liftoffs), prescreened, True)
    return LiftoffScan(tuple(samples), checked, len(liftoffs), prescreened, False)


def _profile_track(
    profile: AscentProfile | None,
    lat: float,
    lon: float,
    azimuth: float,
    step: int,
) -> list[dict]:
    if profile is None:
        return []
    end = min(CLIMB_AFTER_S, profile.insertion_t_seconds)
    offsets = list(range(0, end + 1, step))
    if offsets[-1] != end:
        offsets.append(end)
    track: list[dict] = []
    for offset in offsets:
        point_lat, point_lon, alt, _confidence = rocket_position_at(
            profile, offset, lat, lon, azimuth
        )
        track.append(
            {
                "t_offset_s": offset,
                "lat": round(point_lat, 5),
                "lon": round(point_lon, 5),
                "alt_km": round(max(0, alt), 3),
            }
        )
    return track


def ascent_block(
    direction: ModeledDirection | NoDirection,
    profile: AscentProfile | None,
    launch: Launch,
) -> dict | None:
    if not direction.fans:
        return None
    return {
        "grade": direction.grade if isinstance(direction, ModeledDirection) else "D",
        "source": direction.source
        if isinstance(direction, ModeledDirection)
        else direction.fan_source,
        "fans": [
            {
                "branch": fan.branch.value if fan.branch is not None else None,
                "azimuth_deg": None if fan.azimuth_deg is None else round(fan.azimuth_deg, 4) % 360,
                "low_deg": round(fan.low_deg, 4),
                "high_deg": round(fan.high_deg, 4),
                "track": []
                if fan.azimuth_deg is None
                else _profile_track(
                    profile,
                    launch.site_lat,
                    launch.site_lon,
                    fan.azimuth_deg,
                    30,
                ),
                "low_track": _profile_track(
                    profile, launch.site_lat, launch.site_lon, fan.low_deg, 120
                ),
                "high_track": _profile_track(
                    profile, launch.site_lat, launch.site_lon, fan.high_deg, 120
                ),
            }
            for fan in direction.fans
        ],
    }
