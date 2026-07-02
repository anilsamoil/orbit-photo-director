"""Tests for generator.fires — FIRMS wildfire sampler."""

from __future__ import annotations

import os
import time
from pathlib import Path

from generator.fires import (
    FIRE_MIN_SOLO_FRP_MW,
    FIRMSFireSampler,
    _parse_firms_csv,
)

HEADER = (
    "latitude,longitude,brightness,scan,track,acq_date,acq_time,"
    "satellite,confidence,version,bright_t31,frp,daynight\n"
)


def _row(lat: float, lon: float, conf: int, frp: float) -> str:
    return (
        f"{lat},{lon},330.0,1.0,1.0,2026-07-02,0011,T,{conf},6.1NRT,300.0,{frp},D\n"
    )


# --- CSV parsing -----------------------------------------------------------


def test_parse_filters_low_confidence_and_malformed() -> None:
    text = (
        HEADER
        + _row(10.0, 20.0, 85, 50.0)      # keep
        + _row(11.0, 21.0, 30, 500.0)     # low confidence -> drop
        + "not,a,valid,row\n"             # malformed -> drop
        + _row(999.0, 20.0, 90, 50.0)     # out-of-range lat -> drop
        + _row(-35.5, 149.1, 60, 12.0)    # keep (confidence == threshold)
    )
    rows = _parse_firms_csv(text)
    assert len(rows) == 2
    assert rows[0] == (10.0, 20.0, 50.0)


def test_parse_garbage_returns_empty() -> None:
    assert _parse_firms_csv("<html>error page</html>") == []
    assert _parse_firms_csv("") == []


# --- sampler + thresholds --------------------------------------------------


def _sampler_with(text: str, tmp_path: Path) -> FIRMSFireSampler:
    return FIRMSFireSampler(
        cache_path=tmp_path / "firms.csv", fetcher=lambda _url: text
    )


def test_cluster_above_threshold_tags(tmp_path: Path) -> None:
    # 3 confident detections all within ~20 km of (40, -120).
    text = (
        HEADER
        + _row(40.0, -120.0, 90, 80.0)
        + _row(40.1, -120.1, 80, 120.0)
        + _row(39.95, -119.9, 75, 60.0)
    )
    s = _sampler_with(text, tmp_path)
    activity = s.lookup(40.0, -120.0)
    assert activity is not None
    assert activity.count == 3
    assert activity.max_frp_mw == 120.0
    assert activity.nearest_km < 20


def test_small_cool_fire_is_filtered(tmp_path: Path) -> None:
    """1-2 detections below the solo-FRP bar must NOT tag (anti-busy rule)."""
    text = HEADER + _row(40.0, -120.0, 90, 50.0) + _row(40.05, -120.0, 90, 80.0)
    s = _sampler_with(text, tmp_path)
    assert s.lookup(40.0, -120.0) is None


def test_cool_cluster_is_filtered(tmp_path: Path) -> None:
    """Live-data calibration (2026-07-02 first deploy): 3+ WEAK detections —
    'Chicago IL: 3 fires, max 20.6 MW' urban heat noise — must NOT tag.
    A cluster needs a genuinely hot front (>= 50 MW) to be photographable."""
    text = (
        HEADER
        + _row(41.85, -87.65, 90, 20.6)
        + _row(41.90, -87.70, 85, 12.0)
        + _row(41.80, -87.60, 80, 8.5)
        + _row(41.88, -87.55, 75, 15.0)
    )
    s = _sampler_with(text, tmp_path)
    assert s.lookup(41.85, -87.65) is None


def test_single_very_hot_fire_tags(tmp_path: Path) -> None:
    text = HEADER + _row(40.0, -120.0, 95, FIRE_MIN_SOLO_FRP_MW + 1)
    s = _sampler_with(text, tmp_path)
    activity = s.lookup(40.0, -120.0)
    assert activity is not None
    assert activity.count == 1


def test_far_fire_not_found(tmp_path: Path) -> None:
    """A big complex 500 km away is outside the 100 km radius."""
    text = HEADER + "".join(_row(45.0, -120.0, 90, 300.0) for _ in range(4))
    s = _sampler_with(text, tmp_path)
    assert s.lookup(40.0, -120.0) is None


