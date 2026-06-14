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


def test_combined_observed_zero_with_forecast_nonzero_t2() -> None:
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


def test_combined_cascading_failure_falls_back_to_placeholder_t3() -> None:
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


# --------------------------------------------------------------------------
# v1.5.5.0 coverage gap fillers: _glm_granule_urls + _decode_glm_granule
# --------------------------------------------------------------------------

from generator.lightning import (  # noqa: E402
    _decode_glm_granule,
    _glm_granule_urls,
)


def _make_s3_listing_xml(keys: list[str]) -> str:
    """Synthesize an S3 list-type=2 XML response."""
    contents = "".join(
        f"<Contents><Key>{k}</Key><Size>50000</Size></Contents>" for k in keys
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<ListBucketResult>'
        f'{contents}'
        '</ListBucketResult>'
    )


def test_glm_granule_urls_empty_window_returns_empty() -> None:
    assert _glm_granule_urls("noaa-goes16", datetime.now(tz=UTC), 0) == []
    assert _glm_granule_urls("noaa-goes16", datetime.now(tz=UTC), -10) == []


def test_glm_granule_urls_parses_keys_within_window() -> None:
    """Mock S3 list-type=2 response with one in-window granule, one
    too-old, and one malformed. Only the in-window one returns."""
    when = datetime(2026, 5, 21, 12, 30, tzinfo=UTC)
    doy = when.timetuple().tm_yday
    # Within last 60 min: at 12:15 (15 min ago)
    in_window_key = (
        f"GLM-L2-LCFA/2026/{doy:03d}/12/"
        f"OR_GLM-L2-LCFA_G16_s2026{doy:03d}121500_e2026{doy:03d}121520_c2026{doy:03d}121530.nc"
    )
    # Older than 60 min: at 10:30 (2 hours ago)
    too_old_key = (
        f"GLM-L2-LCFA/2026/{doy:03d}/10/"
        f"OR_GLM-L2-LCFA_G16_s2026{doy:03d}103000_e2026{doy:03d}103020_c2026{doy:03d}103030.nc"
    )
    # Malformed timestamp
    malformed_key = (
        f"GLM-L2-LCFA/2026/{doy:03d}/12/"
        f"OR_GLM-L2-LCFA_G16_sBADTIME000000_e2026{doy:03d}121520_c2026{doy:03d}121530.nc"
    )
    xml = _make_s3_listing_xml([in_window_key, too_old_key, malformed_key])

    class MockResp:
        text = xml

        def raise_for_status(self):
            pass

    with patch("generator.lightning.requests.get", return_value=MockResp()):
        urls = _glm_granule_urls("noaa-goes16", when, 60)
    # Only the in-window key should be retained; deduplicated across hours.
    assert any(in_window_key in u for u in urls)
    assert not any(too_old_key in u for u in urls)
    assert not any("BADTIME" in u for u in urls)


def test_glm_granule_urls_handles_request_exception() -> None:
    """Network failure → return empty list + log warning, no crash."""
    when = datetime(2026, 5, 21, 12, 30, tzinfo=UTC)
    with patch(
        "generator.lightning.requests.get",
        side_effect=__import__("requests").RequestException("network down"),
    ):
        urls = _glm_granule_urls("noaa-goes16", when, 60)
    assert urls == []


def test_glm_granule_urls_handles_no_keys() -> None:
    """S3 returns an empty listing XML — function returns empty list."""
    when = datetime(2026, 5, 21, 12, 30, tzinfo=UTC)

    class MockResp:
        text = '<?xml version="1.0"?><ListBucketResult></ListBucketResult>'

        def raise_for_status(self):
            pass

    with patch("generator.lightning.requests.get", return_value=MockResp()):
        urls = _glm_granule_urls("noaa-goes16", when, 60)
    assert urls == []


def test_decode_glm_granule_handles_corrupt_buffer() -> None:
    """Invalid NetCDF bytes → empty list, no crash."""
    flashes = _decode_glm_granule(b"not a NetCDF file")
    assert flashes == []


