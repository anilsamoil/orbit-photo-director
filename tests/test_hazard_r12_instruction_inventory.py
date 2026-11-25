from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import replace
from datetime import timedelta
from functools import partial
from io import StringIO
from pathlib import Path
from xml.sax.saxutils import escape

import pytest

from generator.hazard_match import Sighting, build_bundle, validate_bundle
from generator.hazard_notices import (
    Notice,
    NoticeError,
    notice_from_record,
    notice_record,
    parse_broadcast_warning,
    parse_faa_tfr,
    parse_nga_payload,
    parse_uscg_space_operations,
)
from generator.hazard_sources import (
    NGA_URL,
    USCG_FILE_URL,
    SourceError,
    refresh_sources,
    sightings_from_state,
)
from tests import hazard_fixtures as fx
from tests.test_hazard_r5_areas import _dateline_801
from tests.test_hazard_r5_relevance import _iv_row
from tests.test_hazard_r5b_relevance import _generic_rows
from tests.test_hazard_r10_match import AVOID_LAUNCH_WINDOW, AVOID_THREE_HOURS
from tests.test_hazard_r11_warnings import (
    AVOID_SPECIFIED_TIMES,
    REMAIN_CLEAR,
    STRONGLY_REMAIN_CLEAR,
    _uscg_payload,
    _with_advice,
)
from tests.test_hazard_refresh import Web
from tests.test_hazard_relevance import _payload

NOW = fx.SCENARIO_NOW
USCG_URL = USCG_FILE_URL.format(part=1)
CONTACT = (
    "For additional information regarding the launch, mariners can contact the U.S. "
    "Coast Guard Sector Corpus Christi Command Center at (361) 939-0450 or access: "
    "www.navcen.uscg.gov/msi"
)
FAA_ADDED = "AIRCRAFT MUST AVOID THIS AREA FOR THREE HOURS BEFORE THE PUBLISHED START TIME."
FAA_ORIGINAL = "SPACE OPS AREA: ACFT OPS ARE PROHIBITIED. EXCLUDING AIRSPACE OVER INTERNATIONAL WATERS."


def _uscg(payload: bytes) -> Notice:
    return next(
        notice for notice in parse_uscg_space_operations(payload, USCG_URL)
        if notice.notice_id == "USCG LNM 58067"
    )


def _entry(*notices: Notice) -> tuple[dict, list[dict]]:
    bundle, log = build_bundle(
        [fx.item(fx.STARSHIP)], [Sighting(notice, NOW) for notice in notices], NOW,
    )
    return fx.launch(bundle, fx.STARSHIP), log


def _assert_high(notice: Notice, expected: tuple[str, ...]) -> None:
    area = next(area for area in notice.areas if area.restriction_class == "high_risk")
    assert area.instructions == expected


def _uscg_clauses(_: Path) -> None:
    notice = _uscg(_uscg_payload(_with_advice(CONTACT, CONTACT)))
    _assert_high(notice, (AVOID_LAUNCH_WINDOW, AVOID_THREE_HOURS))


def _uscg_area_filter(_: Path) -> None:
    notice = _uscg(_uscg_payload(_with_advice(REMAIN_CLEAR, AVOID_SPECIFIED_TIMES)))
    expected = (AVOID_LAUNCH_WINDOW, REMAIN_CLEAR, AVOID_SPECIFIED_TIMES, AVOID_THREE_HOURS)
    _assert_high(notice, expected)
    ordinary = next(area for area in notice.areas if area.restriction_class == "hazard")
    assert ordinary.instructions == expected[:-1]


def _uscg_overflow(_: Path, strict: bool) -> None:
    payload = _uscg_payload(_with_advice(
        REMAIN_CLEAR, AVOID_SPECIFIED_TIMES, STRONGLY_REMAIN_CLEAR,
    ))
    if strict:
        with pytest.raises(NoticeError, match="^USCG_ROW$"):
            parse_uscg_space_operations(payload, USCG_URL)
    else:
        notice = next(
            notice for notice in parse_uscg_space_operations(payload, USCG_URL, strict=False)
            if notice.notice_id == "USCG LNM 58067"
        )
        assert "INSTRUCTIONS_OVERFLOW:HIGH RISK" in notice.problems
        _assert_high(notice, (
            AVOID_LAUNCH_WINDOW, REMAIN_CLEAR, AVOID_SPECIFIED_TIMES,
            STRONGLY_REMAIN_CLEAR, AVOID_THREE_HOURS,
        ))


