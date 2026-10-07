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

from generator.launch_catalog import build_launch_catalog
from generator.launch_data import _parse_iso8601_z, validate_feed
from generator.launch_evidence import build_launch_artifact, canonical_bytes, load_launch_cache
from generator.launch_publish import (
    _same_pointer,
    _validate_artifact,
    _validate_catalog,
    publish_launch_artifact,
    publish_launch_catalog,
    rclone_reader,
    rclone_uploader,
)
from generator.orbit import TLE

# Schedule refresh tolerance, NOT the 15-minute capture-evidence lifetime.
MAX_SCHEDULE_AGE_SECONDS = 3 * 3600


def _drop_expired_pending(output: Path, now: datetime) -> None:
    pending_path = output / "launch" / ".latest.pending.json"
    latest_path = output / "launch" / "latest.json"
    if not pending_path.is_file() or not latest_path.is_file():
        return
    pending = json.loads(pending_path.read_bytes())
    latest = json.loads(latest_path.read_bytes())
    if not isinstance(pending, dict) or _same_pointer(pending, latest):
        return
    valid_until = pending.get("valid_until")
    if not isinstance(valid_until, str) or _parse_iso8601_z(valid_until) > now:
        return
    pending_path.unlink()


def _schedule_fetched(artifact: dict) -> str:
    coverage = artifact["coverage"]
    if artifact.get("schema_version") == 3:
        stamp = coverage["schedule_fetched_at"]
    else:
        stamp = coverage["fetched_at"]
    if not isinstance(stamp, str):
        raise ValueError("SOURCE_AGE_UNKNOWN")
    return stamp


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
        # A model-policy change requires one fresh publication even when the
        # source receipt is unchanged. Retain ownership and prior receipts.
        "policy": 5,
        "schedule_sha256": receipt["sha256"],
        "fetched_at": receipt["fetched_at"],
        "tle_sha256": hashlib.sha256(tle_raw).hexdigest(),
    }
    identity["input_id"] = hashlib.sha256(canonical_bytes(identity)).hexdigest()
    return identity, payload, tle


def _prepare_catalog(
    payload: dict,
    tle: TLE | None,
    now: datetime,
    fetched_at: datetime,
    source_reasons: tuple[str, ...] = (),
) -> tuple[dict | None, str | None]:
    try:
        catalog = build_launch_catalog(
            payload, tle, now, fetched_at=fetched_at, source_reasons=source_reasons,
        )
        _validate_catalog(catalog)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        return None, str(exc)
    return catalog, None