def test_decode_glm_granule_empty_bytes() -> None:
    assert _decode_glm_granule(b"") == []


def test_decode_glm_granule_synthesizes_in_memory_netcdf() -> None:
    """Build a minimal in-memory NetCDF file with the expected GLM-L2-LCFA
    structure and verify the decoder reads it correctly. Validates the
    real parse path against a synthetic but schema-correct file."""
    try:
        import netCDF4
    except ImportError:
        pytest.skip("netCDF4 not available")
    import io
    import tempfile

    # netCDF4 doesn't easily write to a BytesIO in all versions — use a
    # tmp file then read it back as bytes for the in-memory decode test.
    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
        path = tmp.name
    try:
        ds = netCDF4.Dataset(path, "w", format="NETCDF4")
        ds.createDimension("number_of_flashes", 3)
        lat = ds.createVariable("flash_lat", "f4", ("number_of_flashes",))
        lon = ds.createVariable("flash_lon", "f4", ("number_of_flashes",))
        offset = ds.createVariable(
            "flash_time_offset_of_first_event", "f4", ("number_of_flashes",)
        )
        lat[:] = [30.0, 31.0, 32.0]
        lon[:] = [-90.0, -91.0, -92.0]
        offset[:] = [0.0, 10.0, 20.0]
        ds.time_coverage_start = "2026-05-21T12:00:00Z"
        ds.close()

        with open(path, "rb") as f:
            buf = f.read()
        flashes = _decode_glm_granule(buf)
        assert len(flashes) == 3
        # Sorted by index — first flash is (30.0, -90.0) at t+0s
        assert flashes[0].lat == pytest.approx(30.0, abs=0.01)
        assert flashes[0].lon == pytest.approx(-90.0, abs=0.01)
        assert flashes[0].t.year == 2026
    finally:
        Path(path).unlink(missing_ok=True)
    _ = io  # silence unused-import


def test_glm_sampler_full_construction_with_mocked_fetch() -> None:
    """End-to-end GLMSampler construction with a mocked lister + fetcher
    that returns a synthetic NetCDF buffer. Exercises the constructor
    loop including spatial bucket indexing."""
    try:
        import netCDF4
    except ImportError:
        pytest.skip("netCDF4 not available")
    import tempfile

    when = datetime(2026, 5, 21, 12, 30, tzinfo=UTC)
    # Build a synthetic granule with 5 flashes near (30, -90).
    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
        path = tmp.name
    try:
        ds = netCDF4.Dataset(path, "w", format="NETCDF4")
        ds.createDimension("n", 5)
        lat = ds.createVariable("flash_lat", "f4", ("n",))
        lon = ds.createVariable("flash_lon", "f4", ("n",))
        offset = ds.createVariable("flash_time_offset_of_first_event", "f4", ("n",))
        lat[:] = [30.0, 30.1, 30.2, 30.3, 30.4]
        lon[:] = [-90.0, -90.1, -90.2, -90.3, -90.4]
        offset[:] = [0.0, 1.0, 2.0, 3.0, 4.0]
        ds.time_coverage_start = "2026-05-21T12:15:00Z"
        ds.close()
        with open(path, "rb") as f:
            buf = f.read()
    finally:
        Path(path).unlink(missing_ok=True)

    sampler = GLMSampler(
        when=when,
        window_minutes=60,
        lister=lambda _bucket: ["https://fake/granule.nc"] if _bucket == "noaa-goes16" else [],
        fetcher=lambda _url: buf,
    )
    # 5 flashes ingested.
    total = sum(len(v) for v in sampler._flashes_by_bucket.values())
    assert total == 5
    # Looking up (30, -90) within 100km should match most or all 5 flashes.
    result = sampler.sample(30.0, -90.0, when)
    assert result.lightning_potential > 0
    assert result.flash_rate_per_min > 0
    assert result.source.startswith("glm-")
    # Age suffix is computed from when - 12:15Z = 15 min.
    assert "15m" in result.source


