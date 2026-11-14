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
    STARSHIP_FRESH_HOURS,
    STARSHIP_GRACE_HOURS,
    TrackedElements,
    TrackedSpec,
    TrackedUnavailable,
    canonical_intldes,
    load_tracked_specs,
    lookup_json,
    parse_element_sets,
    query_urls,
    resolve_spec,
    unavailable_artifact_text,
    write_tracked_artifact,
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


FIXTURES = Path(__file__).parent.parent / "frontend" / "test" / "fixtures"
CATALOGUE = (FIXTURES / "celestrak-starship-fictional.txt").read_text()
FLIGHT_DAY = datetime(2026, 11, 16, 12, tzinfo=UTC)


def aged(name: str, hours: float) -> str:
    """One object of the fictional catalogue, its epoch `hours` before FLIGHT_DAY."""
    lines = CATALOGUE.splitlines()
    at = lines.index(name)
    line1 = lines[at + 1]
    return f"{name}\n{line1[:18]}26{320.5 - hours / 24:012.8f}{line1[32:]}\n{lines[at + 2]}\n"


def answering(tmp_path: Path, body: dict[str, str]) -> tuple[TleSources, FakeClock]:
    """Every feed answers `body["text"]`, or 404 when it is empty."""

    def get(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        return (200, body["text"]) if body["text"] else (404, "No GP data found")

    return _bind(tmp_path, get)


def unreachable(tmp_path: Path) -> TleSources:
    """Every query fails in transport, on a clock past any rest."""

    def get(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        raise OSError("celestrak down")

    sources, _clock = _bind(tmp_path, get, FakeClock(datetime(2027, 1, 1, tzinfo=UTC)))
    return sources


def seeded(tmp_path: Path, name: str) -> datetime:
    """Caches one catalogue object as the last good set. Returns its epoch."""
    sources, _clock = answering(tmp_path, {"text": aged(name, 0.5)})
    assert names(resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)) == [name]
    return FLIGHT_DAY - timedelta(hours=0.5)


def names(record: object) -> list[str]:
    assert isinstance(record, TrackedElements)
    return [record.elements.name, *(obj.elements.name for obj in record.also)]


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


@pytest.mark.parametrize(
    "name",
    ["STARSHIP", "STARSHIP S41", "starship", "SHIP 41", "SHIP-41", "STARSHIP R/B", "SHIP 91 R/B"],
)
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


def test_starlink_starshield_debris_and_other_ships_are_not_starship(tmp_path: Path) -> None:
    others = [
        "STARLINK-90011",
        "STARSHIELD 12",
        "STARSHIP DEB",
        "SHIP 91 DEB",
        "SPACESHIP NINE",
        "FRIENDSHIP 7",
    ]
    sources, _clock = answering(tmp_path, {"text": "".join(aged(name, 1) for name in others)})
    record = resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)
    assert isinstance(record, TrackedUnavailable)
    assert record.reason == "no_public_orbit"


def test_the_next_flight_is_drawn_and_the_aged_out_one_is_not_listed(tmp_path: Path) -> None:
    sources, _clock = answering(tmp_path, {"text": aged("SHIP 90", 80) + aged("SHIP 91", 1)})
    assert names(resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)) == ["SHIP 91"]


@pytest.mark.parametrize(("older_flight_age", "newer_flight_age"), [(1, 5), (5, 1)])
def test_the_newer_launch_is_drawn_whichever_ship_has_the_newer_epoch(
    older_flight_age: float, newer_flight_age: float, tmp_path: Path
) -> None:
    body = aged("SHIP 90", older_flight_age) + aged("SHIP 91", newer_flight_age)
    sources, _clock = answering(tmp_path, {"text": body})
    assert names(resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)) == ["SHIP 91", "SHIP 90"]


