"""Per-rocket ascent profile tables for V3-P2 ASCENT geometry.

Each profile describes a rocket's nominal climb from liftoff to orbit insertion:
how altitude, downrange distance, and pitch evolve over time. `generator.ascent`
walks these tables at 15-second cadence to find instants when an ascending
rocket is photographable from ISS (sun-illuminated plume + dark Earth backdrop +
clear line-of-sight).

Data sources are publicly available rocket telemetry — SpaceX webcast overlays,
ULA published profiles, NASA Artemis-I downlinked telemetry, ESA Ariane 6
mission briefs. Numbers are approximate — the per-rocket profile is a "typical
mission to a low-inclination LEO" generic shape, NOT a per-mission trajectory.
Real ascent diverges based on payload mass, target orbit, throttle profile, and
weather hold. Profile `confidence` field captures that uncertainty per sample
(declines over the flight; earliest samples are most repeatable).

The `match_rocket()` function maps an LL2 `rocket.configuration` dict to a
profile, preferring `full_name` over `name` over `family` for specificity (a
Falcon 9 and Falcon Heavy share the "Falcon" family but have different climbs).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AscentSample:
    """One instant in a rocket's nominal climb profile.

    Field order is fixed so per-profile tables below can use positional
    construction without sacrificing readability (one row per instant).
    """

    t_seconds: int  # T+t since liftoff
    altitude_km: float
    downrange_km: float  # great-circle distance from pad
    pitch_deg: float  # 90 = vertical, 0 = horizontal
    confidence: float  # 0.0-1.0; declines as flight uncertainty grows


def _s(t: int, alt: float, down: float, pitch: float, conf: float) -> AscentSample:
    """Brief constructor for per-profile sample tables. Positional only.

    Saves the ~30 chars per line that named args cost (t_seconds=, altitude_km=,
    etc.) so each sample fits on one line and the table reads as data, not code.
    """
    return AscentSample(t, alt, down, pitch, conf)


@dataclass(frozen=True)
class AscentProfile:
    """A rocket family's nominal liftoff-to-insertion climb."""

    name: str
    # LL2 rocket.configuration string fragments matched (case-insensitive,
    # substring). First profile to match wins; order matters in ALL_PROFILES.
    # Match against full_name first, then name, then family.
    match_keywords: tuple[str, ...]
    samples: tuple[AscentSample, ...]
    insertion_t_seconds: int  # nominal orbit-insertion time


# Falcon 9 Block 5 (SpaceX). Source: SpaceX webcast telemetry overlay.
# Profile is for a typical LEO ISS-rendezvous mission (~i=51.6°, 400km).
# Max-Q ~ T+70s @ 12km, MECO ~ T+150s @ 80km, SECO-1 ~ T+540s.
FALCON_9 = AscentProfile(
    name="Falcon 9",
    match_keywords=("Falcon 9", "Falcon9"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 1.00),
        _s(30, 2.5, 0.3, 87.0, 0.95),
        _s(70, 12.0, 4.0, 70.0, 0.92),
        _s(120, 45.0, 30.0, 50.0, 0.88),
        _s(150, 80.0, 65.0, 35.0, 0.85),
        _s(240, 130.0, 320.0, 15.0, 0.80),
        _s(540, 200.0, 1400.0, 2.0, 0.70),
    ),
    insertion_t_seconds=540,
)

# Falcon Heavy (SpaceX). Source: SpaceX webcast telemetry. Cross-feed not used
# in flight; profile similar to F9 early but holds higher thrust through core
# burnout. BECO ~ T+150s, Core MECO ~ T+225s, SECO ~ T+540s for typical GTO.
FALCON_HEAVY = AscentProfile(
    name="Falcon Heavy",
    match_keywords=("Falcon Heavy",),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 1.00),
        _s(30, 3.0, 0.4, 86.0, 0.92),
        _s(70, 15.0, 5.0, 68.0, 0.88),
        _s(150, 85.0, 85.0, 32.0, 0.82),
        _s(225, 130.0, 280.0, 18.0, 0.78),
        _s(540, 220.0, 1700.0, 2.0, 0.65),
    ),
    insertion_t_seconds=540,
)

