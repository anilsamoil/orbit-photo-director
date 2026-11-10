from __future__ import annotations

import json
import math
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import Mock

import pytest

from generator.config import CELESTRAK_ISS_SUPPLEMENTAL_TLE_URL, DEFAULT_TLE_URL, Settings
from generator.main import _parse_iss_supplemental_reply, _tle_checksum_ok, fetch_tle, run_tick
from generator.orbit import TLE, propagate
from generator.tle_sources import TleSources
from tests.test_main import _iss_lines, _resign_tle_line
from tests.tle_fakes import FakeClock, TextStream

NOW = datetime(2026, 10, 25, 12, tzinfo=UTC)
STANDARD = "\n".join(_iss_lines("26297.20915682")) + "\n"


def _segment(epoch: str, counter: int = 1) -> str:
    line1, line2 = _iss_lines(epoch)
    line1 = f"{line1[:7]}C{line1[8:64]}{counter:5d}"
    return f"ISS (ZARYA)\n{line1}\n{line2}\n"


def _sources(cache: Path, body: str, calls: list[str], clock: FakeClock) -> TleSources:
    def transport(url: str, budget_s: float) -> TextStream:
        if url not in DEFAULT_TLE_URL.split(","):
            raise OSError("unavailable in supplemental test")
        assert budget_s == 5
        calls.append(url)
        return TextStream(body if url == CELESTRAK_ISS_SUPPLEMENTAL_TLE_URL else STANDARD)

    return TleSources(cache.parent, clock=clock, transport=transport)


def test_parser_accepts_25544c_and_normalizes_counter_for_propagation() -> None:
    body = _segment("26298.50000000", counter=27)
    assert not _tle_checksum_ok(body.splitlines()[1])
    tle = _parse_iss_supplemental_reply(200, body, NOW)
    assert tle.epoch == NOW
    assert tle.line1.startswith("1 25544C ")
    assert _tle_checksum_ok(tle.line1) and _tle_checksum_ok(tle.line2)
    position = propagate(tle, NOW)
    assert all(math.isfinite(value) for value in (position.lat, position.lon, position.alt_km))
    assert 350 < position.alt_km < 470


@pytest.mark.parametrize("cached_epoch", ["26297.20915682", "26296.20915682"])
def test_stale_standard_uses_closest_supplemental_not_latest(
    tmp_path: Path, cached_epoch: str,
) -> None:
    cache = tmp_path / "iss.tle"
    cache.write_text("\n".join(_iss_lines(cached_epoch)) + "\n")
    body = "".join(_segment(epoch, i) for i, epoch in enumerate([
        "26298.25000000", "26298.50000000", "26298.75000000", "26310.50000000",
    ], 1))
    calls: list[str] = []
    tle = fetch_tle(DEFAULT_TLE_URL, cache, NOW, sources=_sources(cache, body, calls, FakeClock(NOW)))
    assert tle.epoch == NOW
    assert calls[-1] == CELESTRAK_ISS_SUPPLEMENTAL_TLE_URL
    assert TLE.from_text(cache.read_text()) == tle


@pytest.mark.parametrize("body", [
    "bad response",
    _segment("26298.50000000")[:-20],
    _segment("26298.50000000").replace("2 25544", "2 99999"),
    _segment("26298.50000000").replace("15.49814196", "00.00000000"),
    _segment("26298.50000000").replace(".00031560", ".BAD31560"),
    _segment("26298.50000000").replace("00000-0", "AAAAA-0"),
    _segment("26298.50000000").replace("56270-3", "abcde-3"),
    _segment("26310.50000000"),
    _segment("26296.50000000"),
])
def test_malformed_or_distant_supplemental_keeps_cached_tle(tmp_path: Path, body: str) -> None:
    cache = tmp_path / "iss.tle"
    cache.write_text(STANDARD)
    calls: list[str] = []
    tle = fetch_tle(DEFAULT_TLE_URL, cache, NOW, sources=_sources(cache, body, calls, FakeClock(NOW)))
    assert tle == TLE.from_text(STANDARD)
    assert cache.read_text() == STANDARD


@pytest.mark.parametrize("mean_motion", ["01.00000000", "02.00000000"])
def test_supplemental_non_iss_altitude_keeps_cache(tmp_path: Path, mean_motion: str) -> None:
    cache = tmp_path / "iss.tle"
    cache.write_text(STANDARD)
    name, line1, line2 = _segment("26298.50000000").splitlines()
    line2 = _resign_tle_line(f"{line2[:52]}{mean_motion}{line2[63:]}")
    assert _tle_checksum_ok(line2)
    body = f"{name}\n{line1}\n{line2}\n"
    tle = fetch_tle(DEFAULT_TLE_URL, cache, NOW, sources=_sources(cache, body, [], FakeClock(NOW)))
    assert tle == TLE.from_text(STANDARD)
    assert cache.read_text() == STANDARD


