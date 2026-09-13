"""Cache-only planning brief, separate from validated camera instructions.

A directly visible launch site is a geometric possibility at the reported NET.
An unknown flight direction can still support a *nominal early-ascent* negative:
every point in a rocket family's modeled downrange disk remains behind Earth.
Neither result establishes plume brightness, station-window access, later burns,
or a result for a different liftoff time. No trajectory is invented here.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Protocol

from .ascent_profiles import match_rocket
from .launch_data import LL2_GO_STATUS_ABBREVS, Launch
from .launch_geometry import look_direction_at
from .orbit import EARTH_RADIUS_KM, TLE, Position, _ensure_utc, great_circle_km, propagate

PLANNING_VALID_SECONDS = 3 * 3600
EPHEMERIS_HORIZON_SECONDS = 24 * 3600
SCREEN_STEP_SECONDS = 30
MAX_WINDOW_SECONDS = 6 * 3600
# Deliberately generous ISS motion allowance between the nearest grid point
# and an unsampled instant: 12 km/s bounds typical ~7.7 km/s orbital motion
# plus Earth rotation. Also expand observer altitude by this displacement.
# An extra 250 km covers spherical-Earth/nominal-position imprecision. This is
# a conservative screen of the stated generic model, not a real-flight bound.
MAX_OBSERVER_SPEED_KM_S = 12.0
SCREEN_MARGIN_KM = 250.0
ASSESSMENT_REASONS = frozenset({
    "SITE_IN_VIEW_AT_NET", "NOMINAL_ASCENT_TOO_FAR", "VIEW_UNCONFIRMED",
    "TIMING_UNCONFIRMED", "EPHEMERIS_UNAVAILABLE", "EPHEMERIS_OUTSIDE_HORIZON",
    "SOURCE_UNAVAILABLE", "PROFILE_UNKNOWN", "EVALUATION_INCOMPLETE", "GEOMETRY_INVALID",
})


class Budget(Protocol):
    def take(self) -> bool: ...


class _BudgetExceededError(Exception):
    pass


def _utc(value: datetime) -> str:
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def _horizon_km(altitude_km: float) -> float:
    return EARTH_RADIUS_KM * math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitude_km))


def build_planning_assessment(
    launch: Launch,
    tle: TLE | None,
    now: datetime,
    fetched_at: datetime | None,
    budget: Budget,
    *,
    source_reasons: tuple[str, ...] = (),
) -> dict:
    """Keep NET and all advertised liftoff times as distinct propositions.

    The all-bearing screen uses the profile's MAX altitude/downrange at EVERY
    instant, so it overestimates the reachable/visible region. It rejects only
    when that whole disk stays occulted with temporal and spatial margins.
    A disk intersection is unknown, never proof that a rocket is visible.
    """
    _ensure_utc(now)
    if fetched_at is not None:
        _ensure_utc(fetched_at)
    profile = match_rocket({"full_name": launch.rocket_type})
    model = None if profile is None else {
        "name": profile.name,
        "duration_seconds": profile.insertion_t_seconds,
        "max_altitude_km": max(sample.altitude_km for sample in profile.samples),
        "max_downrange_km": max(sample.downrange_km for sample in profile.samples),
    }
    valid_until = now + timedelta(seconds=PLANNING_VALID_SECONDS)
    source_usable = (fetched_at is not None
                     and 0 <= (now - fetched_at).total_seconds() < PLANNING_VALID_SECONDS
                     and not set(source_reasons) & {
                         "SOURCE_AGE_MTIME_ONLY", "SOURCE_AGE_UNKNOWN", "REPLAY_SOURCE_MISMATCH",
                     })
    if source_usable:
        deadline = min(valid_until, fetched_at + timedelta(seconds=PLANNING_VALID_SECONDS))
        # Public timestamps use seconds. Never serialize a positive verdict
        # with an already-zero lease after dropping subsecond precision.
        source_usable = _utc(deadline) > _utc(now)
        if source_usable:
            valid_until = deadline
    assessment = {
        "checked_at": _utc(now),
        "valid_until": _utc(valid_until),
        "tle_epoch": _utc(tle.epoch) if tle else None,
        "model": model,
        "net": {
            "verdict": "unknown", "reason": "VIEW_UNCONFIRMED", "at": _utc(launch.t0),
            "pad_distance_km": None, "look": None,
        },
        "window": {"verdict": "unknown", "reason": "VIEW_UNCONFIRMED"},
    }

    def unknown(reason: str) -> dict:
        assessment["net"]["reason"] = reason
        assessment["window"]["reason"] = reason
        return assessment

    if not source_usable:
        return unknown("SOURCE_UNAVAILABLE")
    if (launch.t0 < now or launch.timing_reasons
            or launch.status_abbrev not in LL2_GO_STATUS_ABBREVS):
        return unknown("TIMING_UNCONFIRMED")
    if tle is None:
        return unknown("EPHEMERIS_UNAVAILABLE")
    if (abs((now - tle.epoch).total_seconds()) > EPHEMERIS_HORIZON_SECONDS
            or abs((launch.t0 - tle.epoch).total_seconds()) > EPHEMERIS_HORIZON_SECONDS):
        return unknown("EPHEMERIS_OUTSIDE_HORIZON")

    positions: dict[datetime, Position] = {}

    def position_at(when: datetime) -> Position:
        if when not in positions:
            if not budget.take():
                raise _BudgetExceededError
            position = propagate(tle, when)
            if (not all(math.isfinite(v) for v in (position.lat, position.lon, position.alt_km))
                    or not -90 <= position.lat <= 90 or not -180 <= position.lon <= 180
                    or not 100 <= position.alt_km <= 1000):
                raise ValueError("invalid ISS position")
            positions[when] = position
        return positions[when]

    def too_far(start: datetime, end: datetime) -> bool:
        seconds = int(math.ceil((end - start).total_seconds()))
        offsets = sorted({*range(0, seconds + 1, SCREEN_STEP_SECONDS), seconds})
        displacement = MAX_OBSERVER_SPEED_KM_S * SCREEN_STEP_SECONDS / 2
        for offset in offsets:
            position = position_at(start + timedelta(seconds=offset))
            distance = great_circle_km(position.lat, position.lon, launch.site_lat, launch.site_lon)
            reach = (_horizon_km(position.alt_km + displacement)
                     + _horizon_km(model["max_altitude_km"])
                     + model["max_downrange_km"] + displacement + SCREEN_MARGIN_KM)
            if distance <= reach:
                return False
        return True

    try:
        position = position_at(launch.t0)
        distance = great_circle_km(position.lat, position.lon, launch.site_lat, launch.site_lon)
        assessment["net"]["pad_distance_km"] = round(distance, 1)
        if distance < _horizon_km(position.alt_km):
            assessment["net"].update(
                verdict="possible", reason="SITE_IN_VIEW_AT_NET",
                look=look_direction_at(tle, launch.t0, launch.site_lat, launch.site_lon, 0),
            )
        elif model is None:
            assessment["net"]["reason"] = "PROFILE_UNKNOWN"
        else:
            end = launch.t0 + timedelta(seconds=model["duration_seconds"])
            if abs((end - tle.epoch).total_seconds()) > EPHEMERIS_HORIZON_SECONDS:
                assessment["net"]["reason"] = "EPHEMERIS_OUTSIDE_HORIZON"
            elif too_far(launch.t0, end):
                assessment["net"].update(verdict="too_far", reason="NOMINAL_ASCENT_TOO_FAR")

        start, end = launch.window_start, launch.window_end
        if model is None:
            assessment["window"]["reason"] = "PROFILE_UNKNOWN"
        elif (start is None or end is None or end < start or start < launch.t0
              or (end - start).total_seconds() > MAX_WINDOW_SECONDS):
            assessment["window"]["reason"] = "TIMING_UNCONFIRMED"
        elif abs((end + timedelta(seconds=model["duration_seconds"])
                  - tle.epoch).total_seconds()) > EPHEMERIS_HORIZON_SECONDS:
            assessment["window"]["reason"] = "EPHEMERIS_OUTSIDE_HORIZON"
        elif too_far(start, end + timedelta(seconds=model["duration_seconds"])):
            assessment["window"].update(verdict="too_far", reason="NOMINAL_ASCENT_TOO_FAR")
    except _BudgetExceededError:
        # Completed NET evidence remains useful if the wider window used up the
        # budget. An unfinished negative/positive is never promoted.
        if assessment["net"]["verdict"] == "unknown":
            assessment["net"]["reason"] = "EVALUATION_INCOMPLETE"
        assessment["window"]["reason"] = "EVALUATION_INCOMPLETE"
    except (ValueError, RuntimeError, ArithmeticError):
        assessment["net"].update(verdict="unknown", reason="GEOMETRY_INVALID", look=None)
        assessment["window"].update(verdict="unknown", reason="GEOMETRY_INVALID")
    return assessment
