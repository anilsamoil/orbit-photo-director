"""Planning verdicts stay bounded to their time/model and never admit cameras."""

import copy
import hashlib
import math
from dataclasses import replace
from datetime import timedelta
from unittest.mock import patch

import pytest

from generator.launch_assessment import build_planning_assessment
from generator.launch_data import Launch
from generator.launch_evidence import EvaluationBudget, build_launch_artifact, canonical_bytes, utc
from generator.launch_publish import _validate_artifact
from generator.orbit import EARTH_RADIUS_KM, Position, propagate


@pytest.fixture
def planning(sample_tle):
    now = sample_tle.epoch.replace(microsecond=0) + timedelta(hours=1)
    at = now + timedelta(minutes=10)
    launch = Launch(
        id="test", name="Test Falcon", t0=at, net_window_seconds=1800,
        site_lat=0, site_lon=0, site_name="Test site", rocket_type="Falcon 9 Block 5",
        status_abbrev="Go", window_start=at, window_end=at + timedelta(hours=1),
        time_precision="Second",
    )
    return now, launch, sample_tle


def assess(planning, *, position=None, **kwargs):
    now, launch, tle = planning
    budget = kwargs.pop("budget", EvaluationBudget())
    fetched = kwargs.pop("fetched_at", now)
    if position is None:
        def position(_, at):
            return Position(0, 180, 420, at)
    with patch("generator.launch_assessment.propagate", side_effect=position):
        return build_planning_assessment(launch, tle, now, fetched, budget, **kwargs)


def test_visible_site_has_real_look_even_for_unknown_rocket(planning):
    now, launch, tle = planning
    observer = propagate(tle, launch.t0)
    launch = replace(launch, site_lat=observer.lat, site_lon=observer.lon, rocket_type="Unknown")
    result = build_planning_assessment(launch, tle, now, now, EvaluationBudget())
    assert result["net"]["verdict"] == "possible"
    assert result["net"]["reason"] == "SITE_IN_VIEW_AT_NET"
    assert result["net"]["pad_distance_km"] == 0
    assert result["net"]["look"]["frame"] == "orbital-lvlh"
    assert result["net"]["look"]["off_nadir_deg"] == pytest.approx(0, abs=1e-5)
    assert result["model"] is None
    assert result["window"] == {"verdict": "unknown", "reason": "PROFILE_UNKNOWN"}


def test_first_ascent_negative_does_not_exclude_later_liftoff(planning):
    _, launch, _ = planning

    def observer(_, at):
        # A later liftoff can differ even though all of the NET ascent is far.
        minutes = (at - launch.t0).total_seconds() / 60
        return Position(0, 180 if minutes <= 10 else max(0, 180 - (minutes - 10) * 3), 420, at)

    result = assess(planning, position=observer)
    assert result["net"]["verdict"] == "too_far"
    assert result["net"]["look"] is None
    assert result["model"] == {
        "name": "Falcon 9", "duration_seconds": 540,
        "max_altitude_km": 200, "max_downrange_km": 1400,
    }
    assert result["window"]["verdict"] == "unknown"


def test_all_window_negative_requires_entire_modeled_time_span(planning):
    seen = []

    def observer(_, at):
        seen.append(at)
        return Position(0, 180, 420, at)

    result = assess(planning, position=observer)
    assert result["net"]["verdict"] == result["window"]["verdict"] == "too_far"
    assert max(seen) == planning[1].window_end + timedelta(seconds=540)


def test_hidden_site_without_rocket_model_remains_unknown(planning):
    now, launch, tle = planning
    result = assess((now, replace(launch, rocket_type="Unknown"), tle))
    assert result["net"] == {
        "verdict": "unknown", "reason": "PROFILE_UNKNOWN", "at": utc(launch.t0),
        "pad_distance_km": round(math.pi * EARTH_RADIUS_KM, 1), "look": None,
    }
    assert result["model"] is None


