"""Atomic publish: versioned subfolder + manifest.json pointer.

Frontend reads manifest.json first, then loads every artifact from the version-tagged
path inside. Mixed-version reads are impossible by construction.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


def utcnow_iso(now: datetime | None = None) -> str:
    """ISO 8601 with Z suffix. Always UTC."""
    dt = now if now is not None else datetime.now().astimezone()
    if dt.tzinfo is None or dt.tzinfo.utcoffset(dt) != timedelta(0):
        raise ValueError("now must be UTC-aware (use datetime.now(tz=timezone.utc))")
    return dt.isoformat().replace("+00:00", "Z")


def version_id(now: datetime) -> str:
    """Tick timestamp slug: 20260502T223000Z (compact, sortable, URL-safe)."""
    return now.strftime("%Y%m%dT%H%M%SZ")


def hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_manifest(
    out_dir: Path,
    version: str,
    generated_at: datetime,
    tle_epoch: datetime,
    cloud_composite_hour: datetime,
    target_data_version: str,
    build_version: str,
    artifacts: dict[str, Path],
    extra: dict[str, Any] | None = None,
) -> Path:
    """Write manifest.json (top-level, atomic-swap pointer) describing this version's artifacts.

    Each entry in `artifacts` is {logical_name: absolute_path_within_out_dir}.
    Returns path to the written manifest.json.
    """
    if (
        generated_at.tzinfo is None
        or tle_epoch.tzinfo is None
        or cloud_composite_hour.tzinfo is None
    ):
        raise ValueError("all timestamps must be UTC-aware")

    out_dir.mkdir(parents=True, exist_ok=True)

    artifact_block: dict[str, dict[str, Any]] = {}
    for name, path in artifacts.items():
        if not path.exists():
            raise FileNotFoundError(f"artifact {name!r} not found at {path}")
        rel = path.relative_to(out_dir)
        artifact_block[name] = {
            "path": str(rel).replace("\\", "/"),
            "sha256": hash_file(path),
            "bytes": path.stat().st_size,
        }

    freshness = {
        "tle_hours": (generated_at - tle_epoch).total_seconds() / 3600.0,
        "cloud_hours": (generated_at - cloud_composite_hour).total_seconds() / 3600.0,
        "ok": True,  # adjusted below
    }
    freshness["ok"] = freshness["tle_hours"] < 36 and freshness["cloud_hours"] < 2

    manifest = {
        "version": version,
        "generated_at": utcnow_iso(generated_at),
        "tle_epoch": utcnow_iso(tle_epoch),
        "cloud_composite_hour": utcnow_iso(cloud_composite_hour),
        "target_data_version": target_data_version,
        "build_version": build_version,
        "freshness": freshness,
        "artifacts": artifact_block,
    }
    if extra:
        manifest["extra"] = extra

    manifest_path = out_dir / "manifest.json"
    tmp_path = manifest_path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    tmp_path.replace(manifest_path)
    return manifest_path


def _current_published_version(out_dir: Path) -> str | None:
    """Return the version name referenced by the current manifest.json, if any.

    Used by cleanup to AVOID deleting the version that is still being served.
    """
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.exists():
        return None
    try:
        data = json.loads(manifest_path.read_text())
        return data.get("version")
    except (json.JSONDecodeError, OSError):
        return None


def cleanup_old_versions(out_dir: Path, keep_minutes: int = 60) -> list[Path]:
    """Delete versioned subfolders older than `keep_minutes`. Returns deleted paths.

    SAFETY: never deletes the version that the current `manifest.json` points at,
    even if that version's mtime is past the cutoff. If the daemon stalls and the
    only published version goes "old," cleanup leaves it in place so readers don't
    hit 404s on every artifact between manifest fetches.
    """
    versions_dir = out_dir / "v"
    if not versions_dir.exists():
        return []

    published = _current_published_version(out_dir)
    deleted: list[Path] = []
    cutoff_ts = datetime.now().timestamp() - keep_minutes * 60
    for entry in versions_dir.iterdir():
        if not entry.is_dir():
            continue
        if entry.name == published:
            continue
        if entry.stat().st_mtime < cutoff_ts:
            shutil.rmtree(entry)
            deleted.append(entry)
    return deleted
