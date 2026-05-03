"""Tests for generator.orbit."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta, timezone

import pytest

from generator.orbit import (
    TLE,
    Pass,
    Position,
    angle_off_nadir_deg,
    detect_reboost,
    find_passes,
    fit_iss_polynomial,
    freshness_factor,
    great_circle_km,
    propagate,
    teme_to_geodetic,
    tle_age_hours,
)
from tests.conftest import SAMPLE_TLE_TEXT

# --------------------------------------------------------------------------
# TLE parsing
# --------------------------------------------------------------------------


def test_tle_from_text_parses_real_iss_tle(sample_tle: TLE) -> None:
    assert sample_tle.line1.startswith("1 25544")
    assert sample_tle.line2.startswith("2 25544")
    assert sample_tle.epoch.tzinfo == UTC
    assert sample_tle.epoch.year == 2024


def test_tle_from_text_rejects_too_few_lines() -> None:
    with pytest.raises(ValueError, match="at least 2 lines"):
        TLE.from_text("just one line\n")


def test_tle_from_text_rejects_malformed() -> None:
    bad = "garbage line one\ngarbage line two\n"
    with pytest.raises(ValueError, match="malformed TLE"):
        TLE.from_text(bad)


def test_tle_from_text_strips_name_line() -> None:
    # First line is satellite name, then the two TLE lines
    tle = TLE.from_text(SAMPLE_TLE_TEXT)
    assert "25544" in tle.line1


# --------------------------------------------------------------------------
# Propagation
# --------------------------------------------------------------------------


def test_propagate_returns_valid_position(sample_tle: TLE, now_utc: datetime) -> None:
    pos = propagate(sample_tle, now_utc)
    assert isinstance(pos, Position)
    assert -90 <= pos.lat <= 90
    assert -180 <= pos.lon <= 180
    assert 350 < pos.alt_km < 470  # ISS altitude band


def test_propagate_rejects_naive_datetime(sample_tle: TLE) -> None:
    with pytest.raises(ValueError, match="UTC-aware"):
        propagate(sample_tle, datetime(2024, 10, 17, 12, 0, 0))


def test_propagate_rejects_non_utc_datetime(sample_tle: TLE) -> None:
    eastern = timezone(timedelta(hours=-5))
    with pytest.raises(ValueError, match="UTC-aware"):
        propagate(sample_tle, datetime(2024, 10, 17, 12, 0, 0, tzinfo=eastern))


def test_propagate_advances_position_over_time(sample_tle: TLE, now_utc: datetime) -> None:
    p1 = propagate(sample_tle, now_utc)
    p2 = propagate(sample_tle, now_utc + timedelta(minutes=5))
    # ISS should have moved meaningfully in 5 minutes
    d = great_circle_km(p1.lat, p1.lon, p2.lat, p2.lon)
    assert d > 1000  # > 1000 km in 5 min at orbital speed


# --------------------------------------------------------------------------
# Freshness
# --------------------------------------------------------------------------


def test_tle_age_hours(sample_tle: TLE) -> None:
    later = sample_tle.epoch + timedelta(hours=12)
    assert tle_age_hours(sample_tle, later) == pytest.approx(12.0)


def test_tle_age_hours_rejects_naive(sample_tle: TLE) -> None:
    with pytest.raises(ValueError):
        tle_age_hours(sample_tle, datetime(2024, 10, 17))


def test_freshness_factor_full_within_24h() -> None:
    assert freshness_factor(0.0) == 1.0
    assert freshness_factor(12.0) == 1.0
    assert freshness_factor(24.0) == 1.0


def test_freshness_factor_decays_after_24h() -> None:
    assert freshness_factor(36.0) == pytest.approx(0.9)
    assert freshness_factor(48.0) == pytest.approx(0.8)


def test_freshness_factor_floors_at_half() -> None:
    assert freshness_factor(120.0) == 0.5
    assert freshness_factor(1000.0) == 0.5


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------


def test_great_circle_km_same_point() -> None:
    assert great_circle_km(35.0, 139.0, 35.0, 139.0) == 0.0


def test_great_circle_km_antipodes() -> None:
    # ~ half Earth circumference (Earth radius 6378.137 km)
    d = great_circle_km(0.0, 0.0, 0.0, 180.0)
    assert d == pytest.approx(math.pi * 6378.137, rel=1e-3)


def test_great_circle_km_known_distance() -> None:
    # Tokyo to NYC ~ 10850 km
    d = great_circle_km(35.68, 139.69, 40.71, -74.01)
    assert 10500 < d < 11200


def test_teme_to_geodetic_rejects_naive() -> None:
    with pytest.raises(ValueError):
        teme_to_geodetic((6500.0, 0.0, 0.0), datetime(2024, 10, 17))


# --------------------------------------------------------------------------
# Pass finding
# --------------------------------------------------------------------------


def test_find_passes_returns_empty_for_zero_window(sample_tle: TLE, now_utc: datetime) -> None:
    target = {"id": "x", "geom": {"lat": 0.0, "lon": 0.0}}
    assert find_passes(sample_tle, target, now_utc, now_utc) == []


def test_find_passes_rejects_naive_window(sample_tle: TLE) -> None:
    target = {"id": "x", "geom": {"lat": 0.0, "lon": 0.0}}
    with pytest.raises(ValueError):
        find_passes(sample_tle, target, datetime(2024, 10, 17), datetime(2024, 10, 18))


def test_find_passes_returns_local_minima(sample_tle: TLE, now_utc: datetime) -> None:
    # The ISS will pass over many points in 6h. Use the equator to maximize hits.
    target = {"id": "equator-test", "geom": {"lat": 0.0, "lon": 0.0}}
    passes = find_passes(
        sample_tle,
        target,
        now_utc,
        now_utc + timedelta(hours=6),
        step_seconds=60,
        max_distance_km=2000.0,
    )
    assert len(passes) >= 1
    for p in passes:
        assert isinstance(p, Pass)
        assert p.target_id == "equator-test"
        assert p.nadir_distance_km < 2000.0


def test_find_passes_no_passes_for_polar_target(sample_tle: TLE, now_utc: datetime) -> None:
    # ISS inclination ~51.6°; a target at 80° latitude is never visible.
    target = {"id": "polar", "geom": {"lat": 85.0, "lon": 0.0}}
    passes = find_passes(
        sample_tle,
        target,
        now_utc,
        now_utc + timedelta(hours=6),
        step_seconds=60,
        max_distance_km=500.0,  # camera-friendly horizon
    )
    assert passes == []


# --------------------------------------------------------------------------
# Polynomial fit
# --------------------------------------------------------------------------


def test_fit_iss_polynomial_returns_coeffs_30min(sample_tle: TLE, now_utc: datetime) -> None:
    """30-min window scales to 5th order."""
    poly = fit_iss_polynomial(sample_tle, now_utc, minutes=30, samples=31)
    assert "lat_coeffs" in poly
    assert "lon_coeffs" in poly
    assert len(poly["lat_coeffs"]) == 6  # 5th order = 6 coefficients
    assert len(poly["lon_coeffs"]) == 6
    assert poly["polynomial_order"] == 5
    assert poly["start"].endswith("Z")


def test_fit_iss_polynomial_scales_order_for_1h_window(
    sample_tle: TLE, now_utc: datetime
) -> None:
    """1h window scales to 7th order — covers ~0.65 ISS orbits cleanly."""
    poly = fit_iss_polynomial(sample_tle, now_utc, minutes=60)
    assert poly["polynomial_order"] == 7
    assert len(poly["lat_coeffs"]) == 8


def test_fit_iss_polynomial_scales_order_for_2h_window(
    sample_tle: TLE, now_utc: datetime
) -> None:
    """2h window scales to 11th order to keep accuracy across ~1.3 orbits."""
    poly = fit_iss_polynomial(sample_tle, now_utc, minutes=120)
    assert poly["polynomial_order"] == 11
    assert len(poly["lat_coeffs"]) == 12


def test_fit_iss_polynomial_handles_antimeridian(sample_tle: TLE, now_utc: datetime) -> None:
    """Polynomial fit should not blow up when the ISS crosses ±180° longitude in the window."""
    # Use a 90-min window so the ISS crosses the antimeridian at least once
    poly = fit_iss_polynomial(sample_tle, now_utc, minutes=90, samples=91)
    # Coefficients should be finite numbers
    for c in poly["lat_coeffs"] + poly["lon_coeffs"]:
        assert math.isfinite(c)


# --------------------------------------------------------------------------
# Reboost detection
# --------------------------------------------------------------------------


def test_detect_reboost_first_tle_returns_false(sample_tle: TLE) -> None:
    assert detect_reboost(None, sample_tle) is False


def test_detect_reboost_same_tle_returns_false(sample_tle: TLE) -> None:
    assert detect_reboost(sample_tle, sample_tle) is False


def test_detect_reboost_threshold() -> None:
    """A simulated mean motion change > 0.005 rev/day should flag a reboost."""
    base = (
        "1 25544U 98067A   24290.79041667  .00031560  00000-0  56270-3 0  9990\n"
        "2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.49814196479596"
    )
    # Boosted version: mean motion bumped by ~0.05 rev/day
    boosted = (
        "1 25544U 98067A   24290.79041667  .00031560  00000-0  56270-3 0  9990\n"
        "2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.55000000479596"
    )
    prev = TLE.from_text(base)
    curr = TLE.from_text(boosted)
    assert detect_reboost(prev, curr) is True


# --------------------------------------------------------------------------
# Angle off nadir
# --------------------------------------------------------------------------


def test_angle_off_nadir_zero_at_subpoint() -> None:
    assert angle_off_nadir_deg(0.0, 408.0) == 0.0


def test_angle_off_nadir_negative_distance_clamped() -> None:
    assert angle_off_nadir_deg(-5.0, 408.0) == 0.0


def test_angle_off_nadir_30deg_threshold_at_iss_alt() -> None:
    """At 408 km altitude, 30° off-nadir falls at ~236 km ground distance.
    Verifies the WORF/Cupola threshold matches what is shown to the user."""
    deg = angle_off_nadir_deg(236.0, 408.0)
    assert 29.5 < deg < 30.5


def test_angle_off_nadir_below_threshold_for_close_pass() -> None:
    # 100 km nadir distance at ISS altitude should be well under 30°
    deg = angle_off_nadir_deg(100.0, 408.0)
    assert 13.0 < deg < 14.5


def test_angle_off_nadir_approaches_horizon_at_long_distance() -> None:
    # Near the visibility horizon (~2225 km ground distance for ISS), angle
    # approaches the horizon limit (~70°) but not over it.
    deg = angle_off_nadir_deg(2200.0, 408.0)
    assert 68.0 < deg < 71.0


def test_angle_off_nadir_scales_with_altitude() -> None:
    # Same ground distance, higher altitude → smaller angle off nadir.
    a_low = angle_off_nadir_deg(200.0, 200.0)
    a_high = angle_off_nadir_deg(200.0, 800.0)
    assert a_low > a_high

