from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any

from sgp4.api import Satrec, jday

from .launch_orbit import UNVERIFIED, Branch, Inclination
from .orbit import TLE, _ensure_utc, _gmst_rad, great_circle_km

OFF_PLANE_MAX_DEG = 1.5
ISS_TLE_PLANE = "iss_tle_plane"
_ISS_DESTINATIONS = frozenset({"ISS", "International Space Station"})


class DirectionKind(StrEnum):
    ISS_PLANE = "iss_plane"
    MODELED = "modeled"
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
class Fan:
    branch: Branch | None
    azimuth_deg: float | None
    low_deg: float
    high_deg: float


@dataclass(frozen=True)
class NoDirection:
    kind: DirectionKind = DirectionKind.NONE
    azimuth_deg: None = None
    source: None = None
    off_plane_deg: None = None
    fans: tuple[Fan, ...] = ()
    fan_source: str = ""


@dataclass(frozen=True)
class ModeledDirection:
    azimuth_deg: float
    fans: tuple[Fan, ...]
    grade: str
    source: str
    reasons: tuple[str, ...]
    kind: DirectionKind = DirectionKind.MODELED
    off_plane_deg: None = None


Direction = IssPlaneDirection | ModeledDirection | NoDirection


@dataclass(frozen=True)
class LaunchSite:
    name: str
    lat: float
    lon: float
    sectors: tuple[tuple[float, float], ...]
    source: str = UNVERIFIED
    radius_km: float = 60.0


LAUNCH_SITES = (
    LaunchSite("Cape Canaveral and Kennedy", 28.5, -80.6, ((35, 140),)),
    LaunchSite("Vandenberg", 34.6, -120.6, ((130, 201),)),
    LaunchSite("Starbase", 26.0, -97.2, ((85, 105),)),
    LaunchSite("Wallops", 37.8, -75.5, ((90, 160),)),
    LaunchSite("Mahia", -39.3, 177.9, ((45, 200),)),
    LaunchSite("Kodiak", 57.4, -152.3, ((110, 220),)),
    LaunchSite("Baikonur", 46.0, 63.3, ((25, 70), (340, 355))),
    LaunchSite("Plesetsk", 62.9, 40.6, ((340, 95),)),
    LaunchSite("Vostochny", 51.9, 128.3, ((340, 95),)),
    LaunchSite("Kourou", 5.2, -52.8, ((350, 94),)),
    LaunchSite("Tanegashima and Uchinoura", 30.4, 131.0, ((85, 140),)),
    LaunchSite("Jiuquan", 41.0, 100.3, ((95, 110), (175, 200))),
    LaunchSite("Taiyuan", 38.9, 111.6, ((170, 200),)),
    LaunchSite("Xichang", 28.2, 102.0, ((95, 105),)),
    LaunchSite("Wenchang", 19.6, 111.0, ((90, 175),)),
    LaunchSite("Sriharikota", 13.7, 80.2, ((100, 140),)),
    LaunchSite("Andoya", 69.1, 15.6, ((330, 20),)),
)


def site_for(lat: float, lon: float) -> LaunchSite | None:
    """Match coordinates, independently of LL2 site and pad names."""
    nearest = min(LAUNCH_SITES, key=lambda site: great_circle_km(lat, lon, site.lat, site.lon))
    return (
        nearest
        if great_circle_km(lat, lon, nearest.lat, nearest.lon) <= nearest.radius_km
        else None
    )


def sector_contains(sector: tuple[float, float], azimuth: float) -> bool:
    low, high = sector
    return (azimuth - low) % 360 <= (high - low) % 360


def _angle_gap(left: float, right: float) -> float:
    return abs((left - right + 180.0) % 360.0 - 180.0)


def _fixed_azimuth(inertial_deg: float, lat: float) -> float:
    angle = math.radians(inertial_deg)
    east = 7.784 * math.sin(angle) - 0.4651 * math.cos(math.radians(lat))
    north = 7.784 * math.cos(angle)
    return math.degrees(math.atan2(east, north)) % 360.0


