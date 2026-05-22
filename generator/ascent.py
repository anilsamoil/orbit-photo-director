"""ASCENT geometry: predict ISS-photographable instants during a rocket's climb.

Complements `orbit.py` (which handles OVERHEAD geometry: rocket already in
orbit passing under ISS). ASCENT catches rockets in the climb phase
(T+0 to ~T+9min, altitudes 0-200km) where ISS happens to have line-of-sight
to the still-thrusting rocket — typically a long-lens twilight shot of
an illuminated plume against a dark Earth backdrop.

Physics per /plan-eng-review 2026-05-13 + Codex outside-voice review:

- Sun illumination on the rocket uses ECI Sun-vector + cylindrical Earth
  shadow test, NOT surface-elevation-at-rocket-subpoint. At 100km altitude
  the rocket is sunlit when the surface below it has solar elevation -10°;
  at 200km, -14°. That's exactly the ascent-photo regime.
- Cloud sampling splits into (a) obstruction near the low-altitude rocket
  corridor (only relevant below ~20km) and (b) background aesthetics at the
  ISS foot-of-look. 2D cloud-cover does NOT obstruct a rocket at 100km, so
  treating it as one slant-column-average is wrong.
- No hard slant-range cap. The visibility-relevant quantity is the APPARENT
  PLUME ANGLE — a 5km luminous plume at 1500km is ~3.3 mrad, ~100px at
  200mm on a Nikon D5-class sensor. Useful out to ~3000km clamped at true
  Earth-tangent line-of-sight horizon.
- Real launch azimuth from mission inclination + pad latitude
  (cos i = cos lat × sin az), NOT a guessed `azimuth_mode` constant.
- Real tangent-clearance geometry replaces the |lat|>52° hack from the
  /autoplan locked requirements — Earth occultation has no latitude exception.
- Profiles are interpolated at 15-second cadence (vs the 5-7 sparse samples
  in the table) so the best viewing instant doesn't fall between samples.
  Collapses to ONE AscentPrediction per launch (the best instant).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum

from .ascent_profiles import AscentProfile, AscentSample, match_rocket
from .cloud import CloudSampler, sun_subpoint
from .orbit import EARTH_RADIUS_KM, TLE, Position, _gmst_rad, propagate


class SunState(StrEnum):
    """Rocket's relationship to Earth's shadow.

    SUNLIT: direct sun on the rocket (and its plume) — photographable.
    PENUMBRA: partial Earth occultation, narrow band ~5km in altitude.
              Plume still visible but dimmer; counts as photographable.
    UMBRA: full shadow — plume cannot reflect sunlight, no shot.
    """

    SUNLIT = "sunlit"
    PENUMBRA = "penumbra"
    UMBRA = "umbra"


# Apparent plume angle thresholds. A 5km luminous plume at 1500km is
# ~3.3 mrad ≈ 0.19° ≈ 100px at 200mm on a 36mm full-frame sensor.
# Below ~0.5 mrad is sub-pixel at 50mm — no credit.
PLUME_ANGLE_FULL_CREDIT_MRAD = 3.0
PLUME_ANGLE_NO_CREDIT_MRAD = 0.5

# Walk the profile at this cadence so terminator-crossings and shadow
# transitions don't fall between sparse profile samples.
INTERPOLATION_CADENCE_SECONDS = 15

# Cloud obstruction band. Below CLOUD_OBSTRUCTION_FULL_BELOW_KM the rocket
# can be hidden by clouds at the subpoint. Above CLOUD_OBSTRUCTION_NEUTRAL_ABOVE_KM
# clouds are below the rocket and don't obstruct. Linear fade in between.
CLOUD_OBSTRUCTION_FULL_BELOW_KM = 20.0
CLOUD_OBSTRUCTION_NEUTRAL_ABOVE_KM = 30.0

# Background-darkness scoring: surface sun elevation at the ISS foot-of-look.
# 0° elevation = sunset, twilight is roughly -6° (civil) to -18° (astronomical).
# Score 0.0 in bright day, ramps to 1.0 in night, half at sunset.
BG_DARK_ZERO_ELEV_DEG = 0.0       # 0.5 score (sunset)
BG_DARK_FULL_ELEV_DEG = -18.0     # 1.0 score (full dark)
BG_DARK_BRIGHT_ELEV_DEG = 10.0    # 0.0 score (clearly daylit)

# Score multiplier clamp. Codex reviewers' minimum-viable floor: at less
# than 0.3 we shouldn't surface the card at all (operator's time is scarce).
MULTIPLIER_FLOOR = 0.3
MULTIPLIER_CEILING = 1.0


@dataclass(frozen=True)
class AscentPrediction:
    """One photographable instant during a rocket's climb."""

    rocket_name: str
    profile_name: str
    t0_utc: datetime                  # liftoff time
    t_offset_seconds: int             # which interpolated instant won
    iss_position: Position            # ISS at t0 + t_offset
    rocket_lat: float
    rocket_lon: float
    rocket_alt_km: float
    pad_lat: float
    pad_lon: float
    launch_azimuth_deg: float
    slant_range_km: float
    apparent_plume_angle_mrad: float
    rocket_sun_state: SunState
    background_dark_score: float      # 0.0 (day) - 1.0 (deep night)
    obstruction_cloud_score: float    # low-altitude column near rocket; 1.0=clear
    background_cloud_score: float     # Earth backdrop aesthetics
    profile_confidence: float         # from the profile sample at t_offset

    @property
    def best_instant_utc(self) -> datetime:
        return self.t0_utc + timedelta(seconds=self.t_offset_seconds)


