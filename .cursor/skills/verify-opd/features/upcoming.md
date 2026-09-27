# Upcoming

Upcoming lists later passes. The pane title starts with Next 36 hours. The fixture puts Verify Mesa about eight hours ahead.

## Sub-features

- `upcoming-card` shows Verify Mesa.
- `upcoming-sort` selects Score.
- `upcoming-hide` removes that card.

## How to get to it (user POV)

- Choose the Upcoming tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Open Upcoming.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive upcoming`. The list contains Verify Mesa.
- **Sort.** The Score button gains the active class.
- **Hide.** The Hide control removes Verify Mesa from the list.
- **Proof.** `evidence/upcoming.png` shows the card. `evidence/upcoming-hidden.png` shows it gone.

## Gotchas

- Hide removes the card from the list for this page. The fixture feed still contains Verify Mesa. The next drive deletes the Chrome profile first, so the card is visible again and the script hides it again.
- `drive all` hides the card inside that one page. The screenshot `upcoming-hidden.png` is the proof. The following drive starts from a visible card.