def test_glm_sampler_fetcher_raises_then_continues() -> None:
    """One bad fetch shouldn't crash the constructor — it skips and goes on."""
    when = datetime(2026, 5, 21, 12, 30, tzinfo=UTC)

    def _bad_fetcher(_url: str) -> bytes:
        raise __import__("requests").RequestException("S3 down")

    sampler = GLMSampler(
        when=when,
        lister=lambda _bucket: ["https://fake/g1.nc", "https://fake/g2.nc"],
        fetcher=_bad_fetcher,
    )
    # No flashes ingested, but constructor didn't crash.
    total = sum(len(v) for v in sampler._flashes_by_bucket.values())
    assert total == 0


# --------------------------------------------------------------------------
# GLM concurrency fix (v1.6.x) — ThreadPoolExecutor + 120s overall budget.
# Protects the daemon tick from NOAA S3 worst-case latency: previously a
# serial loop at 30s timeout × ~180 granules could run 4-7+ min and trip
# the watchdog. Fix fans the fetch out to 16 workers and caps the entire
# phase at GLM_FETCH_BUDGET_SECONDS.
# --------------------------------------------------------------------------

import logging  # noqa: E402
import threading  # noqa: E402

from generator.lightning import (  # noqa: E402
    GLM_FETCH_BUDGET_SECONDS,
)


def test_glm_sampler_fetches_concurrently() -> None:
    """Stub fetcher records the thread it ran on; >1 distinct thread observed."""
    when = datetime(2026, 5, 21, 12, 30, tzinfo=UTC)
    seen_threads: set[int] = set()
    lock = threading.Lock()

    def _slow_fetcher(_url: str) -> bytes:
        # Hold the thread briefly so the executor has to spin up multiple
        # workers in parallel to drain the queue.
        time_mod = __import__("time")
        with lock:
            seen_threads.add(threading.get_ident())
        time_mod.sleep(0.05)
        return b"not a netcdf"  # decode returns [] silently

    urls = [f"https://fake/g{i}.nc" for i in range(8)]
    GLMSampler(
        when=when,
        lister=lambda _bucket: urls if _bucket == "noaa-goes16" else [],
        fetcher=_slow_fetcher,
    )
    # With 8 URLs × 50ms each, a serial loop would take 400ms and use 1
    # thread. ThreadPoolExecutor(max_workers=16) puts them all in flight
    # so we observe many distinct worker threads.
    assert len(seen_threads) > 1, f"only saw threads: {seen_threads}"


def test_glm_sampler_partial_success_aggregation(caplog: Any) -> None:
    """5 URLs succeed (return real flashes), 5 raise RequestException.
    Sampler ends up with the 5 successful granules' flashes indexed and
    logs a warning for each failure."""
    try:
        import netCDF4
    except ImportError:
        pytest.skip("netCDF4 not available")
    import tempfile

    when = datetime(2026, 5, 21, 12, 30, tzinfo=UTC)

    # Build one synthetic granule reused for all 5 successful URLs.
    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
        path = tmp.name
    try:
        ds = netCDF4.Dataset(path, "w", format="NETCDF4")
        ds.createDimension("n", 2)
        lat = ds.createVariable("flash_lat", "f4", ("n",))
        lon = ds.createVariable("flash_lon", "f4", ("n",))
        offset = ds.createVariable("flash_time_offset_of_first_event", "f4", ("n",))
        lat[:] = [30.0, 30.05]
        lon[:] = [-90.0, -90.05]
        offset[:] = [0.0, 1.0]
        ds.time_coverage_start = "2026-05-21T12:15:00Z"
        ds.close()
        with open(path, "rb") as f:
            buf = f.read()
    finally:
        Path(path).unlink(missing_ok=True)

    good_urls = {f"https://fake/good{i}.nc" for i in range(5)}
    bad_urls = {f"https://fake/bad{i}.nc" for i in range(5)}

    def _mixed_fetcher(url: str) -> bytes:
        if url in good_urls:
            return buf
        raise __import__("requests").RequestException(f"S3 said no for {url}")

    with caplog.at_level(logging.WARNING, logger="generator.lightning"):
        sampler = GLMSampler(
            when=when,
            lister=lambda _bucket: (
                list(good_urls) + list(bad_urls)
                if _bucket == "noaa-goes16"
                else []
            ),
            fetcher=_mixed_fetcher,
        )

    # 5 good granules × 2 flashes each = 10 flashes ingested.
    total = sum(len(v) for v in sampler._flashes_by_bucket.values())
    assert total == 10
    # One warning per failed URL.
    failure_warnings = [
        r for r in caplog.records
        if "GLM granule fetch failed" in r.getMessage()
    ]
    assert len(failure_warnings) == 5
    # Spatial index is queryable.
    result = sampler.sample(30.0, -90.0, when)
    assert result.lightning_potential > 0


