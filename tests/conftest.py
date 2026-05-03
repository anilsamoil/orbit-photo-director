"""Shared test fixtures."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from generator.config import Settings
from generator.orbit import TLE


@pytest.fixture(autouse=True)
def _force_mock_cloud(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests force the mock cloud sampler so they don't hit the real GIBS API."""
    monkeypatch.setenv("OPD_CLOUD_SOURCE", "mock")

# A real ISS TLE (epoch 2024-10-16). For tests we just need sgp4 to propagate
# and produce sane lat/lon. Accuracy versus real ISS is irrelevant here.
SAMPLE_TLE_TEXT = (
    "ISS (ZARYA)\n"
    "1 25544U 98067A   24290.79041667  .00031560  00000-0  56270-3 0  9990\n"
    "2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.49814196479596\n"
)


@pytest.fixture
def sample_tle() -> TLE:
    return TLE.from_text(SAMPLE_TLE_TEXT)


@pytest.fixture
def now_utc() -> datetime:
    """A fixed UTC datetime used across tests for deterministic results."""
    return datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)


@pytest.fixture
def repo_with_targets(tmp_path: Path) -> Path:
    """A pseudo-repo dir with a minimal valid targets.json."""
    targets = [
        {
            "id": "tokyo-night",
            "name": "Tokyo at night",
            "geom": {"type": "point", "lat": 35.68, "lon": 139.69},
            "priority": 5,
            "regime": "night",
        },
        {
            "id": "lake-baikal",
            "name": "Lake Baikal",
            "geom": {"type": "point", "lat": 53.5, "lon": 108.0},
            "priority": 3,
            "regime": "day",
        },
        {
            "id": "any-bigfeature",
            "name": "Versatile target",
            "geom": {"type": "point", "lat": 0.0, "lon": 0.0},
            "priority": 4,
            "regime": "any",
        },
    ]
    (tmp_path / "targets.json").write_text(json.dumps(targets))
    return tmp_path


@pytest.fixture
def settings_in_tmp(tmp_path: Path, repo_with_targets: Path) -> Settings:
    """Settings rooted at tmp_path with the small targets fixture."""
    return Settings(
        repo_root=tmp_path,
        out_dir=tmp_path / "out",
        cache_dir=tmp_path / "cache",
        log_dir=tmp_path / "logs",
        targets_file=repo_with_targets / "targets.json",
        tle_url="http://example.invalid/tle",  # never hit; test uses cache
        satcorps_creds_file=tmp_path / "creds.json",
        rclone_remote="r2:test-bucket",
        tick_minutes=30,
        pass_window_hours=6,
    )