def _uscg_unknown(_: Path) -> None:
    payload = _uscg_payload(_with_advice("Mariners must leave this area at a different time."))
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(payload, USCG_URL)


def _uscg_unknown_nonstrict(_: Path) -> None:
    advice = "Mariners must leave this area at a different time."
    payload = _uscg_payload(fx.uscg_description(58067) + "\n" + advice)
    notice = next(
        notice for notice in parse_uscg_space_operations(payload, USCG_URL, strict=False)
        if notice.notice_id == "USCG LNM 58067"
    )
    assert notice.problems == ("ADVICE_UNPARSED",)
    _assert_high(notice, (AVOID_LAUNCH_WINDOW, AVOID_THREE_HOURS, advice))
    assert notice_from_record(notice_record(notice)) == notice


def _uscg_length(_: Path) -> None:
    instruction = "Mariners must avoid " + "these hazardous waters " * 20 + "during launch."
    payload = _uscg_payload(_with_advice(instruction))
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(payload, USCG_URL)
    notice = next(
        notice for notice in parse_uscg_space_operations(payload, USCG_URL, strict=False)
        if notice.notice_id == "USCG LNM 58067"
    )
    unread = next(
        " ".join(line.replace("•", " ").split()).upper()
        for line in _with_advice(instruction).splitlines() if instruction in line
    )
    assert notice.problems == ("WINDOW_UNPARSED:" + unread[:60],)
    _assert_high(notice, (AVOID_THREE_HOURS,))
    assert notice_from_record(notice_record(notice)) == notice


def _uscg_supported_length(_: Path) -> None:
    instruction = (
        "For more details or comments contact AVOID " + "WATERS " * 60
        + "at OPS@EXAMPLE.COM or on VHF-FM Chan. 16 or 22."
    )
    payload = _uscg_payload(_with_advice(instruction))
    for strict in (True, False):
        with pytest.raises(NoticeError, match="^USCG_ROW$"):
            parse_uscg_space_operations(payload, USCG_URL, strict=strict)


def _uscg_unread_schedule(_: Path) -> None:
    unread = "13/2265Z Nov 26 to 14/0040Z Nov 26 " + "ADDITIONAL CONDITIONS " * 20
    description = fx.uscg_description(58067).replace(
        "13/2245Z Nov 26 to 14/0040Z Nov 26", unread,
    )
    payload = _uscg_payload(description)
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(payload, USCG_URL)
    notice = next(
        notice for notice in parse_uscg_space_operations(payload, USCG_URL, strict=False)
        if notice.notice_id == "USCG LNM 58067"
    )
    assert notice.problems == ("WINDOW_UNPARSED:" + unread.upper()[:60],)
    _assert_high(notice, (AVOID_LAUNCH_WINDOW, AVOID_THREE_HOURS))
    assert all(len(area.windows) == 6 for area in notice.areas)
    restored = notice_from_record(notice_record(notice))
    assert restored == notice
    entry, log = _entry(restored)
    assert entry["listed"][0]["reason"] == "unread_time"
    assert entry["listed"][0]["text"] == unread.upper()[:60]
    assert log[0]["problems"] == list(notice.problems)


def _uscg_prose(_: Path) -> None:
    notice = fx.uscg_notice(58060)
    assert notice.kind == "launch" and notice.areas == () and notice.problems == ()
    assert notice_from_record(notice_record(notice)) == notice
    bundle, log = build_bundle([fx.item(fx.STARSHIP)], [Sighting(notice, NOW)], NOW)
    assert bundle["launches"] == []
    assert [(row["decision"], row["reasons"]) for row in log] == [("rejected", ["NO_AREAS"])]
    payload = json.loads((fx.NOTICES / fx.USCG).read_bytes())
    feature = next(row for row in payload["features"] if row["properties"]["MSI_UID"] == 58060)
    payload["features"] = [feature]
    feature["properties"]["DESCRIPTION"] += " ADDITIONAL OPERATIONS ARE UNREADABLE."
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(json.dumps(payload).encode(), USCG_URL)


