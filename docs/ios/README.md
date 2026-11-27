# SNAP for iPhone and iPad

SNAP is becoming an offline-first Earth viewer for the NASA-managed iPad and iPhone in orbit, with the ISS track, targets and passes available for hours to days without the station's Ku-band link. Release 1 uses a native shell around the existing screens. Native code handles storage, sync, map tiles and the offline Earth imagery, alerts and sign-in. The flat map uses the bundled baseline, the W-43 Earth pack and W-45 detail packs. W-44 is scheduled after G2 as the first update after release 1 and opens Map on a globe. Read the [product goal](../designs/ios-app.md#product-goal).

The unsigned W-01 skeleton in `app/` loads a bundled placeholder by default. W-02 adds an offline host proof that can be bundled into the same app for simulator testing. [App build guide](../../app/README.md)

## The documents

| Read | For |
| --- | --- |
| [../designs/ios-app.md](../designs/ios-app.md) | Why, what was decided, what is still open |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The shape, the nouns, the contracts, the rules the build enforces |
| [WORK_PLAN.md](WORK_PLAN.md) | The work packages, their order, the gates, the rules for every pull request |
| [OWNER_STEPS.md](OWNER_STEPS.md) | The steps only the owner can do |
| [W-71-NASA-APPROVAL-PACKET.md](W-71-NASA-APPROVAL-PACKET.md) | Draft for owner review before G7 |
| [codex-cold-read-2026-11-15.md](codex-cold-read-2026-11-15.md) | The second opinion and its findings |
| [STATUS.md](STATUS.md) | Where the work stands today |
| [DECISIONS.md](DECISIONS.md) | Decisions made after the design doc |
| [FOLLOWUPS.md](FOLLOWUPS.md) | Problems found and not yet fixed |
| [G1-HOST-PROOF.md](G1-HOST-PROOF.md) | W-02 simulator matrix, checks and evidence |

`DEVICE-ACCESS.md` and `ACCEPTANCE.md` arrive with their work packages.

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

The bundled baseline and W-43 Earth pack together cover the Web Mercator grid at zoom 0 to 8, reaching about ±85.05° latitude. The poles beyond that limit are not covered. The W-43 build checks the full tile inventory and payload integrity. Cold-launch the release candidate offline on the flat map with the packs installed. Check rendering at zoom 8 from the Earth pack at ten locations across continents and oceans, and at zoom 12 from a W-45 detail pack at a covered verified public target. The ISS prediction moves, a target remains usable, an alert appears while locked and a recorded shot survives restart and uploads once.
