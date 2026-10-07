import hashlib
import json
import os
import subprocess
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from generator.launch_evidence import build_launch_artifact, canonical_bytes, utc
from generator.launch_publish import (
    _validate_artifact,
    publish_launch_artifact,
    rclone_reader,
    rclone_uploader,
)
from scripts.launch_refresh import main

FIXTURE = Path(__file__).parent / "fixtures" / "launch_outage"
OLD_REVISION = "2f58f14646f9c98626068210"
PENDING_REVISION = "b93c558321008c8a8d8954a6"
OLD_SHA = "cdd30ac0586adf1ff6f204442a20ddbd8e8e8d879cd3409514c3a04a59f8a02a"
NOW = datetime(2026, 10, 7, 8, 40, tzinfo=UTC)
REMOTE = "test:bucket"
PREFIX = f"{REMOTE}/"


class _Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


def _artifact_bytes() -> bytes:
    return (FIXTURE / f"{OLD_REVISION}.json").read_bytes()


def _pointer_bytes() -> bytes:
    return (FIXTURE / "latest.json").read_bytes()


def _pending_bytes() -> bytes:
    return (FIXTURE / "latest.pending.json").read_bytes()


def _layout(tmp_path: Path, *, remote_artifact: bool = True, local_body: bytes | None = None):
    output = tmp_path / "publication"
    cache = tmp_path / "cache"
    version = output / "launch" / "v"
    version.mkdir(parents=True)
    cache.mkdir()
    artifact = _artifact_bytes()
    (output / "launch" / "latest.json").write_bytes(_pointer_bytes())
    (output / "launch" / ".latest.pending.json").write_bytes(_pending_bytes())
    body = artifact if local_body is None else local_body
    if body is not None:
        (version / f"{OLD_REVISION}.json").write_bytes(body)
    intent_artifact = json.loads(artifact)
    intent_artifact["revision"] = PENDING_REVISION
    intent = {
        "remote": REMOTE,
        "input": {
            "policy": 2,
            "schedule_sha256": "a" * 64,
            "fetched_at": "2026-10-02T11:33:20Z",
            "tle_sha256": "b" * 64,
            "input_id": "expired-b93c",
        },
        "artifact": intent_artifact,
    }
    (output / ".refresh-intent.json").write_bytes(canonical_bytes(intent))
    row = {
        "id": "same-event",
        "name": "Test launch",
        "net": utc(NOW + timedelta(hours=8)),
        "window_start": utc(NOW + timedelta(hours=8)),
        "window_end": utc(NOW + timedelta(hours=8)),
        "net_precision": {"name": "Second"},
        "status": {"abbrev": "Go"},
        "rocket": {"configuration": {"full_name": "Falcon 9 Block 5"}},
        "pad": {"latitude": 28.6, "longitude": -80.6, "location": {"name": "Test pad"}},
    }
    payload = {"results": [row], "count": 100, "next": "https://example.invalid/page2"}
    raw = canonical_bytes(payload)
    (cache / "launches.json").write_bytes(raw)
    (cache / "launches.json.receipt.json").write_bytes(
        canonical_bytes(
            {"sha256": hashlib.sha256(raw).hexdigest(), "fetched_at": utc(NOW - timedelta(minutes=10))}
        )
    )
    store = {"launch/latest.json": _pointer_bytes()}
    if remote_artifact:
        store[f"launch/v/{OLD_REVISION}.json"] = artifact
    return cache, output, store


def _install(monkeypatch: pytest.MonkeyPatch, store: dict[str, bytes]) -> list[list[str]]:
    commands: list[list[str]] = []

    def run(command, check=False, capture_output=False, timeout=None):
        argv = [str(part) for part in command]
        commands.append(argv)
        if "sync" in argv:
            raise AssertionError("rclone sync is forbidden")
        op = argv[1]
        if op == "copyto":
            dest = argv[3]
            assert dest.startswith(PREFIX)
            store[dest[len(PREFIX) :]] = Path(argv[2]).read_bytes()
            return SimpleNamespace(stdout=b"", returncode=0)
        if op == "cat":
            target = argv[2]
            assert target.startswith(PREFIX)
            return SimpleNamespace(stdout=store.get(target[len(PREFIX) :], b""), returncode=0)
        raise AssertionError(argv)

    monkeypatch.setattr("generator.launch_publish.shutil.which", lambda name: "/usr/bin/rclone")
    monkeypatch.setattr("generator.launch_publish.subprocess.run", run)
    monkeypatch.setattr("scripts.launch_refresh.datetime", _Clock)
    return commands