# ---------------------------------------------------------------------------
# Launch azimuth from mission inclination
# ---------------------------------------------------------------------------


def real_launch_azimuth(pad_lat_deg: float, mission_inclination_deg: float) -> float:
    """Real launch azimuth from inclination + pad latitude.

    Spherical geometry: cos(i) = cos(lat) × sin(az). Picks the eastward
    prograde solution (az in [0°, 180°]) for i ≤ 90°, retrograde
    (az in [180°, 360°]) for i > 90° (polar/sun-synchronous).

    Degenerate cases:
    - |lat| > i (impossible to reach the orbit from this pad) → returns
      due-east (90°) for prograde or due-south (180°) for retrograde as a
      best-effort. Real missions don't launch into impossible geometries,
      so this only matters for malformed LL2 data.
    - i ≈ 90° → due-north (0°) or due-south (180°), depending on which
      hemisphere the mission targets (we pick south by convention since
      sun-sync missions are almost always retrograde from Vandenberg).
    """
    inc_rad = math.radians(mission_inclination_deg)
    lat_rad = math.radians(pad_lat_deg)
    cos_lat = math.cos(lat_rad)
    if abs(cos_lat) < 1e-9:
        # Polar pad. Doesn't physically exist but defend the math.
        return 90.0 if mission_inclination_deg <= 90.0 else 180.0
    sin_az = math.cos(inc_rad) / cos_lat
    sin_az = max(-1.0, min(1.0, sin_az))
    # asin returns the azimuth in degrees-from-north directly: sin(az) = cos(i)/cos(lat)
    # where az is measured 0=N, 90=E. For i ≤ 90 (prograde), sin_az ≥ 0 → az ∈ [0°, 90°].
    # For i > 90 (retrograde), sin_az < 0 → asin gives a negative angle; the
    # actual southern-retrograde azimuth is 180° - that (e.g., -8.5° → 188.5°).
    asin_deg = math.degrees(math.asin(sin_az))
    if mission_inclination_deg <= 90.0:
        # Prograde: heading east-of-north, az ∈ [0°, 90°].
        return asin_deg % 360.0
    # Retrograde (i > 90): pick the southern-retrograde solution
    # (SSO from Vandenberg ≈ 188-200°).
    return (180.0 - asin_deg) % 360.0


# ---------------------------------------------------------------------------
# Rocket position interpolation
# ---------------------------------------------------------------------------


def _interpolate_profile_at(profile: AscentProfile, t_seconds: float) -> AscentSample:
    """Linear interpolation between profile samples. Clamps to endpoints."""
    samples = profile.samples
    if t_seconds <= samples[0].t_seconds:
        return samples[0]
    if t_seconds >= samples[-1].t_seconds:
        return samples[-1]
    for i in range(len(samples) - 1):
        a, b = samples[i], samples[i + 1]
        if a.t_seconds <= t_seconds <= b.t_seconds:
            span = b.t_seconds - a.t_seconds
            if span == 0:
                return a
            frac = (t_seconds - a.t_seconds) / span
            return AscentSample(
                t_seconds=int(t_seconds),
                altitude_km=a.altitude_km + frac * (b.altitude_km - a.altitude_km),
                downrange_km=a.downrange_km + frac * (b.downrange_km - a.downrange_km),
                pitch_deg=a.pitch_deg + frac * (b.pitch_deg - a.pitch_deg),
                confidence=a.confidence + frac * (b.confidence - a.confidence),
            )
    return samples[-1]


