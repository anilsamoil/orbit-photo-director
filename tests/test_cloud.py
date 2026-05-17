"""Tests for generator.cloud."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from generator.cloud import (
    CloudSample,
    MockCloudSampler,
    angular_separation_deg,
    assess_obstruction,
    is_water,
    lighting_regime,
    sun_glint_risk,
    sun_subpoint,
)

# --------------------------------------------------------------------------
# Obstruction assessment
# --------------------------------------------------------------------------


def _sample(cf: float) -> CloudSample:
    return CloudSample(cloud_fraction=cf, sample_time=datetime(2024, 10, 17, tzinfo=UTC), source="mock")


def test_assess_obstruction_clear() -> None:
    a = assess_obstruction(_sample(10.0), sun_glint_risk=False)
    assert a.obstruction_class == "clear"
    assert a.p_unobstructed == 90.0


def test_assess_obstruction_cloudy_high() -> None:
    a = assess_obstruction(_sample(85.0), sun_glint_risk=False)
    assert a.obstruction_class == "cloudy"
    assert a.p_unobstructed == 15.0


def test_assess_obstruction_cloudy_mid() -> None:
    a = assess_obstruction(_sample(50.0), sun_glint_risk=False)
    assert a.obstruction_class == "cloudy"
    assert a.p_unobstructed == 50.0


def test_assess_obstruction_sun_glint_overrides() -> None:
    """sun-glint trumps clear-sky classification."""
    a = assess_obstruction(_sample(5.0), sun_glint_risk=True)
    assert a.obstruction_class == "sun-glint risk"
    # p_unobstructed = max(0, 60 - 5) = 55
    assert a.p_unobstructed == 55.0


def test_assess_obstruction_clamps_negative() -> None:
    a = assess_obstruction(_sample(-10.0), sun_glint_risk=False)
    assert 0.0 <= a.p_unobstructed <= 100.0


def test_assess_obstruction_clamps_over_100() -> None:
    a = assess_obstruction(_sample(150.0), sun_glint_risk=False)
    assert 0.0 <= a.p_unobstructed <= 100.0


# --------------------------------------------------------------------------
# Sun subpoint
# --------------------------------------------------------------------------


def test_sun_subpoint_returns_within_range() -> None:
    when = datetime(2024, 6, 21, 12, 0, 0, tzinfo=UTC)
    lat, lon = sun_subpoint(when)
    assert -23.5 <= lat <= 23.5
    assert -180 <= lon <= 180


def test_sun_subpoint_summer_solstice_high_lat() -> None:
    """Around June 21, sub-solar latitude should be near +23°."""
    when = datetime(2024, 6, 21, 12, 0, 0, tzinfo=UTC)
    lat, _lon = sun_subpoint(when)
    assert lat > 22.0


def test_sun_subpoint_winter_solstice_low_lat() -> None:
    when = datetime(2024, 12, 21, 12, 0, 0, tzinfo=UTC)
    lat, _lon = sun_subpoint(when)
    assert lat < -22.0


def test_sun_subpoint_rejects_naive() -> None:
    with pytest.raises(ValueError):
        sun_subpoint(datetime(2024, 10, 17))


def test_sun_subpoint_utc_noon_eot_zero_date() -> None:
    # 2024-04-15 is one of the four annual EoT zero-crossings (others
    # around June 13, Sep 1, Dec 25). At UTC noon on a zero-EoT date,
    # sub_lon should be ≈ 0. EoT correction shipped 2026-05-17 along
    # with sun_subpoint's ±4° error fix.
    when = datetime(2024, 4, 15, 12, 0, 0, tzinfo=UTC)
    _lat, lon = sun_subpoint(when)
    assert abs(lon) < 1.0  # sub-solar at ~0° lon at UTC noon (EoT ≈ 0)


def test_sun_subpoint_applies_equation_of_time() -> None:
    # Mid-February EoT is ~-14 min (sun "slow") → sub_lon at UTC noon
    # should be west of Greenwich by ~3.5°. Without EoT this returned 0.
    when = datetime(2024, 2, 11, 12, 0, 0, tzinfo=UTC)
    _lat, lon = sun_subpoint(when)
    # EoT on day 42 ≈ -14.1 min → sub_lon = -15 * (-14.1/60) ≈ +3.5°.
    # Allow ±0.5° tolerance for the approximation.
    assert 3.0 < lon < 4.0

    # Early November EoT is ~+16 min (sun "fast") → sub_lon at UTC
    # noon should be east of Greenwich by ~4°. Sign flips from Feb case.
    when2 = datetime(2024, 11, 3, 12, 0, 0, tzinfo=UTC)
    _lat2, lon2 = sun_subpoint(when2)
    assert -4.5 < lon2 < -3.0


# --------------------------------------------------------------------------
# Lighting regime
# --------------------------------------------------------------------------


def test_lighting_regime_day_at_subsolar() -> None:
    # target at the sub-solar point -> definitely day
    assert lighting_regime(0.0, 0.0, 0.0, 0.0) == "day"


def test_lighting_regime_night_at_antipode() -> None:
    # target at the anti-solar point -> definitely night
    assert lighting_regime(0.0, 0.0, 0.0, 180.0) == "night"


def test_lighting_regime_terminator_band() -> None:
    # Sub-solar at equator/0°. Target at lat=0, lon=85 → roughly on the day-night terminator.
    regime = lighting_regime(0.0, 0.0, 0.0, 85.0)
    assert regime == "terminator"


# --------------------------------------------------------------------------
# Angular separation (helper for sun-glint geometry)
# --------------------------------------------------------------------------


def test_angular_separation_same_point() -> None:
    assert angular_separation_deg(35.0, 139.0, 35.0, 139.0) == pytest.approx(0.0, abs=1e-4)


def test_angular_separation_quarter_planet() -> None:
    assert angular_separation_deg(0.0, 0.0, 0.0, 90.0) == pytest.approx(90.0)


def test_angular_separation_antipodes() -> None:
    assert angular_separation_deg(0.0, 0.0, 0.0, 180.0) == pytest.approx(180.0)


# --------------------------------------------------------------------------
# Sun-glint risk
# --------------------------------------------------------------------------


def test_sun_glint_risk_false_over_land() -> None:
    # Tokyo is over land
    risk = sun_glint_risk(
        sun_lat=10.0, sun_lon=130.0,
        target_lat=35.68, target_lon=139.69,
        iss_lat=10.0, iss_lon=130.0,
    )
    assert risk is False


def test_sun_glint_risk_false_at_night() -> None:
    """At night the sun is below horizon at the target → no glint possible."""
    risk = sun_glint_risk(
        sun_lat=0.0, sun_lon=0.0,
        target_lat=0.0, target_lon=170.0,  # over Pacific water at night (sub-solar at 0,0)
        iss_lat=0.0, iss_lon=170.0,
    )
    assert risk is False


def test_sun_glint_risk_true_when_iss_overhead_water_in_daylight() -> None:
    """ISS near target subpoint over Pacific in daylight → glint plausible (over-flag)."""
    risk = sun_glint_risk(
        sun_lat=0.0, sun_lon=160.0,
        target_lat=0.0, target_lon=160.0,  # central Pacific
        iss_lat=0.5, iss_lon=160.5,  # ~78 km offset
    )
    assert risk is True


def test_sun_glint_risk_false_when_iss_far_from_target() -> None:
    """ISS far from target subpoint → no glint geometry possible."""
    risk = sun_glint_risk(
        sun_lat=0.0, sun_lon=160.0,
        target_lat=0.0, target_lon=160.0,
        iss_lat=20.0, iss_lon=160.0,  # 20° offset, ~2200 km
    )
    assert risk is False


# --------------------------------------------------------------------------
# Land/sea heuristic
# --------------------------------------------------------------------------


def test_is_water_central_pacific() -> None:
    assert is_water(0.0, 170.0) is True


def test_is_water_tokyo() -> None:
    assert is_water(35.68, 139.69) is False


def test_is_water_sahara() -> None:
    # Northern Africa, well inland
    assert is_water(20.0, 10.0) is False


def test_is_water_hawaii_not_flagged() -> None:
    # Reported by anilsamoilenko 2026-05-17 (V2-P3 TODOS.md): Hawaiian
    # Islands fall inside the V1 Pacific band and were getting
    # sun_glint_risk evaluated on them. Big Island ~lat 19.5, lon -155.5.
    # Diamond Head (Oahu) ~lat 21.3, lon -157.8. Kauai ~lat 22, lon -159.5.
    assert is_water(19.5, -155.5) is False, "Hawaii Big Island"
    assert is_water(21.3, -157.8) is False, "Honolulu / Diamond Head"
    assert is_water(22.0, -159.5) is False, "Kauai"
    # But genuine open Pacific around Hawaii stays flagged as water.
    assert is_water(25.0, -160.0) is True, "Pacific NW of Hawaiian chain"


def test_is_water_vandenberg_not_flagged() -> None:
    # V3.0 review found Vandenberg SLC-4E at lat 34.6, lon -120.6 was
    # flagged as Pacific water, asymmetric vs Kennedy LC-39A
    # (lat 28.6, lon -80.6, outside band). Pacific east boundary shrunk
    # from -110 to -125 to fix.
    assert is_water(34.6, -120.6) is False, "Vandenberg SLC-4E (CA coast)"
    assert is_water(28.6, -80.6) is False, "KSC LC-39A (FL coast, sanity)"
    # Open Pacific further west stays flagged.
    assert is_water(34.0, -140.0) is True, "Open Pacific west of CA"


# (existing test_is_water_with_explicit_mask coverage already exists at
# line ~529 below — kept the more thorough named-callable version)


# --------------------------------------------------------------------------
# Mock sampler
# --------------------------------------------------------------------------


def test_mock_sampler_returns_default() -> None:
    s = MockCloudSampler(default_cf=42.0)
    result = s.sample(0.0, 0.0, datetime(2024, 10, 17, tzinfo=UTC))
    assert result.cloud_fraction == 42.0
    assert result.source == "mock"


def test_mock_sampler_overrides() -> None:
    s = MockCloudSampler(default_cf=10.0, overrides={(35.7, 139.7): 90.0})
    when = datetime(2024, 10, 17, tzinfo=UTC)
    assert s.sample(35.68, 139.69, when).cloud_fraction == 90.0
    assert s.sample(0.0, 0.0, when).cloud_fraction == 10.0


# --------------------------------------------------------------------------
# Himawari NICT sampler — Asia/W.Pacific gap-filler
# --------------------------------------------------------------------------


def _make_fake_himawari_fetcher(brightness_per_tile: dict[tuple[int, int], int]):
    """Return a fetcher that synthesizes a PNG of constant brightness per (x,y) tile.

    Each tile in the 2x2 grid is rendered as a uniform RGB(b,b,b) PNG. Lets us
    drive the sampler with known values per quadrant.
    """
    from io import BytesIO

    import numpy as np
    from PIL import Image

    from generator.cloud import HIMAWARI_NICT_TILE_PX

    def _fetch(url: str) -> bytes:
        # Parse the trailing "{x}_{y}.png" to know which tile is requested.
        tail = url.rsplit("/", 1)[-1]
        coords = tail.replace(".png", "").split("_")
        x, y = int(coords[-2]), int(coords[-1])
        b = brightness_per_tile.get((x, y), 0)
        arr = np.full((HIMAWARI_NICT_TILE_PX, HIMAWARI_NICT_TILE_PX, 3), b, dtype=np.uint8)
        buf = BytesIO()
        Image.fromarray(arr).save(buf, format="PNG")
        return buf.getvalue()

    return _fetch


def test_himawari_nict_timestamp_floors_to_10_min() -> None:
    from generator.cloud import _himawari_nict_timestamp

    when = datetime(2026, 5, 3, 16, 37, 42, tzinfo=UTC)
    assert _himawari_nict_timestamp(when) == "2026/05/03/163000"


def test_himawari_nict_timestamp_rejects_naive() -> None:
    from generator.cloud import _himawari_nict_timestamp

    with pytest.raises(ValueError):
        _himawari_nict_timestamp(datetime(2026, 5, 3, 16, 37))


def test_himawari_nict_returns_no_coverage_outside_disk() -> None:
    from generator.cloud import HimawariNICTSampler

    fetcher = _make_fake_himawari_fetcher({(0, 0): 200, (1, 0): 200, (0, 1): 200, (1, 1): 200})
    when = datetime(2026, 5, 3, 5, 0, 0, tzinfo=UTC)
    s = HimawariNICTSampler(when, fetcher=fetcher)
    # New York: lon -74, lat 40 — well outside Himawari disk
    result = s.sample(40.0, -74.0, when)
    assert result.source == "himawari-no-coverage"
    # Sahara: lon 0, lat 20 — outside
    result = s.sample(20.0, 0.0, when)
    assert result.source == "himawari-no-coverage"


def test_himawari_nict_returns_night_for_dark_pixel() -> None:
    from generator.cloud import HimawariNICTSampler

    # All tiles return brightness 5 (very dark — night)
    fetcher = _make_fake_himawari_fetcher({(0, 0): 5, (1, 0): 5, (0, 1): 5, (1, 1): 5})
    when = datetime(2026, 5, 3, 16, 30, 0, tzinfo=UTC)
    s = HimawariNICTSampler(when, fetcher=fetcher)
    # Tokyo: lon 139.7, lat 35.7 — inside disk but "night" via brightness
    result = s.sample(35.7, 139.7, when)
    assert result.source == "himawari-night"


def test_himawari_nict_returns_cloud_fraction_for_bright_pixel() -> None:
    from generator.cloud import HimawariNICTSampler

    # NE tile (Tokyo) bright (cloud); others dark
    fetcher = _make_fake_himawari_fetcher({(0, 0): 5, (1, 0): 200, (0, 1): 5, (1, 1): 5})
    when = datetime(2026, 5, 3, 5, 0, 0, tzinfo=UTC)
    s = HimawariNICTSampler(when, fetcher=fetcher)
    # Tokyo: lon 139.7, lat 35.7 — top-half (lat > 0), but lon 139.7 is at the
    # boundary between (0,0) and (1,0). 140.7° subsolar = boundary.
    # Test slightly east at lon 160 to land cleanly in (1,0).
    result = s.sample(35.7, 160.0, when)
    assert result.source == "himawari-nict"
    # brightness=200 → cf = (200-50)/150*100 = 100
    assert result.cloud_fraction == pytest.approx(100.0, abs=1.0)


def test_himawari_nict_handles_dateline_wrap() -> None:
    from generator.cloud import HimawariNICTSampler

    # All tiles bright
    fetcher = _make_fake_himawari_fetcher({(0, 0): 100, (1, 0): 100, (0, 1): 100, (1, 1): 100})
    when = datetime(2026, 5, 3, 5, 0, 0, tzinfo=UTC)
    s = HimawariNICTSampler(when, fetcher=fetcher)
    # Hawaii: lon -157, lat 21 — across the dateline from Himawari sub-point.
    # Unwrapped: -157 + 360 = 203, which is inside the 60..220 disk frame.
    result = s.sample(21.0, -157.0, when)
    assert result.source == "himawari-nict"
    # brightness=100 → cf = (100-50)/150*100 ≈ 33.3
    assert 30.0 < result.cloud_fraction < 40.0


def test_himawari_nict_rejects_naive_when() -> None:
    from generator.cloud import HimawariNICTSampler

    fetcher = _make_fake_himawari_fetcher({(0, 0): 100, (1, 0): 100, (0, 1): 100, (1, 1): 100})
    when = datetime(2026, 5, 3, 5, 0, 0, tzinfo=UTC)
    s = HimawariNICTSampler(when, fetcher=fetcher)
    with pytest.raises(ValueError):
        s.sample(35.7, 139.7, datetime(2026, 5, 3, 5, 0, 0))


# --------------------------------------------------------------------------
# GFSForecastSampler — forward cloud-cover via Open-Meteo's GFS endpoint
# --------------------------------------------------------------------------


def _make_fake_gfs_fetcher(per_target: dict[tuple[float, float], list[tuple[str, float]]]):
    """Return a fetcher that synthesizes Open-Meteo-shaped JSON for the
    requested batch. Each target's hourly time/cloud arrays are pulled from
    `per_target`, keyed by (lat, lon) snapped to 0.25° grid.
    """
    from urllib.parse import parse_qs, urlparse

    def _fetch(url: str) -> Any:
        q = parse_qs(urlparse(url).query)
        lats = [float(x) for x in q["latitude"][0].split(",")]
        lons = [float(x) for x in q["longitude"][0].split(",")]
        items = []
        for lat, lon in zip(lats, lons, strict=False):
            key = (round(lat * 4) / 4.0, round(lon * 4) / 4.0)
            series = per_target.get(key, [])
            items.append({
                "latitude": lat,
                "longitude": lon,
                "hourly": {
                    "time": [t for t, _ in series],
                    "cloud_cover": [c for _, c in series],
                },
            })
        # Single-target requests return dict; multi-target returns list (Open-Meteo behavior).
        return items[0] if len(items) == 1 else items

    return _fetch


def test_gfs_forecast_returns_no_data_for_empty_targets() -> None:
    from generator.cloud import GFSForecastSampler

    s = GFSForecastSampler(targets=[], fetcher=lambda url: [])
    when = datetime(2026, 5, 3, 12, 0, 0, tzinfo=UTC)
    r = s.sample(35.7, 139.7, when)
    assert r.source == "gfs-forecast-no-data"


def test_gfs_forecast_snaps_lat_lon_to_grid() -> None:
    from generator.cloud import GFSForecastSampler

    fetcher = _make_fake_gfs_fetcher({
        (35.75, 139.75): [
            ("2026-05-03T12:00", 60.0),
            ("2026-05-03T13:00", 75.0),
        ],
    })
    # Construction lat/lon NOT exactly on the 0.25° grid — sampler should
    # snap to (35.75, 139.75) when looking up.
    s = GFSForecastSampler(targets=[(35.68, 139.69)], fetcher=fetcher)
    when = datetime(2026, 5, 3, 12, 0, 0, tzinfo=UTC)
    r = s.sample(35.68, 139.69, when)
    assert r.source == "gfs-forecast"
    assert r.cloud_fraction == 60.0


def test_gfs_forecast_returns_cloud_cover_at_target_hour() -> None:
    from generator.cloud import GFSForecastSampler

    fetcher = _make_fake_gfs_fetcher({
        (40.75, -74.0): [
            ("2026-05-03T12:00", 30.0),
            ("2026-05-03T13:00", 45.0),
            ("2026-05-03T14:00", 80.0),
        ],
    })
    s = GFSForecastSampler(targets=[(40.71, -74.01)], fetcher=fetcher)
    # Sample a non-aligned minute — should floor to 13:00 hour.
    when = datetime(2026, 5, 3, 13, 47, 12, tzinfo=UTC)
    r = s.sample(40.71, -74.01, when)
    assert r.source == "gfs-forecast"
    assert r.cloud_fraction == 45.0


def test_gfs_forecast_returns_out_of_horizon_past_window() -> None:
    from generator.cloud import GFSForecastSampler

    fetcher = _make_fake_gfs_fetcher({
        (40.75, -74.0): [("2026-05-03T12:00", 30.0)],
    })
    s = GFSForecastSampler(targets=[(40.71, -74.01)], fetcher=fetcher)
    # 24 hours past the only forecast step
    when = datetime(2026, 5, 4, 12, 0, 0, tzinfo=UTC)
    r = s.sample(40.71, -74.01, when)
    assert r.source == "gfs-forecast-out-of-horizon"


def test_gfs_forecast_deduplicates_targets_on_grid_snap() -> None:
    """Two targets within the same 0.25° cell share one forecast time-series."""
    from generator.cloud import GFSForecastSampler

    fetch_calls: list[str] = []

    def counting_fetcher(url: str) -> Any:
        fetch_calls.append(url)
        # Only one target's worth of data needed
        return {
            "latitude": 35.75,
            "longitude": 139.75,
            "hourly": {
                "time": ["2026-05-03T12:00"],
                "cloud_cover": [50.0],
            },
        }

    # Both targets snap to (35.75, 139.75)
    GFSForecastSampler(
        targets=[(35.68, 139.69), (35.78, 139.78)],
        fetcher=counting_fetcher,
    )
    assert len(fetch_calls) == 1
    # URL should only contain one lat / one lon (not two)
    assert fetch_calls[0].count(",") == 0  # no comma-separated lats/lons


# --------------------------------------------------------------------------
# Smaller branches: sun_subpoint wrap, is_water mask + ocean bands,
# GFS forecast malformed-response handling
# --------------------------------------------------------------------------


def test_sun_subpoint_wraps_longitude_positive() -> None:
    """At UTC midnight the unnormalized sub_lon is +180 → wrap path triggers."""
    when = datetime(2024, 6, 21, 0, 0, 0, tzinfo=UTC)
    sun_lat, sun_lon = sun_subpoint(when)
    assert -180 <= sun_lon <= 180


def test_sun_subpoint_wraps_longitude_negative() -> None:
    """At UTC noon+12 the unnormalized sub_lon is < -180 → wrap path triggers."""
    when = datetime(2024, 6, 21, 23, 59, 59, tzinfo=UTC)
    sun_lat, sun_lon = sun_subpoint(when)
    assert -180 <= sun_lon <= 180


def test_sun_subpoint_rejects_naive_datetime() -> None:
    with pytest.raises(ValueError, match="UTC-aware"):
        sun_subpoint(datetime(2024, 6, 21, 12, 0, 0))


def test_is_water_with_explicit_mask() -> None:
    """When a mask callable is provided, is_water defers to it (V2 GSHHG path)."""
    def always_water(_lat: float, _lon: float) -> bool:
        return True

    def always_land(_lat: float, _lon: float) -> bool:
        return False

    assert is_water(0.0, 0.0, mask=always_water) is True
    assert is_water(0.0, 0.0, mask=always_land) is False


@pytest.mark.parametrize(
    ("lat", "lon", "expected_water"),
    [
        (0.0, 160.0, True),    # mid-Pacific
        (0.0, -150.0, True),   # mid-Pacific (negative lon side)
        (0.0, -30.0, True),    # mid-Atlantic
        (-30.0, 75.0, True),   # Indian Ocean
        (60.0, 0.0, True),     # Norwegian Sea
        (40.0, -100.0, False), # central US (land)
        (80.0, 0.0, False),    # outside ±70 lat band
    ],
)
def test_is_water_ocean_bands(lat: float, lon: float, expected_water: bool) -> None:
    assert is_water(lat, lon) is expected_water


def test_gfs_forecast_handles_truncated_payload() -> None:
    """Open-Meteo returning fewer items than requested logs but doesn't crash."""
    from generator.cloud import GFSForecastSampler

    def short_fetcher(url: str) -> list[dict]:
        # Two targets requested, only one response object returned.
        return [{
            "latitude": 35.75,
            "longitude": 139.75,
            "hourly": {
                "time": ["2026-05-03T12:00"],
                "cloud_cover": [50.0],
            },
        }]

    GFSForecastSampler(
        targets=[(35.75, 139.75), (40.75, -74.0)],
        fetcher=short_fetcher,
    )