def refresh_cached(
    cache: Path,
    output: Path,
    now: datetime,
    *,
    remote: str,
    upload: Callable,
    read_remote: Callable,
) -> dict:
    """v2 commits on its own. A catalog failure is logged and never blocks v2."""
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
        catalog_state_path = output / ".refresh-catalog-state.json"
        state = json.loads(state_path.read_bytes()) if state_path.exists() else {}
        intent = json.loads(intent_path.read_bytes()) if intent_path.exists() else None
        catalog_state = (
            json.loads(catalog_state_path.read_bytes()) if catalog_state_path.exists() else {}
        )
        if any(value and value["remote"] != remote for value in (state, intent, catalog_state)):
            raise ValueError("REMOTE_OWNER_MISMATCH")
        _drop_expired_pending(output, now)

        def finish_v2(value: dict) -> dict:
            artifact = value["artifact"]
            if artifact.get("schema_version") != 2:
                raise ValueError("LIVE_PUBLICATION_REQUIRES_SCHEMA_2")
            _validate_artifact(artifact)
            age = (now - _parse_iso8601_z(value["input"]["fetched_at"])).total_seconds()
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

        def ship_catalog(
            identity: dict,
            payload: dict,
            tle: TLE | None,
            fetched_at: datetime,
            prepared: dict | None = None,
            prepared_error: str | None = None,
        ) -> str | None:
            if catalog_state.get("input_id") == identity["input_id"]:
                return None
            if prepared_error:
                return prepared_error
            try:
                catalog = prepared
                if catalog is None:
                    catalog = build_launch_catalog(payload, tle, now, fetched_at=fetched_at)
                    _validate_catalog(catalog)
                publish_launch_catalog(catalog, output, upload=upload)
            except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
                return str(exc)
            _atomic_json(
                catalog_state_path,
                {
                    "remote": remote,
                    "input_id": identity["input_id"],
                    "revision": catalog["revision"],
                },
            )
            return None

        if (
            intent
            and (
                now - _parse_iso8601_z(_schedule_fetched(intent["artifact"]))
            ).total_seconds()
            >= MAX_SCHEDULE_AGE_SECONDS
        ):
            local = json.loads((output / "launch/latest.json").read_bytes())
            observed = read_remote()
            accepted = observed["revision"] != intent["artifact"]["revision"]
            if _same_pointer(observed, local) and accepted:
                intent_path.unlink()
                intent = None
        if intent and intent.get("artifact", {}).get("schema_version") != 2:
            intent_path.unlink()
            intent = None
        if intent and "catalog" in intent:
            intent = {key: value for key, value in intent.items() if key != "catalog"}
            _atomic_json(intent_path, intent)
        if intent:
            state = finish_v2(intent)
        identity, payload, tle = _cached_inputs(cache, now)
        fetched_at = _parse_iso8601_z(identity["fetched_at"])
        if state:
            if fetched_at < _parse_iso8601_z(state["input"]["fetched_at"]):
                raise ValueError("OBSOLETE_SOURCE_RECEIPT")
            if identity["input_id"] == state["input"]["input_id"]:
                pointer_path = output / "launch/latest.json"
                local = json.loads(pointer_path.read_bytes())
                observed = read_remote()
                if observed != state["pointer"] and not _same_pointer(observed, state["pointer"]):
                    raise ValueError("REMOTE_LAUNCH_CONFLICT")
                if local != observed:
                    _atomic_json(pointer_path, observed)
                skipped = ship_catalog(identity, payload, tle, fetched_at)
                result = {
                    "ok": True,
                    "published": False,
                    "notified": False,
                    "reason": "UNCHANGED_INPUT",
                    "revision": observed["revision"],
                }
                if skipped:
                    result["catalog_skipped"] = skipped
                return result
        artifact = build_launch_artifact(payload, tle, now, fetched_at=fetched_at)
        prepared_catalog, prepared_error = _prepare_catalog(payload, tle, now, fetched_at)
        _validate_artifact(artifact)
        intent = {"remote": remote, "input": identity, "artifact": artifact}
        _atomic_json(intent_path, intent)
        state = finish_v2(intent)
        skipped = ship_catalog(
            identity, payload, tle, fetched_at, prepared_catalog, prepared_error,
        )
        result = {
            "ok": True,
            "published": True,
            "notified": False,
            "reason": "PUBLISHED",
            "revision": state["pointer"]["revision"],
            "items": len(artifact["items"]),
            "fetched_at": _schedule_fetched(artifact),
            "coverage_complete": artifact["coverage"]["complete"],
        }
        if skipped:
            result["catalog_skipped"] = skipped
        elif catalog_state.get("input_id") != identity["input_id"]:
            published_catalog = json.loads(catalog_state_path.read_bytes())
            result["catalog_revision"] = published_catalog["revision"]
        return result


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
            uploader = rclone_uploader(args.remote)
            report(
                refresh_cached(
                    args.cache_dir,
                    args.output,
                    now,
                    remote=args.remote,
                    upload=uploader,
                    read_remote=rclone_reader(args.remote, local=args.output, upload=uploader),
                )
            )
            return 0
        payload, tle, fetched, source_reasons = load_launch_cache(args.cache_dir, now)
        artifact = build_launch_artifact(
            payload, tle, now, fetched_at=fetched, source_reasons=source_reasons,
        )
        catalog, catalog_error = _prepare_catalog(
            payload, tle, now, fetched, source_reasons,
        )
        _validate_artifact(artifact)
        upload = rclone_uploader(args.remote) if args.publish else None
        pointer = publish_launch_artifact(artifact, args.output, upload=upload)
        if catalog is not None:
            try:
                publish_launch_catalog(catalog, args.output, upload=upload)
            except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
                catalog_error = str(exc)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        report({"ok": False, "reason": str(exc), "notified": False})
        return 2
    printed = {
        "ok": True,
        "published": args.publish,
        "notified": False,
        "revision": pointer["revision"],
        "items": len(artifact["items"]),
        "coverage_complete": artifact["coverage"]["complete"],
    }
    if catalog_error:
        printed["catalog_skipped"] = catalog_error
    print(json.dumps(printed))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