def rocket_position_at(
    profile: AscentProfile,
    t_seconds: float,
    pad_lat_deg: float,
    pad_lon_deg: float,
    azimuth_deg: float,
) -> tuple[float, float, float, float]:
    """Interpolate profile to (rocket_lat, rocket_lon, alt_km, confidence).

    Propagates along a great-circle bearing from the pad by `downrange_km`.
    Returns geodetic lat/lon (deg), altitude (km), profile confidence (0-1).
    """
    sample = _interpolate_profile_at(profile, t_seconds)
    rocket_lat, rocket_lon = _destination_along_bearing(
        pad_lat_deg, pad_lon_deg, azimuth_deg, sample.downrange_km,
    )
    return rocket_lat, rocket_lon, sample.altitude_km, sample.confidence


def _destination_along_bearing(
    lat1_deg: float, lon1_deg: float, bearing_deg: float, distance_km: float,
) -> tuple[float, float]:
    """Great-circle destination from (lat1, lon1) along a bearing for distance_km.

    Standard spherical-Earth formula. Sufficient at sub-1000km distances
    where the WGS84 vs sphere error is in the noise compared to our profile
    uncertainty.
    """
    angular_dist = distance_km / EARTH_RADIUS_KM
    lat1 = math.radians(lat1_deg)
    lon1 = math.radians(lon1_deg)
    bearing = math.radians(bearing_deg)
    lat2 = math.asin(
        math.sin(lat1) * math.cos(angular_dist)
        + math.cos(lat1) * math.sin(angular_dist) * math.cos(bearing)
    )
    lon2 = lon1 + math.atan2(
        math.sin(bearing) * math.sin(angular_dist) * math.cos(lat1),
        math.cos(angular_dist) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), ((math.degrees(lon2) + 540.0) % 360.0) - 180.0


# ---------------------------------------------------------------------------
# Geometry: slant range, plume angle, tangent clearance
# ---------------------------------------------------------------------------


def _geodetic_to_ecef(lat_deg: float, lon_deg: float, alt_km: float) -> tuple[float, float, float]:
    """Spherical-Earth ECEF (km). Same approximation orbit.py uses for
    its TEME→geodetic round-trip; consistent within this module."""
    r = EARTH_RADIUS_KM + alt_km
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    return (
        r * math.cos(lat) * math.cos(lon),
        r * math.cos(lat) * math.sin(lon),
        r * math.sin(lat),
    )


def slant_range_km(
    iss: Position,
    rocket_lat_deg: float,
    rocket_lon_deg: float,
    rocket_alt_km: float,
) -> float:
    """3D distance ISS-to-rocket in km, spherical-Earth ECEF."""
    iss_xyz = _geodetic_to_ecef(iss.lat, iss.lon, iss.alt_km)
    rocket_xyz = _geodetic_to_ecef(rocket_lat_deg, rocket_lon_deg, rocket_alt_km)
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(iss_xyz, rocket_xyz, strict=True)))


def tangent_clearance(
    iss: Position,
    rocket_lat_deg: float,
    rocket_lon_deg: float,
    rocket_alt_km: float,
) -> bool:
    """True if the ISS→rocket chord clears Earth's surface.

    Replaces the |lat|>52° hack — Earth occultation is line-of-sight,
    not a latitude rule. Computes the closest approach of the chord
    to Earth's center and rejects if it's inside R_earth.
    """
    p1 = _geodetic_to_ecef(iss.lat, iss.lon, iss.alt_km)
    p2 = _geodetic_to_ecef(rocket_lat_deg, rocket_lon_deg, rocket_alt_km)
    # Parametrize: P(s) = p1 + s × (p2 - p1), s ∈ [0, 1].
    # Closest point to origin: s* = -p1·(p2-p1) / |p2-p1|².
    d = tuple(b - a for a, b in zip(p1, p2, strict=True))
    d2 = sum(c * c for c in d)
    if d2 == 0:
        # Coincident points — caller should have rejected earlier.
        return True
    s = -sum(a * c for a, c in zip(p1, d, strict=True)) / d2
    s = max(0.0, min(1.0, s))  # closest point on the SEGMENT, not infinite line
    closest = tuple(a + s * c for a, c in zip(p1, d, strict=True))
    min_dist_to_center = math.sqrt(sum(c * c for c in closest))
    return min_dist_to_center >= EARTH_RADIUS_KM


