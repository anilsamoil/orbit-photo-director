"""Offline evidence and publication boundary tests; no live astronomical claims."""

from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

from generator.launch_catalog import _score, build_launch_catalog
from generator.launch_data import parse_response, validate_feed
from generator.launch_evidence import (
    VALID_SECONDS,
    EvaluationBudget,
    build_launch_artifact,
    canonical_bytes,
    evaluate_liftoff_window,
    read_cached_artifact,
    utc,
)
from generator.launch_opportunities import LightMode, Sight, Subject
from generator.launch_publish import publish_launch_artifact, rclone_reader, rclone_uploader
from generator.orbit import Position, propagate
from scripts.ascent_smoke import main as diagnose
from scripts.launch_census import FIXTURE_DIR, load_replay


@pytest.fixture
def evidence(sample_tle):
    now = sample_tle.epoch.replace(microsecond=0) + timedelta(hours=1)
    start = now + timedelta(minutes=10)
    row = {
        "id": "synthetic-f9",
        "name": "Synthetic Falcon 9",
        "net": utc(start),
        "window_start": utc(start),
        "window_end": utc(start),
        "net_precision": {"name": "Second"},
        "status": {"abbrev": "Go"},
        "rocket": {"configuration": {"full_name": "Falcon 9 Block 5"}},
        "pad": {"latitude": 28.6, "longitude": -80.6, "location": {"name": "Synthetic pad"}},
    }
    return now, {"count": 1, "next": None, "results": [row]}


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        {"results": {}},
        {"results": [], "count": None},
        {"results": [], "count": True},
        {"results": [], "count": "100"},
        {"results": [], "next": 1},
        {"results": [1], "count": 0},
        {"results": [None] * 1001},
    ],
)
def test_feed_shape_failures(payload):
    with pytest.raises(ValueError):
        validate_feed(payload)


def test_unknown_trajectory_is_map_only(evidence, sample_tle):
    now, payload = evidence
    artifact = build_launch_artifact(payload, sample_tle, now, fetched_at=now)
    item = artifact["items"][0]
    assert item["status"] == "map_only"
    assert "TRAJECTORY_UNVERIFIED" in item["reason_codes"]
    assert item["trajectory"]["points"] == []
    assert item["capture_intervals"] == []
    assert artifact["coverage"]["unevaluated"] == 1
    assert not artifact["coverage"]["complete"]


@pytest.mark.parametrize(
    "change,reason",
    [
        ({"window_end": None}, "WINDOW_UNKNOWN"),
        ({"net_precision": None}, "TIME_PRECISION_UNKNOWN"),
        ({"net_precision": {"name": "Day"}}, "TIME_PRECISION_COARSE"),
        ({"window_end": "2024-10-01T00:00:00Z"}, "TIME_CONFLICT"),
    ],
)
def test_timing_unknowns_stay_explicit(evidence, sample_tle, change, reason):
    now, payload = evidence
    payload["results"][0].update(change)
    artifact = build_launch_artifact(payload, sample_tle, now, fetched_at=now)
    assert reason in artifact["items"][0]["reason_codes"]
    assert artifact["items"][0]["capture_intervals"] == []


def test_duplicate_ids_keep_the_newest_update(evidence, sample_tle):
    now, payload = evidence
    older = copy.deepcopy(payload["results"][0])
    newer = copy.deepcopy(payload["results"][0])
    older["last_updated"] = "2026-10-01T00:00:00Z"
    older["name"] = "synthetic: duplicate older"
    newer["last_updated"] = "2026-10-02T00:00:00Z"
    newer["name"] = "synthetic: duplicate newer"
    payload["results"] = [older, newer]
    payload["count"] = 2
    artifact = build_launch_artifact(payload, sample_tle, now, fetched_at=now)
    assert [item["name"] for item in artifact["items"]] == ["synthetic: duplicate newer"]
    assert "DUPLICATE_EVENT_IDS" not in artifact["coverage"]["reasons"]