def test_envelope_intersection_is_unknown_and_motion_margin_is_conservative(planning):
    # ~5,000 km misses the pad's horizon but intersects the inflated all-bearing
    # ascent envelope; a guessed azimuth cannot establish either verdict.
    result = assess(planning, position=lambda _, at: Position(0, 45, 420, at))
    assert result["net"]["verdict"] == result["window"]["verdict"] == "unknown"
    assert result["net"]["look"] is None
    # This distance is beyond the uninflated envelope, but still protected by
    # temporal/position margin, so sampling cannot promote a near-boundary miss.
    uninflated = (EARTH_RADIUS_KM * math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + 420))
                  + EARTH_RADIUS_KM * math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + 200)) + 1400)
    longitude = math.degrees((uninflated + 50) / EARTH_RADIUS_KM)
    result = assess(planning, position=lambda _, at: Position(0, longitude, 420, at))
    assert result["net"]["verdict"] == "unknown"


@pytest.mark.parametrize("age", [None, -1, 3 * 3600, 4 * 3600])
def test_missing_future_or_expired_source_never_becomes_negative(planning, age):
    now, _, _ = planning
    fetched = None if age is None else now - timedelta(seconds=age)
    result = assess(planning, fetched_at=fetched)
    assert result["net"]["reason"] == result["window"]["reason"] == "SOURCE_UNAVAILABLE"
    assert result["net"]["verdict"] == "unknown"


@pytest.mark.parametrize("reason", ["SOURCE_AGE_MTIME_ONLY", "SOURCE_AGE_UNKNOWN", "REPLAY_SOURCE_MISMATCH"])
def test_unverified_receipt_cannot_support_planning(planning, reason):
    assert assess(planning, source_reasons=(reason,))["net"]["reason"] == "SOURCE_UNAVAILABLE"


def test_planning_lease_is_separate_from_camera_ttl_and_clipped_to_source(planning):
    now, _, _ = planning
    result = assess(planning, fetched_at=now - timedelta(hours=2), source_reasons=("SOURCE_STALE",))
    assert result["net"]["verdict"] == "too_far"
    assert result["valid_until"] == utc(now + timedelta(hours=1))


def test_subsecond_source_expiry_never_serializes_zero_length_lease(planning):
    now, launch, tle = planning
    now = now.replace(microsecond=900_000)
    result = assess((now, launch, tle), fetched_at=now - timedelta(hours=3, microseconds=-50_000))
    assert result["net"]["reason"] == "SOURCE_UNAVAILABLE"
    assert result["valid_until"] > result["checked_at"]


@pytest.mark.parametrize("change", ["missing", "old", "future", "net_end", "window_end"])
def test_ephemeris_limits_apply_at_each_evaluated_time(planning, change):
    now, launch, tle = planning
    if change == "missing":
        tle = None
    elif change == "old":
        tle = replace(tle, epoch=now - timedelta(hours=25))
    elif change == "future":
        tle = replace(tle, epoch=now + timedelta(hours=25))
    elif change == "net_end":
        launch = replace(launch, t0=tle.epoch + timedelta(hours=24, seconds=-100))
    else:
        launch = replace(launch, window_end=tle.epoch + timedelta(hours=24))
    result = assess((now, launch, tle))
    if change == "window_end":
        # Keep this interval inside the six-hour bound while moving its end
        # across the ephemeris boundary, independently of a valid NET screen.
        launch = replace(launch, t0=tle.epoch + timedelta(hours=23),
                         window_start=tle.epoch + timedelta(hours=23))
        result = assess((now, launch, tle))
        assert result["net"]["verdict"] == "too_far"
        assert result["window"]["reason"] == "EPHEMERIS_OUTSIDE_HORIZON"
    else:
        assert result["net"]["verdict"] == "unknown"
        assert result["net"]["reason"] == (
            "EPHEMERIS_UNAVAILABLE" if change == "missing" else "EPHEMERIS_OUTSIDE_HORIZON")


