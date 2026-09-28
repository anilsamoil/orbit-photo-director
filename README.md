# Orbit Photo Director

Earth-photography planner for an 8-month ISS mission. Mac-side Python generator publishes a ranked shot queue to [map.astroanil.dev](https://map.astroanil.dev). The astronaut opens the URL from orbit and sees:

- the Queue for the next 90 minutes (target, countdown, `P(unobstructed)`, day/night/terminator regime). The published pool is five ground slots. The page drops past passes and can place launch cards in front. Map is the tab that opens.
- the live ISS dot, ground track, and observed cloud overlay, with a time slider that scrubs the track, marker, terminator, satellites, and target pins to any instant in the next 36 hours. Clouds stay the observed layer.
- a footer that says how old the loaded data is. Online it is green under 90 minutes, yellow until 2 hours, then red. Offline it says LOS and uses green under 1 hour, yellow under 3 hours, orange under 12 hours, then red.

The product is the shot queue, not the map.

**Works offline.** The page boots from a localStorage snapshot before manifest.json comes back, so a tab refresh during an LOS window renders the previous queue in <50ms instead of going blank. The live ISS dot keeps moving past the polynomial window via client-side SGP4. See `CHANGELOG.md` for the V2 ship details.

## Why this exists

Every existing ISS tracker is built for ground viewers aiming up: "when can I see ISS pass overhead?" None show the astronaut what's about to be under them and whether it's worth raising the camera. Same data sources, ~10-person target audience, completely inverted UX.

## Architecture

```
┌────────────────────────────┐         ┌──────────────────────┐         ┌────────────────────────┐
│ Mac on Earth (unattended)  │  rclone │  Cloudflare R2       │ HTTPS   │  ISS browser (you)     │
│                            │  sync   │  + Worker for        │  +      │                        │
│  python generator (60min)  ├────────►│    /api/log endpoint │ Worker  │  shot queue cards      │
│  + daemon.py watchdog      │  every  │  + custom domain     │  POST   │  + map (secondary)     │
│  + OpenClaw notify pipe    │  60 min │  map.astroanil.dev   │         │  + manifest-driven     │
└────────────────────────────┘         └──────────────────────┘         └────────────────────────┘
```

Stack: `sgp4` + `xarray` + `netCDF4` (Mac generator) → `rclone sync` → Cloudflare R2 + custom domain → MapLibre frontend (~150 KB) → Cloudflare Worker for `/api/log` and `/api/health`.

See [docs/DESIGN.md](docs/DESIGN.md) for the full design rationale, premise discussion, and accepted risks.

## Quickstart

```bash
# Python deps
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Run tests
make test

# Run a generator tick (uses mocked SatCORPS until you set NASA Earthdata creds)
make tick

# Frontend dev server
cd frontend && bun install && bun run dev
```

## Operations

- `make tick` — one generator tick (writes to `out/`)
- `make watch` — daemon mode, defaults to one tick every 60 min
- `make deploy` — additive Earth artifacts to Cloudflare R2, manifest last
- `make PYTHON=.venv/bin/python launch-diag` — read-only launch cache diagnosis; exit 2 means incomplete evidence, not a crash

Launch candidate publication is separate from Earth generation and does not send
notifications. See [the launch runbook](docs/launch-runbook.md) and
[the staged launch plan](docs/plans/2026-09-07-iss-launch-photography-autoplan.md).
- `make soak SCENARIO=network-kill` — inject a failure for soak testing

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for ground-side support procedures.

## Status

V1 shipped at v1.0.0.0. V2 (offline-resilient frontend) at v1.1.0.0 + Lane F SW at v1.1.0.1 + past-pass Queue filter at v1.1.0.2. V3.0 rocket-launch photography (OVERHEAD geometry) at v1.2.0.0 — 🚀 LAUNCH cards in Queue + Upcoming with reserved-slot guarantee, stale-launches banner overlay, LL2 schema-drift detection, operator-facing copy renamed Offline → LOS. V3-P2 ASCENT geometry shipped (2026-05-17 soak) — ascent cards with `launch.kind="ascent"` (a visible pad is a possible shot, not a plume promise); v1.6.1.0 adds the on-map trajectory layer (map Launches button, gold polyline + pad pin). Continuous time-slider (Chris feedback 2026-06-09) at v1.8.0.0 — one-drag scrub to any instant in the next 36h, absolute view-time pinning, one-clock satellite/follow consistency, scrub honesty badges. Forecast frames can be published at v1.9.0.0 (generator flag `OPD_ENABLE_FORECAST_CLOUDS`, default off). The page keeps the observed cloud layer, and a scrubbed badge says the clouds are observed, not forecast. Kill-switch DNS (Lane G) still deferred; pre-launch e2e checklist (Lane H) partial via `scripts/verify-sw-upgrade.sh` + `docs/SW_UPGRADE_VERIFY.md` — see `TODOS.md`. Pre-launch checklist in `docs/RUNBOOK.md`.

## License

MIT — see [LICENSE](LICENSE).
