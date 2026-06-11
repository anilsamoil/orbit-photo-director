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
    profile_artifacts: dict[str, dict[str, Path]] | None = None,
    forecast_clouds: dict[str, Any] | None = None,
) -> Path:
    """Write manifest.json (top-level, atomic-swap pointer) describing this version's artifacts.

    Each entry in `artifacts` is {logical_name: absolute_path_within_out_dir}.

    `profile_artifacts` (Slot 4 — design rev 2): {profile_name: {logical_name: path}}.
    When non-empty, the manifest gains an `artifacts.profiles` block keyed by
    profile name, each holding the same shape as the top-level artifact map
    (path / sha256 / bytes). Frontend slot 5 reads this to fetch the right
    per-astronaut variant. Empty / missing → legacy single-tenant manifest
    (no `profiles` block at all), which keeps pre-v1.6.7 frontends working.

    Returns path to the written manifest.json.
    """
    if (
        generated_at.tzinfo is None
        or tle_epoch.tzinfo is None
        or cloud_composite_hour.tzinfo is None
    ):
        raise ValueError("all timestamps must be UTC-aware")

    out_dir.mkdir(parents=True, exist_ok=True)

    artifact_block: dict[str, Any] = {}
    for name, path in artifacts.items():
        if not path.exists():
            raise FileNotFoundError(f"artifact {name!r} not found at {path}")
        rel = path.relative_to(out_dir)
        artifact_block[name] = {
            "path": str(rel).replace("\\", "/"),
            "sha256": hash_file(path),
            "bytes": path.stat().st_size,
        }

    # Slot 4: per-profile artifact pointers under artifacts.profiles. Each
    # profile contributes the same logical names (passes/top5/top_24h/status)
    # at distinct paths (passes_<name>.json etc.). Track + targets are
    # profile-agnostic and stay only at the top level.
    if profile_artifacts:
        profiles_block: dict[str, dict[str, Any]] = {}
        for name, paths in profile_artifacts.items():
            per_profile: dict[str, Any] = {}
            for logical_name, path in paths.items():
                if not path.exists():
                    raise FileNotFoundError(
                        f"profile {name!r} artifact {logical_name!r} not found at {path}"
                    )
                rel = path.relative_to(out_dir)
                per_profile[logical_name] = {
                    "path": str(rel).replace("\\", "/"),
                    "sha256": hash_file(path),
                    "bytes": path.stat().st_size,
                }
            profiles_block[name] = per_profile
        artifact_block["profiles"] = profiles_block

    freshness = {
        "tle_hours": (generated_at - tle_epoch).total_seconds() / 3600.0,
        "cloud_hours": (generated_at - cloud_composite_hour).total_seconds() / 3600.0,
        "ok": True,  # adjusted below
    }
    # Thresholds: TLE accuracy degrades fast (36h). GIBS daily MODIS data is
    # naturally 24-48h old by design (we use yesterday's product to ensure it's
    # fully published); allow up to 48h. SatCORPS hourly will be much fresher
    # when wired up; the threshold tolerates either source.
    freshness["ok"] = freshness["tle_hours"] < 36 and freshness["cloud_hours"] < 48

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
    # V4-P2: TOP-LEVEL key — the frontend reads manifest.forecast_clouds
    # directly (caught by the ship-time run_tick wiring test 2026-06-10:
    # routing this through `extra` nested it under manifest.extra and
    # silently broke the generator↔frontend contract).
    if forecast_clouds:
        manifest["forecast_clouds"] = forecast_clouds

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