def test_a_ship_is_drawn_before_its_rocket_body_and_the_artifact_lists_both(
    tmp_path: Path,
) -> None:
    sources, _clock = answering(tmp_path, {"text": aged("SHIP 91 R/B", 6) + aged("SHIP 91", 9)})
    dest = tmp_path / "tracked.json"
    write_tracked_artifact(tmp_path, FLIGHT_DAY, dest, sources=sources)
    (row,) = json.loads(dest.read_text())["objects"]
    assert (row["name"], row["norad"], row["age_hours"]) == ("SHIP 91", 90003, 9.0)
    (body,) = row["also"]
    assert body == {
        "source": "supgp",
        "name": "SHIP 91 R/B",
        "norad": 90004,
        "intldes": "26310B",
        "line1": body["line1"],
        "line2": body["line2"],
        "epoch": "2026-11-16T06:00:00Z",
        "age_hours": 6.0,
    }
    assert body["line1"].startswith("1 90004U")


def test_a_single_object_publishes_no_also_list(tmp_path: Path) -> None:
    sources, _clock = answering(tmp_path, {"text": aged("SHIP 91", 1)})
    dest = tmp_path / "tracked.json"
    write_tracked_artifact(tmp_path, FLIGHT_DAY, dest, sources=sources)
    assert "also" not in json.loads(dest.read_text())["objects"][0]


def test_the_whole_catalogue_draws_the_newest_live_ship(tmp_path: Path) -> None:
    sources, _clock = answering(tmp_path, {"text": CATALOGUE})
    record = resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY + timedelta(hours=3), sources)
    assert names(record) == ["SHIP 91", "SHIP 90", "SHIP 91 R/B"]


def test_a_reentered_set_inside_the_age_limit_is_hidden_as_reentered(tmp_path: Path) -> None:
    sources, _clock = answering(tmp_path, {"text": aged("SHIP 92", 3)})
    dest = tmp_path / "tracked.json"
    write_tracked_artifact(tmp_path, FLIGHT_DAY, dest, sources=sources)
    row = json.loads(dest.read_text())["objects"][0]
    assert (row["state"], row["reason"]) == ("unavailable", "reentered")


def test_a_low_perigee_set_still_draws_during_its_first_revolution(tmp_path: Path) -> None:
    sources, _clock = answering(tmp_path, {"text": aged("SHIP 92", 0.5)})
    assert names(resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)) == ["SHIP 92"]


def test_a_cached_older_flight_is_dropped_when_only_the_next_flight_answers(
    tmp_path: Path,
) -> None:
    body = {"text": aged("SHIP 90", 2)}
    sources, clock = answering(tmp_path, body)
    assert names(resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)) == ["SHIP 90"]

    clock.advance(2 * 3600 + 1)
    body["text"] = aged("SHIP 91", 1)
    assert names(resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)) == ["SHIP 91"]
    assert "SHIP 90" not in (tmp_path / "tracked-starship.json").read_text()


def test_a_throttled_tick_serves_every_cached_object(tmp_path: Path) -> None:
    sources, _clock = answering(tmp_path, {"text": aged("SHIP 90", 2) + aged("SHIP 91", 1)})
    first = resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)
    assert isinstance(first, TrackedElements)
    assert (first.from_cache, [obj.from_cache for obj in first.also]) == (False, [False])

    second = resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)
    assert names(second) == ["SHIP 91", "SHIP 90"]
    assert isinstance(second, TrackedElements)
    assert (second.from_cache, [obj.from_cache for obj in second.also]) == (True, [True])


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


def test_elements_past_the_grace_age_out_without_a_line(tmp_path: Path) -> None:
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    now = epoch + timedelta(hours=STARSHIP.grace_hours, seconds=1)

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


def test_starship_is_fresh_for_12_h_and_kept_as_last_good_for_72_h() -> None:
    assert (STARSHIP.max_age_hours, STARSHIP.grace_hours) == (12.0, 72.0)
    assert (STARSHIP_FRESH_HOURS, STARSHIP_GRACE_HOURS) == (12.0, 72.0)


@pytest.mark.parametrize(
    ("age", "drawn"),
    [
        (timedelta(hours=STARSHIP_FRESH_HOURS, seconds=-1), True),
        (timedelta(hours=STARSHIP_FRESH_HOURS, seconds=1), True),
        (timedelta(hours=STARSHIP_GRACE_HOURS, seconds=-1), True),
        (timedelta(hours=STARSHIP_GRACE_HOURS, seconds=1), False),
    ],
)
def test_the_last_good_set_outlives_an_outage_until_the_grace(
    age: timedelta, drawn: bool, tmp_path: Path
) -> None:
    epoch = seeded(tmp_path, "SHIP 91")
    record = resolve_spec(STARSHIP, tmp_path, epoch + age, unreachable(tmp_path))
    if not drawn:
        assert isinstance(record, TrackedUnavailable)
        assert record.reason == "lookup_failed"
        return
    assert names(record) == ["SHIP 91"]
    assert isinstance(record, TrackedElements)
    assert record.from_cache is True
    assert record.age_hours == pytest.approx(age.total_seconds() / 3600)
    assert (record.age_hours > STARSHIP.max_age_hours) == (age > timedelta(hours=12))


