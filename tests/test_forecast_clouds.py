"""Tests for the V4-P2 forecast cloud-frame renderer (generator/forecast_clouds.py).

Covers the locked eng-review test plan (grid shape/snap, batch-size guard,
Open-Meteo-down → no frames, alpha ramp, NaN→transparent, 85-tile split,
mercator clamp, antimeridian wrap, tile-seam continuity, flag gating,
run-change skip, publish atomicity, manifest↔dir agreement, gfs_run in path)
plus the Revision-2 stable-path semantics (run-keyed dirs, KEEP_RUNS prune).
"""

from __future__ import annotations

import io
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from generator import forecast_clouds as fc


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

NOW = datetime(2026, 6, 10, 13, 30, tzinfo=UTC)  # → render cycle 2026-06-10T00:00Z


class FakeSample:
    def __init__(self, cf: float, source: str = "gfs-forecast") -> None:
        self.cloud_fraction = cf
        self.source = source


class FakeSampler:
    """Duck-typed sampler: cloud% is a deterministic function of (lat, lon)."""

    def __init__(self, fn: Any | None = None) -> None:
        self.fn = fn or (lambda lat, lon, when: FakeSample((abs(lat) + abs(lon)) % 101))
        self.calls = 0

    def sample(self, lat: float, lon: float, when: datetime) -> FakeSample:
        self.calls += 1
        return self.fn(lat, lon, when)


