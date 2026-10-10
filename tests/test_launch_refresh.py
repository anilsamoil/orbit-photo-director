"""Scheduled publication uses cache receipts, never fetches or notifies."""

import copy
import fcntl
import hashlib
import json
import shutil
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

from generator.launch_evidence import build_launch_artifact, canonical_bytes, utc
from generator.launch_publish import publish_launch_artifact, rclone_reader
from generator.orbit import TLE, propagate
from scripts import launch_refresh
from scripts.launch_refresh import refresh_cached


def _published_catalog(remote: dict) -> dict:
    pointer = json.loads(remote["launch/catalog/latest.json"])
    return json.loads(remote[pointer["path"]])


@pytest.fixture
def setup(tmp_path):
    now = datetime(2026, 9, 9, 8, tzinfo=UTC)
    cache, output = tmp_path / "cache", tmp_path / "publication"
    cache.mkdir()
    row = {
        "id": "same-event",
        "name": "Test launch",
        "net": utc(now + timedelta(hours=8)),
        "window_start": utc(now + timedelta(hours=8)),
        "window_end": utc(now + timedelta(hours=8)),
        "net_precision": {"name": "Second"},
        "status": {"abbrev": "Go"},
        "rocket": {"configuration": {"full_name": "Falcon 9 Block 5"}},
        "pad": {"latitude": 28.6, "longitude": -80.6, "location": {"name": "Test pad"}},
    }
    payload = {"results": [row], "count": 100, "next": "https://example.invalid/page2"}
    remote = {}
    calls = []

    def upload(path, key, immutable):
        calls.append(key)
        remote[key] = path.read_bytes()

    def read_remote():
        return json.loads(remote["launch/latest.json"])

    old = build_launch_artifact(
        payload, None, now - timedelta(days=2), fetched_at=now - timedelta(days=2)
    )
    publish_launch_artifact(old, output, upload=upload)
    calls.clear()

    def write_cache(at=now):
        raw = canonical_bytes(payload)
        (cache / "launches.json").write_bytes(raw)
        (cache / "launches.json.receipt.json").write_bytes(
            canonical_bytes({"sha256": hashlib.sha256(raw).hexdigest(), "fetched_at": utc(at)})
        )

    write_cache()

    def run(at=now, **kwargs):
        with patch("requests.get", side_effect=AssertionError("source fetch forbidden")):
            return refresh_cached(
                cache,
                output,
                at,
                remote="test:bucket",
                upload=kwargs.get("upload", upload),
                read_remote=read_remote,
            )

    return now, cache, output, payload, remote, calls, write_cache, run, upload


@pytest.fixture
def visible_setup(setup):
    _, cache, output, payload, remote, calls, write_cache, run, upload = setup
    tle_text = (Path(__file__).parent / "fixtures/iss-2026-10-05.tle").read_text()
    tle = TLE.from_text(tle_text)
    now = tle.epoch.replace(microsecond=0) + timedelta(hours=1)
    net = now + timedelta(hours=3)
    overhead = propagate(tle, net)
    row = payload["results"][0]
    row.update(net=utc(net), window_start=utc(net), window_end=utc(net))
    row["pad"].update(latitude=overhead.lat, longitude=overhead.lon)
    (cache / "iss.tle").write_text(tle_text)
    write_cache(now)
    return now, cache, output, payload, remote, calls, write_cache, run, upload


