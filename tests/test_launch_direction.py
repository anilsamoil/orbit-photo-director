from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from generator.ascent_profiles import FALCON_9
from generator.launch_direction import (
    LAUNCH_SITES,
    Destination,
    DirectionKind,
    IssPlaneDirection,
    ModeledDirection,
    NoDirection,
    destination_from_ll2,
    direction_for,
    model_direction,
    sector_contains,
    site_for,
)
from generator.launch_opportunities import Pad, Subject, sample_directed
from generator.launch_orbit import UNVERIFIED, Basis, Branch, Inclination
from generator.orbit import TLE, Position

CENSUS = Path(__file__).parent / "fixtures" / "launch_census"
CRS35_ID = "bf2c3027-a314-403e-a416-2bfd5d165ad1"


def _utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _feed() -> list[dict]:
    payload = json.loads((CENSUS / "launches.json").read_text())
    return payload["results"]


def _row(event_id: str) -> dict:
    return next(row for row in _feed() if row["id"] == event_id)


def _tle() -> TLE:
    return TLE.from_text((CENSUS / "iss.tle").read_text())


def _crs35() -> dict:
    return _row(CRS35_ID)


def _starlink() -> dict:
    return next(row for row in _feed() if row["name"] == "Falcon 9 Block 5 | Starlink Group 15-25")


def _pad(row: dict) -> Pad:
    pad = row["pad"]
    return Pad(float(pad["latitude"]), float(pad["longitude"]))


def _overhead(pad: Pad):
    def observer(when: datetime) -> Position:
        return Position(pad.lat, pad.lon, 420.0, when)

    return observer


def test_crs35_iss_plane_azimuth_from_the_census_pad() -> None:
    row = _crs35()
    pad = _pad(row)
    detailed = {
        "rocket": {"spacecraft_stage": [{"destination": "ISS"}]},
    }
    destination = destination_from_ll2(detailed)
    direction = direction_for(_tle(), _utc(row["net"]), pad.lat, pad.lon, destination)

    assert row["net"] == "2026-10-13T10:33:44Z"
    assert destination is Destination.ISS
    assert isinstance(direction, IssPlaneDirection)
    assert direction.kind is DirectionKind.ISS_PLANE
    assert direction.azimuth_deg == pytest.approx(44.7, abs=1.0)
    assert abs(direction.off_plane_deg) < 1.0
    assert direction.source == "iss_tle_plane"


def test_census_name_and_program_are_not_an_iss_destination() -> None:
    row = _crs35()
    programs = [program["name"] for program in row["program"]]

    assert "Dragon" in row["name"]
    assert "International Space Station" in programs
    assert row["rocket"].get("spacecraft_stage") is None
    assert destination_from_ll2(row) is Destination.UNSPECIFIED


def test_non_iss_launch_gets_no_direction() -> None:
    row = _starlink()
    pad = _pad(row)
    destination = destination_from_ll2(row)
    direction = direction_for(_tle(), _utc(row["net"]), pad.lat, pad.lon, destination)
    cape = _pad(_crs35())
    aligned_other = direction_for(
        _tle(),
        _utc(_crs35()["net"]),
        cape.lat,
        cape.lon,
        Destination.OTHER,
    )

    assert "Starlink" in row["name"]
    assert destination is Destination.UNSPECIFIED
    assert direction.kind is DirectionKind.NONE
    assert direction.azimuth_deg is None
    assert direction.off_plane_deg is None
    assert aligned_other.kind is DirectionKind.NONE
    assert aligned_other.azimuth_deg is None


def test_iss_destination_off_the_plane_gets_no_direction() -> None:
    starlink = _starlink()
    pad = _pad(starlink)
    when = _utc(_crs35()["net"])
    direction = direction_for(_tle(), when, pad.lat, pad.lon, Destination.ISS)

    assert direction.kind is DirectionKind.NONE
    assert direction.azimuth_deg is None


def test_destination_reads_the_stage_field_only() -> None:
    titled = {"name": "Dragon CRS-2 SpX-35", "rocket": {"configuration": {"full_name": "Falcon 9"}}}
    listed = {"rocket": {"spacecraft_stage": [{"destination": "ISS"}]}}
    mapped = {
        "rocket": {"spacecraft_stage": {"destination": {"name": "International Space Station"}}}
    }
    elsewhere = {"rocket": {"spacecraft_stage": [{"destination": "LEO"}]}}

    assert destination_from_ll2(titled) is Destination.UNSPECIFIED
    assert destination_from_ll2(listed) is Destination.ISS
    assert destination_from_ll2(mapped) is Destination.ISS
    assert destination_from_ll2(elsewhere) is Destination.OTHER