def test_gfs_forecast_skips_unparseable_timestamps() -> None:
    """Bad ISO timestamps in the upstream payload are skipped silently."""
    from generator.cloud import GFSForecastSampler

    def fetcher_with_bad_time(url: str):
        return {
            "latitude": 35.75,
            "longitude": 139.75,
            "hourly": {
                "time": ["not-a-timestamp", "2026-05-03T13:00"],
                "cloud_cover": [50.0, 30.0],
            },
        }

    s = GFSForecastSampler(
        targets=[(35.75, 139.75)],
        fetcher=fetcher_with_bad_time,
    )
    # The valid sample remains accessible; sample() returns SOMETHING.
    sample = s.sample(35.75, 139.75, datetime(2026, 5, 3, 13, 0, tzinfo=UTC))
    assert sample is not None


def test_gibs_helper_url_format() -> None:
    """_gibs_url builds a WMTS-shaped URL string."""
    from generator.cloud import _gibs_url
    url = _gibs_url("MODIS_Aqua_Cloud_Fraction_Day", "2024-10-17", 0, 0, 0)
    assert "MODIS_Aqua_Cloud_Fraction_Day" in url
    assert "2024-10-17" in url
    assert url.endswith("/0/0/0.png")


def test_date_iso_strips_time() -> None:
    """_date_iso formats yyyy-mm-dd regardless of clock component."""
    from generator.cloud import _date_iso
    assert _date_iso(datetime(2024, 10, 17, 23, 59, 59, tzinfo=UTC)) == "2024-10-17"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0, False),    # 0 = no observation
        (1, True),     # cloud-fraction=1 (sparsest cloud)
        (50, True),
        (100, True),   # full cloud
        (101, False),  # >100 invalid
        (127, False),  # GIBS no-data sentinel
        (-5, False),
    ],
)
def test_is_valid_gibs_pixel(value: int, expected: bool) -> None:
    from generator.cloud import _is_valid_gibs_pixel
    assert _is_valid_gibs_pixel(value) is expected