# Atlas V (ULA). Source: ULA published mission profiles. Variants
# (401/N22/541/...) differ in SRB count; this is the 401 baseline. ISS-bound
# Starliner uses N22 (2 SRBs, no fairing) with similar early climb.
ATLAS_V = AscentProfile(
    name="Atlas V",
    match_keywords=("Atlas V", "Atlas-V", "AtlasV"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.95),
        _s(30, 2.0, 0.2, 88.0, 0.90),
        _s(80, 12.0, 3.0, 72.0, 0.85),
        _s(180, 80.0, 100.0, 38.0, 0.80),
        _s(270, 130.0, 380.0, 15.0, 0.75),
        _s(720, 200.0, 2400.0, 3.0, 0.65),
    ),
    insertion_t_seconds=720,
)

# Vulcan Centaur (ULA). Source: ULA Vulcan-1 / Cert-2 telemetry. Two BE-4 +
# 0-6 GEM-63XL SRBs. Profile here is "VC2" (2 SRBs) typical LEO mission.
VULCAN_CENTAUR = AscentProfile(
    name="Vulcan Centaur",
    match_keywords=("Vulcan",),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.85),
        _s(30, 2.5, 0.3, 87.0, 0.80),
        _s(80, 14.0, 4.0, 70.0, 0.78),
        _s(180, 85.0, 110.0, 36.0, 0.72),
        _s(300, 140.0, 500.0, 12.0, 0.68),
        _s(700, 200.0, 2300.0, 3.0, 0.60),
    ),
    insertion_t_seconds=700,
)

# Soyuz 2.1a/2.1b/2.1v (Roscosmos). Source: Roscosmos published mission
# profiles. Four-strap-on core. Strap-on sep at T+118s, core MECO ~T+286s.
SOYUZ_2 = AscentProfile(
    name="Soyuz 2",
    match_keywords=("Soyuz 2", "Soyuz-2"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.95),
        _s(30, 2.0, 0.3, 87.0, 0.92),
        _s(70, 11.0, 3.5, 72.0, 0.88),
        _s(118, 45.0, 30.0, 52.0, 0.85),
        _s(286, 170.0, 550.0, 10.0, 0.78),
        _s(560, 210.0, 1700.0, 2.0, 0.70),
    ),
    insertion_t_seconds=560,
)

# Long March 5 (CASC). Source: CASC published profiles, supplementary telemetry
# from Chang'e/Tianwen mission reports. YF-77 core + 4 YF-100K strap-ons.
# Approximate — limited public data.
LONG_MARCH_5 = AscentProfile(
    name="Long March 5",
    match_keywords=("Long March 5", "CZ-5", "Chang Zheng 5"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.75),
        _s(30, 2.2, 0.3, 87.0, 0.72),
        _s(80, 13.0, 4.0, 70.0, 0.68),
        _s(175, 80.0, 110.0, 35.0, 0.62),
        _s(475, 180.0, 1700.0, 8.0, 0.55),
        _s(900, 200.0, 3600.0, 2.0, 0.45),
    ),
    insertion_t_seconds=900,
)

# Long March 7 (CASC). Source: CASC published profiles, Tianzhou cargo mission
# telemetry. YF-100 core + 4 strap-ons. Tianzhou docks with Tiangong (i=41.5°).
# Smaller than LM5; profile closer to Falcon 9.
LONG_MARCH_7 = AscentProfile(
    name="Long March 7",
    match_keywords=("Long March 7", "CZ-7", "Chang Zheng 7"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.75),
        _s(30, 2.4, 0.3, 87.0, 0.72),
        _s(80, 13.5, 4.5, 70.0, 0.68),
        _s(160, 80.0, 85.0, 35.0, 0.62),
        _s(560, 200.0, 1800.0, 5.0, 0.55),
    ),
    insertion_t_seconds=560,
)

