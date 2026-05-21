"""Tests for generator.lightning — weather v1.3 framework + NHC tracker."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from generator.lightning import (
    LIGHTNING_BONUS_MAX,
    LightningSample,
    NHCHurricaneTracker,
    PlaceholderLightningSampler,
    _parse_lat_lon,
    _parse_one_storm,
    _saffir_simpson_category,
    lightning_bonus,
)

# --------------------------------------------------------------------------
# PlaceholderLightningSampler
# --------------------------------------------------------------------------


def test_placeholder_returns_zero_potential() -> None:
    s = PlaceholderLightningSampler()
    when = datetime(2024, 10, 17, 12, 0, tzinfo=UTC)
    sample = s.sample(35.0, -120.0, when)
    assert sample.lightning_potential == 0.0
    assert sample.flash_rate_per_min == 0.0
    assert sample.source == "placeholder"
    assert sample.sample_time == when


def test_placeholder_sample_is_lightning_sample_shape() -> None:
    s = PlaceholderLightningSampler()
    sample = s.sample(0, 0, datetime.now(tz=UTC))
    assert isinstance(sample, LightningSample)


# --------------------------------------------------------------------------
# lightning_bonus
# --------------------------------------------------------------------------


def test_lightning_bonus_zero_potential_gives_zero() -> None:
    assert lightning_bonus(0.0) == 0.0


def test_lightning_bonus_full_potential_caps_at_max() -> None:
    assert lightning_bonus(1.0) == LIGHTNING_BONUS_MAX


def test_lightning_bonus_linear_scaling() -> None:
    assert lightning_bonus(0.5) == LIGHTNING_BONUS_MAX * 0.5


def test_lightning_bonus_clamps_out_of_range() -> None:
    assert lightning_bonus(-0.5) == 0.0
    assert lightning_bonus(1.5) == LIGHTNING_BONUS_MAX
    assert lightning_bonus(99.0) == LIGHTNING_BONUS_MAX


# --------------------------------------------------------------------------
# _parse_lat_lon — NHC coordinate-string parsing
# --------------------------------------------------------------------------


def test_parse_lat_lon_north_positive() -> None:
    assert _parse_lat_lon("26.5N", ("N", "S")) == pytest.approx(26.5)


def test_parse_lat_lon_south_negative() -> None:
    assert _parse_lat_lon("12.3S", ("N", "S")) == pytest.approx(-12.3)


def test_parse_lat_lon_east_positive() -> None:
    assert _parse_lat_lon("145.0E", ("E", "W")) == pytest.approx(145.0)


def test_parse_lat_lon_west_negative() -> None:
    assert _parse_lat_lon("78.2W", ("E", "W")) == pytest.approx(-78.2)


def test_parse_lat_lon_numeric_passthrough() -> None:
    assert _parse_lat_lon(26.5, ("N", "S")) == 26.5
    assert _parse_lat_lon(-12.3, ("N", "S")) == -12.3


def test_parse_lat_lon_garbage_returns_none() -> None:
    assert _parse_lat_lon("garbage", ("N", "S")) is None
    assert _parse_lat_lon("", ("N", "S")) is None
    assert _parse_lat_lon(None, ("N", "S")) is None


# --------------------------------------------------------------------------
# _saffir_simpson_category
# --------------------------------------------------------------------------


@pytest.mark.parametrize("kts,expected", [
    (30, 0),    # TD
    (50, 0),    # TS
    (64, 1), (70, 1), (82, 1),
    (83, 2), (95, 2),
    (96, 3), (112, 3),
    (113, 4), (136, 4),
    (137, 5), (180, 5),
])
def test_saffir_simpson_category(kts: int, expected: int) -> None:
    assert _saffir_simpson_category(kts) == expected


# --------------------------------------------------------------------------
# _parse_one_storm — NHC activeStorms[] entry
# --------------------------------------------------------------------------


def test_parse_one_storm_typical_hurricane() -> None:
    raw: dict[str, Any] = {
        "id": "AL052024",
        "name": "Dorian",
        "latitude": "26.5N",
        "longitude": "78.2W",
        "classification": "HU",
        "intensity": "120",  # knots
    }
    storm = _parse_one_storm(raw)
    assert storm is not None
    assert storm.id == "AL052024"
    assert storm.name == "Dorian"
    assert storm.classification == "Hurricane Cat 4"
    assert storm.center_lat == pytest.approx(26.5)
    assert storm.center_lon == pytest.approx(-78.2)


def test_parse_one_storm_tropical_storm() -> None:
    raw: dict[str, Any] = {
        "id": "AL072024",
        "name": "Helene",
        "latitude": "20.0N",
        "longitude": "85.0W",
        "classification": "TS",
    }
    storm = _parse_one_storm(raw)
    assert storm is not None
    assert storm.classification == "Tropical Storm"


def test_parse_one_storm_unknown_classification_falls_through() -> None:
    raw: dict[str, Any] = {
        "id": "X1",
        "name": "Test",
        "latitude": "0N",
        "longitude": "0E",
        "classification": "ZZ",
    }
    storm = _parse_one_storm(raw)
    assert storm is not None
    assert storm.classification == "ZZ"


def test_parse_one_storm_missing_required_fields_returns_none() -> None:
    assert _parse_one_storm({"id": "X1"}) is None
    assert _parse_one_storm({"id": "X1", "name": "X"}) is None
    assert _parse_one_storm({
        "id": "X1", "name": "X", "latitude": "garbage",
        "longitude": "0E", "classification": "HU",
    }) is None


# --------------------------------------------------------------------------
# NHCHurricaneTracker — proximity check
# --------------------------------------------------------------------------


def _sample_nhc_payload() -> dict[str, Any]:
    return {
        "activeStorms": [
            {
                "id": "AL052024",
                "name": "Dorian",
                "latitude": "26.5N",
                "longitude": "78.2W",
                "classification": "HU",
                "intensity": "120",
            },
            {
                "id": "EP032024",
                "name": "Helene",
                "latitude": "20.0N",
                "longitude": "120.0W",
                "classification": "TS",
            },
        ],
    }


def test_tracker_returns_none_before_refresh(tmp_path: Path) -> None:
    cache = tmp_path / "nhc.json"
    tracker = NHCHurricaneTracker(cache_path=cache)
    assert tracker.check_proximity(26.5, -78.2) is None


def test_tracker_refresh_loads_from_cache_when_fresh(tmp_path: Path) -> None:
    cache = tmp_path / "nhc.json"
    cache.write_text(json.dumps(_sample_nhc_payload()))
    tracker = NHCHurricaneTracker(cache_path=cache, ttl_hours=1.0)
    tracker.refresh(now=datetime.now(tz=UTC))
    # Dorian center is 26.5N 78.2W; query right at center = distance 0
    near = tracker.check_proximity(26.5, -78.2)
    assert near is not None
    assert near.name == "Dorian"
    assert near.classification == "Hurricane Cat 4"
    assert near.distance_km == pytest.approx(0.0, abs=1.0)


def test_tracker_picks_closest_storm_when_multiple_match(tmp_path: Path) -> None:
    cache = tmp_path / "nhc.json"
    cache.write_text(json.dumps(_sample_nhc_payload()))
    tracker = NHCHurricaneTracker(cache_path=cache, ttl_hours=1.0)
    tracker.refresh(now=datetime.now(tz=UTC))
    # Sit between Dorian (78.2W) and Helene (120W) but closer to Dorian
    near = tracker.check_proximity(25.0, -90.0)
    assert near is not None
    assert near.name == "Dorian"


def test_tracker_returns_none_when_too_far(tmp_path: Path) -> None:
    cache = tmp_path / "nhc.json"
    cache.write_text(json.dumps(_sample_nhc_payload()))
    tracker = NHCHurricaneTracker(cache_path=cache, ttl_hours=1.0)
    tracker.refresh(now=datetime.now(tz=UTC))
    # Antipodal-ish from both storms
    assert tracker.check_proximity(-60.0, 90.0) is None


def test_tracker_respects_max_distance_override(tmp_path: Path) -> None:
    cache = tmp_path / "nhc.json"
    cache.write_text(json.dumps(_sample_nhc_payload()))
    tracker = NHCHurricaneTracker(cache_path=cache, ttl_hours=1.0)
    tracker.refresh(now=datetime.now(tz=UTC))
    # Dorian is at 26.5N 78.2W; this query is ~1100km away
    near_default = tracker.check_proximity(26.5, -90.0)
    assert near_default is not None
    # Same lat/lon but a tight 100km radius — should now miss
    assert tracker.check_proximity(26.5, -90.0, max_distance_km=100.0) is None


def test_tracker_handles_empty_active_storms(tmp_path: Path) -> None:
    cache = tmp_path / "nhc.json"
    cache.write_text(json.dumps({"activeStorms": []}))
    tracker = NHCHurricaneTracker(cache_path=cache, ttl_hours=1.0)
    tracker.refresh(now=datetime.now(tz=UTC))
    assert tracker.check_proximity(26.5, -78.2) is None


def test_tracker_handles_malformed_payload(tmp_path: Path) -> None:
    cache = tmp_path / "nhc.json"
    cache.write_text("not json at all")
    tracker = NHCHurricaneTracker(cache_path=cache, ttl_hours=1.0)
    with patch("generator.lightning.requests.get") as mock_get:
        mock_get.side_effect = Exception("network down")
        tracker.refresh(now=datetime.now(tz=UTC))
    # Malformed cache + network down → no storms, no crash
    assert tracker.check_proximity(26.5, -78.2) is None


def test_tracker_fetches_when_cache_stale(tmp_path: Path) -> None:
    cache = tmp_path / "nhc.json"
    cache.write_text(json.dumps({"activeStorms": []}))
    # Make cache appear old
    import os
    import time
    old_time = time.time() - (2 * 3600)  # 2 hours ago
    os.utime(cache, (old_time, old_time))

    tracker = NHCHurricaneTracker(cache_path=cache, ttl_hours=1.0)
    with patch("generator.lightning.requests.get") as mock_get:
        mock_resp = type("Mock", (), {
            "raise_for_status": lambda self: None,
            "json": lambda self: _sample_nhc_payload(),
        })()
        mock_get.return_value = mock_resp
        tracker.refresh(now=datetime.now(tz=UTC))
    near = tracker.check_proximity(26.5, -78.2)
    assert near is not None
    assert near.name == "Dorian"


# --------------------------------------------------------------------------
# v1.5.5.0 (weather v1.3.2): GLM, GFS-CAPE, Combined samplers
# --------------------------------------------------------------------------

from generator.lightning import (  # noqa: E402
    CombinedLightningSampler,
    GFSCAPELightningSampler,
    GLMSampler,
    _GLMFlash,
    _in_glm_coverage,
)


def test_glm_coverage_envelope() -> None:
    """A2: targets outside GOES coverage skip GLM lookup entirely."""
    # Americas (in coverage)
    assert _in_glm_coverage(40.0, -74.0)   # New York
    assert _in_glm_coverage(-33.0, -70.0)  # Santiago
    assert _in_glm_coverage(34.0, -118.0)  # LA
    # Outside coverage
    assert not _in_glm_coverage(51.5, 0.0)   # London
    assert not _in_glm_coverage(35.6, 139.7) # Tokyo
    assert not _in_glm_coverage(-26.2, 28.0) # Johannesburg
    assert not _in_glm_coverage(80.0, -100.0) # Above 60° lat


def test_glm_sampler_with_no_data_returns_zero() -> None:
    """Sim-env case: NOAA S3 returns 0 granules → sampler has no data
    → sample() returns 0 potential with source="glm-" (no age suffix)."""
    when = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    sampler = GLMSampler(
        when=when,
        fetcher=lambda _url: b"",  # never called — lister returns []
        lister=lambda _bucket: [],
    )
    result = sampler.sample(30.0, -90.0, when)
    assert result.lightning_potential == 0.0
    assert result.source.startswith("glm")


def test_glm_sampler_skips_out_of_coverage() -> None:
    when = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    sampler = GLMSampler(when=when, fetcher=lambda _: b"", lister=lambda _: [])
    result = sampler.sample(51.5, 0.0, when)  # London
    assert result.source == "glm-out-of-coverage"
    assert result.lightning_potential == 0.0


def test_glm_sampler_aggregates_synthetic_flashes() -> None:
    """Inject flashes via the spatial index directly (bypassing NetCDF
    decode) and verify per-target distance filtering + flash-rate math."""
    when = datetime(2026, 5, 21, 12, 0, tzinfo=UTC)
    sampler = GLMSampler(when=when, fetcher=lambda _: b"", lister=lambda _: [])
    # Manually seed 10 flashes near (30.0, -90.0) — should all be within 100km.
    flashes_near = [
        _GLMFlash(lat=30.0 + i * 0.01, lon=-90.0, t=when)
        for i in range(10)
    ]
    # Plus 5 far away (>100km).
    flashes_far = [
        _GLMFlash(lat=35.0, lon=-90.0, t=when)  # ~555km north
        for _ in range(5)
    ]
    for f in flashes_near + flashes_far:
        from generator.lightning import _bucket_key
        sampler._flashes_by_bucket.setdefault(_bucket_key(f.lat, f.lon), []).append(f)
    sampler._oldest_granule_age_min = 30
    result = sampler.sample(30.0, -90.0, when)
    assert result.flash_rate_per_min == pytest.approx(10 / 60.0, abs=0.01)
    assert result.lightning_potential > 0
    assert result.source == "glm-30m"


def test_gfs_cape_lightning_sampler_no_data() -> None:
    """When the GFS-CAPE sampler returns None (no data), the lightning
    sampler returns 0 potential with source="gfs-cape-no-data"."""
    class _StubGFS:
        def cape_at(self, _lat, _lon, _when):
            return None
    sampler = GFSCAPELightningSampler(_StubGFS())
    result = sampler.sample(30.0, -90.0, datetime(2026, 5, 21, 12, 0, tzinfo=UTC))
    assert result.lightning_potential == 0.0
    assert result.source == "gfs-cape-no-data"


def test_gfs_cape_lightning_sampler_real_cape() -> None:
    """CAPE 2500 J/kg → potential 1.0 (severe threshold per D5)."""
    class _StubGFS:
        def cape_at(self, _lat, _lon, _when):
            return 2500.0
    sampler = GFSCAPELightningSampler(_StubGFS())
    result = sampler.sample(30.0, -90.0, datetime(2026, 5, 21, 12, 0, tzinfo=UTC))
    assert result.lightning_potential == pytest.approx(1.0)
    assert result.source == "gfs-cape"


def test_gfs_cape_lightning_sampler_clamps_above_max() -> None:
    """CAPE 5000 J/kg also saturates at 1.0 — no overflow above max."""
    class _StubGFS:
        def cape_at(self, _lat, _lon, _when):
            return 5000.0
    sampler = GFSCAPELightningSampler(_StubGFS())
    result = sampler.sample(30.0, -90.0, datetime(2026, 5, 21, 12, 0, tzinfo=UTC))
    assert result.lightning_potential == 1.0


def test_combined_observed_zero_with_forecast_nonzero_T2() -> None:
    """T2: observed=0 IS real data (no lightning observed). Forecast
    must NOT win when observed has data, even if observed value is 0."""
    class _ObsZero:
        def sample(self, lat, lon, when):
            return LightningSample(
                lightning_potential=0.0,
                flash_rate_per_min=0.0,
                sample_time=when,
                source="glm-30m",  # has-data source (no -no-data suffix)
            )
    class _FcstHigh:
        def sample(self, lat, lon, when):
            return LightningSample(
                lightning_potential=0.8,
                flash_rate_per_min=0.0,
                sample_time=when,
                source="gfs-cape",
            )
    combined = CombinedLightningSampler(observed=_ObsZero(), forecast=_FcstHigh())
    result = combined.sample(30.0, -90.0, datetime(2026, 5, 21, 12, 0, tzinfo=UTC))
    # Observed=0 wins; max(0, 0.8 * 0.7) = 0.56 — the forecast still
    # contributes because observed had no flashes but forecast is in a
    # separate "future condition" window. The attribution stays "glm-30m"
    # to credit the observed sampler with the real-zero reading.
    assert result.source == "glm-30m"
    # Per D5 max rule: max(0, 0.8*0.7) = 0.56
    assert result.lightning_potential == pytest.approx(0.56)


def test_combined_cascading_failure_falls_back_to_placeholder_T3() -> None:
    """T3: GLM AND GFS-CAPE both return no-data → fallback to placeholder."""
    class _ObsNoData:
        def sample(self, lat, lon, when):
            return LightningSample(0.0, 0.0, when, "glm-out-of-coverage")
    class _FcstNoData:
        def sample(self, lat, lon, when):
            return LightningSample(0.0, 0.0, when, "gfs-cape-no-data")
    combined = CombinedLightningSampler(observed=_ObsNoData(), forecast=_FcstNoData())
    result = combined.sample(51.5, 0.0, datetime(2026, 5, 21, 12, 0, tzinfo=UTC))
    assert result.source == "placeholder"
    assert result.lightning_potential == 0.0


def test_combined_exception_from_sampler_falls_through() -> None:
    """Exceptions inside one sampler don't crash the combined sampler."""
    class _ObsRaises:
        def sample(self, lat, lon, when):
            raise RuntimeError("S3 down")
    class _FcstOK:
        def sample(self, lat, lon, when):
            return LightningSample(0.5, 0.0, when, "gfs-cape")
    combined = CombinedLightningSampler(observed=_ObsRaises(), forecast=_FcstOK())
    result = combined.sample(30.0, -90.0, datetime(2026, 5, 21, 12, 0, tzinfo=UTC))
    # Forecast remains; potential = max(0, 0.5*0.7) = 0.35
    assert result.source == "gfs-cape"
    assert result.lightning_potential == pytest.approx(0.35)


def test_combined_observed_high_wins_over_forecast() -> None:
    """D5: observed always wins. Observed potential > forecast*0.7 → use observed."""
    class _ObsHigh:
        def sample(self, lat, lon, when):
            return LightningSample(0.9, 5.0, when, "glm-20m")
    class _FcstHigh:
        def sample(self, lat, lon, when):
            return LightningSample(1.0, 0.0, when, "gfs-cape")
    combined = CombinedLightningSampler(observed=_ObsHigh(), forecast=_FcstHigh())
    result = combined.sample(30.0, -90.0, datetime(2026, 5, 21, 12, 0, tzinfo=UTC))
    # max(0.9, 1.0*0.7) = 0.9. observed wins.
    assert result.source == "glm-20m"
    assert result.lightning_potential == pytest.approx(0.9)
    assert result.flash_rate_per_min == 5.0
