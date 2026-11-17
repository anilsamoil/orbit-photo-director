from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

from generator.hazard_notices import NoticeError, parse_broadcast_warning, parse_nga_payload
from generator.hazard_sources import NGA_URL
from tests.test_hazard_r5b_relevance import _generic_rows
from tests.test_hazard_relevance import _payload, _retains_source, _xii_rows


def _identity(row: dict) -> str:
    series = "NAVAREA XII" if str(row["navArea"]) == "12" else "NAVAREA IV"
    return f"{series} {row['msgNumber']}/{row['msgYear'] % 100:02d}"


def _issued(row: dict) -> datetime:
    return datetime.strptime(row["issueDate"], "%d%H%MZ %b %Y").replace(tzinfo=UTC)


def _replacement(kind: str) -> dict:
    if kind == "801_as_795":
        row = next(row for row in _xii_rows() if row["msgNumber"] == 801)
        row["msgNumber"] = 795
        row["text"] = row["text"].replace(", ROCKET LAUNCHING:", "", 1)
        assert ", ROCKET LAUNCHING:" not in row["text"]
        return row
    row = dict(next(row for row in _generic_rows() if row["msgNumber"] == 795))
    assert "33-59.00N" in row["text"]
    row["text"] = row["text"].replace("33-59.00N", "33-59.01N", 1)
    return row


@pytest.mark.parametrize("row", _generic_rows(), ids=_identity)
@pytest.mark.parametrize("surface", ("broadcast", "nga"))
@pytest.mark.parametrize("normalized", (False, True))
def test_audited_captured_body_still_drops(
    row: dict, surface: str, normalized: bool,
) -> None:
    row = dict(row)
    if normalized:
        row["text"] = "\n".join(line + " \t " for line in row["text"].splitlines()) + "\n\n"
    if surface == "broadcast":
        notice = parse_broadcast_warning(
            row["text"], _identity(row), _issued(row), "https://example.invalid/", "a" * 64,
            strict=True, authority=row.get("authority"),
        )
    else:
        (notice,) = parse_nga_payload(_payload([row]), NGA_URL.format(area=row["navArea"]))
    assert notice.kind == "other" and not notice.problems


@pytest.mark.parametrize("kind", ("801_as_795", "one_coordinate"))
@pytest.mark.parametrize("surface", ("broadcast", "nga"))
def test_audited_exclusion_rejects_replacement_body(kind: str, surface: str) -> None:
    row = _replacement(kind)
    diagnostic = parse_broadcast_warning(
        row["text"], _identity(row), _issued(row), "https://example.invalid/", "a" * 64,
    )
    assert "RELEVANCE_UNCERTAIN" in diagnostic.problems
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        if surface == "broadcast":
            parse_broadcast_warning(
                row["text"], _identity(row), _issued(row), "https://example.invalid/", "a" * 64,
                strict=True,
            )
        else:
            parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))


@pytest.mark.parametrize("row", _generic_rows(), ids=_identity)
def test_each_audited_exclusion_requires_reaudit_after_a_coordinate_change(row: dict) -> None:
    row = dict(row)
    text, changes = re.subn(
        r"(\d{2}-\d{2})\.\d{2}N", r"\1.01N", row["text"], count=1,
    )
    assert changes == 1 and text != row["text"]
    diagnostic = parse_broadcast_warning(
        text, _identity(row), _issued(row), "https://example.invalid/", "a" * 64,
    )
    assert "RELEVANCE_UNCERTAIN" in diagnostic.problems
    row["text"] = text
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([row]), NGA_URL.format(area=row["navArea"]))


@pytest.mark.parametrize("activity", ("SCIENTIFIC MOORINGS", "ROCKET LAUNCHING"))
def test_changed_audited_body_requires_reaudit_even_with_a_named_cause(activity: str) -> None:
    row = dict(next(row for row in _generic_rows() if row["msgNumber"] == 795))
    row["text"] = row["text"].replace("HAZARDOUS OPERATIONS", f"HAZARDOUS OPERATIONS, {activity}", 1)
    diagnostic = parse_broadcast_warning(
        row["text"], _identity(row), _issued(row), "https://example.invalid/", "a" * 64,
    )
    assert "RELEVANCE_UNCERTAIN" in diagnostic.problems
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))


@pytest.mark.parametrize("kind", ("801_as_795", "one_coordinate"))
def test_audited_replacement_retains_warm_publication(tmp_path: Path, kind: str) -> None:
    _retains_source(
        tmp_path, "nga:12", NGA_URL.format(area="12"), _payload([_replacement(kind)]),
    )
