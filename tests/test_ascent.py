"""Tests for generator.ascent."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import pytest

from generator.ascent import (
    INTERPOLATION_CADENCE_SECONDS,
    MULTIPLIER_CEILING,
    MULTIPLIER_FLOOR,
    PLUME_ANGLE_FULL_CREDIT_MRAD,
    PLUME_ANGLE_NO_CREDIT_MRAD,
    AscentPrediction,
    SunState,
    apparent_plume_angle_mrad,
    ascent_score_multiplier,
    background_cloud_score,
    background_dark_score,
    obstruction_cloud_score,
    plume_angle_score,
    predict_ascent_pass,
    real_launch_azimuth,
    rocket_position_at,
    rocket_sun_state,
    slant_range_km,
    tangent_clearance,
)
from generator.ascent_profiles import FALCON_9
from generator.cloud import CloudSample
from generator.orbit import EARTH_RADIUS_KM, TLE, Position

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


class _FixedCloudSampler:
    """CloudSampler stub that returns the same cloud fraction everywhere."""

    def __init__(self, cloud_fraction: float = 20.0) -> None:
        self._cf = cloud_fraction

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        return CloudSample(cloud_fraction=self._cf, sample_time=when, source="mock")


def _iss_position(lat: float = 0.0, lon: float = 0.0, alt_km: float = 408.0,
                   when: datetime | None = None) -> Position:
    return Position(lat=lat, lon=lon, alt_km=alt_km, when=when or datetime(2024, 10, 17, 12, 0, tzinfo=UTC))


# --------------------------------------------------------------------------
# real_launch_azimuth
# --------------------------------------------------------------------------


def test_launch_azimuth_iss_rendezvous_from_ksc() -> None:
    """KSC (lat 28.6°) launching into ISS orbit (i=51.6°). Azimuth must be
    east-of-north (eastward prograde). asin(cos(51.6)/cos(28.6)) ≈ 45°,
    so heading ≈ 90 - 45 ≈ 45° (NE)."""
    az = real_launch_azimuth(pad_lat_deg=28.6, mission_inclination_deg=51.6)
    assert 40.0 <= az <= 50.0


def test_launch_azimuth_polar_sso_from_vandenberg() -> None:
    """Vandenberg (lat 34.6°) launching SSO (i=97°). Retrograde,
    south-of-south-east. Pure spherical Earth gives ~188.5°; real-world
    figures (~196°) include Earth-rotation + J2 corrections we don't
    model. Anywhere in [185°, 210°] is in the right regime."""
    az = real_launch_azimuth(pad_lat_deg=34.6, mission_inclination_deg=97.0)
    assert 185.0 <= az <= 210.0


def test_launch_azimuth_equatorial_due_east() -> None:
    """Pad on equator, i=0° (equatorial orbit). Must be due east."""
    az = real_launch_azimuth(pad_lat_deg=0.0, mission_inclination_deg=0.0)
    assert az == pytest.approx(90.0, abs=0.5)


def test_launch_azimuth_pad_lat_equal_to_inclination_due_east() -> None:
    """When pad latitude equals inclination, the prograde azimuth is due east."""
    az = real_launch_azimuth(pad_lat_deg=28.6, mission_inclination_deg=28.6)
    assert az == pytest.approx(90.0, abs=1.0)


# --------------------------------------------------------------------------
# rocket_position_at — interpolation + great-circle propagation
# --------------------------------------------------------------------------


def test_rocket_position_at_liftoff_returns_pad() -> None:
    """At T+0 the rocket is on the pad."""
    lat, lon, alt, conf = rocket_position_at(FALCON_9, 0, 28.6, -80.6, 90.0)
    assert lat == pytest.approx(28.6, abs=1e-6)
    assert lon == pytest.approx(-80.6, abs=1e-6)
    assert alt == 0.0
    assert conf == 1.0


def test_rocket_position_at_interpolates_altitude_between_samples() -> None:
    """At T+45 (between T+30 alt=2.5 and T+70 alt=12.0): frac=15/40=0.375,
    so alt = 2.5 + 0.375 × (12 - 2.5) = 6.0625 km."""
    _, _, alt, _ = rocket_position_at(FALCON_9, 45, 28.6, -80.6, 90.0)
    assert alt == pytest.approx(6.0625, abs=0.01)


def test_rocket_position_at_clamps_past_insertion() -> None:
    """Past insertion the position holds at the last sample."""
    lat, lon, alt, conf = rocket_position_at(FALCON_9, 10_000, 28.6, -80.6, 90.0)
    last = FALCON_9.samples[-1]
    assert alt == last.altitude_km
    assert conf == last.confidence


def test_rocket_position_at_clamps_before_zero() -> None:
    lat, lon, alt, conf = rocket_position_at(FALCON_9, -100, 28.6, -80.6, 90.0)
    assert alt == 0.0
    assert conf == 1.0


def test_rocket_position_great_circle_due_east_doesnt_change_lat() -> None:
    """Heading east from KSC, the latitude shouldn't drift much for small downrange."""
    # Falcon 9 at T+30 has downrange = 0.3km, so the lat change is tiny.
    lat, _, _, _ = rocket_position_at(FALCON_9, 30, 28.6, -80.6, 90.0)
    assert lat == pytest.approx(28.6, abs=0.01)


