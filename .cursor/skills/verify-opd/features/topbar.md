# Top bar

The top bar is one fixed header on every tab. It shows where the station is and the current Kp index. The sun thumbnail appears only when the NASA image loads.

## Sub-features

- `iss-now` fills `#iss-now` from the track fixture.
- `kp-badge` shows `Kp 3.0` from the fixture `/api/kp` value `3`.
- `topbar-box` keeps the same fixed box on Map, Queue, Upcoming, Profile, and Log. Non-map pages pad `main` by the bar height. Map padding is 0.
- `topbar-tabs` scrolls the tab strip sideways when the labels are wider than the bar.
- `sun-badge` stays hidden when the NASA sun image does not load.

## How to get to it (user POV)

- Open the app. The bar is stuck to the top. On Map the globe runs under it. On Queue the first heading starts below it.
- On a narrow window the five tabs stay one line and the strip scrolls. The labels do not wrap.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Read the header.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive topbar`. The bar is `position: fixed`. `#iss-now` has text and `#kp-widget` reads `Kp 3.0`.
- **Other tabs.** Queue pads `main` by the bar height, and the footer is no longer pinned.
- **Narrow window.** At 390x800 the tab strip `scrollWidth` is wider than the strip.
- **Proof.** `evidence/topbar.png` is Map. `evidence/topbar-queue.png` is Queue. `evidence/topbar-narrow.png` is the phone width. Stdout reports whether the sun badge stayed hidden.

## Gotchas

- Kp is the fixture value 3, drawn to one decimal as `Kp 3.0`, not a live SWPC fetch.
- A hidden sun badge is an egress miss, not a failed drive, as long as stdout says `sun hidden=true` or the badge is actually visible.
- `drive phone` checks the 44px tab target and the top safe-area padding. This drive checks that the strip scrolls at 390x800.
