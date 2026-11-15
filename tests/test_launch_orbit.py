from __future__ import annotations

import pytest

from generator.launch_orbit import (
    CONSTELLATION_RULES,
    ORBIT_CLASS_RULES,
    PROGRAM_RULES,
    UNVERIFIED,
    Basis,
    Branch,
    OrbitRule,
    inclination_from_ll2,
)


def row(name: str = "Unidentified payload", orbit: str = "LEO", program: str = "") -> dict:
    return {
        "name": name,
        "mission": {"name": name, "orbit": {"abbrev": orbit}},
        "program": [{"name": program}],
    }


@pytest.mark.parametrize(
    ("name", "deg"),
    [
        ("Amazon Leo", 51.9),
        ("Kuiper", 51.9),
        ("Starlink Group 6-1", 43),
        ("Starlink Group 12-1", 43),
        ("Starlink Group 8-1", 53.2),
        ("Starlink Group 10-1", 53.2),
        ("Starlink Group 9-1", 53),
        ("Starlink Group 11-1", 53),
        ("Starlink Group 15-1", 70),
        ("Starlink Group 17-1", 97.6),
        ("OneWeb", 87.9),
        ("Iridium", 86.4),
        ("Globalstar", 52),
        ("GPS", 55),
        ("Galileo", 56),
        ("GLONASS", 64.8),
    ],
)
def test_constellation_rules(name: str, deg: float) -> None:
    result = inclination_from_ll2(row(name), 28.583, -80.583)
    assert result is not None
    assert result.deg == deg
    assert result.basis is Basis.CONSTELLATION
    assert result.grade == "C"
    assert result.source


@pytest.mark.parametrize(
    ("name", "deg"),
    [
        ("International Space Station", 51.64),
        ("Tiangong space station", 41.5),
        ("Shenzhou", 41.5),
        ("Tianzhou", 41.5),
    ],
)
def test_program_precedes_constellation_and_class(name: str, deg: float) -> None:
    result = inclination_from_ll2(row("Amazon Leo", "SSO", name), 28.5, -80.6)
    assert result is not None
    assert result.basis is Basis.PROGRAM
    assert result.deg == deg
    assert result.grade == "C"


def test_stage_destination_is_also_a_program_rule() -> None:
    raw = {"rocket": {"spacecraft_stage": [{"destination": {"name": "ISS"}}]}}
    result = inclination_from_ll2(raw, 28.5, -80.6)
    assert result is not None
    assert result.deg == 51.64


@pytest.mark.parametrize(
    ("abbrev", "deg"),
    [
        ("SSO", 97.6),
        ("PO", 90),
        ("GTO", 28.5),
        ("Direct-GEO", 28.5),
        ("LO", 28.5),
        ("Mars", 28.5),
    ],
)
def test_orbit_classes(abbrev: str, deg: float) -> None:
    result = inclination_from_ll2(row(orbit=abbrev), -28.5, 120)
    assert result is not None
    assert result.basis is Basis.ORBIT_CLASS
    assert result.deg == deg
    assert result.grade == "C"


@pytest.mark.parametrize("abbrev", ["LEO", "MEO", "Sub", "N/A", "HEO", "Helio", ""])
def test_unknown_is_not_inferred_from_description(abbrev: str) -> None:
    raw = row(orbit=abbrev)
    raw["mission"]["description"] = "Amazon Leo 51.9 deg International Space Station SSO"
    assert inclination_from_ll2(raw, 28.5, -80.6) is None
    assert inclination_from_ll2({}, 28.5, -80.6) is None


def test_amazon_rule_is_independent_of_vehicle_date_and_mission_number() -> None:
    result = inclination_from_ll2(row("Any vehicle | Kuiper constellation"), 28.5, -80.6)
    assert result is not None
    assert result.branch_hint is Branch.NORTHBOUND
    assert result.deg == 51.9
    assert "FCC STA" in result.source
    assert "450 km deployment only" in result.source
    assert "other Amazon Leo shells use different inclinations" in result.source
    assert result.grade == "C"


def test_each_rule_preserves_its_source_and_grade() -> None:
    for rule in (*PROGRAM_RULES, *CONSTELLATION_RULES, *ORBIT_CLASS_RULES):
        assert rule.grade in {"B", "C"}
        assert UNVERIFIED in rule.source or "FCC STA" in rule.source
        if rule.source == UNVERIFIED:
            assert rule.grade in {"C", "D"}


@pytest.mark.parametrize(
    ("requested", "expected"), [("A", "C"), ("B", "C"), ("C", "C"), ("D", "D")]
)
def test_future_unverified_rule_cannot_claim_a_better_grade(
    monkeypatch: pytest.MonkeyPatch, requested: str, expected: str
) -> None:
    rule = OrbitRule(r"\bfuture constellation\b", 53.0, 0.5, UNVERIFIED, requested)
    assert rule.grade == expected
    monkeypatch.setattr("generator.launch_orbit.CONSTELLATION_RULES", (rule,))
    result = inclination_from_ll2(row("Future constellation"), 28.5, -80.6)
    assert result is not None
    assert result.grade == expected


def test_cited_rule_keeps_grade_b(monkeypatch: pytest.MonkeyPatch) -> None:
    rule = OrbitRule(r"\bfuture constellation\b", 53.0, 0.5, "Cited primary-document fixture", "B")
    monkeypatch.setattr("generator.launch_orbit.CONSTELLATION_RULES", (rule,))
    result = inclination_from_ll2(row("Future constellation"), 28.5, -80.6)
    assert result is not None
    assert result.grade == "B"


def test_branch_hint_applies_only_at_its_geographic_site() -> None:
    cape = inclination_from_ll2(row("Amazon Leo"), 28.5834, -80.583)
    vandenberg = inclination_from_ll2(row("Amazon Leo"), 34.632, -120.61)
    assert cape is not None and cape.branch_hint is Branch.NORTHBOUND
    assert vandenberg is not None and vandenberg.branch_hint is None
