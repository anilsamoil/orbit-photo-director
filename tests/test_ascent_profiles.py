"""Tests for generator.ascent_profiles."""

from __future__ import annotations

import pytest

from generator.ascent_profiles import (
    ALL_PROFILES,
    ARIANE_6,
    ATLAS_V,
    FALCON_9,
    FALCON_HEAVY,
    LONG_MARCH_5,
    LONG_MARCH_7,
    NEW_GLENN,
    SLS,
    SOYUZ_2,
    STARSHIP,
    VULCAN_CENTAUR,
    AscentProfile,
    match_rocket,
)

# --------------------------------------------------------------------------
# Profile structural integrity
# --------------------------------------------------------------------------


@pytest.mark.parametrize("profile", ALL_PROFILES)
def test_profile_has_at_least_4_samples(profile: AscentProfile) -> None:
    assert len(profile.samples) >= 4, f"{profile.name} needs >= 4 samples for interpolation"


@pytest.mark.parametrize("profile", ALL_PROFILES)
def test_profile_starts_at_t_zero_zero_altitude(profile: AscentProfile) -> None:
    first = profile.samples[0]
    assert first.t_seconds == 0
    assert first.altitude_km == 0.0
    assert first.downrange_km == 0.0
    assert first.pitch_deg == 90.0  # vertical at liftoff


@pytest.mark.parametrize("profile", ALL_PROFILES)
def test_profile_samples_monotonic_time(profile: AscentProfile) -> None:
    times = [s.t_seconds for s in profile.samples]
    assert times == sorted(times), f"{profile.name} samples not in time order"
    assert len(set(times)) == len(times), f"{profile.name} has duplicate t_seconds"


@pytest.mark.parametrize("profile", ALL_PROFILES)
def test_profile_samples_monotonic_altitude(profile: AscentProfile) -> None:
    """Altitude must rise (or stay equal) — the rocket is climbing.

    Some rockets dip slightly post-MECO before second-stage burn, but at the
    coarse 6-sample resolution we encode monotonic-non-decreasing as a sanity
    floor.
    """
    altitudes = [s.altitude_km for s in profile.samples]
    for prev, curr in zip(altitudes, altitudes[1:], strict=False):
        assert curr >= prev, f"{profile.name} altitude not monotonic non-decreasing"


@pytest.mark.parametrize("profile", ALL_PROFILES)
def test_profile_samples_monotonic_downrange(profile: AscentProfile) -> None:
    downranges = [s.downrange_km for s in profile.samples]
    for prev, curr in zip(downranges, downranges[1:], strict=False):
        assert curr >= prev, f"{profile.name} downrange not monotonic non-decreasing"


@pytest.mark.parametrize("profile", ALL_PROFILES)
def test_profile_pitch_drops_from_vertical(profile: AscentProfile) -> None:
    """Gravity turn: pitch starts at 90° (vertical) and falls toward horizontal."""
    pitches = [s.pitch_deg for s in profile.samples]
    assert pitches[0] == 90.0
    assert pitches[-1] < 30.0, f"{profile.name} ends pitched > 30°; not in orbit-insertion regime"


@pytest.mark.parametrize("profile", ALL_PROFILES)
def test_profile_confidence_in_unit_interval(profile: AscentProfile) -> None:
    for s in profile.samples:
        assert 0.0 <= s.confidence <= 1.0, f"{profile.name} confidence out of [0,1]"


@pytest.mark.parametrize("profile", ALL_PROFILES)
def test_profile_confidence_non_increasing(profile: AscentProfile) -> None:
    """Earlier samples are more repeatable than later ones."""
    confidences = [s.confidence for s in profile.samples]
    for prev, curr in zip(confidences, confidences[1:], strict=False):
        assert curr <= prev, f"{profile.name} confidence rose later in flight"


@pytest.mark.parametrize("profile", ALL_PROFILES)
def test_profile_insertion_matches_last_sample(profile: AscentProfile) -> None:
    assert profile.insertion_t_seconds == profile.samples[-1].t_seconds


@pytest.mark.parametrize("profile", ALL_PROFILES)
def test_profile_has_match_keywords(profile: AscentProfile) -> None:
    assert len(profile.match_keywords) >= 1
    assert all(isinstance(k, str) and k.strip() for k in profile.match_keywords)


# --------------------------------------------------------------------------
# match_rocket — LL2 configuration dict to profile resolution
# --------------------------------------------------------------------------


def _config(full_name: str = "", name: str = "", family: str = "") -> dict:
    return {"full_name": full_name, "name": name, "family": family}


def test_match_rocket_falcon_9_block_5() -> None:
    """LL2 fixture form for SpaceX ISS-cargo missions."""
    cfg = _config(full_name="Falcon 9 Block 5", name="Falcon 9", family="Falcon")
    assert match_rocket(cfg) is FALCON_9


def test_match_rocket_falcon_9_block_5_full_name_only() -> None:
    """Resilient if other fields are missing."""
    cfg = _config(full_name="Falcon 9 Block 5")
    assert match_rocket(cfg) is FALCON_9


