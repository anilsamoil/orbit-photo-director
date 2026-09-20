---
name: verify-snap
description: "Drive SNAP (Orbit Photo Director / map.astroanil.dev) in a browser the way a crew operator would — Queue, Upcoming, Map, Profile, Log. Use when verifying frontend behavior for orbit-photo-director, proving a UI change, or running /verify against the map app."
---

# Verify SNAP (Orbit Photo Director)

Primary surface: the **SNAP** web UI (`frontend/`, served locally or at `https://map.astroanil.dev`). Secondary surfaces (not driven by this skill): Python generator (`make tick`), Cloudflare Worker APIs.

Harness: `control-snap` (Playwright Chromium) plus verification-only Vite fixtures so agents never need Cloudflare Access or live R2.

## Launch

From the **repo root** (`orbit-photo-director/`):

```bash
export PATH="$HOME/.bun/bin:$PATH"
# one-time: frontend + harness deps
cd frontend && bun install && cd ..
cd .cursor/skills/verify-snap/helpers && bun install && cd ../../../../..

# optional: pin Chromium if Playwright's download is unavailable
# export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/local/bin/google-chrome

.cursor/skills/verify-snap/helpers/control-snap.mjs launch
```

Ready when stdout JSON has `"ok": true` and `"url": "http://127.0.0.1:43147"` (override with `SNAP_VERIFY_PORT` / `SNAP_VERIFY_HOST`). Launch starts Vite with `.cursor/skills/verify-snap/helpers/vite.config.verify.mjs`, which serves VERIFY fixtures from `.cursor/skills/verify-snap/fixtures/` and stubs `/api/browser/session` (and other `/api/*`) as JSON so SNAP can authenticate without Cloudflare Access or live R2.

Teardown: `.cursor/skills/verify-snap/helpers/control-snap.mjs cleanup` (kills only the recorded PID; keeps evidence under `.cursor/skills/verify-snap/artifacts/`).

Isolation: default port `43147`. Do not drive a shared instance you did not launch. Concurrent runs need distinct `SNAP_VERIFY_PORT` values and separate checkouts (Vite verify cache: `frontend/.vite-cache-verify`).

## Doctor

```bash
.cursor/skills/verify-snap/helpers/control-snap.mjs doctor
```

Require JSON `"ok": true` with `pidAlive`, `htmlOk`, `brandOk` (title/brand SNAP), and `fixtureManifestOk` (manifest version `VERIFY`). Re-run doctor whenever a drive fails or the UI looks wedged before retrying.

## Drive

Prefer stable element IDs from `frontend/index.html` (`#tab-queue`, `#tab-map`, `#time-slider`, …) over coordinates.

```bash
# Open Queue tab
.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id tab-queue --wait-for "#view.view-queue, #cards"

# ARIA-ish snapshot + screenshot
.cursor/skills/verify-snap/helpers/control-snap.mjs browser snapshot --aria --path .cursor/skills/verify-snap/artifacts/queue/queue.aria.json
.cursor/skills/verify-snap/helpers/control-snap.mjs browser screenshot --path .cursor/skills/verify-snap/artifacts/queue/queue.png

# One-shot proof recipe for the Queue feature
.cursor/skills/verify-snap/helpers/control-snap.mjs browser prove-queue --path .cursor/skills/verify-snap/artifacts/queue
```

Other useful actions: `browser click --id <id>`, `browser fill --id <id> --value "…"`, `browser eval "document.title"`, `browser goto --path /`.

Feature recipes live in [`features/`](./features/README.md). Drive the mapped entry points; do not substitute a different path and call it verified.

## Evidence

Store proofs under `.cursor/skills/verify-snap/artifacts/<feature>/` (gitignored run state stays out; committed proofs may live here or be copied to the Project media store).

Standards:

- Exercise the real tab/button path a crew member uses — not vitest mocks or Worker-only endpoints.
- Capture **action + resulting state** (e.g. click Queue → `#view` is `view-queue` and `#cards` contains fixture target `Verify Tokyo`).
- UI proof: ARIA/JSON snapshot **and** screenshot showing the SNAP brand.
- Side effects (Shoot/Skip → `/api/log`, Profile target CRUD) need a second read of the visible list or network response; those APIs require production Worker auth — mark `verified-unreachable` locally when the fixture server returns 404 for `/api/*`.
- Never treat cleanup as deleting evidence.

## Cleanup

```bash
.cursor/skills/verify-snap/helpers/control-snap.mjs cleanup
```

Removes `.run-state.json` and the Vite log for this run; kills the launch PID (process group). Does **not** delete `artifacts/`. After cleanup, confirm evidence files still exist at the paths above.

Always run cleanup after failed iterations so ports and Vite processes are not stranded.

## Helpers

| Script | Role |
|--------|------|
| `.cursor/skills/verify-snap/helpers/control-snap.mjs` | `launch` \| `doctor` \| `browser …` \| `cleanup` |
| `.cursor/skills/verify-snap/helpers/vite.config.verify.mjs` | Standalone Vite config: VERIFY fixtures + `/api/*` JSON stubs |
| `.cursor/skills/verify-snap/fixtures/` | Disposable VERIFY manifest + artifacts (sha256-matched) |

Install harness deps once: `cd .cursor/skills/verify-snap/helpers && bun install`.

## Maintain

When SNAP UI or routes change, run `/maintain-verification-skill` against this skill so the feature map stays honest.
