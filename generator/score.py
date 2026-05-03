"""Pass scoring engine. Combines P(unobstructed), regime fit, nadir proximity, target priority.

All values are 0-100. Final score = product / 1_000_000 → 0-100.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .config import NADIR_HORIZON_KM


@dataclass(frozen=True)
class ScoreComponents:
    p_unobstructed: float  # 0-100
    regime_fit: float  # 0-100
    nadir_proximity: float  # 0-100
    priority_weight: float  # 0-100
    final: float  # 0-100


def regime_fit(target_regime: str, pass_regime: str) -> float:
    """Lighting regime fit:
    - 100 if pass regime matches target preference
    - 70 if target is `any` and pass is `terminator` (still a great shot)
    - 100 if target is `any` and pass is day or night (max compatibility)
    - 30 if mismatch (e.g., night-target on a day pass)
    """
    if target_regime == "any":
        return 70.0 if pass_regime == "terminator" else 100.0
    if target_regime == pass_regime:
        return 100.0
    return 30.0


def nadir_proximity(distance_km: float, horizon_km: float = NADIR_HORIZON_KM) -> float:
    """Linear falloff: 0 km → 100, horizon_km → 0, clamped to [0, 100]."""
    if distance_km <= 0:
        return 100.0
    if distance_km >= horizon_km:
        return 0.0
    return 100.0 * (1.0 - distance_km / horizon_km)


def priority_weight(priority: int) -> float:
    """Map 1-5 priority to 20-100 weight."""
    if priority < 1 or priority > 5:
        raise ValueError(f"priority must be 1-5, got {priority}")
    return float(priority) / 5.0 * 100.0


def compute_score(
    p_unobstructed: float,
    target_regime: str,
    pass_regime: str,
    distance_km: float,
    priority: int,
    horizon_km: float = NADIR_HORIZON_KM,
) -> ScoreComponents:
    p = max(0.0, min(100.0, p_unobstructed))
    rf = regime_fit(target_regime, pass_regime)
    np_ = nadir_proximity(distance_km, horizon_km)
    pw = priority_weight(priority)
    final = (p * rf * np_ * pw) / 1_000_000.0
    return ScoreComponents(
        p_unobstructed=p,
        regime_fit=rf,
        nadir_proximity=np_,
        priority_weight=pw,
        final=final,
    )


def top_n(passes: list[dict[str, Any]], n: int) -> list[dict[str, Any]]:
    """Return top N passes by `score` field, sorted descending."""
    if n <= 0:
        return []
    return sorted(passes, key=lambda p: p.get("score", 0.0), reverse=True)[:n]
