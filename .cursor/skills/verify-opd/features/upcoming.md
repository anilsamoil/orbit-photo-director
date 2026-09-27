# Upcoming

Upcoming lists later passes. The pane title starts with Next 36 hours. The fixture puts Verify Mesa about eight hours ahead.

## Sub-features

- `upcoming-card` shows Verify Mesa.
- `upcoming-sort` selects Score.
- `upcoming-hide` removes that card and keeps it removed after a re-render and a reload.

## How to get to it (user POV)

- Choose the Upcoming tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Open Upcoming.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive upcoming`. The list contains Verify Mesa.
- **Sort.** The Score button gains the active class.
- **Hide.** The Hide control removes Verify Mesa from the list. Time sort paints the list again and the card stays gone. `removedCuratedIds` in localStorage `opd-profile-anil` contains `verify-mesa`.
- **Reload.** The script reloads the page and opens Upcoming again. Verify Mesa stays gone, and the same id is still in `removedCuratedIds`.
- **Proof.** `evidence/upcoming.png` shows the card. `evidence/upcoming-hidden.png` shows it gone. `evidence/upcoming-reloaded.png` shows it still gone.

## Gotchas

- Hide writes the target id into `removedCuratedIds` on `opd-profile-anil` and PUTs the list to the profile API. Queue, Upcoming, and the map pins all drop that id on the next paint. The fixture feed still contains Verify Mesa. A new browser that loads after the PUT gets the list from the profile GET and hides it too.
- The next drive deletes the Chrome profile first, so the card is visible again and the script hides it again.
- `drive all` hides Verify Mesa here, after Queue has already hidden Verify Delta. Both stay hidden for the rest of that page, including the reload in this drive. Profile later restores Verify Mesa.