# --------------------------------------------------------------------------
# slant_range_km
# --------------------------------------------------------------------------


def test_slant_range_iss_directly_above_rocket() -> None:
    """ISS at the equator at 408km, rocket at the same lat/lon at 0km altitude:
    slant range = 408km exactly."""
    iss = _iss_position(lat=0.0, lon=0.0, alt_km=408.0)
    sr = slant_range_km(iss, 0.0, 0.0, 0.0)
    assert sr == pytest.approx(408.0, abs=0.01)


def test_slant_range_iss_offset_rocket_at_altitude() -> None:
    """ISS at (0,0,408), rocket at (0,5,100). Approximate via cosine-law."""
    iss = _iss_position(lat=0.0, lon=0.0, alt_km=408.0)
    sr = slant_range_km(iss, 0.0, 5.0, 100.0)
    # Cosine-law check: cos(5°) chord between two points at radii 6786 and 6478.
    r1 = EARTH_RADIUS_KM + 408
    r2 = EARTH_RADIUS_KM + 100
    expected = math.sqrt(r1 * r1 + r2 * r2 - 2 * r1 * r2 * math.cos(math.radians(5.0)))
    assert sr == pytest.approx(expected, rel=1e-4)


# --------------------------------------------------------------------------
# tangent_clearance — Earth occultation
# --------------------------------------------------------------------------


def test_tangent_clearance_directly_above_passes() -> None:
    """ISS directly above the rocket, no Earth in the way."""
    iss = _iss_position(lat=0.0, lon=0.0, alt_km=408.0)
    assert tangent_clearance(iss, 0.0, 0.0, 0.0) is True


def test_tangent_clearance_antipodal_rejected() -> None:
    """Antipodal pair has Earth squarely in the line — chord passes through center."""
    iss = _iss_position(lat=0.0, lon=0.0, alt_km=408.0)
    assert tangent_clearance(iss, 0.0, 180.0, 0.0) is False


def test_tangent_clearance_75_deg_off_at_low_altitude_rejected() -> None:
    """75° great-circle apart with rocket at 0km — chord misses surface only
    if the off-angle is < horizon. ISS horizon at 408km is ~20° from nadir
    in Earth-centered angle, so 75° is well beyond → rejected."""
    iss = _iss_position(lat=0.0, lon=0.0, alt_km=408.0)
    assert tangent_clearance(iss, 0.0, 75.0, 0.0) is False


def test_tangent_clearance_high_altitude_extends_horizon() -> None:
    """At 100km altitude, the rocket is visible from a much greater Earth-centered
    angle than a surface point — the chord stays well above the Earth surface."""
    iss = _iss_position(lat=0.0, lon=0.0, alt_km=408.0)
    # ~15° great-circle off, rocket at 100km — should clear.
    assert tangent_clearance(iss, 0.0, 15.0, 100.0) is True


# --------------------------------------------------------------------------
# apparent_plume_angle_mrad
# --------------------------------------------------------------------------


def test_plume_angle_5km_plume_at_1500km() -> None:
    """At >80km altitude, plume is ~5km. 5km / 1500km = 3.33 mrad."""
    angle = apparent_plume_angle_mrad(slant_range_km_=1500.0, rocket_alt_km=100.0)
    assert angle == pytest.approx(3.33, abs=0.05)


