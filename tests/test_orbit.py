"""Tests for generator.orbit."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta, timezone

import pytest

from generator.orbit import (
    ENCOUNTER_MAX_OFF_NADIR_DEG,
    TLE,
    Encounter,
    Pass,
    Position,
    _find_encounter,
    _relative_bearing_at,
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
    assert p.encounter is None  # encounter also defaults None for direct construction


# --------------------------------------------------------------------------
# Initial-encounter scan (_find_encounter / find_passes encounter field).
# Production threshold is ENCOUNTER_MAX_OFF_NADIR_DEG (60°). The scan-mechanics
# unit tests below pass an explicit max_off_nadir_deg=45.0 so their synthetic
# fixtures (which straddle the 45° ≈ 420 km boundary: 400 km → 43.5°, 450 km →
# 46.7°) stay valid independent of the production default.
# --------------------------------------------------------------------------


def _enc_samples(
    distances_km: list[float],
    *,
    alt_km: float = 408.0,
    step_s: int = 30,
) -> list[tuple[datetime, Position, float]]:
    """Build a synthetic (time, Position, ground_distance) sample list. The ISS
    walks east along the equator (so headings are well-defined); only the
    ground distances drive the off-nadir scan, so they're set directly."""
    base = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    out: list[tuple[datetime, Position, float]] = []
    for k, d in enumerate(distances_km):
        when = base + timedelta(seconds=step_s * k)
        out.append((when, Position(lat=0.0, lon=0.1 * k, alt_km=alt_km, when=when), d))
    return out


def test_find_encounter_precedes_closest_and_within_threshold() -> None:
    """Encounter is the earliest contiguous sample still within 45° off-nadir,
    so it precedes closest approach and the sample just before it exceeds 45°."""
    # idx:        0    1    2    3    4(closest)
    # dist km:   700  450  300  200  100
    # off-nadir: 58   46.7 35.8 25.9 14    → 450 km (idx1) is the first >45 break
    samples = _enc_samples([700, 450, 300, 200, 100])
    enc = _find_encounter(samples, 4, lat_t=0.0, lon_t=2.0, max_off_nadir_deg=45.0)
    assert enc is not None
    assert enc.off_nadir_deg <= 45.0
    assert enc.time < samples[4][0]  # strictly before closest approach
    # The encounter sample is idx 2 (300 km); idx 1 (450 km) is the break point.
    assert enc.time == samples[2][0]
    assert 0.0 <= enc.rel_bearing_deg < 360.0
    # Invariant: the sample one step earlier than the encounter exceeds 45°.
    enc_idx = next(i for i, s in enumerate(samples) if s[0] == enc.time)
    assert enc_idx == 0 or angle_off_nadir_deg(
        samples[enc_idx - 1][2], samples[enc_idx - 1][1].alt_km
    ) > 45.0


def test_find_encounter_none_when_closest_never_frameable() -> None:
    """A distant/grazing pass whose closest approach is itself past 45°
    off-nadir never becomes frameable — no encounter."""
    # closest 500 km → 49.4° off-nadir, already > 45°.
    samples = _enc_samples([900, 700, 500])
    assert _find_encounter(samples, 2, lat_t=0.0, lon_t=1.0, max_off_nadir_deg=45.0) is None


def test_find_encounter_none_when_only_frameable_at_closest() -> None:
    """If the target crosses inside 45° only within the final step before
    closest approach, there's no meaningful earlier encounter → None (avoids a
    redundant ENCOUNTER row duplicating the closest moment)."""
    # idx0 700 (58°, >45), idx1 450 (46.7°, >45), idx2 400 (43.5°, ≤45 closest)
    samples = _enc_samples([700, 450, 400])
    assert _find_encounter(samples, 2, lat_t=0.0, lon_t=1.0, max_off_nadir_deg=45.0) is None


def test_find_encounter_none_at_local_max_without_observed_crossing() -> None:
    """When the target stays inside 45° across a local distance maximum (framed
    continuously, e.g. spanning a previous approach), the crossing is never
    observed, so no honest initial-encounter time exists → None. The scan also
    stops at the local max rather than walking into the separate previous lobe."""
    # idx:        0    1(local max)  2    3(closest)
    # dist km:   200      350       300   100
    # off-nadir: 25.9     40.0     35.8   14    → all <45, no crossing observed
    samples = _enc_samples([200, 350, 300, 100])
    assert _find_encounter(samples, 3, lat_t=0.0, lon_t=1.0, max_off_nadir_deg=45.0) is None


