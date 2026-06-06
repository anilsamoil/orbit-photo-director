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


# Off-nadir angle (deg) at/under which a target is "realistically frameable" —
# the photographic horizon for the initial-encounter scan. ~60° corresponds to
# roughly the 800 km pass-search cone (max_distance_km), i.e. "the target enters
# the working area." 45° was too tight on two counts: the crossing landed only
# ~30-60s before closest (so minute-rounded countdowns collapsed to the same
# value) and it excluded every oblique Cupola pass (closest > 45°) from getting
# an initial at all. 60° gives ~2 min of lead (distinct countdown) and includes
# Cupola-range passes. Tunable. (Operator feedback 2026-06-03.)
ENCOUNTER_MAX_OFF_NADIR_DEG = 60.0


@dataclass(frozen=True)
class Encounter:
    """Initial-encounter geometry for a pass — the first moment (scanning back
    from closest approach) the target crosses inside ENCOUNTER_MAX_OFF_NADIR_DEG,
    i.e. when the operator could first realistically frame the shot. Distinct
    from closest approach: the look angle sweeps fore → nadir → aft across a
    pass, so the encounter look angle/side differ from the closest one and tell
    the operator where the target will first appear."""

    time: datetime
    off_nadir_deg: float
    # Same convention as Pass.iss_relative_bearing_deg: clockwise from forward,
    # 0 = ahead, 90 = starboard, 180 = aft, 270 = port.
    rel_bearing_deg: float


@dataclass(frozen=True)
class Pass:
    target_id: str
    target_lat: float
    target_lon: float
    closest_approach: datetime
    nadir_distance_km: float
    iss_position: Position
    # Direction the target sits in relative to ISS's direction of travel,
    # measured clockwise from forward. 0 = ahead, 90 = starboard, 180 = aft,
    # 270 = port. Lets the operator orient the shot ("90° starboard, look
    # right of travel"). Computed in find_passes when an ISS heading sample
    # is available; None when find_passes is called outside that path
    # (some legacy tests pass synthetic data).
    iss_relative_bearing_deg: float | None = None
    # Initial-encounter geometry (off-nadir ≤60° scan-back from closest
    # approach). None when the pass never gets frameable (closest approach
    # itself > 60° off-nadir — a distant/grazing pass) or when find_passes
    # is called outside the heading-sample path. See Encounter.
    encounter: Encounter | None = None


def great_circle_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance, km. Spherical Earth."""
    rl1, rl2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin((rl2 - rl1) / 2) ** 2
        + math.cos(rl1) * math.cos(rl2) * math.sin(dl / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def great_circle_bearing_deg(
    lat1: float, lon1: float, lat2: float, lon2: float,
) -> float:
    """Great-circle initial bearing from (lat1, lon1) to (lat2, lon2),
    in degrees clockwise from true north [0, 360).

    ISS travels along great circles so this is the correct formula for
    direction-of-travel; flat-Earth atan2(Δlat, Δlon) blows up near the
    poles and across the antimeridian.
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def relative_bearing_deg(iss_heading_deg: float, target_bearing_deg: float) -> float:
    """Bearing of target relative to ISS direction-of-travel, clockwise from
    forward [0, 360). 0 = fore, 90 = starboard, 180 = aft, 270 = port."""
    return (target_bearing_deg - iss_heading_deg + 360.0) % 360.0


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
    R = EARTH_RADIUS_KM  # noqa: N806 — geometric convention
    theta = ground_distance_km / R  # angle subtended at Earth's center, radians
    sin_t = math.sin(theta)
    cos_t = math.cos(theta)
    # tan(alpha) = R sin θ / (R + h − R cos θ)
    alpha = math.atan2(R * sin_t, R + altitude_km - R * cos_t)
    return math.degrees(alpha)