def _nga_generic(_: Path) -> None:
    row = _iv_row(329)
    (notice,) = parse_nga_payload(_payload([row]), NGA_URL.format(area="4"))
    assert notice.kind == "standing_closure"
    assert [(area.area_id, area.restriction_class, area.instructions, area.windows) for area in notice.areas] == [
        ("A", "prohibition", (), ()), ("B", "prohibition", (), ()),
    ]
    assert notice.cancels == ("NAVAREA IV 326/23",) and notice.valid_until is None
    assert notice_from_record(notice_record(notice)) == notice
    row["text"] += "3. MARINERS MUST AVOID THIS AREA FOR THREE HOURS BEFORE LAUNCH."
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([row]), NGA_URL.format(area="4"))


def _nga_relevance(_: Path) -> None:
    row = dict(next(row for row in _generic_rows() if row["msgNumber"] == 795))
    (notice,) = parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))
    assert notice.kind == "other" and notice.problems == ()
    row["text"] = row["text"].replace("33-59.00N", "33-59.01N", 1)
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))
    ident, issued, _ = fx.broadcast_blocks("navarea-iv-1080-26.txt")[0]
    text = "1. SCIENTIFIC MOORINGS AT DEPTH 15 METERS.\n2. MARINERS MUST KEEP CLEAR."
    notice = parse_broadcast_warning(text, ident, issued, USCG_URL, "a" * 64, strict=True)
    assert notice.kind == "other" and notice.areas == ()
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_broadcast_warning(
            text, ident, issued, USCG_URL, "a" * 64, strict=True,
            authority="SPACE LAUNCH DELTA 0/23",
        )


def _nga_other_preview(_: Path) -> None:
    ident, issued, _ = fx.broadcast_blocks("navarea-iv-1080-26.txt")[0]
    text = "1. SCIENTIFIC MOORINGS " + "AT DEPTH 15 METERS " * 30 + "."
    output = StringIO()
    handler = logging.StreamHandler(output)
    logger = logging.getLogger("generator.hazard_notices")
    logger.addHandler(handler)
    try:
        notice = parse_broadcast_warning(text, ident, issued, USCG_URL, "a" * 64, strict=True)
    finally:
        logger.removeHandler(handler)
    assert notice.kind == "other" and notice.areas == () and notice.problems == ()
    assert notice.subject == text[:280].rstrip()
    assert notice_from_record(notice_record(notice)) == notice
    assert f"DROP_OTHER notice_id={ident} reason=NON_LAUNCH_MARINE_ACTIVITY" in output.getvalue()
    bundle, log = build_bundle([fx.item(fx.STARSHIP)], [Sighting(notice, NOW)], NOW)
    assert bundle["launches"] == []
    assert [(row["decision"], row["reasons"]) for row in log] == [("not_launch", ["other"])]


def _nga_unknown(_: Path, json_source: bool) -> None:
    ident, issued, text = fx.broadcast_blocks("navarea-iv-1080-26.txt")[0]
    text += "3. MARINERS MUST AVOID THIS AREA FOR THREE HOURS BEFORE LAUNCH.\n"
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        if json_source:
            payload = json.dumps({"broadcast-warn": [{
                "navArea": "4", "msgNumber": 1080, "msgYear": 2026,
                "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(), "text": text,
            }]}).encode()
            parse_nga_payload(payload, NGA_URL.format(area="4"))
        else:
            parse_broadcast_warning(
                text, ident, issued, NGA_URL.format(area="4"), "a" * 64, strict=True,
            )


def _nga_baseline(_: Path) -> None:
    notice = fx.broadcast_notice("navarea-iv-1080-26.txt")
    assert tuple((area.area_id, area.restriction_class, area.instructions) for area in notice.areas) == (
        ("A", "hazard", ()), ("B", "hazard", ()),
    )


def _faa_paragraphs(_: Path, before: bool) -> None:
    name = "faa-tfr-6-7129.xml"
    body = (fx.NOTICES / name).read_text()
    start = body.index("<txtInstr>") + len("<txtInstr>")
    end = body.index("</txtInstr>", start)
    content = (
        f"{escape(FAA_ADDED)}\n\n{body[start:end]}" if before
        else f"{body[start:end]}\n\n{escape(FAA_ADDED)}"
    )
    notice = parse_faa_tfr((body[:start] + content + body[end:]).encode(), fx.manifest(name)["source_url"])
    words = [instruction for area in notice.areas for instruction in area.instructions]
    assert FAA_ORIGINAL in words and FAA_ADDED in words
    expected = [FAA_ADDED, FAA_ORIGINAL] if before else [FAA_ORIGINAL, FAA_ADDED]
    assert words[1:] == expected


