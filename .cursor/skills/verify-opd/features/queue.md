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
- `queue-hide` hides Verify Delta and stores `verify-delta` in `removedCuratedIds` on `opd-profile-anil`.

## How to get to it (user POV)

- Choose the Queue tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The manifest `generated_at` is under 60 minutes old, or Shoot stays disabled.

- **Open Queue.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive queue`. The card list contains Verify Reef and Verify Delta.
- **Score.** The first score control opens a breakdown panel. The panel is visible, not only present while `hidden`.
- **Sort.** The Score button gains the active class.
- **Remind and Shoot.** Remind shows pressed. Shoot shows a toast that contains `Shoot logged`.
- **Mine filter.** The empty state names your targets. All brings the cards back.
- **Keepsake.** The keepsake button reveals Verify Keepsake.
- **Hide.** Hide on the Verify Delta card removes that card. `removedCuratedIds` in `opd-profile-anil` contains `verify-delta`. The same list is what Upcoming and the map pins read.
- **Proof.** `evidence/queue.png`, `evidence/queue-score.png`, `evidence/queue-shoot.png`, `evidence/queue-mine.png`, `evidence/queue-keepsake.png`, and `evidence/queue-hide.png`.

## Gotchas

- Shoot on a stale manifest is disabled. `up` stamps the manifest a few seconds before the drive.
- The mine filter matches personal targets. The fixture cards are shared, so Mine is empty until you add one.
- Forecast cards in Upcoming do not have Shoot. Shoot lives on Queue.
- Hide on Queue and Hide on Upcoming write the same `removedCuratedIds` list. `drive upcoming` reloads the page and proves the id is still there. This drive checks the write before it returns.
