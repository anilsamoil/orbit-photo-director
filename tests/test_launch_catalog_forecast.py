"""Forecast planning policy; scores are not photo probabilities.

Fixtures retain the catalog-used fields verbatim from the CRS-35 LL2 row and
the real Oct 9 TLE copied for crs35-astra/algorithm-review on 2026-10-10.
The 12-hour control isolates tier policy on frozen geometry: changing an epoch
does not manufacture a physically valid future TLE or validate future visibility.
"""

import copy
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from generator import launch_catalog as catalog
from generator.launch_data import retained_launch_rows
from generator.launch_evidence import utc
from generator.orbit import TLE

FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 10, 14, 23, tzinfo=UTC)
RECEIPT = datetime(2026, 10, 10, 13, 46, 20, 365162, tzinfo=UTC)
FORECAST_PREFIX = "Likely forecast — recheck with a fresh ISS orbit."


@pytest.fixture(scope="module")
def crs35():
    payload = json.loads((FIXTURES / "ll2-crs35-2026-10-10.json").read_text())
    tle = TLE.from_text((FIXTURES / "iss-2026-10-09.tle").read_text())
    launch, _ = retained_launch_rows(payload, NOW)[0]
    item = catalog.build_launch_catalog(payload, tle, NOW, fetched_at=RECEIPT)["items"][0]
    return payload, tle, launch, item


def test_real_crs35_84h_tle_is_likely_forecast_not_shot(crs35):
    _, tle, _, item = crs35
    assert item["name"] == "Falcon 9 Block 5 | Dragon CRS-2 SpX-35"
    assert tle.epoch == datetime(2026, 10, 9, 22, 48, 38, 797056, tzinfo=UTC)
    assert item["tier"] == "likely"
    assert {"FORECAST_EPHEMERIS", "TLE_AGE_OVER_48H"} <= set(item["reasons"])
    assert item["why"].startswith(FORECAST_PREFIX)
    assert {shot["subject"] for shot in item["shots"]} == {"pad", "ascent"}
    assert all(83 < shot["confidence"]["tle_age_h"] < 85 for shot in item["shots"])


def test_same_crs35_geometry_at_12h_policy_age_is_still_shot(crs35):
    _, _, launch, item = crs35
    epoch = launch.t0 - timedelta(hours=12)
    assert catalog._tier(
        launch, True, item["shots"], epoch, False, True, True, (launch.t0,),
    ) == "shot"


def test_ordinary_likely_48h_path_keeps_its_existing_thresholds(crs35):
    _, _, launch, item = crs35
    shots = copy.deepcopy(item["shots"])
    for shot in shots:
        shot["score"]["low"] = 25
        shot["slant_km"] = 801
        shot["confidence"]["robust"] = False
        shot["best"] = shot["start"]
    end = max(datetime.fromisoformat(shot["end"]) for shot in shots)
    assert catalog._tier(
        launch, True, shots, end - timedelta(hours=48), False, True, True, (launch.t0,),
    ) == "likely"


@pytest.mark.parametrize(
    "block", ["age97", "receipt", "incomplete", "weak", "far", "thin", "edge", "tbc", "hour", "window"],
)
def test_forecast_relaxation_preserves_watch_controls(crs35, block):
    _, tle, launch, item = crs35
    shots = copy.deepcopy(item["shots"])
    epoch = launch.t0 - timedelta(hours=97) if block == "age97" else tle.epoch
    for shot in shots:
        if block == "weak":
            shot["score"]["low"] = 49
        if block == "far":
            shot["slant_km"] = 801
        if block == "thin":
            shot["confidence"]["robust"] = False
        if block == "edge":
            shot["best"] = shot["start"]
    if block == "tbc":
        launch = replace(launch, status_abbrev="TBC")
    if block == "hour":
        launch = replace(launch, time_precision="Hour")
    if block == "window":
        launch = replace(launch, window_end=launch.t0 + timedelta(seconds=1))
    assert catalog._tier(
        launch, True, shots, epoch, False, block != "incomplete", block != "receipt", (launch.t0,),
    ) == "watch"


@pytest.mark.parametrize("seconds_over, expected", [(0, "likely"), (1, "watch")])
def test_forecast_96h_capture_boundary(crs35, seconds_over, expected):
    _, _, launch, item = crs35
    # An earlier-ending pad must not rescue the just-over-boundary control.
    shots = [shot for shot in item["shots"] if shot["subject"] == "ascent"]
    end = datetime.fromisoformat(shots[0]["end"])
    epoch = end - timedelta(hours=96, seconds=seconds_over)
    assert catalog._tier(
        launch, True, shots, epoch, False, True, True, (launch.t0,),
    ) == expected