def apparent_plume_angle_mrad(slant_range_km_: float, rocket_alt_km: float) -> float:
    """Apparent angular size of the rocket plume from ISS, in milliradians.

    Plume size scales with altitude (vacuum expansion). Below ~30km the
    plume is approximately the rocket length (~70m). Above ~80km the
    plume expands to multi-km luminous shell. Linear ramp in between.
    """
    if slant_range_km_ <= 0:
        return 0.0
    # Approximate plume length (km) as function of altitude.
    if rocket_alt_km < 30.0:
        plume_km = 0.07  # ~rocket length, atmospheric containment
    elif rocket_alt_km > 80.0:
        plume_km = 5.0   # multi-km luminous vacuum shell
    else:
        # Linear ramp 30→80km from 0.07km → 5km.
        frac = (rocket_alt_km - 30.0) / 50.0
        plume_km = 0.07 + frac * (5.0 - 0.07)
    # Small-angle: angle (rad) ≈ size / distance.
    return (plume_km / slant_range_km_) * 1000.0


def plume_angle_score(angle_mrad: float) -> float:
    """Convert apparent plume angle to a [0, 1] visibility score.

    Full credit at PLUME_ANGLE_FULL_CREDIT_MRAD (≈3 mrad — 5km plume at
    1500km, well-visible at 200mm). No credit below
    PLUME_ANGLE_NO_CREDIT_MRAD (sub-pixel even at 50mm).
    """
    if angle_mrad >= PLUME_ANGLE_FULL_CREDIT_MRAD:
        return 1.0
    if angle_mrad <= PLUME_ANGLE_NO_CREDIT_MRAD:
        return 0.0
    span = PLUME_ANGLE_FULL_CREDIT_MRAD - PLUME_ANGLE_NO_CREDIT_MRAD
    return (angle_mrad - PLUME_ANGLE_NO_CREDIT_MRAD) / span


# ---------------------------------------------------------------------------
# Sun illumination at altitude (ECI Earth-shadow cylinder test)
# ---------------------------------------------------------------------------


def _sun_eci_unit_vector(when: datetime) -> tuple[float, float, float]:
    """Unit vector from Earth's center toward the Sun, in ECI (TEME-aligned).

    Derived from sun_subpoint() which gives the sub-solar surface point
    (lat = declination, lon = hour angle). The Sun direction in ECEF is the
    unit vector at that surface point; we then rotate to ECI via GMST.

    Direction-only — magnitude (1 AU) doesn't matter for the shadow test
    since the Sun is treated as parallel rays (cylindrical shadow).
    """
    sub_lat_deg, sub_lon_deg = sun_subpoint(when)
    sub_lat = math.radians(sub_lat_deg)
    sub_lon = math.radians(sub_lon_deg)
    # Sun direction in ECEF: unit vector at the sub-solar surface point.
    ecef = (
        math.cos(sub_lat) * math.cos(sub_lon),
        math.cos(sub_lat) * math.sin(sub_lon),
        math.sin(sub_lat),
    )
    # ECEF → ECI: rotate by +GMST around Z (inverse of orbit.teme_to_geodetic).
    gmst = _gmst_rad(when)
    cos_g = math.cos(gmst)
    sin_g = math.sin(gmst)
    return (
        ecef[0] * cos_g - ecef[1] * sin_g,
        ecef[0] * sin_g + ecef[1] * cos_g,
        ecef[2],
    )


def _ecef_to_eci(
    xyz_ecef: tuple[float, float, float], when: datetime,
) -> tuple[float, float, float]:
    """ECEF → ECI rotation by +GMST around Z (inverse of orbit.teme_to_geodetic)."""
    gmst = _gmst_rad(when)
    cos_g = math.cos(gmst)
    sin_g = math.sin(gmst)
    x, y, z = xyz_ecef
    return (x * cos_g - y * sin_g, x * sin_g + y * cos_g, z)


