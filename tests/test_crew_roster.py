"""Crew roster profiles score data/crew-roster with no Worker request.

The rows match frontend/test/crew-roster.test.ts so a queue row and its map
ring share one id. Edit both tables together."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NoReturn
from unittest.mock import patch

import pytest
import requests

from generator import multiplex
from generator.config import PROFILE_API_BASE, PROFILE_NAMES, Settings
from generator.main import run_tick
from generator.multiplex import fetch_profile_targets, profile_names, roster_profiles
from tests.conftest import SAMPLE_TLE_TEXT

Row = tuple[str, str, float, float, int]

WATKINS: list[Row] = [
    ("personal:watkins:lafayette-colorado-hometown", "Lafayette, Colorado hometown", 39.994, -105.09, 5),
    ("personal:watkins:boulder-and-the-flatirons-colorado", "Boulder and the Flatirons, Colorado", 40.015, -105.271, 4),
    ("personal:watkins:south-san-francisco-bay-stanford-and-moffett-field", "South San Francisco Bay, Stanford and Moffett Field", 37.444, -122.16, 4),
    ("personal:watkins:los-angeles-basin-ucla-and-pasadena", "Los Angeles basin, UCLA and Pasadena", 34.054, -118.243, 4),
    ("personal:watkins:hanksville-and-mars-desert-research-station-terrain-utah", "Hanksville and Mars Desert Research Station terrain, Utah", 38.405, -110.79, 5),
    ("personal:watkins:florida-keys-aquarius-and-conch-reef", "Florida Keys, Aquarius and Conch Reef", 24.95, -80.453, 5),
    ("personal:watkins:grand-canyon-arizona", "Grand Canyon, Arizona", 36.308, -112.293, 5),
    ("personal:watkins:yosemite-valley-and-central-sierra-nevada-california", "Yosemite Valley and central Sierra Nevada, California", 37.733, -119.606, 4),
    ("personal:watkins:death-valley-california", "Death Valley, California", 36.47, -117.088, 5),
    ("personal:watkins:houston-and-galveston-bay-texas", "Houston and Galveston Bay, Texas", 29.57, -94.937, 3),
    ("personal:watkins:cape-canaveral-and-kennedy-space-center-coastline-florida", "Cape Canaveral and Kennedy Space Center coastline, Florida", 28.607, -80.604, 3),
    ("personal:watkins:dubai-united-arab-emirates", "Dubai, United Arab Emirates", 25.265, 55.292, 4),
]

KUTRYK: list[Row] = [
    ("personal:kutryk:beauvallon-and-eastern-alberta-farmland-oblique-only", "Beauvallon and eastern Alberta farmland (oblique only)", 53.659, -111.366, 5),
    ("personal:kutryk:fort-saskatchewan-and-north-saskatchewan-river-oblique-only", "Fort Saskatchewan and North Saskatchewan River (oblique only)", 53.713, -113.215, 4),
    ("personal:kutryk:cold-lake-and-its-lakeshore-city-oblique-only", "Cold Lake and its lakeshore city (oblique only)", 54.531, -110.066, 5),
    ("personal:kutryk:saguenay-fjord-and-la-baie", "Saguenay Fjord and La Baie", 48.33, -70.869, 4),
    ("personal:kutryk:kingston-waterfront-and-royal-military-college-setting", "Kingston waterfront and Royal Military College setting", 44.231, -76.481, 4),
    ("personal:kutryk:rogers-dry-lake-and-edwards-region", "Rogers Dry Lake and Edwards region", 34.935, -117.833, 5),
    ("personal:kutryk:houston-clear-lake-and-galveston-bay-region", "Houston Clear Lake and Galveston Bay region", 29.578, -95.131, 4),
    ("personal:kutryk:mistastin-lake-also-called-kamestastin-oblique-only", "Mistastin Lake, also called Kamestastin (oblique only)", 55.89, -63.269, 5),
    ("personal:kutryk:slovenian-karst-and-divaca-region-caves-connection", "Slovenian Karst and Divača region, CAVES connection", 45.683, 13.969, 4),
    ("personal:kutryk:meteor-crater-arizona", "Meteor Crater, Arizona", 35.027, -111.018, 5),
    ("personal:kutryk:cape-canaveral-and-florida-space-coast", "Cape Canaveral and Florida Space Coast", 28.451, -80.528, 4),
]

DELANEY: list[Row] = [
    ("personal:delaney:debary-st-johns-river-and-lake-monroe-florida", "DeBary, St. Johns River and Lake Monroe, Florida", 28.883, -81.309, 5),
    ("personal:delaney:cape-canaveral-and-kennedy-space-center-coast-florida", "Cape Canaveral and Kennedy Space Center coast, Florida", 28.451, -80.528, 5),
    ("personal:delaney:university-of-north-florida-and-jacksonville-florida", "University of North Florida and Jacksonville, Florida", 30.269, -81.51, 5),
    ("personal:delaney:miami-and-biscayne-bay-florida", "Miami and Biscayne Bay, Florida", 25.774, -80.194, 4),
    ("personal:delaney:hampton-and-hampton-roads-virginia", "Hampton and Hampton Roads, Virginia", 37.026, -76.344, 5),
    ("personal:delaney:patuxent-river-mouth-and-southern-chesapeake-bay-maryland", "Patuxent River mouth and southern Chesapeake Bay, Maryland", 38.318, -76.456, 4),
    ("personal:delaney:quantico-region-and-potomac-river-virginia", "Quantico region and Potomac River, Virginia", 38.522, -77.291, 4),
    ("personal:delaney:pensacola-bay-and-gulf-barrier-islands-florida", "Pensacola Bay and Gulf barrier islands, Florida", 30.368, -87.201, 4),
    ("personal:delaney:corpus-christi-bay-and-padre-island-coast-texas", "Corpus Christi Bay and Padre Island coast, Texas", 27.786, -97.258, 4),
    ("personal:delaney:san-diego-bay-and-pacific-coastline-california", "San Diego Bay and Pacific coastline, California", 32.65, -117.134, 4),
    ("personal:delaney:okinawa-island-and-adjacent-reefs-japan", "Okinawa island and adjacent reefs, Japan", 26.475, 127.912, 5),
]


@pytest.fixture
def no_requests() -> Iterator[None]:
    with patch("generator.multiplex.requests.get", side_effect=AssertionError("crew roster made a request")):
        yield


def _rows(targets: list[dict[str, Any]]) -> list[Row]:
    return [(t["id"], t["name"], t["geom"]["lat"], t["geom"]["lon"], t["priority"]) for t in targets]


@pytest.mark.usefixtures("no_requests")
@pytest.mark.parametrize("token", [None, "test-token"], ids=["no-token", "token"])
def test_kutryk_scores_the_eleven_sites_in_kutryk_csv_without_the_network(
    monkeypatch: pytest.MonkeyPatch, token: str | None,
) -> None:
    if token is None:
        monkeypatch.delenv("OPD_CALIB_TOKEN", raising=False)
    else:
        monkeypatch.setenv("OPD_CALIB_TOKEN", token)
    out = fetch_profile_targets("kutryk")
    assert out["source"] == "roster"
    assert out["removed_curated_ids"] == []
    assert _rows(out["targets"]) == KUTRYK


@pytest.mark.usefixtures("no_requests")
def test_watkins_scores_the_twelve_sites_in_watkins_csv() -> None:
    assert _rows(fetch_profile_targets("watkins")["targets"]) == WATKINS


@pytest.mark.usefixtures("no_requests")
def test_delaney_scores_the_eleven_sites_in_delaney_csv() -> None:
    assert _rows(fetch_profile_targets("delaney")["targets"]) == DELANEY


@pytest.mark.usefixtures("no_requests")
def test_a_roster_site_is_a_daemon_target() -> None:
    assert fetch_profile_targets("kutryk")["targets"][8] == {
        "id": "personal:kutryk:slovenian-karst-and-divaca-region-caves-connection",
        "name": "Slovenian Karst and Divača region, CAVES connection",
        "geom": {"type": "point", "lat": 45.683, "lon": 13.969},
        "regime": "any",
        "priority": 4,
        "_source": "personal",
        "_profile": "kutryk",
    }


def test_the_roster_is_multiplexed_after_the_configured_profiles() -> None:
    assert roster_profiles() == ("watkins", "kutryk", "delaney")
    assert profile_names() == (*PROFILE_NAMES, "watkins", "kutryk", "delaney")
    assert set(roster_profiles()).isdisjoint(PROFILE_NAMES)


def test_an_unreadable_roster_json_multiplexes_only_the_configured_profiles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "roster.json").write_text('[{"name": "kutryk"', encoding="utf-8")
    monkeypatch.setattr(multiplex, "_ROSTER_DIR", tmp_path)
    assert profile_names() == PROFILE_NAMES


def test_a_roster_json_entry_that_cannot_name_an_artifact_is_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    entries = [
        {"name": "kutryk"},
        {"name": "kutryk"},
        {"name": "../passes"},
        {"name": "delaney\n"},
        {"name": "Delaney"},
        "watkins",
        {"name": "watkins"},
    ]
    (tmp_path / "roster.json").write_text(json.dumps(entries), encoding="utf-8")
    monkeypatch.setattr(multiplex, "_ROSTER_DIR", tmp_path)
    assert roster_profiles() == ("kutryk", "watkins")


@pytest.mark.usefixtures("no_requests")
def test_a_bad_csv_row_is_dropped_and_a_bom_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "roster.json").write_text('[{"name": "kutryk"}]', encoding="utf-8")
    (tmp_path / "kutryk.csv").write_text(
        "\ufeffname,lat,lon,priority\r\n"
        "Meteor Crater,35.027,-111.018,5\r\n"
        "Cold Lake,95,-110.066,5\r\n"
        "Saguenay Fjord,48.33,-70.869,high\r\n"
        "沖縄,26.475,127.912,5\r\n"
        "Rogers Dry Lake,34.935\r\n",
        encoding="utf-8",
        newline="",
    )
    monkeypatch.setattr(multiplex, "_ROSTER_DIR", tmp_path)
    assert _rows(fetch_profile_targets("kutryk")["targets"]) == [
        ("personal:kutryk:meteor-crater", "Meteor Crater", 35.027, -111.018, 5),
    ]


def test_run_tick_writes_roster_artifacts_with_no_worker_request(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings_in_tmp.cache_dir.mkdir(parents=True, exist_ok=True)
    (settings_in_tmp.cache_dir / "iss.tle").write_text(SAMPLE_TLE_TEXT)
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    monkeypatch.setattr(multiplex, "PROFILE_NAMES", ("jack",))
    requested: list[str] = []

    def offline_get(url: str, *_args: Any, **_kwargs: Any) -> NoReturn:
        requested.append(url)
        raise requests.ConnectionError("offline")

    with patch("generator.multiplex.requests.get", side_effect=offline_get):
        manifest = run_tick(settings_in_tmp, now=datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC))

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    target_counts = {
        name: json.loads((v_dir / f"status_{name}.json").read_text())["target_count"]
        for name in manifest["artifacts"]["profiles"]
    }
    assert target_counts == {"jack": 3, "watkins": 15, "kutryk": 14, "delaney": 14}
    assert [url for url in requested if "/api/profiles/" in url] == [
        f"{PROFILE_API_BASE}/api/profiles/jack/targets",
    ]