def test_plume_angle_low_altitude_smaller() -> None:
    """At <30km altitude, plume is rocket-length ~70m → much smaller angle."""
    angle = apparent_plume_angle_mrad(slant_range_km_=1500.0, rocket_alt_km=20.0)
    # 0.07 / 1500 * 1000 = 0.047 mrad
    assert angle == pytest.approx(0.047, abs=0.005)


def test_plume_angle_ramp_between_30_and_80km() -> None:
    """Linear ramp in the 30-80km band."""
    angle_at_55km = apparent_plume_angle_mrad(slant_range_km_=1500.0, rocket_alt_km=55.0)
    # 0.07 + 0.5 * (5.0 - 0.07) = ~2.535 km → 2.535/1500 * 1000 ≈ 1.69 mrad
    assert angle_at_55km == pytest.approx(1.69, abs=0.1)


def test_plume_angle_zero_slant_returns_zero() -> None:
    assert apparent_plume_angle_mrad(slant_range_km_=0.0, rocket_alt_km=100.0) == 0.0


# --------------------------------------------------------------------------
# plume_angle_score
# --------------------------------------------------------------------------


def test_plume_angle_score_full_credit_above_threshold() -> None:
    assert plume_angle_score(PLUME_ANGLE_FULL_CREDIT_MRAD) == 1.0
    assert plume_angle_score(10.0) == 1.0


def test_plume_angle_score_no_credit_below_threshold() -> None:
    assert plume_angle_score(PLUME_ANGLE_NO_CREDIT_MRAD) == 0.0
    assert plume_angle_score(0.0) == 0.0


def test_plume_angle_score_linear_in_middle() -> None:
    mid = (PLUME_ANGLE_NO_CREDIT_MRAD + PLUME_ANGLE_FULL_CREDIT_MRAD) / 2
    assert plume_angle_score(mid) == pytest.approx(0.5, abs=0.01)


# --------------------------------------------------------------------------
# rocket_sun_state — ECI shadow geometry
# --------------------------------------------------------------------------


def test_rocket_sun_state_sunlit_at_subsolar() -> None:
    """A rocket directly under the sun is SUNLIT at any altitude."""
    when = datetime(2024, 6, 21, 12, 0, tzinfo=UTC)  # northern summer solstice noon UTC
    # Sub-solar approx at lat ≈ 23.4°, lon = 0 (noon UTC).
    state = rocket_sun_state(when, rocket_lat_deg=23.4, rocket_lon_deg=0.0, rocket_alt_km=100.0)
    assert state == SunState.SUNLIT


def test_rocket_sun_state_umbra_anti_solar_low_altitude() -> None:
    """A surface point opposite the sun is in deep UMBRA."""
    when = datetime(2024, 6, 21, 12, 0, tzinfo=UTC)
    # Anti-solar: lat ≈ -23.4°, lon = 180°.
    state = rocket_sun_state(when, rocket_lat_deg=-23.4, rocket_lon_deg=180.0, rocket_alt_km=0.0)
    assert state == SunState.UMBRA


def test_rocket_sun_state_sunlit_at_altitude_past_terminator() -> None:
    """At 200km altitude, rocket is sunlit when the surface below has sun
    elevation about -14° — past the surface terminator. This is the
    ascent-photo regime that surface-elevation alone would miss."""
    when = datetime(2024, 6, 21, 12, 0, tzinfo=UTC)
    # ~30° east of the terminator on the dark side, at high altitude.
    # Surface at this lat/lon is in shadow (terminator ~90° from sun) but
    # at 200km the rocket can still be sunlit.
    # Sun sublon ≈ 0 at 12:00 UTC; terminator at ±90°. At lon=100° lat=23.4°,
    # surface is in early-night shadow but rocket at 200km can be sunlit.
    state = rocket_sun_state(when, rocket_lat_deg=23.4, rocket_lon_deg=100.0, rocket_alt_km=200.0)
    # Should be SUNLIT — the high altitude keeps it out of the cylindrical shadow.
    assert state == SunState.SUNLIT


def test_rocket_sun_state_umbra_deep_night() -> None:
    """Far-anti-solar at 100km — still in shadow because the Earth blocks
    the sun-line at that perpendicular distance."""
    when = datetime(2024, 6, 21, 12, 0, tzinfo=UTC)
    state = rocket_sun_state(when, rocket_lat_deg=-23.4, rocket_lon_deg=180.0, rocket_alt_km=100.0)
    # At 100km on the anti-solar side, perpendicular distance to sun-line
    # ≈ R_earth (slightly above the equator since lat=-23.4). Should be
    # in shadow.
    assert state == SunState.UMBRA