@pytest.mark.parametrize("changes", [
    {"status_abbrev": "TBD"}, {"timing_reasons": ("TIME_CONFLICT",)}, {"past": True},
])
def test_timing_uncertainty_never_becomes_negative(planning, changes):
    now, launch, tle = planning
    if changes.get("past"):
        changes = {"t0": now - timedelta(seconds=1)}
    result = assess((now, replace(launch, **changes), tle))
    assert result["net"]["reason"] == "TIMING_UNCONFIRMED"
    assert result["net"]["verdict"] == "unknown"


@pytest.mark.parametrize("changes", [
    {"window_end": None}, {"width": 7}, {"start_before": True},
])
def test_unknown_or_excessive_window_does_not_erase_net_result(planning, changes):
    now, launch, tle = planning
    if "width" in changes:
        changes = {"window_end": launch.t0 + timedelta(hours=changes["width"])}
    elif "start_before" in changes:
        changes = {"window_start": launch.t0 - timedelta(minutes=1)}
    result = assess((now, replace(launch, **changes), tle))
    assert result["net"]["verdict"] == "too_far"
    assert result["window"] == {"verdict": "unknown", "reason": "TIMING_UNCONFIRMED"}


@pytest.mark.parametrize("points", [0, 1, 5])
def test_exhaustion_cannot_complete_negative(planning, points):
    result = assess(planning, budget=EvaluationBudget(max_points=points))
    assert result["net"]["verdict"] == result["window"]["verdict"] == "unknown"
    assert result["net"]["reason"] == "EVALUATION_INCOMPLETE"


def test_completed_net_possible_survives_window_budget_limit(planning):
    now, launch, tle = planning
    observer = propagate(tle, launch.t0)
    launch = replace(launch, site_lat=observer.lat, site_lon=observer.lon,
                     window_start=launch.t0 + timedelta(minutes=1))
    result = build_planning_assessment(launch, tle, now, now, EvaluationBudget(max_points=1))
    assert result["net"]["verdict"] == "possible"
    assert result["window"]["reason"] == "EVALUATION_INCOMPLETE"


@pytest.mark.parametrize("failure", [ValueError("bad orbit"), RuntimeError("SGP4"), "nan", "alt"])
def test_invalid_geometry_is_unknown(planning, failure):
    def observer(_, at):
        if isinstance(failure, Exception):
            raise failure
        return Position(float("nan") if failure == "nan" else 0, 180,
                        -1 if failure == "alt" else 420, at)

    result = assess(planning, position=observer)
    assert result["net"]["verdict"] == result["window"]["verdict"] == "unknown"
    assert result["net"]["reason"] == "GEOMETRY_INVALID"
    assert result["net"]["look"] is None


def test_changed_net_is_recomputed_and_cannot_reuse_old_verdict(planning):
    now, launch, tle = planning
    first = assess(planning)
    slipped = replace(launch, t0=launch.t0 + timedelta(hours=1),
                      window_start=launch.t0 + timedelta(hours=1),
                      window_end=launch.t0 + timedelta(hours=2))
    observer = propagate(tle, slipped.t0)
    slipped = replace(slipped, site_lat=observer.lat, site_lon=observer.lon)
    second = build_planning_assessment(slipped, tle, now, now, EvaluationBudget())
    assert first["net"]["verdict"] == "too_far"
    assert second["net"]["verdict"] == "possible"
    assert first["net"]["at"] != second["net"]["at"]


@pytest.fixture
def public_artifact(planning):
    now, launch, tle = planning
    observer = propagate(tle, launch.t0)
    row = {
        "id": "test", "name": launch.name, "net": utc(launch.t0),
        "window_start": utc(launch.t0), "window_end": utc(launch.t0),
        "net_precision": {"name": "Second"}, "status": {"abbrev": "Go"},
        "rocket": {"configuration": {"full_name": launch.rocket_type}},
        "pad": {"latitude": observer.lat, "longitude": observer.lon,
                "location": {"name": launch.site_name}},
    }
    return build_launch_artifact({"count": 1, "next": None, "results": [row]}, tle, now, fetched_at=now)


