from __future__ import annotations

from pathlib import Path

import pytest

from generator.hazard_notices import NoticeError, parse_broadcast_warning, parse_nga_payload
from generator.hazard_sources import NGA_URL
from tests import hazard_fixtures as fx
from tests.test_hazard_r5_relevance import _iv_row, _retains_publication
from tests.test_hazard_relevance import _payload


def _mixed_marine_body(label: str, paragraph: bool) -> str:
    separator = "\n2. MARINERS ARE ADVISED OF " if paragraph else " "
    return (
        "1. SCIENTIFIC MOORINGS AT DEPTH 15 METERS."
        + separator + label + ":\n"
        "32-10.00N 120-10.00W, 32-10.00N 120-20.00W, 32-20.00N 120-10.00W.\n"
        "13/2245Z NOV 26 TO 14/0040Z NOV 26.\n"
        "MARINERS MUST AVOID THIS AREA."
    )


@pytest.mark.parametrize("label", (
    "HAZARD AREA", "HIGH RISK HAZARD AREA", "HAZARD AREAS",
    "HAZARD  AREA", "HAZARD\nAREA", "HAZARD\tAREA",
))
@pytest.mark.parametrize("paragraph", (False, True))
def test_marine_prefix_cannot_exclude_hazard_area_content(label: str, paragraph: bool) -> None:
    text = _mixed_marine_body(label, paragraph)
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_broadcast_warning(
            text, "NAVAREA IV 1231/23", fx.SCENARIO_NOW, NGA_URL.format(area="4"),
            "a" * 64, strict=True,
        )
    diagnostic = parse_broadcast_warning(
        text, "NAVAREA IV 1231/23", fx.SCENARIO_NOW, NGA_URL.format(area="4"), "a" * 64,
    )
    assert "RELEVANCE_UNCERTAIN" in diagnostic.problems
    row = dict(_iv_row(1231), text=text, authority="")
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([row]), NGA_URL.format(area="4"))


@pytest.mark.parametrize("label", (
    "HIGH RISK HAZARD AREA", "HAZARD  AREA", "HAZARD\nAREA", "HAZARD\tAREA",
))
def test_mixed_marine_hazard_content_retains_warm_publication(tmp_path: Path, label: str) -> None:
    original = _iv_row(1231)
    changed = dict(original, text=_mixed_marine_body(label, True), authority="")
    _retains_publication(
        tmp_path, "nga:4", NGA_URL.format(area="4"), _payload([original]),
        _payload([changed]), "NAVAREA IV 1231/23",
    )


@pytest.mark.parametrize("non_drawn", ("standing_closure", "space_debris", "audited_other"))
def test_nondrawn_nga_grammar_rejects_appended_launch_block(non_drawn: str) -> None:
    if non_drawn == "standing_closure":
        row = _iv_row(329)
    elif non_drawn == "audited_other":
        row = _iv_row(222)
    else:
        notice_id, issued, text = next(
            row for row in fx.broadcast_blocks("navarea-xii-in-force-2026-11-13.txt")
            if row[0] == "NAVAREA XII 788/26"
        )
        row = {
            "navArea": "12", "msgNumber": 788, "msgYear": 2026,
            "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(), "text": text,
        }
        assert notice_id == "NAVAREA XII 788/26"
    changed = dict(row, text=str(row["text"]) + "\nHAZARD AREA FOR LAUNCH OPERATIONS:\n"
                   "13/2245Z NOV 26 TO 14/0040Z NOV 26. MARINERS MUST AVOID THIS AREA.")
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([changed]), NGA_URL.format(area=row["navArea"]))
