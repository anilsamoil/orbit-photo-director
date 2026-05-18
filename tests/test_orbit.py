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
    great_circle_bearing_deg,
    great_circle_km,
    propagate,
    relative_bearing_deg,
    sample_track_points,
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


def test_fit_iss_polynomial_caps_order_at_11_for_long_windows(
    sample_tle: TLE, now_utc: datetime
) -> None:
    """Past 180 min, order is capped at 11 (numerical stability).

    Higher order on a single-variable polyfit triggers RankWarning and Runge
    oscillations near the window edges. The cap forces callers into the
    shorter-window or client-side-SGP4 path instead of getting a wobbly fit.
    """
    poly = fit_iss_polynomial(sample_tle, now_utc, minutes=240)
    assert poly["polynomial_order"] == 11


def _eval_poly(coeffs: list[float], t: float) -> float:
    acc = 0.0
    for c in coeffs:
        acc = acc * t + c
    return acc


def test_fit_iss_polynomial_residual_30min_under_tenth_degree(
    sample_tle: TLE, now_utc: datetime
) -> None:
    """30-min window at order 5 fits ISS lat within 0.1° max residual.

    The 30-min/order-5 regime is where the polynomial is genuinely
    accurate (~0.006° measured). 0.1° is loose regression-guard headroom
    — if a future change cuts samples or drops the order past need, this
    fires before the live ISS dot visibly drifts.
    """
    from generator.orbit import propagate

    minutes = 30
    poly = fit_iss_polynomial(sample_tle, now_utc, minutes=minutes)

    max_lat_err = 0.0
    for sec in range(0, minutes * 60 + 1, 30):
        truth = propagate(sample_tle, now_utc + timedelta(seconds=sec))
        fit_lat = _eval_poly(poly["lat_coeffs"], float(sec))
        err = abs(truth.lat - fit_lat)
        if err > max_lat_err:
            max_lat_err = err

    assert max_lat_err < 0.1, (
        f"30-min polynomial lat residual {max_lat_err:.3f}° > 0.1° threshold."
    )


def test_fit_iss_polynomial_residual_120min_documented_drift(
    sample_tle: TLE, now_utc: datetime
) -> None:
    """120-min window at order 11 documents the lat drift envelope.

    Reality: ~1° max lat error across a 2-hour window covering ~1.3 ISS
    orbits. The live ISS dot displays at ~3-pixel resolution at the
    default map zoom, so 1° drift is visually noticeable but not
    catastrophic. V3 ships satellite.js client-side SGP4 to replace this
    past the 60-min window. The cap here is a regression-guard, not a
    quality target.
    """
    from generator.orbit import propagate

    minutes = 120
    poly = fit_iss_polynomial(sample_tle, now_utc, minutes=minutes)

    max_lat_err = 0.0
    for sec in range(0, minutes * 60 + 1, 30):
        truth = propagate(sample_tle, now_utc + timedelta(seconds=sec))
        fit_lat = _eval_poly(poly["lat_coeffs"], float(sec))
        err = abs(truth.lat - fit_lat)
        if err > max_lat_err:
            max_lat_err = err

    assert max_lat_err < 2.0, (
        f"120-min polynomial lat residual {max_lat_err:.3f}° > 2.0°: regression "
        "vs the documented ~1° envelope. Either bump samples, change basis "
        "(Chebyshev), or accelerate the SGP4-client-side V3 plan."
    )


def test_fit_iss_polynomial_handles_antimeridian(sample_tle: TLE, now_utc: datetime) -> None:
    """Polynomial fit should not blow up when the ISS crosses ±180° longitude in the window."""
    # Use a 90-min window so the ISS crosses the antimeridian at least once
    poly = fit_iss_polynomial(sample_tle, now_utc, minutes=90, samples=91)
    # Pin the order=9 branch (60 < minutes <= 90) — closes the only branch
    # gap in _polynomial_order_for_window.
    assert poly["polynomial_order"] == 9
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


