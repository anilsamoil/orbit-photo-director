"""Offline analytic fixtures, independent of the production frame algebra."""

from __future__ import annotations

import math
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sgp4.api import Satrec, jday

from generator import launch_geometry as geometry
from generator.orbit import TLE, teme_to_geodetic

POSITION = (7000.0, 0.0, 0.0)
VELOCITY = (2.0, 7.0, 0.0)
TARGET = (6900.0, 100.0, 100.0)
WHEN = datetime(2000, 1, 1, 12, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clear_satrec_cache():
    geometry._satrec.cache_clear()
    yield
    geometry._satrec.cache_clear()


def _assert_look(result, azimuth, off_nadir):
    assert set(result) == {"frame", "azimuth_deg", "off_nadir_deg"}
    assert result["frame"] == "orbital-lvlh"
    assert type(result["azimuth_deg"]) is float
    assert type(result["off_nadir_deg"]) is float
    assert 0.0 <= result["azimuth_deg"] < 360.0
    assert 0.0 <= result["off_nadir_deg"] <= 180.0
    assert result["azimuth_deg"] == pytest.approx(azimuth, abs=1e-9)
    assert result["off_nadir_deg"] == pytest.approx(off_nadir, abs=1e-9)


CARDINAL_CASES = [
    pytest.param((6900.0, 100.0, 0.0), 0.0, 45.0, id="ahead"),
    pytest.param((6900.0, 0.0, 100.0), 90.0, 45.0, id="right-positive-z"),
    pytest.param((6900.0, -100.0, 0.0), 180.0, 45.0, id="aft"),
    pytest.param((6900.0, 0.0, -100.0), 270.0, 45.0, id="left-negative-z"),
    pytest.param((6900.0, 100.0, 100.0), 45.0, 54.735610317245346, id="ahead-right"),
    pytest.param((7000.0, 100.0, 0.0), 0.0, 90.0, id="horizontal-ahead"),
    pytest.param((7000.0, 0.0, 100.0), 90.0, 90.0, id="horizontal-right"),
    pytest.param((7100.0, 100.0, 0.0), 0.0, 135.0, id="above-observer"),
    pytest.param((6500.0, 0.0, 0.0), 0.0, 0.0, id="nadir-sentinel"),
    pytest.param((0.0, 0.0, 0.0), 0.0, 0.0, id="origin-is-valid-target"),
]


@pytest.mark.parametrize(("target", "azimuth", "off_nadir"), CARDINAL_CASES)
def test_analytic_directions_and_handedness(target, azimuth, off_nadir):
    # At +X traveling +Y, nadir is -X and right MUST be +Z, not -Z.
    _assert_look(geometry.orbital_look_direction(POSITION, VELOCITY, target), azimuth, off_nadir)


@pytest.mark.parametrize("radial_speed", [-1000.0, -2.0, 0.0, 2.0, 1000.0])
def test_radial_velocity_does_not_tilt_along_direction(radial_speed):
    result = geometry.orbital_look_direction(POSITION, (radial_speed, 7.0, 0.0), TARGET)
    _assert_look(result, 45.0, 54.735610317245346)


def test_reversing_motion_reverses_ahead_and_right():
    result = geometry.orbital_look_direction(POSITION, (2.0, -7.0, 0.0), TARGET)
    _assert_look(result, 225.0, 54.735610317245346)


def test_negative_tiny_azimuth_still_excludes_360():
    result = geometry.orbital_look_direction(POSITION, VELOCITY, (7000.0, 100.0, -1e-18))
    _assert_look(result, 0.0, 90.0)


@pytest.mark.parametrize("scale", [1e-300, 1.0, 1e300])
def test_scale_invariance_without_norm_overflow_or_underflow(scale):
    def scaled(vector):
        return tuple(component * scale for component in vector)

    result = geometry.orbital_look_direction(scaled(POSITION), scaled(VELOCITY), scaled(TARGET))
    _assert_look(result, 45.0, 54.735610317245346)


@pytest.mark.parametrize(("target", "azimuth", "off_nadir"), CARDINAL_CASES)
@pytest.mark.parametrize("matrix", [
    ((0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
    ((1 / 3, 2 / 3, 2 / 3), (2 / 3, 1 / 3, -2 / 3), (-2 / 3, 2 / 3, -1 / 3)),
])
def test_common_proper_rotation_preserves_look(matrix, target, azimuth, off_nadir):
    # Fixed orthonormal determinant +1 matrices, not the implementation's basis.
    def rotate(vector):
        return tuple(sum(a * b for a, b in zip(row, vector, strict=True)) for row in matrix)

    result = geometry.orbital_look_direction(rotate(POSITION), rotate(VELOCITY), rotate(target))
    # Permit the equivalent side of the 0/360 seam after floating-point rotation.
    if azimuth == 0.0 and result["azimuth_deg"] > 359.999999999:
        assert result["azimuth_deg"] < 360.0
        result = {**result, "azimuth_deg": 0.0}
    _assert_look(result, azimuth, off_nadir)


@pytest.mark.parametrize("altitude", [0.0, 100.0, 200.0])
def test_elevated_target_uses_3d_radius_not_surface_distance(altitude):
    observer_radius = 6778.137
    target_radius = 6378.137 + altitude
    separation = math.radians(5.0)
    target = (target_radius * math.cos(separation), target_radius * math.sin(separation), 0.0)
    expected = math.degrees(math.atan2(target[1], observer_radius - target[0]))
    result = geometry.orbital_look_direction((observer_radius, 0.0, 0.0), VELOCITY, target)
    _assert_look(result, 0.0, expected)
    if altitude:
        surface_angle = math.degrees(math.atan2(
            6378.137 * math.sin(separation), observer_radius - 6378.137 * math.cos(separation),
        ))
        assert result["off_nadir_deg"] > surface_angle


@pytest.mark.parametrize("index", range(3))
@pytest.mark.parametrize("bad", [
    None, 1.0, (), (1.0, 2.0), (1.0, 2.0, 3.0, 4.0),
    (math.nan, 0.0, 0.0), (0.0, math.inf, 0.0), (0.0, 0.0, -math.inf),
    (True, 0.0, 0.0), ("1", 0.0, 0.0), (1j, 0.0, 0.0), (10**400, 0.0, 0.0),
])
def test_invalid_vectors_raise_value_error(index, bad):
    arguments = [POSITION, VELOCITY, TARGET]
    arguments[index] = bad
    with pytest.raises(ValueError, match="finite real|exactly three"):
        geometry.orbital_look_direction(*arguments)


@pytest.mark.parametrize(("position", "velocity", "target", "message"), [
    ((0.0, 0.0, 0.0), VELOCITY, TARGET, "observer_position must be nonzero"),
    (POSITION, (0.0, 0.0, 0.0), TARGET, "observer_velocity must be nonzero"),
    (POSITION, (7.0, 0.0, 0.0), TARGET, "collinear"),
    (POSITION, (-7.0, 0.0, 0.0), TARGET, "collinear"),
    ((1.0, 2.0, 3.0), (2.0, 4.0, 6.0), TARGET, "collinear"),
    (POSITION, (7.0, 1e-13, 0.0), TARGET, "collinear"),
    (POSITION, VELOCITY, POSITION, "line of sight must be nonzero"),
    (POSITION, VELOCITY, (7100.0, 0.0, 0.0), "undefined at zenith"),
    (POSITION, VELOCITY, (7100.0, 1e-13, 0.0), "undefined at zenith"),
    ((-1e308, 0.0, 0.0), VELOCITY, (1e308, 0.0, 0.0), "line of sight"),
])
def test_degenerate_directions_fail_explicitly(position, velocity, target, message):
    with pytest.raises(ValueError, match=message):
        geometry.orbital_look_direction(position, velocity, target)


def test_nadir_tolerance_is_explicit_but_nearby_azimuth_is_resolved():
    _assert_look(
        geometry.orbital_look_direction(POSITION, VELOCITY, (6900.0, 0.0, 1e-11)),
        0.0, 0.0,
    )
    result = geometry.orbital_look_direction(POSITION, VELOCITY, (6900.0, 0.0, 0.01))
    _assert_look(result, 90.0, math.degrees(math.atan2(0.01, 100.0)))


def _fake_satellite(monkeypatch, state):
    satellite = SimpleNamespace(sgp4=Mock(return_value=state))
    factory = Mock(return_value=satellite)
    monkeypatch.setattr(geometry, "Satrec", SimpleNamespace(twoline2rv=factory))
    return satellite, factory


@pytest.mark.parametrize("gmst", [0.0, math.pi / 2])
def test_wrapper_spherical_target_rotation_and_altitude(monkeypatch, sample_tle, gmst):
    # At the equator moving east, a northern target is right (+Z).
    position = (6778.137 * math.cos(gmst), 6778.137 * math.sin(gmst), 0.0)
    velocity = (-7.0 * math.sin(gmst), 7.0 * math.cos(gmst), 0.0)
    _fake_satellite(monkeypatch, (0, position, velocity))
    monkeypatch.setattr(geometry, "_gmst_rad", lambda _when: gmst)
    result = geometry.look_direction_at(sample_tle, WHEN, 30.0, 0.0, 200.0)
    radius = 6578.137
    expected = math.degrees(math.atan2(radius * 0.5, 6778.137 - radius * math.sqrt(3) / 2))
    _assert_look(result, 90.0, expected)


def test_wrapper_passes_full_teme_state_and_fractional_utc(monkeypatch, sample_tle):
    state = (0, (6778.137, 0.0, 0.0), (1.2, 6.5, -3.2))
    satellite, factory = _fake_satellite(monkeypatch, state)
    look = Mock(wraps=geometry.orbital_look_direction)
    monkeypatch.setattr(geometry, "orbital_look_direction", look)
    when = WHEN.replace(microsecond=123456)
    geometry.look_direction_at(sample_tle, when, 30.0, -80.0, 200.0)
    factory.assert_called_once_with(sample_tle.line1, sample_tle.line2)
    jd, fraction = satellite.sgp4.call_args.args
    assert jd == 2451544.5
    assert fraction == pytest.approx((43200.0 + 0.123456) / 86400.0, abs=1e-15)
    position, velocity, target = look.call_args.args
    assert position == state[1]
    assert velocity == state[2]
    # J2000 GMST is 280.46061837 deg; retain the fractional-second rotation.
    gmst_deg = 280.46061837 + 360.98564736629 * 0.123456 / 86400.0
    longitude = math.radians(-80.0 + gmst_deg)
    assert target == pytest.approx((
        6578.137 * math.cos(math.radians(30)) * math.cos(longitude),
        6578.137 * math.cos(math.radians(30)) * math.sin(longitude),
        6578.137 * 0.5,
    ), abs=1e-5)


@pytest.mark.parametrize("when", [
    datetime(2000, 1, 1, 12),
    datetime(2000, 1, 1, 7, tzinfo=timezone(timedelta(hours=-5))),
    datetime(2000, 1, 1, 17, 30, tzinfo=timezone(timedelta(hours=5, minutes=30))),
    None,
])
def test_wrong_utc_rejected_before_sgp4(monkeypatch, sample_tle, when):
    _, factory = _fake_satellite(monkeypatch, (0, POSITION, VELOCITY))
    with pytest.raises(ValueError, match="when must be UTC-aware"):
        geometry.look_direction_at(sample_tle, when, 0.0, 0.0, 100.0)
    factory.assert_not_called()


@pytest.mark.parametrize(("lat", "lon", "altitude"), [
    (math.nan, 0.0, 0.0), (0.0, math.inf, 0.0), (0.0, 0.0, -math.inf),
    (91.0, 0.0, 0.0), (-91.0, 0.0, 0.0),
    (0.0, 181.0, 0.0), (0.0, -181.0, 0.0),
    (0.0, 0.0, -6378.137), (0.0, 0.0, -7000.0),
    (True, 0.0, 0.0), (0.0, "0", 0.0), (0.0, 0.0, None),
])
def test_invalid_rocket_coordinates_fail_before_sgp4(monkeypatch, sample_tle, lat, lon, altitude):
    _, factory = _fake_satellite(monkeypatch, (0, POSITION, VELOCITY))
    with pytest.raises(ValueError, match="rocket_"):
        geometry.look_direction_at(sample_tle, WHEN, lat, lon, altitude)
    factory.assert_not_called()


@pytest.mark.parametrize("error", [1, 2, 3, 4, 5, 6, 99])
def test_sgp4_error_never_uses_returned_state(monkeypatch, sample_tle, error):
    _fake_satellite(monkeypatch, (error, POSITION, VELOCITY))
    look = Mock()
    monkeypatch.setattr(geometry, "orbital_look_direction", look)
    with pytest.raises(RuntimeError, match=f"sgp4 propagation failed: error code {error}"):
        geometry.look_direction_at(sample_tle, WHEN, 0.0, 0.0, 100.0)
    look.assert_not_called()


@pytest.mark.parametrize(("position", "velocity"), [
    ((math.nan, 0.0, 0.0), VELOCITY),
    (POSITION, (0.0, math.inf, 0.0)),
    ((0.0, 0.0, 0.0), VELOCITY),
    (POSITION, (0.0, 0.0, 0.0)),
    (POSITION, (7.0, 0.0, 0.0)),
])
def test_sgp4_success_code_with_invalid_state_is_rejected(monkeypatch, sample_tle, position, velocity):
    _fake_satellite(monkeypatch, (0, position, velocity))
    with pytest.raises(ValueError):
        geometry.look_direction_at(sample_tle, WHEN, 0.0, 0.0, 100.0)


@pytest.mark.parametrize("error", [ValueError("invalid TLE"), ZeroDivisionError(), OverflowError()])
def test_satrec_parse_error_is_not_hidden(monkeypatch, sample_tle, error):
    _, factory = _fake_satellite(monkeypatch, None)
    factory.side_effect = error
    with pytest.raises(ValueError, match="invalid TLE") as caught:
        geometry.look_direction_at(sample_tle, WHEN, 0.0, 0.0, 100.0)
    assert caught.value.__cause__ is error
    assert geometry._satrec.cache_info().currsize == 0


def test_satrec_cache_keys_both_lines_and_propagates_every_instant(monkeypatch, sample_tle):
    satellite, factory = _fake_satellite(monkeypatch, (0, POSITION, VELOCITY))
    tles = [
        sample_tle, replace(sample_tle, epoch=WHEN),
        replace(sample_tle, line1=sample_tle.line1 + " "),
        replace(sample_tle, line2=sample_tle.line2 + " "),
    ]
    for index, tle in enumerate(tles):
        geometry.look_direction_at(tle, WHEN + timedelta(seconds=index), 30.0, 0.0, 200.0)
    assert factory.call_count == 3
    assert satellite.sgp4.call_count == 4
    assert len({call.args for call in satellite.sgp4.call_args_list}) == 4


def test_satrec_cache_is_bounded(monkeypatch, sample_tle):
    _, factory = _fake_satellite(monkeypatch, (0, POSITION, VELOCITY))
    for index in range(40):
        geometry._satrec(sample_tle.line1, f"{sample_tle.line2} {index}")
    assert geometry._satrec.cache_info().maxsize == 32
    assert geometry._satrec.cache_info().currsize == 32
    geometry._satrec(sample_tle.line1, f"{sample_tle.line2} 0")
    assert factory.call_count == 41  # Oldest entry was evicted.


def test_real_sgp4_subpoint_is_nadir_in_same_spherical_model(sample_tle: TLE, now_utc: datetime):
    # A round-trip integration check, NOT independent astrometric validation.
    jd, fraction = jday(2024, 10, 17, 12, 0, 0.0)
    error, position, _ = Satrec.twoline2rv(sample_tle.line1, sample_tle.line2).sgp4(jd, fraction)
    assert error == 0
    subpoint = teme_to_geodetic(position, now_utc)
    result = geometry.look_direction_at(sample_tle, now_utc, subpoint.lat, subpoint.lon, 200.0)
    _assert_look(result, 0.0, 0.0)


def test_real_sgp4_zero_mean_motion_fails_explicitly(sample_tle: TLE, now_utc: datetime):
    line2 = sample_tle.line2[:52] + " 0.00000000" + sample_tle.line2[63:]
    invalid_tle = replace(sample_tle, line2=line2)
    # Pure Python fails during parsing; accelerated SGP4 can return an error
    # code or nonfinite state instead. Neither backend may emit a direction.
    with pytest.raises((ValueError, RuntimeError)):
        geometry.look_direction_at(invalid_tle, now_utc, 0.0, 0.0, 100.0)


def test_real_sgp4_decayed_orbit_rejects_finite_state(sample_tle: TLE, now_utc: datetime):
    line2 = sample_tle.line2[:52] + "25.00000000" + sample_tle.line2[63:]
    invalid_tle = replace(sample_tle, line2=line2)
    jd, fraction = jday(2024, 10, 17, 12, 0, 0.0)
    error, position, velocity = Satrec.twoline2rv(invalid_tle.line1, invalid_tle.line2).sgp4(jd, fraction)
    assert error == 6
    assert all(math.isfinite(component) for component in (*position, *velocity))
    with pytest.raises(RuntimeError, match="error code 6"):
        geometry.look_direction_at(invalid_tle, now_utc, 0.0, 0.0, 100.0)
