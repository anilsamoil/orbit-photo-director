import copy
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from generator import launch_catalog as catalog
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
    assert _item(opened, fresh, now, fetched, prior)["tier"] == "watch"

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


def _change(payload, field: str):
    changed = copy.deepcopy(payload)
    row = changed["results"][0]
    if field == "name":
        row["name"] = f"{row['name']} renamed"
    elif field == "rocket":
        row["rocket"]["configuration"]["full_name"] = "Falcon 9 Block 5 cargo"
    elif field == "pad":
        row["pad"]["location"]["name"] = "Other pad"
    elif field == "window_start":
        row["window_start"] = "2026-10-13T10:33:43Z"
    elif field == "window_end":
        row["window_end"] = "2026-10-13T10:33:45Z"
    else:
        raise AssertionError(field)
    return changed


@pytest.mark.parametrize(
    ("field", "expected"),
    [
        ("name", "likely"),
        ("rocket", "likely"),
        ("pad", "likely"),
        ("window_start", "watch"),
        ("window_end", "watch"),
    ],
)
def test_crs35_one_saved_field_releases_shot(field, expected):
    payload, tle = _load()
    fresh = TLE(line1=tle.line1, line2=tle.line2, epoch=NET - timedelta(hours=12))
    now = NET - timedelta(hours=10)
    fetched = now - timedelta(minutes=5)
    prior = [_item(payload, fresh, now, fetched)]
    assert prior[0]["tier"] == "shot"
    released = _item(_change(payload, field), tle, now, fetched, prior)
    assert released["event_id"] == CRS35_ID
    assert released["tier"] == expected


def test_crs35_pad_name_change_releases_an_aged_shot():
    payload, tle = _load()
    fresh = TLE(line1=tle.line1, line2=tle.line2, epoch=NET - timedelta(hours=12))
    now = NET - timedelta(hours=10)
    fetched = now - timedelta(minutes=5)
    prior = [_item(payload, fresh, now, fetched)]
    assert prior[0]["tier"] == "shot"
    assert prior[0]["site"]["name"] == "Cape Canaveral SFS, FL, USA"
    assert prior[0]["site"]["pad"] == "Space Launch Complex 40"

    renamed = copy.deepcopy(payload)
    renamed["results"][0]["pad"]["name"] = "Space Launch Complex 41"
    released = build_launch_catalog(
        renamed, fresh, now, fetched_at=now - timedelta(minutes=80), prior_items=prior,
    )["items"][0]
    assert released["site"]["name"] == "Cape Canaveral SFS, FL, USA"
    assert released["site"]["pad"] == "Space Launch Complex 41"
    assert released["tier"] == "watch"

    requalified = _item(renamed, fresh, now, fetched, prior)
    assert requalified["site"]["pad"] == "Space Launch Complex 41"
    assert requalified["tier"] == "shot"


def test_crs35_envelope_set_must_match_the_claim():
    payload, tle = _load()
    fresh = TLE(line1=tle.line1, line2=tle.line2, epoch=NET - timedelta(hours=12))
    now = NET - timedelta(hours=10)
    fetched = now - timedelta(minutes=5)
    qualified = _item(payload, fresh, now, fetched)
    assert _item(payload, tle, now, fetched, [qualified])["tier"] == "shot"
    narrowed = copy.deepcopy(qualified)
    narrowed["shots"] = narrowed["shots"][:1]
    assert narrowed["shots"]
    released = _item(payload, tle, now, fetched, [narrowed])
    assert released["tier"] == "likely"
    assert len(released["shots"]) == len(qualified["shots"])


@pytest.mark.parametrize("reason", ["GEOMETRY_INVALID", "EVALUATION_INCOMPLETE", "EPHEMERIS_MISSING"])
def test_crs35_unusable_evidence_does_not_keep_shot(monkeypatch, reason):
    payload, tle = _load()
    fresh = TLE(line1=tle.line1, line2=tle.line2, epoch=NET - timedelta(hours=12))
    now = NET - timedelta(hours=10)
    fetched = now - timedelta(minutes=5)
    prior = [_item(payload, fresh, now, fetched)]
    original = catalog._shots

    def partial(launch, orbit, destination, reasons, liftoffs):
        shots, direction = original(launch, orbit, destination, reasons, liftoffs)
        reasons.append(reason)
        return shots, direction

    monkeypatch.setattr(catalog, "_shots", partial)
    held = _item(payload, tle, now, fetched, prior)
    assert held["shots"]
    assert reason in held["reasons"]
    assert held["tier"] == "watch"
