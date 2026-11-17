from __future__ import annotations

from datetime import UTC, datetime

import pytest

from generator.hazard_notices import (
    NoticeError,
    _launch_relevance,
    parse_broadcast_warning,
    parse_nga_payload,
)
from generator.hazard_sources import NGA_URL
from tests.test_hazard_r5_relevance import _retains_publication
from tests.test_hazard_r5b_relevance import _generic_rows
from tests.test_hazard_relevance import _payload, _xii_rows


def _row_801() -> dict:
    return next(row for row in _xii_rows() if row["msgNumber"] == 801)


def _damage(text: str, kind: str) -> str:
    if kind == "missing_cause":
        assert ", ROCKET LAUNCHING:" in text
        return text.replace(", ROCKET LAUNCHING:", "", 1)
    start, end = text.index("   B."), text.index("   C.")
    return text[:start] + text[end:]


@pytest.mark.parametrize("kind", ("missing_cause", "missing_middle_area"))
@pytest.mark.parametrize("surface", ("broadcast", "nga"))
def test_801_damage_fails_strict_confirmation(kind: str, surface: str) -> None:
    row = _row_801()
    row["text"] = _damage(row["text"], kind)
    issued = datetime.strptime(row["issueDate"], "%d%H%MZ %b %Y").replace(tzinfo=UTC)
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        if surface == "broadcast":
            parse_broadcast_warning(row["text"], "NAVAREA XII 801/26", issued,
                                    "https://example.invalid/", "a" * 64, strict=True)
        else:
            parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))


@pytest.mark.parametrize("kind", ("missing_cause", "missing_middle_area"))
def test_801_damage_retains_warm_publication(tmp_path, kind: str) -> None:
    row = _row_801()
    original = _payload([row])
    row["text"] = _damage(row["text"], kind)
    _retains_publication(tmp_path, "nga:12", NGA_URL.format(area="12"), original,
                         _payload([row]), "NAVAREA XII 801/26")


def test_complete_generic_body_does_not_prove_an_unknown_id_irrelevant() -> None:
    row = dict(next(row for row in _generic_rows() if row["msgNumber"] == 795))
    row["msgNumber"] = 999
    issued = datetime.strptime(row["issueDate"], "%d%H%MZ %b %Y").replace(tzinfo=UTC)
    assert _launch_relevance(row["text"], issued=issued).name == "UNCERTAIN"
    notice = parse_broadcast_warning(row["text"], "NAVAREA XII 999/26", issued,
                                     "https://example.invalid/", "a" * 64)
    assert "RELEVANCE_UNCERTAIN" in notice.problems
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))


@pytest.mark.parametrize("number", (789, 745, 639))
def test_named_nonspace_causes_do_not_depend_on_audited_id(number: int) -> None:
    row = next(row for row in _xii_rows() if row["msgNumber"] == number)
    row["msgNumber"] = 999
    (notice,) = parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))
    assert notice.kind == "other"


@pytest.mark.parametrize("cause", ("GUNNERY FIRING", "DREDGING OPERATIONS", "MILITARY EXERCISES"))
def test_explicit_nonspace_vocabulary_excludes_renamed_generic_row(cause: str) -> None:
    row = dict(next(row for row in _generic_rows() if row["msgNumber"] == 795))
    row["msgNumber"] = 999
    row["text"] = row["text"].replace("HAZARDOUS OPERATIONS", f"HAZARDOUS OPERATIONS, {cause}", 1)
    (notice,) = parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))
    assert notice.kind == "other"