def test_refresh_and_restart_noop_preserve_source_age(setup):
    now, _, output, _, remote, calls, _, run, _ = setup
    result = run()
    assert result["published"] and not result["notified"]
    assert len(calls) == 4
    pointer = json.loads(remote["launch/latest.json"])
    artifact = json.loads(remote[pointer["path"]])
    catalog = _published_catalog(remote)
    assert artifact["schema_version"] == 2
    assert artifact["coverage"]["fetched_at"] == utc(now)
    assert pointer["schema_version"] == 2
    assert pointer["valid_until"] == artifact["valid_until"]
    assert catalog["schema_version"] == 3
    assert catalog["coverage"]["schedule_fetched_at"] == utc(now)
    assert catalog["schedule_valid_until"] == utc(now + timedelta(minutes=75))
    assert catalog["geometry_valid_until"] == utc(now + timedelta(minutes=15))
    assert "FEED_PAGINATED" in catalog["coverage"]["reasons"]
    assert not catalog["coverage"]["complete"]
    assert catalog["items"][0]["tier"] == "watch"
    assert run(now + timedelta(minutes=1))["reason"] == "UNCHANGED_INPUT"
    assert len(calls) == 4
    assert json.loads((output / "launch/latest.json").read_bytes()) == pointer


def test_ten_minute_checks_do_not_fetch_renew_source_or_republish_v2(setup):
    now, _, _, _, remote, calls, _, run, _ = setup
    run()
    original_pointer = remote["launch/latest.json"]
    for minutes in range(10, 180, 10):
        result = run(now + timedelta(minutes=minutes))
        assert result["reason"] == "UNCHANGED_INPUT"
        assert not result["notified"] and not result["published"]
    assert calls.count("launch/latest.json") == 1
    assert sum(key.startswith("launch/v/") for key in calls) == 1
    assert remote["launch/latest.json"] == original_pointer
    assert _published_catalog(remote)["coverage"]["schedule_fetched_at"] == utc(now)
    sent = len(calls)
    with pytest.raises(ValueError, match="CACHE_RECEIPT_EXPIRED_OR_FUTURE"):
        run(now + timedelta(hours=3))
    assert len(calls) == sent


def test_ten_minute_check_recomputes_catalog_before_its_lease_expires(visible_setup, monkeypatch):
    now, cache, output, _, remote, calls, _, run, _ = visible_setup
    evaluations = []
    build = launch_refresh.build_launch_catalog

    def tracked_build(payload, tle, at, **kwargs):
        evaluations.append(at)
        return build(payload, tle, at, **kwargs)

    monkeypatch.setattr(launch_refresh, "build_launch_catalog", tracked_build)
    run(now)
    first = _published_catalog(remote)
    original_pointer = remote["launch/latest.json"]
    original_input = json.loads((output / ".refresh-state.json").read_bytes())["input"]
    original_receipt = (cache / "launches.json.receipt.json").read_bytes()
    assert first["items"][0]["tier"] == "shot"
    sent = len(calls)
    checked_at = now + timedelta(minutes=10)
    result = run(checked_at)
    catalog = _published_catalog(remote)
    state = json.loads((output / ".refresh-catalog-state.json").read_bytes())
    assert evaluations == [now, checked_at]
    assert result["reason"] == "UNCHANGED_INPUT"
    assert not result["published"] and not result["notified"]
    assert catalog["generated_at"] == utc(checked_at)
    assert catalog["geometry_valid_until"] == utc(now + timedelta(minutes=25))
    assert catalog["geometry_valid_until"] > first["geometry_valid_until"]
    assert catalog["coverage"]["schedule_fetched_at"] == first["coverage"]["schedule_fetched_at"]
    assert catalog["tle"] == first["tle"]
    assert catalog["tle"]["epoch"] is not None
    assert catalog["items"][0]["tier"] == "shot"
    assert state["input_id"] == original_input["input_id"]
    for field in ("generated_at", "geometry_valid_until", "schedule_valid_until"):
        assert state[field] == catalog[field]
    assert json.loads((output / ".refresh-state.json").read_bytes())["input"] == original_input
    assert (cache / "launches.json.receipt.json").read_bytes() == original_receipt
    assert remote["launch/latest.json"] == original_pointer
    assert len(calls[sent:]) == 2
    assert all(key.startswith("launch/catalog/") for key in calls[sent:])