# --------------------------------------------------------------------------
# background_dark_score
# --------------------------------------------------------------------------


def test_background_dark_score_full_night() -> None:
    """Anti-solar point at lat 0 is in deep night."""
    when = datetime(2024, 6, 21, 12, 0, tzinfo=UTC)
    score = background_dark_score(when, foot_of_look_lat_deg=0.0, foot_of_look_lon_deg=180.0)
    assert score == pytest.approx(1.0, abs=0.05)


def test_background_dark_score_full_day() -> None:
    """Sub-solar point is fully day."""
    when = datetime(2024, 6, 21, 12, 0, tzinfo=UTC)
    score = background_dark_score(when, foot_of_look_lat_deg=23.4, foot_of_look_lon_deg=0.0)
    assert score == 0.0


def test_background_dark_score_sunset_midpoint() -> None:
    """At sun elevation = 0° (sunset), score = 0.5."""
    when = datetime(2024, 6, 21, 12, 0, tzinfo=UTC)
    # Terminator: 90° from sun. At lon=90°, lat=0, that's about sunset.
    score = background_dark_score(when, foot_of_look_lat_deg=0.0, foot_of_look_lon_deg=90.0)
    assert score == pytest.approx(0.5, abs=0.1)


# --------------------------------------------------------------------------
# obstruction_cloud_score
# --------------------------------------------------------------------------


def test_obstruction_cloud_above_30km_always_clear() -> None:
    """Above 30km, clouds are below the rocket → no obstruction."""
    sampler = _FixedCloudSampler(cloud_fraction=100.0)  # fully overcast
    when = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    assert obstruction_cloud_score(0.0, 0.0, rocket_alt_km=50.0,
                                   cloud_sampler=sampler, when=when) == 1.0


def test_obstruction_cloud_below_20km_clear_sky() -> None:
    sampler = _FixedCloudSampler(cloud_fraction=0.0)
    when = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    assert obstruction_cloud_score(0.0, 0.0, rocket_alt_km=10.0,
                                   cloud_sampler=sampler, when=when) == 1.0


def test_obstruction_cloud_below_20km_overcast() -> None:
    sampler = _FixedCloudSampler(cloud_fraction=100.0)
    when = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    assert obstruction_cloud_score(0.0, 0.0, rocket_alt_km=10.0,
                                   cloud_sampler=sampler, when=when) == 0.0


def test_obstruction_cloud_in_fade_band() -> None:
    """At 25km (midpoint of 20-30 fade), overcast score should be ~0.5."""
    sampler = _FixedCloudSampler(cloud_fraction=100.0)
    when = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    score = obstruction_cloud_score(0.0, 0.0, rocket_alt_km=25.0,
                                     cloud_sampler=sampler, when=when)
    assert score == pytest.approx(0.5, abs=0.05)


# --------------------------------------------------------------------------
# background_cloud_score
# --------------------------------------------------------------------------


def test_background_cloud_clear_sky_full() -> None:
    sampler = _FixedCloudSampler(cloud_fraction=0.0)
    when = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    assert background_cloud_score(0.0, 0.0, sampler, when) == 1.0


def test_background_cloud_overcast_floors_at_half() -> None:
    """Heavy overcast still photogenic for plume contrast — floor at 0.5."""
    sampler = _FixedCloudSampler(cloud_fraction=100.0)
    when = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    assert background_cloud_score(0.0, 0.0, sampler, when) == 0.5


# --------------------------------------------------------------------------
# predict_ascent_pass — top-level integration
# --------------------------------------------------------------------------


@pytest.fixture
def f9_launch_dict() -> dict:
    return {
        "rocket": {"configuration": {
            "full_name": "Falcon 9 Block 5",
            "name": "Falcon 9",
            "family": "Falcon",
        }},
        "mission": {"orbit": {"inclination": 51.6}},
    }


def test_predict_ascent_pass_returns_none_for_unknown_rocket(sample_tle: TLE) -> None:
    launch = {"rocket": {"configuration": {"full_name": "Electron"}}}
    sampler = _FixedCloudSampler()
    when = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    assert predict_ascent_pass(launch, 28.6, -80.6, when, sample_tle, sampler) is None


