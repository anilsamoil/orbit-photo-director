from __future__ import annotations

import copy
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

from generator import launch_catalog
from generator.ascent_profiles import FALCON_9
from generator.launch_data import retained_launch_rows
from generator.launch_direction import ModeledDirection, model_direction
from generator.launch_evidence import EvaluationBudget, canonical_bytes
from generator.launch_orbit import inclination_from_ll2
from generator.launch_publish import _validate_catalog
from generator.orbit import TLE

FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 11, 14, 23, 33, tzinfo=UTC)


def _payload() -> dict:
    return json.loads((FIXTURES / "ll2-planner-cases.json").read_text())


def _tle() -> TLE:
    return TLE.from_text((FIXTURES / "iss-2026-11-14.tle").read_text())


@pytest.fixture(scope="module")
def catalog() -> dict:
    return launch_catalog.build_launch_catalog(_payload(), _tle(), NOW, fetched_at=NOW)


def _item(catalog: dict, event_id: str) -> dict:
    return next(item for item in catalog["items"] if item["event_id"] == event_id)


def test_iss_inclination_from_cape_keeps_both_scenarios(catalog) -> None:
    item = _item(catalog, "fixture-iss-cape")
    assert item["direction"]["kind"] == "modeled"
    assert [fan["azimuth_deg"] for fan in item["ascent"]["fans"]] == pytest.approx(
        [42.76, 137.24],
        abs=0.1,
    )
    assert item["ascent"]["grade"] == "C"
    assert "BRANCH_AMBIGUOUS" in item["reasons"]
    assert item["tier"] != "shot"
    assert {
        shot["direction"]["azimuth_deg"] for shot in item["shots"] if shot["subject"] == "ascent"
    } == {42.7624, 137.2376}


def test_actual_amazon_row_is_a_conditional_modeled_negative(catalog) -> None:
    item = next(item for item in catalog["items"] if "Amazon Leo (LV-01)" in item["name"])
    assert item["direction"]["kind"] == "modeled"
    assert item["direction"]["azimuth_deg"] == pytest.approx(42.42, abs=0.1)
    assert item["ascent"]["grade"] == "C"
    assert item["tier"] == "watch"
    assert item["shots"] == []
    assert "21 liftoff minutes sampled" in item["why"]
    assert {"DIRECTION_MODELED", "TRAJECTORY_UNVERIFIED"} <= set(item["reasons"])
    assert "FCC STA" in item["ascent"]["source"]
    assert "450 km deployment only" in item["ascent"]["source"]
    assert "other Amazon Leo shells use different inclinations" in item["ascent"]["source"]
    assert "unverified: not checked against a primary document" in item["ascent"]["source"]


@pytest.mark.parametrize("event_id", ["fixture-sso-vandenberg", "fixture-polar-vandenberg"])
def test_vandenberg_nominal_tracks_head_south(catalog, event_id) -> None:
    item = _item(catalog, event_id)
    fan = item["ascent"]["fans"][0]
    assert fan["branch"] == "southbound"
    assert all(
        right["lat"] < left["lat"]
        for left, right in zip(fan["track"], fan["track"][1:], strict=False)
    )
    assert fan["track"][-1]["t_offset_s"] <= 600


def test_gto_cape_is_east_with_later_plane_change(catalog) -> None:
    item = _item(catalog, "fixture-gto-cape")
    assert item["direction"]["azimuth_deg"] == 90
    assert item["ascent"]["grade"] == "C"
    assert "PLANE_CHANGE_LATER" in item["reasons"]
    track = item["ascent"]["fans"][0]["track"]
    assert all(abs(point["lat"] - item["site"]["lat"]) < 2 for point in track[:10])
    assert track[-1]["lon"] > track[0]["lon"]


def test_starbase_unknown_keeps_sector_and_known_orbit_has_a_flagged_dogleg(catalog) -> None:
    unknown = _item(catalog, "fixture-starbase")
    assert unknown["direction"]["kind"] == "none"
    assert unknown["ascent"]["grade"] == "D"
    fan = unknown["ascent"]["fans"][0]
    assert (fan["low_deg"], fan["high_deg"]) == (85, 105)
    assert fan["azimuth_deg"] is None and fan["track"] == []
    known = _item(catalog, "fixture-starbase-known")
    assert known["direction"]["kind"] == "modeled"
    assert "DOGLEG_ASSUMED" in known["reasons"]
    assert known["ascent"]["grade"] == "C"


def test_baikonur_iss_rule_uses_north_branch_and_starts_at_pad(catalog) -> None:
    item = _item(catalog, "fixture-baikonur")
    assert item["direction"]["azimuth_deg"] == pytest.approx(62.18, abs=0.1)
    start = item["ascent"]["fans"][0]["track"][0]
    assert start == {"t_offset_s": 0, "lat": 45.996, "lon": 63.56, "alt_km": 0}


def test_unknown_orbit_never_publishes_an_ascent_shot(catalog) -> None:
    item = _item(catalog, "fixture-unknown")
    assert item["direction"]["kind"] == "none"
    assert "ORBIT_UNKNOWN" in item["reasons"]
    assert item["ascent"]["grade"] == "D"
    assert all(shot["subject"] == "pad" for shot in item["shots"])


