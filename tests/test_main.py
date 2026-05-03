"""Integration tests for generator.main.run_tick."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from generator.config import Settings
from generator.main import run_tick, score_pass_for_target
from generator.orbit import TLE, Pass, Position
from tests.conftest import SAMPLE_TLE_TEXT


@pytest.fixture
def cached_tle(settings_in_tmp: Settings) -> Path:
    """Pre-seed the TLE cache so run_tick doesn't need network."""
    settings_in_tmp.cache_dir.mkdir(parents=True, exist_ok=True)
    cache = settings_in_tmp.cache_dir / "iss.tle"
    cache.write_text(SAMPLE_TLE_TEXT)
    return cache


def test_run_tick_writes_manifest(settings_in_tmp: Settings, cached_tle: Path) -> None:
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    manifest = run_tick(settings_in_tmp, now=now)

    assert manifest["version"] == "20241017T120000Z"
    assert manifest["build_version"] == "0.1.0"
    assert manifest["generated_at"].endswith("Z")
    assert manifest["tle_epoch"].endswith("Z")
    assert "freshness" in manifest


def test_run_tick_creates_versioned_artifacts(settings_in_tmp: Settings, cached_tle: Path) -> None:
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    assert (v_dir / "passes.json").exists()
    assert (v_dir / "top5.json").exists()
    assert (v_dir / "track.json").exists()
    assert (v_dir / "status.json").exists()
    assert (v_dir / "targets.json").exists()


def test_run_tick_top5_passes_format(settings_in_tmp: Settings, cached_tle: Path) -> None:
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    top5 = json.loads((v_dir / "top5.json").read_text())
    assert isinstance(top5, list)
    assert len(top5) <= 5
    for p in top5:
        assert "target_id" in p
        assert "closest_approach" in p
        assert p["closest_approach"].endswith("Z")
        assert "score" in p
        assert 0.0 <= p["score"] <= 100.0
        assert "obstruction_class" in p
        assert p["obstruction_class"] in ("clear", "cloudy", "sun-glint risk")
        assert p["pass_regime"] in ("day", "night", "terminator")


def test_run_tick_status_includes_freshness(settings_in_tmp: Settings, cached_tle: Path) -> None:
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    status = json.loads((v_dir / "status.json").read_text())
    assert "tle_age_hours" in status
    assert "tle_freshness_factor" in status
    assert "cloud_source" in status
    assert status["target_count"] == 3  # from fixture
    assert status["cloud_source"] == "mock"  # no SatCORPS cache in fixture


def test_run_tick_uses_cached_tle_when_url_unreachable(
    settings_in_tmp: Settings, cached_tle: Path
) -> None:
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    # URL is unreachable (example.invalid). Cache exists. Should still succeed.
    manifest = run_tick(settings_in_tmp, now=now)
    assert manifest["version"] == "20241017T120000Z"


def test_run_tick_fails_when_no_tle_cache_and_no_network(
    settings_in_tmp: Settings, tmp_path: Path
) -> None:
    """No cached TLE + unreachable URL → tick raises."""
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    # Make sure cache is empty
    cache = settings_in_tmp.cache_dir / "iss.tle"
    if cache.exists():
        cache.unlink()
    with pytest.raises(RuntimeError, match="TLE fetch failed"):
        run_tick(settings_in_tmp, now=now)


def test_run_tick_track_includes_polynomial(settings_in_tmp: Settings, cached_tle: Path) -> None:
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    track = json.loads((v_dir / "track.json").read_text())
    poly = track["iss_polynomial"]
    assert len(poly["lat_coeffs"]) == 6
    assert len(poly["lon_coeffs"]) == 6
    assert poly["start"].endswith("Z")
    assert poly["polynomial_order"] == 5


def test_score_pass_for_target_handles_glint_path(sample_tle: TLE) -> None:
    """Smoke-test the per-pass scorer with a synthetic over-water pass."""
    from generator.cloud import MockCloudSampler

    when = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    target = {
        "id": "test",
        "name": "Test",
        "geom": {"type": "point", "lat": 0.0, "lon": 170.0},
        "priority": 4,
        "regime": "any",
    }
    pass_obj = Pass(
        target_id="test",
        target_lat=0.0,
        target_lon=170.0,
        closest_approach=when,
        nadir_distance_km=100.0,
        iss_position=Position(lat=0.5, lon=170.5, alt_km=410, when=when),
    )
    sampler = MockCloudSampler(default_cf=10.0)
    result = score_pass_for_target(target, pass_obj, sampler, tle_freshness=1.0)
    assert result["target_id"] == "test"
    assert result["pass_regime"] in ("day", "night", "terminator")
    assert result["closest_approach"].endswith("Z")
    assert result["nadir_distance_km"] == 100.0


def test_run_tick_skips_targets_with_no_passes(
    settings_in_tmp: Settings, cached_tle: Path, tmp_path: Path
) -> None:
    """A polar target produces zero passes; tick should still complete."""
    targets = [
        {
            "id": "polar-only",
            "name": "Polar",
            "geom": {"type": "point", "lat": 88.0, "lon": 0.0},
            "priority": 5,
            "regime": "any",
        },
    ]
    targets_file = settings_in_tmp.targets_file
    targets_file.write_text(json.dumps(targets))

    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    manifest = run_tick(settings_in_tmp, now=now)
    assert manifest["version"] == "20241017T120000Z"

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    top5 = json.loads((v_dir / "top5.json").read_text())
    assert top5 == []