def _faa_reject(_: Path, overflow: bool) -> None:
    name = "faa-tfr-6-7129.xml"
    body = (fx.NOTICES / name).read_text()
    extra = ("\n\n" + FAA_ADDED) * 3 if overflow else "\n\nUNSUPPORTED OPERATING CONDITION."
    body = body.replace("</txtInstr>", escape(extra) + "</txtInstr>")
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(body.encode(), fx.manifest(name)["source_url"])


def _faa_baseline(_: Path) -> None:
    notice = fx.faa_notice("faa-tfr-6-7129.xml")
    assert notice.areas[0].restriction_class == "restricted_airspace"
    assert notice.areas[0].instructions == ("SFC-UNL.", FAA_ORIGINAL)


def _faa_instruction_nodes(_: Path, case: str) -> None:
    name = "faa-tfr-6-7129.xml"
    body = (fx.NOTICES / name).read_text()
    if case == "missing":
        body = re.sub(r"<InstructionsGroup>.*?</InstructionsGroup>", "", body, flags=re.S)
    elif case == "missing-node":
        body = re.sub(r"<txtInstr>.*?</txtInstr>", "", body, flags=re.S)
    elif case == "duplicate":
        body = body.replace("</txtInstr>", "</txtInstr><txtInstr>" + FAA_ADDED + "</txtInstr>")
    else:
        body = re.sub(r"<txtInstr>.*?</txtInstr>", "<txtInstr/>", body, flags=re.S)
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(body.encode(), fx.manifest(name)["source_url"])


def _faa_instruction_length(_: Path) -> None:
    name = "faa-tfr-6-7129.xml"
    body = (fx.NOTICES / name).read_text()
    instruction = " ".join([FAA_ADDED] * 6)
    assert len(instruction) > 400
    body = body.replace("</txtInstr>", escape("\n\n" + instruction) + "</txtInstr>")
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(body.encode(), fx.manifest(name)["source_url"])


def _cache_roundtrip(_: Path) -> None:
    notice = _uscg(_uscg_payload(_with_advice(REMAIN_CLEAR, AVOID_SPECIFIED_TIMES)))
    restored = notice_from_record(json.loads(json.dumps(notice_record(notice))))
    assert restored == notice
    _assert_high(restored, (
        AVOID_LAUNCH_WINDOW, REMAIN_CLEAR, AVOID_SPECIFIED_TIMES, AVOID_THREE_HOURS,
    ))


def _confirmed_cache(tmp_path: Path, invalid: bool) -> None:
    web = Web(complete=True)
    web.pages[USCG_URL] = _uscg_payload(_with_advice(REMAIN_CLEAR, AVOID_SPECIFIED_TIMES))
    sources = refresh_sources(tmp_path / "cache", NOW, fetch=web, pause=lambda _: None)
    record = next(
        notice for notice in sources["uscg"]["notices"]
        if notice["notice_id"] == "USCG LNM 58067"
    )
    if invalid:
        record["areas"][0]["instructions"].append(7)
        with pytest.raises(SourceError, match="^SOURCE_STATE_INCOMPLETE$"):
            sightings_from_state(sources, NOW)
    else:
        notice = next(
            sighting.notice for sighting in sightings_from_state(sources, NOW)
            if sighting.notice.notice_id == "USCG LNM 58067"
        )
        _assert_high(notice, (
            AVOID_LAUNCH_WINDOW, REMAIN_CLEAR, AVOID_SPECIFIED_TIMES, AVOID_THREE_HOURS,
        ))