def _run(cache: Path, output: Path) -> int:
    return main(
        [
            "--cache-dir",
            str(cache),
            "--output",
            str(output),
            "--publish",
            "--scheduled",
            "--remote",
            REMOTE,
        ]
    )


def _log(capsys: pytest.CaptureFixture[str]) -> dict:
    out = capsys.readouterr().out
    assert "Expecting value" not in out
    return json.loads(out)


def test_policy2_net_omits_only_t_offset_seconds() -> None:
    artifact = json.loads(_artifact_bytes())
    _validate_artifact(artifact)
    assert "t_offset_seconds" not in artifact["items"][0]["assessment"]["net"]
    assert "t_offset_seconds" not in artifact["items"][1]["assessment"]["net"]
    extra = json.loads(_artifact_bytes())
    extra["items"][0]["assessment"]["net"]["bonus"] = 1
    with pytest.raises(ValueError, match="UNEXPECTED_PUBLIC_LAUNCH_FIELDS"):
        _validate_artifact(extra)
    missing = json.loads(_artifact_bytes())
    del missing["items"][0]["assessment"]["net"]["pad_distance_km"]
    with pytest.raises(ValueError, match="UNEXPECTED_PUBLIC_LAUNCH_FIELDS"):
        _validate_artifact(missing)


def test_scheduled_publish_supersedes_restored_policy2_artifact(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path)
    commands = _install(monkeypatch, store)
    assert _run(cache, output) == 0
    logged = _log(capsys)
    assert logged["reason"] == "PUBLISHED"
    pointer = json.loads(store["launch/latest.json"])
    body = store[pointer["path"]]
    assert pointer["schema_version"] == 2
    assert pointer["revision"] not in {OLD_REVISION, PENDING_REVISION}
    assert pointer["sha256"] == hashlib.sha256(body).hexdigest()
    assert pointer["sha256"] != OLD_SHA
    assert json.loads(body)["schema_version"] == 2
    assert json.loads((output / "launch" / "latest.json").read_bytes()) == pointer
    catalog_pointer = json.loads(store["launch/catalog/latest.json"])
    catalog = json.loads(store[catalog_pointer["path"]])
    assert catalog["schema_version"] == 3
    assert store[f"launch/v/{OLD_REVISION}.json"] == _artifact_bytes()
    assert f"launch/v/{PENDING_REVISION}.json" not in store
    assert not (output / "launch" / ".latest.pending.json").exists()
    assert not (output / ".refresh-intent.json").exists()
    assert "sync" not in {part for argv in commands for part in argv}


def test_empty_remote_bytes_log_missing_artifact(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path)
    store["launch/latest.json"] = b""
    _install(monkeypatch, store)
    assert _run(cache, output) == 2
    assert _log(capsys)["reason"] == "REMOTE_LAUNCH_ARTIFACT_MISSING"


def test_missing_remote_key_logs_missing_artifact(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path, remote_artifact=False, local_body=b"")
    (output / "launch" / "v" / f"{OLD_REVISION}.json").unlink()
    (output / "launch" / "latest.json").write_bytes(_pending_bytes())
    commands = _install(monkeypatch, store)
    assert _run(cache, output) == 2
    assert _log(capsys)["reason"] == "REMOTE_LAUNCH_ARTIFACT_MISSING"
    assert all(argv[1] != "copyto" for argv in commands)


