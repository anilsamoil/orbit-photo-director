"""Scheduled catalogs recover their own accepted PUT without adopting other owners."""

import copy
import fcntl
import hashlib
import json
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from generator.launch_catalog import build_launch_catalog
from generator.launch_publish import publish_launch_catalog
from scripts import launch_refresh
from tests.test_launch_refresh_ownership import NOW, RENEWAL, LaunchHarness

CATALOG_KEY = "launch/catalog/latest.json"


@pytest.fixture
def scheduled(tmp_path, monkeypatch, capsys):
    harness = LaunchHarness(tmp_path)
    harness.failure = None
    harness.commands = []

    class Clock(datetime):
        at = NOW

        @classmethod
        def now(cls, tz=None):
            return cls.at

    def assert_locked():
        with (harness.output / ".launch-publisher.lock").open("a") as lock:
            with pytest.raises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def transport(command, check=False, capture_output=False, timeout=None):
        harness.commands.append(command)
        if command[1] == "copyto":
            assert_locked()
            assert command[3].startswith("test:bucket/")
            key = command[3].removeprefix("test:bucket/")
            harness.upload(Path(command[2]), key, "/v/" in key)
            if key == CATALOG_KEY and harness.failure:
                failure, harness.failure = harness.failure, None
                if failure == "timeout":
                    raise subprocess.TimeoutExpired(command, timeout)
                return SimpleNamespace(stdout=b"", stderr=b"accepted PUT, lost response", returncode=5)
            return SimpleNamespace(stdout=b"", stderr=b"", returncode=0)
        assert command[1] == "cat"
        assert command[2].startswith("test:bucket/")
        key = command[2].removeprefix("test:bucket/")
        if key not in harness.remote:
            return SimpleNamespace(stdout=b"", stderr=b"object not found", returncode=4)
        limit = int(command[command.index("--count") + 1])
        return SimpleNamespace(stdout=harness.remote[key][:limit], stderr=b"", returncode=0)

    def forbidden(*args, **kwargs):
        raise AssertionError("source fetch or network forbidden")

    replace = launch_refresh.os.replace

    def checked_replace(source, destination):
        if Path(destination) == harness.output / CATALOG_KEY:
            assert_locked()
        return replace(source, destination)

    atomic_json = launch_refresh._atomic_json

    def checked_state(path, value):
        if path.name == ".refresh-catalog-state.json":
            assert_locked()
        atomic_json(path, value)

    monkeypatch.setattr("requests.get", forbidden)
    monkeypatch.setattr("socket.create_connection", forbidden)
    monkeypatch.setattr("generator.launch_publish.shutil.which", lambda _name: "/usr/bin/rclone")
    monkeypatch.setattr("generator.launch_publish.subprocess.run", transport)
    monkeypatch.setattr(launch_refresh, "datetime", Clock)
    monkeypatch.setattr(launch_refresh.os, "replace", checked_replace)
    monkeypatch.setattr(launch_refresh, "_atomic_json", checked_state)

    def run(at):
        Clock.at = at
        assert launch_refresh.main([
            "--cache-dir", str(harness.cache), "--output", str(harness.output),
            "--publish", "--scheduled", "--remote", "test:bucket",
        ]) == 0
        return json.loads(capsys.readouterr().out)

    harness.scheduled = run
    assert run(NOW)["reason"] == "PUBLISHED"
    return harness


def _lose_acknowledgment(harness, failure):
    local = (harness.output / CATALOG_KEY).read_bytes()
    state = (harness.output / ".refresh-catalog-state.json").read_bytes()
    harness.failure = failure
    result = harness.scheduled(RENEWAL)
    assert result["catalog_skipped"].startswith(
        "RCLONE_TIMEOUT" if failure == "timeout" else "RCLONE_EXIT_5"
    )
    pending = harness.output / "launch/catalog/.latest.pending.json"
    pointer = json.loads(pending.read_bytes())
    assert pending.read_bytes() == harness.remote[CATALOG_KEY]
    assert pointer["sha256"] == hashlib.sha256(harness.remote[pointer["path"]]).hexdigest()
    assert pointer["sha256"] == hashlib.sha256((harness.output / pointer["path"]).read_bytes()).hexdigest()
    assert (harness.output / CATALOG_KEY).read_bytes() == local
    assert (harness.output / ".refresh-catalog-state.json").read_bytes() == state
    return pending, pointer