# SLS Block 1 (NASA). Source: Artemis I downlinked telemetry. Two SRBs +
# 4x RS-25 core. SRB sep T+125s, core MECO ~T+480s, ICPS handoff to TLI orbit.
SLS = AscentProfile(
    name="SLS",
    match_keywords=("SLS", "Space Launch System"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.85),
        _s(30, 3.0, 0.4, 87.0, 0.82),
        _s(70, 15.0, 5.5, 68.0, 0.78),
        _s(125, 48.0, 45.0, 46.0, 0.72),
        _s(240, 115.0, 270.0, 22.0, 0.68),
        _s(480, 160.0, 1700.0, 4.0, 0.60),
    ),
    insertion_t_seconds=480,
)

# New Glenn (Blue Origin). Source: Blue Origin published Block 1 profile +
# NG-1 mission downlink. 7x BE-4 first stage. Limited flight history → low conf.
NEW_GLENN = AscentProfile(
    name="New Glenn",
    match_keywords=("New Glenn",),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.70),
        _s(30, 2.5, 0.3, 87.0, 0.65),
        _s(80, 13.0, 4.0, 70.0, 0.60),
        _s(180, 90.0, 120.0, 35.0, 0.55),
        _s(540, 200.0, 1900.0, 3.0, 0.45),
    ),
    insertion_t_seconds=540,
)

# Ariane 6 (ESA). Source: ESA Ariane 6 user manual + VA262 maiden flight
# telemetry. Vulcain 2.1 core + 2-4 P120C SRBs. Profile here is A62 (2 SRBs).
ARIANE_6 = AscentProfile(
    name="Ariane 6",
    match_keywords=("Ariane 6", "Ariane-6", "Ariane62", "Ariane 64", "Ariane62", "Ariane64"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.80),
        _s(30, 2.5, 0.3, 87.0, 0.76),
        _s(80, 14.0, 4.5, 70.0, 0.72),
        _s(130, 60.0, 40.0, 45.0, 0.68),
        _s(470, 200.0, 1700.0, 4.0, 0.58),
    ),
    insertion_t_seconds=470,
)

# Starship (SpaceX). Source: SpaceX IFT-3 through IFT-6 webcast telemetry.
# Super Heavy first stage MECO ~T+165s, hot-stage at ~T+170s, Ship SECO ~T+515s.
# Tall plume from 33x Raptor → unusually visible; confidence declines fast after
# stage-sep because trajectory varies per flight test profile.
STARSHIP = AscentProfile(
    name="Starship",
    match_keywords=("Starship",),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.80),
        _s(30, 2.5, 0.3, 87.0, 0.78),
        _s(70, 14.0, 4.0, 70.0, 0.72),
        _s(165, 70.0, 85.0, 38.0, 0.65),
        _s(300, 130.0, 600.0, 15.0, 0.55),
        _s(515, 190.0, 1600.0, 3.0, 0.45),
    ),
    insertion_t_seconds=515,
)

# ---------------------------------------------------------------------------
# Coverage wave 2 (2026-06-10). A live audit of the cached LL2 feed showed
# 5 of 7 distinct upcoming rockets had NO profile (Electron, H3, Kinetica 1,
# Long March 3B/E, Spectrum) — every such launch silently skips ASCENT
# prediction. This wave adds the cache-confirmed five plus the high-cadence
# active families most likely to appear in the feed during the mission.
# Tables are nominal keyframes from public webcast/press-kit telemetry;
# confidence runs lower than wave 1 where public data is sparser. The
# geometry math tolerates ±20% alt/downrange error — sight lines are
# hundreds of km, so shape matters more than precision.
# ---------------------------------------------------------------------------

