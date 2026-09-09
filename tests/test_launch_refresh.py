"""Scheduled publication uses cache receipts, never fetches or notifies."""

import copy
import fcntl
import hashlib
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

from generator.launch_evidence import build_launch_artifact, canonical_bytes, utc
from generator.launch_publish import publish_launch_artifact, rclone_reader
from scripts.launch_refresh import refresh_cached


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


def test_refresh_and_restart_noop_preserve_source_age(setup):
    now, _, output, _, remote, calls, _, run, _ = setup
    result = run()
    assert result["published"] and not result["notified"]
    assert len(calls) == 2
    pointer = json.loads(remote["launch/latest.json"])
    artifact = json.loads(remote[pointer["path"]])
    assert artifact["coverage"]["fetched_at"] == utc(now)
    assert "FEED_PAGINATED" in artifact["coverage"]["reasons"]
    assert not artifact["coverage"]["complete"]
    assert all(item["status"] == "map_only" for item in artifact["items"])
    assert run(now + timedelta(hours=2))["reason"] == "UNCHANGED_INPUT"
    assert len(calls) == 2
    assert json.loads((output / "launch/latest.json").read_bytes()) == pointer


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
    pointer = json.loads(remote["launch/latest.json"])
    item = json.loads(remote[pointer["path"]])["items"][0]
    assert item["launch_window"]["net"] == row["net"]
    row.update(
        net=utc(now + timedelta(days=8)),
        status={"abbrev": "TBD"},
        net_precision={"name": "Day"},
        window_start=None,
        window_end=None,
    )
    write_cache(now + timedelta(hours=2))
    run(now + timedelta(hours=2))
    pointer = json.loads(remote["launch/latest.json"])
    assert json.loads(remote[pointer["path"]])["items"] == []


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


def test_remote_conflict_does_not_upload(setup):
    _, _, _, _, remote, calls, _, run, _ = setup
    pointer = json.loads(remote["launch/latest.json"])
    pointer["revision"] = "different-owner"
    remote["launch/latest.json"] = canonical_bytes(pointer)
    with pytest.raises(ValueError, match="REMOTE_LAUNCH_CONFLICT"):
        run()
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
        assert len(calls) == sent_before  # adopt confirmed remote commit, no replay


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
    assert len(calls) == 2


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
    assert len(calls) == 4


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
