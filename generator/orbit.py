"""ISS orbit propagation via sgp4. UTC end-to-end."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
from sgp4.api import Satrec, jday

EARTH_RADIUS_KM = 6378.137


@dataclass(frozen=True)
class TLE:
    line1: str
    line2: str
    epoch: datetime

    @classmethod
    def from_text(cls, text: str) -> TLE:
        lines = [ln for ln in text.strip().splitlines() if ln.strip()]
        if len(lines) < 2:
            raise ValueError("TLE must have at least 2 lines")
        l1, l2 = lines[-2], lines[-1]
        if not l1.startswith("1 ") or not l2.startswith("2 "):
            raise ValueError(f"malformed TLE: {l1!r} / {l2!r}")
        sat = Satrec.twoline2rv(l1, l2)
        epoch_yr = sat.epochyr + (2000 if sat.epochyr < 57 else 1900)
        epoch = datetime(epoch_yr, 1, 1, tzinfo=UTC) + timedelta(
            days=sat.epochdays - 1
        )
        return cls(line1=l1, line2=l2, epoch=epoch)


@dataclass(frozen=True)
class Position:
    lat: float
    lon: float
    alt_km: float
    when: datetime


def _ensure_utc(dt: datetime, name: str = "datetime") -> None:
    if dt.tzinfo is None or dt.tzinfo.utcoffset(dt) != timedelta(0):
        raise ValueError(f"{name} must be UTC-aware")


def _gmst_rad(when: datetime) -> float:
    """Greenwich Mean Sidereal Time (rad), IAU 1982 simplified."""
    jd = (
        367 * when.year
        - (7 * (when.year + (when.month + 9) // 12)) // 4
        + (275 * when.month) // 9
        + when.day
        + 1721013.5
        + (when.hour + when.minute / 60 + (when.second + when.microsecond / 1e6) / 3600) / 24
    )
    t = (jd - 2451545.0) / 36525.0
    gmst = (
        280.46061837
        + 360.98564736629 * (jd - 2451545.0)
        + 0.000387933 * t * t
        - t * t * t / 38710000.0
    )
    gmst = gmst % 360.0
    return math.radians(gmst)


def teme_to_geodetic(r: tuple[float, float, float], when: datetime) -> Position:
    """TEME ECI position (km) → geodetic lat/lon (deg) + altitude (km, spherical)."""
    _ensure_utc(when, "when")
    x, y, z = r
    gmst = _gmst_rad(when)
    x_ecef = x * math.cos(gmst) + y * math.sin(gmst)
    y_ecef = -x * math.sin(gmst) + y * math.cos(gmst)
    z_ecef = z
    r_total = math.sqrt(x_ecef * x_ecef + y_ecef * y_ecef + z_ecef * z_ecef)
    lat = math.degrees(math.asin(z_ecef / r_total))
    lon = math.degrees(math.atan2(y_ecef, x_ecef))
    if lon > 180:
        lon -= 360
    elif lon < -180:
        lon += 360
    return Position(lat=lat, lon=lon, alt_km=r_total - EARTH_RADIUS_KM, when=when)


def propagate(tle: TLE, when: datetime) -> Position:
    """Propagate the ISS to a UTC datetime; return geodetic position."""
    _ensure_utc(when, "when")
    sat = Satrec.twoline2rv(tle.line1, tle.line2)
    jd, fr = jday(
        when.year, when.month, when.day,
        when.hour, when.minute, when.second + when.microsecond / 1e6,
    )
    e, r, _v = sat.sgp4(jd, fr)
    if e != 0:
        raise RuntimeError(f"sgp4 propagation failed: error code {e}")
    return teme_to_geodetic(r, when)


def tle_age_hours(tle: TLE, now: datetime) -> float:
    _ensure_utc(now, "now")
    return (now - tle.epoch).total_seconds() / 3600.0


def freshness_factor(age_hours: float) -> float:
    """0..1 multiplier for confidence based on TLE age.
    1.0 if age <= 24h. Decay 10% per 12h past 24h. Floor 0.5."""
    if age_hours <= 24:
        return 1.0
    decay = ((age_hours - 24) / 12.0) * 0.10
    return max(0.5, 1.0 - decay)


@dataclass(frozen=True)
class Pass:
    target_id: str
    target_lat: float
    target_lon: float
    closest_approach: datetime
    nadir_distance_km: float
    iss_position: Position


def great_circle_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance, km. Spherical Earth."""
    rl1, rl2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin((rl2 - rl1) / 2) ** 2
        + math.cos(rl1) * math.cos(rl2) * math.sin(dl / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def angle_off_nadir_deg(ground_distance_km: float, altitude_km: float) -> float:
    """Angle from ISS nadir vector to the line-of-sight to a surface target.

    Spherical geometry, not flat-Earth — at ISS altitudes (~408 km) the
    curvature matters once ground distance gets past a few hundred km. The
    horizon limit (where the line of sight grazes Earth's surface) is
    `acos(R / (R+h))` ≈ 19.97° at the *Earth-center* angle, which works out
    to ~70° off-nadir as seen from ISS.

    Used for window selection: <30° = WORF (Destiny lab nadir window),
    ≥30° = Cupola (panoramic dome handles obliques well).
    """
    if ground_distance_km <= 0.0:
        return 0.0
    R = EARTH_RADIUS_KM
    theta = ground_distance_km / R  # angle subtended at Earth's center, radians
    sin_t = math.sin(theta)
    cos_t = math.cos(theta)
    # tan(alpha) = R sin θ / (R + h − R cos θ)
    alpha = math.atan2(R * sin_t, R + altitude_km - R * cos_t)
    return math.degrees(alpha)


def find_passes(
    tle: TLE,
    target: dict[str, Any],
    window_start: datetime,
    window_end: datetime,
    step_seconds: int = 30,
    max_distance_km: float = 800.0,
) -> list[Pass]:
    """Sample ground track at step_seconds; return local minima within max_distance_km of target."""
    _ensure_utc(window_start, "window_start")
    _ensure_utc(window_end, "window_end")
    if window_end <= window_start:
        return []
    lat_t = target["geom"]["lat"]
    lon_t = target["geom"]["lon"]
    target_id = target["id"]

    samples: list[tuple[datetime, Position, float]] = []
    t = window_start
    while t < window_end:
        pos = propagate(tle, t)
        d = great_circle_km(lat_t, lon_t, pos.lat, pos.lon)
        samples.append((t, pos, d))
        t = t + timedelta(seconds=step_seconds)

    passes: list[Pass] = []
    for i in range(1, len(samples) - 1):
        prev_d = samples[i - 1][2]
        curr_d = samples[i][2]
        next_d = samples[i + 1][2]
        if curr_d < prev_d and curr_d < next_d and curr_d < max_distance_km:
            passes.append(
                Pass(
                    target_id=target_id,
                    target_lat=lat_t,
                    target_lon=lon_t,
                    closest_approach=samples[i][0],
                    nadir_distance_km=curr_d,
                    iss_position=samples[i][1],
                )
            )
    return passes


_POLYNOMIAL_ORDER_CAP = 11
"""Hard cap on polyfit degree. Past 11, np.polyfit on ISS lat/lon over multiple
orbits gets numerically ill-conditioned (RankWarning, Runge oscillations near
window edges). For windows >180 min the right answer is to fit two shorter
polynomials (or run SGP4 client-side, see V3 plan) — not to crank degree
further. We keep the cap and let the frontend fall back to its slower path
when more accuracy is needed."""


def _polynomial_order_for_window(minutes: int) -> int:
    """Polynomial order scaled to the inter-tick window.
    ISS orbital period is ~93 min. Orders chosen to keep RMS error <0.05° lat over the window:
      <=30 min  → 5  (less than 1/3 orbit)
      <=60 min  → 7
      <=90 min  → 9
      else      → 11 (just under 2 orbits — capped for numerical stability)

    Past ~180 min, even order 13 starts to wobble at the edges. We cap at 11
    and let callers re-fit with shorter windows if they need finer-grained
    accuracy.
    """
    if minutes <= 30:
        return 5
    if minutes <= 60:
        return 7
    if minutes <= 90:
        return 9
    return _POLYNOMIAL_ORDER_CAP


def fit_iss_polynomial(
    tle: TLE, start: datetime, minutes: int = 120, samples: int | None = None
) -> dict[str, Any]:
    """Fit a polynomial in lat/lon vs t (seconds from start) for live frontend rendering.

    Order scales with `minutes` (see `_polynomial_order_for_window`). Longitude is
    unwrapped to handle antimeridian crossings within the window.
    """
    _ensure_utc(start, "start")
    order = _polynomial_order_for_window(minutes)
    if samples is None:
        # ~1 sample per minute; ensures over-determined fit at every order.
        samples = max(order * 4 + 1, minutes + 1)
    ts = np.linspace(0.0, minutes * 60.0, samples)
    lats = np.empty(samples)
    lons = np.empty(samples)
    for i, t in enumerate(ts):
        pos = propagate(tle, start + timedelta(seconds=float(t)))
        lats[i] = pos.lat
        lons[i] = pos.lon
    lons_unwrapped = np.degrees(np.unwrap(np.radians(lons)))
    lat_coeffs = np.polyfit(ts, lats, order).tolist()
    lon_coeffs = np.polyfit(ts, lons_unwrapped, order).tolist()
    return {
        "start": start.isoformat().replace("+00:00", "Z"),
        "duration_seconds": minutes * 60,
        "lat_coeffs": lat_coeffs,
        "lon_coeffs": lon_coeffs,
        "polynomial_order": order,
    }


def detect_reboost(prev: TLE | None, curr: TLE) -> bool:
    """Detect a likely orbit-raising reboost.

    A reboost adds energy → raises altitude → period lengthens → mean motion
    DECREASES. So `curr.no_kozai < prev.no_kozai` is the reboost direction.
    Threshold: > 0.005 rev/day decrease (the prior code used abs() and was
    flagging both reboosts AND debris-avoidance burns / TLE noise that goes
    the other way; this returns false on those non-reboost deltas).
    """
    if prev is None:
        return False
    prev_sat = Satrec.twoline2rv(prev.line1, prev.line2)
    curr_sat = Satrec.twoline2rv(curr.line1, curr.line2)
    # Positive delta = mean motion DECREASED = reboost.
    delta = prev_sat.no_kozai - curr_sat.no_kozai  # rad/min
    delta_revs_per_day = delta * (1440.0 / (2 * math.pi))
    return delta_revs_per_day > 0.005