@pytest.mark.parametrize("epoch,now", [
    ("26366.50000000", datetime(2027, 1, 1, 12, tzinfo=UTC)),
    ("27000.50000000", datetime(2026, 12, 31, 12, tzinfo=UTC)),
])
def test_supplemental_invalid_calendar_epoch_keeps_cache(
    tmp_path: Path, epoch: str, now: datetime,
) -> None:
    cache = tmp_path / "iss.tle"
    cache.write_text(STANDARD)
    tle = fetch_tle(
        DEFAULT_TLE_URL, cache, now, sources=_sources(cache, _segment(epoch), [], FakeClock(now)),
    )
    assert tle == TLE.from_text(STANDARD)
    assert cache.read_text() == STANDARD


@pytest.mark.parametrize("age_hours,expected_calls", [(24, 3), (24.001, 4)])
def test_supplemental_starts_after_24_hours(
    tmp_path: Path, age_hours: float, expected_calls: int,
) -> None:
    cache = tmp_path / "iss.tle"
    cache.write_text(STANDARD)
    now = TLE.from_text(STANDARD).epoch + timedelta(hours=age_hours)
    calls: list[str] = []
    fetch_tle(DEFAULT_TLE_URL, cache, now, sources=_sources(cache, "invalid", calls, FakeClock(now)))
    assert len(calls) == expected_calls


def test_cached_supplemental_refreshes_after_source_rest(tmp_path: Path) -> None:
    cache = tmp_path / "iss.tle"
    cache.write_text(STANDARD)
    clock = FakeClock(NOW + timedelta(hours=2))
    calls: list[str] = []
    body = _segment("26298.50000000") + _segment("26298.75000000", 2)
    sources = _sources(cache, body, calls, clock)
    first = fetch_tle(DEFAULT_TLE_URL, cache, clock.now(), sources=sources)
    assert first.epoch == NOW
    clock.advance(2 * 3600 - 1)
    assert fetch_tle(DEFAULT_TLE_URL, cache, clock.now(), sources=sources) == first
    assert calls.count(CELESTRAK_ISS_SUPPLEMENTAL_TLE_URL) == 1
    clock.advance(1)
    second = fetch_tle(DEFAULT_TLE_URL, cache, clock.now(), sources=sources)
    assert second.epoch == NOW + timedelta(hours=6)
    assert calls.count(CELESTRAK_ISS_SUPPLEMENTAL_TLE_URL) == 2


def test_tick_publishes_fresh_supplemental_track(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_in_tmp = replace(settings_in_tmp, tle_url=DEFAULT_TLE_URL)
    cache = settings_in_tmp.cache_dir / "iss.tle"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(STANDARD)
    calls: list[str] = []
    sources = _sources(cache, _segment("26298.50000000"), calls, FakeClock(NOW))
    monkeypatch.setattr("generator.main.TleSources", lambda _: sources)
    monkeypatch.setattr(
        "requests.sessions.Session.request",
        Mock(side_effect=OSError("network disabled in supplemental tick test")),
    )
    manifest = run_tick(settings_in_tmp, now=NOW)
    track = json.loads((settings_in_tmp.out_dir / "v" / manifest["version"] / "track.json").read_text())
    assert track["tle_epoch"] == "2026-10-25T12:00:00Z"
    assert track["tle_age_hours"] == 0
    assert track["tle"]["line1"].startswith("1 25544C ")
    assert len(track["track_points"]) > 700


def test_supplemental_recovers_without_cache_when_standard_sources_fail(tmp_path: Path) -> None:
    cache = tmp_path / "iss.tle"

    def transport(url: str, budget_s: float) -> TextStream:
        if url != CELESTRAK_ISS_SUPPLEMENTAL_TLE_URL:
            raise OSError("standard unavailable")
        return TextStream(_segment("26298.50000000"))

    tle = fetch_tle(DEFAULT_TLE_URL, cache, NOW, sources=TleSources(tmp_path, transport=transport))
    assert tle.epoch == NOW
    assert TLE.from_text(cache.read_text()) == tle


def test_fresh_standard_replaces_future_supplemental_even_with_lower_epoch(tmp_path: Path) -> None:
    cache = tmp_path / "iss.tle"
    prior = _parse_iss_supplemental_reply(200, _segment("26298.75000000"), NOW)
    cache.write_text(f"{prior.line1}\n{prior.line2}\n")
    calls: list[str] = []
    fresh = "\n".join(_iss_lines("26298.50000000")) + "\n"

    def transport(url: str, budget_s: float) -> TextStream:
        calls.append(url)
        if url == CELESTRAK_ISS_SUPPLEMENTAL_TLE_URL:
            raise OSError("supplemental unavailable")
        return TextStream(fresh)

    tle = fetch_tle(DEFAULT_TLE_URL, cache, NOW, sources=TleSources(tmp_path, transport=transport))
    assert tle.epoch == NOW
    assert cache.read_text() == fresh
    assert CELESTRAK_ISS_SUPPLEMENTAL_TLE_URL not in calls
