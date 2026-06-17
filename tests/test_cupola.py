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


def test_region_label_tiles_the_globe() -> None:
    """Every window gets a named region — the box table must tile the globe so
    no card ever shows the generic 'land' fallback (operator feedback)."""
    from generator.cupola import _region_label

    generic = {"the far north", "the far south", "the open ocean", "a remote coast"}
    misses = [
        (lat, lon)
        for lat in range(-89, 90, 3)
        for lon in range(-179, 180, 3)
        if _region_label(float(lat), float(lon), True) in generic
    ]
    assert not misses, f"{len(misses)} grid points hit the generic fallback, e.g. {misses[:5]}"
    # A few labels read sensibly.
    assert _region_label(47.5, -87.5, True) == "the Great Lakes"
    assert _region_label(78.0, 20.0, True) == "the Arctic"
    assert _region_label(-80.0, 40.0, True) == "the Southern Ocean"
    assert _region_label(44.0, 34.0, True) == "the Black Sea"


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


def test_find_windows_seeds_only_mix_cells_not_whole_daylit_track(sample_tle: TLE) -> None:
    """429 fix (2026-06-16): the pre-pass must seed ONLY the daylit COASTLINE
    cells (past the local mix gate), not the whole daylit track — otherwise it
    floods Open-Meteo with ~15-30x more cells and gets rate-limited to zero
    windows. Guards against reverting to all-daylit seeding."""
    from datetime import timedelta

    from generator.cloud import sun_subpoint
    from generator.cupola import _disc_water_fraction, _solar_zenith_deg, MIX_WATER_CEIL, MIX_WATER_FLOOR
    from generator.orbit import propagate

    mask = load_water_mask()
    assert mask is not None
    fc = _StubForecast(cf=5.0)
    minutes, step = 360, 20
    find_cupola_windows(sample_tle, WHEN, forecast_sampler=fc, water_mask_obj=mask,
                        minutes=minutes, step_seconds=step)
    seeded = len(set(fc.added))

    # Count the unique daylit cells the OLD code would have seeded.
    daylit_cells = set()
    for i in range(int(minutes * 60 / step) + 1):
        when = WHEN + timedelta(seconds=i * step)
        pos = propagate(sample_tle, when)
        slat, slon = sun_subpoint(when)
        if _solar_zenith_deg(slat, slon, pos.lat, pos.lon) < 70.0:
            daylit_cells.add((round(pos.lat * 4) / 4, round(pos.lon * 4) / 4))

    assert seeded > 0
    # Seeding must be a small fraction of all-daylit — the mix gate dropping
    # open-ocean + interior cells is the whole point.
    assert seeded < len(daylit_cells) / 3, (
        f"seeded {seeded} of {len(daylit_cells)} daylit cells — mix-gating not applied"
    )


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