@pytest.mark.parametrize("legacy", [False, True], ids=["persisted-intent", "legacy-pending"])
@pytest.mark.parametrize("failure", ["rc5", "timeout"])
@pytest.mark.parametrize("retry_minutes", [11, 26, 30], ids=["next-check", "expired-lease", "fresh-receipt"])
def test_postcommit_acknowledgment_loss_recovers_and_keeps_renewing(scheduled, failure, retry_minutes, legacy):
    harness = scheduled
    original_v2 = harness.remote["launch/latest.json"]
    original_receipt = (harness.cache / "launches.json.receipt.json").read_bytes()
    pending, _ = _lose_acknowledgment(harness, failure)
    if legacy:
        (harness.output / ".refresh-catalog-intent.json").unlink(missing_ok=True)
        state_path = harness.output / ".refresh-catalog-state.json"
        state = json.loads(state_path.read_bytes())
        state.pop("pointer", None)
        state_path.write_text(json.dumps(state))
    retry_at = NOW + timedelta(minutes=retry_minutes)
    if retry_minutes == 30:
        harness.write_cache(retry_at)

    result = harness.scheduled(retry_at)

    assert "catalog_skipped" not in result
    assert (harness.output / CATALOG_KEY).read_bytes() == harness.remote[CATALOG_KEY]
    assert not pending.exists()
    pointer = harness.read_catalog()
    catalog_state = json.loads((harness.output / ".refresh-catalog-state.json").read_bytes())
    assert catalog_state["revision"] == pointer["revision"]
    assert datetime.fromisoformat(pointer["valid_until"]) > retry_at + timedelta(minutes=10)
    assert harness.catalog()["items"][0]["tier"] == "likely"
    if retry_minutes != 30:
        assert harness.remote["launch/latest.json"] == original_v2
        assert (harness.cache / "launches.json.receipt.json").read_bytes() == original_receipt

    sent = len(harness.calls)
    assert "catalog_skipped" not in harness.scheduled(retry_at + timedelta(seconds=1))
    assert harness.calls[sent:] == []
    next_at = retry_at + timedelta(minutes=10)
    assert "catalog_skipped" not in harness.scheduled(next_at)
    assert datetime.fromisoformat(harness.catalog()["geometry_valid_until"]) == next_at + timedelta(minutes=15)
    assert (harness.output / CATALOG_KEY).read_bytes() == harness.remote[CATALOG_KEY]


@pytest.mark.parametrize("tamper", ["foreign-remote", "foreign-pending", "corrupt-body", "missing-body"])
def test_acknowledgment_recovery_rejects_unverified_or_foreign_pending(scheduled, tamper):
    harness = scheduled
    pending, pointer = _lose_acknowledgment(harness, "rc5")
    if tamper in {"foreign-remote", "foreign-pending"}:
        payload = copy.deepcopy(harness.payload)
        payload["results"][0]["status"] = {"abbrev": "TBC"}
        at = RENEWAL + timedelta(seconds=1)
        catalog = build_launch_catalog(payload, harness.tle, at, fetched_at=at)

        def foreign_upload(path, key, immutable):
            harness.upload(path, key, immutable)
            if key == CATALOG_KEY and tamper == "foreign-pending":
                raise TimeoutError("another publisher lost acknowledgment")

        target = harness.output if tamper == "foreign-pending" else harness.output.parent / "foreign"
        if tamper == "foreign-pending":
            with pytest.raises(TimeoutError):
                publish_launch_catalog(catalog, target, upload=foreign_upload)
        else:
            publish_launch_catalog(catalog, target, upload=foreign_upload)
    elif tamper == "corrupt-body":
        body = harness.output / pointer["path"]
        body.write_bytes(body.read_bytes() + b" ")
    else:
        (harness.output / pointer["path"]).unlink()
    local = (harness.output / CATALOG_KEY).read_bytes()
    state = (harness.output / ".refresh-catalog-state.json").read_bytes()
    remote = dict(harness.remote)
    sent = len(harness.calls)

    result = harness.scheduled(NOW + timedelta(minutes=20))

    assert "catalog_skipped" in result
    assert harness.remote == remote
    assert harness.calls[sent:] == []
    assert (harness.output / CATALOG_KEY).read_bytes() == local
    assert (harness.output / ".refresh-catalog-state.json").read_bytes() == state
    assert pending.exists()