def test_find_encounter_none_when_already_frameable_at_window_start() -> None:
    """If the window opens with the target already inside 45° and it only gets
    closer (no observed crossing before sample[0]), the true initial encounter
    predates our samples — return None rather than fabricate the window-edge
    time as the encounter (Codex review P2)."""
    # all within 45°, monotonically closing: 300→35.8, 200→25.9, 100→14
    samples = _enc_samples([300, 200, 100])
    assert _find_encounter(samples, 2, lat_t=0.0, lon_t=1.0, max_off_nadir_deg=45.0) is None


def test_relative_bearing_at_returns_valid_bearing() -> None:
    """Direct unit for the shared bearing helper (used by both find_passes and
    _find_encounter). Reuses the idx→idx+1 heading; caller guarantees idx+1 is
    in range. Pin a valid [0,360) result on a tiny eastward synthetic track."""
    samples = _enc_samples([300, 200, 100])  # ISS walks east along the equator
    b = _relative_bearing_at(samples, 0, lat_t=0.0, lon_t=1.0)
    assert 0.0 <= b < 360.0


def test_find_encounter_threshold_is_inclusive_at_exact_boundary() -> None:
    """The off-nadir gate is `> max` (strict), so a sample sitting EXACTLY on
    the threshold is still frameable (included), not excluded. Pin the `>` vs
    `>=` discrimination by setting the threshold to a sample's exact angle."""
    samples = _enc_samples([700, 450, 300, 100])  # closest at idx3
    boundary = angle_off_nadir_deg(samples[1][2], samples[1][1].alt_km)  # idx1 angle
    enc = _find_encounter(samples, 3, lat_t=0.0, lon_t=1.0, max_off_nadir_deg=boundary)
    assert enc is not None
    # idx1's angle == threshold, and `> threshold` is False, so the scan does
    # NOT break at idx1 — the encounter reaches idx1 (or earlier if idx0 also
    # qualifies; here idx0=700km is well past, so idx1 is the earliest).
    assert enc.time == samples[1][0]


def test_encounter_default_threshold_is_60_degrees() -> None:
    """Production threshold widened 45°→60° (operator feedback 2026-06-03): 45°
    put the crossing only ~30-60s before closest (minute-rounded countdowns
    collapsed) and excluded every Cupola-range pass. 60° ≈ the 800 km search
    cone — ~2 min lead and oblique passes get an initial."""
    assert ENCOUNTER_MAX_OFF_NADIR_DEG == 60.0


def test_find_encounter_covers_cupola_range_pass() -> None:
    """A Cupola-range pass (closest 45-60° off-nadir, e.g. Rome at ~57°) now gets
    an initial encounter at the 60° default — the old 45° threshold returned
    None for these (the 'no initial row on oblique targets' the operator saw)."""
    samples = _enc_samples([900, 700, 680])
    closest_off = angle_off_nadir_deg(samples[2][2], samples[2][1].alt_km)
    crossing_off = angle_off_nadir_deg(samples[0][2], samples[0][1].alt_km)
    assert 45.0 < closest_off < 60.0   # genuinely Cupola-range (45° would exclude)
    assert crossing_off > 60.0          # idx0 is the observed >60° crossing
    enc = _find_encounter(samples, 2, lat_t=0.0, lon_t=1.0)  # default 60°
    assert enc is not None
    assert enc.time < samples[2][0]
    assert enc.off_nadir_deg <= 60.0


def test_find_passes_attaches_encounter(sample_tle: TLE) -> None:
    """Real find_passes attaches an Encounter to frameable passes; when present
    it precedes closest approach, sits within the threshold, and looks more
    forward than the closest-approach bearing (the look angle sweeps
    fore → nadir → aft across a pass)."""
    target = {
        "id": "test",
        "name": "Test",
        "geom": {"type": "point", "lat": 0.0, "lon": 0.0},
        "priority": 5,
        "regime": "any",
    }
    start = datetime(2024, 10, 17, 0, 0, tzinfo=UTC)
    end = start + timedelta(hours=24)
    passes = find_passes(sample_tle, target, start, end, step_seconds=30)
    assert len(passes) > 0
    framed = [p for p in passes if p.encounter is not None]
    assert framed, "expected at least one frameable pass with an encounter"
    for p in framed:
        assert isinstance(p.encounter, Encounter)
        assert p.encounter.off_nadir_deg <= ENCOUNTER_MAX_OFF_NADIR_DEG + 1e-6
        # Encounter is always strictly before closest (equal-index is suppressed).
        assert p.encounter.time < p.closest_approach
        assert 0.0 <= p.encounter.rel_bearing_deg < 360.0
        # Forwardness = cos(bearing): +1 fore, 0 abeam, -1 aft. As the ISS
        # approaches and passes, forwardness decreases monotonically, so the
        # earlier encounter is at least as forward as the closest moment.
        assert p.iss_relative_bearing_deg is not None
        fwd_enc = math.cos(math.radians(p.encounter.rel_bearing_deg))
        fwd_closest = math.cos(math.radians(p.iss_relative_bearing_deg))
        assert fwd_enc >= fwd_closest - 0.05