def offline_fetcher_factory(record: list[str]):
    """Open-Meteo-shaped fetcher: deterministic hourly series per coord."""

    def fetcher(url: str) -> Any:
        record.append(url)
        lats = re.search(r"latitude=([^&]+)", url).group(1).split(",")
        run = fc.latest_gfs_run(NOW)
        times = [
            (run + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M")
            for h in range(0, 49)
        ]
        return [
            {"hourly": {"time": times, "cloud_cover": [50.0] * len(times)}}
            for _ in lats
        ]

    return fetcher


# ---------------------------------------------------------------------------
# Run + frame cadence
# ---------------------------------------------------------------------------

def test_latest_gfs_run_floors_to_render_cycle_with_lag() -> None:
    # Revision 3: 12h render cadence — 00Z/12Z cycles only.
    # 13:30Z − 5h lag = 08:30 → 00Z cycle
    assert fc.latest_gfs_run(NOW) == datetime(2026, 6, 10, 0, 0, tzinfo=UTC)
    # 17:30Z − 5h = 12:30 → 12Z cycle
    noonish = datetime(2026, 6, 10, 17, 30, tzinfo=UTC)
    assert fc.latest_gfs_run(noonish) == datetime(2026, 6, 10, 12, 0, tzinfo=UTC)
    # Lag crossing midnight picks yesterday's 12Z
    past_midnight = datetime(2026, 6, 10, 2, 0, tzinfo=UTC)
    assert fc.latest_gfs_run(past_midnight) == datetime(2026, 6, 9, 12, 0, tzinfo=UTC)


def test_latest_gfs_run_rejects_naive_datetime() -> None:
    with pytest.raises(ValueError):
        fc.latest_gfs_run(datetime(2026, 6, 10, 13, 30))  # noqa: DTZ001


def test_frame_times_tiered_cadence() -> None:
    run = fc.latest_gfs_run(NOW)
    times = fc.frame_times(run)
    offsets = [(t - run).total_seconds() / 3600 for t in times]
    # Hourly through +6, then 3-hourly to +48 → 7 + 14 = 21 frames, and the
    # +48h tail keeps the slider's +36h range covered all render-cycle long.
    assert offsets == [0, 1, 2, 3, 4, 5, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48]


# ---------------------------------------------------------------------------
# Grid + sampler
# ---------------------------------------------------------------------------

def test_grid_coords_shape_and_snap() -> None:
    coords = fc.grid_coords()
    assert len(coords) == 36 * 72
    lats = sorted({lat for lat, _ in coords})
    lons = sorted({lon for _, lon in coords})
    assert len(lats) == 36 and len(lons) == 72
    assert lats[0] == -87.5 and lats[-1] == 87.5
    assert lons[0] == -180.0 and lons[-1] == 175.0
    # Uniform 5° spacing on both axes (Revision 3)
    assert np.allclose(np.diff(lats), fc.GRID_STEP_DEG)
    assert np.allclose(np.diff(lons), fc.GRID_STEP_DEG)


def test_batch_size_guard_and_call_count() -> None:
    # P1 (Revision 3): ≤100 coords per Open-Meteo call (URL-length safety),
    # one sweep ≈ 26 calls / 2,592 location-requests for the full 5° grid.
    record: list[str] = []
    fc.build_grid_sampler(offline_fetcher_factory(record))
    assert len(record) == 26
    for url in record:
        n = len(re.search(r"latitude=([^&]+)", url).group(1).split(","))
        assert n <= 100
        assert len(url) < 8000


def test_sample_grid_maps_sources_to_nan() -> None:
    def fn(lat: float, lon: float, when: datetime) -> FakeSample:
        if lat > 0:
            return FakeSample(120.0)  # clamps to 100
        if lon > 0:
            return FakeSample(50.0, source="gfs-forecast-no-data")
        return FakeSample(50.0, source="gfs-forecast-out-of-horizon")

    grid = fc.sample_grid(FakeSampler(fn), NOW)
    assert grid.shape == (36, 72)
    north = grid[fc.GRID_LATS > 0]
    assert np.nanmax(north) == 100.0 and not np.any(np.isnan(north))
    south = grid[fc.GRID_LATS < 0]
    assert np.all(np.isnan(south))  # both non-real sources → NaN


# ---------------------------------------------------------------------------
# Ramp + tiles
# ---------------------------------------------------------------------------

def test_alpha_ramp_floor_monotonic_max_and_nan() -> None:
    cf = np.array([0.0, fc.RAMP_FLOOR_CF - 0.1, fc.RAMP_FLOOR_CF, 50.0, 100.0, np.nan])
    alpha = fc.alpha_from_cloud(cf)
    assert alpha.dtype == np.uint8
    assert alpha[0] == 0 and alpha[1] == 0          # below floor → transparent
    assert alpha[5] == 0                             # NaN → transparent
    assert 0 <= alpha[2] <= 2                        # floor edge ≈ 0
    assert alpha[2] <= alpha[3] <= alpha[4]          # monotonic
    assert alpha[4] == fc.RAMP_MAX_ALPHA             # 100% cloud → max


def test_render_frame_tiles_exact_tile_set() -> None:
    grid = np.full((36, 72), 80.0)
    tiles = fc.render_frame_tiles(grid)
    assert len(tiles) == 85  # 1 + 4 + 16 + 64
    for z in range(4):
        keys = [(zz, x, y) for (zz, x, y) in tiles if zz == z]
        assert len(keys) == (2**z) ** 2
        assert {(x, y) for (_, x, y) in keys} == {
            (x, y) for x in range(2**z) for y in range(2**z)
        }
    img = Image.open(io.BytesIO(tiles[(0, 0, 0)]))
    assert img.size == (256, 256) and img.mode == "RGBA"


def test_mercator_clamp_poles_reuse_extreme_rows() -> None:
    # At z3 the edge pixel centers sit poleward of the mercator limit, so
    # the clamp engages: the first/last pixel rows map to the grid rows at
    # ±85.05°, never out of range. (At z0 the 256-pixel centers stop short
    # of the limit — clamping is a high-zoom-edge behavior.)
    rows3, _ = fc.pixel_grid_indices(3)
    assert rows3[0] == np.round((fc.MERCATOR_LAT_LIMIT - fc.GRID_LATS[0]) / fc.GRID_STEP_DEG)
    assert rows3[-1] == np.round((-fc.MERCATOR_LAT_LIMIT - fc.GRID_LATS[0]) / fc.GRID_STEP_DEG)
    for z in range(4):
        rows, _ = fc.pixel_grid_indices(z)
        assert rows.min() >= 0 and rows.max() <= fc.GRID_LATS.size - 1


def test_antimeridian_wraps_via_modulo() -> None:
    _, cols = fc.pixel_grid_indices(3)
    assert cols.min() >= 0 and cols.max() <= fc.GRID_LONS.size - 1
    # The easternmost pixels (lon → +180) wrap onto grid col 0 (lon −180):
    # ±180° is the same meridian, so the raster is continuous at the seam.
    assert cols[-1] == 0
    assert cols[0] == 0  # westernmost pixel (−180 + ε) also col 0


def test_tile_seam_continuity() -> None:
    # Adjacent tiles slice ONE shared global index map — across any tile
    # boundary the grid index advances by at most one cell (no jumps, no
    # repeats-then-skips → no visible seams). Column steps are measured
    # circularly: the 143→0 transition at the antimeridian IS continuity
    # on a wrapped axis, not a seam.
    rows, cols = fc.pixel_grid_indices(2)
    row_steps = np.abs(np.diff(rows.astype(np.int64)))
    assert row_steps.max() <= 1
    col_steps = np.abs(np.diff(cols.astype(np.int64)))
    circular = np.minimum(col_steps, fc.GRID_LONS.size - col_steps)
    assert circular.max() <= 1


def test_renders_visible_clouds_where_cloudy() -> None:
    grid = np.full((36, 72), np.nan)
    grid[30, :] = 95.0  # one cloudy northern band
    tiles = fc.render_frame_tiles(grid)
    img = np.array(Image.open(io.BytesIO(tiles[(0, 0, 0)])))
    assert img[..., 3].max() > 150  # the band renders strongly
    assert img[..., 3].min() == 0   # NaN elsewhere stays transparent


# ---------------------------------------------------------------------------
# Paced fetcher (live smoke 2026-06-10: unpaced sweep trips the 429 limiter)
# ---------------------------------------------------------------------------

class FakeResp:
    def __init__(self, status: int = 200) -> None:
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return {"hourly": {"time": [], "cloud_cover": []}}


def test_paced_fetcher_sleeps_between_batches() -> None:
    sleeps: list[float] = []
    fetch = fc.paced_fetcher(get=lambda url: FakeResp(), sleep=sleeps.append)
    fetch("http://x/1")
    fetch("http://x/2")
    assert sleeps == [fc.OPEN_METEO_BATCH_DELAY_S, fc.OPEN_METEO_BATCH_DELAY_S]


def test_paced_fetcher_backs_off_on_429_then_succeeds() -> None:
    sleeps: list[float] = []
    statuses = iter([429, 429, 200])
    fetch = fc.paced_fetcher(get=lambda url: FakeResp(next(statuses)), sleep=sleeps.append)
    assert fetch("http://x") is not None
    # pace, backoff×1, pace, backoff×2, pace → success
    assert sleeps == [
        fc.OPEN_METEO_BATCH_DELAY_S,
        fc.OPEN_METEO_429_BACKOFF_S,
        fc.OPEN_METEO_BATCH_DELAY_S,
        fc.OPEN_METEO_429_BACKOFF_S * 2,
        fc.OPEN_METEO_BATCH_DELAY_S,
    ]


def test_paced_fetcher_gives_up_after_retries() -> None:
    fetch = fc.paced_fetcher(get=lambda url: FakeResp(429), sleep=lambda s: None)
    with pytest.raises(RuntimeError):
        fetch("http://x")


def test_frame_below_coverage_floor_is_skipped(tmp_path: Path) -> None:
    # Half the grid has data → below the 60% floor → frame not published
    # (a hole-y forecast layer erodes trust more than no layer).
    def fn(lat: float, lon: float, when: datetime) -> FakeSample:
        if lon < 0:
            return FakeSample(40.0)
        return FakeSample(50.0, "gfs-forecast-no-data")

    assert fc.write_frames(tmp_path, NOW, sampler=FakeSampler(fn)) is None


# ---------------------------------------------------------------------------
# write_frames — publish atomicity, gating, prune
# ---------------------------------------------------------------------------

def test_write_frames_publishes_run_dir_with_index(tmp_path: Path) -> None:
    index = fc.write_frames(tmp_path, NOW, sampler=FakeSampler())
    assert index is not None
    assert index["gfs_run"] == "2026-06-10T00:00:00Z"
    assert index["prefix"] == "clouds-fcst/20260610T000000Z"
    assert index["max_zoom"] == 3
    assert len(index["valid_times"]) == 21

    run_dir = tmp_path / "clouds-fcst" / "20260610T000000Z"
    assert (run_dir / "index.json").is_file()
    # Manifest index ↔ written dirs agree exactly
    frame_dirs = sorted(d.name for d in run_dir.iterdir() if d.is_dir())
    expected = sorted(
        fc.compact_key(datetime.fromisoformat(t.replace("Z", "+00:00")))
        for t in index["valid_times"]
    )
    assert frame_dirs == expected
    # 85 tiles per frame at {z}/{x}/{y}.png
    sample_frame = run_dir / frame_dirs[0]
    assert len(list(sample_frame.rglob("*.png"))) == 85
    assert (sample_frame / "3" / "7" / "0.png").is_file()
    # No tmp leftovers (atomic rename published the whole dir)
    assert not list((tmp_path / "clouds-fcst").glob("*.tmp"))


def test_write_frames_skips_when_run_already_rendered(tmp_path: Path) -> None:
    s1 = FakeSampler()
    first = fc.write_frames(tmp_path, NOW, sampler=s1)
    calls_after_first = s1.calls
    assert calls_after_first > 0

    s2 = FakeSampler()
    second = fc.write_frames(tmp_path, NOW + timedelta(hours=1), sampler=s2)
    assert s2.calls == 0  # run unchanged → no re-render (P2 cadence gate)
    assert second == first


def test_write_frames_new_run_renders_and_prunes(tmp_path: Path) -> None:
    fc.write_frames(tmp_path, NOW, sampler=FakeSampler())                        # 00Z 06-10
    fc.write_frames(tmp_path, NOW + timedelta(hours=12), sampler=FakeSampler())  # 12Z 06-10
    fc.write_frames(tmp_path, NOW + timedelta(hours=24), sampler=FakeSampler())  # 00Z 06-11
    runs = sorted(d.name for d in (tmp_path / "clouds-fcst").iterdir())
    assert runs == ["20260610T120000Z", "20260611T000000Z"]  # KEEP_RUNS=2


def test_write_frames_returns_none_when_no_data(tmp_path: Path) -> None:
    dead = FakeSampler(lambda lat, lon, when: FakeSample(50.0, "gfs-forecast-no-data"))
    assert fc.write_frames(tmp_path, NOW, sampler=dead) is None
    # Nothing published → next tick retries; manifest omits the key (A4).
    assert not (tmp_path / "clouds-fcst" / "20260610T000000Z").exists()


def test_write_frames_omits_individual_empty_frames(tmp_path: Path) -> None:
    run = fc.latest_gfs_run(NOW)
    horizon = run + timedelta(hours=24)

    def fn(lat: float, lon: float, when: datetime) -> FakeSample:
        if when > horizon:
            return FakeSample(50.0, "gfs-forecast-out-of-horizon")
        return FakeSample(42.0)

    index = fc.write_frames(tmp_path, NOW, sampler=FakeSampler(fn))
    assert index is not None
    offsets = [
        (datetime.fromisoformat(t.replace("Z", "+00:00")) - run).total_seconds() / 3600
        for t in index["valid_times"]
    ]
    assert max(offsets) == 24  # frames past the data horizon are omitted
    assert len(offsets) == 13  # 0..6 hourly + 9..24 3-hourly


def test_prune_removes_incomplete_crashed_renders(tmp_path: Path) -> None:
    root = tmp_path / "clouds-fcst"
    crashed = root / "20260609T120000Z"
    crashed.mkdir(parents=True)  # no index.json → incomplete
    fc.write_frames(tmp_path, NOW, sampler=FakeSampler())
    assert not crashed.exists()
    assert (root / "20260610T000000Z" / "index.json").is_file()


# ---------------------------------------------------------------------------
# Flag default
# ---------------------------------------------------------------------------

def test_flag_defaults_off(monkeypatch: pytest.MonkeyPatch) -> None:
    from generator.config import Settings

    monkeypatch.delenv("OPD_ENABLE_FORECAST_CLOUDS", raising=False)
    assert Settings.from_env().enable_forecast_clouds is False
    monkeypatch.setenv("OPD_ENABLE_FORECAST_CLOUDS", "1")
    assert Settings.from_env().enable_forecast_clouds is True


# ---------------------------------------------------------------------------
# run_tick wiring (ship coverage audit 2026-06-10): the flag gate, the
# manifest extra, and the failure→omit path — the seam between this module
# and the tick that no unit above exercises.
# ---------------------------------------------------------------------------

@pytest.fixture
def cached_tle(settings_in_tmp: Any) -> Path:
    """Pre-seed the TLE cache so run_tick doesn't need network (mirrors
    the test_main.py fixture — local to that module, so re-declared)."""
    from tests.test_main import SAMPLE_TLE_TEXT
    settings_in_tmp.cache_dir.mkdir(parents=True, exist_ok=True)
    cache = settings_in_tmp.cache_dir / "iss.tle"
    cache.write_text(SAMPLE_TLE_TEXT)
    return cache


def test_run_tick_flag_on_adds_manifest_index(
    settings_in_tmp: Any, cached_tle: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from dataclasses import replace
    from generator import forecast_clouds as fc_mod
    from generator.main import run_tick

    stub_index = {
        "gfs_run": "2024-10-17T00:00:00Z",
        "prefix": "clouds-fcst/20241017T000000Z",
        "valid_times": ["2024-10-17T00:00:00Z"],
        "max_zoom": 3,
    }
    calls: list[Path] = []

    def fake_write_frames(out_dir: Path, now: datetime, **_: Any) -> dict[str, Any]:
        calls.append(out_dir)
        return stub_index

    monkeypatch.setattr(fc_mod, "write_frames", fake_write_frames)
    settings = replace(settings_in_tmp, enable_forecast_clouds=True)
    manifest = run_tick(settings, now=datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC))
    assert manifest["forecast_clouds"] == stub_index
    assert calls == [settings.out_dir]


def test_run_tick_flag_off_omits_manifest_index(
    settings_in_tmp: Any, cached_tle: Path,
) -> None:
    from generator.main import run_tick

    manifest = run_tick(settings_in_tmp, now=datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC))
    assert "forecast_clouds" not in manifest


def test_run_tick_render_failure_omits_key_and_does_not_fail_tick(
    settings_in_tmp: Any, cached_tle: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from dataclasses import replace
    from generator import forecast_clouds as fc_mod
    from generator.main import run_tick

    def explode(*_: Any, **__: Any) -> dict[str, Any]:
        raise RuntimeError("open-meteo melted")

    monkeypatch.setattr(fc_mod, "write_frames", explode)
    settings = replace(settings_in_tmp, enable_forecast_clouds=True)
    manifest = run_tick(settings, now=datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC))
    # Locked A4: failures omit the key; the tick itself must survive.
    assert "forecast_clouds" not in manifest
    assert manifest["version"] == "20241017T120000Z"
