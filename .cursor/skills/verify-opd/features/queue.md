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
- `queue-hide` hides Verify Delta and stores `verify-delta` in `removedCuratedIds` on `opd-profile-anil`. Verify Reef stays, and `#empty` stays hidden.
- `queue-empty` hides Verify Reef, the last card. That click shows `#empty` with `No passes in the next 90 minutes.` The script then restores Verify Reef and reloads, and leaves Verify Delta hidden.

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
- **Hide.** Hide on the Verify Delta card removes that card. `removedCuratedIds` in `opd-profile-anil` contains `verify-delta`. The same list is what Upcoming and the map pins read. The script waits until `GET /api/browser/profiles/anil/targets` contains `verify-delta`. Verify Reef is still in `#cards`. `#empty` stays hidden. This step does not open a second Chrome. Upcoming's fresh-profile check is for Verify Mesa, the card that step hides.
- **Last card.** Hide on Verify Reef removes the last card. On that click `#empty` is shown and its text is `No passes in the next 90 minutes.` The script scrolls `#empty` into view, requires the element inside the viewport, and writes `evidence/queue-empty.png`. A shot that does not contain that sentence does not pass. The launch-coverage notice above the cards can push `#empty` below a phone viewport. The script then puts Verify Reef back: `opd-profile-anil` and `PUT /api/browser/profiles/anil/targets` drop `verify-reef` and keep `verify-delta`, the page reloads, and Verify Reef is in `#cards` again with `#empty` hidden. The map step hides that pin itself.
- **Proof.** `evidence/queue.png`, `evidence/queue-score.png`, `evidence/queue-shoot.png`, `evidence/queue-mine.png`, `evidence/queue-keepsake.png`, `evidence/queue-hide.png`, and `evidence/queue-empty.png`.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- Shoot on a stale manifest is disabled. `up` stamps `generated_at` 30 seconds before it starts, and a reused `up` does not rebuild that stamp. `doctor` fails about 13 minutes after `up`, while the manifest is still under the 60-minute Shoot gate.
- The mine filter matches personal targets. The fixture cards are shared, and an added personal target has no pass in this fixture, so Mine stays empty.
- Forecast cards in Upcoming do not have Shoot. Shoot lives on Queue.
- Hide on Queue and Hide on Upcoming write the same `removedCuratedIds` list. The proxy keeps that list until `down`. `drive upcoming` reloads the same Chrome, then opens a new Chrome profile and checks that Verify Mesa is already gone. It does not check Verify Delta.
- The last-card empty state is `showQueueEmpty` from `handleHideAction` in `frontend/src/main.ts`. Hiding one card while another remains leaves `#empty` hidden because the queue host still has a child. The default sentence is `No passes in the next 90 minutes.` Mine and a stale manifest use different sentences. This drive is on All with a fresh manifest.
- `queue-empty.png` is taken before Verify Reef is restored. Restoring Reef is what lets the later map step find that pin and hide it. Delta stays hidden.
