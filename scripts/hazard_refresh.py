#!/usr/bin/env python3
"""Publish hazard schema 2 for the launches in the current catalog. Uploads only with --publish."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from generator.hazard_match import build_bundle, validate_bundle
from generator.hazard_sources import Fetch, http_fetch, refresh_sources, sightings_from_state
from generator.launch_data import _parse_iso8601_z
from generator.launch_evidence import canonical_bytes
from generator.launch_publish import _verified_catalog, _write_bytes_atomic, rclone_uploader

ARTIFACT = "hazards/v2/launches.json"
RUN_LOG = "hazards/v2/run.json"
PUBLICATION_RECEIPT = ".hazard-publication.json"


@dataclass(frozen=True)
class PublicationTarget:
    remote: str
    upload: Callable[[Path, str, bool], None]


@dataclass(frozen=True)
class PublicationReceipt:
    target_sha256: str
    revision: str


def _read_receipt(path: Path) -> PublicationReceipt | None:
    try:
        raw = json.loads(path.read_bytes())
        if (
            not isinstance(raw, dict)
            or set(raw) != {"schema_version", "target_sha256", "revision"}
            or type(raw["schema_version"]) is not int
            or raw["schema_version"] != 1
            or not isinstance(raw["target_sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", raw["target_sha256"])
            or not isinstance(raw["revision"], str)
            or not re.fullmatch(r"[a-f0-9]{16}", raw["revision"])
        ):
            return None
        return PublicationReceipt(raw["target_sha256"], raw["revision"])
    except (OSError, ValueError):
        return None


def _sync_directory(path: Path) -> None:
    directory = os.open(path, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _current_catalog(output: Path, now: datetime) -> dict:
    """The committed catalog, only while its schedule lease holds."""
    try:
        pointer = json.loads((output / "launch/catalog/latest.json").read_bytes())
        catalog = _verified_catalog(output, pointer)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise ValueError("CATALOG_UNAVAILABLE") from exc
    generated = _parse_iso8601_z(catalog["generated_at"])
    if not generated <= now < _parse_iso8601_z(catalog["schedule_valid_until"]):
        raise ValueError("CATALOG_EXPIRED")
    return catalog


def _overrides(path: Path | None) -> dict | None:
    if path is None:
        return None
    raw = json.loads(path.read_bytes())
    pins, bans = raw.get("pin", {}), raw.get("ban", [])
    if (
        raw.get("schema_version") != 1
        or not isinstance(pins, dict)
        or not isinstance(bans, list)
        or any(not isinstance(value, str) for value in [*pins, *pins.values(), *bans])
    ):
        raise ValueError("INVALID_OVERRIDES")
    return {"pin": pins, "ban": bans}


def refresh_hazards(
    cache: Path,
    output: Path,
    now: datetime,
    *,
    publication: PublicationTarget | None = None,
    fetch: Fetch = http_fetch,
    pause: Callable[[float], None] = time.sleep,
    overrides: Path | None = None,
) -> dict:
    """One locked run builds confirmed sources and records successful publication separately."""
    if "out" in output.resolve().parts:
        raise ValueError("launch output must be separate from Earth out/")
    output.mkdir(parents=True, exist_ok=True)
    with (output / ".hazard-refresh.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("HAZARD_REFRESH_BUSY") from exc
        catalog = _current_catalog(output, now)
        sources = refresh_sources(cache, now, fetch=fetch, pause=pause)
        bundle, log = build_bundle(
            catalog["items"], sightings_from_state(sources, now), now, _overrides(overrides)
        )
        target = output / ARTIFACT
        try:
            previous = json.loads(target.read_bytes())
            validate_bundle(previous)
            previous = canonical_bytes({k: v for k, v in previous.items() if k != "generated_at"})
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            previous = None
        changed = previous != canonical_bytes(
            {k: v for k, v in bundle.items() if k != "generated_at"}
        )
        if changed:
            _write_bytes_atomic(target, canonical_bytes(bundle))
        published = False
        if publication is not None:
            receipt_path = output / PUBLICATION_RECEIPT
            receipt = PublicationReceipt(
                hashlib.sha256(
                    f"{publication.remote.rstrip('/')}/{ARTIFACT}".encode()
                ).hexdigest(),
                bundle["revision"],
            )
            if _read_receipt(receipt_path) != receipt:
                receipt_path.unlink(missing_ok=True)
                _sync_directory(output)
                publication.upload(target, ARTIFACT, False)
                _write_bytes_atomic(
                    receipt_path, canonical_bytes({"schema_version": 1, **asdict(receipt)})
                )
                _sync_directory(output)
                published = True
        health = {
            name: {"checked_at": entry.get("checked_at"), "error": entry.get("error")}
            for name, entry in sources.items()
            if isinstance(entry, dict)
        }
        degraded = any(entry["error"] is not None for entry in health.values())
        _write_bytes_atomic(
            output / RUN_LOG,
            canonical_bytes(
                {
                    "generated_at": bundle["generated_at"],
                    "revision": bundle["revision"],
                    "catalog_revision": catalog["revision"],
                    "sources": health,
                    "decisions": log,
                }
            ),
        )
        return {
            "ok": not degraded,
            "degraded": degraded,
            "reason": "SOURCE_REFRESH_DEGRADED" if degraded else None,
            "published": published,
            "written": changed,
            "revision": bundle["revision"],
            "launches": len(bundle["launches"]),
            "sources": health,
            "undrawn": sorted(
                entry["notice_id"]
                for entry in log
                if entry["decision"] in ("unmatched", "ambiguous", "rejected")
            ),
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--overrides", type=Path)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--remote", default="r2:map-astroanil-dev")
    args = parser.parse_args(argv)
    now = datetime.now(UTC).replace(microsecond=0)
    try:
        report = refresh_hazards(
            args.cache_dir,
            args.output,
            now,
            publication=(
                PublicationTarget(args.remote, rclone_uploader(args.remote))
                if args.publish else None
            ),
            overrides=args.overrides,
        )
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        print(json.dumps({"ok": False, "reason": str(exc), "checked_at": now.isoformat()}))
        return 2
    print(json.dumps({"checked_at": now.isoformat(), **report}))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