# --------------------------------------------------------------------------
# Encounter pre-roll (find_passes preroll_seconds). Restores the INITIAL row
# for passes whose closest approach lands in the first minutes of a tick (whose
# cone crossing predates window_start) while never surfacing an already-past
# pass. Tests anchor on a real pass so they survive ephemeris changes.
# --------------------------------------------------------------------------

_PREROLL_TARGET = {
    "id": "preroll-test",
    "name": "Preroll",
    "geom": {"type": "point", "lat": 0.0, "lon": 0.0},
    "priority": 5,
    "regime": "any",
}


def _anchor_pass_with_lead(
    tle: TLE, start: datetime, end: datetime, min_lead_s: float,
) -> Pass:
    """The framed pass with the LARGEST encounter→closest lead, so the emit
    window can open between the crossing and closest with room to spare."""
    framed = [
        p for p in find_passes(tle, _PREROLL_TARGET, start, end, step_seconds=30)
        if p.encounter is not None
    ]
    assert framed, "expected at least one framed pass to anchor on"
    best = max(framed, key=lambda p: (p.closest_approach - p.encounter.time).total_seconds())
    lead = (best.closest_approach - best.encounter.time).total_seconds()
    assert lead >= min_lead_s, f"best encounter lead {lead}s < required {min_lead_s}s"
    return best


def test_preroll_recovers_encounter_lost_when_window_opens_after_crossing(
    sample_tle: TLE,
) -> None:
    start = datetime(2024, 10, 17, 0, 0, tzinfo=UTC)
    anchor = _anchor_pass_with_lead(sample_tle, start, start + timedelta(hours=24), 60.0)
    assert anchor.encounter is not None

    # Open the emit window AFTER the crossing but before closest, so the scan
    # cannot see the crossing from window_start alone.
    window_start = anchor.encounter.time + timedelta(seconds=30)
    assert window_start < anchor.closest_approach  # the pass still emits
    window_end = anchor.closest_approach + timedelta(minutes=5)

    def _the_pass(passes: list[Pass]) -> Pass | None:
        for p in passes:
            if abs((p.closest_approach - anchor.closest_approach).total_seconds()) < 1:
                return p
        return None

    # Without pre-roll: crossing predates the window → no encounter.
    no_pre = _the_pass(find_passes(sample_tle, _PREROLL_TARGET, window_start, window_end, step_seconds=30))
    assert no_pre is not None, "the pass itself should still emit without pre-roll"
    assert no_pre.encounter is None

    # With pre-roll reaching back past the crossing: encounter recovered, and it
    # matches the originally-observed crossing time (grids align on the 30s step).
    pre = _the_pass(find_passes(
        sample_tle, _PREROLL_TARGET, window_start, window_end,
        step_seconds=30, preroll_seconds=600,
    ))
    assert pre is not None and pre.encounter is not None
    assert abs((pre.encounter.time - anchor.encounter.time).total_seconds()) < 1


def test_preroll_never_emits_a_pass_whose_closest_is_before_window_start(
    sample_tle: TLE,
) -> None:
    start = datetime(2024, 10, 17, 0, 0, tzinfo=UTC)
    anchor = _anchor_pass_with_lead(sample_tle, start, start + timedelta(hours=24), 60.0)

    # window_start AFTER this pass's closest, with a pre-roll that reaches back
    # past it — the now-past pass sits squarely in the pre-roll region.
    window_start = anchor.closest_approach + timedelta(seconds=60)
    window_end = window_start + timedelta(hours=2)

    passes = find_passes(
        sample_tle, _PREROLL_TARGET, window_start, window_end,
        step_seconds=30, preroll_seconds=900,
    )
    # Pre-roll is context only: nothing before the emit window may surface.
    for p in passes:
        assert p.closest_approach >= window_start
    assert all(
        abs((p.closest_approach - anchor.closest_approach).total_seconds()) > 1
        for p in passes
    ), "the past pass in the pre-roll region must not be emitted"
