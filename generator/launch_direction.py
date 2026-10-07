from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any

from sgp4.api import Satrec, jday

from .orbit import TLE, _ensure_utc, _gmst_rad

OFF_PLANE_MAX_DEG = 1.5
ISS_TLE_PLANE = "iss_tle_plane"
_ISS_DESTINATIONS = frozenset({"ISS", "International Space Station"})


class DirectionKind(StrEnum):
    ISS_PLANE = "iss_plane"
    NONE = "none"


class Destination(StrEnum):
    ISS = "iss"
    OTHER = "other"
    UNSPECIFIED = "unspecified"


@dataclass(frozen=True)
class IssPlaneDirection:
    azimuth_deg: float
    off_plane_deg: float
    source: str = ISS_TLE_PLANE
    kind: DirectionKind = DirectionKind.ISS_PLANE


@dataclass(frozen=True)
class NoDirection:
    kind: DirectionKind = DirectionKind.NONE
    azimuth_deg: None = None
    source: None = None
    off_plane_deg: None = None


Direction = IssPlaneDirection | NoDirection


@dataclass(frozen=True)
class IssPlaneAtPad:
    prograde_azimuth_deg: float
    off_plane_toward_normal_deg: float


def destination_from_ll2(result: Mapping[str, Any]) -> Destination:
    """Read spacecraft destination. Launch titles and program names are not one."""
    labels = _destination_labels(result)
    if not labels:
        return Destination.UNSPECIFIED
    if any(label in _ISS_DESTINATIONS for label in labels):
        return Destination.ISS
    return Destination.OTHER


def direction_for(
    tle: TLE,
    when: datetime,
    lat: float,
    lon: float,
    destination: Destination,
) -> Direction:
    if destination is not Destination.ISS:
        return NoDirection()
    plane = _iss_plane(tle, when, lat, lon)
    if abs(plane.off_plane_toward_normal_deg) >= OFF_PLANE_MAX_DEG:
        return NoDirection()
    return IssPlaneDirection(
        azimuth_deg=plane.prograde_azimuth_deg,
        off_plane_deg=plane.off_plane_toward_normal_deg,
    )


def _destination_labels(result: Mapping[str, Any]) -> tuple[str, ...]:
    rocket = result.get("rocket")
    if not isinstance(rocket, Mapping):
        return ()
    stage = rocket.get("spacecraft_stage")
    if isinstance(stage, Mapping):
        stages: list[Any] = [stage]
    elif isinstance(stage, list):
        stages = stage
    else:
        return ()
    labels: list[str] = []
    for item in stages:
        if not isinstance(item, Mapping):
            continue
        label = _label(item.get("destination"))
        if label is not None:
            labels.append(label)
    return tuple(labels)


def _label(value: Any) -> str | None:
    if isinstance(value, str):
        text = value.strip()
        return text or None
    if isinstance(value, Mapping):
        return _label(value.get("name"))
    return None


def _iss_plane(tle: TLE, when: datetime, lat: float, lon: float) -> IssPlaneAtPad:
    _ensure_utc(when, "when")
    sat = Satrec.twoline2rv(tle.line1, tle.line2)
    jd, fr = jday(
        when.year, when.month, when.day,
        when.hour, when.minute, when.second + when.microsecond / 1e6,
    )
    error, radius, velocity = sat.sgp4(jd, fr)
    if error != 0:
        raise RuntimeError(f"sgp4 propagation failed: error code {error}")
    angular = _unit(_cross(radius, velocity))
    gmst = _gmst_rad(when)
    pad = _pad_eci(lat, lon, gmst)
    off_plane = math.degrees(math.asin(max(-1.0, min(1.0, _dot(angular, pad)))))
    prograde = _cross(angular, pad)
    east, north = _east_north(lat, lon, gmst)
    azimuth = math.degrees(math.atan2(_dot(prograde, east), _dot(prograde, north))) % 360.0
    return IssPlaneAtPad(prograde_azimuth_deg=azimuth, off_plane_toward_normal_deg=off_plane)


def _pad_eci(lat: float, lon: float, gmst: float) -> tuple[float, float, float]:
    lat_rad = math.radians(lat)
    lon_rad = math.radians(lon) + gmst
    return (
        math.cos(lat_rad) * math.cos(lon_rad),
        math.cos(lat_rad) * math.sin(lon_rad),
        math.sin(lat_rad),
    )


def _east_north(
    lat: float, lon: float, gmst: float,
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    lat_rad = math.radians(lat)
    lon_rad = math.radians(lon) + gmst
    east = (-math.sin(lon_rad), math.cos(lon_rad), 0.0)
    north = (
        -math.sin(lat_rad) * math.cos(lon_rad),
        -math.sin(lat_rad) * math.sin(lon_rad),
        math.cos(lat_rad),
    )
    return east, north


def _cross(
    left: tuple[float, float, float], right: tuple[float, float, float],
) -> tuple[float, float, float]:
    return (
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    )


def _dot(left: tuple[float, float, float], right: tuple[float, float, float]) -> float:
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]


def _unit(vector: tuple[float, float, float]) -> tuple[float, float, float]:
    norm = math.sqrt(_dot(vector, vector))
    if norm == 0.0:
        raise RuntimeError("orbital plane is undefined")
    return (vector[0] / norm, vector[1] / norm, vector[2] / norm)