def test_no_ascent_envelope_without_a_direction() -> None:
    row = _crs35()
    pad = _pad(row)
    liftoff = _utc(row["net"])
    sourced = direction_for(_tle(), liftoff, pad.lat, pad.lon, Destination.ISS)
    missing = direction_for(_tle(), liftoff, pad.lat, pad.lon, Destination.UNSPECIFIED)
    with_direction = sample_directed(liftoff, _overhead(pad), pad, FALCON_9, sourced)
    without = sample_directed(liftoff, _overhead(pad), pad, FALCON_9, missing)

    assert any(span.subject is Subject.ASCENT for span in with_direction.spans)
    assert any(sight.subject is Subject.ASCENT for sight in with_direction.sights)
    assert not any(span.subject is Subject.ASCENT for span in without.spans)
    assert not any(sight.subject is Subject.ASCENT for sight in without.sights)


def _inclination(deg: float, branch: Branch | None = None, sigma: float = 0.5) -> Inclination:
    return Inclination(deg, sigma, Basis.CONSTELLATION, UNVERIFIED, "B", branch)


def test_modeled_cape_has_both_rotation_corrected_branches() -> None:
    direction = model_direction(28.5834, -80.583, _inclination(51.64))
    assert isinstance(direction, ModeledDirection)
    assert [fan.azimuth_deg for fan in direction.fans] == pytest.approx([42.76, 137.24], abs=0.1)
    assert [fan.branch for fan in direction.fans] == [Branch.NORTHBOUND, Branch.SOUTHBOUND]
    assert direction.grade == "C"
    assert "BRANCH_AMBIGUOUS" in direction.reasons


def test_amazon_cape_rotation_and_northbound_hint() -> None:
    import math

    direction = model_direction(28.5834, -80.583, _inclination(51.9, Branch.NORTHBOUND))
    assert isinstance(direction, ModeledDirection)
    assert direction.kind is DirectionKind.MODELED
    assert direction.azimuth_deg == pytest.approx(42.42, abs=0.1)
    inertial = math.degrees(
        math.asin(math.cos(math.radians(51.9)) / math.cos(math.radians(28.5834)))
    )
    assert inertial == pytest.approx(44.6, abs=0.1)
    assert len(direction.fans) == 1
    assert direction.fans[0].low_deg == pytest.approx(37.42, abs=0.1)
    assert direction.fans[0].high_deg == pytest.approx(47.42, abs=0.1)
    assert direction.grade == "C"
    assert UNVERIFIED in direction.source


@pytest.mark.parametrize("grade", ["A", "B", "C", "D"])
def test_unverified_inclination_cannot_produce_grade_b(grade: str) -> None:
    inclination = Inclination(51.9, 0.5, Basis.CONSTELLATION, UNVERIFIED, grade, Branch.NORTHBOUND)
    direction = model_direction(28.5834, -80.583, inclination)
    assert isinstance(direction, ModeledDirection)
    assert direction.grade == "C"


def test_cited_inclination_can_produce_grade_b() -> None:
    inclination = Inclination(
        51.9, 0.5, Basis.CONSTELLATION, "Cited primary-document fixture", "B", Branch.NORTHBOUND
    )
    direction = model_direction(28.5834, -80.583, inclination)
    assert isinstance(direction, ModeledDirection)
    assert direction.grade == "B"


def test_polar_vandenberg_is_southbound_and_uncertainty_is_symmetric() -> None:
    direction = model_direction(34.632, -120.61, _inclination(97.6))
    assert isinstance(direction, ModeledDirection)
    assert len(direction.fans) == 1
    assert direction.fans[0].branch is Branch.SOUTHBOUND
    assert direction.azimuth_deg == pytest.approx(192.01, abs=0.1)
    polar = model_direction(34.632, -120.61, _inclination(90, sigma=8))
    assert isinstance(polar, ModeledDirection)
    assert polar.fans[0].high_deg - polar.fans[0].low_deg > 23


