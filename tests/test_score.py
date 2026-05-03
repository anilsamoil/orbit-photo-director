"""Tests for generator.score."""

from __future__ import annotations

import pytest

from generator.score import (
    compute_score,
    nadir_proximity,
    priority_weight,
    regime_fit,
    top_n,
)

# --------------------------------------------------------------------------
# regime_fit
# --------------------------------------------------------------------------


def test_regime_fit_exact_match_day() -> None:
    assert regime_fit("day", "day") == 100.0


def test_regime_fit_exact_match_night() -> None:
    assert regime_fit("night", "night") == 100.0


def test_regime_fit_exact_match_terminator() -> None:
    assert regime_fit("terminator", "terminator") == 100.0


def test_regime_fit_mismatch_day_night() -> None:
    assert regime_fit("night", "day") == 30.0


def test_regime_fit_any_on_day() -> None:
    assert regime_fit("any", "day") == 100.0


def test_regime_fit_any_on_night() -> None:
    assert regime_fit("any", "night") == 100.0


def test_regime_fit_any_on_terminator() -> None:
    assert regime_fit("any", "terminator") == 70.0


# --------------------------------------------------------------------------
# nadir_proximity
# --------------------------------------------------------------------------


def test_nadir_proximity_at_target() -> None:
    assert nadir_proximity(0.0) == 100.0


def test_nadir_proximity_at_horizon() -> None:
    assert nadir_proximity(500.0) == 0.0


def test_nadir_proximity_halfway() -> None:
    assert nadir_proximity(250.0) == 50.0


def test_nadir_proximity_beyond_horizon() -> None:
    assert nadir_proximity(800.0) == 0.0


def test_nadir_proximity_negative_distance_clamps() -> None:
    assert nadir_proximity(-10.0) == 100.0


def test_nadir_proximity_custom_horizon() -> None:
    assert nadir_proximity(100.0, horizon_km=200.0) == 50.0


# --------------------------------------------------------------------------
# priority_weight
# --------------------------------------------------------------------------


def test_priority_weight_min() -> None:
    assert priority_weight(1) == 20.0


def test_priority_weight_max() -> None:
    assert priority_weight(5) == 100.0


def test_priority_weight_mid() -> None:
    assert priority_weight(3) == 60.0


@pytest.mark.parametrize("p", [0, 6, -1, 100])
def test_priority_weight_rejects_out_of_range(p: int) -> None:
    with pytest.raises(ValueError):
        priority_weight(p)


# --------------------------------------------------------------------------
# compute_score
# --------------------------------------------------------------------------


def test_compute_score_perfect() -> None:
    sc = compute_score(
        p_unobstructed=100.0,
        target_regime="night",
        pass_regime="night",
        distance_km=0.0,
        priority=5,
    )
    assert sc.final == 100.0


def test_compute_score_zero_p_unobstructed_zeros_final() -> None:
    sc = compute_score(
        p_unobstructed=0.0,
        target_regime="night",
        pass_regime="night",
        distance_km=0.0,
        priority=5,
    )
    assert sc.final == 0.0


def test_compute_score_clamps_p_unobstructed() -> None:
    sc = compute_score(
        p_unobstructed=150.0,  # over-range; should clamp to 100
        target_regime="day",
        pass_regime="day",
        distance_km=0.0,
        priority=5,
    )
    assert sc.final == 100.0


def test_compute_score_components_recorded() -> None:
    sc = compute_score(
        p_unobstructed=80.0,
        target_regime="day",
        pass_regime="day",
        distance_km=250.0,
        priority=4,
    )
    assert sc.p_unobstructed == 80.0
    assert sc.regime_fit == 100.0
    assert sc.nadir_proximity == 50.0
    assert sc.priority_weight == 80.0
    # 80 * 100 * 50 * 80 / 1_000_000 = 32
    assert sc.final == pytest.approx(32.0)


def test_compute_score_regime_mismatch_penalizes() -> None:
    perfect = compute_score(80.0, "night", "night", 0.0, 5).final
    mismatched = compute_score(80.0, "night", "day", 0.0, 5).final
    assert mismatched < perfect * 0.5  # 30% regime fit destroys the score


# --------------------------------------------------------------------------
# top_n
# --------------------------------------------------------------------------


def test_top_n_sorts_descending() -> None:
    passes = [{"score": 1.0}, {"score": 5.0}, {"score": 3.0}]
    result = top_n(passes, 2)
    assert [p["score"] for p in result] == [5.0, 3.0]


def test_top_n_returns_all_when_n_exceeds() -> None:
    passes = [{"score": 1.0}, {"score": 2.0}]
    assert len(top_n(passes, 10)) == 2


def test_top_n_zero_returns_empty() -> None:
    passes = [{"score": 1.0}]
    assert top_n(passes, 0) == []


def test_top_n_negative_returns_empty() -> None:
    passes = [{"score": 1.0}]
    assert top_n(passes, -1) == []


def test_top_n_handles_missing_score() -> None:
    passes = [{"score": 1.0}, {}, {"score": 5.0}]
    result = top_n(passes, 3)
    assert result[0]["score"] == 5.0
    assert result[1]["score"] == 1.0
