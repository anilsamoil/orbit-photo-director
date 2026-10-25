import copy
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from generator.launch_catalog import build_launch_catalog
from generator.orbit import TLE

FIXTURES = Path(__file__).parent / "fixtures"
CRS35_ID = "bf2c3027-a314-403e-a416-2bfd5d165ad1"
CRS35_NAME = "Falcon 9 Block 5 | Dragon CRS-2 SpX-35"
NET = datetime(2026, 10, 13, 10, 33, 44, tzinfo=UTC)


def _load():
    payload = json.loads((FIXTURES / "ll2-crs35-2026-10-10.json").read_text())
    tle = TLE.from_text((FIXTURES / "iss-2026-10-09.tle").read_text())
    return payload, tle


def _item(payload, tle, now, fetched, prior=None):
    catalog = build_launch_catalog(
        payload, tle, now, fetched_at=fetched, prior_items=prior,
    )
    return catalog["items"][0]


def test_crs35_shot_stays_shot_until_liftoff():
    payload, tle = _load()
    fresh = TLE(line1=tle.line1, line2=tle.line2, epoch=NET - timedelta(hours=12))
    now = NET - timedelta(hours=10)
    fetched = now - timedelta(minutes=5)
    qualified = _item(payload, fresh, now, fetched)
    assert qualified["event_id"] == CRS35_ID
    assert qualified["name"] == CRS35_NAME
    assert qualified["tier"] == "shot"
    prior = [qualified]

    bare = _item(payload, tle, now, fetched)
    assert bare["event_id"] == CRS35_ID
    assert bare["name"] == CRS35_NAME
    assert bare["tier"] == "likely"
    assert "FORECAST_EPHEMERIS" in bare["reasons"]
    opened_bare = copy.deepcopy(payload)
    opened_bare["results"][0]["window_end"] = "2026-10-13T10:33:45Z"
    assert _item(opened_bare, fresh, now, fetched)["tier"] == "watch"
    assert _item(payload, fresh, fetched + timedelta(minutes=80), fetched)["tier"] == "watch"

    aged = _item(payload, tle, now, fetched, prior)
    assert aged["event_id"] == CRS35_ID
    assert aged["name"] == CRS35_NAME
    assert aged["tier"] == "shot"
    assert aged["why"] == qualified["why"]

    opened = copy.deepcopy(payload)
    opened["results"][0]["window_end"] = "2026-10-13T10:33:45Z"
    assert _item(opened, fresh, now, fetched, prior)["tier"] == "shot"

    later = fetched + timedelta(minutes=80)
    assert _item(payload, fresh, later, fetched, prior)["tier"] == "shot"

    after = NET + timedelta(seconds=1)
    flown = _item(payload, tle, after, after - timedelta(minutes=5), prior)
    assert flown["name"] == CRS35_NAME
    assert flown["tier"] == "likely"

    scrubbed = copy.deepcopy(payload)
    scrubbed["results"][0]["status"] = {"abbrev": "TBC", "name": "To Be Confirmed"}
    assert _item(scrubbed, fresh, now, fetched, prior)["tier"] == "watch"
