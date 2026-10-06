"""The 2026-10-06 horizon, replayed, lists seven G1 launches and no chances."""

from __future__ import annotations

import copy
import json
from datetime import UTC, datetime
from pathlib import Path

from generator.launch_evidence import build_launch_artifact
from generator.orbit import TLE

NOW = datetime(2026, 10, 6, 7, 22, 53, tzinfo=UTC)
CENSUS = Path(__file__).parent / "fixtures" / "ll2-2.3.0-g1-census.json"
TLE_PATH = Path(__file__).parent / "fixtures" / "iss-2026-10-05.tle"
PUBLISHED = Path(__file__).parent.parent / "frontend" / "test" / "fixtures" / "g1-census-artifact.json"
G1_NAMES = [
    "Nuri | NeonSat-2 to 6",
    "Falcon 9 Block 5 | SDA Tranche 1 Transport Layer A",
    "Long March 12 | Unknown Payload",
    "Falcon 9 Block 5 | Starlink Group 15-25",
    "Falcon 9 Block 5 | Dragon CRS-2 SpX-35",
    'Falcon 9 Block 5 | USSF-xxx ("TH-2")',
    "H3-24 | Martian Moon eXplorer (MMX)",
]


def _payload() -> dict:
    payload = json.loads(CENSUS.read_text())
    base = copy.deepcopy(payload["results"][0])
    year = copy.deepcopy(base)
    year.update(
        id="synthetic-year",
        name="synthetic: year placeholder",
        status={"abbrev": "TBD", "name": "To Be Determined"},
        net_precision={"name": "Year", "abbrev": "Y"},
        net="2026-10-12T00:00:00Z",
        window_start="2026-10-12T00:00:00Z",
        window_end="2026-10-12T00:00:00Z",
        last_updated="2026-10-01T00:00:00Z",
    )
    day = copy.deepcopy(base)
    day.update(
        id="synthetic-day",
        name="synthetic: day precision",
        status={"abbrev": "Go", "name": "Go for Launch"},
        net_precision={"name": "Day", "abbrev": "D"},
        net="2026-10-11T00:00:00Z",
        window_start="2026-10-11T00:00:00Z",
        window_end="2026-10-11T00:00:00Z",
        last_updated="2026-10-01T00:00:00Z",
    )
    payload["results"].extend([year, day])
    payload["count"] = len(payload["results"])
    return payload


def _g1(item: dict) -> bool:
    precision = (item["launch_window"]["precision"] or "").lower()
    return precision in {"second", "minute", "hour"} and "LAUNCH_UNCONFIRMED" not in item["reason_codes"]


def test_saved_horizon_lists_seven_g1_launches_and_no_chances() -> None:
    tle = TLE.from_text(TLE_PATH.read_text())
    artifact = build_launch_artifact(_payload(), tle, NOW, fetched_at=NOW)
    assert artifact["coverage"]["until"] == "2026-10-20T07:22:53Z"
    assert "FEED_PAGINATED" not in artifact["coverage"]["reasons"]
    listed = [item for item in artifact["items"] if _g1(item)]
    assert [item["name"] for item in listed] == G1_NAMES
    assert all(item["assessment"]["net"]["verdict"] != "possible" for item in artifact["items"])
    published = json.loads(PUBLISHED.read_text())
    assert [item["event_id"] for item in published["items"]] == [item["event_id"] for item in artifact["items"]]
    assert [item["launch_window"]["precision"] for item in published["items"]] == [
        item["launch_window"]["precision"] for item in artifact["items"]
    ]
    assert [item["reason_codes"] for item in published["items"]] == [
        item["reason_codes"] for item in artifact["items"]
    ]