@pytest.mark.parametrize("slack, expected", [(29, "watch"), (30, "likely")])
def test_forecast_score_slant_and_central_slack_boundaries(crs35, slack, expected):
    _, tle, launch, item = crs35
    shots = copy.deepcopy(item["shots"])
    for shot in shots:
        shot["score"]["low"] = 50
        shot["slant_km"] = 800
        shot["best"] = utc(datetime.fromisoformat(shot["start"]) + timedelta(seconds=slack))
    assert catalog._tier(
        launch, True, shots, tle.epoch, False, True, True, (launch.t0,),
    ) == expected


def test_forecast_requires_qualifying_envelope_at_every_liftoff(crs35):
    _, tle, launch, item = crs35
    liftoffs = (launch.t0, launch.t0 + timedelta(seconds=1))
    assert not catalog._forecast_covers(item["shots"], liftoffs, tle.epoch)
    assert not catalog._forecast_covers(item["shots"], (), tle.epoch)


def test_forecast_can_use_qualifying_lower_scored_envelope(crs35):
    _, tle, launch, item = crs35
    shots = copy.deepcopy(item["shots"])
    best = catalog._best(shots)
    best["slant_km"] = 801
    assert catalog._tier(
        launch, True, shots, tle.epoch, False, True, True, (launch.t0,),
    ) == "likely"
    assert catalog._tier(
        launch, False, shots, tle.epoch, False, True, True, (launch.t0,),
    ) == "unassessed"


@pytest.mark.parametrize("reason", ["GEOMETRY_INVALID", "EVALUATION_INCOMPLETE", "EPHEMERIS_MISSING"])
def test_recorded_partial_geometry_error_does_not_make_a_forecast(crs35, monkeypatch, reason):
    payload, tle, _, _ = crs35
    original = catalog._shots

    def partial(launch, orbit, destination, reasons, liftoffs):
        shots, direction = original(launch, orbit, destination, reasons, liftoffs)
        reasons.append(reason)
        return shots, direction

    monkeypatch.setattr(catalog, "_shots", partial)
    item = catalog.build_launch_catalog(payload, tle, NOW, fetched_at=RECEIPT)["items"][0]
    assert item["shots"]
    assert item["tier"] == "watch"
    assert reason in item["reasons"]
    assert "FORECAST_EPHEMERIS" not in item["reasons"]
    assert not item["why"].startswith(FORECAST_PREFIX)


def test_dropped_envelope_records_geometry_error_and_prevents_forecast(crs35, monkeypatch):
    payload, tle, _, _ = crs35
    original = catalog.look_direction_at
    calls = 0

    def fail_first(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ValueError("unavailable look geometry")
        return original(*args, **kwargs)

    monkeypatch.setattr(catalog, "look_direction_at", fail_first)
    item = catalog.build_launch_catalog(payload, tle, NOW, fetched_at=RECEIPT)["items"][0]
    assert item["shots"]
    assert item["tier"] == "watch"
    assert "GEOMETRY_INVALID" in item["reasons"]
    assert "FORECAST_EPHEMERIS" not in item["reasons"]


@pytest.mark.parametrize("age_minutes", [75, 76, 180])
def test_real_forecast_geometry_cannot_make_stale_receipt_actionable(crs35, age_minutes):
    payload, tle, _, _ = crs35
    item = catalog.build_launch_catalog(
        payload, tle, NOW, fetched_at=NOW - timedelta(minutes=age_minutes),
    )["items"][0]
    assert item["shots"]
    assert item["tier"] == "watch"
    assert "FORECAST_EPHEMERIS" not in item["reasons"]


def test_real_crs35_incomplete_evaluation_stays_watch(crs35, monkeypatch):
    payload, tle, _, _ = crs35
    original = catalog.EvaluationBudget
    monkeypatch.setattr(catalog, "EvaluationBudget", lambda: original(seconds=0))
    item = catalog.build_launch_catalog(payload, tle, NOW, fetched_at=RECEIPT)["items"][0]
    assert item["tier"] == "watch"
    assert "EVALUATION_INCOMPLETE" in item["reasons"]
    assert "FORECAST_EPHEMERIS" not in item["reasons"]