def _relative_bearing_at(
    samples: list[tuple[datetime, Position, float]],
    idx: int,
    lat_t: float,
    lon_t: float,
) -> float:
    """ISS-relative target bearing at sample `idx`, reusing the heading from
    `idx` → `idx+1` (one step ahead). Caller guarantees `idx + 1` is in range
    (encounter index is always ≤ the closest-approach index, which is < last)."""
    iss_here = samples[idx][1]
    iss_next = samples[idx + 1][1]
    heading = great_circle_bearing_deg(
        iss_here.lat, iss_here.lon, iss_next.lat, iss_next.lon,
    )
    target_bearing = great_circle_bearing_deg(
        iss_here.lat, iss_here.lon, lat_t, lon_t,
    )
    return relative_bearing_deg(heading, target_bearing)


def _find_encounter(
    samples: list[tuple[datetime, Position, float]],
    closest_idx: int,
    lat_t: float,
    lon_t: float,
    max_off_nadir_deg: float = ENCOUNTER_MAX_OFF_NADIR_DEG,
) -> Encounter | None:
    """Initial encounter for the pass whose closest approach is at
    `closest_idx`: scan back to the sample where the target crossed INTO the
    `max_off_nadir_deg` frameable cone. Returns None when:
      - closest approach itself is already past the threshold (never frameable);
      - the target only becomes frameable at closest approach (no earlier moment);
      - the crossing is never observed — the target was already framed when the
        window opened, or stayed framed across a previous approach. We do NOT
        fabricate a boundary time when the true crossing predates our samples.

    The scan stops at the off-nadir crossing OR at a local distance maximum
    (where earlier samples belong to a separate approach), whichever comes
    first. Only an *observed* crossing yields an encounter."""
    iss_c = samples[closest_idx][1]
    if angle_off_nadir_deg(samples[closest_idx][2], iss_c.alt_km) > max_off_nadir_deg:
        return None  # never realistically frameable

    enc_idx = closest_idx
    saw_crossing = False
    j = closest_idx - 1
    while j >= 0:
        iss_j = samples[j][1]
        d_j = samples[j][2]
        # Stop if ground distance stops increasing as we scan back. Within one
        # close approach, distance rises monotonically away from the local
        # minimum; the moment it stops rising we've reached a local maximum and
        # the earlier samples belong to a *separate* approach. Guards against
        # attaching a previous pass's time to THIS pass (a silent wrong-result),
        # insurance for a retuned threshold or the multi-satellite roadmap.
        if d_j <= samples[j + 1][2]:
            break
        if angle_off_nadir_deg(d_j, iss_j.alt_km) > max_off_nadir_deg:
            # Observed the target crossing INTO the frameable cone — enc_idx
            # (the next sample inward) is the genuine initial encounter.
            saw_crossing = True
            break
        enc_idx = j
        j -= 1

    if not saw_crossing or enc_idx == closest_idx:
        # No observed crossing → the target was already frameable when the
        # window opened (scan reached the edge / a local max without seeing
        # off-nadir exceed the threshold), or it only becomes frameable at
        # closest itself. Either way there's no honest *earlier* encounter time
        # to report — render closest-only rather than fabricate one.
        return None

    iss_e = samples[enc_idx][1]
    return Encounter(
        time=samples[enc_idx][0],
        off_nadir_deg=angle_off_nadir_deg(samples[enc_idx][2], iss_e.alt_km),
        rel_bearing_deg=_relative_bearing_at(samples, enc_idx, lat_t, lon_t),
    )