def test_partial_feed_is_not_complete_negative(evidence, sample_tle):
    now, payload = evidence
    payload.update(count=101, next="https://example.invalid/page2")
    artifact = build_launch_artifact(payload, sample_tle, now, fetched_at=now)
    assert "FEED_PAGINATED" in artifact["coverage"]["reasons"]
    assert not artifact["coverage"]["complete"]


def test_fitted_horizon_page_is_not_marked_paginated(evidence, sample_tle):
    now, payload = evidence
    payload.update(count=1, next="https://example.invalid/unused")
    artifact = build_launch_artifact(payload, sample_tle, now, fetched_at=now)
    assert "FEED_PAGINATED" not in artifact["coverage"]["reasons"]


def test_missing_tle_and_malformed_rows_are_visible(evidence):
    now, payload = evidence
    payload["results"].append({"id": "broken"})
    payload["count"] = 2
    artifact = build_launch_artifact(payload, None, now)
    assert {"MALFORMED_ROWS", "EPHEMERIS_MISSING", "SOURCE_AGE_UNKNOWN"} <= set(
        artifact["coverage"]["reasons"]
    )


@pytest.mark.parametrize(
    "delta,reason",
    [(timedelta(hours=-2), "SOURCE_STALE"), (timedelta(hours=2), "REPLAY_SOURCE_MISMATCH")],
)
def test_source_age(evidence, sample_tle, delta, reason):
    now, payload = evidence
    artifact = build_launch_artifact(payload, sample_tle, now, fetched_at=now + delta)
    assert reason in artifact["coverage"]["reasons"]


def test_budget_and_asymmetric_liftoff_endpoints(evidence, sample_tle):
    now, payload = evidence
    launch = parse_response(payload, now)[0]
    launch = replace(
        launch,
        window_end=launch.t0 + timedelta(seconds=65),
        launch_azimuth_deg=45,
        trajectory_source="synthetic-test-only",
    )
    with (
        patch("generator.launch_evidence.tangent_clearance", return_value=True),
        patch("generator.launch_evidence.rocket_sun_state", return_value="day"),
        patch(
            "generator.launch_geometry.look_direction_at",
            return_value={"frame": "orbital-lvlh", "azimuth_deg": 45, "off_nadir_deg": 30},
        ),
    ):
        result = evaluate_liftoff_window(launch, sample_tle, EvaluationBudget(seconds=30))
        assert result["evaluated"]
        assert {row["liftoff_start"] for row in result["intervals"]} == {
            utc(launch.t0 + timedelta(seconds=s)) for s in (0, 60, 65)
        }
        assert "SAMPLED_GEOMETRY_ONLY" in result["reasons"]
        limited = evaluate_liftoff_window(launch, sample_tle, EvaluationBudget(max_points=1))
        assert not limited["evaluated"]
        assert limited["sample_count"] == 1
        assert "EVALUATION_INCOMPLETE" in limited["reasons"]


def test_flush_keeps_visible_segments_bound_to_their_liftoff(evidence, sample_tle):
    now, payload = evidence
    launch = parse_response(payload, now)[0]
    launch = replace(
        launch,
        window_end=launch.t0 + timedelta(seconds=60),
        launch_azimuth_deg=45,
        trajectory_source="synthetic-test-only",
    )
    look = {"frame": "orbital-lvlh", "azimuth_deg": 45, "off_nadir_deg": 30}
    with (
        patch("generator.launch_evidence.tangent_clearance", side_effect=[True, False, True] * 2),
        patch("generator.launch_evidence.rocket_sun_state", return_value="day"),
        patch("generator.launch_geometry.look_direction_at", return_value=look),
        patch("generator.launch_evidence.match_rocket") as match,
    ):
        match.return_value.insertion_t_seconds = 30
        with (
            patch(
                "generator.launch_evidence.rocket_position_at", return_value=(28.6, -80.6, 30, 0)
            ),
            patch("generator.launch_evidence.build_ascent_trajectory", return_value=[]),
        ):
            result = evaluate_liftoff_window(launch, sample_tle, EvaluationBudget(seconds=30))
    assert result["evaluated"]
    assert len(result["intervals"]) == 4
    for interval, liftoff, climb in zip(
        result["intervals"], (0, 0, 60, 60), (0, 30, 0, 30), strict=True
    ):
        assert (
            interval["liftoff_start"]
            == interval["liftoff_end"]
            == utc(launch.t0 + timedelta(seconds=liftoff))
        )
        assert (
            interval["start"]
            == interval["peak"]
            == interval["end"]
            == utc(launch.t0 + timedelta(seconds=liftoff + climb))
        )


