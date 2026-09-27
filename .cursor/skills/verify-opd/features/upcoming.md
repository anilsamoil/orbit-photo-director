# Upcoming

Upcoming lists passes beyond the next 90 minutes. The fixture puts Verify Mesa about eight hours ahead.

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

- Hide writes the curated id into this Chrome profile. Every drive deletes that profile before Chrome starts, so the next `drive upcoming` shows Verify Mesa again and then hides it.
- `drive all` hides the card inside that one page. The screenshot `upcoming-hidden.png` is the proof. The following drive starts from a visible card.
