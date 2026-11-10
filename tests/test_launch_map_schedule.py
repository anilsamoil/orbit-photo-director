"""Replay catalog-used LL2 2.3 fields captured from the 2026-11-10 feed."""

import json
from datetime import UTC, datetime
from pathlib import Path

from generator.launch_catalog import build_launch_catalog
from generator.launch_publish import _validate_catalog
from generator.orbit import TLE

FIXTURES = Path(__file__).parent / "fixtures"


def test_real_shaped_starship_feed_keeps_tentative_schedule_and_vehicle():
    payload = json.loads((FIXTURES / "ll2-2.3.0-starship-2026-11-10.json").read_text())
    tle = TLE.from_text((FIXTURES / "iss-2026-11-10.txt").read_text())
    now = datetime(2026, 11, 10, 8, 38, 59, tzinfo=UTC)
    fetched = datetime(2026, 11, 10, 8, 32, 5, 283879, tzinfo=UTC)
    catalog = build_launch_catalog(payload, tle, now, fetched_at=fetched)
    _validate_catalog(catalog)
    saved = json.loads(
        (FIXTURES.parent.parent / "frontend/test/fixtures/starship-catalog-2026-11-10.json")
        .read_text()
    )
    assert catalog == saved
    assert catalog["coverage"]["received"] == catalog["coverage"]["listed"] == 2
    starship = next(item for item in catalog["items"] if "Starship" in item["name"])
    assert starship["rocket"] == "Starship V3"
    assert starship["site"] == {
        "name": "SpaceX Starbase, TX, USA", "pad": "Orbital Launch Pad 2",
        "lat": 25.99677, "lon": -97.15799,
    }
    assert starship["schedule"]["net"] == "2026-11-13T22:45:00Z"
    assert starship["schedule"]["window_end"] == "2026-11-14T00:00:00Z"
    assert starship["schedule"]["status"] == "TBC"
    assert starship["schedule"]["precision"] == "Minute"
    assert starship["tier"] == "watch"
    assert starship["shots"] == []
