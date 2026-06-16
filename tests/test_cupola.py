"""Tests for the Cupola keepsake-window finder (generator/cupola.py).

The disc mix gate is checked against the REAL committed GSHHG mask — the
correctness gate (coastlines accept; open ocean / interiors / island-specks
reject). find_cupola_windows is exercised end-to-end with a real TLE + stub
forecast for shape, ranking, byte-stability, and the load-bearing add_targets
pre-pass.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from generator.cloud import CloudSample
from generator.cupola import (
    MAX_WINDOWS,
    _disc_water_fraction,
    _solar_zenith_deg,
    find_cupola_windows,
)
from generator.orbit import TLE
from generator.water_mask import load_water_mask

WHEN = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)


# --- disc mix gate against the real mask ------------------------------------

def test_disc_mix_accepts_coastlines() -> None:
    mask = load_water_mask()
    assert mask is not None
    # Coastlines: both land and water present in the disc (20–80% water).
    for name, lat, lon in [
        ("Norfolk VA", 36.9, -76.3), ("Big Sur", 36.3, -121.8),
        ("Rio", -22.9, -43.2), ("Sendai", 38.3, 141.0), ("Wellington", -41.3, 174.8),
    ]:
        wf = _disc_water_fraction(lat, lon, mask)
        assert 0.20 <= wf <= 0.80, f"{name} should be a mix, got water_frac={wf:.2f}"


def test_disc_mix_rejects_open_ocean_and_interiors() -> None:
    mask = load_water_mask()
    assert mask is not None
    for name, lat, lon in [("mid-Pacific", 0.0, -150.0), ("mid-Atlantic", 30.0, -40.0)]:
        assert _disc_water_fraction(lat, lon, mask) > 0.80, f"{name} should be open ocean"
    for name, lat, lon in [("Sahara", 23.0, 12.0), ("Kansas", 38.5, -98.0)]:
        assert _disc_water_fraction(lat, lon, mask) < 0.20, f"{name} should be all land"


def test_disc_mix_rejects_island_specks() -> None:
    mask = load_water_mask()
    assert mask is not None
    # An isolated island in open ocean is mostly water → below the 20% land floor.
    for name, lat, lon in [("Tahiti", -17.65, -149.43), ("Maldives", 3.2, 73.2)]:
        assert _disc_water_fraction(lat, lon, mask) > 0.80, f"{name} speck should reject"


def test_solar_zenith_overhead_is_zero() -> None:
    # Sun directly overhead → zenith ≈ 0; antipode → ≈ 180.
    assert _solar_zenith_deg(10.0, 20.0, 10.0, 20.0) < 0.01
    assert _solar_zenith_deg(10.0, 20.0, -10.0, 20.0 - 180.0) > 179.0


# --- find_cupola_windows end-to-end -----------------------------------------

class _StubForecast:
    """Always returns a real gfs-forecast sample at a fixed low cloud."""

    def __init__(self, cf: float = 5.0, source: str = "gfs-forecast") -> None:
        self.cf = cf
        self.source = source
        self.added: list[tuple[float, float]] = []

    def add_targets(self, targets: list[tuple[float, float]]) -> None:
        self.added.extend(targets)

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        return CloudSample(cloud_fraction=self.cf, sample_time=when, source=self.source)


def test_find_windows_shape_and_ranking(sample_tle: TLE) -> None:
    mask = load_water_mask()
    assert mask is not None
    fc = _StubForecast(cf=5.0)
    # 12h is enough orbit time to cross several daylit coastlines.
    windows = find_cupola_windows(
        sample_tle, WHEN, forecast_sampler=fc, water_mask_obj=mask, minutes=720,
    )
    assert windows, "low-cloud coastline crossings should yield windows"
    assert len(windows) <= MAX_WINDOWS
    # Ranked lowest-cloud first.
    clouds = [w["cloud_fraction"] for w in windows]
    assert clouds == sorted(clouds)
    # Each window is PassEntry-compatible with no NaN-inducing gaps.
    for w in windows:
        assert w["target_id"].startswith("cupola:")
        assert w["target_name"].startswith("Keepsake —")
        assert w["pass_regime"] == "day"
        assert w["target_regime"] == "day"
        assert isinstance(w["nadir_distance_km"], float)
        assert set(w["score_components"]) == {
            "p_unobstructed", "regime_fit", "nadir_proximity",
            "priority_weight", "tle_freshness",
        }
        assert all(isinstance(v, (int, float)) for v in w["score_components"].values())
        assert "iss_at_closest" in w and "alt_km" in w["iss_at_closest"]
        assert w["closest_approach"].endswith("Z")
        assert isinstance(w["golden_hour"], bool)


def test_find_windows_seeds_forecast_cache_with_daylit_cells(sample_tle: TLE) -> None:
    """The add_targets pre-pass is load-bearing — it must be called with the
    daylit, 0.25°-snapped track cells, or the finder emits nothing."""
    mask = load_water_mask()
    assert mask is not None
    fc = _StubForecast(cf=5.0)
    find_cupola_windows(sample_tle, WHEN, forecast_sampler=fc, water_mask_obj=mask, minutes=360)
    assert fc.added, "forecast cache must be seeded with daylit track cells"
    # All seeded cells are 0.25°-snapped.
    for lat, lon in fc.added:
        assert abs(lat * 4 - round(lat * 4)) < 1e-9
        assert abs(lon * 4 - round(lon * 4)) < 1e-9


def test_find_windows_rejects_cloud_placeholder(sample_tle: TLE) -> None:
    """A forecast that only returns the cf=50 'no-data' placeholder must yield
    zero windows — never treat the placeholder as a real clear sky."""
    mask = load_water_mask()
    assert mask is not None
    fc = _StubForecast(cf=50.0, source="gfs-forecast-no-data")
    windows = find_cupola_windows(
        sample_tle, WHEN, forecast_sampler=fc, water_mask_obj=mask, minutes=720,
    )
    assert windows == []


def test_find_windows_byte_stable(sample_tle: TLE) -> None:
    mask = load_water_mask()
    assert mask is not None
    a = find_cupola_windows(
        sample_tle, WHEN, forecast_sampler=_StubForecast(), water_mask_obj=mask, minutes=360,
    )
    b = find_cupola_windows(
        sample_tle, WHEN, forecast_sampler=_StubForecast(), water_mask_obj=mask, minutes=360,
    )
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
