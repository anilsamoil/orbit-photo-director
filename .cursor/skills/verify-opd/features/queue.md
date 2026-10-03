# Queue

Queue is the next passes to shoot. The fixture puts Verify Reef and Verify Delta inside the next 90 minutes.

## Sub-features

- `queue-cards` shows both fixture passes.
- `queue-score` opens the score breakdown on the first card.
- `queue-sort` selects Score.
- `queue-remind` presses Remind and sets `aria-pressed` to true.
- `queue-shoot` logs Shoot and shows the toast.
- `queue-mine` shows the empty mine-filter message, then All restores the cards.
- `queue-keepsake` opens the keepsake pane on Verify Keepsake.
- `queue-hide` hides Verify Delta while Verify Reef remains. `#empty` stays hidden. Hiding Verify Reef, the last card, shows `#empty` on that click with `No passes in the next 90 minutes.` The script then restores Verify Reef so the map step can hide that pin. `verify-delta` stays in `removedCuratedIds` on `opd-profile-anil`.

## How to get to it (user POV)

- Choose the Queue tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The manifest `generated_at` is under 60 minutes old, or Shoot stays disabled.
- Run `down`, then `up`, when an earlier drive on this proxy hid a fixture card. The proxy keeps `removedCuratedIds` until `down`, and a fresh Chrome hides those cards before any click.

- **Open Queue.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive queue`. The card list contains Verify Reef and Verify Delta.
- **Score.** The first score control opens a breakdown panel. The panel is visible, not only present while `hidden`.
- **Sort.** The Score button gains the active class.
- **Remind and Shoot.** Remind shows pressed. Shoot shows a toast that contains `Shoot logged`.
- **Mine filter.** The empty state names your targets. All brings the cards back.
- **Keepsake.** The keepsake button reveals Verify Keepsake.
- **Hide one card.** Hide on the Verify Delta card removes that card. Verify Reef stays. `#empty` stays hidden. `removedCuratedIds` in `opd-profile-anil` contains `verify-delta`. The same list is what Upcoming and the map pins read. This step does not open a second Chrome. Upcoming's fresh-profile check is for Verify Mesa, the card that step hides.
- **Hide the last card.** Hide on the remaining Verify Reef card removes it. On that same click, `#cards` has no children and `#empty` is visible. Its text contains `No passes in the next 90 minutes.` The mine-filter sentence and the stale-manifest hint are different copies. This step is on All, with a fresh manifest, so the default sentence is the one on screen. The script reads `#empty` in the same evaluation as the click, before `renderQueue` runs again. It scrolls the remaining card into view for `queue-hide.png`, and scrolls `#empty` into view for `queue-empty.png`, because the launch notice can push that line below a phone viewport. It waits until `GET /api/browser/profiles/anil/targets` contains both `verify-delta` and `verify-reef`, then opens Profile and presses Restore on Verify Reef. Verify Reef returns to the queue and `#empty` hides again. Verify Delta stays hidden, so the map step can still hide the Reef pin.
- **Proof.** `evidence/queue.png`, `evidence/queue-score.png`, `evidence/queue-shoot.png`, `evidence/queue-mine.png`, `evidence/queue-keepsake.png`, `evidence/queue-hide.png` (one card left, `#empty` hidden), and `evidence/queue-empty.png` (`#empty` visible).

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- Shoot on a stale manifest is disabled. `up` stamps `generated_at` 30 seconds before it starts, and a reused `up` does not rebuild that stamp. `doctor` fails about 13 minutes after `up`, while the manifest is still under the 60-minute Shoot gate.
- The mine filter matches personal targets. The fixture cards are shared, and an added personal target has no pass in this fixture, so Mine stays empty.
- Forecast cards in Upcoming do not have Shoot. Shoot lives on Queue.
- Hide on Queue and Hide on Upcoming write the same `removedCuratedIds` list. The proxy keeps that list until `down`. `drive upcoming` reloads the same Chrome, then opens a new Chrome profile and checks that Verify Mesa is already gone. It does not check Verify Delta.
- `#empty` after the last Hide is the Queue empty state. `handleHideAction` removes the card and, when `#cards` has no children, calls `showQueueEmpty` before the profile PUT. A later `renderQueue` is not what first paints it. Hiding one card while another remains does not call `showQueueEmpty`.
- The script restores Verify Reef after the empty proof. A later `drive map` on this proxy still finds that pin. Verify Delta stays removed.
