"""Single-writer launch namespace; never modifies Earth out/ or sends messages."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

from .launch_data import _parse_iso8601_z
from .launch_evidence import VALID_SECONDS, canonical_bytes


def _validate_artifact(artifact: dict) -> None:
    def keys(value: dict, expected: str) -> None:
        if not isinstance(value, dict) or set(value) != set(expected.split()):
            raise ValueError("UNEXPECTED_PUBLIC_LAUNCH_FIELDS")

    keys(artifact, "schema_version revision generated_at valid_until coverage items")
    if artifact["schema_version"] != 2 or len(artifact["items"]) > 100:
        raise ValueError("INVALID_LAUNCH_SCHEMA")
    keys(
        artifact["coverage"],
        "complete from until fetched_at received parsed evaluated visible unevaluated reasons",
    )
    for item in artifact["items"]:
        keys(
            item,
            "event_id revision name rocket site status reason_codes "
            "launch_window capture_intervals trajectory sources",
        )
        if item["status"] != "map_only":
            raise ValueError("LAUNCH_INSTRUCTIONS_NOT_ENABLED")
        keys(item["site"], "name lat lon")
        keys(item["launch_window"], "net start end precision")
        keys(item["trajectory"], "quality source points")
        for point in item["trajectory"]["points"]:
            keys(point, "lat lon alt_km t_offset_seconds")
        for interval in item["capture_intervals"]:
            keys(interval, "start peak end liftoff_start liftoff_end look")
            if interval["look"] is not None:
                keys(interval["look"], "frame azimuth_deg off_nadir_deg")
        for source in item["sources"]:
            keys(source, "kind url fetched_at")
    expected = hashlib.sha256(
        canonical_bytes({k: v for k, v in artifact.items() if k != "revision"})
    ).hexdigest()[:24]
    if artifact["revision"] != expected:
        raise ValueError("LAUNCH_REVISION_MISMATCH")
    if len(canonical_bytes(artifact)) > 2_000_000:
        raise ValueError("LAUNCH_ARTIFACT_TOO_LARGE")
    validity = (
        _parse_iso8601_z(artifact["valid_until"]) - _parse_iso8601_z(artifact["generated_at"])
    ).total_seconds()
    if not 0 < validity <= VALID_SECONDS:
        raise ValueError("INVALID_LAUNCH_VALIDITY")


def publish_launch_artifact(
    artifact: dict,
    output: Path,
    *,
    upload: Callable[[Path, str, bool], None] | None = None,
    read_remote: Callable[[], dict] | None = None,
    permit_upload: bool = True,
) -> dict:
    _validate_artifact(artifact)
    if "out" in output.resolve().parts:
        raise ValueError("launch output must be separate from Earth out/")
    output.mkdir(parents=True, exist_ok=True)
    with (output / ".launch-publisher.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("LAUNCH_PUBLISHER_BUSY") from exc
        revision = artifact["revision"]
        if (
            not isinstance(revision, str)
            or len(revision) != 24
            or any(c not in "0123456789abcdef" for c in revision)
        ):
            raise ValueError("invalid launch revision")
        generated = _parse_iso8601_z(artifact["generated_at"])
        pointer_path = output / "launch/latest.json"
        previous = None
        if pointer_path.exists():
            previous = json.loads(pointer_path.read_text())
            if _parse_iso8601_z(previous["generated_at"]) > generated:
                raise ValueError("OBSOLETE_LAUNCH_PUBLICATION")
            if (
                previous["generated_at"] == artifact["generated_at"]
                and previous["revision"] != revision
            ):
                raise ValueError("CONFLICTING_LAUNCH_REVISION")
        relative = f"launch/v/{revision}.json"
        artifact_path = output / relative
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        body = canonical_bytes(artifact)
        if artifact_path.exists() and artifact_path.read_bytes() != body:
            raise ValueError("IMMUTABLE_LAUNCH_CONFLICT")
        pending_artifact = artifact_path.with_suffix(".pending")
        pending_artifact.write_bytes(body)
        os.replace(pending_artifact, artifact_path)
        pointer = {
            "schema_version": 2,
            "revision": revision,
            "generated_at": artifact["generated_at"],
            "valid_until": artifact["valid_until"],
            "path": relative,
            "sha256": hashlib.sha256(body).hexdigest(),
        }
        pending = output / "launch/.latest.pending.json"
        pending.write_bytes(canonical_bytes(pointer))
        # Hold ownership through upload; failure cannot advance the local receipt.
        if upload:
            remote = read_remote() if read_remote else None
            if read_remote and (previous is None or remote not in (previous, pointer)):
                raise ValueError("REMOTE_LAUNCH_CONFLICT")
            # A confirmed pointer+hash readback resolves an interrupted acknowledgment.
            if not read_remote or remote != pointer:
                if not permit_upload:
                    raise ValueError("PENDING_SOURCE_EXPIRED")
                upload(artifact_path, relative, True)
                if read_remote and read_remote() != previous:
                    raise ValueError("REMOTE_LAUNCH_CONFLICT")
                upload(pending, "launch/latest.json", False)
                if read_remote and read_remote() != pointer:
                    raise ValueError("REMOTE_LAUNCH_READBACK_FAILED")
        os.replace(pending, pointer_path)
        return pointer


def rclone_uploader(remote: str) -> Callable[[Path, str, bool], None]:
    if not remote or remote.startswith("-") or "\n" in remote:
        raise ValueError("invalid remote")
    executable = shutil.which("rclone")
    if executable is None:
        raise FileNotFoundError("rclone executable not found")
    executable = str(Path(executable).resolve())

    def upload(path: Path, relative: str, immutable: bool) -> None:
        command = [
            executable,
            "copyto",
            str(path.resolve()),
            f"{remote.rstrip('/')}/{relative}",
            "--header-upload",
            "Cache-Control: public, max-age=" + ("3600, immutable" if immutable else "10"),
        ]
        # Resolved rclone, publisher paths and operator remote use separate argv; no shell.
        subprocess.run(command, check=True, timeout=90)  # noqa: S603

    return upload


def rclone_reader(remote: str) -> Callable[[], dict]:
    """Read and hash-validate the actual remote commit, bounded and fail-closed."""
    if not remote or remote.startswith("-") or "\n" in remote:
        raise ValueError("invalid remote")
    executable = shutil.which("rclone")
    if executable is None:
        raise FileNotFoundError("rclone executable not found")
    executable = str(Path(executable).resolve())

    def cat(relative: str, limit: int) -> bytes:
        result = subprocess.run(  # noqa: S603
            [executable, "cat", f"{remote.rstrip('/')}/{relative}", "--count", str(limit + 1)],
            check=True,
            capture_output=True,
            timeout=45,
        )
        if len(result.stdout) > limit:
            raise ValueError("REMOTE_LAUNCH_TOO_LARGE")
        return result.stdout

    def read() -> dict:
        raw = cat("launch/latest.json", 4096)
        pointer = json.loads(raw)
        if not isinstance(pointer, dict) or set(pointer) != {
            "schema_version",
            "revision",
            "generated_at",
            "valid_until",
            "path",
            "sha256",
        }:
            raise ValueError("INVALID_REMOTE_LAUNCH_POINTER")
        revision = pointer["revision"]
        if (
            not isinstance(revision, str)
            or not re.fullmatch(r"[a-f0-9]{24}", revision)
            or pointer["path"] != f"launch/v/{revision}.json"
        ):
            raise ValueError("INVALID_REMOTE_LAUNCH_PATH")
        body = cat(pointer["path"], 2_000_000)
        artifact = json.loads(body)
        _validate_artifact(artifact)
        if (
            hashlib.sha256(body).hexdigest() != pointer["sha256"]
            or any(
                pointer[k] != artifact[k]
                for k in ("schema_version", "revision", "generated_at", "valid_until")
            )
            or cat("launch/latest.json", 4096) != raw
        ):
            raise ValueError("REMOTE_LAUNCH_READBACK_FAILED")
        return pointer

    return read