def test_detect_reboost_fires_on_mean_motion_decrease() -> None:
    """A reboost adds energy → raises altitude → mean motion DECREASES.
    detect_reboost only fires in that direction."""
    base = (
        "1 25544U 98067A   24290.79041667  .00031560  00000-0  56270-3 0  9990\n"
        "2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.49814196479596"
    )
    # Reboosted: mean motion DECREASED by ~0.05 rev/day (orbit raised).
    reboosted = (
        "1 25544U 98067A   24290.79041667  .00031560  00000-0  56270-3 0  9990\n"
        "2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.44814196479596"
    )
    prev = TLE.from_text(base)
    curr = TLE.from_text(reboosted)
    assert detect_reboost(prev, curr) is True


def test_detect_reboost_does_not_fire_on_mean_motion_increase() -> None:
    """The opposite direction (mean motion INCREASES) is a deboost / debris
    avoidance burn that lowers the orbit. The previous abs()-based check
    flagged this as a reboost too — a false positive that ground-side
    support could misread as a planned orbit raise."""
    base = (
        "1 25544U 98067A   24290.79041667  .00031560  00000-0  56270-3 0  9990\n"
        "2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.49814196479596"
    )
    deboosted = (
        "1 25544U 98067A   24290.79041667  .00031560  00000-0  56270-3 0  9990\n"
        "2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.55000000479596"
    )
    prev = TLE.from_text(base)
    curr = TLE.from_text(deboosted)
    # Mean motion went UP — not a reboost.
    assert detect_reboost(prev, curr) is False


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



# --------------------------------------------------------------------------
# sample_track_points — raw SGP4 samples for the 2-orbit ground track
# --------------------------------------------------------------------------


def test_sample_track_points_count_matches_duration_and_step(
    sample_tle: TLE, now_utc: datetime
) -> None:
    """200 min × 1 sample / 30s + 1 = 401 points (inclusive boundary)."""
    pts = sample_track_points(sample_tle, now_utc, minutes=200, step_seconds=30)
    assert len(pts) == 401
    assert pts[0][0] == 0.0
    assert pts[-1][0] == 200.0 * 60.0


def test_sample_track_points_lat_lon_match_propagate(
    sample_tle: TLE, now_utc: datetime
) -> None:
    """Each sample matches a direct propagate() call at the same time."""
    pts = sample_track_points(sample_tle, now_utc, minutes=10, step_seconds=60)
    for t_sec, lat, lon in pts:
        truth = propagate(sample_tle, now_utc + timedelta(seconds=int(t_sec)))
        # 3-decimal rounding in the sampler → ~0.001° tolerance
        assert abs(truth.lat - lat) < 0.005
        assert abs(truth.lon - lon) < 0.005


def test_sample_track_points_covers_two_full_orbits(
    sample_tle: TLE, now_utc: datetime
) -> None:
    """200 min ≈ 2.15 ISS orbits — lat traces should peak at +51.6° and dip
    to -51.6° at least twice (two full crossings of each extreme)."""
    pts = sample_track_points(sample_tle, now_utc, minutes=200, step_seconds=30)
    lats = [p[1] for p in pts]
    # ISS inclination ≈ 51.6°; allow a small margin for SGP4
    assert max(lats) > 50.0, f"max lat {max(lats)} should exceed +50°"
    assert min(lats) < -50.0, f"min lat {min(lats)} should be below -50°"


def test_sample_track_points_rejects_naive(sample_tle: TLE) -> None:
    with pytest.raises(ValueError):
        sample_track_points(sample_tle, datetime(2024, 10, 17, 12, 0, 0))


def test_sample_track_points_payload_size_under_15kb(
    sample_tle: TLE, now_utc: datetime
) -> None:
    """200-min track at 30-s step compresses to under 15 KB JSON.
    If a future change changes the encoding (more decimals, more fields),
    this test fires before the artifact bloat reaches the user's bandwidth.
    """
    import json
    pts = sample_track_points(sample_tle, now_utc, minutes=200, step_seconds=30)
    encoded = json.dumps(pts)
    assert len(encoded) < 15_000, f"track_points JSON {len(encoded)} bytes > 15 KB cap"


# --------------------------------------------------------------------------
# great_circle_bearing_deg + relative_bearing_deg (operator direction hint)
# --------------------------------------------------------------------------