def rehash(artifact):
    artifact["revision"] = hashlib.sha256(canonical_bytes(
        {k: v for k, v in artifact.items() if k != "revision"})).hexdigest()[:24]


def test_new_planning_and_legacy_artifacts_keep_map_only_admission(public_artifact):
    item = public_artifact["items"][0]
    assert item["assessment"]["net"]["verdict"] == "possible"
    assert item["status"] == "map_only"
    assert item["capture_intervals"] == []
    assert public_artifact["coverage"]["evaluated"] == 0
    _validate_artifact(public_artifact)
    old = copy.deepcopy(public_artifact)
    del old["items"][0]["assessment"]
    rehash(old)
    _validate_artifact(old)


@pytest.mark.parametrize("failure", [
    "private", "bad_lease", "at_mismatch", "unhashable_reason", "unhashable_verdict",
    "bad_time", "missing_epoch", "old_epoch", "unknown_look", "negative_look",
    "missing_model", "bad_frame", "bad_angle", "future_source", "expired_source",
    "bad_model", "full_window_possible", "unknown_precision", "coarse_precision",
    "time_conflict", "missing_window", "bad_window", "unverified_source",
])
def test_public_boundary_rejects_forged_or_inconsistent_planning(public_artifact, failure):
    artifact = copy.deepcopy(public_artifact)
    value = artifact["items"][0]["assessment"]
    if failure == "private":
        value["credential"] = "not-allowed"
    elif failure == "bad_lease":
        value["valid_until"] = value["checked_at"]
    elif failure == "at_mismatch":
        value["net"]["at"] = value["checked_at"]
    elif failure == "unhashable_reason":
        value["net"]["reason"] = {}
    elif failure == "unhashable_verdict":
        value["window"]["verdict"] = []
    elif failure == "bad_time":
        value["checked_at"] = None
    elif failure == "missing_epoch":
        value["tle_epoch"] = None
    elif failure == "old_epoch":
        value["tle_epoch"] = "2000-01-01T00:00:00Z"
    elif failure in {"unknown_look", "negative_look", "missing_model"}:
        value["net"]["verdict"] = "unknown" if failure == "unknown_look" else "too_far"
        value["net"]["reason"] = "NOMINAL_ASCENT_TOO_FAR"
        if failure == "missing_model":
            value["model"] = value["net"]["look"] = None
    elif failure == "bad_frame":
        value["net"]["look"]["frame"] = "compass"
    elif failure == "bad_angle":
        value["net"]["look"]["azimuth_deg"] = 360
    elif failure == "future_source":
        artifact["coverage"]["fetched_at"] = value["net"]["at"]
    elif failure == "expired_source":
        artifact["coverage"]["fetched_at"] = "2000-01-01T00:00:00Z"
    elif failure == "bad_model":
        value["model"]["duration_seconds"] = True
    elif failure == "unknown_precision":
        artifact["items"][0]["launch_window"]["precision"] = None
    elif failure == "coarse_precision":
        artifact["items"][0]["launch_window"]["precision"] = "Day"
    elif failure == "time_conflict":
        artifact["items"][0]["reason_codes"].append("TIME_CONFLICT")
    elif failure == "missing_window":
        artifact["items"][0]["launch_window"]["start"] = None
    elif failure == "bad_window":
        artifact["items"][0]["launch_window"]["end"] = value["checked_at"]
    elif failure == "unverified_source":
        artifact["coverage"]["reasons"].append("SOURCE_AGE_MTIME_ONLY")
    else:
        value["window"] = {"verdict": "too_far", "reason": "NOMINAL_ASCENT_TOO_FAR"}
    rehash(artifact)
    with pytest.raises(ValueError):
        _validate_artifact(artifact)