def test_glm_sampler_overall_budget_drops_pending(caplog: Any,
                                                  monkeypatch: Any) -> None:
    """One URL sleeps past the budget; the others are fast. Constructor
    must return shortly after the budget expires (NOT block on the slow
    fetcher's full sleep), log the timeout warning, cancel pending
    futures, and still have data from the fast fetches."""
    try:
        import netCDF4
    except ImportError:
        pytest.skip("netCDF4 not available")
    import tempfile

    # Squash the budget to keep the test fast while still exercising the
    # exact code path (the only thing that matters is fetcher-runtime >
    # budget, with at least one pending future at the deadline).
    monkeypatch.setattr(
        "generator.lightning.GLM_FETCH_BUDGET_SECONDS", 1
    )

    when = datetime(2026, 5, 21, 12, 30, tzinfo=UTC)

    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
        path = tmp.name
    try:
        ds = netCDF4.Dataset(path, "w", format="NETCDF4")
        ds.createDimension("n", 1)
        lat = ds.createVariable("flash_lat", "f4", ("n",))
        lon = ds.createVariable("flash_lon", "f4", ("n",))
        offset = ds.createVariable("flash_time_offset_of_first_event", "f4", ("n",))
        lat[:] = [30.0]
        lon[:] = [-90.0]
        offset[:] = [0.0]
        ds.time_coverage_start = "2026-05-21T12:15:00Z"
        ds.close()
        with open(path, "rb") as f:
            buf = f.read()
    finally:
        Path(path).unlink(missing_ok=True)

    slow_url = "https://fake/slow.nc"
    fast_urls = [f"https://fake/fast{i}.nc" for i in range(5)]
    time_mod = __import__("time")

    def _mixed_fetcher(url: str) -> bytes:
        if url == slow_url:
            # Sleep well past the budget so it can't possibly complete
            # before as_completed raises TimeoutError.
            time_mod.sleep(10)
            return buf
        return buf

    start = time_mod.monotonic()
    with caplog.at_level(logging.WARNING, logger="generator.lightning"):
        sampler = GLMSampler(
            when=when,
            lister=lambda _bucket: (
                [slow_url] + fast_urls
                if _bucket == "noaa-goes16"
                else []
            ),
            fetcher=_mixed_fetcher,
        )
    elapsed = time_mod.monotonic() - start

    # Constructor must return shortly after the 1s budget — generous
    # slack accounts for Python+threadpool teardown, but the bound is
    # nowhere near the slow fetcher's 10s sleep.
    assert elapsed < 5.0, f"constructor took {elapsed:.2f}s; budget was 1s"

    # The timeout warning was logged.
    timeout_warnings = [
        r for r in caplog.records
        if "GLM granule fetch budget exceeded" in r.getMessage()
    ]
    assert len(timeout_warnings) == 1

    # The 5 fast fetches contributed real flashes to the spatial index.
    total = sum(len(v) for v in sampler._flashes_by_bucket.values())
    assert total >= 5


def test_glm_fetch_budget_constant_is_120s() -> None:
    """Design-doc-locked budget. Changing this requires re-reading the
    design doc — 120s gives ~3-4 min total tick budget headroom over the
    900s post-soak watchdog target."""
    assert GLM_FETCH_BUDGET_SECONDS == 120


# ---------------------------------------------------------------------------
# Sprite watch (Unit 7): strongest_cluster_in_annulus
# ---------------------------------------------------------------------------


