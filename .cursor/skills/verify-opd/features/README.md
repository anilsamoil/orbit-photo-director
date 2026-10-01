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
- `drive all` walks banner, topbar, queue, upcoming, map, iss, help, profile, log, phone, and tracked in that order on desktop Chrome, then runs those same steps on WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11. A single feature drive does the same four surfaces. WebKit missing fails the drive.
- `sw` builds a preview and is not part of `drive all`.
- `down` deletes the Chrome profile and keeps `evidence/`.

## Proof and skip reporting

- Save the PNG for the action, not only the last screen.
- Record the feature id in the script stdout.
- If a path cannot be reached, record the command and the unmet precondition. Do not mark it verified by a different path.

## Features

- [Status banner](./banner.md) covers the footer after the manifest loads, including the held `SIGN IN AGAIN` footer.
- [Top bar](./topbar.md) covers the fixed header, the live ISS readout, the Kp badge, and the row that scrolls when the tabs and a long username do not fit. A drag that starts on the ISS readout or the Kp chip scrolls that row.
- [Queue](./queue.md) covers the next passes, score, sort, remind, shoot, the mine filter, keepsake windows, and Hide.
- [Upcoming](./upcoming.md) covers launch cards, the later passes, score sort, and hide.
- [Map](./map.md) covers the globe, ISS track, target popup, dropped pin, legend, imagery date, collapsed credits, time controls, tool rail, satellite picker, launch dialog, and the pin that Hide removes. The map opens with that chrome hidden behind Controls.
- [ISS view](./iss.md) covers the tab after Map, Horizon and Straight down, optical field of view that starts over on return, pan that stays for the page session, Cupola windows 1 through 7 and the lens field they restore, Reset and a double-tap on the frame, the collapsed Telemetry card, place labels, Port and Starboard, and returning to Map and Queue.
- [Help](./help.md) covers the ? button, hidden on a fresh Map until Controls, the corner button on the other tabs, and the dialog.
- [Profile](./profile.md) covers the signed-in profile, distance threshold, add target, hidden curated targets, and photo lookup.
- [Log](./log.md) covers the calibration row written by Shoot.
- [Phone](./phone.md) covers a 390x844 portrait and an 844x390 landscape, 44px targets, the dock clearing the (i) and ? buttons with credits collapsed and expanded, and a long-press pin popup.
- [Tracked vehicles](./tracked.md) covers the Starship legend, the no-orbit row, the missing-artifact fallback, the age-out sentence, and the marker plus ground track when an element set is published.
- [Service worker](./service-worker.md) covers `sw.js` on a preview build.
