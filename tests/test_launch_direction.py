"""Direction provenance for an ascent corridor."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from generator.ascent_profiles import FALCON_9
from generator.launch_direction import (
    Destination,
    DirectionKind,
    IssPlaneDirection,
    destination_from_ll2,
    direction_for,
)
from generator.launch_opportunities import Pad, Subject, sample_directed
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
        _tle(), _utc(_crs35()["net"]), cape.lat, cape.lon, Destination.OTHER,
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
    mapped = {"rocket": {"spacecraft_stage": {"destination": {"name": "International Space Station"}}}}
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
