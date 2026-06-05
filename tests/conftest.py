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
    """Tests force the mock cloud sampler so they don't hit the real GIBS API.

    Two distinct cloud code paths reach the network and both must be neutered:

    1. Observed cloud (GIBS) — gated by OPD_CLOUD_SOURCE, set to "mock" here.
    2. Forecast cloud (GFS via Open-Meteo) — a SEPARATE path that ignores
       OPD_CLOUD_SOURCE and does a live requests.get to api.open-meteo.com
       whenever GFSForecastSampler is built without a fetcher (run_tick does
       exactly this). A transient open-meteo timeout made run_tick
       non-deterministic: the canonical pass-set would get a "no-data" cloud
       attribution while the per-profile pass-set re-fetched the same coords,
       succeeded, and got "out-of-horizon" — breaking byte-equality assertions
       like `jack == canonical`. Inject an offline fetcher on the default
       (no-fetcher) path so run_tick tests are hermetic and deterministic.
       Tests that pass an explicit fetcher (test_cloud.py, test_lightning.py)
       are untouched — only the live-network default is replaced.
    """
    monkeypatch.setenv("OPD_CLOUD_SOURCE", "mock")

    from generator import cloud as _cloud

    _orig_init = _cloud.GFSForecastSampler.__init__

    def _offline_init(
        self: object,
        targets: list[tuple[float, float]],
        forecast_days: int = 2,
        fetcher: object | None = None,
        include_cape: bool = False,
    ) -> None:
        if fetcher is None:
            def fetcher(_url: str) -> object:  # noqa: ANN401
                raise RuntimeError(
                    "open-meteo is disabled in tests; pass an explicit "
                    "fetcher= to exercise GFSForecastSampler against canned data"
                )
        _orig_init(
            self, targets, forecast_days=forecast_days,
            fetcher=fetcher, include_cape=include_cape,
        )

    monkeypatch.setattr(_cloud.GFSForecastSampler, "__init__", _offline_init)

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