# Penumbra band (km of cylindrical-shadow perpendicular distance) around
# the Earth's radius below which we report PENUMBRA rather than SUNLIT/UMBRA.
# Real penumbra width depends on sun-distance geometry; ±5km is a coarse
# approximation that captures the brief transition.
PENUMBRA_HALF_WIDTH_KM = 5.0


def rocket_sun_state(
    when: datetime,
    rocket_lat_deg: float,
    rocket_lon_deg: float,
    rocket_alt_km: float,
) -> SunState:
    """Cylindrical Earth-shadow test in ECI.

    Returns SUNLIT, PENUMBRA, or UMBRA. At 100km altitude the rocket is
    sunlit when the surface below has solar elevation about -10°; at
    200km, about -14°. This is the photographically-useful regime that
    surface-sun-elevation alone would miss.

    Approach: project the rocket's ECI position onto the Earth→Sun
    direction. If the rocket is on the sunward side (projection > 0),
    it's SUNLIT regardless of perpendicular distance. If it's on the
    anti-sunward side (projection ≤ 0), check the perpendicular distance
    to the Sun-line: > R_earth means alongside-Earth (sunlit from the
    side), < R_earth means in shadow (umbra). The penumbra band catches
    the ±5km transition.
    """
    sun_eci = _sun_eci_unit_vector(when)
    rocket_ecef = _geodetic_to_ecef(rocket_lat_deg, rocket_lon_deg, rocket_alt_km)
    rocket_eci = _ecef_to_eci(rocket_ecef, when)
    # Projection onto sun-direction (anti-sun = negative).
    dot = sum(r * s for r, s in zip(rocket_eci, sun_eci, strict=True))
    if dot >= 0.0:
        return SunState.SUNLIT
    # Anti-sunward: check perpendicular distance from rocket to sun-line.
    proj = tuple(dot * s for s in sun_eci)
    perp = tuple(r - p for r, p in zip(rocket_eci, proj, strict=True))
    perp_dist = math.sqrt(sum(c * c for c in perp))
    if perp_dist > EARTH_RADIUS_KM + PENUMBRA_HALF_WIDTH_KM:
        return SunState.SUNLIT
    if perp_dist < EARTH_RADIUS_KM - PENUMBRA_HALF_WIDTH_KM:
        return SunState.UMBRA
    return SunState.PENUMBRA


# ---------------------------------------------------------------------------
# Background darkness + cloud scoring
# ---------------------------------------------------------------------------


def _surface_sun_elevation_deg(when: datetime, lat_deg: float, lon_deg: float) -> float:
    """Solar elevation angle at a surface point (deg above horizon)."""
    sun_lat_deg, sun_lon_deg = sun_subpoint(when)
    sun_lat = math.radians(sun_lat_deg)
    target_lat = math.radians(lat_deg)
    dl = math.radians(lon_deg - sun_lon_deg)
    cos_zenith = (
        math.sin(target_lat) * math.sin(sun_lat)
        + math.cos(target_lat) * math.cos(sun_lat) * math.cos(dl)
    )
    cos_zenith = max(-1.0, min(1.0, cos_zenith))
    zenith_deg = math.degrees(math.acos(cos_zenith))
    return 90.0 - zenith_deg


def background_dark_score(
    when: datetime, foot_of_look_lat_deg: float, foot_of_look_lon_deg: float,
) -> float:
    """Earth-background darkness at the photographed surface scene.

    Returns 1.0 in full astronomical night, 0.5 at sunset, 0.0 in bright
    day. The "foot of look" is where on the surface ISS is photographing —
    for an ascent shot, that's typically the rocket's ground track or a bit
    short of the limb behind the plume.
    """
    elev = _surface_sun_elevation_deg(when, foot_of_look_lat_deg, foot_of_look_lon_deg)
    if elev <= BG_DARK_FULL_ELEV_DEG:
        return 1.0
    if elev >= BG_DARK_BRIGHT_ELEV_DEG:
        return 0.0
    if elev <= BG_DARK_ZERO_ELEV_DEG:
        # Twilight ramp: 0° → 0.5, -18° → 1.0
        frac = (BG_DARK_ZERO_ELEV_DEG - elev) / (BG_DARK_ZERO_ELEV_DEG - BG_DARK_FULL_ELEV_DEG)
        return 0.5 + 0.5 * frac
    # Civil-day ramp: 0° → 0.5, 10° → 0.0
    frac = elev / BG_DARK_BRIGHT_ELEV_DEG
    return 0.5 * (1.0 - frac)