def find_passes(
    tle: TLE,
    target: dict[str, Any],
    window_start: datetime,
    window_end: datetime,
    step_seconds: int = 30,
    max_distance_km: float = 800.0,
    preroll_seconds: int = 0,
) -> list[Pass]:
    """Sample ground track at step_seconds; return local minima within max_distance_km of target.

    `preroll_seconds` extends sampling BACKWARD before `window_start` so the
    initial-encounter scan can observe a cone crossing that happens before the
    window opens (see _find_encounter). Pre-roll samples are context only:
    passes whose closest approach falls before `window_start` are never emitted,
    so a pre-roll never surfaces an already-past pass.
    """
    _ensure_utc(window_start, "window_start")
    _ensure_utc(window_end, "window_end")
    if window_end <= window_start:
        return []
    lat_t = target["geom"]["lat"]
    lon_t = target["geom"]["lon"]
    target_id = target["id"]

    scan_start = window_start - timedelta(seconds=preroll_seconds)
    samples: list[tuple[datetime, Position, float]] = []
    t = scan_start
    while t < window_end:
        pos = propagate(tle, t)
        d = great_circle_km(lat_t, lon_t, pos.lat, pos.lon)
        samples.append((t, pos, d))
        t = t + timedelta(seconds=step_seconds)

    passes: list[Pass] = []
    for i in range(1, len(samples) - 1):
        # Pre-roll samples are encounter context only — a local minimum before
        # `window_start` is an already-past approach and must not be emitted.
        if samples[i][0] < window_start:
            continue
        prev_d = samples[i - 1][2]
        curr_d = samples[i][2]
        next_d = samples[i + 1][2]
        if curr_d < prev_d and curr_d < next_d and curr_d < max_distance_km:
            # ISS heading at closest approach: bearing from this sample to
            # the next. The next sample is `step_seconds` ahead, plenty for
            # a stable heading at ISS orbital speeds (~7.7 km/s → ~230 km
            # in 30s, far above noise). The relative bearing tells the
            # operator which way to look (forward/starboard/aft/port).
            iss_here = samples[i][1]
            rel = _relative_bearing_at(samples, i, lat_t, lon_t)
            # Initial-encounter geometry: scan back to where the target first
            # crossed inside the frameable off-nadir threshold (see Encounter).
            encounter = _find_encounter(samples, i, lat_t, lon_t)
            passes.append(
                Pass(
                    target_id=target_id,
                    target_lat=lat_t,
                    target_lon=lon_t,
                    closest_approach=samples[i][0],
                    nadir_distance_km=curr_d,
                    iss_position=iss_here,
                    iss_relative_bearing_deg=rel,
                    encounter=encounter,
                )
            )
    return passes


_POLYNOMIAL_ORDER_CAP = 11
"""Hard cap on polyfit degree. Past 11, np.polyfit on ISS lat/lon over multiple
orbits gets numerically ill-conditioned (RankWarning, Runge oscillations near
window edges). For windows >180 min the right answer is to fit two shorter
polynomials (or run SGP4 client-side, see frontend/src/iss-sgp4.ts) — not to
crank degree further. We keep the cap and let the frontend fall back to its
slower path when more accuracy is needed."""


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


def sample_track_points(
    tle: TLE, start: datetime, *, minutes: int = 200, step_seconds: int = 30
) -> list[list[float]]:
    """Sample ISS lat/lon directly from SGP4 every `step_seconds` for `minutes`.

    The polynomial fit (fit_iss_polynomial) is great for fast in-window
    interpolation but degrades visibly past ~120 min. For the map's ground-
    track polyline we want 2 full orbits (~190 min); raw SGP4 samples have
    no drift accumulation regardless of duration.

    Returns a list of [t_seconds_from_start, lat_deg, lon_deg] triples,
    rounded to 3 decimals (~110 m surface accuracy — plenty for a map line).
    With minutes=200, step=30 → 401 points × 3 floats × ~8 bytes = ~9.6 KB
    JSON, ~3 KB gzipped. Cheap.
    """
    _ensure_utc(start, "start")
    points: list[list[float]] = []
    total_seconds = minutes * 60
    t = 0
    while t <= total_seconds:
        pos = propagate(tle, start + timedelta(seconds=t))
        points.append([float(t), round(pos.lat, 3), round(pos.lon, 3)])
        t += step_seconds
    return points


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
