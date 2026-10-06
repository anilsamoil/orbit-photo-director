# Run the launch census

The census replays one saved Launch Library page and one ISS TLE. It counts what today's launch list would show, and it prints a separate research tier count. It does not fetch, publish, or change the map.

From the repository root:

```
python scripts/launch_census.py
```

The fixtures are `tests/fixtures/launch_census/launches.json`, the receipt beside it, and `iss.tle`. The clock is the receipt time.

To add the geometry base rate, pass `--base-rate`. `--base-rate-n` sets the sample count and defaults to 3000. `--seed` defaults to 1. Tests call the same function with a small sample count. The profile is a generic Falcon 9. Each pad azimuth is a stand-in, not a flown heading.

```
python scripts/launch_census.py --base-rate --base-rate-n 3000 --seed 1
```

The tier line is research only. It is not a shooting instruction. Photo cases in `eol_cases.json` keep `status` `TODO` where no opened EOL page supplied a frame.