def _dedupe(_: Path, difference: str) -> None:
    original = fx.uscg_notice(58067)
    alias = replace(original, notice_id="USCG LNM 58066")
    if difference:
        high, other = alias.areas
        high = replace(high, **{
            difference: "hazard" if difference == "restriction_class" else (AVOID_LAUNCH_WINDOW,),
        })
        alias = replace(alias, areas=(high, other))
    entry, log = _entry(original, alias)
    high_rows = [row for row in entry["notices"] if row["area_id"] == "HIGH RISK"]
    assert len(high_rows) == (2 if difference else 1)
    strongest = next(row for row in high_rows if row["restriction_class"] == "high_risk" and AVOID_THREE_HOURS in row["instructions"])
    assert strongest["instructions"] == [AVOID_LAUNCH_WINDOW, AVOID_THREE_HOURS]
    if not difference:
        assert strongest["also"] == ["USCG LNM 58067"]
        assert "SAME_AREA_AS:USCG LNM 58066" in next(
            row["reasons"] for row in log if row["notice_id"] == "USCG LNM 58067"
        )


def _fill(_: Path, difference: str) -> None:
    original = fx.uscg_notice(58067)
    high, other = original.areas
    alias_high = replace(high, **{
        difference: "hazard" if difference == "restriction_class" else (AVOID_LAUNCH_WINDOW,),
    })
    alias = replace(original, notice_id="USCG LNM 58068", areas=(alias_high, other))
    entry, log = _entry(alias, original, fx.broadcast_notice("navarea-iv-1080-26.txt"))
    enriched = next(row for row in entry["notices"] if row["notice_id"] == "NAVAREA IV 1080/26" and row["area_id"] == "B")
    assert enriched["restriction_class"] == "high_risk"
    assert enriched["instructions"] == [AVOID_LAUNCH_WINDOW, AVOID_THREE_HOURS]
    separate = next(row for row in entry["notices"] if row["notice_id"] == "USCG LNM 58068")
    assert separate[difference] == ("hazard" if difference == "restriction_class" else [AVOID_LAUNCH_WINDOW])
    assert "CROSS_CHECK_OF:NAVAREA IV 1080/26" in next(
        row["reasons"] for row in log if row["notice_id"] == "USCG LNM 58067"
    )


def _bundle_bound(_: Path, field: str) -> None:
    notice = fx.uscg_notice(58067)
    high = notice.areas[0]
    change = {
        "count": {"instructions": ("A", "B", "C", "D", "E")},
        "length": {"instructions": ("A" * 401,)},
        "class": {"restriction_class": "unrecognized"},
    }[field]
    notice = replace(notice, areas=(replace(high, **change),))
    with pytest.raises(ValueError, match="^HAZARD_CLASS$" if field == "class" else "^HAZARD_TEXT$"):
        _entry(notice)


def _bundle_alignment(_: Path, duplicate: bool) -> None:
    bundle, _ = build_bundle([fx.item(fx.STARSHIP)], [Sighting(fx.uscg_notice(58067), NOW)], NOW)
    entry = fx.launch(bundle, fx.STARSHIP)
    if duplicate:
        entry["notices"].append(entry["notices"][0].copy())
        entry["geojson"]["features"].append(entry["geojson"]["features"][0].copy())
    else:
        entry["geojson"]["features"][0]["properties"]["restriction_class"] = "restricted_airspace"
    with pytest.raises(ValueError, match="^HAZARD_DUPLICATE$" if duplicate else "^HAZARD_FEATURE$"):
        validate_bundle(bundle)


def _undrawn(_: Path) -> None:
    (notice,) = parse_nga_payload(_dateline_801(), NGA_URL.format(area="12"))
    restored = notice_from_record(notice_record(notice))
    assert restored == notice
    bundle, log = build_bundle([fx.item(fx.USSF_317)], [Sighting(restored, NOW)], NOW)
    entry = fx.launch(bundle, fx.USSF_317)
    assert [row["area_id"] for row in entry["notices"]] == ["A", "B"]
    assert entry["listed"][0]["text"] == "Area C is not drawn because its ring crosses the antimeridian."
    assert log[0]["problems"] == ["GEOMETRY_UNDRAWN:ANTIMERIDIAN:C"]


