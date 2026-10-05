from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from generator.config import Settings
from generator.main import run_tick
from generator.orbit import TLE
from generator.tle_sources import TleSources
from generator.tracked import (
    STARSHIP,
    TrackedElements,
    TrackedSpec,
    TrackedUnavailable,
    canonical_intldes,
    parse_element_sets,
    query_urls,
    resolve_spec,
)
from tests.conftest import SAMPLE_TLE_TEXT
from tests.tle_fakes import FakeClock, TextStream

GetText = Callable[[str, float], tuple[int, str]]


def _lines(text: str = SAMPLE_TLE_TEXT) -> tuple[str, str]:
    data = [ln.strip() for ln in text.splitlines() if ln.strip().startswith(("1 ", "2 "))]
    return data[0], data[1]


def named(name: str, text: str = SAMPLE_TLE_TEXT) -> str:
    line1, line2 = _lines(text)
    return f"{name}\n{line1}\n{line2}\n"


def later_epoch(text: str = SAMPLE_TLE_TEXT) -> str:
    return text.replace("24290.79041667", "24291.20000000")


def seed_iss(settings: Settings) -> None:
    settings.cache_dir.mkdir(parents=True, exist_ok=True)
    (settings.cache_dir / "iss.tle").write_text(SAMPLE_TLE_TEXT)


def _bind(
    cache: Path,
    get: GetText,
    clock: FakeClock | None = None,
) -> tuple[TleSources, FakeClock]:
    clock = clock or FakeClock(datetime(2026, 10, 5, tzinfo=UTC))

    def transport(url: str, budget_s: float) -> TextStream:
        status, text = get(url, budget_s)
        return TextStream(text, status=status)

    return TleSources(cache, clock=clock, transport=transport), clock


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("2026-159A", "26159A"),
        ("1998-067A", "98067A"),
        ("98067A", "98067A"),
        ("26159A", "26159A"),
    ],
)
def test_international_designator_forms(raw: str, want: str) -> None:
    assert canonical_intldes(raw) == want


def test_parse_keeps_every_named_set() -> None:
    body = named("STARLINK-38123") + named("STARSHIP S41")
    found = parse_element_sets(body, "gp")
    assert [element.name for element in found] == ["STARLINK-38123", "STARSHIP S41"]
    assert found[1].norad == 25544
    assert found[1].intldes == "98067A"


