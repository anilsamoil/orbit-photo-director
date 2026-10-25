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


def _shift_net(payload, when: datetime):
    moved = copy.deepcopy(payload)
    text = when.strftime("%Y-%m-%dT%H:%M:%SZ")
    moved["results"][0]["net"] = text
    moved["results"][0]["window_start"] = text
    moved["results"][0]["window_end"] = text
    return moved


def test_crs35_shot_releases_when_the_launch_that_earned_it_changes():
    payload, tle = _load()
    fresh = TLE(line1=tle.line1, line2=tle.line2, epoch=NET - timedelta(hours=12))
    now = NET - timedelta(hours=10)
    fetched = now - timedelta(minutes=5)
    prior = [_item(payload, fresh, now, fetched)]
    assert prior[0]["tier"] == "shot"

    for hours in (1, 24, 48):
        slipped = _item(_shift_net(payload, NET + timedelta(hours=hours)), tle, now, fetched, prior)
        assert slipped["event_id"] == CRS35_ID
        assert slipped["tier"] == "watch"

    moved = copy.deepcopy(payload)
    moved["results"][0]["pad"]["latitude"] = 0.0
    assert _item(moved, tle, now, fetched, prior)["tier"] == "watch"

    elsewhere = copy.deepcopy(payload)
    elsewhere["results"][0]["rocket"]["spacecraft_stage"][0]["destination"] = "LEO"
    diverted = _item(elsewhere, tle, now, fetched, prior)
    assert diverted["schedule"]["destination"] == "other"
    assert diverted["tier"] == "likely"

    assert _item(payload, None, now, fetched, prior)["shots"] == []
    assert _item(payload, None, now, fetched, prior)["tier"] == "watch"

    missing_window = copy.deepcopy(payload)
    missing_window["results"][0]["window_start"] = None
    missing_window["results"][0]["window_end"] = None
    unassessed = _item(missing_window, fresh, now, fetched, prior)
    assert unassessed["shots"] == []
    assert unassessed["tier"] == "unassessed"

    opposite = TLE.from_text(
        "1 25544U 98067A   26282.95044904  .00006711  00000-0  13074-3 0  9998\n"
        "2 25544  51.6315 272.1575 0006672 244.0714 115.9587 15.48795780589546\n"
    )
    far = TLE(line1=opposite.line1, line2=opposite.line2, epoch=opposite.epoch)
    emptied = _item(payload, far, now, fetched, prior)
    assert emptied["shots"] == []
    assert emptied["tier"] == "watch"


def test_crs35_hour_precision_miss_and_unusable_receipt_release_shot():
    payload, tle = _load()
    fresh = TLE(line1=tle.line1, line2=tle.line2, epoch=NET - timedelta(hours=12))
    now = NET - timedelta(hours=10)
    fetched = now - timedelta(minutes=5)
    prior = [_item(payload, fresh, now, fetched)]

    hour = copy.deepcopy(payload)
    hour["results"][0]["net_precision"] = {"name": "Hour"}
    assert _item(hour, fresh, now, fetched, prior)["tier"] == "watch"

    opposite = TLE.from_text(
        "1 25544U 98067A   26282.95044904  .00006711  00000-0  13074-3 0  9998\n"
        "2 25544  51.6315 272.1575 0006672 244.0714 115.9587 15.48795780589546\n"
    )
    missed_tle = TLE(line1=opposite.line1, line2=opposite.line2, epoch=NET - timedelta(hours=12))
    missed = _item(payload, missed_tle, now, fetched, prior)
    assert missed["name"] == CRS35_NAME
    assert missed["tier"] == "none"
    assert missed["why"] == "The ascent stays behind Earth on a fresh orbit."

    stale_receipt = build_launch_catalog(
        payload, tle, now, fetched_at=fetched, source_reasons=("SOURCE_AGE_MTIME_ONLY",), prior_items=prior,
    )["items"][0]
    assert stale_receipt["tier"] == "watch"

    unknown = build_launch_catalog(payload, tle, now, fetched_at=None, prior_items=prior)["items"][0]
    assert unknown["tier"] == "watch"
    future = build_launch_catalog(
        payload, tle, now, fetched_at=now + timedelta(minutes=5), prior_items=prior,
    )["items"][0]
    assert future["tier"] == "watch"

    at_liftoff = _item(payload, tle, NET, NET - timedelta(minutes=5), prior)
    assert at_liftoff["tier"] == "likely"
