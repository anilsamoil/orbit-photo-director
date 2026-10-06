"""Baseline for the saved 2026-10-06 launch feed."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta

import pytest

from scripts.launch_census import (
    FIXTURE_DIR,
    base_rates,
    census_from,
    format_census,
    load_replay,
    main,
    shown_launch_ids,
    tle_checksum_digit,
)

FEED_SHA256 = "737e328c70b8d228e0e4e97fc49b2c4be8951a1dfb43785c5592b8e508512c19"


def _chance_artifact(now: datetime, net: datetime, verdict: str, look, window: str = "unknown") -> dict:
    stamp = now.isoformat().replace("+00:00", "Z")
    net_stamp = net.isoformat().replace("+00:00", "Z")
    end = (net + timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
    return {
        "generated_at": stamp,
        "valid_until": (now + timedelta(minutes=15)).isoformat().replace("+00:00", "Z"),
        "coverage": {
            "from": stamp,
            "until": (now + timedelta(days=7)).isoformat().replace("+00:00", "Z"),
            "fetched_at": stamp,
            "reasons": ["FEED_PAGINATED"],
            "complete": False,
        },
        "items": [
            {
                "event_id": "go",
                "status": "map_only",
                "reason_codes": ["FEED_PAGINATED", "VALIDATION_PENDING"],
                "launch_window": {
                    "net": net_stamp,
                    "start": net_stamp,
                    "end": end,
                    "precision": "Second",
                },
                "sources": [{"fetched_at": stamp}],
                "assessment": {
                    "checked_at": stamp,
                    "valid_until": (now + timedelta(hours=3)).isoformat().replace("+00:00", "Z"),
                    "net": {"verdict": verdict, "at": net_stamp, "look": look},
                    "window": {"verdict": window},
                },
            }
        ],
    }


def test_saved_feed_shows_nothing_and_counts_seven_g1() -> None:
    payload, tle, now = load_replay(FIXTURE_DIR)
    report = census_from(payload, tle, now)
    text = format_census(report)
    print(text)
    assert "tier_watch 7" in text
    assert report.rows_received == 100
    assert report.rows_in_14_days == 7
    assert report.g1_pass == 7
    assert report.shown_map == 0
    assert report.shown_upcoming == 0
    assert report.shown_iss == 0
    assert report.tiers.as_dict() == {
        "shot": 0,
        "likely": 0,
        "watch": 7,
        "unassessed": 0,
        "none": 0,
    }
    assert "research-only" in report.research_rule
    assert "uncalibrated" in report.research_rule
    assert "3500" in report.research_rule
    assert "night_engine" in report.research_rule


def test_chance_list_keeps_a_possible_pad_and_drops_too_far() -> None:
    now = datetime(2026, 10, 6, 12, tzinfo=UTC)
    look = {"frame": "orbital-lvlh", "azimuth_deg": 10.0, "off_nadir_deg": 20.0}
    near = _chance_artifact(now, now + timedelta(hours=1), "possible", look)
    assert shown_launch_ids(near, now, "map") == ("go",)
    assert shown_launch_ids(near, now, "upcoming") == ("go",)
    later = _chance_artifact(now, now + timedelta(hours=40), "possible", look)
    assert shown_launch_ids(later, now, "map") == ("go",)
    assert shown_launch_ids(later, now, "upcoming") == ()
    hidden = _chance_artifact(now, now + timedelta(hours=1), "possible", look, window="too_far")
    assert shown_launch_ids(hidden, now, "map") == ()
    assert shown_launch_ids(_chance_artifact(now, now + timedelta(hours=1), "possible", None), now, "map") == ()
    assert shown_launch_ids(_chance_artifact(now, now + timedelta(hours=1), "too_far", look), now, "map") == ()


def test_feed_receipt_and_tle_checksum() -> None:
    raw = (FIXTURE_DIR / "launches.json").read_bytes()
    receipt = json.loads((FIXTURE_DIR / "launches.json.receipt.json").read_text())
    assert hashlib.sha256(raw).hexdigest() == receipt["sha256"] == FEED_SHA256
    lines = (FIXTURE_DIR / "iss.tle").read_text().strip().splitlines()
    assert [tle_checksum_digit(line) for line in lines] == [3, 5]
    assert [line[-1] for line in lines] == ["3", "5"]
    broken = lines[0][:-1] + ("0" if lines[0][-1] != "0" else "1")
    assert tle_checksum_digit(broken) != int(broken[-1])


def test_eol_cases_keep_only_opened_frames() -> None:
    cases = json.loads((FIXTURE_DIR / "eol_cases.json").read_text())["cases"]
    by_id = {case["case_id"]: case for case in cases}
    assert set(by_id) == {
        "oa-4",
        "ms-15",
        "ms-17",
        "ms-22",
        "starship-flight-6",
        "new-glenn-ng-1",
    }
    opened = by_id["oa-4"]
    assert opened["status"] == "measured"
    assert opened["frame_id"] == "ISS045-E-168055"
    assert opened["url"] == (
        "https://eol.jsc.nasa.gov/SearchPhotos/photo.pl?mission=ISS045&roll=E&frame=168055"
    )
    assert opened["iss_nadir_lat"] == 45.2
    assert opened["iss_nadir_lon"] == -48.2
    assert opened["focal_length_mm"] == 1150
    assert by_id["ms-15"]["frame_id"] == "ISS060-E-80405"
    assert by_id["starship-flight-6"]["frame_id"] == "ISS072-E-220043"
    for case in cases:
        if case["status"] == "TODO":
            assert case["frame_id"] is None
            assert case["url"] is None
            assert case["iss_nadir_lat"] is None
            continue
        assert case["frame_id"]
        assert case["url"].startswith("https://eol.jsc.nasa.gov/SearchPhotos/photo.pl?")
        assert case["iss_nadir_lat"] is not None
        assert case["iss_nadir_lon"] is not None
        assert case["focal_length_mm"] is not None


def test_base_rate_is_deterministic_for_a_fixed_seed() -> None:
    _payload, tle, now = load_replay(FIXTURE_DIR)
    first = base_rates(tle, samples=4, seed=1, start=now)
    second = base_rates(tle, samples=4, seed=1, start=now)
    expected = (
        ("Cape Canaveral 28.6N", 4, 0, 0, 0),
        ("Vandenberg 34.6N", 4, 0, 0, 0),
        ("Baikonur 46.0N", 4, 1, 0, 0),
        ("Wenchang 19.6N", 4, 0, 0, 0),
        ("Kourou 5.3N", 4, 1, 0, 0),
        ("Mahia 39.3S", 4, 0, 0, 0),
    )
    assert first == second
    assert tuple(
        (rate.name, rate.samples, rate.line_of_sight, rate.slant_under_1500, rate.slant_under_1000)
        for rate in first
    ) == expected


def test_base_rate_flag_prints_the_same_rows_twice(capsys) -> None:
    args = ["--base-rate", "--base-rate-n", "4", "--seed", "1"]
    assert main(args) == 0
    first = capsys.readouterr().out
    assert main(args) == 0
    second = capsys.readouterr().out
    assert first == second
    assert "tier_watch 7" in first
    assert "base_rate Baikonur 46.0N n=4 los=1 under_1500=0 under_1000=0" in first


def test_base_rate_n_rejects_zero() -> None:
    with pytest.raises(SystemExit, match="at least 1"):
        main(["--base-rate-n", "0"])