def test_himawari_nict_sampler_rejects_naive_datetime() -> None:
    """Same UTC-awareness contract as sun_subpoint."""
    from generator.cloud import HimawariNICTSampler
    with pytest.raises(ValueError, match="UTC-aware"):
        HimawariNICTSampler(datetime(2024, 10, 17, 12, 0, 0))


def test_gfs_forecast_skips_null_cloud_cover() -> None:
    from generator.cloud import GFSForecastSampler

    def fetcher_with_null(url: str):
        return {
            "latitude": 35.75,
            "longitude": 139.75,
            "hourly": {
                "time": ["2026-05-03T12:00", "2026-05-03T13:00"],
                "cloud_cover": [None, 40.0],
            },
        }

    s = GFSForecastSampler(
        targets=[(35.75, 139.75)],
        fetcher=fetcher_with_null,
    )
    sample = s.sample(35.75, 139.75, datetime(2026, 5, 3, 13, 0, tzinfo=UTC))
    assert sample is not None


def test_gfs_forecast_clamps_cloud_fraction() -> None:
    """Open-Meteo can return values like 100.5 due to interpolation; clamp 0..100."""
    from generator.cloud import GFSForecastSampler

    fetcher = _make_fake_gfs_fetcher({
        (40.75, -74.0): [
            ("2026-05-03T12:00", -5.0),
            ("2026-05-03T13:00", 105.0),
        ],
    })
    s = GFSForecastSampler(targets=[(40.71, -74.01)], fetcher=fetcher)
    r1 = s.sample(40.71, -74.01, datetime(2026, 5, 3, 12, 0, 0, tzinfo=UTC))
    r2 = s.sample(40.71, -74.01, datetime(2026, 5, 3, 13, 0, 0, tzinfo=UTC))
    assert r1.cloud_fraction == 0.0
    assert r2.cloud_fraction == 100.0


