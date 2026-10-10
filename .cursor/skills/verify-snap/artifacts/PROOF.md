# verify-snap proof (2026-09-20)

Commit under test: `c728283` (`main` tip / Mac `codex/map-controls-overlay-20260913`).

## Commands

```bash
.cursor/skills/verify-snap/helpers/control-snap.mjs launch
.cursor/skills/verify-snap/helpers/control-snap.mjs doctor
.cursor/skills/verify-snap/helpers/control-snap.mjs browser prove-queue --path .cursor/skills/verify-snap/artifacts/queue
.cursor/skills/verify-snap/helpers/control-snap.mjs cleanup
```

## Results

- Doctor: `ok` — SNAP title, VERIFY manifest, pid alive at `http://127.0.0.1:43147`
- Drove feature: **Queue** (`queue-open` + `queue-cards`)
- Proof: `view-queue`, 3 cards including **Verify Tokyo**, brand SNAP
- Cleanup: port freed; evidence retained

## Evidence

- `.cursor/skills/verify-snap/artifacts/queue/queue.aria.json`
- `.cursor/skills/verify-snap/artifacts/queue/queue.png`
