# SNAP verification map

This directory is the source for driving SNAP the way an astronaut does. Read this index, then use one feature file as the recipe.

## Baseline preconditions

- Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs up` from the repo root.
- Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs doctor` and require the `ok` line, the proxy pid, and a launch `valid_until` in the future.
- Open only the URL `doctor` prints. The default is `http://127.0.0.1:41731`.
- Keep a second run on its own `OPD_VERIFY_HOME` and `OPD_VERIFY_PORT`.
- The fixture signs in as Anil. Cards are `Verify Reef`, `Verify Delta`, `Verify Mesa`, and `Verify Keepsake`. The chance launch is `Verify Ascent`. `Verify Horizon` is the All launches row. Upcoming and the map do not list it.

## Driving conventions

- Start each feature from the healthy instance unless its preconditions say otherwise.
- Prefer the ids and accessible names in the feature file.
- `drive all` walks banner, topbar, queue, upcoming, map, iss, help, profile, log, phone, and tracked in that order on desktop Chrome, then runs those same steps on WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11. A single feature drive does the same four surfaces. WebKit missing fails the drive. `OPD_VERIFY_SURFACE` limits one process to `desktop`, `iphone-13`, `iphone-17-pro`, or `ipad-pro-11`. A combined process that hits `page.goto: WebKit encountered an internal error` inside `proveHeldSignIn` is not the surface verdict. Run one surface per process. A flake of `iss launch earth restored 390x664` gets one solo fresh-process retry of `iphone-13`.
- `sw` builds a preview and is not part of `drive all`.
- `down` deletes the Chrome profile and keeps `evidence/`.

## Proof and skip reporting

- Save the PNG for the action, not only the last screen.
- Record the feature id in the script stdout.
- If a path cannot be reached, record the command and the unmet precondition. Do not mark it verified by a different path.

## Features

- [Status banner](./banner.md) covers the footer after the manifest loads, the orange `TLE Nh old` suffix held across a countdown tick while the age label may step, and the held `SIGN IN AGAIN` footer. The suffix reads track `tle_age_hours`. The footer does not print `tle_epoch`. That field on `track.json` is the element-set epoch.
- [Top bar](./topbar.md) covers the fixed header, the live ISS readout, the Kp badge, the profile name that opens the crew menu, and the row that scrolls when the tabs and a long name do not fit. A drag that starts on the ISS readout or the Kp chip scrolls that row.
- [Queue](./queue.md) covers the next passes, score, sort, remind, shoot, the All, Mine, and Launches filters, the Verify Keepsake pane, Hide, and the empty sentence on the last Hide. Mine writes shared `opd_target_filter_v1`. Launches does not.
- [Upcoming](./upcoming.md) covers chance launch cards, the later passes, score sort, and hide. Verify Horizon stays off this list.
- [Map](./map.md) covers the globe, ISS track, target popup, dropped pin, legend, imagery date, the Time strip laid on the map (the canvas meets the pane with a 0px gap, and the strip is `rgba(16, 22, 28, 0.55)` so the ground shows through), tool rail, satellite picker, chance-only launch dialog, the word Launches inside its Show-group button, and the pin that Hide removes. The drive then opens the profile menu, switches to Jessica Watkins (Watty), and returns to Anil from that menu. The map opens with that chrome hidden behind Controls. The hide control stays 88 by 44, 12px from the right. The map ? button and the (i) credit button are not shown. An open popup reserves the inspector, and on a phone the pin click still lands on the canvas.
- [ISS view](./iss.md) covers the tab after Map, Horizon and Straight down, the Launch menu beside Telemetry, seven-day chances first, then the All launches group, the `Expedition 75 Beta Edition` line at the UTC size, starting under the toolbar ? on a wide window and on the last toolbar row at 720px and below, the UTC clock and the four text lines under it (the GMT day at the UTC size, then Houston time, day and month, weekday) from that same instant, including after the second changes and after an aim, and those five lines clearing when the orbit is unavailable, optical field of view that stays across a tab return and a reload, pan that stays for the page session, Cupola windows 1 through 7 and the lens field they restore, `r` and Escape that return to Horizon and clear sessionStorage when the profile menu is closed, and Escape that only closes an open profile menu, arrow keys, W/A/S/D for that same pan, Shift+arrows and Shift+W/A/S/D for a quarter-step pan, `+`/`-`, digit keys `1` through `7` that select Cupola windows, and `h` and `n` that select Horizon and Straight down while the view is focused, the collapsed Telemetry card, place labels, Port and Starboard, and returning to Map and Queue. The map does not show those clock lines. A 44px `[data-iss-fullscreen]` button uses modes `off`, `overlay`, and `element`. The shortcut sheet closes through its scrim when fullscreen starts. Attribution is hidden while fullscreen is active. The drive stdout includes `sheet press`.
- [Help](./help.md) covers the ? button, hidden on the Map tab, the corner button on the other tabs, and the dialog, including Aiming the ISS view (`n / N`, WASD, `#iss=`, the Launch line with seven-day chances first, the pad beside Telemetry, the gold pin and edge arrow, and the gold path when that launch includes a trajectory) and a legend of launch, day, twilight, and eclipse.
- [Profile](./profile.md) covers the signed-in profile, the profile select, New profile, Delete this profile, the no-account picker refusing roster names, the read-only crew roster, the authorized list, distance threshold, add target, hidden curated targets, and photo lookup.
- [Log](./log.md) covers the shoot and skip rows for the signed-in profile. The drive proves the Verify Reef shoot.
- [Phone](./phone.md) covers a 390x844 portrait and an 844x390 landscape, 44px targets, a longer dock with the map ? button and the (i) credit button hidden, and a long-press pin popup.
- [Tracked vehicles](./tracked.md) covers the missing Starship legend row, the no-orbit case, the missing-artifact fallback, the age-out case, and the marker plus ground track when an element set is published.
- [Service worker](./service-worker.md) covers `sw.js` on a preview build. The shell reload, `updateViaCache: none`, and the no-cache headers on HTML and the shell filenames are named from source. `sw` does not assert them.