def test_gfs_forecast_rejects_naive_when() -> None:
    from generator.cloud import GFSForecastSampler

    fetcher = _make_fake_gfs_fetcher({
        (40.75, -74.0): [("2026-05-03T12:00", 30.0)],
    })
    s = GFSForecastSampler(targets=[(40.71, -74.01)], fetcher=fetcher)
    with pytest.raises(ValueError):
        s.sample(40.71, -74.01, datetime(2026, 5, 3, 12, 0, 0))


def test_gfs_forecast_handles_fetch_failure_gracefully() -> None:
    """Network/HTTP failure mid-batch leaves the affected targets uncached;
    .sample returns the no-data placeholder rather than raising."""
    from generator.cloud import GFSForecastSampler

    def failing_fetcher(url: str) -> Any:
        raise RuntimeError("simulated network failure")

    s = GFSForecastSampler(targets=[(40.71, -74.01)], fetcher=failing_fetcher)
    r = s.sample(40.71, -74.01, datetime(2026, 5, 3, 12, 0, 0, tzinfo=UTC))
    assert r.source == "gfs-forecast-no-data"


# --------------------------------------------------------------------------
# MeteosatEUMETSATSampler — Africa/Europe day+night via EUMETSAT WMS IR108
# --------------------------------------------------------------------------


