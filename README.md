# Orbit Photo Director

Earth-photography planner for an 8-month ISS mission. Mac-side Python generator publishes a ranked shot queue to [map.astroanil.dev](https://map.astroanil.dev). The astronaut opens the URL from orbit and sees:

- the next 5 shots in the next 90 minutes (target, countdown, `P(unobstructed)`, day/night/terminator regime)
- the live ISS dot + ground track + cloud overlay (secondary view)
- a confidence banner that escalates with snapshot age (green <1h → yellow <3h → orange <12h → red beyond) so it's always honest about how trustworthy the data on screen is

The product is the shot queue, not the map.

**Works offline.** The page boots from a localStorage snapshot before manifest.json comes back, so a tab refresh during an LOS window renders the previous queue in <50ms instead of going blank. The live ISS dot keeps moving past the polynomial window via client-side SGP4. See `CHANGELOG.md` for the V2 ship details.

## Why this exists

Every existing ISS tracker is built for ground viewers aiming up: "when can I see ISS pass overhead?" None show the astronaut what's about to be under them and whether it's worth raising the camera. Same data sources, ~10-person target audience, completely inverted UX.

## Architecture

```
┌────────────────────────────┐         ┌──────────────────────┐         ┌────────────────────────┐
│ Mac on Earth (unattended)  │  rclone │  Cloudflare R2       │ HTTPS   │  ISS browser (you)     │
│                            │  sync   │  + Worker for        │  +      │                        │
│  python generator (30min)  ├────────►│    /api/log endpoint │ Worker  │  shot queue cards      │
│  + daemon.py watchdog      │  every  │  + custom domain     │  POST   │  + map (secondary)     │
│  + OpenClaw notify pipe    │  30 min │  map.astroanil.dev   │         │  + manifest-driven     │
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
- `make watch` — daemon mode, ticks every 30 min
- `make deploy` — `rclone sync` to Cloudflare R2
- `make soak SCENARIO=network-kill` — inject a failure for soak testing

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for ground-side support procedures.

## Status

V1 shipped at v1.0.0.0. V2 (offline-resilient frontend) at v1.1.0.0. Pre-mission service worker (Lane F) and kill-switch DNS (Lane G) deferred to a follow-up — see `TODOS.md`. Pre-launch checklist in `docs/RUNBOOK.md`.

## License

MIT — see [LICENSE](LICENSE).
