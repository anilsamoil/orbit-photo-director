"""Integration tests for generator.main.run_tick."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

from generator.config import Settings
from generator.main import (
    TLE_HARD_FAIL_HOURS,
    CombinedCloudSampler,
    fetch_tle,
    main,
    run_tick,
    score_pass_for_target,
    select_cloud_sampler,
)
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
    # Polynomial covers 120 min so the frontend's +90 min lookahead has data.
    # Order 11 → 12 coefficients (see _polynomial_order_for_window).
    assert len(poly["lat_coeffs"]) == 12
    assert len(poly["lon_coeffs"]) == 12
    assert poly["start"].endswith("Z")
    assert poly["polynomial_order"] == 11
    assert poly["duration_seconds"] == 120 * 60


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


def test_run_tick_lock_blocks_concurrent_tick(
    settings_in_tmp: Settings, cached_tle: Path
) -> None:
    """A second run_tick while the first holds the lock raises RuntimeError.

    Simulated by holding the flock manually before calling run_tick. The
    second call should fail fast (LOCK_NB) rather than block or silently
    corrupt out/.
    """
    import fcntl
    settings_in_tmp.out_dir.mkdir(parents=True, exist_ok=True)
    lock_path = settings_in_tmp.out_dir / ".tick.lock"
    holder = open(lock_path, "w")
    try:
        fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
        with pytest.raises(RuntimeError, match="another tick is already running"):
            run_tick(settings_in_tmp, now=now)
    finally:
        fcntl.flock(holder.fileno(), fcntl.LOCK_UN)
        holder.close()


def test_run_tick_lock_releases_on_normal_completion(
    settings_in_tmp: Settings, cached_tle: Path
) -> None:
    """After run_tick returns, the lock is released so the next tick can proceed."""
    targets = [{
        "id": "tokyo",
        "name": "Tokyo",
        "geom": {"type": "point", "lat": 35.7, "lon": 139.7},
        "priority": 5,
        "regime": "any",
    }]
    settings_in_tmp.targets_file.write_text(json.dumps(targets))
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    run_tick(settings_in_tmp, now=now)
    # Second call should succeed too, with the same lock file in place.
    run_tick(settings_in_tmp, now=now + timedelta(seconds=1))


# --------------------------------------------------------------------------
# fetch_tle — direct tests of the network/cache logic
# --------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, text: str, status: int = 200) -> None:
        self.text = text
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def test_fetch_tle_uses_fresh_cache(tmp_path: Path) -> None:
    """Cache age below TTL → return cached, no network call."""
    cache = tmp_path / "iss.tle"
    cache.write_text(SAMPLE_TLE_TEXT)
    now = datetime.fromtimestamp(cache.stat().st_mtime + 60, tz=UTC)  # 1 min old
    with patch("generator.main.requests.get") as mock_get:
        tle = fetch_tle("http://example.invalid", cache, ttl_hours=1.0, now=now)
    assert tle is not None
    mock_get.assert_not_called()


def test_fetch_tle_fetches_when_cache_stale(tmp_path: Path) -> None:
    """Cache older than TTL → network fetch + write new cache."""
    cache = tmp_path / "iss.tle"
    cache.write_text(SAMPLE_TLE_TEXT)
    # Force cache to be stale
    old_mtime = time.time() - 7200  # 2 hours old
    import os as _os
    _os.utime(cache, (old_mtime, old_mtime))

    new_text = SAMPLE_TLE_TEXT  # same content; just exercises the fetch path
    with patch("generator.main.requests.get", return_value=_FakeResponse(new_text)):
        tle = fetch_tle("http://example.invalid", cache, ttl_hours=1.0)
    assert tle is not None


def test_fetch_tle_falls_back_to_cache_on_network_error(tmp_path: Path) -> None:
    """Network fails but cache present → return cached TLE (don't crash)."""
    cache = tmp_path / "iss.tle"
    cache.write_text(SAMPLE_TLE_TEXT)
    old_mtime = time.time() - 7200
    import os as _os
    _os.utime(cache, (old_mtime, old_mtime))

    with patch("generator.main.requests.get", side_effect=RuntimeError("offline")):
        tle = fetch_tle("http://example.invalid", cache, ttl_hours=1.0)
    assert tle is not None


def test_fetch_tle_no_cache_no_network_raises(tmp_path: Path) -> None:
    cache = tmp_path / "iss.tle"
    with patch("generator.main.requests.get", side_effect=RuntimeError("offline")):
        with pytest.raises(RuntimeError, match="TLE fetch failed"):
            fetch_tle("http://example.invalid", cache, ttl_hours=1.0)


def test_fetch_tle_logs_reboost_when_mean_motion_jumps(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A new TLE with a meaningfully different mean motion logs the reboost path."""
    cache = tmp_path / "iss.tle"
    # Old TLE (current sample). Force it stale so we re-fetch.
    cache.write_text(SAMPLE_TLE_TEXT)
    old_mtime = time.time() - 7200
    import os as _os
    _os.utime(cache, (old_mtime, old_mtime))

    # Reboost = altitude raised = period lengthens = mean motion DECREASES.
    # Old TLE has 15.4981; drop it to 15.4900 to trigger detect_reboost.
    bumped_tle = (
        "ISS (ZARYA)\n"
        "1 25544U 98067A   24291.79041667  .00031560  00000-0  56270-3 0  9998\n"
        "2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.49000000479596\n"
    )
    import logging
    with (
        caplog.at_level(logging.WARNING, logger="generator.main"),
        patch("generator.main.requests.get", return_value=_FakeResponse(bumped_tle)),
    ):
        fetch_tle("http://example.invalid", cache, ttl_hours=1.0)
    # Reboost detection logs a warning
    assert any("reboost" in r.message.lower() for r in caplog.records)


# --------------------------------------------------------------------------
# select_cloud_sampler — picks the right sampler based on availability
# --------------------------------------------------------------------------


def test_select_cloud_sampler_honors_mock_env(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPD_CLOUD_SOURCE", "mock")
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    sampler, composite_hour, label = select_cloud_sampler(settings_in_tmp, now)
    assert label == "mock"
    assert composite_hour == now.replace(minute=0, second=0, microsecond=0)


def test_select_cloud_sampler_falls_back_to_mock_when_all_real_fail(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No SatCORPS cache + every real-source constructor blows up → mock fallback."""
    monkeypatch.delenv("OPD_CLOUD_SOURCE", raising=False)

    def boom(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise RuntimeError("network down")

    with (
        patch("generator.main.GIBSCloudSampler", side_effect=boom),
        patch("generator.main.GeostationaryIRSampler", side_effect=boom),
        patch("generator.main.MeteosatEUMETSATSampler", side_effect=boom),
        patch("generator.main.HimawariNICTSampler", side_effect=boom),
    ):
        now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
        _, _, label = select_cloud_sampler(settings_in_tmp, now)
    assert label == "mock"


def test_select_cloud_sampler_combined_when_modis_and_geoir_succeed(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPD_CLOUD_SOURCE", raising=False)

    class _StubSampler:
        def __init__(self, *args, **kwargs) -> None: ...
        def sample(self, *args, **kwargs):  # pragma: no cover
            from generator.cloud import CloudSample
            return CloudSample(50.0, datetime.now(tz=UTC), "stub")

    def boom(*args, **kwargs):
        raise RuntimeError("not this tier")

    with (
        patch("generator.main.GIBSCloudSampler", _StubSampler),
        patch("generator.main.GeostationaryIRSampler", _StubSampler),
        patch("generator.main.MeteosatEUMETSATSampler", side_effect=boom),
        patch("generator.main.HimawariNICTSampler", side_effect=boom),
    ):
        now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
        _, _, label = select_cloud_sampler(settings_in_tmp, now)
    assert "combined" in label
    assert "modis" in label
    assert "geoir" in label


def test_select_cloud_sampler_geoir_only(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPD_CLOUD_SOURCE", raising=False)

    class _StubSampler:
        def __init__(self, *args, **kwargs) -> None: ...

    with (
        patch("generator.main.GIBSCloudSampler", side_effect=RuntimeError("modis down")),
        patch("generator.main.GeostationaryIRSampler", _StubSampler),
        patch("generator.main.MeteosatEUMETSATSampler", side_effect=RuntimeError("nope")),
        patch("generator.main.HimawariNICTSampler", side_effect=RuntimeError("nope")),
    ):
        now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
        _, _, label = select_cloud_sampler(settings_in_tmp, now)
    assert label == "geo-ir"


def test_select_cloud_sampler_modis_only(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPD_CLOUD_SOURCE", raising=False)

    class _StubSampler:
        def __init__(self, *args, **kwargs) -> None: ...

    with (
        patch("generator.main.GIBSCloudSampler", _StubSampler),
        patch("generator.main.GeostationaryIRSampler", side_effect=RuntimeError("gone")),
        patch("generator.main.MeteosatEUMETSATSampler", side_effect=RuntimeError("nope")),
        patch("generator.main.HimawariNICTSampler", side_effect=RuntimeError("nope")),
    ):
        now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
        _, composite_hour, label = select_cloud_sampler(settings_in_tmp, now)
    assert label == "gibs"
    # MODIS-only path uses yesterday's composite (different from the now-rounded path)
    assert composite_hour < now


# --------------------------------------------------------------------------
# CombinedCloudSampler — tier cascade logic
# --------------------------------------------------------------------------


class _FakeSampler:
    def __init__(self, source: str, cf: float = 25.0) -> None:
        self._source = source
        self._cf = cf

    def sample(self, lat: float, lon: float, when: datetime):
        from generator.cloud import CloudSample
        return CloudSample(self._cf, when, self._source)


def test_combined_cloud_sampler_returns_modis_when_present() -> None:
    modis = _FakeSampler("gibs", cf=10.0)
    geo = _FakeSampler("geo-ir-east", cf=80.0)
    combined = CombinedCloudSampler(modis, geo)  # type: ignore[arg-type]
    s = combined.sample(0.0, 0.0, datetime.now(tz=UTC))
    assert s.source == "gibs"
    assert s.cloud_fraction == 10.0


def test_combined_cloud_sampler_falls_through_to_geoir() -> None:
    modis = _FakeSampler("gibs-no-coverage")
    geo = _FakeSampler("geo-ir-east", cf=40.0)
    combined = CombinedCloudSampler(modis, geo)  # type: ignore[arg-type]
    s = combined.sample(0.0, 0.0, datetime.now(tz=UTC))
    assert s.source == "geo-ir-east"


def test_combined_cloud_sampler_falls_through_to_meteosat() -> None:
    modis = _FakeSampler("gibs-no-coverage")
    geo = _FakeSampler("geo-ir-east-nodata")
    meteosat = _FakeSampler("meteosat-ir108", cf=30.0)
    combined = CombinedCloudSampler(modis, geo, meteosat=meteosat)  # type: ignore[arg-type]
    s = combined.sample(0.0, 0.0, datetime.now(tz=UTC))
    assert s.source == "meteosat-ir108"


def test_combined_cloud_sampler_falls_through_to_himawari() -> None:
    modis = _FakeSampler("gibs-no-coverage")
    geo = _FakeSampler("geo-ir-east-no-coverage")
    meteosat = _FakeSampler("meteosat-no-coverage")
    himawari = _FakeSampler("himawari-nict", cf=20.0)
    combined = CombinedCloudSampler(  # type: ignore[arg-type]
        modis, geo, meteosat=meteosat, himawari=himawari,
    )
    s = combined.sample(0.0, 0.0, datetime.now(tz=UTC))
    assert s.source == "himawari-nict"


def test_combined_cloud_sampler_global_no_coverage_fallback() -> None:
    """All four tiers miss → cf=50 with combined-no-coverage source."""
    modis = _FakeSampler("gibs-no-coverage")
    geo = _FakeSampler("geo-ir-east-no-coverage")
    meteosat = _FakeSampler("meteosat-off-disk")
    himawari = _FakeSampler("himawari-night")
    combined = CombinedCloudSampler(  # type: ignore[arg-type]
        modis, geo, meteosat=meteosat, himawari=himawari,
    )
    s = combined.sample(0.0, 0.0, datetime.now(tz=UTC))
    assert s.source == "combined-no-coverage"
    assert s.cloud_fraction == 50.0


# --------------------------------------------------------------------------
# main() CLI entry point
# --------------------------------------------------------------------------


def test_main_returns_zero_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    """main() returns 0 when run_tick succeeds."""
    monkeypatch.setattr("generator.main.run_tick", lambda settings: {})
    monkeypatch.setattr("generator.main.Settings.from_env", classmethod(
        lambda cls: Settings(
            repo_root=Path("/tmp"),
            out_dir=Path("/tmp/out"),
            cache_dir=Path("/tmp/cache"),
            log_dir=Path("/tmp/log"),
            targets_file=Path("/tmp/targets.json"),
            tle_url="http://example.invalid",
            satcorps_creds_file=Path("/tmp/creds.json"),
            rclone_remote="r2:bucket",
            tick_minutes=30,
            pass_window_hours=6,
        )
    ))
    assert main() == 0


def test_main_returns_one_on_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    """main() returns 1 when run_tick raises (so launchd treats as failure)."""
    def boom(settings):  # type: ignore[no-untyped-def]
        raise RuntimeError("tick exploded")
    monkeypatch.setattr("generator.main.run_tick", boom)
    monkeypatch.setattr("generator.main.Settings.from_env", classmethod(
        lambda cls: Settings(
            repo_root=Path("/tmp"),
            out_dir=Path("/tmp/out"),
            cache_dir=Path("/tmp/cache"),
            log_dir=Path("/tmp/log"),
            targets_file=Path("/tmp/targets.json"),
            tle_url="http://example.invalid",
            satcorps_creds_file=Path("/tmp/creds.json"),
            rclone_remote="r2:bucket",
            tick_minutes=30,
            pass_window_hours=6,
        )
    ))
    assert main() == 1


# --------------------------------------------------------------------------
# TLE hard-fail age threshold
# --------------------------------------------------------------------------


def test_run_tick_raises_when_tle_age_exceeds_hard_fail(
    settings_in_tmp: Settings, tmp_path: Path
) -> None:
    """TLE older than TLE_HARD_FAIL_HOURS → tick refuses to publish stale shots."""
    cache = settings_in_tmp.cache_dir / "iss.tle"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(SAMPLE_TLE_TEXT)
    # Sample TLE epoch is 2024-10-16; pick a now so age > TLE_HARD_FAIL_HOURS (96h).
    now = datetime(2024, 10, 16, 19, 0, tzinfo=UTC) + timedelta(
        hours=TLE_HARD_FAIL_HOURS + 5
    )
    with pytest.raises(RuntimeError, match="hard-fail threshold"):
        run_tick(settings_in_tmp, now=now)