def test_catalog_is_only_rebuilt_when_lease_cannot_cover_next_check(setup):
    now, _, _, _, _, calls, _, run, _ = setup
    with patch.object(launch_refresh, "build_launch_catalog", wraps=launch_refresh.build_launch_catalog) as build:
        run()
        for seconds in (0, 60, 299):
            run(now + timedelta(seconds=seconds))
        assert build.call_count == 1
        assert len(calls) == 4
        run(now + timedelta(minutes=5))
        assert build.call_count == 2
        assert len(calls) == 6


@pytest.mark.parametrize("metadata", ["legacy", "invalid", "future"])
def test_catalog_restart_rebuilds_unusable_lease_metadata(setup, metadata):
    now, _, output, _, remote, calls, _, run, _ = setup
    run()
    path = output / ".refresh-catalog-state.json"
    state = json.loads(path.read_bytes())
    if metadata == "legacy":
        for field in ("generated_at", "geometry_valid_until", "schedule_valid_until"):
            state.pop(field)
    elif metadata == "invalid":
        state["geometry_valid_until"] = "invalid"
    else:
        state["generated_at"] = utc(now + timedelta(minutes=2))
    path.write_bytes(canonical_bytes(state))
    assert run(now + timedelta(minutes=1))["reason"] == "UNCHANGED_INPUT"
    assert _published_catalog(remote)["generated_at"] == utc(now + timedelta(minutes=1))
    assert len(calls) == 6
    assert all(key.startswith("launch/catalog/") for key in calls[4:])
    assert run(now + timedelta(minutes=2))["reason"] == "UNCHANGED_INPUT"
    assert len(calls) == 6


@pytest.mark.parametrize("minutes", [75, 80, 179])
def test_catalog_rebuild_cannot_renew_actionable_tier_from_stale_receipt(visible_setup, minutes):
    now, _, output, _, remote, calls, _, run, _ = visible_setup
    run(now)
    original = _published_catalog(remote)
    original_input = json.loads((output / ".refresh-state.json").read_bytes())["input"]
    assert original["items"][0]["tier"] == "shot"
    result = run(now + timedelta(minutes=minutes))
    catalog = _published_catalog(remote)
    assert result["reason"] == "UNCHANGED_INPUT"
    assert not result["published"] and not result["notified"]
    assert catalog["generated_at"] == utc(now + timedelta(minutes=minutes))
    assert catalog["items"][0]["tier"] == "watch"
    assert catalog["coverage"]["schedule_fetched_at"] == utc(now)
    assert catalog["tle"] == original["tle"]
    assert catalog["geometry_valid_until"] <= catalog["schedule_valid_until"] <= utc(now + timedelta(hours=3))
    assert json.loads((output / ".refresh-state.json").read_bytes())["input"] == original_input
    assert all(key.startswith("launch/catalog/") for key in calls[4:])
    sent = len(calls)
    with pytest.raises(ValueError, match="CACHE_RECEIPT_EXPIRED_OR_FUTURE"):
        run(now + timedelta(hours=3))
    assert len(calls) == sent


def test_ten_minute_check_consumes_new_receipt_once(setup):
    now, _, _, _, remote, calls, write_cache, run, _ = setup
    run()
    # Receipt arrives before the old source lease expires; the hourly phase
    # could miss it. A ten-minute check consumes it before expiry.
    received = now + timedelta(hours=2, minutes=41)
    write_cache(received)
    result = run(now + timedelta(hours=2, minutes=50))
    assert result["published"] and not result["notified"]
    catalog = _published_catalog(remote)
    assert catalog["coverage"]["schedule_fetched_at"] == utc(received)
    assert len(calls) == 8
    assert run(now + timedelta(hours=3))["reason"] == "UNCHANGED_INPUT"
    assert len(calls) == 10
    assert all(key.startswith("launch/catalog/") for key in calls[8:])