def test_bearing_due_north_is_zero() -> None:
    # From equator at lon 0 to north pole, bearing should be 0° (north).
    assert great_circle_bearing_deg(0.0, 0.0, 89.9, 0.0) == pytest.approx(0.0, abs=0.1)


def test_bearing_due_east_is_ninety() -> None:
    # From equator (0, 0) to a nearby east point — bearing 90°.
    assert great_circle_bearing_deg(0.0, 0.0, 0.0, 0.1) == pytest.approx(90.0, abs=0.1)


def test_bearing_due_south_is_one_eighty() -> None:
    assert great_circle_bearing_deg(0.0, 0.0, -0.1, 0.0) == pytest.approx(180.0, abs=0.1)


def test_bearing_due_west_is_two_seventy() -> None:
    assert great_circle_bearing_deg(0.0, 0.0, 0.0, -0.1) == pytest.approx(270.0, abs=0.1)


def test_bearing_antimeridian_crossing() -> None:
    """Going east from lon=179 to lon=-179 (crosses dateline) should still be ~east."""
    b = great_circle_bearing_deg(0.0, 179.0, 0.0, -179.0)
    assert 85.0 <= b <= 95.0


def test_relative_bearing_target_dead_ahead() -> None:
    """ISS heading east + target due east → relative 0° (fore)."""
    assert relative_bearing_deg(iss_heading_deg=90.0, target_bearing_deg=90.0) == 0.0


def test_relative_bearing_target_starboard() -> None:
    """ISS heading north + target due east → 90° (starboard)."""
    assert relative_bearing_deg(iss_heading_deg=0.0, target_bearing_deg=90.0) == 90.0


def test_relative_bearing_target_aft() -> None:
    """ISS heading north + target due south → 180° (aft)."""
    assert relative_bearing_deg(iss_heading_deg=0.0, target_bearing_deg=180.0) == 180.0


def test_relative_bearing_target_port() -> None:
    """ISS heading north + target due west → 270° (port)."""
    assert relative_bearing_deg(iss_heading_deg=0.0, target_bearing_deg=270.0) == 270.0


def test_relative_bearing_wraps_correctly() -> None:
    """If target bearing < heading, the modulo math should still give [0, 360)."""
    assert relative_bearing_deg(iss_heading_deg=350.0, target_bearing_deg=10.0) == 20.0


# --------------------------------------------------------------------------
# find_passes populates iss_relative_bearing_deg
# --------------------------------------------------------------------------


def test_find_passes_includes_relative_bearing(sample_tle: TLE) -> None:
    """A real find_passes call should attach a relative-bearing field to
    every returned Pass (lets the frontend render "look starboard")."""
    target = {
        "id": "test",
        "name": "Test",
        "geom": {"type": "point", "lat": 0.0, "lon": 0.0},
        "priority": 5,
        "regime": "any",
    }
    # Search a long enough window that we hit at least one near pass over
    # (0, 0). The ISS visits the equator twice per orbit; over 24h we'll
    # see several near passes within 800km.
    start = datetime(2024, 10, 17, 0, 0, tzinfo=UTC)
    end = start + timedelta(hours=24)
    passes = find_passes(sample_tle, target, start, end, step_seconds=60)
    assert len(passes) > 0, "expected at least one near-equator pass in 24h"
    for p in passes:
        assert p.iss_relative_bearing_deg is not None
        assert 0.0 <= p.iss_relative_bearing_deg < 360.0


def test_pass_dataclass_relative_bearing_defaults_none() -> None:
    """The field is optional so unit tests that construct Pass directly
    (without a TLE/heading context) still work after the schema bump."""
    p = Pass(
        target_id="x",
        target_lat=0.0,
        target_lon=0.0,
        closest_approach=datetime(2024, 10, 17, 12, 0, tzinfo=UTC),
        nadir_distance_km=100.0,
        iss_position=Position(lat=0.0, lon=0.0, alt_km=408.0,
                              when=datetime(2024, 10, 17, 12, 0, tzinfo=UTC)),
    )
    assert p.iss_relative_bearing_deg is None
