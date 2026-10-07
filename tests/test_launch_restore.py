"""The 2026-10-02 policy-2 publication must publish again, and a missing object must not decode as JSON."""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from generator.launch_evidence import canonical_bytes, utc
from generator.launch_publish import _validate_artifact
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
    assert heal[0][2].endswith(restored)
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