@pytest.mark.parametrize("name", ["STARSHIP", "STARSHIP S41", "starship", "SHIP 41", "SHIP-41"])
def test_starship_names_match(name: str, tmp_path: Path) -> None:
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch

    def get(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        return 200, named("STARLINK-38123") + named(name)

    sources, _clock = _bind(tmp_path, get)
    record = resolve_spec(STARSHIP, tmp_path, epoch + timedelta(hours=1), sources)
    assert isinstance(record, TrackedElements)
    assert record.elements.name == name
    assert record.elements.line1.startswith("1 25544U")


def test_starlink_is_not_starship(tmp_path: Path) -> None:
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch

    def get(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        return 200, named("STARLINK-38123")

    sources, _clock = _bind(tmp_path, get)
    record = resolve_spec(STARSHIP, tmp_path, epoch + timedelta(hours=1), sources)
    assert isinstance(record, TrackedUnavailable)
    assert record.reason == "no_public_orbit"


def test_no_public_orbit_when_both_feeds_404(tmp_path: Path) -> None:
    seen: list[str] = []

    def get(url: str, timeout: float) -> tuple[int, str]:
        assert timeout == 15.0
        seen.append(url)
        return 404, "No GP data found"

    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    sources, _clock = _bind(tmp_path, get)
    record = resolve_spec(STARSHIP, tmp_path, epoch + timedelta(hours=1), sources)
    assert isinstance(record, TrackedUnavailable)
    assert record.reason == "no_public_orbit"
    assert seen[0].startswith(
        "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?"
    )
    assert "NAME=STARSHIP" in seen[0]
    assert "FORMAT=TLE" in seen[0]
    assert any(
        url.startswith("https://celestrak.org/NORAD/elements/gp.php?") and "NAME=STARSHIP" in url
        for url in seen
    )
    assert any("NAME=SHIP" in url and "sup-gp.php" in url for url in seen)


def test_answered_queries_are_not_sent_again_within_two_hours(tmp_path: Path) -> None:
    seen: list[str] = []

    def get(url: str, timeout: float) -> tuple[int, str]:
        del timeout
        seen.append(url)
        return 404, "No GP data found"

    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    now = epoch + timedelta(hours=1)
    sources, clock = _bind(tmp_path, get)
    first = resolve_spec(STARSHIP, tmp_path, now, sources)
    assert isinstance(first, TrackedUnavailable)
    assert first.reason == "no_public_orbit"
    assert len(seen) == 4
    seen.clear()
    clock.advance(2 * 3600 - 1)
    second = resolve_spec(STARSHIP, tmp_path, now, sources)
    assert isinstance(second, TrackedUnavailable)
    assert second.reason == "no_public_orbit"
    assert seen == []


def test_queries_are_not_sent_during_backoff(tmp_path: Path) -> None:
    seen: list[str] = []

    def get(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        seen.append("sent")
        raise OSError("celestrak down")

    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    sources, clock = _bind(tmp_path, get)
    first = resolve_spec(STARSHIP, tmp_path, epoch, sources)
    assert isinstance(first, TrackedUnavailable)
    assert first.reason == "lookup_failed"
    assert len(seen) == 4
    seen.clear()
    clock.advance(2 * 3600 - 1)
    second = resolve_spec(STARSHIP, tmp_path, epoch, sources)
    assert isinstance(second, TrackedUnavailable)
    assert second.reason == "lookup_failed"
    assert seen == []


def test_newer_cached_supgp_is_kept_when_gp_is_older(tmp_path: Path) -> None:
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    now = epoch + timedelta(hours=1)
    phase = {"live": True}

    def get(url: str, timeout: float) -> tuple[int, str]:
        del timeout
        if phase["live"]:
            if "sup-gp.php" in url:
                return 200, named("STARSHIP", later_epoch())
            return 200, named("STARSHIP")
        if "sup-gp.php" in url:
            raise OSError("supgp down")
        return 200, named("STARSHIP")

    sources, clock = _bind(tmp_path, get)
    first = resolve_spec(STARSHIP, tmp_path, now, sources)
    assert isinstance(first, TrackedElements)
    assert first.from_cache is False
    assert first.elements.source == "supgp"
    cached_text = (tmp_path / "tracked-starship.json").read_text()
    clock.advance(2 * 3600 + 1)
    phase["live"] = False
    second = resolve_spec(STARSHIP, tmp_path, now, sources)
    assert isinstance(second, TrackedElements)
    assert second.from_cache is True
    assert second.elements.source == "supgp"
    assert second.elements.epoch > epoch
    assert (tmp_path / "tracked-starship.json").read_text() == cached_text


def test_supgp_wins_a_tie_and_a_newer_gp_wins(tmp_path: Path) -> None:
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    now = epoch + timedelta(hours=1)

    def tied(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        return 200, named("STARSHIP")

    tied_sources, _clock = _bind(tmp_path / "tie", tied)
    tied_record = resolve_spec(STARSHIP, tmp_path / "tie", now, tied_sources)
    assert isinstance(tied_record, TrackedElements)
    assert tied_record.elements.source == "supgp"

    def newer_gp(url: str, timeout: float) -> tuple[int, str]:
        del timeout
        if "sup-gp.php" in url:
            return 200, named("STARSHIP")
        return 200, named("STARSHIP", later_epoch())

    newer_sources, _clock = _bind(tmp_path / "newer", newer_gp)
    newer = resolve_spec(STARSHIP, tmp_path / "newer", now, newer_sources)
    assert isinstance(newer, TrackedElements)
    assert newer.elements.source == "gp"
    assert newer.elements.epoch > epoch


def test_aged_out_gp_uses_a_fresher_cached_supgp_while_supgp_rests(tmp_path: Path) -> None:
    later = TLE.from_text(later_epoch()).epoch
    now = later + timedelta(hours=6)
    line1, line2 = _lines(later_epoch())
    cached = json.dumps(
        {"name": "STARSHIP", "line1": line1, "line2": line2, "source": "supgp"}
    )
    (tmp_path / "tracked-starship.json").write_text(cached)
    seen: list[str] = []

    def get(url: str, timeout: float) -> tuple[int, str]:
        del timeout
        seen.append(url)
        return 200, named("STARSHIP")

    sources, clock = _bind(tmp_path, get)
    resting = {
        url: {"attempted_at": clock.now().isoformat(), "failures": 1}
        for source, url in query_urls(STARSHIP)
        if source == "supgp"
    }
    (tmp_path / "tle-sources.json").write_text(
        json.dumps({"version": 1, "sources": resting})
    )
    record = resolve_spec(STARSHIP, tmp_path, now, sources)
    assert isinstance(record, TrackedElements)
    assert record.from_cache is True
    assert record.elements.source == "supgp"
    assert record.elements.line1 == line1
    assert record.age_hours == pytest.approx(6.0)
    assert (tmp_path / "tracked-starship.json").read_text() == cached
    assert seen
    assert all("sup-gp.php" not in url for url in seen)


def test_old_elements_age_out_without_a_line(tmp_path: Path) -> None:
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    now = epoch + timedelta(hours=STARSHIP.max_age_hours + 1)

    def get(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        return 200, named("STARSHIP S41")

    sources, _clock = _bind(tmp_path, get)
    record = resolve_spec(STARSHIP, tmp_path, now, sources)
    assert isinstance(record, TrackedUnavailable)
    assert record.reason == "aged_out"


def test_element_just_inside_the_max_age_is_kept(tmp_path: Path) -> None:
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    now = epoch + timedelta(hours=STARSHIP.max_age_hours - 0.1)

    def get(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        return 200, named("SHIP 41")

    sources, _clock = _bind(tmp_path, get)
    record = resolve_spec(STARSHIP, tmp_path, now, sources)
    assert isinstance(record, TrackedElements)
    assert record.elements.name == "SHIP 41"
    assert record.from_cache is False


def test_last_good_cache_survives_a_404_until_it_ages_out(tmp_path: Path) -> None:
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    young = epoch + timedelta(hours=1)
    calls = {"missing": 0}

    def live(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        return 200, named("STARSHIP")

    def missing(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        calls["missing"] += 1
        return 404, "No GP data found"

    phase = {"get": live}

    def get(url: str, timeout: float) -> tuple[int, str]:
        return phase["get"](url, timeout)

    sources, clock = _bind(tmp_path, get)
    first = resolve_spec(STARSHIP, tmp_path, young, sources)
    assert isinstance(first, TrackedElements)

    clock.advance(2 * 3600 + 1)
    phase["get"] = missing
    cached = resolve_spec(STARSHIP, tmp_path, young, sources)
    assert isinstance(cached, TrackedElements)
    assert cached.from_cache is True
    assert cached.elements.line1 == first.elements.line1
    assert calls["missing"] == 4

    clock.advance(2 * 3600 + 1)
    stale = resolve_spec(
        STARSHIP, tmp_path, epoch + timedelta(hours=STARSHIP.max_age_hours + 1), sources
    )
    assert isinstance(stale, TrackedUnavailable)
    assert stale.reason == "aged_out"


def test_html_200_does_not_replace_the_cached_element_set(tmp_path: Path) -> None:
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    now = epoch + timedelta(hours=1)
    calls = {"html": 0}

    def live(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        return 200, named("STARSHIP")

    def html(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        calls["html"] += 1
        return 200, "<html>nope</html>"

    phase = {"get": live}

    def get(url: str, timeout: float) -> tuple[int, str]:
        return phase["get"](url, timeout)

    sources, clock = _bind(tmp_path, get)
    resolve_spec(STARSHIP, tmp_path, now, sources)
    clock.advance(2 * 3600 + 1)
    phase["get"] = html
    record = resolve_spec(STARSHIP, tmp_path, now, sources)
    assert isinstance(record, TrackedElements)
    assert record.from_cache is True
    assert calls["html"] == 4
    cache = (tmp_path / "tracked-starship.json").read_text()
    assert "STARSHIP" in cache
    assert "<html>" not in cache


def test_lookup_failure_with_no_cache(tmp_path: Path) -> None:
    def get(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        raise OSError("celestrak down")

    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    sources, _clock = _bind(tmp_path, get)
    record = resolve_spec(STARSHIP, tmp_path, epoch, sources)
    assert isinstance(record, TrackedUnavailable)
    assert record.reason == "lookup_failed"


def test_catalog_number_and_cospar_match_without_a_name(tmp_path: Path) -> None:
    spec = TrackedSpec(
        id="probe",
        label="Probe",
        color="#ffffff",
        name_patterns=(),
        name_queries=(),
        max_age_hours=12,
        catnr=25544,
        intldes="1998-067A",
    )
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch

    def get(url: str, timeout: float) -> tuple[int, str]:
        del timeout
        assert "CATNR=25544" in url or "INTDES=1998-067A" in url
        return 200, named("ISS (ZARYA)")

    sources, _clock = _bind(tmp_path, get)
    record = resolve_spec(spec, tmp_path, epoch + timedelta(hours=1), sources)
    assert isinstance(record, TrackedElements)
    assert record.elements.norad == 25544
    assert record.elements.intldes == "98067A"


def test_run_tick_adds_tracked_and_leaves_the_iss_track(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed_iss(settings_in_tmp)
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    now = epoch + timedelta(hours=1)

    def transport(url: str, budget_s: float) -> TextStream:
        del url, budget_s
        return TextStream(named("STARSHIP S41"))

    monkeypatch.setattr("generator.tle_sources.open_http", transport)
    manifest = run_tick(settings_in_tmp, now=now)
    v_dir = settings_in_tmp.out_dir / "v" / manifest["version"]
    track = json.loads((v_dir / "track.json").read_text())
    tracked = json.loads((v_dir / "tracked.json").read_text())
    assert track["tle"]["line1"].startswith("1 25544U")
    assert manifest["tle_epoch"] == track["tle_epoch"]
    for key in ("passes", "top5", "top_24h", "track", "status", "targets", "tracked"):
        assert key in manifest["artifacts"]
    for key in ("version", "generated_at", "tle_epoch", "freshness", "artifacts"):
        assert key in manifest
    row = tracked["objects"][0]
    assert row["state"] == "elements"
    assert row["name"] == "STARSHIP S41"
    assert row["line1"] == track["tle"]["line1"]
    assert "reason" not in row


def test_run_tick_404_publishes_no_public_orbit(settings_in_tmp: Settings) -> None:
    seed_iss(settings_in_tmp)
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    manifest = run_tick(settings_in_tmp, now=epoch + timedelta(hours=1))
    tracked = json.loads(
        (settings_in_tmp.out_dir / "v" / manifest["version"] / "tracked.json").read_text()
    )
    assert tracked["objects"] == [
        {
            "id": "starship",
            "label": "Starship",
            "color": "#ff5c5c",
            "state": "unavailable",
            "reason": "no_public_orbit",
        }
    ]
