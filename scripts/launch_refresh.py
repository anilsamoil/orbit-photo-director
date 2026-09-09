#!/usr/bin/env python3
"""Explicit launch-only publication from existing cache; never sends WhatsApp."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import subprocess
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from generator.launch_data import _parse_iso8601_z, validate_feed
from generator.launch_evidence import build_launch_artifact, canonical_bytes, read_cached_artifact
from generator.launch_publish import publish_launch_artifact, rclone_reader, rclone_uploader
from generator.orbit import TLE

# Schedule refresh tolerance, NOT the 15-minute capture-evidence lifetime.
MAX_SCHEDULE_AGE_SECONDS = 3 * 3600


def _atomic_json(path: Path, value: dict) -> None:
    pending = path.with_suffix(".pending")
    with pending.open("wb") as file:
        file.write(canonical_bytes(value))
        file.flush()
        os.fsync(file.fileno())
    os.replace(pending, path)


def _cached_inputs(cache: Path, now: datetime) -> tuple[dict, dict, TLE | None]:
    receipt_path = cache / "launches.json.receipt.json"
    try:
        receipt_raw = receipt_path.read_bytes()
        receipt = json.loads(receipt_raw)
        if (cache / "launches.json").stat().st_size > 8_000_000:
            raise ValueError("CACHE_TOO_LARGE")
        raw = (cache / "launches.json").read_bytes()
        if (
            receipt["sha256"] != hashlib.sha256(raw).hexdigest()
            or receipt_raw != receipt_path.read_bytes()
        ):
            raise ValueError("CACHE_RECEIPT_MISMATCH")
        fetched = _parse_iso8601_z(receipt["fetched_at"])
        if not 0 <= (now - fetched).total_seconds() < MAX_SCHEDULE_AGE_SECONDS:
            raise ValueError("CACHE_RECEIPT_EXPIRED_OR_FUTURE")
        payload = json.loads(raw)
        validate_feed(payload)
    except (OSError, KeyError, TypeError, AttributeError) as exc:
        raise ValueError("CACHE_RECEIPT_REQUIRED") from exc
    try:
        tle_raw = (cache / "iss.tle").read_bytes()
    except FileNotFoundError:
        tle_raw = b""
    try:
        tle = TLE.from_text(tle_raw.decode())
    except (ValueError, UnicodeError):
        tle = None
    identity = {
        "policy": 1,
        "schedule_sha256": receipt["sha256"],
        "fetched_at": receipt["fetched_at"],
        "tle_sha256": hashlib.sha256(tle_raw).hexdigest(),
    }
    identity["input_id"] = hashlib.sha256(canonical_bytes(identity)).hexdigest()
    return identity, payload, tle


def refresh_cached(
    cache: Path,
    output: Path,
    now: datetime,
    *,
    remote: str,
    upload: Callable,
    read_remote: Callable,
) -> dict:
    """One persistent owner; durable intent before upload, receipt after readback."""
    if "out" in output.resolve().parts:
        raise ValueError("launch output must be separate from Earth out/")
    output.mkdir(parents=True, exist_ok=True)
    with (output / ".launch-refresh.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("LAUNCH_REFRESH_BUSY") from exc
        state_path = output / ".refresh-state.json"
        intent_path = output / ".refresh-intent.json"
        state = json.loads(state_path.read_bytes()) if state_path.exists() else {}
        intent = json.loads(intent_path.read_bytes()) if intent_path.exists() else None
        if any(value and value["remote"] != remote for value in (state, intent)):
            raise ValueError("REMOTE_OWNER_MISMATCH")

        def finish(value: dict) -> dict:
            artifact = value["artifact"]
            age = (now - _parse_iso8601_z(artifact["coverage"]["fetched_at"])).total_seconds()
            pointer = publish_launch_artifact(
                artifact,
                output,
                upload=upload,
                read_remote=read_remote,
                permit_upload=0 <= age < MAX_SCHEDULE_AGE_SECONDS,
            )
            committed = {"remote": remote, "input": value["input"], "pointer": pointer}
            _atomic_json(state_path, committed)
            intent_path.unlink(missing_ok=True)
            return committed

        if (
            intent
            and (
                now - _parse_iso8601_z(intent["artifact"]["coverage"]["fetched_at"])
            ).total_seconds()
            >= MAX_SCHEDULE_AGE_SECONDS
        ):
            local = json.loads((output / "launch/latest.json").read_bytes())
            observed = read_remote()
            # If the old pointer is still committed, an expired, unaccepted intent
            # is safe to retire. Otherwise only finish() can adopt its exact commit.
            if observed == local and observed["revision"] != intent["artifact"]["revision"]:
                intent_path.unlink()
                intent = None
        if intent:
            state = finish(intent)
        identity, payload, tle = _cached_inputs(cache, now)
        if state:
            if _parse_iso8601_z(identity["fetched_at"]) < _parse_iso8601_z(
                state["input"]["fetched_at"]
            ):
                raise ValueError("OBSOLETE_SOURCE_RECEIPT")
            if identity["input_id"] == state["input"]["input_id"]:
                local = json.loads((output / "launch/latest.json").read_bytes())
                if read_remote() != state["pointer"] or local != state["pointer"]:
                    raise ValueError("REMOTE_LAUNCH_CONFLICT")
                return {
                    "ok": True,
                    "published": False,
                    "notified": False,
                    "reason": "UNCHANGED_INPUT",
                    "revision": local["revision"],
                }
        artifact = build_launch_artifact(
            payload, tle, now, fetched_at=_parse_iso8601_z(identity["fetched_at"])
        )
        intent = {"remote": remote, "input": identity, "artifact": artifact}
        _atomic_json(intent_path, intent)
        state = finish(intent)
        return {
            "ok": True,
            "published": True,
            "notified": False,
            "reason": "PUBLISHED",
            "revision": state["pointer"]["revision"],
            "items": len(artifact["items"]),
            "fetched_at": artifact["coverage"]["fetched_at"],
            "coverage_complete": artifact["coverage"]["complete"],
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument(
        "--scheduled",
        action="store_true",
        help="Cache-receipt deduplication and verified remote ownership",
    )
    parser.add_argument("--remote", default="r2:map-astroanil-dev")
    args = parser.parse_args(argv)
    now = datetime.now(UTC)
    started = time.monotonic()

    def report(value: dict) -> None:
        print(
            json.dumps(
                {
                    "checked_at": now.isoformat(),
                    "elapsed_seconds": round(time.monotonic() - started, 3),
                    **value,
                }
            )
        )

    try:
        if args.scheduled:
            if not args.publish:
                raise ValueError("SCHEDULED_REQUIRES_PUBLISH")
            report(
                refresh_cached(
                    args.cache_dir,
                    args.output,
                    now,
                    remote=args.remote,
                    upload=rclone_uploader(args.remote),
                    read_remote=rclone_reader(args.remote),
                )
            )
            return 0
        artifact = read_cached_artifact(args.cache_dir, datetime.now(UTC))
        pointer = publish_launch_artifact(
            artifact, args.output, upload=rclone_uploader(args.remote) if args.publish else None
        )
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        report({"ok": False, "reason": str(exc), "notified": False})
        return 2
    print(
        json.dumps(
            {
                "ok": True,
                "published": args.publish,
                "notified": False,
                "revision": pointer["revision"],
                "items": len(artifact["items"]),
                "coverage_complete": artifact["coverage"]["complete"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