# Electron (Rocket Lab). Highest-cadence smallsat launcher. Tiny vehicle:
# Max-Q ~T+65s, MECO ~T+150s @ ~70km, SES-1 to ~T+540s. Small plume —
# apparent-plume-angle scoring will rank it honestly low at long range.
ELECTRON = AscentProfile(
    name="Electron",
    match_keywords=("Electron",),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.90),
        _s(30, 2.0, 0.2, 87.0, 0.88),
        _s(65, 10.0, 3.0, 72.0, 0.85),
        _s(150, 70.0, 55.0, 35.0, 0.80),
        _s(300, 120.0, 350.0, 12.0, 0.72),
        _s(540, 200.0, 1100.0, 2.0, 0.62),
    ),
    insertion_t_seconds=540,
)

# H3 (JAXA/MHI). H3-22/24 fly SRB-3 boosters (sep ~T+116s); H3-30 is the
# all-liquid 3×LE-9 variant. Common keyframes cover both within tolerance.
# MECO ~T+297s, second-stage to LEO insertion ~T+700s.
H3 = AscentProfile(
    name="H3",
    match_keywords=("H3-", "H3 "),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.80),
        _s(30, 2.2, 0.3, 87.0, 0.78),
        _s(80, 13.0, 4.0, 70.0, 0.74),
        _s(180, 80.0, 110.0, 35.0, 0.70),
        _s(297, 140.0, 450.0, 12.0, 0.65),
        _s(700, 220.0, 2100.0, 3.0, 0.55),
    ),
    insertion_t_seconds=700,
)

# Long March 3A/3B/3C (CASC). Hypergolic GTO workhorse from Xichang, four
# boosters on 3B/3C. Booster sep ~T+140s; the photogenic climb ends with
# stage-2 ~T+330s; stage-3 burns long and dim toward GTO.
LONG_MARCH_3 = AscentProfile(
    name="Long March 3",
    match_keywords=("Long March 3", "CZ-3"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.80),
        _s(30, 2.0, 0.3, 87.0, 0.78),
        _s(75, 12.0, 4.0, 71.0, 0.74),
        _s(140, 55.0, 45.0, 45.0, 0.70),
        _s(330, 160.0, 600.0, 10.0, 0.62),
        _s(800, 210.0, 2600.0, 2.0, 0.50),
    ),
    insertion_t_seconds=800,
)

# Long March 2C/2D/2F (CASC). Two-stage hypergolic LEO family (2F flies
# crew to Tiangong). Stage sep ~T+160s, insertion ~T+580s.
LONG_MARCH_2 = AscentProfile(
    name="Long March 2",
    match_keywords=("Long March 2", "CZ-2"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.85),
        _s(30, 2.0, 0.3, 87.0, 0.82),
        _s(75, 12.0, 4.0, 71.0, 0.78),
        _s(160, 65.0, 70.0, 40.0, 0.74),
        _s(330, 140.0, 500.0, 10.0, 0.68),
        _s(580, 200.0, 1500.0, 2.0, 0.60),
    ),
    insertion_t_seconds=580,
)

# Long March 4B/4C (CASC). Three-stage hypergolic SSO workhorse; climb
# closely tracks CZ-2 with a third-stage stretch to ~T+700s.
LONG_MARCH_4 = AscentProfile(
    name="Long March 4",
    match_keywords=("Long March 4", "CZ-4"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.80),
        _s(30, 2.0, 0.3, 87.0, 0.78),
        _s(75, 12.0, 4.0, 71.0, 0.74),
        _s(160, 65.0, 70.0, 40.0, 0.70),
        _s(350, 150.0, 550.0, 10.0, 0.64),
        _s(700, 210.0, 1900.0, 2.0, 0.55),
    ),
    insertion_t_seconds=700,
)

# Long March 6/6A/6C (CASC). Kerolox small/medium SSO family from Taiyuan;
# 6A adds four solid boosters (sep ~T+115s). Insertion ~T+650s.
LONG_MARCH_6 = AscentProfile(
    name="Long March 6",
    match_keywords=("Long March 6", "CZ-6"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.78),
        _s(30, 2.2, 0.3, 87.0, 0.75),
        _s(80, 13.0, 4.0, 70.0, 0.72),
        _s(180, 75.0, 100.0, 36.0, 0.66),
        _s(350, 140.0, 520.0, 10.0, 0.60),
        _s(650, 200.0, 1700.0, 2.0, 0.52),
    ),
    insertion_t_seconds=650,
)

