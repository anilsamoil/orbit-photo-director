# Top bar

The top bar is one fixed header on every tab. It shows where the station is and the current Kp index. The sun thumbnail appears only when the NASA image loads. The username chip, the Kp badge, and the five tabs stay on one line. When that line is wider than the screen, the bar scrolls sideways. The chips do not cover the tabs.

## Sub-features

- `iss-now` fills `#iss-now` from the published track. The text starts with `ISS` and the latitude, with no space between the label and the number, as in `ISS15.4°S`. Its title is `Live ISS sub-point from SGP4, or the polynomial fit when SGP4 has no position`. When the track has no position, the label `ISS` is immediately followed by `live track expired`, so the text is `ISSlive track expired`. That text does not pass. The stale-orbit sentence is on Profile photo lookup, not here.
- `kp-badge` shows `Kp 3.0` from the fixture `/api/kp` value `3`.
- `topbar-box` keeps the same fixed box on Map, Queue, Upcoming, Profile, and Log. Non-map pages pad `main` by the bar height. Map padding is 0.
- `topbar-tabs` keeps Queue, Upcoming, Map, Profile, and Log at their full width. The bar scrolls when those buttons, the Kp badge, and a long username do not fit. After the bar scrolls a control into view, `elementFromPoint` at its center is that control.
- `sun-badge` stays hidden when the NASA sun image does not load.

## How to get to it (user POV)

- Open the app. The bar is stuck to the top. On Map the globe runs under it. On Queue the first heading starts below it.
- On a phone the row does not wrap. Swipe anywhere on the bar, including the username, the ISS readout, and the Kp chip on the left half, to reach a control that starts past the edge. The username and the Kp badge stay in the row. A drag that moves at least 8px pans the bar. A tap still activates the chip or the tab under the finger.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Read the header.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive topbar`. The bar is `position: fixed`. `#iss-now` matches `ISS` plus a latitude, and its title is the SGP4 sentence above. `#kp-widget` reads `Kp 3.0`. Stdout includes the readout.
- **Other tabs.** Queue pads `main` by the bar height, and the footer is no longer pinned.
- **Narrow window.** The drive sets the badge text to `👤 anilsamoilenko-astro` and checks 402x874, 874x402, 390x844, 844x390, and 834x1194. Each tab, the Kp badge, and the username chip is fully inside the bar after scrolling only `.topbar`, and `elementFromPoint` at its center is that control. At 402px wide the bar `scrollWidth` is greater than its `clientWidth`. On that frame a mouse drag that starts on the Kp chip, then one that starts on `#iss-now`, each in the left half of the bar, moves `.topbar.scrollLeft` by more than 40px. `evidence/topbar-pan-left.png` is the bar after both drags are returned to the start. A real click on Queue, then Upcoming, switches the view. The drive then restores the badge text to `👤 Anil`.
- **Safe area.** When the browser accepts an inset override, left, right, and top padding on the bar include that inset.
- **Proof.** `evidence/topbar.png` is Map. `evidence/topbar-queue.png` is Queue. `evidence/topbar-iphone-17-pro.png`, `evidence/topbar-iphone-17-pro-land.png`, `evidence/topbar-iphone-13.png`, `evidence/topbar-iphone-13-land.png`, and `evidence/topbar-ipad.png` are the long-name frames. Stdout reports whether the sun badge stayed hidden.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- Kp is the fixture value 3, drawn to one decimal as `Kp 3.0`, not a live SWPC fetch.
- A hidden sun badge is an egress miss, not a failed drive, as long as stdout says `sun hidden=true` or the badge is actually visible. At 430px and narrower the stylesheet also hides `.sun-badge`, so the phone frames can omit the sun after stdout reported `sun hidden=false`.
- `drive phone` checks the 44px tab target and the top safe-area padding. This drive checks that the bar scrolls from a drag on the left-half Kp chip and from a drag on the ISS readout, and that each control receives the tap.
