# SNAP for iPhone and iPad

SNAP is becoming an app for the operator's iPad and iPhone so that it keeps working when the station's link drops. Release 1 is a native shell around the existing web frontend: the screens stay as they are, and native code takes over storage, syncing, the map tiles, alerts and sign-in. Native screens come later, one at a time. The website does not change.

Planned on 2026-11-15. No app code exists yet.

## The documents

| Read | For |
| --- | --- |
| [../designs/ios-app.md](../designs/ios-app.md) | Why, what was decided, what is still open |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The shape, the nouns, the contracts, the rules the build enforces |
| [WORK_PLAN.md](WORK_PLAN.md) | The work packages, their order, the gates, the rules for every pull request |
| [OWNER_STEPS.md](OWNER_STEPS.md) | The steps only the owner can do |
| [codex-cold-read-2026-11-15.md](codex-cold-read-2026-11-15.md) | The second opinion, word for word |
| [STATUS.md](STATUS.md) | Where the work stands today |
| [DECISIONS.md](DECISIONS.md) | Decisions made after the design doc |
| [FOLLOWUPS.md](FOLLOWUPS.md) | Problems found and not yet fixed |

`G1-HOST-PROOF.md`, `DEVICE-ACCESS.md` and `ACCEPTANCE.md` do not exist yet. Work packages create them.

## If you are the implementer

1. Read ARCHITECTURE.md, then the rules and the gates at the top of WORK_PLAN.md.
2. Start with W-00. Then Wave 0 runs in parallel: W-01, W-10, W-20 (the design note first, no code before its review), W-30, W-40.
3. One work package per pull request, from a worktree, with the proof the package names.
4. When a fact in these documents turns out wrong, say so in the pull request and fix the document in the same change.

## If you are the organizer

1. Read WORK_PLAN.md in full.
2. Open one tracking issue per Wave 0 work package, with the package's section as the body.
3. Keep `STATUS.md` current. The owner reads it on a phone.
4. Hold the gates. G1 decides the host and can stop the whole plan. W-20 needs a security review before code and the owner's approval before deploy.
5. Chase OWNER_STEPS.md. Step 2, the developer membership, is the longest wait.

## The one line that defines done for release 1

Cold-launch offline; Earth draws; the ISS prediction moves; a target remains usable; an alert appears while locked; a recorded shot survives restart and uploads once.