def obstruction_cloud_score(
    rocket_lat_deg: float,
    rocket_lon_deg: float,
    rocket_alt_km: float,
    cloud_sampler: CloudSampler,
    when: datetime,
) -> float:
    """Clouds in the low-altitude corridor near the rocket.

    Returns 1.0 if rocket is above CLOUD_OBSTRUCTION_NEUTRAL_ABOVE_KM
    (clouds are below the rocket, irrelevant — the slant ray to ISS goes
    above them too). Linear fade in [20, 30] km. Below 20km, samples the
    cloud cover at the rocket subpoint and uses (1 - cloud_fraction/100)
    as the score (clear → 1.0, fully overcast → 0.0).
    """
    if rocket_alt_km >= CLOUD_OBSTRUCTION_NEUTRAL_ABOVE_KM:
        return 1.0
    sample = cloud_sampler.sample(rocket_lat_deg, rocket_lon_deg, when)
    cloud_score = max(0.0, 1.0 - sample.cloud_fraction / 100.0)
    if rocket_alt_km <= CLOUD_OBSTRUCTION_FULL_BELOW_KM:
        return cloud_score
    # Linear fade [20, 30] km: at 20km use full cloud_score, at 30km use 1.0.
    span = CLOUD_OBSTRUCTION_NEUTRAL_ABOVE_KM - CLOUD_OBSTRUCTION_FULL_BELOW_KM
    fade = (rocket_alt_km - CLOUD_OBSTRUCTION_FULL_BELOW_KM) / span
    return cloud_score + fade * (1.0 - cloud_score)


def background_cloud_score(
    foot_of_look_lat_deg: float,
    foot_of_look_lon_deg: float,
    cloud_sampler: CloudSampler,
    when: datetime,
) -> float:
    """Earth/cloud backdrop aesthetics behind the rocket as seen from ISS.

    Sampled at the foot-of-look on the surface (where ISS's camera is
    pointing through to the rocket). Clear sky → 1.0 (clean backdrop).
    Cloudy → also acceptable (sometimes preferred for plume contrast),
    so we floor at 0.5 to avoid penalizing cloudy-but-photogenic shots.
    """
    sample = cloud_sampler.sample(foot_of_look_lat_deg, foot_of_look_lon_deg, when)
    # Clear sky: 1.0. Heavy cloud: 0.5 (still photogenic). Linear between.
    clear_fraction = max(0.0, 1.0 - sample.cloud_fraction / 100.0)
    return 0.5 + 0.5 * clear_fraction


# ---------------------------------------------------------------------------
# Top-level predictor
# ---------------------------------------------------------------------------