def test_self_heal_copies_the_matching_local_object_and_publishes(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path, remote_artifact=False)
    commands = _install(monkeypatch, store)
    assert _run(cache, output) == 0
    logged = _log(capsys)
    assert logged["reason"] == "PUBLISHED"
    restored = f"launch/v/{OLD_REVISION}.json"
    assert store[restored] == _artifact_bytes()
    heal = [argv for argv in commands if argv[1] == "copyto" and argv[3] == f"{PREFIX}{restored}"]
    assert len(heal) == 1
    assert heal[0][2].endswith(f".heal-{OLD_REVISION}.tmp")
    assert "sync" not in {part for argv in commands for part in argv}
    pointer = json.loads(store["launch/latest.json"])
    assert pointer["sha256"] == hashlib.sha256(store[pointer["path"]]).hexdigest()
    assert pointer["sha256"] != OLD_SHA
    assert json.loads(store[json.loads(store["launch/catalog/latest.json"])["path"]])["schema_version"] == 3


def test_hash_mismatch_fails_closed(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path, remote_artifact=False, local_body=b"{}")
    commands = _install(monkeypatch, store)
    assert _run(cache, output) == 2
    assert _log(capsys)["reason"] == "LOCAL_LAUNCH_HASH_MISMATCH"
    assert f"launch/v/{OLD_REVISION}.json" not in store
    assert all(argv[1] != "copyto" for argv in commands)


def test_orphan_expired_pending_dropped_on_unchanged_input(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path)
    commands = _install(monkeypatch, store)
    assert _run(cache, output) == 0
    assert _log(capsys)["reason"] == "PUBLISHED"
    pending = output / "launch" / ".latest.pending.json"
    pending.write_bytes(_pending_bytes())
    commands.clear()
    assert _run(cache, output) == 0
    assert _log(capsys)["reason"] == "UNCHANGED_INPUT"
    assert all(argv[1] != "copyto" for argv in commands)
    assert not pending.exists()


def test_truncated_pending_recovers_from_intent_and_latest(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path)
    pending = output / "launch" / ".latest.pending.json"
    pending.write_bytes(b"{")
    _install(monkeypatch, store)
    assert _run(cache, output) == 0
    assert _log(capsys)["reason"] == "PUBLISHED"
    assert (output / "launch" / ".latest.pending.bad.json").read_bytes() == b"{"
    assert not pending.exists()
    assert _run(cache, output) == 0
    assert _log(capsys)["reason"] == "UNCHANGED_INPUT"


def test_interrupted_pending_write_keeps_the_previous_bytes(tmp_path, monkeypatch):
    _, output, _store = _layout(tmp_path, remote_artifact=False)
    artifact = json.loads(_artifact_bytes())
    real_replace = os.replace

    def boom(src, dst):
        if Path(dst).name == ".latest.pending.json":
            raise OSError("disk")
        real_replace(src, dst)

    monkeypatch.setattr("generator.launch_publish.os.replace", boom)
    with pytest.raises(OSError, match="disk"):
        publish_launch_artifact(artifact, output, upload=None)
    assert (output / "launch" / ".latest.pending.json").read_bytes() == _pending_bytes()
    assert not list((output / "launch").glob(".latest.pending.json.*.tmp"))


def test_scheduled_refresh_leaves_a_paused_manual_commit_intact(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path)
    _install(monkeypatch, store)
    payload = json.loads((cache / "launches.json").read_bytes())
    built_at = NOW - timedelta(minutes=20)
    artifact = build_launch_artifact(payload, None, built_at, fetched_at=built_at)
    paused = threading.Event()
    release = threading.Event()
    saved: dict[str, bytes] = {}
    done: dict = {}

    def upload(path: Path, relative: str, immutable: bool) -> None:
        if relative == "launch/latest.json":
            paused.set()
            assert release.wait(10)
        saved[relative] = path.read_bytes()

    def manual() -> None:
        try:
            done["pointer"] = publish_launch_artifact(artifact, output, upload=upload)
        except Exception as exc:
            done["error"] = exc
            paused.set()

    thread = threading.Thread(target=manual)
    thread.start()
    assert paused.wait(10)
    pending_during = (output / "launch" / ".latest.pending.json").read_bytes()
    try:
        assert _run(cache, output) == 2
        assert _log(capsys)["reason"] == "LAUNCH_PUBLISHER_BUSY"
        assert (output / "launch" / ".latest.pending.json").read_bytes() == pending_during
    finally:
        release.set()
    thread.join(10)
    assert not thread.is_alive()
    assert "error" not in done
    pointer = done["pointer"]
    assert json.loads(saved["launch/latest.json"])["revision"] == pointer["revision"]
    assert hashlib.sha256(saved[pointer["path"]]).hexdigest() == pointer["sha256"]