# Long March 8/8A (CASC). Kerolox medium-lift from Wenchang (coastal —
# good ocean sight lines). Two boosters, core sep ~T+170s, ~T+700s to SSO.
LONG_MARCH_8 = AscentProfile(
    name="Long March 8",
    match_keywords=("Long March 8", "CZ-8"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.78),
        _s(30, 2.2, 0.3, 87.0, 0.75),
        _s(80, 13.0, 4.0, 70.0, 0.72),
        _s(170, 70.0, 90.0, 38.0, 0.66),
        _s(350, 145.0, 540.0, 10.0, 0.60),
        _s(700, 210.0, 1900.0, 2.0, 0.52),
    ),
    insertion_t_seconds=700,
)

# Kinetica 1 / Lijian-1 (CAS Space). Four-stage solid smallsat launcher from
# Jiuquan. Solids climb FAST: very photogenic early plume, ~T+600s insertion.
KINETICA_1 = AscentProfile(
    name="Kinetica 1",
    match_keywords=("Kinetica", "Lijian"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.72),
        _s(30, 3.0, 0.4, 86.0, 0.70),
        _s(70, 18.0, 8.0, 65.0, 0.66),
        _s(160, 80.0, 110.0, 32.0, 0.60),
        _s(330, 150.0, 550.0, 8.0, 0.54),
        _s(600, 210.0, 1500.0, 2.0, 0.46),
    ),
    insertion_t_seconds=600,
)

# Kuaizhou-1A / KZ-11 (ExPace). Road-mobile solid smallsat family. Fast
# solid climb like Kinetica; insertion ~T+460s.
KUAIZHOU = AscentProfile(
    name="Kuaizhou",
    match_keywords=("Kuaizhou", "KZ-"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.70),
        _s(30, 3.0, 0.4, 86.0, 0.68),
        _s(70, 18.0, 8.0, 64.0, 0.64),
        _s(150, 75.0, 100.0, 32.0, 0.58),
        _s(300, 140.0, 480.0, 8.0, 0.52),
        _s(460, 200.0, 1100.0, 2.0, 0.45),
    ),
    insertion_t_seconds=460,
)

# Ceres-1 (Galactic Energy). Four-stage solid smallsat launcher, high
# Chinese commercial cadence. Profile mirrors the solid-family shape.
CERES_1 = AscentProfile(
    name="Ceres-1",
    match_keywords=("Ceres",),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.70),
        _s(30, 3.0, 0.4, 86.0, 0.68),
        _s(70, 17.0, 7.0, 65.0, 0.64),
        _s(150, 75.0, 95.0, 32.0, 0.58),
        _s(320, 145.0, 500.0, 8.0, 0.52),
        _s(500, 200.0, 1200.0, 2.0, 0.45),
    ),
    insertion_t_seconds=500,
)

# PSLV (ISRO). Solid core + 6 strap-ons; alternating solid/liquid stages
# from Sriharikota. PS1 burnout ~T+110s, insertion ~T+1000s for typical SSO.
PSLV = AscentProfile(
    name="PSLV",
    match_keywords=("PSLV",),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.82),
        _s(30, 2.5, 0.3, 87.0, 0.80),
        _s(70, 14.0, 5.0, 68.0, 0.76),
        _s(180, 90.0, 140.0, 34.0, 0.70),
        _s(400, 160.0, 700.0, 8.0, 0.62),
        _s(1000, 230.0, 2900.0, 2.0, 0.50),
    ),
    insertion_t_seconds=1000,
)

