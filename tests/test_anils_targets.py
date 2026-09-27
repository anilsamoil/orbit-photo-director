"""Anil's curated targets stay in the catalog the generator scores."""

from __future__ import annotations

from pathlib import Path

from generator.config import load_targets

ROOT = Path(__file__).resolve().parents[1]
CATEGORY = "anils-targets"

# Decimal degrees. Aspen points are the photographed groves, not the bare
# summits. Peak points are the summits. Everest is the Nepal base camp.
EXPECTED = {
    "maroon-bells-aspens": (39.09699, -106.94519, True),
    "kebler-pass-aspens": (38.84972, -107.10028, True),
    "dallas-divide-aspens": (38.09444, -107.88833, True),
    "k2": (35.88250, 76.51333, False),
    "broad-peak": (35.81361, 76.56528, False),
    "gasherbrum-i": (35.72444, 76.69639, False),
    "gasherbrum-ii": (35.75833, 76.65333, False),
    "everest-south-base-camp": (28.00722, 86.85944, False),
}


def test_anils_targets_are_daylight_points_the_generator_accepts() -> None:
    targets = {row["id"]: row for row in load_targets(ROOT / "targets.json")}
    for target_id, (lat, lon, seasonal) in EXPECTED.items():
        row = targets[target_id]
        assert row["category"] == CATEGORY
        assert row["regime"] == "day"
        assert row["geom"]["type"] == "point"
        assert row["geom"]["lat"] == lat
        assert row["geom"]["lon"] == lon
        notes = row.get("notes", "")
        if seasonal:
            assert "late September" in notes
            assert "early October" in notes
        if target_id == "everest-south-base-camp":
            assert "28.14139" in notes
            assert "86.85139" in notes
            assert "Tibet" in notes
