"""Independent 3D launch look directions in an observer's orbital frame.

SGP4 supplies Earth-centered TEME position and velocity. Rocket coordinates
use orbit.py's spherical Earth and inverse GMST rotation into approximate
TEME, with UTC standing in for UT1 and no polar-motion correction. This is
not EME2000/OEM verification, station body attitude, or window-attitude
verification. A direction alone does not establish visibility or access.
"""

from __future__ import annotations

import math
from datetime import datetime
from functools import lru_cache
from numbers import Real

from sgp4.api import SGP4_ERRORS, Satrec, jday

from .orbit import EARTH_RADIUS_KM, TLE, _ensure_utc, _gmst_rad

_Vector3 = tuple[float, float, float]
# Dimensionless sine-angle tolerance, applied only to normalized directions.
_DIRECTION_EPS = 1e-12


def _finite_float(value: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a finite real number")
    try:
        result = float(value)
    except (OverflowError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite real number") from exc
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite real number")
    return result


def _vector3(value: _Vector3, name: str) -> _Vector3:
    try:
        x, y, z = value
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must contain exactly three finite real numbers") from exc
    return (
        _finite_float(x, name),
        _finite_float(y, name),
        _finite_float(z, name),
    )


def _unit(vector: _Vector3, name: str) -> _Vector3:
    scale = max(abs(component) for component in vector)
    if scale == 0.0:
        raise ValueError(f"{name} must be nonzero")
    # Scaling first avoids both overflow and underflow in the vector norm.
    x, y, z = (component / scale for component in vector)
    norm = math.hypot(x, y, z)
    return x / norm, y / norm, z / norm


def _dot(a: _Vector3, b: _Vector3) -> float:
    return math.fsum(x * y for x, y in zip(a, b, strict=True))


def _cross(a: _Vector3, b: _Vector3) -> _Vector3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def orbital_look_direction(
    observer_position: _Vector3,
    observer_velocity: _Vector3,
    target_position: _Vector3,
) -> dict[str, str | float]:
    """Return orbital-relative azimuth and off-nadir angle in degrees.

    All vectors must share one Earth-centered inertial frame and epoch;
    positions are km and velocity is km/s. Nadir is -unit(r), along is
    unit(v - proj_r(v)), and right is along cross nadir. For the unit line
    of sight q, azimuth is atan2(q.right, q.along) in [0, 360), while
    off-nadir is acos(q.nadir) in [0, 180]. Thus 0/90/180/270 azimuth means
    ahead/right/aft/left, not compass bearing or station body orientation.

    At nadir (transverse q magnitude <= 1e-12), return off-nadir 0 and
    azimuth 0 by convention: this azimuth is meaningless, NOT "ahead".
    The opposite pole (zenith) raises ValueError for undefined azimuth.
    Zero r or v, collinear/nearly radial v (transverse unit-v magnitude
    <= 1e-12), coincident positions, nonfinite values, and overflowing
    subtraction also raise ValueError. A target at the origin is valid
    pure geometry (nadir); this function does not test Earth occultation.
    """
    position = _vector3(observer_position, "observer_position")
    velocity = _vector3(observer_velocity, "observer_velocity")
    target = _vector3(target_position, "target_position")
    radial = _unit(position, "observer_position")
    velocity_unit = _unit(velocity, "observer_velocity")
    radial_speed = _dot(velocity_unit, radial)
    transverse = tuple(v - radial_speed * r for v, r in zip(velocity_unit, radial, strict=True))
    if math.hypot(*transverse) <= _DIRECTION_EPS:
        raise ValueError("observer_velocity is collinear with observer_position; along unresolved")
    nadir = tuple(-component for component in radial)
    along = _unit(transverse, "along direction")
    right = _unit(_cross(along, nadir), "right direction")
    # Restore orthogonality after cancellation in the radial projection.
    along = _unit(_cross(nadir, right), "along direction")
    displacement = _vector3(
        tuple(t - r for t, r in zip(target, position, strict=True)), "line of sight",
    )
    q = _unit(displacement, "line of sight")
    forward, sideways, down = _dot(q, along), _dot(q, right), _dot(q, nadir)
    if math.hypot(forward, sideways) <= _DIRECTION_EPS:
        if down <= 0.0:
            raise ValueError("azimuth is undefined at zenith")
        azimuth, off_nadir = 0.0, 0.0
    else:
        azimuth = math.degrees(math.atan2(sideways, forward)) % 360.0
        # A very small negative angle can round up to exactly 360 on modulo.
        if azimuth == 360.0:
            azimuth = 0.0
        off_nadir = math.degrees(math.acos(max(-1.0, min(1.0, down))))
    return {
        "frame": "orbital-lvlh",
        "azimuth_deg": azimuth,
        "off_nadir_deg": off_nadir,
    }


@lru_cache(maxsize=32)
def _satrec(line1: str, line2: str) -> Satrec:
    try:
        return Satrec.twoline2rv(line1, line2)
    except (TypeError, ValueError, ArithmeticError) as exc:
        # The pure-Python backend can divide by zero on malformed mean motion.
        raise ValueError("invalid TLE for SGP4 propagation") from exc


def look_direction_at(
    tle: TLE,
    when: datetime,
    rocket_lat: float,
    rocket_lon: float,
    rocket_alt_km: float,
) -> dict[str, str | float]:
    """Propagate full SGP4 TEME state and return the rocket's look direction.

    ``when`` must be UTC-aware (zero offset). Latitude and longitude are
    degrees in [-90, 90] and [-180, 180]; altitude is km above the sphere
    of radius orbit.EARTH_RADIUS_KM, with a strictly positive total radius.
    Rocket ECEF is rotated by +GMST, exactly the inverse approximation of
    orbit.teme_to_geodetic: spherical, UTC-as-UT1, no polar motion. This is
    approximate TEME, NOT EME2000/OEM or window-attitude verification.

    Invalid inputs/undefined geometry raise ValueError. Nonzero SGP4 error
    codes raise RuntimeError, consistent with orbit.propagate; error states
    are never used even when SGP4 returns finite position/velocity vectors.
    Nadir azimuth has the explicit sentinel semantics documented above.
    """
    if not isinstance(when, datetime):
        raise ValueError("when must be UTC-aware")
    _ensure_utc(when, "when")
    lat = _finite_float(rocket_lat, "rocket_lat")
    lon = _finite_float(rocket_lon, "rocket_lon")
    altitude = _finite_float(rocket_alt_km, "rocket_alt_km")
    if not -90.0 <= lat <= 90.0:
        raise ValueError("rocket_lat must be in [-90, 90] degrees")
    if not -180.0 <= lon <= 180.0:
        raise ValueError("rocket_lon must be in [-180, 180] degrees")
    radius = EARTH_RADIUS_KM + altitude
    if not math.isfinite(radius) or radius <= 0.0:
        raise ValueError("rocket_alt_km must give a finite positive geocentric radius")

    sat = _satrec(tle.line1, tle.line2)
    jd, fraction = jday(
        when.year, when.month, when.day,
        when.hour, when.minute, when.second + when.microsecond / 1e6,
    )
    error, position, velocity = sat.sgp4(jd, fraction)
    if error != 0:
        detail = SGP4_ERRORS.get(error, "unknown SGP4 error")
        raise RuntimeError(f"sgp4 propagation failed: error code {error} ({detail})")

    lat_rad, lon_rad = math.radians(lat), math.radians(lon)
    x = radius * math.cos(lat_rad) * math.cos(lon_rad)
    y = radius * math.cos(lat_rad) * math.sin(lon_rad)
    z = radius * math.sin(lat_rad)
    gmst = _gmst_rad(when)
    cos_g, sin_g = math.cos(gmst), math.sin(gmst)
    target = (x * cos_g - y * sin_g, x * sin_g + y * cos_g, z)
    return orbital_look_direction(position, velocity, target)
