"""Tests for generator.cloud."""

from __future__ import annotations

from datetime import UTC, datetime

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


def test_sun_subpoint_utc_noon_zero_meridian() -> None:
    when = datetime(2024, 3, 20, 12, 0, 0, tzinfo=UTC)
    _lat, lon = sun_subpoint(when)
    assert abs(lon) < 1.0  # sub-solar at ~0° lon at UTC noon


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
