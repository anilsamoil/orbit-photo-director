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
- **Hide.** Hide on the Verify Delta card removes that card. `removedCuratedIds` in `opd-profile-anil` contains `verify-delta`. The same list is what Upcoming and the map pins read. The script waits until `GET /api/browser/profiles/anil/targets` contains `verify-delta`. The fresh-profile check is the upcoming step.
- **Proof.** `evidence/queue.png`, `evidence/queue-score.png`, `evidence/queue-shoot.png`, `evidence/queue-mine.png`, `evidence/queue-keepsake.png`, and `evidence/queue-hide.png`.

## Gotchas

- Shoot on a stale manifest is disabled. `up` stamps the manifest a few seconds before the drive.
- The mine filter matches personal targets. The fixture cards are shared, and an added personal target has no pass in this fixture, so Mine stays empty.
- Forecast cards in Upcoming do not have Shoot. Shoot lives on Queue.
- Hide on Queue and Hide on Upcoming write the same `removedCuratedIds` list. The proxy keeps that list until `down`. `drive upcoming` reloads the same Chrome, then opens a new Chrome profile and checks that the hidden card is already gone.