def predict_ascent_pass(
    launch: dict,
    pad_lat_deg: float,
    pad_lon_deg: float,
    t0_utc: datetime,
    iss_tle: TLE,
    cloud_sampler: CloudSampler,
) -> AscentPrediction | None:
    """Predict the single best ASCENT photo instant for one launch.

    Walks the matched rocket profile at INTERPOLATION_CADENCE_SECONDS,
    filters by tangent-clearance + UMBRA-rejection, picks the instant
    with the highest score. Returns None if no instant passes the gates
    (e.g., rocket fully eclipsed throughout climb, or no profile match).

    The `launch` dict is the LL2-shaped launch record. We read:
    - rocket.configuration → profile match
    - mission.orbit.inclination → real launch azimuth
    """
    profile = match_rocket(launch.get("rocket", {}).get("configuration"))
    if profile is None:
        return None
    inclination = (
        launch.get("mission", {})
        .get("orbit", {})
        .get("inclination", 51.6)  # ISS default if unspecified
    )
    azimuth_deg = real_launch_azimuth(pad_lat_deg, inclination)

    best: AscentPrediction | None = None
    best_score = -1.0
    for t_offset in range(0, profile.insertion_t_seconds + 1, INTERPOLATION_CADENCE_SECONDS):
        when = t0_utc + timedelta(seconds=t_offset)
        rocket_lat, rocket_lon, rocket_alt_km, profile_conf = rocket_position_at(
            profile, t_offset, pad_lat_deg, pad_lon_deg, azimuth_deg,
        )
        iss = propagate(iss_tle, when)
        if not tangent_clearance(iss, rocket_lat, rocket_lon, rocket_alt_km):
            continue
        sun_state = rocket_sun_state(when, rocket_lat, rocket_lon, rocket_alt_km)
        if sun_state == SunState.UMBRA:
            continue
        sr_km = slant_range_km(iss, rocket_lat, rocket_lon, rocket_alt_km)
        plume_mrad = apparent_plume_angle_mrad(sr_km, rocket_alt_km)
        plume = plume_angle_score(plume_mrad)
        if plume == 0.0:
            continue
        # Foot of look: surface point under the rocket (approximation —
        # strictly we'd ray-cast from ISS through the rocket onto Earth,
        # but at low rocket altitudes those are close).
        bg_dark = background_dark_score(when, rocket_lat, rocket_lon)
        obstruction = obstruction_cloud_score(
            rocket_lat, rocket_lon, rocket_alt_km, cloud_sampler, when,
        )
        background = background_cloud_score(
            rocket_lat, rocket_lon, cloud_sampler, when,
        )
        # Composite score for picking the best instant. Equal weights for
        # now; soak data will tune.
        composite = plume * bg_dark * obstruction * background * profile_conf
        # Penumbra is slightly worse than fully sunlit.
        if sun_state == SunState.PENUMBRA:
            composite *= 0.7
        if composite > best_score:
            best_score = composite
            best = AscentPrediction(
                rocket_name=launch.get("rocket", {})
                .get("configuration", {})
                .get("full_name", profile.name),
                profile_name=profile.name,
                t0_utc=t0_utc,
                t_offset_seconds=t_offset,
                iss_position=iss,
                rocket_lat=rocket_lat,
                rocket_lon=rocket_lon,
                rocket_alt_km=rocket_alt_km,
                pad_lat=pad_lat_deg,
                pad_lon=pad_lon_deg,
                launch_azimuth_deg=azimuth_deg,
                slant_range_km=sr_km,
                apparent_plume_angle_mrad=plume_mrad,
                rocket_sun_state=sun_state,
                background_dark_score=bg_dark,
                obstruction_cloud_score=obstruction,
                background_cloud_score=background,
                profile_confidence=profile_conf,
            )
    return best


@dataclass(frozen=True)
class AscentTrajectoryPoint:
    """One sample along the rocket's predicted ground track."""

    t_offset_seconds: int
    lat: float
    lon: float
    alt_km: float


def build_ascent_trajectory(
    profile: AscentProfile,
    pad_lat_deg: float,
    pad_lon_deg: float,
    azimuth_deg: float,
) -> list[AscentTrajectoryPoint]:
    """Walk the profile at INTERPOLATION_CADENCE_SECONDS and return the
    full ground-track polyline from T+0 to nominal orbit insertion.

    Used by the frontend ascent-trajectory map layer to draw the predicted
    climb path. Independent of ISS visibility — the line is the rocket's
    nominal trajectory regardless of whether ISS can see it.
    """
    points: list[AscentTrajectoryPoint] = []
    for t_offset in range(
        0, profile.insertion_t_seconds + 1, INTERPOLATION_CADENCE_SECONDS
    ):
        lat, lon, alt_km, _ = rocket_position_at(
            profile, t_offset, pad_lat_deg, pad_lon_deg, azimuth_deg,
        )
        points.append(
            AscentTrajectoryPoint(
                t_offset_seconds=t_offset,
                lat=lat,
                lon=lon,
                alt_km=alt_km,
            )
        )
    return points


def ascent_score_multiplier(prediction: AscentPrediction) -> float:
    """Convert an AscentPrediction to a [MULTIPLIER_FLOOR, MULTIPLIER_CEILING]
    score multiplier for the existing PassEntry scoring pipeline.

    Folded into the launch's score; the operator sees the result as the
    star count (per D5: confidence stays hidden, only launch.kind itself
    is rendered as a visible tag).
    """
    plume = plume_angle_score(prediction.apparent_plume_angle_mrad)
    sun_factor = 0.7 if prediction.rocket_sun_state == SunState.PENUMBRA else 1.0
    raw = (
        plume
        * prediction.background_dark_score
        * prediction.obstruction_cloud_score
        * prediction.background_cloud_score
        * prediction.profile_confidence
        * sun_factor
    )
    return max(MULTIPLIER_FLOOR, min(MULTIPLIER_CEILING, raw))
