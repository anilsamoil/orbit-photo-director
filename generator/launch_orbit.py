"""Inclination estimates from structured LL2 labels, never mission prose."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum

from .orbit import great_circle_km

UNVERIFIED = "unverified: not checked against a primary document"


class Branch(StrEnum):
    NORTHBOUND = "northbound"
    SOUTHBOUND = "southbound"
    EAST = "east"


class Basis(StrEnum):
    PROGRAM = "program"
    CONSTELLATION = "constellation"
    ORBIT_CLASS = "orbit_class"


@dataclass(frozen=True)
class Inclination:
    deg: float
    sigma_deg: float
    basis: Basis
    source: str
    grade: str
    branch_hint: Branch | None = None


@dataclass(frozen=True)
class OrbitRule:
    pattern: str
    deg: float | None
    sigma_deg: float
    source: str
    grade: str
    branch_hint: Branch | None = None
    hint_site: tuple[float, float] | None = None

    def __post_init__(self) -> None:
        if self.source == UNVERIFIED and self.grade in {"A", "B"}:
            object.__setattr__(self, "grade", "C")


PROGRAM_RULES = (
    OrbitRule(r"\b(international space station|iss)\b", 51.64, 0.1, UNVERIFIED, "B"),
    OrbitRule(r"\b(tiangong|shenzhou|tianzhou)\b", 41.5, 0.3, UNVERIFIED, "B"),
)
CONSTELLATION_RULES = (
    OrbitRule(
        r"\b(amazon leo|kuiper)\b",
        51.9,
        0.5,
        "FCC STA application quoted at https://forum.nasaspaceflight.com/index.php?topic=63084.0; "
        "For Amazon Leo/Kuiper, 51.9 deg is sourced for the 450 km deployment only, "
        "on a northerly trajectory from the Cape. "
        "This estimate may not apply to this launch because other Amazon Leo shells use "
        "different inclinations. "
        "A constellation estimate, not a published trajectory for this launch.",
        "C",
        Branch.NORTHBOUND,
        (28.5, -80.6),
    ),
    OrbitRule(
        r"\bstarlink group (6|12)\b", 43.0, 0.5, UNVERIFIED, "B", Branch.SOUTHBOUND, (28.5, -80.6)
    ),
    OrbitRule(
        r"\bstarlink group (8|10)\b", 53.2, 0.5, UNVERIFIED, "B", Branch.NORTHBOUND, (28.5, -80.6)
    ),
    OrbitRule(
        r"\bstarlink group (9|11)\b", 53.0, 0.5, UNVERIFIED, "B", Branch.SOUTHBOUND, (34.6, -120.6)
    ),
    OrbitRule(
        r"\bstarlink group 15\b", 70.0, 0.5, UNVERIFIED, "B", Branch.SOUTHBOUND, (34.6, -120.6)
    ),
    OrbitRule(
        r"\bstarlink group 17\b", 97.6, 0.5, UNVERIFIED, "B", Branch.SOUTHBOUND, (34.6, -120.6)
    ),
    OrbitRule(r"\boneweb\b", 87.9, 0.5, UNVERIFIED, "B"),
    OrbitRule(r"\biridium\b", 86.4, 0.5, UNVERIFIED, "B"),
    OrbitRule(r"\bglobalstar\b", 52.0, 0.5, UNVERIFIED, "B"),
    OrbitRule(r"\bgps\b", 55.0, 1.0, UNVERIFIED, "B"),
    OrbitRule(r"\bgalileo\b", 56.0, 1.0, UNVERIFIED, "B"),
    OrbitRule(r"\bglonass\b", 64.8, 1.0, UNVERIFIED, "B"),
)
ORBIT_CLASS_RULES = (
    OrbitRule(r"sso", 97.6, 1.5, UNVERIFIED, "C"),
    OrbitRule(r"po", 90.0, 8.0, UNVERIFIED, "C"),
    OrbitRule(r"gto|direct-geo", None, 3.0, UNVERIFIED, "C", Branch.EAST),
    OrbitRule(r"lo|mars", None, 5.0, UNVERIFIED, "C", Branch.EAST),
)


def _label(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        return _label(value.get("name"))
    return ""


def _destinations(raw: Mapping[str, object]) -> list[str]:
    rocket = raw.get("rocket")
    if not isinstance(rocket, Mapping):
        return []
    stage = rocket.get("spacecraft_stage")
    stages = stage if isinstance(stage, list) else [stage]
    return [_label(row.get("destination")) for row in stages if isinstance(row, Mapping)]


def inclination_from_ll2(
    raw: Mapping[str, object],
    pad_lat: float,
    pad_lon: float,
) -> Inclination | None:
    """Resolve program, constellation, then orbit class. Unknown stays None."""
    programs = raw.get("program")
    names = [_label(row) for row in programs] if isinstance(programs, list) else []
    mission = raw.get("mission")
    mission = mission if isinstance(mission, Mapping) else {}
    orbit = mission.get("orbit")
    orbit = orbit if isinstance(orbit, Mapping) else {}
    program_text = " ".join([*names, *_destinations(raw)])
    constellation_text = " ".join([*names, _label(mission.get("name")), _label(raw.get("name"))])
    candidates = (
        (PROGRAM_RULES, program_text, Basis.PROGRAM),
        (CONSTELLATION_RULES, constellation_text, Basis.CONSTELLATION),
        (ORBIT_CLASS_RULES, str(orbit.get("abbrev", "")), Basis.ORBIT_CLASS),
    )
    for rules, text, basis in candidates:
        for rule in rules:
            matches = re.fullmatch if basis is Basis.ORBIT_CLASS else re.search
            if matches(rule.pattern, text, re.IGNORECASE):
                deg = abs(pad_lat) if rule.deg is None else rule.deg
                hint = rule.branch_hint
                if (
                    rule.hint_site is not None
                    and great_circle_km(
                        pad_lat,
                        pad_lon,
                        *rule.hint_site,
                    )
                    > 60
                ):
                    hint = None
                return Inclination(
                    deg,
                    rule.sigma_deg,
                    basis,
                    rule.source,
                    rule.grade,
                    hint,
                )
    return None