def test_cache_receipt_and_readonly_diagnostic(tmp_path, evidence, capsys):
    now, payload = evidence
    raw = canonical_bytes(payload)
    (tmp_path / "launches.json").write_bytes(raw)
    (tmp_path / "launches.json.receipt.json").write_text(
        json.dumps({"sha256": hashlib.sha256(raw).hexdigest(), "fetched_at": utc(now)})
    )
    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in tmp_path.iterdir()}
    with patch("requests.get", side_effect=AssertionError("network forbidden")):
        assert diagnose(["--cache-dir", str(tmp_path), "--now", utc(now), "--json"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["coverage"]["listed"] == 1
    assert "schedule_fetched_at" in report["coverage"]
    assert not report["notified"] and not report["published"]
    assert "EPHEMERIS_MISSING" in report["coverage"]["reasons"]
    assert "SOURCE_AGE_MTIME_ONLY" not in report["coverage"]["reasons"]
    assert before == {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in tmp_path.iterdir()}
    with pytest.raises(ValueError, match="REPLAY_SOURCE_MISMATCH"):
        read_cached_artifact(tmp_path, now - timedelta(days=1), replay=True)


@pytest.mark.parametrize(
    "contents,reason",
    [(None, "MISSING_CACHE"), ("{", "CORRUPT_CACHE"), ('{"foo":1}', "CORRUPT_CACHE")],
)
def test_cache_failures(tmp_path, evidence, contents, reason):
    if contents is not None:
        (tmp_path / "launches.json").write_text(contents)
    with pytest.raises(ValueError, match=reason):
        read_cached_artifact(tmp_path, evidence[0])


def test_publication_is_isolated_hash_checked_and_monotonic(tmp_path, evidence, sample_tle):
    now, payload = evidence
    artifact = build_launch_artifact(payload, sample_tle, now, fetched_at=now)
    output = tmp_path / "launch-output"
    calls = []
    pointer = publish_launch_artifact(
        artifact, output, upload=lambda p, key, immutable: calls.append((key, immutable))
    )
    assert calls == [(pointer["path"], True), ("launch/latest.json", False)]
    assert pointer["sha256"] == hashlib.sha256((output / pointer["path"]).read_bytes()).hexdigest()
    assert not (output / "manifest.json").exists()
    old = build_launch_artifact(
        payload, sample_tle, now - timedelta(seconds=1), fetched_at=now - timedelta(seconds=1)
    )
    with pytest.raises(ValueError, match="OBSOLETE"):
        publish_launch_artifact(old, output)
    artifact["items"][0]["name"] = "tampered"
    with pytest.raises(ValueError, match="REVISION_MISMATCH"):
        publish_launch_artifact(artifact, output)


@pytest.mark.parametrize(
    "seconds,accepted",
    [
        (1, True),
        (VALID_SECONDS, True),
        (0, False),
        (-1, False),
        (VALID_SECONDS + 0.001, False),
        (VALID_SECONDS + 1, False),
    ],
)
def test_publication_bounds_validity(tmp_path, evidence, sample_tle, seconds, accepted):
    now, payload = evidence
    artifact = build_launch_artifact(payload, sample_tle, now, fetched_at=now)
    artifact["valid_until"] = (now + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")
    artifact["revision"] = hashlib.sha256(
        canonical_bytes({key: value for key, value in artifact.items() if key != "revision"})
    ).hexdigest()[:24]
    output = tmp_path / "launch-output"
    with patch("generator.launch_publish.rclone_uploader") as uploader:
        if accepted:
            assert (
                publish_launch_artifact(artifact, output)["valid_until"] == artifact["valid_until"]
            )
        else:
            with pytest.raises(ValueError, match="INVALID_LAUNCH_VALIDITY"):
                publish_launch_artifact(artifact, output)
            assert not output.exists()
        uploader.assert_not_called()


@pytest.mark.parametrize("immutable,max_age", [(True, "3600, immutable"), (False, "10")])
def test_uploader_uses_resolved_executable_and_explicit_argv(
    tmp_path, monkeypatch, immutable, max_age
):
    monkeypatch.chdir(tmp_path)
    source = tmp_path / "artifact ; not-a-shell.json"
    with (
        patch("generator.launch_publish.shutil.which", return_value="rclone-bin") as which,
        patch("generator.launch_publish.subprocess.run") as run,
    ):
        upload = rclone_uploader("remote:bucket with spaces/")
        upload(source, "launch/latest.json", immutable)
        which.assert_called_once_with("rclone")
        run.assert_called_once_with(
            [
                str(tmp_path / "rclone-bin"),
                "copyto",
                str(source),
                "remote:bucket with spaces/launch/latest.json",
                "--header-upload",
                f"Cache-Control: public, max-age={max_age}",
            ],
            check=True,
            timeout=90,
        )


def test_uploader_fails_before_execution_when_rclone_missing():
    with (
        patch("generator.launch_publish.shutil.which", return_value=None),
        patch("generator.launch_publish.subprocess.run") as run,
    ):
        with pytest.raises(FileNotFoundError, match="rclone executable not found"):
            rclone_uploader("remote:bucket")
        run.assert_not_called()


@pytest.mark.parametrize("remote", ["", "--invalid", "remote:bucket\ninvalid"])
def test_uploader_rejects_invalid_remote_before_resolution(remote):
    with patch("generator.launch_publish.shutil.which") as which:
        with pytest.raises(ValueError, match="invalid remote"):
            rclone_uploader(remote)
        which.assert_not_called()


@pytest.mark.parametrize("fail_at", [1, 2])
def test_failed_upload_retains_last_pointer(tmp_path, evidence, sample_tle, fail_at):
    now, payload = evidence
    output = tmp_path / "launch-output"
    initial = build_launch_artifact(payload, sample_tle, now, fetched_at=now)
    publish_launch_artifact(initial, output)
    before = (output / "launch/latest.json").read_bytes()
    newer = build_launch_artifact(payload, sample_tle, now + timedelta(seconds=1), fetched_at=now)
    calls = []

    def fail(path, key, immutable):
        calls.append(key)
        if len(calls) == fail_at:
            raise OSError("synthetic upload failure")

    with pytest.raises(OSError):
        publish_launch_artifact(newer, output, upload=fail)
    assert (output / "launch/latest.json").read_bytes() == before


def test_lock_held_through_publication(tmp_path, evidence, sample_tle):
    now, payload = evidence
    artifact = build_launch_artifact(payload, sample_tle, now, fetched_at=now)
    output = tmp_path / "launch-output"

    def competing_writer(*args):
        with pytest.raises(RuntimeError, match="BUSY"):
            publish_launch_artifact(artifact, output)

    publish_launch_artifact(artifact, output, upload=competing_writer)


def test_publication_rejects_private_fields_and_earth_output(tmp_path, evidence, sample_tle):
    now, payload = evidence
    artifact = build_launch_artifact(payload, sample_tle, now, fetched_at=now)
    with pytest.raises(ValueError, match="separate"):
        publish_launch_artifact(artifact, tmp_path / "out")
    artifact["items"][0]["sources"][0]["oauth_token"] = "test-secret"
    with pytest.raises(ValueError, match="UNEXPECTED_PUBLIC"):
        publish_launch_artifact(artifact, tmp_path / "launch-output")


def test_historical_fixture_requires_archived_evidence(tmp_path, capsys):
    registry = tmp_path / "observed.json"
    registry.write_text(json.dumps({"validation_status": "historical_ephemeris_missing"}))
    assert diagnose(["--fixture", str(registry), "--json"]) == 2
    assert "HISTORICAL_EPHEMERIS_MISSING" in json.loads(capsys.readouterr().out)["reasons"]


def _catalog_row(net: datetime, **over) -> dict:
    row = {
        "id": "synthetic-f9",
        "name": "Synthetic Falcon 9",
        "net": utc(net),
        "window_start": utc(net),
        "window_end": utc(net),
        "net_precision": {"name": "Second"},
        "status": {"abbrev": "Go"},
        "rocket": {"configuration": {"full_name": "Falcon 9 Block 5"}},
        "pad": {"latitude": 0.0, "longitude": 0.0, "location": {"name": "Synthetic pad"}},
    }
    row.update(over)
    return {"count": 1, "next": None, "results": [row]}


def _overhead(sample_tle, net: datetime) -> dict:
    iss = propagate(sample_tle, net)
    payload = _catalog_row(net)
    payload["results"][0]["pad"]["latitude"] = iss.lat
    payload["results"][0]["pad"]["longitude"] = iss.lon
    return payload


def test_night_engine_score_is_a_range():
    when = datetime(2026, 10, 6, tzinfo=UTC)
    sight = Sight(
        Subject.ASCENT, when, when, 60, 28.0, -80.0, 80.0,
        True, 500.0, 10.0, LightMode.NIGHT_ENGINE, 1.0, True,
    )
    score = _score(sight, Position(28.0, -80.0, 420.0, when), 30.0)
    assert score["terms"]["C"] == [0.3, 0.8]
    assert score["low"] < score["high"]
    assert score["low"] != (score["low"] + score["high"]) / 2


def test_overhead_pad_is_a_shot_with_one_sentence(sample_tle, tmp_path):
    now = sample_tle.epoch.replace(microsecond=0) + timedelta(hours=1)
    net = now + timedelta(minutes=10)
    catalog = build_launch_catalog(_overhead(sample_tle, net), sample_tle, now, fetched_at=now)
    item = catalog["items"][0]
    assert catalog["schema_version"] == 3
    assert catalog["schedule_valid_until"] == utc(now + timedelta(minutes=75))
    assert catalog["geometry_valid_until"] == utc(now + timedelta(minutes=15))
    assert item["tier"] == "shot"
    assert item["direction"]["kind"] == "none"
    assert item["why"].endswith(".")
    assert "km" in item["why"]
    assert all(shot["subject"] == "pad" and shot["track"] == [] for shot in item["shots"])
    shot = item["shots"][0]
    assert set(shot["score"]["terms"]) == {"A", "C", "D", "M", "R"}
    assert shot["score"]["low"] <= shot["score"]["high"]
    assert shot["score"]["low"] >= 50
    pointer = publish_launch_artifact(catalog, tmp_path / "launch-output")
    assert pointer["schema_version"] == 2
    assert pointer["valid_until"] == catalog["geometry_valid_until"]


def test_tle_age_splits_likely_and_watch(sample_tle):
    epoch = sample_tle.epoch.replace(microsecond=0)
    now = epoch + timedelta(hours=1)
    likely = build_launch_catalog(
        _overhead(sample_tle, epoch + timedelta(hours=30)), sample_tle, now, fetched_at=now,
    )
    watch = build_launch_catalog(
        _overhead(sample_tle, epoch + timedelta(hours=49)), sample_tle, now, fetched_at=now,
    )
    assert likely["items"][0]["tier"] == "likely"
    assert watch["items"][0]["tier"] == "watch"


def test_hour_and_loose_schedule_cap_the_tier(sample_tle):
    now = sample_tle.epoch.replace(microsecond=0) + timedelta(hours=1)
    net = now + timedelta(minutes=10)
    hour = _overhead(sample_tle, net)
    hour["results"][0]["net_precision"] = {"name": "Hour"}
    tbc = _overhead(sample_tle, net)
    tbc["results"][0]["status"] = {"abbrev": "TBC"}
    day = _catalog_row(net, net_precision={"name": "Day"})
    assert build_launch_catalog(hour, sample_tle, now, fetched_at=now)["items"][0]["tier"] == "watch"
    assert build_launch_catalog(tbc, sample_tle, now, fetched_at=now)["items"][0]["tier"] == "watch"
    loose = build_launch_catalog(day, sample_tle, now, fetched_at=now)["items"][0]
    assert loose["tier"] == "unassessed"
    assert loose["why"] == "Schedule is too loose to plan a window."
    assert loose["shots"] == []


def test_fresh_disk_negative_is_none_and_stale_miss_is_not(sample_tle):
    now = sample_tle.epoch.replace(microsecond=0) + timedelta(hours=1)
    fresh_net = now + timedelta(minutes=20)
    iss = propagate(sample_tle, fresh_net)
    lon = iss.lon + 180.0
    if lon > 180.0:
        lon -= 360.0
    fresh = _catalog_row(fresh_net)
    fresh["results"][0]["pad"]["latitude"] = -iss.lat
    fresh["results"][0]["pad"]["longitude"] = lon
    fresh_item = build_launch_catalog(fresh, sample_tle, now, fetched_at=now)["items"][0]
    assert fresh_item["tier"] == "none"
    assert "NOMINAL_ASCENT_TOO_FAR" in fresh_item["reasons"]
    stale_net = sample_tle.epoch.replace(microsecond=0) + timedelta(hours=49)
    stale = _catalog_row(stale_net)
    stale["results"][0]["pad"]["latitude"] = -iss.lat
    stale["results"][0]["pad"]["longitude"] = lon
    stale_item = build_launch_catalog(stale, sample_tle, now, fetched_at=now)["items"][0]
    assert stale_item["tier"] == "watch"


def test_ascent_track_needs_a_direction_and_keeps_altitude(sample_tle, tmp_path):
    now = sample_tle.epoch.replace(microsecond=0) + timedelta(hours=1)
    net = now + timedelta(minutes=10)
    payload = _overhead(sample_tle, net)
    payload["results"][0]["rocket"]["spacecraft_stage"] = [{"destination": "ISS"}]
    catalog = build_launch_catalog(payload, sample_tle, now, fetched_at=now)
    item = catalog["items"][0]
    assert item["direction"]["kind"] == "iss_plane"
    assert item["schedule"]["destination"] == "ISS"
    ascent = [shot for shot in item["shots"] if shot["subject"] == "ascent"]
    assert ascent
    assert ascent[0]["track"]
    assert any(point["alt_km"] > 0 for point in ascent[0]["track"])
    assert all(point["alt_km"] >= 0 for point in ascent[0]["track"])
    offsets = [point["t_offset_s"] for point in ascent[0]["track"]]
    assert offsets == sorted(set(offsets))
    publish_launch_artifact(catalog, tmp_path / "launch-output")


def test_liftoff_scenarios_stay_separate(sample_tle):
    now = sample_tle.epoch.replace(microsecond=0) + timedelta(hours=1)
    net = now + timedelta(minutes=10)
    payload = _overhead(sample_tle, net)
    end = net + timedelta(seconds=120)
    payload["results"][0]["window_end"] = utc(end)
    item = build_launch_catalog(payload, sample_tle, now, fetched_at=now)["items"][0]
    liftoffs = {shot["liftoff"] for shot in item["shots"]}
    assert liftoffs == {utc(net), utc(end)}
    for shot in item["shots"]:
        liftoff = datetime.fromisoformat(shot["liftoff"].replace("Z", "+00:00"))
        best = datetime.fromisoformat(shot["best"].replace("Z", "+00:00"))
        assert -300 <= (best - liftoff).total_seconds() <= 600


def test_complete_follows_the_horizon_not_the_server_count(sample_tle):
    now = sample_tle.epoch.replace(microsecond=0) + timedelta(hours=1)
    payload = _catalog_row(now + timedelta(hours=2))
    payload.update(count=400, next="https://example.invalid/page2")
    partial = build_launch_catalog(payload, sample_tle, now, fetched_at=now)
    assert partial["coverage"]["complete"] is False
    assert "FEED_PAGINATED" in partial["coverage"]["reasons"]
    far = copy.deepcopy(payload["results"][0])
    far.update(
        id="beyond-horizon",
        name="Beyond horizon",
        net=utc(now + timedelta(days=15)),
        window_start=utc(now + timedelta(days=15)),
        window_end=utc(now + timedelta(days=15)),
    )
    payload["results"].append(far)
    paged = build_launch_catalog(payload, sample_tle, now, fetched_at=now)
    assert paged["coverage"]["complete"] is True
    assert "FEED_PAGINATED" not in paged["coverage"]["reasons"]
    assert paged["coverage"]["listed"] == 1
    assert paged["coverage"]["received"] == 2


def test_saved_feed_lists_seven_and_crs35_is_watch():
    payload, tle, now = load_replay(FIXTURE_DIR)
    catalog = build_launch_catalog(payload, tle, now, fetched_at=now)
    assert catalog["schema_version"] == 3
    assert catalog["coverage"]["listed"] == 7
    assert catalog["coverage"]["tier_counts"]["shot"] == 0
    assert catalog["coverage"]["tier_counts"]["likely"] == 0
    crs = next(item for item in catalog["items"] if "SpX-35" in item["name"])
    assert crs["tier"] == "watch"
    epoch = datetime.fromisoformat(catalog["tle"]["epoch"].replace("Z", "+00:00"))
    for item in catalog["items"]:
        assert all(shot["subject"] != "ascent" or item["direction"]["kind"] != "none" for shot in item["shots"])
        if item["tier"] != "none":
            continue
        net = datetime.fromisoformat(item["schedule"]["net"].replace("Z", "+00:00"))
        assert abs((net - epoch).total_seconds()) <= 24 * 3600


def test_catalog_pointer_stays_schema2(tmp_path, sample_tle):
    from types import SimpleNamespace

    now = sample_tle.epoch.replace(microsecond=0) + timedelta(hours=1)
    catalog = build_launch_catalog(
        _catalog_row(now + timedelta(minutes=10)), sample_tle, now, fetched_at=now,
    )
    stored = {}

    def upload(path, key, immutable):
        stored[key] = path.read_bytes()

    output = tmp_path / "launch-output"
    pointer = publish_launch_artifact(catalog, output, upload=upload)
    assert pointer["schema_version"] == 2
    assert pointer["valid_until"] == catalog["geometry_valid_until"]
    body = stored[pointer["path"]]
    raw = canonical_bytes(pointer)
    with (
        patch("generator.launch_publish.shutil.which", return_value="/usr/bin/rclone"),
        patch(
            "generator.launch_publish.subprocess.run",
            side_effect=[SimpleNamespace(stdout=value) for value in (raw, body, raw)],
        ),
    ):
        assert rclone_reader("test:bucket")() == pointer