def model_direction(
    lat: float, lon: float, inclination: Inclination | None
) -> ModeledDirection | NoDirection:
    """Model both rotation-corrected branches within assumed site sectors."""
    site = site_for(lat, lon)
    site_source = (
        f"Assumed site sectors for {site.name}: {site.sectors}. {site.source}."
        if site
        else "Site corridor unknown."
    )
    if inclination is None:
        fans = tuple(Fan(None, None, low, high) for low, high in site.sectors) if site else ()
        return NoDirection(fans=fans, fan_source=site_source)
    inc = math.radians(inclination.deg)
    cosine = math.cos(math.radians(lat))
    ratio = (
        math.cos(inc) / cosine if abs(cosine) > 1e-12 else math.copysign(math.inf, math.cos(inc))
    )
    reasons: list[str] = []
    if abs(ratio) >= 1.0 - 1e-12 or inclination.branch_hint is Branch.EAST:
        candidates = [(Branch.EAST if ratio >= 0 else None, 90.0 if ratio >= 0 else 270.0, 10.0)]
        if abs(ratio) > 1.0 + 1e-12 or inclination.branch_hint is Branch.EAST:
            reasons.append("PLANE_CHANGE_LATER")
    else:
        north = math.degrees(math.asin(ratio))
        width = 2 + inclination.sigma_deg * abs(
            math.sin(inc) / (cosine * math.cos(math.radians(north)))
        )
        width = min(20.0, max(5.0, width))
        candidates = [
            (Branch.NORTHBOUND, _fixed_azimuth(north, lat), width),
            (Branch.SOUTHBOUND, _fixed_azimuth(180.0 - north, lat), width),
        ]
    if len(candidates) == 2 and inclination.branch_hint not in (None, Branch.EAST):
        candidates = [item for item in candidates if item[0] is inclination.branch_hint]
    allowed = [
        item
        for item in candidates
        if site is None or any(sector_contains(s, item[1]) for s in site.sectors)
    ]
    fans: list[Fan] = []
    if allowed:
        fans = [
            Fan(branch, az, (az - width) % 360, (az + width) % 360) for branch, az, width in allowed
        ]
    elif site is not None:
        edges = [edge for sector in site.sectors for edge in sector]
        for branch, desired, _width in candidates:
            edge = min(edges, key=lambda value: _angle_gap(value, desired))
            if _angle_gap(edge, desired) > 60.0:
                continue
            delta = (desired - edge + 180.0) % 360.0 - 180.0
            low = (edge + min(0, delta - _width)) % 360
            high = (edge + max(0, delta + _width)) % 360
            fans.append(Fan(branch, edge, low, high))
        if fans:
            reasons.append("DOGLEG_ASSUMED")
        else:
            unknown = tuple(Fan(None, None, low, high) for low, high in site.sectors)
            return NoDirection(
                fans=unknown, fan_source=f"Required azimuth outside assumed sectors. {site_source}"
            )
    if len(fans) > 1:
        reasons.append("BRANCH_AMBIGUOUS")
    if site is None:
        reasons.append("CORRIDOR_UNKNOWN")
    grade = (
        "C" if reasons or inclination.grade == "C" or inclination.source == UNVERIFIED else "B"
    )
    source = (
        f"Inclination {inclination.deg:g} deg from {inclination.basis.value}. "
        f"{inclination.source} {site_source} Not a published trajectory."
    )
    if "PLANE_CHANGE_LATER" in reasons:
        source += " Plane change comes later."
    if "DOGLEG_ASSUMED" in reasons:
        source += " DOGLEG assumed; initial heading is the nearest sector edge."
    return ModeledDirection(fans[0].azimuth_deg, tuple(fans), grade, source, tuple(reasons))


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
        when.year,
        when.month,
        when.day,
        when.hour,
        when.minute,
        when.second + when.microsecond / 1e6,
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
    lat: float,
    lon: float,
    gmst: float,
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
    left: tuple[float, float, float],
    right: tuple[float, float, float],
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
