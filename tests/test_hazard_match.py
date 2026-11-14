"""Which notice is drawn for which launch, and the hazard schema 2 file that results."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from generator.hazard_match import (
    LABEL,
    LEAD_MAX,
    OPEN_SLACK,
    PAD_ANCHOR_KM,
    Sighting,
    build_bundle,
    in_force_at_window_open,
    launches_from_catalog,
    pad_distance_km,
    same_ring,
    validate_bundle,
)
from generator.hazard_notices import parse_nga_payload
from tests import hazard_fixtures as fx

NOW = fx.SCENARIO_NOW


def _utc(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)


def _decisions(log: list[dict]) -> dict[str, dict]:
    return {entry["notice_id"]: entry for entry in log}


def _seen(*notices, at: datetime = NOW) -> list[Sighting]:
    return [Sighting(notice, at) for notice in notices]


def _drawn(bundle: dict, event_id: str) -> list[tuple[str, str]]:
    entries = [entry for entry in bundle["launches"] if entry["event_id"] == event_id]
    return [(notice["notice_id"], notice["area_id"]) for entry in entries for notice in entry["notices"]]


def _launch(event_id: str, **schedule: str):
    (found,) = launches_from_catalog([fx.item(event_id, **schedule)], _utc("2026-11-13T00:00"))
    return found


def test_the_committed_reference_file_is_what_the_pipeline_builds_from_the_notices():
    bundle, _ = fx.scenario_bundle()
    assert bundle == json.loads(fx.GOLDEN.read_text())
    validate_bundle(bundle)
    assert bundle["schema_version"] == 2 and bundle["label"] == LABEL
    assert [entry["event_id"] for entry in bundle["launches"]] == [fx.STARSHIP, fx.USSF_317, fx.VULCAN]
    text = json.dumps(bundle)
    for absent in ("LineString", "azimuth", "direction", "trajectory", "tier", "shots"):
        assert absent not in text


def test_reference_file_vertices_match_the_notice_text_for_each_launch():
    stored = json.loads(fx.GOLDEN.read_text())
    starship = fx.broadcast_body("navarea-iv-1080-26.txt", "NAVAREA IV 1080/26")
    assert fx.same_ring(fx.ring(stored, fx.STARSHIP, "NAVAREA IV 1080/26", "A"), fx.read_dm_pairs(fx.between(starship, "A. ", "B. ")))
    assert fx.same_ring(fx.ring(stored, fx.STARSHIP, "NAVAREA IV 1080/26", "B"), fx.read_dm_pairs(fx.between(starship, "B. ", "2. CANCEL")))
    coast_guard = fx.uscg_description(58067)
    assert fx.same_ring(fx.ring(stored, fx.STARSHIP, "NAVAREA IV 1080/26", "B"), fx.read_dms_pairs(fx.between(coast_guard, "High Risk Hazard Area:", "\nHazard Area:")))
    tfr = (fx.NOTICES / "faa-tfr-6-7129.xml").read_text(encoding="utf-8-sig")
    assert fx.same_ring(fx.ring(stored, fx.STARSHIP, "TFR 6/7129", "6/7129"), fx.read_tfr_ring(tfr))
    vulcan = fx.broadcast_body("navarea-iv-1099-26.txt", "NAVAREA IV 1099/26")
    for area, start, end in (("A", "A. ", "B. "), ("B", "B. ", "C. "), ("C", "C. ", "2. CANCEL")):
        assert fx.same_ring(fx.ring(stored, fx.VULCAN, "NAVAREA IV 1099/26", area), fx.read_dm_pairs(fx.between(vulcan, start, end)))
    cape = (fx.NOTICES / "faa-tfr-6-7111.xml").read_text(encoding="utf-8-sig")
    assert fx.same_ring(fx.ring(stored, fx.VULCAN, "TFR 6/7111", "6/7111"), fx.read_tfr_ring(cape))
    falcon = fx.broadcast_body("navarea-xii-in-force-2026-11-13.txt", "NAVAREA XII 801/26")
    for area, chunk in zip("ABC", falcon.split("IN AREA BOUND BY")[1:], strict=True):
        assert fx.same_ring(fx.ring(stored, fx.USSF_317, "NAVAREA XII 801/26", area), fx.read_dm_pairs(chunk))


@pytest.mark.parametrize(("event_id", "notice_id", "area_id", "vertex"), [
    (fx.STARSHIP, "NAVAREA IV 1080/26", "A", 4),
    (fx.STARSHIP, "TFR 6/7129", "6/7129", 1),
    (fx.VULCAN, "NAVAREA IV 1099/26", "C", 2),
    (fx.USSF_317, "NAVAREA XII 801/26", "B", 3),
])
def test_a_reference_vertex_moved_one_hundredth_of_a_degree_fails_both_checks(event_id, notice_id, area_id, vertex):
    stored = json.loads(fx.GOLDEN.read_text())
    fx.ring(stored, event_id, notice_id, area_id)[vertex][0] += 0.01
    assert stored != fx.scenario_bundle()[0]
    if notice_id.startswith("TFR"):
        expected = fx.read_tfr_ring((fx.NOTICES / "faa-tfr-6-7129.xml").read_text(encoding="utf-8-sig"))
    else:
        name = {"NAVAREA IV 1080/26": "navarea-iv-1080-26.txt", "NAVAREA IV 1099/26": "navarea-iv-1099-26.txt"}.get(notice_id, "navarea-xii-in-force-2026-11-13.txt")
        body = fx.broadcast_body(name, notice_id)
        expected = {
            ("NAVAREA IV 1080/26", "A"): lambda: fx.read_dm_pairs(fx.between(body, "A. ", "B. ")),
            ("NAVAREA IV 1099/26", "C"): lambda: fx.read_dm_pairs(fx.between(body, "C. ", "2. CANCEL")),
            ("NAVAREA XII 801/26", "B"): lambda: fx.read_dm_pairs(body.split("IN AREA BOUND BY")[2]),
        }[(notice_id, area_id)]()
    assert fx.same_ring(fx.ring(stored, event_id, notice_id, area_id), expected) is False


def test_schema_2_for_starship_holds_what_the_hand_built_schema_1_file_held():
    old = json.loads(fx.V1_STARSHIP.read_text())
    new = fx.launch(fx.scenario_bundle()[0], fx.STARSHIP)
    assert old["schema_version"] == 1 and old["event_id"] == new["event_id"]
    assert [(n["notice_id"], n["area_id"]) for n in old["notices"]] == [(n["notice_id"], n["area_id"]) for n in new["notices"]]
    for before, after in zip(old["notices"], new["notices"], strict=True):
        for field in ("authority", "domain", "restriction_class", "windows", "source_url", "source_sha256"):
            assert before[field] == after[field]
        assert after["checked_at"] == old["checked_at"]
        assert "phase" not in after and "retrieved_from" not in after
    for before, after in zip(old["geojson"]["features"], new["geojson"]["features"], strict=True):
        assert before["geometry"] == after["geometry"]
    assert new["notices"][0]["valid_until"] == old["valid_until"]
    assert new["notices"][1]["instructions"] == [
        "Mariners should avoid waters within the defined hazard areas during the scheduled launch window.",
        "The high risk hazard area should be avoided three hours prior to the earliest launch to ensure range clearance.",
    ]
    assert new["notices"][1]["cross_check_sha256"] == fx.file_sha256(fx.USCG)
    assert "cross_check_url" not in new["notices"][2]


def test_every_notice_of_the_run_has_one_logged_decision():
    bundle, log = fx.scenario_bundle()
    decisions = _decisions(log)
    assert len(decisions) == len(log) == len(fx.scenario_sightings())
    assert {name: (entry["decision"], entry["event_id"]) for name, entry in decisions.items() if entry["decision"] == "matched"} == {
        "NAVAREA IV 1080/26": ("matched", fx.STARSHIP),
        "TFR 6/7129": ("matched", fx.STARSHIP),
        "USCG LNM 58067": ("matched", fx.STARSHIP),
        "NAVAREA IV 1099/26": ("matched", fx.VULCAN),
        "TFR 6/7111": ("matched", fx.VULCAN),
        "TFR 6/7112": ("matched", fx.VULCAN),
        "USCG LNM 58224": ("matched", fx.VULCAN),
        "NAVAREA XII 801/26": ("matched", fx.USSF_317),
        "USCG LNM 58217": ("matched", fx.USSF_317),
    }
    assert decisions["NAVAREA IV 1078/26"]["decision"] == decisions["NAVAREA XII 785/26"]["decision"] == "cancelled"
    assert decisions["HYDROPAC 3245/26"]["decision"] == "cancelled"
    assert decisions["NAVAREA IV 1099/26"]["problems"] == ["WINDOW_UNPARSED:1616550Z TO 161828"]
    assert decisions["USCG LNM 58060"]["decision"] == "rejected" and decisions["USCG LNM 58060"]["reasons"] == ["NO_AREAS"]
    assert decisions["USCG LNM 58067"]["reasons"] == ["CROSS_CHECK_OF:NAVAREA IV 1080/26"]
    assert decisions["USCG LNM 58224"]["reasons"] == ["CROSS_CHECK_OF:NAVAREA IV 1099/26:WINDOWS_DIFFER"]
    assert decisions["TFR 6/7112"]["reasons"] == ["SAME_AREA_AS:TFR 6/7111"]
    assert {name: entry["event_id"] for name, entry in decisions.items() if entry["decision"] == "listed"} == {
        "USCG LNM 58225": fx.VULCAN,
        "USCG LNM 58296": fx.STARSHIP,
        "USCG LNM 58298": fx.STARSHIP,
    }
    assert (decisions["USCG LNM 58306"]["decision"], decisions["USCG LNM 58306"]["reasons"]) == ("not_launch", ["recovery"])
    assert _drawn(bundle, fx.VULCAN) == [
        ("NAVAREA IV 1099/26", "A"), ("NAVAREA IV 1099/26", "B"), ("NAVAREA IV 1099/26", "C"), ("TFR 6/7111", "6/7111"),
    ]
    assert fx.launch(bundle, fx.VULCAN)["notices"][3]["also"] == ["TFR 6/7112"]
    assert _drawn(bundle, fx.NROL_136) == []


def test_falcon_9_from_cape_canaveral_gets_the_areas_of_the_archived_nga_warning():
    facts = json.loads((fx.FIXTURES / "launch-starlink-6-25-2023.json").read_text())["item"]
    raw = (fx.NOTICES / fx.NGA_2023).read_bytes()
    seen = _utc("2023-10-30T21:00")
    notices = parse_nga_payload(raw, "https://msi.nga.mil/api/publications/broadcast-warn?navArea=4&status=active&output=json")
    bundle, log = build_bundle([facts], _seen(*notices, at=seen), _utc("2023-10-30T22:00"))
    assert _drawn(bundle, fx.STARLINK_6_25) == [("NAVAREA IV 1231/23", "A"), ("NAVAREA IV 1231/23", "B")]
    text = next(row["text"] for row in json.loads(raw)["broadcast-warn"] if row["msgNumber"] == 1231)
    assert fx.same_ring(fx.ring(bundle, fx.STARLINK_6_25, "NAVAREA IV 1231/23", "A"), fx.read_dm_pairs(fx.between(text, "A. ", "B. ")))
    assert fx.same_ring(fx.ring(bundle, fx.STARLINK_6_25, "NAVAREA IV 1231/23", "B"), fx.read_dm_pairs(fx.between(text, "B. ", "2. CANCEL")))
    entry = fx.launch(bundle, fx.STARLINK_6_25)["notices"][0]
    assert entry["windows"][0] == {"start": "2023-10-30T22:23:00Z", "end": "2023-10-31T02:54:00Z"}
    assert entry["checked_at"] == "2023-10-30T21:00:00Z" and entry["instructions"] == []
    decisions = _decisions(log)
    assert decisions["NAVAREA IV 1130/23"]["decision"] == "not_launch"
    assert decisions["NAVAREA IV 329/23"]["decision"] == "not_launch"
    assert sum(entry["decision"] == "matched" for entry in log) == 1


def test_an_unrelated_military_exercise_at_the_coast_is_never_drawn_for_a_launch():
    missile = fx.broadcast_notice("navarea-xii-in-force-2026-11-13.txt", "NAVAREA XII 789/26")
    plain = fx.broadcast_notice("navarea-xii-in-force-2026-11-13.txt", "NAVAREA XII 795/26")
    assert missile.subject == "MISSILE OPERATIONS" and plain.subject == "HAZARDOUS OPERATIONS"
    for notice, lat, lon, net in ((missile, 32.0, -118.5, "2026-11-14T14:05:00Z"), (plain, 33.6, -119.5, "2026-11-16T16:05:00Z")):
        decoy = fx.item(fx.USSF_317, net=net, window_start=net[:14] + "00:00Z", window_end=net[:11] + "20:00:00Z")
        decoy["site"].update(lat=lat, lon=lon)
        (launch,) = launches_from_catalog([decoy], _utc("2026-11-13T00:00"))
        assert pad_distance_km(launch, notice.areas[0].ring) == 0.0
        assert in_force_at_window_open(launch, notice) is True
        bundle, log = build_bundle([decoy], _seen(notice, at=_utc("2026-11-13T12:00")), _utc("2026-11-13T12:00"))
        assert bundle["launches"] == []
        assert _decisions(log)[notice.notice_id]["decision"] == "not_launch"


def test_a_range_operation_that_overlaps_the_falcon_9_window_is_not_drawn_for_it():
    operation = fx.uscg_notice(57935)
    launch = _launch(fx.USSF_317)
    assert (launch.opens, launch.closes) == (_utc("2026-11-18T03:14"), _utc("2026-11-18T07:14"))
    window = operation.areas[0].windows[0]
    assert window.start < launch.closes and window.end > launch.opens
    assert min(pad_distance_km(launch, area.ring) for area in operation.areas) < PAD_ANCHOR_KM
    assert in_force_at_window_open(launch, operation) is False
    bundle, log = build_bundle(fx.catalog_items(), _seen(operation, fx.uscg_notice(58217)), NOW)
    assert _drawn(bundle, fx.USSF_317) == [("USCG LNM 58217", "A"), ("USCG LNM 58217", "B"), ("USCG LNM 58217", "C")]
    entry = _decisions(log)["USCG LNM 57935"]
    assert entry["decision"] == "unmatched"
    assert f"NOT_IN_FORCE_AT_WINDOW_OPEN:{fx.USSF_317}" in entry["reasons"]


def test_a_notice_for_another_launch_from_the_same_pad_on_the_same_day_is_not_drawn():
    other = fx.broadcast_notice("navarea-xii-in-force-2026-11-13.txt", "NAVAREA XII 794/26")
    mine = fx.broadcast_notice("navarea-xii-in-force-2026-11-13.txt", "NAVAREA XII 801/26")
    launch = _launch(fx.USSF_317)
    assert any(window.start.date() == launch.net.date() for window in other.areas[0].windows)
    assert pad_distance_km(launch, other.areas[0].ring) < PAD_ANCHOR_KM
    bundle, log = build_bundle(fx.catalog_items(), _seen(other, mine), NOW)
    assert _drawn(bundle, fx.USSF_317) == [("NAVAREA XII 801/26", "A"), ("NAVAREA XII 801/26", "B"), ("NAVAREA XII 801/26", "C")]
    assert _drawn(bundle, fx.NROL_136) == []
    assert _decisions(log)["NAVAREA XII 794/26"]["decision"] == "unmatched"


def test_a_rocket_launching_notice_with_no_area_at_the_pad_is_not_drawn():
    disposal = fx.broadcast_notice("hydropac-3246-26.txt")
    assert disposal.kind == "launch"
    slipped = fx.item(fx.VULCAN, net="2026-11-14T20:10:00Z", window_start="2026-11-14T20:06:00Z", window_end="2026-11-14T21:00:00Z")
    (launch,) = launches_from_catalog([slipped], NOW)
    assert in_force_at_window_open(launch, disposal) is True
    bundle, log = build_bundle([slipped], _seen(disposal), NOW)
    assert bundle["launches"] == []
    (reason,) = _decisions(log)["HYDROPAC 3246/26"]["reasons"]
    assert reason.startswith(f"NOT_AT_PAD:{fx.VULCAN}:") and int(reason.rsplit(":", 1)[1][:-2]) > 5_000


def test_slip_to_the_backup_day_keeps_launch_notices_and_refuses_the_return_notices():
    slipped = fx.item(fx.STARSHIP, net="2026-11-14T22:45:00Z", window_start="2026-11-14T22:45:00Z", window_end="2026-11-15T00:00:00Z")
    now = _utc("2026-11-14T12:00")
    (launch,) = launches_from_catalog([slipped], now)
    debris = fx.broadcast_notice("navarea-iv-1081-26.txt")
    recovery = fx.faa_notice("faa-tfr-6-7131.xml")
    for trap in (debris, recovery):
        assert pad_distance_km(launch, trap.areas[0].ring) < PAD_ANCHOR_KM
        assert in_force_at_window_open(launch, trap) is True
    seen = [Sighting(s.notice, now) for s in fx.scenario_sightings()]
    bundle, log = build_bundle([slipped], seen, now)
    assert _drawn(bundle, fx.STARSHIP) == [("NAVAREA IV 1080/26", "A"), ("NAVAREA IV 1080/26", "B"), ("TFR 6/7130", "6/7130")]
    decisions = _decisions(log)
    assert decisions["TFR 6/7129"]["decision"] == "expired"
    assert (decisions["TFR 6/7131"]["decision"], decisions["TFR 6/7131"]["reasons"]) == ("not_launch", ["recovery"])
    assert (decisions["NAVAREA IV 1081/26"]["decision"], decisions["NAVAREA IV 1081/26"]["reasons"]) == ("not_launch", ["space_debris"])
    first = fx.launch(bundle, fx.STARSHIP)["notices"][0]["windows"][0]
    assert first == {"start": "2026-11-14T22:45:00Z", "end": "2026-11-15T00:40:00Z"}


def test_slip_past_every_published_window_and_a_cancelled_launch_draw_nothing():
    seen = fx.scenario_sightings()
    late = fx.item(fx.STARSHIP, net="2026-11-20T22:45:00Z", window_start="2026-11-20T22:45:00Z", window_end="2026-11-21T00:00:00Z")
    bundle, log = build_bundle([late], seen, NOW)
    assert _drawn(bundle, fx.STARSHIP) == []
    assert _decisions(log)["NAVAREA IV 1080/26"]["reasons"] == [f"NOT_IN_FORCE_AT_WINDOW_OPEN:{fx.STARSHIP}"]
    past_every_record = fx.item(fx.STARSHIP, net="2026-11-21T23:59:59Z", window_start="2026-11-21T22:45:00Z", window_end="2026-11-22T00:40:00Z")
    assert build_bundle([past_every_record], seen, NOW)[0]["launches"] == []
    for status in ("Cancelled", "TBD", "Hold"):
        cancelled = fx.item(fx.STARSHIP, status=status)
        assert launches_from_catalog([cancelled], NOW) == []
        assert build_bundle([cancelled], seen, NOW)[0]["launches"] == []
    net_outside = fx.item(fx.STARSHIP, net="2026-11-14T22:45:00Z")
    assert launches_from_catalog([net_outside], NOW) == []
    assert launches_from_catalog([{"event_id": "x"}, fx.item(fx.STARSHIP, net="soon")], NOW) == []
    assert launches_from_catalog([fx.item(fx.STARSHIP)], _utc("2026-11-14T00:00")) == []
    assert launches_from_catalog([fx.item(fx.STARSHIP)], _utc("2026-11-05T22:44")) == []


def test_an_amendment_replaces_the_first_issue_and_a_withdrawn_notice_leaves_the_file():
    first = fx.broadcast_notice("navarea-iv-1078-26.txt")
    amended = fx.broadcast_notice("navarea-iv-1099-26.txt")
    items = [fx.item(fx.VULCAN)]
    before, _ = build_bundle(items, _seen(first), NOW)
    assert _drawn(before, fx.VULCAN) == [("NAVAREA IV 1078/26", "A"), ("NAVAREA IV 1078/26", "B"), ("NAVAREA IV 1078/26", "C")]
    assert len(fx.launch(before, fx.VULCAN)["notices"][0]["windows"]) == 6
    after, log = build_bundle(items, _seen(first, amended), NOW)
    assert _drawn(after, fx.VULCAN) == [("NAVAREA IV 1099/26", "A"), ("NAVAREA IV 1099/26", "B"), ("NAVAREA IV 1099/26", "C")]
    assert _decisions(log)["NAVAREA IV 1078/26"]["decision"] == "cancelled"
    starts = [window["start"] for window in fx.launch(after, fx.VULCAN)["notices"][0]["windows"]]
    assert starts == ["2026-11-14T17:32:00Z", "2026-11-15T17:11:00Z", "2026-11-17T16:28:00Z", "2026-11-18T16:07:00Z", "2026-11-19T15:46:00Z"]
    assert before["revision"] != after["revision"]
    withdrawn, _ = build_bundle(items, [], NOW)
    assert withdrawn["launches"] == [] and withdrawn["revision"] != after["revision"]
    validate_bundle(withdrawn)


def test_a_review_older_than_two_days_and_a_notice_past_its_cancel_time_are_dropped():
    notice = fx.broadcast_notice("navarea-iv-1099-26.txt")
    items = [fx.item(fx.VULCAN)]
    fresh, _ = build_bundle(items, _seen(notice, at=NOW - timedelta(hours=47, minutes=59)), NOW)
    assert fx.launch(fresh, fx.VULCAN)["notices"][0]["checked_at"] == "2026-11-11T23:41:00Z"
    stale, log = build_bundle(items, _seen(notice, at=NOW - timedelta(hours=48)), NOW)
    assert stale["launches"] == [] and _decisions(log)["NAVAREA IV 1099/26"]["decision"] == "stale"
    week = fx.item(fx.VULCAN, net="2026-11-19T15:50:00Z", window_start="2026-11-19T15:46:00Z", window_end="2026-11-19T17:00:00Z")
    at_cancel = _utc("2026-11-19T18:24")
    assert notice.valid_until == at_cancel
    _, log = build_bundle([week], _seen(notice, at=at_cancel), at_cancel)
    assert _decisions(log)["NAVAREA IV 1099/26"]["decision"] == "expired"
    before_cancel = _utc("2026-11-19T16:00")
    bundle, _ = build_bundle([week], _seen(notice, at=before_cancel), before_cancel)
    entry = fx.launch(bundle, fx.VULCAN)["notices"][0]
    assert entry["windows"] == [{"start": "2026-11-19T15:46:00Z", "end": "2026-11-19T17:24:00Z"}]
    assert entry["valid_until"] == "2026-11-19T18:24:00Z"


def test_a_notice_with_an_unreadable_time_is_listed_on_the_day_it_cannot_be_drawn():
    amended = fx.broadcast_notice("navarea-iv-1099-26.txt")
    on_the_16th = fx.item(fx.VULCAN, net="2026-11-16T16:50:30Z", window_start="2026-11-16T16:50:00Z", window_end="2026-11-16T17:19:00Z")
    now = _utc("2026-11-16T12:00")
    (launch,) = launches_from_catalog([on_the_16th], now)
    assert in_force_at_window_open(launch, amended) is False
    bundle, log = build_bundle([on_the_16th], _seen(amended, at=now), now)
    entry = fx.launch(bundle, fx.VULCAN)
    assert entry["notices"] == [] and entry["geojson"]["features"] == []
    assert entry["listed"] == [{
        "authority": "NGA",
        "notice_id": "NAVAREA IV 1099/26",
        "reason": "unread_time",
        "text": "1616550Z TO 161828",
        "checked_at": "2026-11-16T12:00:00Z",
        "valid_until": "2026-11-19T18:24:00Z",
        "source_url": fx.manifest("navarea-iv-1099-26.txt")["source_url"],
        "source_sha256": fx.file_sha256("navarea-iv-1099-26.txt"),
    }]
    assert "1616550Z TO 161828," in fx.broadcast_body("navarea-iv-1099-26.txt", "NAVAREA IV 1099/26")
    decision = _decisions(log)["NAVAREA IV 1099/26"]
    assert (decision["decision"], decision["event_id"], decision["reasons"]) == ("listed", fx.VULCAN, ["UNREAD_TIME"])
    validate_bundle(bundle)
    with_coast_guard, _ = build_bundle([on_the_16th], _seen(amended, fx.uscg_notice(58224), at=now), now)
    assert _drawn(with_coast_guard, fx.VULCAN) == [("USCG LNM 58224", "A")]
    assert [x["notice_id"] for x in fx.launch(with_coast_guard, fx.VULCAN)["listed"]] == ["NAVAREA IV 1099/26"]
    on_a_readable_day, _ = build_bundle([fx.item(fx.VULCAN)], _seen(amended), NOW)
    assert len(_drawn(on_a_readable_day, fx.VULCAN)) == 3
    assert [x["text"] for x in fx.launch(on_a_readable_day, fx.VULCAN)["listed"]] == ["1616550Z TO 161828"]
    clean = fx.broadcast_notice("navarea-iv-1078-26.txt")
    assert fx.launch(build_bundle([fx.item(fx.VULCAN)], _seen(clean), NOW)[0], fx.VULCAN)["listed"] == []


def test_an_unreadable_time_is_listed_only_for_one_launch_at_the_pad_inside_the_notice_life():
    amended = fx.broadcast_notice("navarea-iv-1099-26.txt")
    now = _utc("2026-11-13T12:00")

    def listed_for(**schedule: str) -> list[str]:
        bundle, _ = build_bundle([fx.item(fx.VULCAN, **schedule)], _seen(amended, at=now), now)
        return [x["notice_id"] for entry in bundle["launches"] for x in entry["listed"]]

    assert listed_for(net="2026-11-16T03:00:00Z", window_start="2026-11-16T03:00:00Z", window_end="2026-11-16T04:00:00Z") == ["NAVAREA IV 1099/26"]
    assert listed_for(net="2026-11-13T17:32:00Z", window_start="2026-11-13T17:32:00Z", window_end="2026-11-13T18:00:00Z") == ["NAVAREA IV 1099/26"]
    assert listed_for(net="2026-11-13T17:31:00Z", window_start="2026-11-13T17:31:00Z", window_end="2026-11-13T18:00:00Z") == []
    assert listed_for(net="2026-11-19T18:24:00Z", window_start="2026-11-19T18:00:00Z", window_end="2026-11-19T19:00:00Z") == []
    elsewhere = fx.item(fx.USSF_317, net="2026-11-16T16:50:00Z", window_start="2026-11-16T16:50:00Z", window_end="2026-11-16T17:19:00Z")
    assert build_bundle([elsewhere], _seen(amended, at=now), now)[0]["launches"] == []
    twin = fx.item(fx.VULCAN, net="2026-11-16T16:50:00Z", window_start="2026-11-16T16:50:00Z", window_end="2026-11-16T17:19:00Z")
    other = json.loads(json.dumps(twin))
    other["event_id"] = "second-launch-from-the-same-pad"
    bundle, log = build_bundle([twin, other], _seen(amended, at=now), now)
    assert bundle["launches"] == [] and _decisions(log)["NAVAREA IV 1099/26"]["decision"] == "unmatched"
    air_launch = fx.uscg_notice(58219)
    assert air_launch.problems == ("WINDOW_UNPARSED:221400Z NOV TO 242000Z NOV 2026",)
    later = _utc("2026-11-17T00:00")
    at_the_pad = [launch.event_id for launch in launches_from_catalog(fx.catalog_items(), later) if abs(launch.lat - 34.632) < 0.01]
    assert len(at_the_pad) == 3
    three, log = build_bundle(fx.catalog_items(), _seen(air_launch, at=later), later)
    assert three["launches"] == [] and _decisions(log)["USCG LNM 58219"]["decision"] == "unmatched"
    alone, log = build_bundle([fx.item("460d9db7-eaf6-4cd9-b095-cff433534c09")], _seen(air_launch, at=later), later)
    assert [(x["notice_id"], x["text"]) for x in alone["launches"][0]["listed"]] == [("USCG LNM 58219", "221400Z NOV TO 242000Z NOV 2026")]
    assert alone["launches"][0]["notices"] == []
    assert amended.valid_from == _utc("2026-11-13T17:20")
    unreadable = type(amended)(**{**amended.__dict__, "areas": tuple(type(area)(area.area_id, area.ring, (), "hazard") for area in amended.areas)})
    for net, expected in (("2026-11-16T16:50:00Z", ["NAVAREA IV 1099/26"]), ("2026-11-12T17:19:00Z", [])):
        only = fx.item(fx.VULCAN, net=net, window_start=net, window_end=net)
        found, _ = build_bundle([only], _seen(unreadable, at=_utc("2026-11-12T12:00")), _utc("2026-11-12T12:00"))
        assert [x["notice_id"] for entry in found["launches"] for x in entry["listed"]] == expected
    undated = type(amended)(**{**unreadable.__dict__, "valid_until": None})
    assert build_bundle([fx.item(fx.VULCAN)], _seen(undated), NOW)[0]["launches"] == []


def test_safety_zones_and_regulated_areas_are_listed_as_text_and_never_drawn():
    bundle, log = fx.scenario_bundle()
    starship = fx.launch(bundle, fx.STARSHIP)
    assert [(x["notice_id"], x["reason"]) for x in starship["listed"]] == [("USCG LNM 58296", "not_drawn"), ("USCG LNM 58298", "not_drawn")]
    assert starship["listed"][0]["text"] == fx.uscg_notice(58296).subject
    assert starship["listed"][0]["valid_until"] == "2026-11-20T23:59:59Z"
    assert starship["listed"][0]["source_sha256"] == fx.file_sha256(fx.USCG)
    assert all("58296" not in feature["id"] and "58298" not in feature["id"] for feature in starship["geojson"]["features"])
    assert len(starship["geojson"]["features"]) == 3
    vulcan = fx.launch(bundle, fx.VULCAN)
    assert [(x["notice_id"], x["reason"]) for x in vulcan["listed"]] == [("NAVAREA IV 1099/26", "unread_time"), ("USCG LNM 58225", "not_drawn")]
    assert vulcan["listed"][1]["text"].startswith("Active RNA. ")
    assert all(feature["properties"]["notice_id"] != "USCG LNM 58225" for feature in vulcan["geojson"]["features"])
    assert fx.launch(bundle, fx.USSF_317)["listed"] == []
    zone, rna = fx.uscg_notice(58296), fx.uscg_notice(58225)
    now = NOW

    def decision(notice, *items) -> tuple[str, str | None]:
        _, log = build_bundle(list(items), _seen(notice, at=now), now)
        entry = _decisions(log)[notice.notice_id]
        return entry["decision"], entry["event_id"]

    assert decision(zone, fx.item(fx.STARSHIP)) == ("listed", fx.STARSHIP)
    assert decision(zone, fx.item(fx.VULCAN)) == ("not_launch", None)
    after_the_record = fx.item(fx.STARSHIP, net="2026-11-20T23:59:59Z", window_start="2026-11-20T22:45:00Z", window_end="2026-11-21T00:40:00Z")
    assert decision(zone, after_the_record) == ("not_launch", None)
    second = fx.item(fx.STARSHIP)
    second["event_id"] = "second-launch-from-the-same-pad"
    assert decision(zone, fx.item(fx.STARSHIP), second) == ("ambiguous", None)
    assert rna.valid_until - rna.valid_from > timedelta(days=150)
    assert decision(rna, fx.item(fx.VULCAN)) == ("listed", fx.VULCAN)
    day_late = fx.item(fx.VULCAN, net="2026-11-20T17:32:30Z", window_start="2026-11-20T17:32:00Z", window_end="2026-11-20T18:01:00Z")
    assert decision(rna, day_late) == ("not_launch", None)
    long_lived = type(zone)(**{**zone.__dict__, "valid_until": zone.valid_from + timedelta(days=22)})
    assert decision(long_lived, fx.item(fx.STARSHIP)) == ("not_launch", None)
    no_outline = type(zone)(**{**zone.__dict__, "outline": ()})
    assert decision(no_outline, fx.item(fx.STARSHIP)) == ("not_launch", None)
    reentry = fx.uscg_notice(58306)
    assert reentry.kind == "recovery" and decision(reentry, fx.item(fx.STARSHIP)) == ("not_launch", None)


def test_coast_guard_areas_stand_alone_while_nga_is_unreachable():
    bundle, log = build_bundle(fx.catalog_items(), _seen(fx.uscg_notice(58067), fx.faa_notice("faa-tfr-6-7129.xml")), NOW)
    entry = fx.launch(bundle, fx.STARSHIP)
    assert [(n["notice_id"], n["area_id"], n["restriction_class"]) for n in entry["notices"]] == [
        ("USCG LNM 58067", "HAZARD", "hazard"),
        ("USCG LNM 58067", "HIGH RISK", "high_risk"),
        ("TFR 6/7129", "6/7129", "restricted_airspace"),
    ]
    old = json.loads(fx.V1_STARSHIP.read_text())["geojson"]["features"]
    assert entry["geojson"]["features"][0]["geometry"] == old[0]["geometry"]
    assert entry["geojson"]["features"][1]["geometry"] == old[1]["geometry"]
    assert "cross_check_url" not in entry["notices"][0]
    assert _decisions(log)["USCG LNM 58067"]["reasons"] == []


def test_two_launches_that_fit_one_notice_get_nothing_until_an_operator_names_one():
    notice = fx.broadcast_notice("navarea-xii-in-force-2026-11-13.txt", "NAVAREA XII 801/26")
    twin = fx.item(fx.USSF_317)
    twin["event_id"] = "second-launch-from-the-same-pad"
    items = [fx.item(fx.USSF_317), twin]
    bundle, log = build_bundle(items, _seen(notice), NOW)
    assert bundle["launches"] == []
    entry = _decisions(log)["NAVAREA XII 801/26"]
    assert (entry["decision"], entry["event_id"]) == ("ambiguous", None)
    assert entry["reasons"] == [fx.USSF_317, "second-launch-from-the-same-pad"]
    pinned, log = build_bundle(items, _seen(notice), NOW, {"pin": {"NAVAREA XII 801/26": twin["event_id"]}})
    assert [entry["event_id"] for entry in pinned["launches"]] == ["second-launch-from-the-same-pad"]
    assert _decisions(log)["NAVAREA XII 801/26"]["reasons"] == ["PINNED"]
    banned, log = build_bundle([fx.item(fx.USSF_317)], _seen(notice), NOW, {"ban": ["NAVAREA XII 801/26"]})
    assert banned["launches"] == [] and _decisions(log)["NAVAREA XII 801/26"]["decision"] == "banned"
    lost, log = build_bundle(items, _seen(notice), NOW, {"pin": {"NAVAREA XII 801/26": "not-in-the-catalog"}})
    assert lost["launches"] == [] and _decisions(log)["NAVAREA XII 801/26"]["reasons"] == ["PIN_UNUSABLE"]


def test_window_open_rule_at_its_edges():
    notice = fx.broadcast_notice("navarea-iv-1080-26.txt")
    opens = _utc("2026-11-13T22:45")

    def launch(start: datetime, net: datetime | None = None):
        return _launch(
            fx.STARSHIP,
            net=(net or start).strftime("%Y-%m-%dT%H:%M:%SZ"),
            window_start=start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            window_end="2026-11-14T03:00:00Z",
        )

    assert in_force_at_window_open(launch(opens), notice) is True
    assert in_force_at_window_open(launch(opens - OPEN_SLACK, net=opens), notice) is True
    assert in_force_at_window_open(launch(opens - OPEN_SLACK), notice) is False
    assert in_force_at_window_open(launch(opens - OPEN_SLACK - timedelta(minutes=1), net=opens), notice) is False
    assert in_force_at_window_open(launch(opens + LEAD_MAX - timedelta(hours=5), net=_utc("2026-11-14T00:39")), notice) is True
    assert in_force_at_window_open(launch(opens, net=_utc("2026-11-14T00:40")), notice) is False
    late = _launch(fx.STARSHIP, net="2026-11-14T04:46:00Z", window_start="2026-11-14T04:46:00Z", window_end="2026-11-14T05:00:00Z")
    assert late.opens - LEAD_MAX > opens and in_force_at_window_open(late, notice) is False


def test_pad_distance_is_zero_inside_and_measured_to_the_nearest_edge_outside():
    launch = _launch(fx.STARSHIP)
    square = ((-97.3, 25.9), (-97.0, 25.9), (-97.0, 26.1), (-97.3, 26.1))
    assert pad_distance_km(launch, square) == 0.0
    east = tuple((lon + 0.5, lat) for lon, lat in square)
    assert pad_distance_km(launch, east) == pytest.approx(0.35799 * 111.32 * 0.89882, rel=0.01)
    assert pad_distance_km(launch, tuple((lon, lat + 1.0) for lon, lat in square)) == pytest.approx(0.90323 * 110.57, rel=0.01)
    assert pad_distance_km(launch, ((-97.1, 26.0), (-97.1, 26.0), (-97.1, 26.0))) == pytest.approx(5.8, abs=0.2)
    assert PAD_ANCHOR_KM == 25.0


def test_same_ring_allows_another_start_vertex_and_direction_but_not_another_shape():
    ring = fx.broadcast_notice("navarea-iv-1078-26.txt").areas[1].ring
    turned = fx.broadcast_notice("navarea-iv-1099-26.txt").areas[1].ring
    assert ring != turned and same_ring(ring, turned) and same_ring(ring, tuple(reversed(turned)))
    assert same_ring(ring, tuple((lon + 0.0009, lat) for lon, lat in turned))
    assert not same_ring(ring, tuple((lon + 0.0011, lat) for lon, lat in turned))
    assert not same_ring(ring, turned[:-1])


def test_a_launch_with_more_areas_than_the_map_accepts_is_left_out_whole():
    notice = fx.broadcast_notice("navarea-xii-in-force-2026-11-13.txt", "NAVAREA XII 797/26")
    assert len(notice.areas) == 11
    decoy = fx.item(fx.USSF_317, net="2026-11-16T23:50:00Z", window_start="2026-11-16T23:45:00Z", window_end="2026-11-17T01:00:00Z")
    decoy["site"].update(lat=33.65, lon=-119.2)
    others = ("NAVAREA XII 794/26", "NAVAREA XII 801/26", "NAVAREA XII 795/26")
    pins = {"pin": dict.fromkeys(("NAVAREA XII 797/26", *others), fx.USSF_317)}
    seen = _seen(notice, *(fx.broadcast_notice("navarea-xii-in-force-2026-11-13.txt", name) for name in others))
    bundle, log = build_bundle([decoy], seen, NOW, pins)
    assert bundle["launches"] == []
    assert "TOO_MANY_AREAS" in _decisions(log)["NAVAREA XII 797/26"]["reasons"]
    fits, _ = build_bundle([decoy], seen[:1], NOW, pins)
    assert len(fx.launch(fits, fx.USSF_317)["notices"]) == 11


@pytest.mark.parametrize("damage", [
    lambda b: b["launches"][0]["geojson"]["features"][0]["geometry"]["coordinates"][0].pop(),
    lambda b: b["launches"][0]["geojson"]["features"][0]["geometry"]["coordinates"][0].reverse(),
    lambda b: b["launches"][0]["geojson"]["features"][0]["geometry"].update(type="LineString"),
    lambda b: b["launches"][0]["geojson"]["features"][0]["geometry"]["coordinates"].append([]),
    lambda b: b["launches"][0]["geojson"]["features"][0]["geometry"]["coordinates"][0][1].__setitem__(0, 181.0),
    lambda b: b["launches"][0]["geojson"]["features"][0]["geometry"]["coordinates"][0].insert(1, b["launches"][0]["geojson"]["features"][0]["geometry"]["coordinates"][0][0]),
    lambda b: b["launches"][0]["geojson"]["features"][0]["properties"].update(area_id="Z"),
    lambda b: b["launches"][0]["geojson"]["features"].pop(),
    lambda b: b["launches"][0].update(direction={"kind": "none"}),
    lambda b: b["launches"][0]["notices"][0].update(tier="watch"),
    lambda b: b["launches"][0]["notices"][0].update(windows=[]),
    lambda b: b["launches"][0]["notices"][0]["windows"].reverse(),
    lambda b: b["launches"][0]["notices"][0]["windows"][0].update(end="2026-11-13T22:45:00Z"),
    lambda b: b["launches"][0]["notices"][0].update(checked_at="2026-11-13 10:02"),
    lambda b: b["launches"][0]["notices"][0].update(source_url="http://example.invalid/"),
    lambda b: b["launches"][0]["notices"][0].update(source_sha256="abc"),
    lambda b: b["launches"][0]["notices"][0].update(restriction_class="corridor"),
    lambda b: b["launches"][0]["notices"][0].update(instructions=["x" * 401]),
    lambda b: b["launches"][0]["notices"][0].update(notice_id=""),
    lambda b: b["launches"][0]["notices"].__setitem__(1, b["launches"][0]["notices"][0]),
    lambda b: b["launches"].append(b["launches"][0]),
    lambda b: b.update(label="Launch corridor"),
    lambda b: b.update(schema_version=1),
    lambda b: b.update(revision="latest"),
    lambda b: b.update(launches=[b["launches"][0]] * 33),
    lambda b: b["launches"][1].update(listed=None),
    lambda b: b["launches"][1].pop("listed"),
    lambda b: b["launches"][1].update(notices=[], geojson={"type": "FeatureCollection", "features": []}),
    lambda b: b["launches"][0]["listed"][0].update(reason="hazard"),
    lambda b: b["launches"][0]["listed"][0].update(text=""),
    lambda b: b["launches"][0]["listed"][0].update(text="x" * 401),
    lambda b: b["launches"][0]["listed"][0].update(ring=[[0, 0]]),
    lambda b: b["launches"][0]["listed"][0].update(source_url="http://example.invalid/"),
    lambda b: b["launches"][0]["listed"][0].update(source_sha256="abc"),
    lambda b: b["launches"][0]["listed"][0].update(valid_until="tomorrow"),
    lambda b: b["launches"][0].update(listed=b["launches"][0]["listed"] * 5),
])
def test_a_file_the_map_would_refuse_is_refused_before_it_is_written(damage):
    bundle = json.loads(fx.GOLDEN.read_text())
    validate_bundle(bundle)
    damage(bundle)
    with pytest.raises(ValueError, match="HAZARD_"):
        validate_bundle(bundle)