def test_slip_then_tbd_removes_old_exact_event(setup):
    now, _, _, payload, remote, _, write_cache, run, _ = setup
    run()
    row = payload["results"][0]
    row.update(
        net=utc(now + timedelta(days=1, hours=8)),
        window_start=utc(now + timedelta(days=1, hours=8)),
        window_end=utc(now + timedelta(days=1, hours=8)),
    )
    write_cache(now + timedelta(hours=1))
    run(now + timedelta(hours=1))
    item = _published_catalog(remote)["items"][0]
    assert item["schedule"]["net"] == row["net"]
    row.update(
        net=utc(now + timedelta(days=8)),
        status={"abbrev": "TBD"},
        net_precision={"name": "Day"},
        window_start=None,
        window_end=None,
    )
    write_cache(now + timedelta(hours=2))
    run(now + timedelta(hours=2))
    items = _published_catalog(remote)["items"]
    assert [item["schedule"]["net"] for item in items] == [row["net"]]
    assert items[0]["tier"] == "unassessed"
    assert "LAUNCH_UNCONFIRMED" in items[0]["reasons"]


@pytest.mark.parametrize("mode", ["missing", "mismatch", "future", "stale"])
def test_bad_cache_receipt_cannot_publish(setup, mode):
    now, cache, _, _, _, calls, write_cache, run, _ = setup
    path = cache / "launches.json.receipt.json"
    if mode == "missing":
        path.unlink()
    elif mode == "mismatch":
        path.write_text('{"sha256":"wrong"}')
    else:
        write_cache(now + timedelta(hours=1) if mode == "future" else now - timedelta(hours=3))
    with pytest.raises(ValueError):
        run()
    assert calls == []


@pytest.mark.parametrize("unchanged", [False, True])
def test_remote_conflict_does_not_upload(setup, unchanged):
    now, _, _, _, remote, calls, _, run, _ = setup
    if unchanged:
        run()
        calls.clear()
    pointer = json.loads(remote["launch/latest.json"])
    pointer["revision"] = "different-owner"
    remote["launch/latest.json"] = canonical_bytes(pointer)
    with pytest.raises(ValueError, match="REMOTE_LAUNCH_CONFLICT"):
        run(now + timedelta(minutes=10))
    assert calls == []


@pytest.mark.parametrize("fail_key", ["immutable", "pointer"])
def test_interruption_retains_last_good_and_recovers_same_intent(setup, fail_key):
    now, _, output, _, remote, calls, _, run, upload = setup
    before = (output / "launch/latest.json").read_bytes()

    def interrupted(path, key, immutable):
        if (fail_key == "immutable" and immutable) or (fail_key == "pointer" and not immutable):
            if not immutable:
                upload(path, key, immutable)  # provider accepted; acknowledgment lost
            raise RuntimeError("interrupted")
        upload(path, key, immutable)

    with pytest.raises(RuntimeError, match="interrupted"):
        run(upload=interrupted)
    assert (output / "launch/latest.json").read_bytes() == before
    sent_before = len(calls)
    result = run(now + timedelta(minutes=1))
    assert result["reason"] in {"PUBLISHED", "UNCHANGED_INPUT"}
    assert (output / "launch/latest.json").read_bytes() == remote["launch/latest.json"]
    if fail_key == "pointer":
        assert calls.count("launch/latest.json") == 1
        assert sum(key.startswith("launch/v/") for key in calls) == 1
        assert sent_before == 2


def test_rollback_and_cross_destination_are_rejected(setup):
    now, cache, output, _, _, calls, write_cache, run, upload = setup
    run()
    write_cache(now - timedelta(minutes=1))
    with pytest.raises(ValueError, match="OBSOLETE_SOURCE_RECEIPT"):
        run()
    with pytest.raises(ValueError, match="REMOTE_OWNER_MISMATCH"):
        refresh_cached(
            cache, output, now, remote="other:bucket", upload=upload, read_remote=lambda: {}
        )
    assert len(calls) == 4