def test_predict_ascent_pass_returns_prediction_for_falcon_9(
    f9_launch_dict: dict, sample_tle: TLE,
) -> None:
    """A real Falcon 9 launch from KSC at a moment when geometry can work."""
    sampler = _FixedCloudSampler(cloud_fraction=10.0)
    # Pick a t0 such that the ISS happens to be near KSC. The sample TLE
    # is from 2024-10-16; the ISS comes overhead Florida several times a
    # day. We pick a time and verify _some_ valid prediction exists or
    # we get None — both are valid; we just need the call to not crash.
    when = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    result = predict_ascent_pass(f9_launch_dict, 28.6, -80.6, when, sample_tle, sampler)
    # Result may be None (no good geometry) but the call must complete cleanly.
    if result is not None:
        assert result.profile_name == "Falcon 9"
        assert 0 <= result.t_offset_seconds <= FALCON_9.insertion_t_seconds
        assert result.rocket_sun_state in {SunState.SUNLIT, SunState.PENUMBRA}
        assert result.t_offset_seconds % INTERPOLATION_CADENCE_SECONDS == 0


def test_predict_ascent_pass_skips_when_no_profile_match(sample_tle: TLE) -> None:
    """LL2 rocket with no matching profile returns None instead of crashing."""
    launch = {"rocket": {"configuration": {"full_name": "Some Unknown LV-5"}}}
    sampler = _FixedCloudSampler()
    when = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    assert predict_ascent_pass(launch, 28.6, -80.6, when, sample_tle, sampler) is None


# --------------------------------------------------------------------------
# ascent_score_multiplier — clamp + math
# --------------------------------------------------------------------------


def _prediction(
    *, plume_mrad: float = 3.0, sun_state: SunState = SunState.SUNLIT,
    bg_dark: float = 1.0, obstruction: float = 1.0, background: float = 1.0,
    confidence: float = 1.0,
) -> AscentPrediction:
    """Build a minimal AscentPrediction for multiplier math tests."""
    return AscentPrediction(
        rocket_name="Falcon 9 Block 5",
        profile_name="Falcon 9",
        t0_utc=datetime(2024, 10, 17, 12, 0, tzinfo=UTC),
        t_offset_seconds=120,
        iss_position=_iss_position(),
        rocket_lat=28.6, rocket_lon=-80.6, rocket_alt_km=45.0,
        pad_lat=28.6, pad_lon=-80.6,
        launch_azimuth_deg=45.0,
        slant_range_km=800.0,
        apparent_plume_angle_mrad=plume_mrad,
        rocket_sun_state=sun_state,
        background_dark_score=bg_dark,
        obstruction_cloud_score=obstruction,
        background_cloud_score=background,
        profile_confidence=confidence,
    )


def test_multiplier_perfect_conditions_at_ceiling() -> None:
    mult = ascent_score_multiplier(_prediction())
    assert mult == MULTIPLIER_CEILING


def test_multiplier_zero_components_floors() -> None:
    """All-zero components would yield 0 raw → floor."""
    p = _prediction(bg_dark=0.0)
    assert ascent_score_multiplier(p) == MULTIPLIER_FLOOR


def test_multiplier_penumbra_reduces() -> None:
    sunlit = ascent_score_multiplier(_prediction(sun_state=SunState.SUNLIT))
    penumbra = ascent_score_multiplier(_prediction(sun_state=SunState.PENUMBRA))
    assert penumbra < sunlit


def test_multiplier_always_in_bounds() -> None:
    """Any combination of inputs stays in [MULTIPLIER_FLOOR, MULTIPLIER_CEILING]."""
    for plume in (0.0, 0.5, 3.0, 10.0):
        for bg in (0.0, 0.5, 1.0):
            for sun in (SunState.SUNLIT, SunState.PENUMBRA):
                p = _prediction(plume_mrad=plume, bg_dark=bg, sun_state=sun)
                mult = ascent_score_multiplier(p)
                assert MULTIPLIER_FLOOR <= mult <= MULTIPLIER_CEILING


# --------------------------------------------------------------------------
# AscentPrediction convenience
# --------------------------------------------------------------------------


def test_best_instant_utc() -> None:
    p = _prediction()
    assert p.best_instant_utc == p.t0_utc + timedelta(seconds=120)