def test_cross_bucket_lookup(tmp_path: Path) -> None:
    """Detections just across a 5-degree bucket edge are still found."""
    # Target at 39.99, detection at 40.01 — different buckets (7 vs 8), <5 km apart.
    text = (
        HEADER
        + _row(40.01, -120.0, 90, 100.0)
        + _row(40.02, -120.0, 90, 100.0)
        + _row(40.03, -120.0, 90, 100.0)
    )
    s = _sampler_with(text, tmp_path)
    activity = s.lookup(39.99, -120.0)
    assert activity is not None
    assert activity.count == 3


# --- resilience ------------------------------------------------------------


def test_fetch_failure_falls_back_to_cache(tmp_path: Path) -> None:
    cache = tmp_path / "firms.csv"
    cache.write_text(HEADER + "".join(
        _row(10.0 + i * 0.01, 20.0, 90, 100.0) for i in range(3)
    ))
    # Age the cache past TTL so the sampler tries (and fails) the network.
    old = time.time() - 2 * 3600
    os.utime(cache, (old, old))

    def _boom(_url: str) -> str:
        raise RuntimeError("network down")

    s = FIRMSFireSampler(cache_path=cache, fetcher=_boom)
    assert s.lookup(10.01, 20.0) is not None  # stale cache still serves


def test_html_error_page_does_not_overwrite_cache(tmp_path: Path) -> None:
    cache = tmp_path / "firms.csv"
    good = HEADER + "".join(_row(10.0 + i * 0.01, 20.0, 90, 100.0) for i in range(3))
    cache.write_text(good)
    old = time.time() - 2 * 3600
    os.utime(cache, (old, old))

    s = FIRMSFireSampler(cache_path=cache, fetcher=lambda _u: "<html>oops</html>")
    # Falls back to the cached good data...
    assert s.lookup(10.01, 20.0) is not None
    # ...and the garbage was NOT written over the cache.
    assert cache.read_text() == good


def test_no_data_no_crash(tmp_path: Path) -> None:
    def _boom(_url: str) -> str:
        raise RuntimeError("network down")

    s = FIRMSFireSampler(cache_path=tmp_path / "missing.csv", fetcher=_boom)
    assert s.lookup(0.0, 0.0) is None


# --- score_pass_for_target integration --------------------------------------


def test_score_pass_serializes_fire_activity(tmp_path: Path) -> None:
    """A significant fire near the target serializes `fire_activity`; a quiet
    (or absent) sampler omits the key ENTIRELY so no-fire passes stay
    byte-identical to the pre-feature manifest (same rule as sprite/hurricane)."""
    from datetime import UTC, datetime

    from generator.cloud import MockCloudSampler
    from generator.main import score_pass_for_target
    from generator.orbit import Pass, Position

    when = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    target = {
        "id": "test", "name": "Test",
        "geom": {"type": "point", "lat": 40.0, "lon": -120.0},
        "priority": 4, "regime": "any",
    }
    pass_obj = Pass(
        target_id="test", target_lat=40.0, target_lon=-120.0,
        closest_approach=when, nadir_distance_km=100.0,
        iss_position=Position(lat=40.0, lon=-120.0, alt_km=410, when=when),
    )
    cloud = MockCloudSampler(default_cf=10.0)

    burning = _sampler_with(
        HEADER
        + _row(40.0, -120.0, 90, 80.0)
        + _row(40.1, -120.1, 80, 320.0)
        + _row(39.95, -119.9, 75, 60.0),
        tmp_path,
    )
    out = score_pass_for_target(target, pass_obj, cloud, 1.0, fire_sampler=burning)
    assert out["fire_activity"]["count"] == 3
    assert out["fire_activity"]["max_frp_mw"] == 320.0
    assert out["fire_activity"]["source"] == "firms-modis-24h"

    quiet = _sampler_with(HEADER, tmp_path / "quiet")
    assert "fire_activity" not in score_pass_for_target(
        target, pass_obj, cloud, 1.0, fire_sampler=quiet
    )
    assert "fire_activity" not in score_pass_for_target(
        target, pass_obj, cloud, 1.0
    )


def test_fresh_cache_skips_network(tmp_path: Path) -> None:
    cache = tmp_path / "firms.csv"
    cache.write_text(HEADER + "".join(
        _row(10.0 + i * 0.01, 20.0, 90, 100.0) for i in range(3)
    ))
    calls = {"n": 0}

    def _counting(_url: str) -> str:
        calls["n"] += 1
        return HEADER

    s = FIRMSFireSampler(cache_path=cache, fetcher=_counting)
    assert calls["n"] == 0  # fresh cache -> no fetch
    assert s.lookup(10.01, 20.0) is not None