def test_remote_changes_during_immutable_upload_do_not_flip_pointer(setup):
    _, _, output, _, remote, _, _, run, upload = setup
    before = (output / "launch/latest.json").read_bytes()

    def competing(path, key, immutable):
        upload(path, key, immutable)
        if immutable:
            pointer = copy.deepcopy(json.loads(remote["launch/latest.json"]))
            pointer["revision"] = "competing"
            remote["launch/latest.json"] = canonical_bytes(pointer)

    with pytest.raises(ValueError, match="REMOTE_LAUNCH_CONFLICT"):
        run(upload=competing)
    assert (output / "launch/latest.json").read_bytes() == before


def test_expired_unaccepted_intent_can_use_new_receipt_after_outage(setup):
    now, _, _, _, _, _, write_cache, run, _ = setup
    with pytest.raises(RuntimeError, match="offline"):
        run(upload=lambda *args: (_ for _ in ()).throw(RuntimeError("offline")))
    write_cache(now + timedelta(hours=4))
    assert run(now + timedelta(hours=4))["reason"] == "PUBLISHED"


def test_refresh_lock_excludes_second_worker(setup):
    _, _, output, _, _, calls, _, run, _ = setup
    with (output / ".launch-refresh.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(RuntimeError, match="LAUNCH_REFRESH_BUSY"):
            run()
    assert calls == []


def test_unchanged_data_with_new_source_receipt_updates_checked_time(setup):
    now, _, _, _, _, calls, write_cache, run, _ = setup
    first = run()
    write_cache(now + timedelta(hours=2))
    second = run(now + timedelta(hours=2))
    assert first["revision"] != second["revision"]
    assert second["fetched_at"] == utc(now + timedelta(hours=2))
    assert len(calls) == 8


@pytest.mark.parametrize("failure", [None, "hash", "path", "changed"])
def test_remote_reader_bounds_and_verifies_actual_artifact(setup, failure):
    from types import SimpleNamespace

    _, _, _, _, remote, _, _, _, _ = setup
    pointer = json.loads(remote["launch/latest.json"])
    if failure == "hash":
        pointer["sha256"] = "0" * 64
    if failure == "path":
        pointer["path"] = "../credentials"
    raw = canonical_bytes(pointer)
    outputs = [raw, remote.get(pointer["path"], b""), raw if failure != "changed" else b"{}"]
    with (
        patch("generator.launch_publish.shutil.which", return_value="/usr/bin/rclone"),
        patch(
            "generator.launch_publish.subprocess.run",
            side_effect=[SimpleNamespace(stdout=value) for value in outputs],
        ) as run,
    ):
        reader = rclone_reader("test:bucket")
        if failure:
            with pytest.raises(ValueError):
                reader()
        else:
            assert reader() == pointer
        assert all(call.kwargs["timeout"] == 45 for call in run.call_args_list)
        assert all("--count" in call.args[0] for call in run.call_args_list)
        if failure == "path":
            assert run.call_count == 1


def test_policy_upgrade_republishes_same_receipt_once_without_releasing_owner(setup):
    now, _, output, _, _, calls, _, run, _ = setup
    first = run()
    state_path = output / ".refresh-state.json"
    state = json.loads(state_path.read_bytes())
    old_owner = state["remote"]
    old_receipt = state["input"]["fetched_at"]
    state["input"]["policy"] = 1
    state["input"]["input_id"] = hashlib.sha256(canonical_bytes(
        {key: value for key, value in state["input"].items() if key != "input_id"}
    )).hexdigest()
    state_path.write_bytes(canonical_bytes(state))
    catalog_state_path = output / ".refresh-catalog-state.json"
    catalog_state = json.loads(catalog_state_path.read_bytes())
    catalog_state["input_id"] = state["input"]["input_id"]
    catalog_state_path.write_bytes(canonical_bytes(catalog_state))
    upgraded = run(now + timedelta(seconds=1))
    assert upgraded["published"] and upgraded["revision"] != first["revision"]
    state = json.loads(state_path.read_bytes())
    assert state["remote"] == old_owner
    assert state["input"]["fetched_at"] == old_receipt
    assert state["input"]["policy"] == 6
    assert len(calls) == 8
    assert run(now + timedelta(seconds=2))["reason"] == "UNCHANGED_INPUT"
    assert len(calls) == 8


def test_live_path_stays_visible_to_current_selectors(setup):
    now, _, output, _, _, _, _, run, _ = setup
    run()
    pointer = json.loads((output / "launch/latest.json").read_bytes())
    artifact_path = output / pointer["path"]
    catalog_path = output / json.loads((output / "launch/catalog/latest.json").read_bytes())["path"]
    frontend = Path(__file__).resolve().parents[1] / "frontend"
    bun = shutil.which("bun")
    assert bun, "bun must be on PATH so selectAllLaunches can read the published paths"
    script = """
import { readFileSync } from 'node:fs';
import { selectAllLaunches } from './src/iss-view/launches.ts';
const now = Number(process.argv[1]);
const state = (path) => ({
  artifact: JSON.parse(readFileSync(path, 'utf8')),
  pointer: null,
  availability: 'ready',
  superseded: false,
});
const ids = (path) => selectAllLaunches(state(path), now).map((selection) => selection.item.event_id);
console.log(JSON.stringify({ live: ids(process.argv[2]), catalog: ids(process.argv[3]) }));
"""
    result = subprocess.run(  # noqa: S603
        [bun, "-e", script, str(int(now.timestamp() * 1000)), str(artifact_path), str(catalog_path)],
        cwd=frontend,
        check=True,
        capture_output=True,
        text=True,
    )
    selected = json.loads(result.stdout)
    assert selected["live"] == ["same-event"]
    assert selected["catalog"] == []


def _receipt(cache, payload, fetched_at: str) -> None:
    raw = canonical_bytes(payload)
    (cache / "launches.json").write_bytes(raw)
    (cache / "launches.json.receipt.json").write_bytes(
        canonical_bytes({"sha256": hashlib.sha256(raw).hexdigest(), "fetched_at": fetched_at})
    )


def test_receipt_just_inside_75_minutes_publishes_a_real_lease(setup):
    now, cache, output, payload, remote, _, _, run, _ = setup
    fetched = now - timedelta(minutes=75) + timedelta(milliseconds=200)
    _receipt(cache, payload, fetched.isoformat(timespec="milliseconds").replace("+00:00", "Z"))
    result = run()
    assert result["published"]
    catalog = _published_catalog(remote)
    assert catalog["generated_at"] < catalog["geometry_valid_until"] <= catalog["schedule_valid_until"]
    assert catalog["schedule_valid_until"] == utc(now + timedelta(minutes=75))
    assert catalog["geometry_valid_until"] == utc(now + timedelta(minutes=15))
    assert not (output / ".refresh-intent.json").exists()
    assert run(now + timedelta(seconds=1))["reason"] == "UNCHANGED_INPUT"


def test_truncated_receipt_lease_does_not_stick_refresh(setup):
    now, cache, output, payload, remote, calls, _, run, _ = setup
    fetched = now - timedelta(hours=3) + timedelta(milliseconds=200)
    _receipt(cache, payload, fetched.isoformat(timespec="milliseconds").replace("+00:00", "Z"))
    result = run()
    assert result["published"]
    assert result["catalog_skipped"] == "INVALID_LAUNCH_VALIDITY"
    assert len(calls) == 2
    assert "launch/latest.json" in remote
    assert not any(key.startswith("launch/catalog/") for key in calls)
    assert not (output / ".refresh-intent.json").exists()
    assert run()["reason"] == "UNCHANGED_INPUT"
    assert len(calls) == 2
    assert not (output / ".refresh-intent.json").exists()


def test_invalid_catalog_after_v2_commit_recovers(setup):
    now, _, output, _, _, calls, _, run, _ = setup
    run()
    state = json.loads((output / ".refresh-state.json").read_bytes())
    pointer = json.loads((output / "launch/latest.json").read_bytes())
    artifact = json.loads((output / pointer["path"]).read_bytes())
    catalog_pointer = json.loads((output / "launch/catalog/latest.json").read_bytes())
    catalog = json.loads((output / catalog_pointer["path"]).read_bytes())
    catalog["schedule_valid_until"] = catalog["generated_at"]
    catalog["geometry_valid_until"] = catalog["generated_at"]
    catalog["revision"] = "0" * 24
    intent = {
        "remote": "test:bucket",
        "input": state["input"],
        "artifact": artifact,
        "catalog": catalog,
    }
    (output / ".refresh-intent.json").write_bytes(canonical_bytes(intent))
    sent = len(calls)
    result = run(now + timedelta(seconds=1))
    assert result["reason"] == "UNCHANGED_INPUT"
    assert not (output / ".refresh-intent.json").exists()
    assert not any(key.startswith("launch/catalog/") for key in calls[sent:])
    assert run(now + timedelta(seconds=2))["reason"] == "UNCHANGED_INPUT"


def test_lagging_local_pointer_adopts_the_remote_v2_commit(setup):
    now, _, output, _, remote, calls, _, run, _ = setup
    before = (output / "launch/latest.json").read_bytes()
    run()
    accepted = remote["launch/latest.json"]
    assert (output / "launch/latest.json").read_bytes() == accepted
    (output / "launch/latest.json").write_bytes(before)
    sent = len(calls)
    adopted = run(now + timedelta(seconds=1))
    assert adopted["reason"] == "UNCHANGED_INPUT"
    assert (output / "launch/latest.json").read_bytes() == accepted
    assert len(calls) == sent
    assert run(now + timedelta(seconds=2))["reason"] == "UNCHANGED_INPUT"
    assert len(calls) == sent


def test_catalog_outage_then_fresh_input_updates_v2_immediately(setup):
    now, _, _, _, remote, calls, write_cache, run, upload = setup

    def catalog_down(path, key, immutable):
        if key.startswith("launch/catalog/"):
            raise RuntimeError("catalog offline")
        upload(path, key, immutable)

    first = run(upload=catalog_down)
    assert first["published"]
    assert first["catalog_skipped"] == "catalog offline"
    assert "launch/latest.json" in remote
    assert not any(key.startswith("launch/catalog/") for key in remote)
    write_cache(now + timedelta(hours=1))
    second = run(now + timedelta(hours=1))
    assert second["published"]
    assert second["revision"] != first["revision"]
    assert json.loads(remote["launch/latest.json"])["revision"] == second["revision"]
    assert any(key.startswith("launch/catalog/") for key in calls)


def test_catalog_lease_refresh_failure_keeps_prior_state_and_retries(setup):
    now, _, output, _, remote, calls, _, run, upload = setup
    run()
    state_path = output / ".refresh-catalog-state.json"
    previous_state = state_path.read_bytes()
    previous_pointer = remote["launch/catalog/latest.json"]
    v2_pointer = remote["launch/latest.json"]

    def catalog_pointer_down(path, key, immutable):
        if key == "launch/catalog/latest.json":
            raise RuntimeError("catalog offline")
        upload(path, key, immutable)

    failed = run(now + timedelta(minutes=10), upload=catalog_pointer_down)
    assert failed["reason"] == "UNCHANGED_INPUT"
    assert failed["catalog_skipped"] == "catalog offline"
    assert state_path.read_bytes() == previous_state
    assert remote["launch/catalog/latest.json"] == previous_pointer
    assert remote["launch/latest.json"] == v2_pointer
    recovered = run(now + timedelta(minutes=11))
    assert "catalog_skipped" not in recovered
    assert _published_catalog(remote)["generated_at"] == utc(now + timedelta(minutes=11))
    assert remote["launch/latest.json"] == v2_pointer
    assert all(key.startswith("launch/catalog/") for key in calls[4:])


def test_publish_path_prevalidates_both_artifacts(tmp_path, monkeypatch, capsys):
    from generator.launch_publish import _validate_artifact, _validate_catalog
    from scripts.launch_refresh import main

    now = datetime.now(UTC).replace(microsecond=0)
    cache, output = tmp_path / "cache", tmp_path / "publication"
    cache.mkdir()
    row = {
        "id": "same-event",
        "name": "Test launch",
        "net": utc(now + timedelta(hours=8)),
        "window_start": utc(now + timedelta(hours=8)),
        "window_end": utc(now + timedelta(hours=8)),
        "net_precision": {"name": "Second"},
        "status": {"abbrev": "Go"},
        "rocket": {"configuration": {"full_name": "Falcon 9 Block 5"}},
        "pad": {"latitude": 28.6, "longitude": -80.6, "location": {"name": "Test pad"}},
    }
    payload = {"results": [row], "count": 1, "next": None}
    _receipt(cache, payload, utc(now))
    uploads = []
    seen = []

    def validate_artifact(artifact):
        seen.append(("v2", len(uploads)))
        _validate_artifact(artifact)

    def validate_catalog(artifact):
        seen.append(("catalog", len(uploads)))
        _validate_catalog(artifact)

    def upload(path, key, immutable):
        uploads.append(key)

    monkeypatch.setattr("scripts.launch_refresh._validate_artifact", validate_artifact)
    monkeypatch.setattr("scripts.launch_refresh._validate_catalog", validate_catalog)
    monkeypatch.setattr("scripts.launch_refresh.rclone_uploader", lambda _remote: upload)
    code = main(
        ["--cache-dir", str(cache), "--output", str(output), "--publish", "--remote", "test:bucket"]
    )
    assert code == 0
    assert seen[:2] == [("catalog", 0), ("v2", 0)]
    assert any(key.startswith("launch/v/") for key in uploads)
    assert any(key.startswith("launch/catalog/") for key in uploads)
    logged = json.loads(capsys.readouterr().out)
    assert logged["ok"] is True
    assert "catalog_skipped" not in logged


def test_publish_path_skips_an_invalid_catalog_and_ships_v2(tmp_path, monkeypatch, capsys):
    from scripts.launch_refresh import main

    now = datetime.now(UTC).replace(microsecond=0)
    cache, output = tmp_path / "cache", tmp_path / "publication"
    cache.mkdir()
    row = {
        "id": "same-event",
        "name": "Test launch",
        "net": utc(now + timedelta(hours=8)),
        "window_start": utc(now + timedelta(hours=8)),
        "window_end": utc(now + timedelta(hours=8)),
        "net_precision": {"name": "Second"},
        "status": {"abbrev": "Go"},
        "rocket": {"configuration": {"full_name": "Falcon 9 Block 5"}},
        "pad": {"latitude": 28.6, "longitude": -80.6, "location": {"name": "Test pad"}},
    }
    _receipt(cache, {"results": [row], "count": 1, "next": None}, utc(now))
    uploads = []

    def reject(_artifact):
        raise ValueError("INVALID_LAUNCH_VALIDITY")

    monkeypatch.setattr("scripts.launch_refresh._validate_catalog", reject)
    monkeypatch.setattr(
        "scripts.launch_refresh.rclone_uploader",
        lambda _remote: lambda path, key, immutable: uploads.append(key),
    )
    code = main(
        ["--cache-dir", str(cache), "--output", str(output), "--publish", "--remote", "test:bucket"]
    )
    assert code == 0
    assert any(key.startswith("launch/v/") for key in uploads)
    assert not any(key.startswith("launch/catalog/") for key in uploads)
    logged = json.loads(capsys.readouterr().out)
    assert logged["catalog_skipped"] == "INVALID_LAUNCH_VALIDITY"