def _make_fake_meteosat_fetcher(brightness_grid: dict[tuple[int, int], int] | None = None,
                                 alpha_grid: dict[tuple[int, int], int] | None = None,
                                 default_brightness: int = 100):
    """Return a fetcher that synthesizes a 1024x1024 RGBA PNG with controllable
    brightness/alpha per pixel (or per region). Pixels not in `brightness_grid`
    use `default_brightness`. Pixels not in `alpha_grid` are alpha=255.
    """
    from io import BytesIO

    import numpy as np
    from PIL import Image

    from generator.cloud import EUMETSAT_TILE_PX

    def _fetch(_url: str) -> bytes:
        n = EUMETSAT_TILE_PX
        arr = np.full((n, n, 4), default_brightness, dtype=np.uint8)
        arr[:, :, 3] = 255
        if brightness_grid:
            for (row, col), b in brightness_grid.items():
                arr[row, col, 0:3] = b
        if alpha_grid:
            for (row, col), a in alpha_grid.items():
                arr[row, col, 3] = a
        buf = BytesIO()
        Image.fromarray(arr, mode="RGBA").save(buf, format="PNG")
        return buf.getvalue()

    return _fetch


def test_meteosat_returns_no_coverage_outside_disk() -> None:
    from generator.cloud import MeteosatEUMETSATSampler

    fetcher = _make_fake_meteosat_fetcher(default_brightness=100)
    when = datetime(2026, 5, 3, 12, 0, 0, tzinfo=UTC)
    s = MeteosatEUMETSATSampler(when, fetcher=fetcher)
    # Tokyo (lon 139) is well outside MSG-0° disk (max lon 60)
    r = s.sample(35.7, 139.7, when)
    assert r.source == "meteosat-no-coverage"
    # NYC (lon -74) is outside the western edge
    r = s.sample(40.7, -74.0, when)
    assert r.source == "meteosat-no-coverage"


