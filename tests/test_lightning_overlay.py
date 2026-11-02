from datetime import UTC, datetime, timedelta

import pytest

from generator.lightning import GLM_SUBPOINT_LON, _GLMFlash, _GLMGranule
from generator.lightning_overlay import WINDOW, _cells, build_overlay

END = datetime(2026, 10, 26, 17, tzinfo=UTC)
START = END - WINDOW


def slots():
    return [
        (sat, _GLMGranule(START + timedelta(seconds=i), []))
        for sat in GLM_SUBPOINT_LON for i in range(0, 301, 20)
    ]


def test_only_complete_owned_sectors_can_report_quiet():
    files = slots()
    assert [s["cells"] for s in build_overlay(END, END, files)["sectors"]] == [[], []]
    for omitted in [0, 6, 15]:
        partial = files[:omitted] + files[omitted + 1:]
        assert [s["cells"] for s in build_overlay(END, END, partial)["sectors"]] == [None, []]


def test_sector_mosaic_duplicate_file_and_boundary_flash():
    files = slots()
    copies = [
        _GLMFlash(0, lon, time) for lon, time in [
            (-95, END - timedelta(seconds=1)), (-115, END - timedelta(seconds=1)),
            (-75, END), (-140, START - timedelta(milliseconds=20)),
        ]
    ]
    for index in [15, 31]:
        sat, last = files[index]
        files[index] = sat, _GLMGranule(last.start, copies)
    files.append(files[-1])
    sectors = build_overlay(END, END, files)["sectors"]
    assert [s["cells"] for s in sectors] == [[[-95, 0, 299, 1]], [[-115, 0, 299, 1]]]
    assert build_overlay(END, END, reversed(files))["sectors"] == sectors


def test_expanding_grid_preserves_every_count_and_uses_real_positions():
    flashes = [_GLMFlash(10 + y / 4, -105 + x / 4, START) for x in range(50) for y in range(50)]
    rows = _cells(flashes, START)
    assert len(rows) <= 512
    assert sum(c[-1] for c in rows) == len(flashes)
    assert rows == _cells(list(reversed(flashes)), START)
    positions = {(f.lat, f.lon) for f in flashes}
    assert all((lat, lon) in positions for lon, lat, _, _ in rows)


def test_quality_platform_and_complete_granule_required(tmp_path):
    import netCDF4

    from generator.lightning import _decode_glm_granule

    p = tmp_path / "sector.nc"
    with netCDF4.Dataset(p, "w") as ds:
        ds.time_coverage_start = START.isoformat()
        ds.time_coverage_end = (START + timedelta(seconds=20)).isoformat()
        ds.platform_ID = "G19"
        ds.createVariable("percent_uncorrectable_L0_errors", "f4")[()] = 0
        ds.createVariable("percent_navigated_L1b_events", "f4")[()] = 1
        ds.createDimension("flashes", 3)
        for field in ["flash_lat", "flash_lon", "flash_time_offset_of_first_event", "flash_quality_flag"]:
            ds.createVariable(field, "f4", ("flashes",))
        ds["flash_quality_flag"][:] = [0, 3, 0]
        ds["flash_lat"][:] = [10, 20, 30]
        ds["flash_lon"][:] = [-80, -80, -80]
        ds["flash_time_offset_of_first_event"][:] = [-2, 3, 4]
    data = p.read_bytes()
    assert _decode_glm_granule(data, overlay_platform="G18") is None
    result = _decode_glm_granule(data, overlay_platform="G19")
    assert result and result.flashes == [
        _GLMFlash(10, -80, START - timedelta(seconds=2)),
        _GLMFlash(30, -80, START + timedelta(seconds=4)),
    ]
    with netCDF4.Dataset(p, "a") as ds:
        ds["percent_uncorrectable_L0_errors"][()] = 0.5
    assert _decode_glm_granule(p.read_bytes(), overlay_platform="G19") is None


def test_refresh_atomically_replaces_a_prior_feed_and_refuses_a_second_owner(tmp_path, monkeypatch):
    import fcntl
    import json

    from generator.lightning_overlay import refresh

    monkeypatch.setattr("generator.lightning_overlay._glm_granule_urls", lambda *_: [])
    folder = tmp_path / "lightning"
    folder.mkdir()
    published = folder / "latest.json"
    published.write_text("prior")
    with (folder / ".publisher.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with pytest.raises(BlockingIOError):
            refresh(tmp_path)
        assert published.read_text() == "prior"
    artifact = refresh(tmp_path)
    assert json.loads(published.read_text()) == artifact
    assert all(s["cells"] is None for s in artifact["sectors"])
