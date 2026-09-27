# SNAP verification map

This directory is the source for driving SNAP the way an astronaut does. Read this index, then use one feature file as the recipe.

## Baseline preconditions

- Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs up` from the repo root.
- Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs doctor` and require the `ok` line, the proxy pid, and a launch `valid_until` in the future.
- Open only the URL `doctor` prints. The default is `http://127.0.0.1:41731`.
- Keep a second run on its own `OPD_VERIFY_HOME` and `OPD_VERIFY_PORT`.
- The fixture signs in as Anil. Cards are `Verify Reef`, `Verify Delta`, `Verify Mesa`, and `Verify Keepsake`. The launch is `Verify Ascent`.

## Driving conventions

- Start each feature from the healthy instance unless its preconditions say otherwise.
- Prefer the ids and accessible names in the feature file.
- `drive all` walks banner, topbar, queue, upcoming, map, help, profile, log, and phone in that order on one page.
- `sw` builds a preview and is not part of `drive all`.
- `down` deletes the Chrome profile and keeps `evidence/`.

## Proof and skip reporting

- Save the PNG for the action, not only the last screen.
- Record the feature id in the script stdout.
- If a path cannot be reached, record the command and the unmet precondition. Do not mark it verified by a different path.

## Features

- [Status banner](./banner.md) covers the footer after the manifest loads.
- [Top bar](./topbar.md) covers the fixed header, the live ISS readout, the Kp badge, and the scrolling tab strip.
- [Queue](./queue.md) covers the next passes, score, sort, remind, shoot, the mine filter, keepsake windows, and Hide.
- [Upcoming](./upcoming.md) covers the later passes, score sort, and hide.
- [Map](./map.md) covers the globe, ISS track, target popup, dropped pin, legend, imagery date, collapsed credits, time controls, tool rail, satellite picker, and launch dialog.
- [Help](./help.md) covers the ? button above the map credits, the corner button on the other tabs, and the dialog.
- [Profile](./profile.md) covers the signed-in profile, distance threshold, add target, hidden curated targets, and photo lookup.
- [Log](./log.md) covers the calibration row written by Shoot.
- [Phone](./phone.md) covers a 390x844 portrait and an 844x390 landscape, 44px targets, the dock clearing the (i) and ? buttons, and a long-press pin popup.
- [Service worker](./service-worker.md) covers `sw.js` on a preview build.