def test_a_set_the_feeds_still_list_past_the_fresh_window_is_published_with_its_age(
    tmp_path: Path,
) -> None:
    sources, _clock = answering(tmp_path, {"text": aged("SHIP 91", 13)})
    dest = tmp_path / "tracked.json"
    write_tracked_artifact(tmp_path, FLIGHT_DAY, dest, sources=sources)
    (row,) = json.loads(dest.read_text())["objects"]
    assert (row["state"], row["name"], row["age_hours"]) == ("elements", "SHIP 91", 13.0)
    assert (row["lookup"]["max_age_hours"], row["lookup"]["grace_hours"]) == (12.0, 72.0)


def test_a_cached_set_that_reenters_inside_the_grace_is_dropped(tmp_path: Path) -> None:
    epoch = seeded(tmp_path, "SHIP 92")
    record = resolve_spec(STARSHIP, tmp_path, epoch + timedelta(hours=20), unreachable(tmp_path))
    assert isinstance(record, TrackedUnavailable)
    assert record.reason == "reentered"


def test_a_complete_empty_answer_clears_a_stale_last_good_set(tmp_path: Path) -> None:
    body = {"text": aged("SHIP 91", 0.5)}
    sources, clock = answering(tmp_path, body)
    assert names(resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)) == ["SHIP 91"]

    clock.advance(2 * 3600 + 1)
    body["text"] = ""
    record = resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY + timedelta(hours=20), sources)
    assert isinstance(record, TrackedUnavailable)
    assert record.reason == "no_public_orbit"
    assert not (tmp_path / "tracked-starship.json").exists()


def test_an_object_the_operator_added_has_no_grace_past_its_age_limit(tmp_path: Path) -> None:
    (spec,) = load_tracked_specs(
        _objects_file(tmp_path, [{"id": "station", "label": "Station", "catnr": 25544}])
    )[1:]
    assert spec.grace_hours == spec.max_age_hours == 48.0


def test_a_ship_missing_from_every_answer_is_gone_and_a_throttled_tick_does_not_revive_it(
    tmp_path: Path,
) -> None:
    body = {"text": aged("SHIP 91", 1)}
    sources, clock = answering(tmp_path, body)
    assert names(resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)) == ["SHIP 91"]
    assert (tmp_path / "tracked-starship.json").exists()

    clock.advance(2 * 3600 + 1)
    body["text"] = ""
    gone = resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)
    assert isinstance(gone, TrackedUnavailable)
    assert gone.reason == "no_public_orbit"
    assert not (tmp_path / "tracked-starship.json").exists()

    body["text"] = aged("SHIP 91", 1)
    throttled = resolve_spec(STARSHIP, tmp_path, FLIGHT_DAY, sources)
    assert isinstance(throttled, TrackedUnavailable)
    assert throttled.reason == "no_public_orbit"


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
            "lookup": {
                "names": ["STARSHIP", "SHIP"],
                "patterns": [
                    r"^STARSHIP(?:[\s-]|$)(?!.*\bDEB\b)",
                    r"^SHIP[\s-]+\d+\b(?!.*\bDEB\b)",
                ],
                "max_age_hours": 12.0,
                "grace_hours": 72.0,
            },
        }
    ]


FRONTEND_FALLBACK = FIXTURES / "tracked-lookup-failed.json"


def test_the_frontend_fallback_fixture_is_the_generator_no_data_artifact() -> None:
    assert FRONTEND_FALLBACK.read_text() == unavailable_artifact_text()


def _objects_file(tmp_path: Path, objects: object) -> Path:
    path = tmp_path / "tracked-objects.json"
    path.write_text(json.dumps({"objects": objects}))
    return path