def test_meteosat_returns_off_disk_for_alpha_zero() -> None:
    from generator.cloud import MeteosatEUMETSATSampler

    # Set the (0,0) pixel — corresponds to (lat 60, lon -60), upper-left
    # corner of the box — to alpha=0.
    fetcher = _make_fake_meteosat_fetcher(
        default_brightness=100,
        alpha_grid={(0, 0): 0},
    )
    when = datetime(2026, 5, 3, 12, 0, 0, tzinfo=UTC)
    s = MeteosatEUMETSATSampler(when, fetcher=fetcher)
    r = s.sample(60.0, -60.0, when)
    assert r.source == "meteosat-off-disk"


def test_meteosat_returns_ir108_cf_for_known_pixel() -> None:
    from generator.cloud import EUMETSAT_TILE_PX, MeteosatEUMETSATSampler

    # Place a pixel at the center of the bbox (0°lat, 0°lon) → row,col = (n/2, n/2).
    # IR brightness 200 → cf = 100 - (200/255)*100 ≈ 21.6 → "warm" so low cloud.
    n = EUMETSAT_TILE_PX
    fetcher = _make_fake_meteosat_fetcher(
        default_brightness=10,
        brightness_grid={(n // 2, n // 2): 200},
    )
    when = datetime(2026, 5, 3, 12, 0, 0, tzinfo=UTC)
    s = MeteosatEUMETSATSampler(when, fetcher=fetcher)
    r = s.sample(0.0, 0.0, when)
    assert r.source == "meteosat-ir108"
    # 200/255 → ~21.6% cloud
    assert 20 < r.cloud_fraction < 24


def test_meteosat_high_brightness_means_high_cloud() -> None:
    from generator.cloud import MeteosatEUMETSATSampler

    fetcher = _make_fake_meteosat_fetcher(default_brightness=240)
    when = datetime(2026, 5, 3, 12, 0, 0, tzinfo=UTC)
    s = MeteosatEUMETSATSampler(when, fetcher=fetcher)
    # Cairo is comfortably inside MSG-0° disk
    r = s.sample(30.0, 31.0, when)
    assert r.source == "meteosat-ir108"
    # 240/255 → ~5.9% cloud (LOW because IR-brightness inverts: bright = warm = no cloud)
    assert r.cloud_fraction < 10


def test_meteosat_low_brightness_means_low_cloud_per_ir_inversion() -> None:
    from generator.cloud import MeteosatEUMETSATSampler

    # Dark pixels = cold = high cloud tops → high cf.
    fetcher = _make_fake_meteosat_fetcher(default_brightness=10)
    when = datetime(2026, 5, 3, 12, 0, 0, tzinfo=UTC)
    s = MeteosatEUMETSATSampler(when, fetcher=fetcher)
    r = s.sample(0.0, 0.0, when)
    assert r.source == "meteosat-ir108"
    # 10/255 → ~96% cloud
    assert r.cloud_fraction > 90


def test_meteosat_rejects_naive_when_in_init() -> None:
    from generator.cloud import MeteosatEUMETSATSampler

    fetcher = _make_fake_meteosat_fetcher(default_brightness=100)
    with pytest.raises(ValueError):
        MeteosatEUMETSATSampler(datetime(2026, 5, 3, 12, 0, 0), fetcher=fetcher)


def test_meteosat_rejects_naive_when_in_sample() -> None:
    from generator.cloud import MeteosatEUMETSATSampler

    fetcher = _make_fake_meteosat_fetcher(default_brightness=100)
    when = datetime(2026, 5, 3, 12, 0, 0, tzinfo=UTC)
    s = MeteosatEUMETSATSampler(when, fetcher=fetcher)
    with pytest.raises(ValueError):
        s.sample(0.0, 0.0, datetime(2026, 5, 3, 12, 0, 0))


def test_gfs_forecast_batches_above_100_targets() -> None:
    """Targets > OPEN_METEO_BATCH_SIZE split into multiple HTTP calls."""
    from generator.cloud import GFSForecastSampler

    fetch_calls: list[str] = []

    def counting_fetcher(url: str) -> Any:
        fetch_calls.append(url)
        # Parse the URL to know how many lats came in this batch
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(url).query)
        lats_str = q["latitude"][0].split(",")
        # Build matching response shape
        items = [
            {
                "latitude": float(lats_str[i]),
                "longitude": -74.0,
                "hourly": {"time": ["2026-05-03T12:00"], "cloud_cover": [42.0]},
            }
            for i in range(len(lats_str))
        ]
        return items[0] if len(items) == 1 else items

    # 150 unique targets → 2 batches (100 + 50)
    targets = [(20.0 + 0.25 * i, -74.0) for i in range(150)]
    GFSForecastSampler(targets=targets, fetcher=counting_fetcher)
    assert len(fetch_calls) == 2
