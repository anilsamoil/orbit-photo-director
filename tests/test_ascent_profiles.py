"""Tests for generator.ascent_profiles."""

from __future__ import annotations

import pytest

from generator.ascent_profiles import (
    ALL_PROFILES,
    ARIANE_6,
    ATLAS_V,
    FALCON_9,
    FALCON_HEAVY,
    FIREFLY_ALPHA,
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
    # (This test used Electron until coverage wave 2 gave it a profile —
    # Pegasus XL is air-launched and effectively retired; no profile.)
    cfg = _config(full_name="Pegasus XL", name="Pegasus XL", family="Pegasus")
    assert match_rocket(cfg) is None


# --------------------------------------------------------------------------
# Coverage wave 2 (2026-06-10): every rocket in the live LL2 cache audit
# that previously skipped ASCENT now matches, and family disambiguation
# holds inside the crowded Long March namespace.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("full_name", "name", "family", "expected"),
    [
        ("Electron", "Electron", "Electron", "Electron"),
        ("H3-30", "H3-30", "H3", "H3"),
        ("Kinetica 1", "Kinetica 1", "", "Kinetica 1"),
        ("Long March 3B/E", "Long March 3B/E", "Long March", "Long March 3"),
        ("Spectrum", "Spectrum", "", "Spectrum"),
    ],
)
def test_wave2_cache_audit_rockets_all_match(
    full_name: str, name: str, family: str, expected: str
) -> None:
    prof = match_rocket(_config(full_name=full_name, name=name, family=family))
    assert prof is not None, f"{full_name} should match a profile"
    assert prof.name == expected, f"{full_name} matched {prof.name}"


@pytest.mark.parametrize(
    ("full_name", "expected"),
    [
        ("Long March 2F", "Long March 2"),
        ("Long March 2D", "Long March 2"),
        ("Long March 4C", "Long March 4"),
        ("Long March 5B", "Long March 5"),  # wave-1 profile unaffected
        ("Long March 6A", "Long March 6"),
        ("Long March 7A", "Long March 7"),  # wave-1 profile unaffected
        ("Long March 8A", "Long March 8"),
    ],
)
def test_wave2_long_march_disambiguation(full_name: str, expected: str) -> None:
    prof = match_rocket(_config(full_name=full_name, name=full_name, family="Long March"))
    assert prof is not None and prof.name == expected, (
        f"{full_name} → {prof.name if prof else None}, wanted {expected}"
    )


@pytest.mark.parametrize(
    ("full_name", "expected"),
    [
        # LL2 sometimes uses CASC's "Chang Zheng" naming; wave-1 LM 5/7
        # already carried the alias (see test_match_rocket_cz_5_abbreviation
        # for the CZ- form), wave-2 families must too.
        ("Chang Zheng 2F", "Long March 2"),
        ("Chang Zheng 3B", "Long March 3"),
        ("Chang Zheng 4C", "Long March 4"),
        ("Chang Zheng 6A", "Long March 6"),
        ("Chang Zheng 8A", "Long March 8"),
    ],
)
def test_wave2_chang_zheng_aliases(full_name: str, expected: str) -> None:
    prof = match_rocket(_config(full_name=full_name))
    assert prof is not None and prof.name == expected, (
        f"{full_name} → {prof.name if prof else None}, wanted {expected}"
    )


@pytest.mark.parametrize(
    ("full_name", "family", "expected"),
    [
        ("Kuaizhou-1A", "Kuaizhou", "Kuaizhou"),
        ("Ceres-1S", "Ceres-1", "Ceres-1"),
        ("PSLV-XL", "PSLV", "PSLV"),
        ("Vega-C", "Vega", "Vega-C"),
        ("Firefly Alpha", "Alpha", "Firefly Alpha"),
    ],
)
def test_wave2_high_cadence_families_match(
    full_name: str, family: str, expected: str
) -> None:
    prof = match_rocket(_config(full_name=full_name, name=full_name, family=family))
    assert prof is not None and prof.name == expected