def test_heal_uploads_verified_bytes_when_the_source_changes(tmp_path, monkeypatch):
    _, output, store = _layout(tmp_path, remote_artifact=False)
    expected = _artifact_bytes()
    live = output / "launch" / "v" / f"{OLD_REVISION}.json"

    def run(command, check=False, capture_output=False, timeout=None):
        argv = [str(part) for part in command]
        if "sync" in argv:
            raise AssertionError("rclone sync is forbidden")
        op = argv[1]
        if op == "copyto":
            live.write_bytes(expected + b"\n")
            data = Path(argv[2]).read_bytes()
            dest = argv[3]
            assert dest.startswith(PREFIX)
            store[dest[len(PREFIX) :]] = data
            return SimpleNamespace(stdout=b"", stderr=b"", returncode=0)
        if op == "cat":
            target = argv[2]
            body = store.get(target[len(PREFIX) :], b"")
            return SimpleNamespace(stdout=body, stderr=b"", returncode=0)
        raise AssertionError(argv)

    monkeypatch.setattr("generator.launch_publish.shutil.which", lambda name: "/usr/bin/rclone")
    monkeypatch.setattr("generator.launch_publish.subprocess.run", run)
    reader = rclone_reader(REMOTE, local=output, upload=rclone_uploader(REMOTE))
    pointer = reader()
    restored = store[f"launch/v/{OLD_REVISION}.json"]
    assert pointer["sha256"] == OLD_SHA
    assert restored == expected
    assert hashlib.sha256(restored).hexdigest() == OLD_SHA
    assert live.read_bytes() == expected + b"\n"


def test_whitespace_object_is_overwritten_when_the_digest_matches(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path, remote_artifact=False)
    key = f"launch/v/{OLD_REVISION}.json"
    store[key] = b" \n"
    _install(monkeypatch, store)
    assert _run(cache, output) == 0
    assert _log(capsys)["reason"] == "PUBLISHED"
    assert store[key] == _artifact_bytes()


def test_repeated_heal_warns_and_keeps_the_count(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path)
    _install(monkeypatch, store)
    assert _run(cache, output) == 0
    first = _log(capsys)
    assert first["reason"] == "PUBLISHED"
    assert "heal" not in first
    key = json.loads(store["launch/latest.json"])["path"]
    digest = store[key]
    del store[key]
    assert _run(cache, output) == 0
    second = _log(capsys)
    assert second["ok"] is True
    assert second["reason"] == "UNCHANGED_INPUT"
    assert second["heal"] == {"key": key, "count": 1}
    assert store[key] == digest
    del store[key]
    assert _run(cache, output) == 0
    third = _log(capsys)
    assert third["ok"] is True
    assert third["reason"] == "WARN"
    assert third["heal"] == {"key": key, "count": 2}
    assert store[key] == digest
    assert json.loads((output / ".launch-heal.json").read_bytes())["counts"][key] == 2
    assert _run(cache, output) == 0
    fourth = _log(capsys)
    assert fourth["reason"] == "UNCHANGED_INPUT"
    assert "heal" not in fourth
    assert json.loads((output / ".launch-heal.json").read_bytes())["counts"][key] == 2


