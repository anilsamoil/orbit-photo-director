from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from generator.ascent_profiles import FALCON_9
from generator.launch_data import Launch
from generator.launch_direction import ModeledDirection, model_direction
from generator.launch_evidence import EvaluationBudget
from generator.launch_orbit import Basis, Branch, Inclination
from generator.launch_scan import scan_liftoffs, scan_modeled_liftoffs, too_far_to_sample
from generator.orbit import TLE, Position


def _launch() -> Launch:
    when = datetime(2026, 11, 15, 20, tzinfo=UTC)
    return Launch(
        id="fixture",
        name="fixture",
        t0=when,
        net_window_seconds=0,
        site_lat=28.5834,
        site_lon=-80.583,
        site_name="fixture",
        rocket_type="Falcon 9",
        status_abbrev="Go",
        window_start=when - timedelta(minutes=1),
        window_end=when + timedelta(seconds=125),
        time_precision="Second",
    )


def test_minute_scan_starts_at_net_and_always_includes_window_end() -> None:
    launch = _launch()
    assert [(when - launch.t0).total_seconds() for when in scan_liftoffs(launch)] == [
        0,
        60,
        120,
        125,
    ]
    assert scan_liftoffs(replace(launch, window_end=launch.t0)) == (launch.t0,)
    assert scan_liftoffs(replace(launch, window_end=launch.t0 - timedelta(seconds=1))) == ()
    assert scan_liftoffs(replace(launch, window_end=launch.t0 + timedelta(days=1))) == ()


def test_prescreen_keeps_possible_between_sample_approaches() -> None:
    from generator.launch_opportunities import Pad

    launch = _launch()
    pad = Pad(launch.site_lat, launch.site_lon)
    offsets: list[float] = []

    def far_but_not_excludable(when: datetime) -> Position:
        offsets.append((when - launch.t0).total_seconds())
        return Position(0, -38, 420, when)

    assert not too_far_to_sample(launch.t0, far_but_not_excludable, pad, FALCON_9)
    assert offsets == [-300, 0, 270, 540]
    assert too_far_to_sample(launch.t0, lambda t: Position(0, 100, 420, t), pad, FALCON_9)


@pytest.mark.parametrize("limit", ["points", "deadline"])
def test_budget_stops_inside_a_liftoff_and_marks_scan_incomplete(monkeypatch, limit) -> None:
    launch = _launch()
    tle = TLE("1", "2", launch.t0)
    direction = model_direction(
        launch.site_lat,
        launch.site_lon,
        Inclination(51.9, 0.5, Basis.CONSTELLATION, "fixture", "B", Branch.NORTHBOUND),
    )
    assert isinstance(direction, ModeledDirection)
    monkeypatch.setattr(
        "generator.launch_scan.propagate", lambda _tle, t: Position(28.5, -80.6, 420, t)
    )
    tick = iter([0.0, *([0.0] * 10), *([20.0] * 1000)])
    budget = EvaluationBudget(
        max_points=10 if limit == "points" else 1000,
        seconds=15,
        clock=(lambda: 0.0) if limit == "points" else lambda: next(tick),
    )
    result = scan_modeled_liftoffs(launch, tle, FALCON_9, direction, budget)
    assert result.incomplete
    assert result.checked == 0
    assert result.total == 4
    assert budget.points == 10