def test_wave2_generic_alpha_does_not_shadow_specific_profiles() -> None:
    # FIREFLY_ALPHA's generic exact-keyword "Alpha" must sit LAST in
    # ALL_PROFILES: a rocket matched by any more specific profile must never
    # fall through to it.
    cfg = _config(full_name="New Glenn Alpha Test", name="New Glenn", family="New Glenn")
    prof = match_rocket(cfg)
    assert prof is not None and prof.name == "New Glenn"


def test_firefly_alpha_is_last_profile() -> None:
    """Structural guard: FIREFLY_ALPHA carries the most generic keyword
    ("Alpha", exact-field) and must stay at the end of ALL_PROFILES so it
    can never shadow a later, more specific profile added above it."""
    assert ALL_PROFILES[-1] is FIREFLY_ALPHA


# --------------------------------------------------------------------------
# Exact-field keyword semantics (ship review 2026-06-11): generic tokens
# match by whole-field equality, never by substring — verified-live misfires
# below must stay dead.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("cfg", "expected"),
    [
        # Bare single-field forms LL2 actually emits for sparse configs.
        (_config(family="H3"), "H3"),
        (_config(name="h3"), "H3"),  # exact match is case-insensitive
        (_config(family="Alpha"), "Firefly Alpha"),  # LL2 Firefly family
    ],
)
def test_exact_keywords_match_bare_fields(cfg: dict, expected: str) -> None:
    prof = match_rocket(cfg)
    assert prof is not None and prof.name == expected


@pytest.mark.parametrize(
    "cfg",
    [
        # Substring misfires the old matcher produced (verified live in the
        # 2026-06-11 ship review) — all must skip ASCENT, not fake-match.
        _config(full_name="Alphabet"),
        _config(full_name="Alpha Centauri-1", family="Alphabet"),
        _config(full_name="Mach3 Express"),  # old "H3 " join hack hit "mach3 "
        _config(full_name="ZH3", name="ZH3"),
        _config(full_name="SH3 Demo"),
    ],
)
def test_exact_keywords_reject_substring_lookalikes(cfg: dict) -> None:
    assert match_rocket(cfg) is None


@pytest.mark.parametrize(
    "cfg",
    [
        # Larger sibling vehicles with genuinely different ascents (Codex
        # adversarial 2026-06-11): must fail-safe skip, never inherit the
        # smaller rocket's geometry.
        _config(full_name="Kinetica 2", name="Kinetica 2", family="Kinetica"),
        _config(full_name="Lijian-2", name="Lijian-2"),
        _config(full_name="Kinetica 2 Heavy"),
        _config(full_name="Ceres-2", name="Ceres-2", family="Ceres"),
        # Numbered-substring limitation, documented: today's matcher would
        # confuse a hypothetical "Long March 20" with "Long March 2", so we
        # pin that the REAL current non-covered LM vehicles stay unmatched.
        # If one of these starts matching, a keyword grew too greedy.
        _config(full_name="Long March 10", name="Long March 10", family="Long March"),
        _config(full_name="Long March 12", name="Long March 12", family="Long March"),
        _config(full_name="CZ-12", name="CZ-12", family="Long March"),
    ],
)
def test_sibling_vehicles_fail_safe_skip(cfg: dict) -> None:
    assert match_rocket(cfg) is None


def test_kuaizhou_family_mapping_is_intentional() -> None:
    """KZ-1A and KZ-11 both map to the one Kuaizhou profile on purpose —
    both are quick-burn solid LVs with similar climb character."""
    for full_name in ("Kuaizhou-1A", "Kuaizhou-11", "KZ-11"):
        prof = match_rocket(_config(full_name=full_name, family="Kuaizhou"))
        assert prof is not None and prof.name == "Kuaizhou"


def test_exact_keywords_resolve_back_to_their_profile() -> None:
    """Self-consistency mirror of the match_keywords battery below: every
    exact keyword, used as a whole field, must resolve to its own profile."""
    for profile in ALL_PROFILES:
        for keyword in profile.exact_keywords:
            resolved = match_rocket(_config(family=keyword))
            assert resolved is profile, (
                f"{profile.name} exact keyword '{keyword}' resolved to "
                f"{resolved.name if resolved else None}"
            )


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