def test_catalog_state_failure_after_local_pointer_commit_recovers(scheduled, monkeypatch):
    harness = scheduled
    catalog_state_path = harness.output / ".refresh-catalog-state.json"
    original_state = catalog_state_path.read_bytes()
    atomic_json = launch_refresh._atomic_json
    failed = False

    def interrupt_state_commit(path, value):
        nonlocal failed
        if path == catalog_state_path and not failed:
            failed = True
            assert (harness.output / CATALOG_KEY).read_bytes() == harness.remote[CATALOG_KEY]
            assert not (harness.output / "launch/catalog/.latest.pending.json").exists()
            raise OSError("interrupted after local catalog pointer commit")
        atomic_json(path, value)

    monkeypatch.setattr(launch_refresh, "_atomic_json", interrupt_state_commit)
    result = harness.scheduled(RENEWAL)
    assert result["catalog_skipped"] == "interrupted after local catalog pointer commit"
    assert catalog_state_path.read_bytes() == original_state
    assert harness.catalog()["generated_at"] == "2026-10-10T08:10:00Z"
    assert (harness.output / ".refresh-catalog-intent.json").exists()

    result = harness.scheduled(RENEWAL + timedelta(minutes=1))

    assert "catalog_skipped" not in result
    assert not (harness.output / ".refresh-catalog-intent.json").exists()
    assert (harness.output / CATALOG_KEY).read_bytes() == harness.remote[CATALOG_KEY]
    state = json.loads(catalog_state_path.read_bytes())
    assert state["revision"] == harness.read_catalog()["revision"]
    assert "catalog_skipped" not in harness.scheduled(RENEWAL + timedelta(minutes=10))
    assert harness.catalog()["geometry_valid_until"] == "2026-10-10T08:35:00Z"


@pytest.mark.parametrize("change", ["payload", "tle", "payload-and-tle"])
@pytest.mark.parametrize("failure", ["rc5", "timeout"])
def test_own_pending_recovers_when_cached_inputs_have_changed(scheduled, failure, change):
    harness = scheduled
    _lose_acknowledgment(harness, failure)
    if change in {"payload", "payload-and-tle"}:
        harness.payload["results"][0]["status"] = {"abbrev": "TBC"}
    if change in {"tle", "payload-and-tle"}:
        (harness.cache / "iss.tle").write_bytes(
            (Path(__file__).parent / "fixtures/iss-2026-10-05.tle").read_bytes()
        )
    at = NOW + timedelta(minutes=30)
    harness.write_cache(at)
    old_v2 = harness.remote["launch/latest.json"]

    result = harness.scheduled(at)

    assert result["reason"] == "PUBLISHED"
    assert "catalog_skipped" not in result
    assert harness.remote["launch/latest.json"] != old_v2
    assert (harness.output / CATALOG_KEY).read_bytes() == harness.remote[CATALOG_KEY]
    assert not (harness.output / ".refresh-catalog-intent.json").exists()
    assert not (harness.output / "launch/catalog/.latest.pending.json").exists()
    catalog = harness.catalog()
    assert catalog["generated_at"] == "2026-10-10T08:30:00Z"
    assert catalog["coverage"]["schedule_fetched_at"] == "2026-10-10T08:30:00Z"
    if change in {"payload", "payload-and-tle"}:
        assert catalog["items"][0]["schedule"]["status"] == "TBC"
        assert catalog["items"][0]["tier"] == "watch"
    if change in {"tle", "payload-and-tle"}:
        assert catalog["tle"]["epoch"].startswith("2026-10-05")
    assert "catalog_skipped" not in harness.scheduled(at + timedelta(minutes=10))
    assert harness.catalog()["geometry_valid_until"] == "2026-10-10T08:55:00Z"