def test_a_missing_objects_file_tracks_only_starship(tmp_path: Path) -> None:
    assert load_tracked_specs(tmp_path / "tracked-objects.json") == (STARSHIP,)


def test_an_object_added_by_catalog_number_is_published_with_its_lookup(tmp_path: Path) -> None:
    specs = load_tracked_specs(
        _objects_file(tmp_path, [{"id": "station", "label": "Station", "catnr": 25544}])
    )
    assert [spec.id for spec in specs] == ["starship", "station"]
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch

    def get(url: str, timeout: float) -> tuple[int, str]:
        del timeout
        if "CATNR=25544" in url:
            return 200, named("ISS (ZARYA)")
        return 404, ""

    sources, _clock = _bind(tmp_path, get)
    dest = tmp_path / "tracked.json"
    write_tracked_artifact(tmp_path, epoch + timedelta(hours=1), dest, sources=sources, specs=specs)
    starship, station = json.loads(dest.read_text())["objects"]
    assert starship["reason"] == "no_public_orbit"
    assert station["state"] == "elements"
    assert station["norad"] == 25544
    assert station["lookup"] == {
        "names": [],
        "patterns": [],
        "max_age_hours": 48.0,
        "grace_hours": 48.0,
        "catnr": 25544,
    }


def test_an_object_added_by_name_matches_that_name_and_not_a_longer_one(tmp_path: Path) -> None:
    specs = load_tracked_specs(
        _objects_file(tmp_path, [{"id": "ship-39", "label": "Ship 39", "names": ["ship 39"]}])
    )
    spec = specs[1]
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch
    assert lookup_json(spec)["names"] == ["SHIP 39"]

    def get(url: str, timeout: float) -> tuple[int, str]:
        del url, timeout
        return 200, named("SHIP 390") + named("SHIP 39 DEB")

    sources, _clock = _bind(tmp_path, get)
    record = resolve_spec(spec, tmp_path, epoch + timedelta(hours=1), sources)
    assert isinstance(record, TrackedElements)
    assert record.elements.name == "SHIP 39 DEB"


@pytest.mark.parametrize(
    "entry",
    [
        {"id": "no-way-to-find", "label": "Nothing"},
        {"id": "Bad Id", "label": "X", "catnr": 5},
        {"id": "zero", "label": "X", "catnr": 0},
        {"id": "starship", "label": "Impostor", "catnr": 5},
        {"id": "tint", "label": "X", "catnr": 5, "color": "red"},
        {"id": "forever", "label": "X", "catnr": 5, "max_age_hours": float("inf")},
        {"id": "nan", "label": "X", "catnr": 5, "max_age_hours": float("nan")},
        {"id": "negative", "label": "X", "catnr": 5, "max_age_hours": -1},
        "not an object",
    ],
)
def test_an_unusable_entry_is_skipped(entry: object, tmp_path: Path) -> None:
    assert load_tracked_specs(_objects_file(tmp_path, [entry])) == (STARSHIP,)


def test_an_unreadable_objects_file_tracks_only_starship(tmp_path: Path) -> None:
    path = tmp_path / "tracked-objects.json"
    path.write_text("{not json")
    assert load_tracked_specs(path) == (STARSHIP,)


def test_run_tick_publishes_an_object_from_the_operator_file(
    settings_in_tmp: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed_iss(settings_in_tmp)
    _objects_file(settings_in_tmp.repo_root, [{"id": "station", "label": "Station", "catnr": 25544}])
    epoch = TLE.from_text(SAMPLE_TLE_TEXT).epoch

    def transport(url: str, budget_s: float) -> TextStream:
        del budget_s
        if "CATNR=25544" in url:
            return TextStream(named("ISS (ZARYA)"))
        return TextStream("No GP data found")

    monkeypatch.setattr("generator.tle_sources.open_http", transport)
    manifest = run_tick(settings_in_tmp, now=epoch + timedelta(hours=1))
    tracked = json.loads(
        (settings_in_tmp.out_dir / "v" / manifest["version"] / "tracked.json").read_text()
    )
    assert [(row["id"], row["state"]) for row in tracked["objects"]] == [
        ("starship", "unavailable"),
        ("station", "elements"),
    ]
    assert tracked["objects"][1]["norad"] == 25544
