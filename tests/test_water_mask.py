"""Tests for the GSHHG land/water mask loader (general sun-glint gate).

The golden coordinate set is the constraint-3/4 correctness gate: lakes (Great
Lakes, Caspian, Victoria, Baikal, Titicaca) MUST read as water, land (Sahara,
central Asia, Tokyo) MUST read as land. A flipped/transposed mask re-build fails
these, not silently in production. Mirrors the build script's own assertions.
"""

from __future__ import annotations

from pathlib import Path

from generator.water_mask import load_water_mask

# (name, lat, lon, expected_is_water)
GOLDEN = [
    ("Lake Superior", 47.5, -87.5, True),
    ("Lake Michigan", 43.5, -87.0, True),
    ("Caspian Sea", 41.5, 50.0, True),
    ("Lake Victoria", -1.0, 33.0, True),
    ("Lake Baikal", 53.5, 108.0, True),
    ("Lake Titicaca", -15.8, -69.3, True),
    ("Sahara", 20.0, 10.0, False),
    ("Central Asia", 45.0, 80.0, False),
    ("Tokyo", 35.68, 139.69, False),
    ("mid-Pacific", 0.0, -150.0, True),
    ("mid-Atlantic", 30.0, -40.0, True),
]


def test_load_water_mask_returns_callable() -> None:
    mask = load_water_mask()
    assert mask is not None, "committed water_mask.npz must load"
    assert callable(mask)


def test_water_mask_golden_coordinates() -> None:
    """Inland lakes are water; deserts/cities are land — the correctness gate."""
    mask = load_water_mask()
    assert mask is not None
    for name, lat, lon, expected in GOLDEN:
        assert mask(lat, lon) is expected, f"{name} ({lat},{lon}) should be water={expected}"


def test_water_mask_absent_returns_none() -> None:
    """A missing artifact returns None → callers fall back to the V1 heuristic."""
    assert load_water_mask(Path("/nonexistent/water_mask.npz")) is None


def test_water_mask_clamps_out_of_range() -> None:
    """Degenerate / out-of-range lat/lon clamp to the grid edge, never crash."""
    mask = load_water_mask()
    assert mask is not None
    for lat, lon in [(90.0, 180.0), (-90.0, -180.0), (95.0, 200.0), (-95.0, -200.0)]:
        assert isinstance(mask(lat, lon), bool)