def _listing(_: Path, too_long: bool) -> None:
    notice = fx.uscg_notice(58225)
    expected = (
        "MARINERS ARE URGED TO AVOID WATERS WITHIN ROCKET FLIGHT TRAJECTORIES/HAZARD "
        "AREAS DURING LAUNCH WINDOWS AS DETAILED ABOVE.",
    )
    subject = (
        "Active RNA. Space Operations/Active RNA/Government Supported (RNA) 1. SPACE "
        "LAUNCH OPERATIONS, WHICH MAY BE HAZARDOUS TO SURFACE VESSELS, WILL BE "
        "CONDUCTED WITHIN PORTIONS OF THE FOLLOWING HAZARD AREAS FOR VULCAN KV-01:"
    )
    assert notice.areas[0].instructions == expected
    assert notice.subject == subject
    assert notice_from_record(notice_record(notice)).areas[0].instructions == expected
    subject = "A" * 401 + " VESSELS MUST AVOID THE AREA." if too_long else subject
    notice = replace(notice, subject=subject)
    if too_long:
        with pytest.raises(ValueError, match="^HAZARD_LISTED$"):
            build_bundle([fx.item(fx.VULCAN)], [Sighting(notice, NOW)], NOW)
    else:
        bundle, log = build_bundle([fx.item(fx.VULCAN)], [Sighting(notice, NOW)], NOW)
        entry = fx.launch(bundle, fx.VULCAN)
        assert entry["notices"] == []
        assert entry["listed"][0]["text"] == subject
        assert entry["listed"][0]["reason"] == "not_drawn"
        assert log[0]["decision"] == "listed"


def _listing_validation(_: Path, case: str) -> None:
    bundle, _ = build_bundle([fx.item(fx.VULCAN)], [Sighting(fx.uscg_notice(58225), NOW)], NOW)
    entry = fx.launch(bundle, fx.VULCAN)
    if case == "count":
        entry["listed"] *= 9
    elif case == "reason":
        entry["listed"][0]["reason"] = "hazard"
    elif case == "url":
        entry["listed"][0]["source_url"] = "http://example.invalid/"
    elif case == "sha":
        entry["listed"][0]["source_sha256"] = "unverified"
    else:
        entry["listed"][0][case] = ""
    with pytest.raises(ValueError, match="^HAZARD_LISTED$"):
        validate_bundle(bundle)


def _eligibility(_: Path) -> None:
    original = fx.uscg_notice(58067)
    launch = fx.item(fx.STARSHIP)
    duplicate = json.loads(json.dumps(launch))
    duplicate["event_id"] = "second-launch"
    cancelled_by = replace(original, notice_id="USCG LNM 58068", kind="recovery", areas=(), cancels=(original.notice_id,))
    cases = (
        (original, NOW, [launch], {"ban": [original.notice_id]}, (), "banned", []),
        (original, NOW, [launch], None, (Sighting(cancelled_by, NOW),), "cancelled", []),
        (replace(original, valid_until=NOW), NOW, [launch], None, (), "expired", []),
        (original, NOW - timedelta(hours=48), [launch], None, (), "stale", []),
        (original, NOW, [launch, duplicate], None, (), "ambiguous", [fx.STARSHIP, "second-launch"]),
        (original, NOW, [], None, (), "unmatched", ["NO_LAUNCH_AT_PAD_AND_TIME"]),
        (replace(original, kind="recovery"), NOW, [launch], None, (), "not_launch", ["recovery"]),
        (replace(original, kind="standing_closure"), NOW, [launch], None, (), "unmatched", ["STANDING_CLOSURE_NO_LAUNCH_WINDOW"]),
    )
    for notice, checked, items, overrides, extra, decision, reasons in cases:
        restored = notice_from_record(notice_record(notice))
        assert restored == notice
        assert tuple((area.restriction_class, area.instructions) for area in restored.areas) == tuple(
            (area.restriction_class, area.instructions) for area in original.areas
        )
        bundle, log = build_bundle(items, [Sighting(restored, checked), *extra], NOW, overrides)
        assert bundle["launches"] == []
        assert len(log) == 1 + len(extra)
        row = next(row for row in log if row["notice_id"] == original.notice_id)
        assert (row["decision"], row["event_id"], row["reasons"]) == (decision, None, reasons)


