"""Live-S3 smoke test for the GLM sampler (v1.5.5.0 / weather v1.3.2).

Builds a GLMSampler at "now" and reports what it finds. Use this to
verify the live path after real-world deployment when NOAA S3 has
data for today.

In the simulated-2026 dev env this will print "0 granules" because
the bucket only has data through 2025 — that's expected, not a bug.
The mocked unit tests are what gate v1.3.2 correctness.
"""

from datetime import UTC, datetime

from generator.lightning import GLMSampler


def main() -> None:
    now = datetime.now(tz=UTC)
    sampler = GLMSampler(when=now)
    total_flashes = sum(len(v) for v in sampler._flashes_by_bucket.values())
    print(f"GLM-SMOKE @ {now.isoformat()}")
    print(f"  total flashes ingested: {total_flashes}")
    print(f"  oldest granule age: {sampler._oldest_granule_age_min} min")
    print(f"  spatial buckets populated: {len(sampler._flashes_by_bucket)}")
    print()
    print("Sample lookups (expect 'glm-' source w/ age for in-coverage targets):")
    for lat, lon, name in [
        (30.0, -90.0, "New Orleans"),
        (40.7, -74.0, "New York"),
        (-33.0, -70.0, "Santiago"),
        (51.5, 0.0, "London (outside coverage)"),
    ]:
        result = sampler.sample(lat, lon, now)
        print(
            f"  {name:30s} ({lat:6.2f}, {lon:7.2f}): "
            f"source={result.source}, "
            f"potential={result.lightning_potential:.3f}, "
            f"flashes/min={result.flash_rate_per_min:.2f}"
        )

    # Sprite-watch live-verify (Unit 7): the limb-annulus cluster scan is
    # invisible in dev (no live GLM past 2025), so this is the only place it
    # can be exercised against real flashes. Sweep a few sub-points sitting
    # over GLM coverage and report the strongest in-annulus storm cluster —
    # what the generator would attach as pass.sprite on a night pass there.
    print()
    print("Sprite annulus scan (strongest storm in the 900-3200km limb ring):")
    for lat, lon, name in [
        (25.0, -85.0, "Gulf of Mexico"),
        (10.0, -75.0, "N. Andes / Caribbean"),
        (-20.0, -55.0, "S. Brazil / La Plata"),
        (0.0, -30.0, "Equatorial Atlantic"),
    ]:
        cluster = sampler.strongest_cluster_in_annulus(lat, lon)
        if cluster is None:
            print(f"  {name:30s} ({lat:6.2f}, {lon:7.2f}): no qualifying storm")
        else:
            print(
                f"  {name:30s} ({lat:6.2f}, {lon:7.2f}): "
                f"{cluster.distance_km:.0f}km @ {cluster.bearing_deg:.0f}deg, "
                f"{cluster.flash_count} flashes"
            )


if __name__ == "__main__":
    main()