def test_sub_latitude_orbit_flies_east_and_flags_later_plane_change() -> None:
    direction = model_direction(28.5834, -80.583, _inclination(27))
    assert isinstance(direction, ModeledDirection)
    assert direction.azimuth_deg == 90
    assert direction.fans[0].branch is Branch.EAST
    assert "PLANE_CHANGE_LATER" in direction.reasons
    assert direction.grade == "C"
    direct = model_direction(28.5834, -80.583, _inclination(28.5834))
    assert isinstance(direct, ModeledDirection)
    assert direct.azimuth_deg == 90
    assert "PLANE_CHANGE_LATER" not in direct.reasons


def test_known_starbase_inclination_uses_nearest_corridor_edge_for_dogleg() -> None:
    direction = model_direction(25.997, -97.16, _inclination(51.6, Branch.NORTHBOUND))
    assert isinstance(direction, ModeledDirection)
    assert direction.azimuth_deg == 85
    assert "DOGLEG_ASSUMED" in direction.reasons
    assert direction.grade == "C"
    narrow = model_direction(25.997, -97.16, _inclination(26.4, Branch.NORTHBOUND))
    assert isinstance(narrow, ModeledDirection)
    fan = narrow.fans[0]
    assert (fan.high_deg - fan.low_deg) % 360 >= 10


def test_baikonur_filters_the_southbound_branch() -> None:
    direction = model_direction(45.996, 63.56, _inclination(51.64))
    assert isinstance(direction, ModeledDirection)
    assert len(direction.fans) == 1
    assert direction.azimuth_deg == pytest.approx(62.18, abs=0.1)
    assert direction.fans[0].branch is Branch.NORTHBOUND


@pytest.mark.parametrize(
    ("lat", "lon", "expected"),
    [
        (26, -97.2, [(85, 105)]),
        (28.5, -80.6, [(35, 140)]),
        (46, 63.3, [(25, 70), (340, 355)]),
    ],
)
def test_unknown_orbit_keeps_all_assumed_site_fans(lat, lon, expected) -> None:
    direction = model_direction(lat, lon, None)
    assert isinstance(direction, NoDirection)
    assert direction.azimuth_deg is None
    assert [(fan.low_deg, fan.high_deg) for fan in direction.fans] == expected
    assert all(fan.azimuth_deg is None for fan in direction.fans)
    assert UNVERIFIED in direction.fan_source


def test_site_matching_is_geographic_and_unverified() -> None:
    assert site_for(28.5834, -80.583).name == "Cape Canaveral and Kennedy"
    assert site_for(0, 0) is None
    assert all(UNVERIFIED in site.source for site in LAUNCH_SITES)
    direction = model_direction(0, 0, _inclination(45))
    assert isinstance(direction, ModeledDirection)
    assert len(direction.fans) == 2
    assert set(direction.reasons) == {"BRANCH_AMBIGUOUS", "CORRIDOR_UNKNOWN"}


def test_wrapping_sector_and_southern_infeasible_orbit_are_finite() -> None:
    assert sector_contains((340, 20), 350)
    assert sector_contains((340, 20), 10)
    assert not sector_contains((340, 20), 180)
    direction = model_direction(-39.3, 177.9, _inclination(30))
    assert isinstance(direction, ModeledDirection)
    assert 0 <= direction.azimuth_deg < 360
    assert "PLANE_CHANGE_LATER" in direction.reasons
    west = model_direction(85, 0, _inclination(97.6))
    assert isinstance(west, ModeledDirection)
    assert west.azimuth_deg == 270
    assert west.fans[0].branch is None


def test_andoya_retrograde_dogleg_includes_exactly_60_degree_gap() -> None:
    direction = model_direction(69.1, 15.6, _inclination(120))

    assert direction.kind is DirectionKind.MODELED
    assert isinstance(direction, ModeledDirection)
    assert direction.azimuth_deg == 330
    assert "DOGLEG_ASSUMED" in direction.reasons
    assert "PLANE_CHANGE_LATER" in direction.reasons


def test_andoya_dogleg_rejects_just_beyond_60_degree_gap() -> None:
    direction = model_direction(69.1, 15.6, _inclination(110.899999, Branch.SOUTHBOUND))

    assert isinstance(direction, NoDirection)
    assert direction.kind is DirectionKind.NONE
    assert direction.azimuth_deg is None
