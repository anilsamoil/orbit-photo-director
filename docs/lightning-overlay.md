# Publishing the lightning overlay

The map's Lightning control reads `/lightning/latest.json`. An independent weather-data publisher owns that one key. Run its producer against a dedicated staging directory:

```sh
python -m generator.lightning_overlay --output /path/to/lightning-staging
```

Schedule one run every two minutes. The five-minute observation window overlaps the previous window and ends two minutes behind the clock so NOAA has time to deliver the files. Each run reads the sixteen 20-second files for each spacecraft, including the next file because a flash can start before its file boundary. The two-minute schedule lets an enabled map pick up changes between IR frames and hourly queue runs. A staging lock prevents overlapping producers, and a same-directory rename commits the complete artifact.

On activation, give one scheduler and transport exclusive ownership of `lightning/latest.json` in the map's existing static origin. Transfer the staged file after each successful command, including an artifact with two unavailable sectors. Set `Content-Type: application/json` and `Cache-Control: no-store`. A failed command must leave the last published object in place. The map ages that object's observation end and suppresses its dots at eight minutes. A missing object shows feed unavailable on first use. This PR supplies the producer. Scheduling and the production transport require a separate rollout.

Schema 1 carries UTC `start`, `end` (exclusive) and `generated_at`, the conservative 5,500 km coverage radius, and one entry per spacecraft. Each entry includes its sub-satellite longitude. A centroid inside the pilot footprint belongs only to its nearest spacecraft, with GOES-19 owning the equal-distance meridian. Missing coverage never transfers that territory to the other spacecraft. This geographic mosaic uses the reported optical centroids. GLM observes total lightning including flashes within clouds.

A sector needs every slot, the expected platform, a full 20 seconds per file and complete navigation with zero reported data loss. Its `cells` is null when a slot fails. An empty list means the complete sector recorded zero quality-accepted flashes inside its footprint during the interval. For each occupied cell the tuple is `[longitude, latitude, first-event seconds since start, flash count]`. Only good-quality flashes enter those counts. Starting at a quarter degree, the producer doubles the grid spacing until each sector has at most 512 occupied cells. A dot uses the newest flash's centroid within its cell. The sector total includes every accepted flash, including those summarized by the same dot.

NOAA publishes GOES-19 East and GOES-18 West through its open-data program. [Source registry](https://registry.opendata.aws/noaa-goes/).
