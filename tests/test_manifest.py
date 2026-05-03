"""Tests for generator.manifest."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest

from generator.manifest import (
    cleanup_old_versions,
    hash_file,
    utcnow_iso,
    version_id,
    write_manifest,
)

# --------------------------------------------------------------------------
# utcnow_iso
# --------------------------------------------------------------------------


def test_utcnow_iso_rejects_naive() -> None:
    with pytest.raises(ValueError):
        utcnow_iso(datetime(2024, 10, 17))


def test_utcnow_iso_rejects_non_utc() -> None:
    eastern = timezone(timedelta(hours=-5))
    with pytest.raises(ValueError):
        utcnow_iso(datetime(2024, 10, 17, tzinfo=eastern))


def test_utcnow_iso_emits_z_suffix() -> None:
    s = utcnow_iso(datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC))
    assert s.endswith("Z")
    assert "+00:00" not in s


# --------------------------------------------------------------------------
# version_id
# --------------------------------------------------------------------------


def test_version_id_compact_format() -> None:
    when = datetime(2024, 10, 17, 22, 30, 5, tzinfo=UTC)
    assert version_id(when) == "20241017T223005Z"


def test_version_id_lexicographically_sortable() -> None:
    earlier = version_id(datetime(2024, 1, 1, 0, 0, 0, tzinfo=UTC))
    later = version_id(datetime(2024, 12, 31, 23, 59, 59, tzinfo=UTC))
    assert earlier < later


# --------------------------------------------------------------------------
# hash_file
# --------------------------------------------------------------------------


def test_hash_file_deterministic(tmp_path: Path) -> None:
    f = tmp_path / "x.txt"
    f.write_text("hello world")
    h1 = hash_file(f)
    h2 = hash_file(f)
    assert h1 == h2
    assert len(h1) == 64  # sha256 hex


def test_hash_file_changes_on_content_change(tmp_path: Path) -> None:
    f = tmp_path / "x.txt"
    f.write_text("v1")
    h1 = hash_file(f)
    f.write_text("v2")
    h2 = hash_file(f)
    assert h1 != h2


# --------------------------------------------------------------------------
# write_manifest
# --------------------------------------------------------------------------


def _make_artifact(out_dir: Path, version: str, name: str, content: str) -> Path:
    path = out_dir / "v" / version / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


def test_write_manifest_creates_top_level_pointer(tmp_path: Path) -> None:
    out = tmp_path / "out"
    v = "20241017T223000Z"
    artifact = _make_artifact(out, v, "passes.json", "[]")
    now = datetime(2024, 10, 17, 22, 30, 0, tzinfo=UTC)
    epoch = now - timedelta(hours=12)
    cloud_h = now.replace(minute=0, second=0)

    manifest_path = write_manifest(
        out_dir=out,
        version=v,
        generated_at=now,
        tle_epoch=epoch,
        cloud_composite_hour=cloud_h,
        target_data_version="v1",
        build_version="0.1.0",
        artifacts={"passes": artifact},
    )
    assert manifest_path == out / "manifest.json"
    data = json.loads(manifest_path.read_text())
    assert data["version"] == v
    assert data["generated_at"].endswith("Z")
    assert data["tle_epoch"].endswith("Z")
    assert data["artifacts"]["passes"]["path"] == f"v/{v}/passes.json"
    assert data["artifacts"]["passes"]["sha256"]


def test_write_manifest_freshness_ok_within_thresholds(tmp_path: Path) -> None:
    out = tmp_path / "out"
    v = "20241017T223000Z"
    artifact = _make_artifact(out, v, "passes.json", "[]")
    now = datetime(2024, 10, 17, 22, 30, 0, tzinfo=UTC)
    write_manifest(
        out_dir=out, version=v, generated_at=now,
        tle_epoch=now - timedelta(hours=10),
        cloud_composite_hour=now - timedelta(minutes=30),
        target_data_version="v1", build_version="0.1.0",
        artifacts={"passes": artifact},
    )
    data = json.loads((out / "manifest.json").read_text())
    assert data["freshness"]["ok"] is True


def test_write_manifest_freshness_not_ok_when_tle_too_old(tmp_path: Path) -> None:
    out = tmp_path / "out"
    v = "20241017T223000Z"
    artifact = _make_artifact(out, v, "passes.json", "[]")
    now = datetime(2024, 10, 17, 22, 30, 0, tzinfo=UTC)
    write_manifest(
        out_dir=out, version=v, generated_at=now,
        tle_epoch=now - timedelta(hours=48),  # > 36h
        cloud_composite_hour=now,
        target_data_version="v1", build_version="0.1.0",
        artifacts={"passes": artifact},
    )
    data = json.loads((out / "manifest.json").read_text())
    assert data["freshness"]["ok"] is False


def test_write_manifest_atomic_replace(tmp_path: Path) -> None:
    """Manifest write uses tmp + rename so partial writes never expose torn manifests."""
    out = tmp_path / "out"
    v = "20241017T223000Z"
    artifact = _make_artifact(out, v, "passes.json", "[]")
    now = datetime(2024, 10, 17, 22, 30, 0, tzinfo=UTC)
    write_manifest(
        out_dir=out, version=v, generated_at=now,
        tle_epoch=now, cloud_composite_hour=now,
        target_data_version="v1", build_version="0.1.0",
        artifacts={"passes": artifact},
    )
    # No leftover .tmp
    assert not (out / "manifest.json.tmp").exists()


def test_write_manifest_rejects_naive_timestamps(tmp_path: Path) -> None:
    out = tmp_path / "out"
    v = "20241017T223000Z"
    artifact = _make_artifact(out, v, "passes.json", "[]")
    naive = datetime(2024, 10, 17)
    aware = datetime(2024, 10, 17, tzinfo=UTC)
    with pytest.raises(ValueError):
        write_manifest(
            out_dir=out, version=v, generated_at=naive,
            tle_epoch=aware, cloud_composite_hour=aware,
            target_data_version="v1", build_version="0.1.0",
            artifacts={"passes": artifact},
        )


def test_write_manifest_rejects_missing_artifact(tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir()
    now = datetime(2024, 10, 17, 22, 30, 0, tzinfo=UTC)
    with pytest.raises(FileNotFoundError):
        write_manifest(
            out_dir=out, version="v1", generated_at=now,
            tle_epoch=now, cloud_composite_hour=now,
            target_data_version="v1", build_version="0.1.0",
            artifacts={"missing": out / "nope.json"},
        )


# --------------------------------------------------------------------------
# cleanup_old_versions
# --------------------------------------------------------------------------


def test_cleanup_old_versions_returns_empty_when_no_versions(tmp_path: Path) -> None:
    deleted = cleanup_old_versions(tmp_path)
    assert deleted == []


def test_cleanup_old_versions_deletes_old(tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir()
    old = out / "v" / "old-version"
    old.mkdir(parents=True)
    (old / "passes.json").write_text("[]")
    # set mtime to 2 hours ago
    old_ts = time.time() - 2 * 3600
    import os

    os.utime(old, (old_ts, old_ts))

    deleted = cleanup_old_versions(out, keep_minutes=60)
    assert len(deleted) == 1
    assert not old.exists()


def test_cleanup_old_versions_keeps_recent(tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir()
    recent = out / "v" / "recent-version"
    recent.mkdir(parents=True)
    (recent / "passes.json").write_text("[]")

    deleted = cleanup_old_versions(out, keep_minutes=60)
    assert deleted == []
    assert recent.exists()