def _glm_with_flashes(when, flashes):
    """Build a GLMSampler with a pre-populated index (no network)."""
    from generator.lightning import GLMSampler, _GLMFlash, _bucket_key
    s = GLMSampler.__new__(GLMSampler)
    s._when = when
    s._window_minutes = 60
    s._flashes_by_bucket = {}
    s._oldest_granule_age_min = 0
    for (lat, lon) in flashes:
        f = _GLMFlash(lat=lat, lon=lon, t=when)
        s._flashes_by_bucket.setdefault(_bucket_key(lat, lon), []).append(f)
    return s


def test_strongest_cluster_in_annulus_finds_strong_limb_storm() -> None:
    from generator.lightning import SPRITE_MIN_FLASHES
    when = datetime(2024, 7, 1, 3, 0, 0, tzinfo=UTC)
    # ISS sub-point in GLM coverage (Gulf of Mexico-ish), storm ~1500km N.
    iss_lat, iss_lon = 15.0, -85.0
    storm_lat, storm_lon = 28.5, -85.0  # ~1500km north (in the 900-3200 annulus)
    flashes = [(storm_lat + 0.05 * (i % 5), storm_lon + 0.05 * (i // 5))
               for i in range(SPRITE_MIN_FLASHES + 10)]
    s = _glm_with_flashes(when, flashes)
    c = s.strongest_cluster_in_annulus(iss_lat, iss_lon)
    assert c is not None
    assert c.flash_count >= SPRITE_MIN_FLASHES
    assert 900.0 <= c.distance_km <= 3200.0
    assert 350.0 <= c.bearing_deg or c.bearing_deg <= 10.0  # ~due north


def test_strongest_cluster_below_threshold_returns_none() -> None:
    from generator.lightning import SPRITE_MIN_FLASHES
    when = datetime(2024, 7, 1, 3, 0, 0, tzinfo=UTC)
    flashes = [(28.5 + 0.05 * i, -85.0) for i in range(SPRITE_MIN_FLASHES - 50)]
    s = _glm_with_flashes(when, flashes)
    assert s.strongest_cluster_in_annulus(15.0, -85.0) is None


def test_strongest_cluster_ignores_flashes_inside_inner_radius() -> None:
    from generator.lightning import SPRITE_MIN_FLASHES
    when = datetime(2024, 7, 1, 3, 0, 0, tzinfo=UTC)
    # A big storm right at nadir (inside 900km inner) must NOT count as sprite.
    flashes = [(15.2 + 0.02 * (i % 8), -85.0 + 0.02 * (i // 8))
               for i in range(SPRITE_MIN_FLASHES + 50)]
    s = _glm_with_flashes(when, flashes)
    assert s.strongest_cluster_in_annulus(15.0, -85.0) is None


def test_strongest_cluster_out_of_glm_coverage_returns_none() -> None:
    from generator.lightning import SPRITE_MIN_FLASHES
    when = datetime(2024, 7, 1, 3, 0, 0, tzinfo=UTC)
    flashes = [(28.5, 120.0 + 0.05 * i) for i in range(SPRITE_MIN_FLASHES + 10)]
    s = _glm_with_flashes(when, flashes)
    # ISS sub-point over Asia (lon 120) — outside GLM coverage box.
    assert s.strongest_cluster_in_annulus(15.0, 120.0) is None


def test_strongest_cluster_negative_longitude_bucket_math() -> None:
    from generator.lightning import SPRITE_MIN_FLASHES
    when = datetime(2024, 7, 1, 3, 0, 0, tzinfo=UTC)
    # Western-hemisphere negative-lon floor-division path.
    iss_lat, iss_lon = -10.0, -120.0
    flashes = [(-23.0 + 0.05 * (i % 5), -120.0) for i in range(SPRITE_MIN_FLASHES + 5)]
    s = _glm_with_flashes(when, flashes)
    c = s.strongest_cluster_in_annulus(iss_lat, iss_lon)
    assert c is not None and c.flash_count >= SPRITE_MIN_FLASHES