def test_match_rocket_falcon_heavy_wins_over_falcon_9() -> None:
    """ALL_PROFILES order: FALCON_HEAVY must be tried before FALCON_9."""
    cfg = _config(full_name="Falcon Heavy", name="Falcon Heavy", family="Falcon")
    assert match_rocket(cfg) is FALCON_HEAVY


def test_match_rocket_atlas_v() -> None:
    cfg = _config(full_name="Atlas V 401", name="Atlas V", family="Atlas")
    assert match_rocket(cfg) is ATLAS_V


def test_match_rocket_vulcan_centaur() -> None:
    """LL2 fixture form for ULA Vulcan."""
    cfg = _config(full_name="Vulcan Centaur", name="Vulcan", family="Vulcan")
    assert match_rocket(cfg) is VULCAN_CENTAUR


def test_match_rocket_soyuz_2_1a() -> None:
    """LL2 fixture form for Roscosmos Soyuz."""
    cfg = _config(full_name="Soyuz 2.1a", name="Soyuz 2.1a", family="Soyuz")
    assert match_rocket(cfg) is SOYUZ_2


def test_match_rocket_soyuz_2_1b() -> None:
    cfg = _config(full_name="Soyuz 2.1b", name="Soyuz 2.1b", family="Soyuz")
    assert match_rocket(cfg) is SOYUZ_2


def test_match_rocket_long_march_5() -> None:
    cfg = _config(full_name="Long March 5", name="Long March 5", family="Long March")
    assert match_rocket(cfg) is LONG_MARCH_5


def test_match_rocket_long_march_7() -> None:
    cfg = _config(full_name="Long March 7", name="Long March 7", family="Long March")
    assert match_rocket(cfg) is LONG_MARCH_7


def test_match_rocket_cz_5_abbreviation() -> None:
    """LL2 occasionally uses Chinese rocket abbreviations."""
    cfg = _config(full_name="CZ-5", name="CZ-5", family="Long March")
    assert match_rocket(cfg) is LONG_MARCH_5


def test_match_rocket_sls() -> None:
    cfg = _config(full_name="SLS Block 1", name="SLS", family="Space Launch System")
    assert match_rocket(cfg) is SLS


def test_match_rocket_new_glenn() -> None:
    cfg = _config(full_name="New Glenn", name="New Glenn", family="New Glenn")
    assert match_rocket(cfg) is NEW_GLENN


def test_match_rocket_ariane_6() -> None:
    cfg = _config(full_name="Ariane 62", name="Ariane 6", family="Ariane")
    assert match_rocket(cfg) is ARIANE_6


def test_match_rocket_starship() -> None:
    cfg = _config(full_name="Starship", name="Starship", family="Starship")
    assert match_rocket(cfg) is STARSHIP


def test_match_rocket_unknown_returns_none() -> None:
    cfg = _config(full_name="Electron", name="Electron", family="Electron")
    assert match_rocket(cfg) is None


def test_match_rocket_empty_dict_returns_none() -> None:
    assert match_rocket({}) is None


def test_match_rocket_none_returns_none() -> None:
    assert match_rocket(None) is None


def test_match_rocket_case_insensitive() -> None:
    cfg = _config(full_name="falcon 9 block 5", name="falcon 9", family="falcon")
    assert match_rocket(cfg) is FALCON_9


# --------------------------------------------------------------------------
# Realism sanity checks — coarse altitude bounds, not precision telemetry
# --------------------------------------------------------------------------


def test_falcon_9_max_q_altitude_in_known_range() -> None:
    """SpaceX webcast shows max-Q at T+70-80s, altitude ~12-15 km."""
    sample_70s = next(s for s in FALCON_9.samples if s.t_seconds == 70)
    assert 8.0 <= sample_70s.altitude_km <= 18.0


def test_falcon_9_meco_altitude_in_known_range() -> None:
    """MECO ~ T+150s, ~80 km altitude."""
    sample_150s = next(s for s in FALCON_9.samples if s.t_seconds == 150)
    assert 60.0 <= sample_150s.altitude_km <= 100.0


def test_falcon_9_insertion_altitude_in_leo_range() -> None:
    final = FALCON_9.samples[-1]
    assert 180.0 <= final.altitude_km <= 250.0


def test_no_profile_exceeds_geo_altitude() -> None:
    """All profiles end at LEO insertion (< 600 km altitude)."""
    for profile in ALL_PROFILES:
        final = profile.samples[-1]
        assert final.altitude_km < 600.0, f"{profile.name} ends above 600 km — wrong regime"


def test_all_profiles_have_distinct_names() -> None:
    names = [p.name for p in ALL_PROFILES]
    assert len(set(names)) == len(names), "Profile names must be unique"


def test_all_match_keywords_have_at_least_one_match() -> None:
    """Self-consistency: every keyword in a profile must resolve back to that profile.

    Catches typos and ordering bugs where a more-permissive earlier profile
    swallows a later profile's keyword.
    """
    for profile in ALL_PROFILES:
        for keyword in profile.match_keywords:
            cfg = _config(full_name=keyword)
            resolved = match_rocket(cfg)
            assert resolved is profile, (
                f"{profile.name} keyword '{keyword}' resolved to "
                f"{resolved.name if resolved else None}; check ALL_PROFILES ordering"
            )