# Vega-C (Avio/Arianespace). Three solid stages + AVUM+ from Kourou.
# P120C burnout ~T+135s; the bright solid climb ends ~T+450s.
VEGA_C = AscentProfile(
    name="Vega",
    match_keywords=("Vega",),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.78),
        _s(30, 3.0, 0.4, 86.0, 0.75),
        _s(70, 18.0, 8.0, 64.0, 0.72),
        _s(135, 70.0, 80.0, 36.0, 0.66),
        _s(300, 140.0, 460.0, 8.0, 0.58),
        _s(600, 200.0, 1400.0, 2.0, 0.50),
    ),
    insertion_t_seconds=600,
)

# Spectrum (Isar Aerospace). Two-stage kerolox smallsat launcher from
# Andøya (polar — high-latitude trajectories the ISS rarely sees, but the
# tangent-clearance geometry handles that honestly). Sparse flight history:
# lowest confidence in the table.
SPECTRUM = AscentProfile(
    name="Spectrum",
    match_keywords=("Spectrum",),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.60),
        _s(30, 2.0, 0.2, 87.0, 0.58),
        _s(70, 11.0, 3.5, 70.0, 0.55),
        _s(160, 65.0, 60.0, 36.0, 0.50),
        _s(320, 130.0, 420.0, 10.0, 0.45),
        _s(540, 190.0, 1100.0, 2.0, 0.40),
    ),
    insertion_t_seconds=540,
)

# Firefly Alpha. Two-stage kerolox smallsat launcher from Vandenberg.
# Stage sep ~T+165s, insertion ~T+500s.
FIREFLY_ALPHA = AscentProfile(
    name="Firefly Alpha",
    match_keywords=("Firefly Alpha", "Alpha"),
    samples=(
        _s(0, 0.0, 0.0, 90.0, 0.68),
        _s(30, 2.2, 0.3, 87.0, 0.66),
        _s(75, 12.0, 4.0, 70.0, 0.62),
        _s(165, 70.0, 75.0, 36.0, 0.56),
        _s(320, 135.0, 460.0, 9.0, 0.50),
        _s(500, 195.0, 1100.0, 2.0, 0.44),
    ),
    insertion_t_seconds=500,
)


# Order matters: more-specific keywords go first so "Falcon Heavy" matches
# FALCON_HEAVY before falling through to FALCON_9's "Falcon" substring.
ALL_PROFILES: tuple[AscentProfile, ...] = (
    FALCON_HEAVY,
    FALCON_9,
    ATLAS_V,
    VULCAN_CENTAUR,
    SOYUZ_2,
    LONG_MARCH_5,
    LONG_MARCH_7,
    SLS,
    NEW_GLENN,
    ARIANE_6,
    STARSHIP,
    # Coverage wave 2 (2026-06-10) — see the section comment above.
    LONG_MARCH_2,
    LONG_MARCH_3,
    LONG_MARCH_4,
    LONG_MARCH_6,
    LONG_MARCH_8,
    ELECTRON,
    H3,
    KINETICA_1,
    KUAIZHOU,
    CERES_1,
    PSLV,
    VEGA_C,
    SPECTRUM,
    # LAST: "Alpha" is the family name LL2 uses for Firefly — generic enough
    # that every more-specific profile must get first crack at the haystack.
    FIREFLY_ALPHA,
)


def match_rocket(rocket_configuration: dict | None) -> AscentProfile | None:
    """Return the AscentProfile matching an LL2 `rocket.configuration` dict.

    Matches case-insensitively against `full_name`, `name`, and `family` in
    that order (most specific to least). Returns None if no profile matches,
    in which case the caller should skip ASCENT prediction for this launch
    (OVERHEAD path is unaffected).
    """
    if not rocket_configuration:
        return None
    candidates = (
        rocket_configuration.get("full_name") or "",
        rocket_configuration.get("name") or "",
        rocket_configuration.get("family") or "",
    )
    haystack = " ".join(c.lower() for c in candidates if c)
    if not haystack:
        return None
    for profile in ALL_PROFILES:
        for keyword in profile.match_keywords:
            if keyword.lower() in haystack:
                return profile
    return None
