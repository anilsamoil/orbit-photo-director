"""Line of sight from the station to a pad and to a rocket on ascent."""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum

from .ascent import (
    SunState,
    _geodetic_to_ecef,
    _surface_sun_elevation_deg,
    apparent_plume_angle_mrad,
    rocket_position_at,
    rocket_sun_state,
    slant_range_km,
    tangent_clearance,
)
from .ascent_profiles import AscentProfile
from .launch_direction import Direction, IssPlaneDirection, NoDirection
from .orbit import EARTH_RADIUS_KM, Position, _ensure_utc

SLANT_CAP_KM = 3500.0
SAMPLE_STEP_S = 5
EDGE_STEP_S = 1
PREP_BEFORE_S = 5 * 60
CLIMB_AFTER_S = 10 * 60
TWILIGHT_SUN_ELEV_DEG = -6.0


class Subject(StrEnum):
    PAD = "pad"
    ASCENT = "ascent"


class LightMode(StrEnum):
    TWILIGHT_PLUME = "twilight_plume"
    DAY_PLUME = "day_plume"
    NIGHT_ENGINE = "night_engine"
    PAD_DAY = "pad_day"
    PAD_NIGHT = "pad_night"


@dataclass(frozen=True)
class Pad:
    lat: float
    lon: float


@dataclass(frozen=True)
class Ascent:
    profile: AscentProfile
    azimuth_deg: float


@dataclass(frozen=True)
class Sight:
    subject: Subject
    liftoff: datetime
    when: datetime
    t_offset_s: int
    lat: float
    lon: float
    alt_km: float
    line_of_sight: bool
    slant_km: float
    limb_margin_deg: float
    light: LightMode
    plume_mrad: float | None
    in_plan: bool


@dataclass(frozen=True)
class VisibleSpan:
    """One contiguous in-plan run for one subject and one liftoff."""

    subject: Subject
    liftoff: datetime
    start: datetime
    end: datetime
    closest: Sight
    start_sight: Sight | None = None
    end_sight: Sight | None = None


@dataclass(frozen=True)
class LiftoffScenario:
    liftoff: datetime
    sights: tuple[Sight, ...]
    spans: tuple[VisibleSpan, ...]


def limb_margin_deg(
    observer: Position, lat: float, lon: float, alt_km: float,
) -> float:
    """Degrees the subject sits above the geometric Earth limb."""
    origin = _geodetic_to_ecef(observer.lat, observer.lon, observer.alt_km)
    target = _geodetic_to_ecef(lat, lon, alt_km)
    los = tuple(b - a for a, b in zip(origin, target, strict=True))
    los_norm = math.sqrt(sum(c * c for c in los))
    radius = math.sqrt(sum(c * c for c in origin))
    if los_norm == 0.0 or radius == 0.0:
        elev = -90.0
    else:
        sin_elev = sum(a * b for a, b in zip(los, origin, strict=True)) / (los_norm * radius)
        elev = math.degrees(math.asin(max(-1.0, min(1.0, sin_elev))))
    ratio = EARTH_RADIUS_KM / radius if radius else 1.0
    limb_elev = -math.degrees(math.acos(max(-1.0, min(1.0, ratio))))
    return elev - limb_elev


def sight_at(
    observer: Position,
    when: datetime,
    liftoff: datetime,
    subject: Subject,
    lat: float,
    lon: float,
    alt_km: float,
) -> Sight:
    _ensure_utc(when, "when")
    _ensure_utc(liftoff, "liftoff")
    offset = int((when - liftoff).total_seconds())
    visible = tangent_clearance(observer, lat, lon, alt_km)
    slant = slant_range_km(observer, lat, lon, alt_km)
    margin = limb_margin_deg(observer, lat, lon, alt_km)
    sun = rocket_sun_state(when, lat, lon, alt_km)
    surface_elev = _surface_sun_elevation_deg(when, lat, lon)
    nadir_elev = _surface_sun_elevation_deg(when, observer.lat, observer.lon)
    light = _light(subject, sun, margin, nadir_elev, surface_elev)
    plume = None if subject is Subject.PAD else apparent_plume_angle_mrad(slant, alt_km)
    return Sight(
        subject=subject,
        liftoff=liftoff,
        when=when,
        t_offset_s=offset,
        lat=lat,
        lon=lon,
        alt_km=alt_km,
        line_of_sight=visible,
        slant_km=slant,
        limb_margin_deg=margin,
        light=light,
        plume_mrad=plume,
        in_plan=visible and slant <= SLANT_CAP_KM,
    )


def sample_liftoff(
    liftoff: datetime,
    observer_at: Callable[[datetime], Position],
    pad: Pad,
    ascent: Ascent | None,
) -> LiftoffScenario:
    """Sample one liftoff from T-5 min through T+10 min."""
    _ensure_utc(liftoff, "liftoff")
    if ascent is not None:
        azimuth = ascent.azimuth_deg
        if (
            isinstance(azimuth, bool)
            or not isinstance(azimuth, (int, float))
            or not 0.0 <= azimuth < 360.0
        ):
            raise ValueError("azimuth_deg must be in [0, 360)")
    sights = _grid(liftoff, observer_at, pad, ascent)
    spans = _spans(liftoff, observer_at, pad, ascent, sights)
    return LiftoffScenario(liftoff=liftoff, sights=tuple(sights), spans=tuple(spans))


def sample_liftoffs(
    liftoffs: Sequence[datetime],
    observer_at: Callable[[datetime], Position],
    pad: Pad,
    ascent: Ascent | None,
) -> tuple[LiftoffScenario, ...]:
    return tuple(
        sample_liftoff(liftoff, observer_at, pad, ascent) for liftoff in liftoffs
    )