Probe = Callable[[Path], None]
CASES: tuple[tuple[str, Probe], ...] = (
    ("N1-N3-nga-default-fields", _nga_baseline),
    ("N4-nga-broadcast-unconsumed-advice", partial(_nga_unknown, json_source=False)),
    ("N5-nga-json-unconsumed-advice", partial(_nga_unknown, json_source=True)),
    ("N6-nga-generic-prohibition-and-unconsumed-advice", _nga_generic),
    ("N7-nga-relevance-exclusions-need-proof", _nga_relevance),
    ("N8-nga-other-preview-logs-exclusion", _nga_other_preview),
    ("U1-U3-uscg-clause-partition", _uscg_clauses),
    ("U4-uscg-applicable-order-and-class", _uscg_area_filter),
    ("U5-uscg-strict-capacity", partial(_uscg_overflow, strict=True)),
    ("U6-uscg-nonstrict-capacity", partial(_uscg_overflow, strict=False)),
    ("U7-uscg-unknown-advice", _uscg_unknown),
    ("U7-uscg-nonstrict-advice-retention", _uscg_unknown_nonstrict),
    ("U8-uscg-mixed-line-fails-closed", _uscg_length),
    ("U8-uscg-instruction-length", _uscg_supported_length),
    ("U9-uscg-unread-schedule-preview", _uscg_unread_schedule),
    ("U10-uscg-prose-advice-without-drawn-areas", _uscg_prose),
    ("F1-F2-faa-real-boilerplate-and-altitude", _faa_baseline),
    ("F3-faa-trailing-paragraph", partial(_faa_paragraphs, before=False)),
    ("F4-faa-leading-paragraph", partial(_faa_paragraphs, before=True)),
    ("F5-faa-unsupported-instructions", partial(_faa_reject, overflow=False)),
    ("F5-faa-missing-instruction-group", partial(_faa_instruction_nodes, case="missing")),
    ("F5-faa-missing-instruction-node", partial(_faa_instruction_nodes, case="missing-node")),
    ("F5-faa-duplicate-instruction-node", partial(_faa_instruction_nodes, case="duplicate")),
    ("F5-faa-empty-instruction-node", partial(_faa_instruction_nodes, case="empty")),
    ("F6-faa-instruction-capacity", partial(_faa_reject, overflow=True)),
    ("F6-faa-instruction-length", _faa_instruction_length),
    ("C1-C2-cache-roundtrip", _cache_roundtrip),
    ("C3-cache-confirmation", partial(_confirmed_cache, invalid=False)),
    ("C4-cache-invalid-warning-type", partial(_confirmed_cache, invalid=True)),
    ("M1-M2-M6-identical-alias-and-note", partial(_dedupe, difference="")),
    ("M3-class-difference", partial(_dedupe, difference="restriction_class")),
    ("M4-instruction-difference", partial(_dedupe, difference="instructions")),
    ("M5-nga-fill-class-difference", partial(_fill, difference="restriction_class")),
    ("M5-nga-fill-instruction-difference", partial(_fill, difference="instructions")),
    ("B1-B2-bundle-capacity", partial(_bundle_bound, field="count")),
    ("B3-bundle-instruction-length", partial(_bundle_bound, field="length")),
    ("B4-bundle-class", partial(_bundle_bound, field="class")),
    ("B4-bundle-duplicate", partial(_bundle_alignment, duplicate=True)),
    ("B4-bundle-feature-class-alignment", partial(_bundle_alignment, duplicate=False)),
    ("L1-L2-undrawn-cache-and-diagnostic", _undrawn),
    ("L3-regulated-cache-and-disclosed-listing", partial(_listing, too_long=False)),
    ("L4-L5-listing-length", partial(_listing, too_long=True)),
    ("L5-listing-count", partial(_listing_validation, case="count")),
    ("L5-listing-reason", partial(_listing_validation, case="reason")),
    ("L5-listing-source-url", partial(_listing_validation, case="url")),
    ("L5-listing-source-sha", partial(_listing_validation, case="sha")),
    ("L5-listing-authority", partial(_listing_validation, case="authority")),
    ("L5-listing-notice-id", partial(_listing_validation, case="notice_id")),
    ("L5-listing-empty-text", partial(_listing_validation, case="text")),
    ("L6-eligibility-decisions-keep-cached-warnings", _eligibility),
)


@pytest.mark.parametrize("probe", [pytest.param(probe, id=name) for name, probe in CASES])
def test_instruction_inventory_keeps_warnings_or_fails_closed(tmp_path: Path, probe: Probe) -> None:
    probe(tmp_path)