def test_positive_and_interior_liftoff_are_observable_but_never_shot_tier(catalog) -> None:
    positive = _item(catalog, "fixture-positive")
    assert positive["tier"] in {"likely", "watch"}
    ascent = next(shot for shot in positive["shots"] if shot["subject"] == "ascent")
    assert ascent["light"] == "day_plume"
    assert ascent["slant_km"] < 1500
    scan = _item(catalog, "fixture-scan")
    assert "19 of 61 liftoff minutes sampled" in scan["why"]
    best = min(
        (s for s in scan["shots"] if s["subject"] == "ascent"),
        key=lambda s: (-s["score"]["low"], s["slant_km"]),
    )
    assert best["liftoff"] not in {scan["schedule"]["net"], scan["schedule"]["window_end"]}
    assert "2026-11-15T20:20:00Z" <= best["liftoff"] <= "2026-11-15T20:38:00Z"


@pytest.mark.parametrize("limit", ["points", "deadline"])
def test_partial_scan_reaches_item_and_catalog_coverage(monkeypatch, limit) -> None:
    payload = _payload()
    payload["results"] = [row for row in payload["results"] if row["id"] == "fixture-scan"]
    payload["count"] = 1
    ticks = iter([*([0] * 12), *([20] * 100)])
    monkeypatch.setattr(
        launch_catalog,
        "EvaluationBudget",
        lambda: EvaluationBudget(
            max_points=10 if limit == "points" else 250000,
            clock=(lambda: 0) if limit == "points" else lambda: next(ticks),
        ),
    )
    result = launch_catalog.build_launch_catalog(payload, _tle(), NOW, fetched_at=NOW)
    item = result["items"][0]
    assert "EVALUATION_INCOMPLETE" in item["reasons"]
    assert "EVALUATION_INCOMPLETE" in result["coverage"]["reasons"]
    assert result["coverage"]["evaluated"] == 0
    assert "Unsampled liftoffs remain unknown" in item["why"]
    assert item["tier"] == "watch"


def test_modeled_negative_cannot_reach_none_or_restore_a_prior_shot(monkeypatch) -> None:
    payload = _payload()
    payload["results"] = [payload["results"][0]]
    payload["count"] = 1
    monkeypatch.setattr(
        launch_catalog,
        "_window_outcome",
        lambda *args: pytest.fail("modeled negative must not prove exclusion"),
    )
    monkeypatch.setattr(launch_catalog, "_tier", lambda *args: "none")
    fresh = replace(_tle(), epoch=NOW)
    assert (
        launch_catalog.build_launch_catalog(payload, fresh, NOW, fetched_at=NOW)["items"][0]["tier"]
        == "watch"
    )
    monkeypatch.setattr(launch_catalog, "_keeps_shot", lambda *args: True)
    assert (
        launch_catalog.build_launch_catalog(payload, fresh, NOW, fetched_at=NOW)["items"][0]["tier"]
        == "likely"
    )


def test_existing_iss_plane_item_is_byte_identical_to_base() -> None:
    payload = json.loads((FIXTURES / "ll2-crs35-2026-10-10.json").read_text())
    tle = TLE.from_text((FIXTURES / "iss-2026-10-09.tle").read_text())
    now = datetime(2026, 10, 10, 14, 23, tzinfo=UTC)
    fetched = datetime(2026, 10, 10, 13, 46, 20, 365162, tzinfo=UTC)
    item = launch_catalog.build_launch_catalog(payload, tle, now, fetched_at=fetched)["items"][0]
    assert canonical_bytes(item) == (FIXTURES / "lp1-crs35-baseline.json").read_bytes()


def test_scoring_does_not_propagate_after_the_scan_spends_its_point_budget(monkeypatch) -> None:
    launch, row = next(
        (launch, row)
        for launch, row in retained_launch_rows(_payload(), NOW)
        if launch.id == "fixture-scan"
    )
    inclination = inclination_from_ll2(row, launch.site_lat, launch.site_lon)
    direction = model_direction(launch.site_lat, launch.site_lon, inclination)
    assert isinstance(direction, ModeledDirection)
    budget = EvaluationBudget(max_points=12000, clock=lambda: 0)
    monkeypatch.setattr(
        launch_catalog,
        "_envelope",
        lambda *args: pytest.fail(
            "no envelope propagation is allowed after point exhaustion",
        ),
    )
    shots, _direction, scan = launch_catalog._modeled_shots(
        launch,
        _tle(),
        FALCON_9,
        direction,
        budget,
    )
    assert budget.points == 12000
    assert scan.incomplete
    assert shots == []


def test_catalog_validates_and_is_the_frontend_fixture(catalog) -> None:
    _validate_catalog(catalog)
    fixture = FIXTURES.parent.parent / "frontend/test/fixtures/launch-planner-catalog.json"
    assert canonical_bytes(catalog) == fixture.read_bytes()


def test_missing_profile_preserves_direction_and_empty_model_tracks(catalog) -> None:
    payload = _payload()
    row = copy.deepcopy(next(row for row in payload["results"] if row["id"] == "fixture-positive"))
    row["rocket"]["configuration"]["full_name"] = "Unknown launch vehicle"
    payload["results"] = [row]
    payload["count"] = 1
    result = launch_catalog.build_launch_catalog(payload, _tle(), NOW, fetched_at=NOW)
    _validate_catalog(result)
    item = result["items"][0]
    assert item["direction"]["kind"] == "modeled"
    assert "PROFILE_UNKNOWN" in item["reasons"]
    assert all(fan["track"] == [] for fan in item["ascent"]["fans"])
    assert all(shot["subject"] == "pad" for shot in item["shots"])