def sample_directed(
    liftoff: datetime,
    observer_at: Callable[[datetime], Position],
    pad: Pad,
    profile: AscentProfile,
    direction: Direction,
) -> LiftoffScenario:
    if isinstance(direction, IssPlaneDirection):
        ascent = Ascent(profile, direction.azimuth_deg)
    elif isinstance(direction, NoDirection):
        ascent = None
    else:
        raise TypeError(f"unknown direction {type(direction).__name__}")
    return sample_liftoff(liftoff, observer_at, pad, ascent)


def _light(
    subject: Subject,
    sun: SunState,
    limb_margin: float,
    nadir_elev: float,
    surface_elev: float,
) -> LightMode:
    if subject is Subject.PAD:
        return LightMode.PAD_DAY if surface_elev > 0.0 else LightMode.PAD_NIGHT
    if sun is SunState.UMBRA:
        return LightMode.NIGHT_ENGINE
    if limb_margin > 0.0:
        dark = nadir_elev <= TWILIGHT_SUN_ELEV_DEG
    else:
        dark = surface_elev <= TWILIGHT_SUN_ELEV_DEG
    return LightMode.TWILIGHT_PLUME if dark else LightMode.DAY_PLUME


def _at(
    liftoff: datetime,
    observer_at: Callable[[datetime], Position],
    pad: Pad,
    ascent: Ascent | None,
    subject: Subject,
    offset: int,
) -> Sight:
    when = liftoff + timedelta(seconds=offset)
    if subject is Subject.PAD:
        lat, lon, alt = pad.lat, pad.lon, 0.0
    else:
        lat, lon, alt, _confidence = rocket_position_at(
            ascent.profile, offset, pad.lat, pad.lon, ascent.azimuth_deg,
        )
    return sight_at(observer_at(when), when, liftoff, subject, lat, lon, alt)


def _offsets(start: int, end: int) -> list[int]:
    values = list(range(start, end + 1, SAMPLE_STEP_S))
    if not values or values[-1] != end:
        values.append(end)
    return values


def _grid(
    liftoff: datetime,
    observer_at: Callable[[datetime], Position],
    pad: Pad,
    ascent: Ascent | None,
) -> list[Sight]:
    sights: list[Sight] = []
    for offset in _offsets(-PREP_BEFORE_S, CLIMB_AFTER_S):
        sights.append(_at(liftoff, observer_at, pad, ascent, Subject.PAD, offset))
    if ascent is not None:
        end = min(CLIMB_AFTER_S, ascent.profile.insertion_t_seconds)
        for offset in _offsets(0, end):
            sights.append(_at(liftoff, observer_at, pad, ascent, Subject.ASCENT, offset))
    sights.sort(key=lambda sample: (sample.t_offset_s, sample.subject))
    return sights


def _spans(
    liftoff: datetime,
    observer_at: Callable[[datetime], Position],
    pad: Pad,
    ascent: Ascent | None,
    sights: list[Sight],
) -> list[VisibleSpan]:
    spans: list[VisibleSpan] = []
    for subject in (Subject.PAD, Subject.ASCENT):
        row = [sample for sample in sights if sample.subject is subject]
        spans.extend(_runs(liftoff, observer_at, pad, ascent, subject, row))
    spans.sort(key=lambda span: (span.start, span.subject))
    return spans


def _runs(
    liftoff: datetime,
    observer_at: Callable[[datetime], Position],
    pad: Pad,
    ascent: Ascent | None,
    subject: Subject,
    row: list[Sight],
) -> list[VisibleSpan]:
    spans: list[VisibleSpan] = []
    index = 0
    while index < len(row):
        if not row[index].in_plan:
            index += 1
            continue
        start_i = index
        while index < len(row) and row[index].in_plan:
            index += 1
        end_i = index - 1
        start = _refine_start(
            liftoff, observer_at, pad, ascent, subject, row, start_i,
        )
        end = _refine_end(
            liftoff, observer_at, pad, ascent, subject, row, end_i,
        )
        candidates = [start, *row[start_i:end_i + 1], end]
        closest = min(candidates, key=lambda sample: (sample.slant_km, sample.t_offset_s))
        spans.append(VisibleSpan(
            subject=subject,
            liftoff=liftoff,
            start=start.when,
            end=end.when,
            closest=closest,
            start_sight=start,
            end_sight=end,
        ))
    return spans


def _refine_start(
    liftoff: datetime,
    observer_at: Callable[[datetime], Position],
    pad: Pad,
    ascent: Ascent | None,
    subject: Subject,
    row: list[Sight],
    start_i: int,
) -> Sight:
    first = row[start_i]
    if start_i == 0:
        return first
    previous = row[start_i - 1].t_offset_s
    found = first
    offset = previous + EDGE_STEP_S
    while offset < first.t_offset_s:
        sample = _at(liftoff, observer_at, pad, ascent, subject, offset)
        if sample.in_plan:
            return sample
        offset += EDGE_STEP_S
    return found


def _refine_end(
    liftoff: datetime,
    observer_at: Callable[[datetime], Position],
    pad: Pad,
    ascent: Ascent | None,
    subject: Subject,
    row: list[Sight],
    end_i: int,
) -> Sight:
    last = row[end_i]
    if end_i == len(row) - 1:
        return last
    nxt = row[end_i + 1].t_offset_s
    found = last
    offset = last.t_offset_s + EDGE_STEP_S
    while offset < nxt:
        sample = _at(liftoff, observer_at, pad, ascent, subject, offset)
        if not sample.in_plan:
            break
        found = sample
        offset += EDGE_STEP_S
    return found
