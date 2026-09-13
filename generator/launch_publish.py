"""Single-writer launch namespace; never modifies Earth out/ or sends messages."""

from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

from .launch_assessment import (
    ASSESSMENT_REASONS,
    EPHEMERIS_HORIZON_SECONDS,
    PLANNING_VALID_SECONDS,
)
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
            "launch_window capture_intervals trajectory sources"
            + (" assessment" if "assessment" in item else ""),
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
        if "assessment" in item:
            _validate_assessment(item["assessment"], item, artifact, keys)
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


def _validate_assessment(value: dict, item: dict, artifact: dict, keys: Callable) -> None:
    """Public planning facts cannot accidentally become camera instructions."""
    def number(raw: object, lower: float, upper: float) -> bool:
        return (isinstance(raw, (int, float)) and not isinstance(raw, bool)
                and math.isfinite(raw) and lower <= raw <= upper)

    keys(value, "checked_at valid_until tle_epoch model net window")
    keys(value["net"], "verdict reason at pad_distance_km look")
    keys(value["window"], "verdict reason")
    checked = _parse_iso8601_z(value["checked_at"])
    expires = _parse_iso8601_z(value["valid_until"])
    net_time = _parse_iso8601_z(value["net"]["at"])
    net, window, model = value["net"], value["window"], value["model"]
    if (value["checked_at"] != artifact["generated_at"]
            or value["net"]["at"] != item["launch_window"]["net"]
            or not 0 < (expires - checked).total_seconds() <= PLANNING_VALID_SECONDS
            or not isinstance(net["verdict"], str)
            or net["verdict"] not in {"possible", "too_far", "unknown"}
            or not isinstance(window["verdict"], str)
            or window["verdict"] not in {"too_far", "unknown"}
            or not isinstance(net["reason"], str) or net["reason"] not in ASSESSMENT_REASONS
            or not isinstance(window["reason"], str) or window["reason"] not in ASSESSMENT_REASONS
            or (net["pad_distance_km"] is not None
                and not number(net["pad_distance_km"], 0, 21_000))):
        raise ValueError("INVALID_LAUNCH_ASSESSMENT")
    if model is not None:
        keys(model, "name duration_seconds max_altitude_km max_downrange_km")
        if (not isinstance(model["name"], str) or not 0 < len(model["name"]) <= 100
                or not number(model["duration_seconds"], 1, 3600)
                or not number(model["max_altitude_km"], 0, 2000)
                or not number(model["max_downrange_km"], 0, 20_000)):
            raise ValueError("INVALID_LAUNCH_ASSESSMENT")
    epoch = _parse_iso8601_z(value["tle_epoch"]) if value["tle_epoch"] is not None else None
    concrete = net["verdict"] != "unknown" or window["verdict"] != "unknown"
    if concrete:
        fetched = artifact["coverage"]["fetched_at"]
        precision = item["launch_window"]["precision"]
        start, end = item["launch_window"]["start"], item["launch_window"]["end"]
        uncertain_reasons = {
            "WINDOW_UNKNOWN", "TIME_CONFLICT", "TIME_PRECISION_UNKNOWN", "TIME_PRECISION_COARSE",
            "LAUNCH_UNCONFIRMED", "SOURCE_AGE_MTIME_ONLY", "SOURCE_AGE_UNKNOWN",
            "REPLAY_SOURCE_MISMATCH",
        }
        if (epoch is None or fetched is None or net_time < checked
                or not isinstance(precision, str) or precision.lower() not in {"second", "minute"}
                or uncertain_reasons.intersection(item["reason_codes"])
                or uncertain_reasons.intersection(artifact["coverage"]["reasons"])
                or start is None or end is None
                or _parse_iso8601_z(start) != net_time or _parse_iso8601_z(end) < net_time
                or abs((checked - epoch).total_seconds()) > EPHEMERIS_HORIZON_SECONDS
                or abs((net_time - epoch).total_seconds()) > EPHEMERIS_HORIZON_SECONDS
                or not 0 <= (checked - _parse_iso8601_z(fetched)).total_seconds()
                < PLANNING_VALID_SECONDS
                or (expires - _parse_iso8601_z(fetched)).total_seconds() > PLANNING_VALID_SECONDS):
            raise ValueError("INVALID_LAUNCH_ASSESSMENT")
    look = net["look"]
    if net["verdict"] == "possible":
        if (net["reason"] != "SITE_IN_VIEW_AT_NET" or net["pad_distance_km"] is None
                or look is None):
            raise ValueError("INVALID_LAUNCH_ASSESSMENT")
        keys(look, "frame azimuth_deg off_nadir_deg")
        if (look["frame"] != "orbital-lvlh" or not number(look["azimuth_deg"], 0, 360)
                or look["azimuth_deg"] == 360 or not number(look["off_nadir_deg"], 0, 180)):
            raise ValueError("INVALID_LAUNCH_ASSESSMENT")
    elif look is not None:
        raise ValueError("INVALID_LAUNCH_ASSESSMENT")
    for result in (net, window):
        if result["verdict"] == "too_far" and (
            model is None or result["reason"] != "NOMINAL_ASCENT_TOO_FAR"
        ):
            raise ValueError("INVALID_LAUNCH_ASSESSMENT")
    if net["verdict"] == "too_far" and (
        net_time - epoch
    ).total_seconds() + model["duration_seconds"] > EPHEMERIS_HORIZON_SECONDS:
        raise ValueError("INVALID_LAUNCH_ASSESSMENT")
    if window["verdict"] == "too_far":
        start, end = item["launch_window"]["start"], item["launch_window"]["end"]
        if start is None or end is None or net["verdict"] == "possible":
            raise ValueError("INVALID_LAUNCH_ASSESSMENT")
        start, end = _parse_iso8601_z(start), _parse_iso8601_z(end)
        if (end < start or start < net_time or (end - start).total_seconds() > 6 * 3600
                or (end - epoch).total_seconds() + model["duration_seconds"]
                > EPHEMERIS_HORIZON_SECONDS):
            raise ValueError("INVALID_LAUNCH_ASSESSMENT")


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