def test_rclone_nonzero_exit_puts_stderr_in_the_reason(tmp_path, monkeypatch, capsys):
    cache, output, _store = _layout(tmp_path)

    def run(command, check=False, capture_output=False, timeout=None):
        return SimpleNamespace(stdout=b"", stderr=b"auth failed\n", returncode=7)

    monkeypatch.setattr("generator.launch_publish.shutil.which", lambda name: "/usr/bin/rclone")
    monkeypatch.setattr("generator.launch_publish.subprocess.run", run)
    monkeypatch.setattr("scripts.launch_refresh.datetime", _Clock)
    assert _run(cache, output) == 2
    assert _log(capsys)["reason"] == "RCLONE_EXIT_7: auth failed"


def test_uploader_nonzero_exit_puts_stderr_in_the_reason(tmp_path, monkeypatch, capsys):
    cache, output, store = _layout(tmp_path)

    def run(command, check=False, capture_output=False, timeout=None):
        assert capture_output is True
        argv = [str(part) for part in command]
        if "sync" in argv:
            raise AssertionError("rclone sync is forbidden")
        op = argv[1]
        if op == "copyto":
            return SimpleNamespace(stdout=b"", stderr=b"disk full\n", returncode=3)
        if op == "cat":
            target = argv[2]
            assert target.startswith(PREFIX)
            body = store.get(target[len(PREFIX) :], b"")
            return SimpleNamespace(stdout=body, stderr=b"", returncode=0)
        raise AssertionError(argv)

    monkeypatch.setattr("generator.launch_publish.shutil.which", lambda name: "/usr/bin/rclone")
    monkeypatch.setattr("generator.launch_publish.subprocess.run", run)
    monkeypatch.setattr("scripts.launch_refresh.datetime", _Clock)
    assert _run(cache, output) == 2
    assert _log(capsys)["reason"] == "RCLONE_EXIT_3: disk full"


def test_rclone_timeout_puts_stderr_in_the_reason(tmp_path, monkeypatch, capsys):
    cache, output, _store = _layout(tmp_path)

    def run(command, check=False, capture_output=False, timeout=None):
        assert capture_output is True
        expired = subprocess.TimeoutExpired(list(command), timeout or 45)
        expired.stderr = b"i/o timeout\n"
        raise expired

    monkeypatch.setattr("generator.launch_publish.shutil.which", lambda name: "/usr/bin/rclone")
    monkeypatch.setattr("generator.launch_publish.subprocess.run", run)
    monkeypatch.setattr("scripts.launch_refresh.datetime", _Clock)
    assert _run(cache, output) == 2
    assert _log(capsys)["reason"] == "RCLONE_TIMEOUT: i/o timeout"


@pytest.mark.parametrize("operation", ["cat", "copyto"])
@pytest.mark.parametrize(
    "stderr",
    [b"i/o timeout\n", "i/o timeout\n", None],
    ids=["bytes", "str", "none"],
)
def test_timeout_reason_matrix(tmp_path, monkeypatch, capsys, operation, stderr):
    cache, output, store = _layout(tmp_path)
    calls = []
    limits = {"cat": 45, "copyto": 90}

    def run(command, check=False, capture_output=False, timeout=None):
        argv = [str(part) for part in command]
        if "sync" in argv:
            raise AssertionError("rclone sync is forbidden")
        op = argv[1]
        calls.append((op, timeout))
        assert check is False
        assert capture_output is True
        assert timeout == limits[op]
        if op == operation:
            raise subprocess.TimeoutExpired(
                command, timeout, output=b"wrong stdout\n", stderr=stderr,
            )
        assert op == "cat"
        target = argv[2]
        assert target.startswith(PREFIX)
        body = store.get(target[len(PREFIX) :], b"")
        return SimpleNamespace(stdout=body, stderr=b"", returncode=0)

    monkeypatch.setattr("generator.launch_publish.shutil.which", lambda name: "/usr/bin/rclone")
    monkeypatch.setattr("generator.launch_publish.subprocess.run", run)
    monkeypatch.setattr("scripts.launch_refresh.datetime", _Clock)
    assert _run(cache, output) == 2
    detail = "" if stderr is None else "i/o timeout"
    assert _log(capsys)["reason"] == "RCLONE_TIMEOUT: " + detail
    assert calls[-1] == (operation, limits[operation])
