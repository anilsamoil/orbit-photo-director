# Top bar

The top bar is one fixed header on every tab. Wider than 700px, identity, the ISS readout, the Kp badge, the username, and the six tabs stay on one scrolling row. At 700px and below, with enough height for two rows, the tabs sit on their own scrolling row and the ISS readout, Kp badge, sun thumbnail, and username sit behind the Status button. A short window (520px tall or less) keeps one compact row and hides that readout. The sun thumbnail appears only when the NASA image loads. The chips do not cover the tabs.

## Sub-features

- `iss-now` fills `#iss-now` from the published track. The text starts with `ISS` and the latitude, with no space between the label and the number, then the longitude, as in `ISS15.4°S, 118.3°E`. A span after that reads `over` plus a coarse region (hidden at 500px and narrower; the text stays in the node). Its title is `Live ISS sub-point from SGP4, or the polynomial fit when SGP4 has no position`. When the track has no position, the label `ISS` is immediately followed by `live track expired`, so the text is `ISSlive track expired`. That text does not pass. The stale-orbit sentence is on Profile photo lookup, not here.
- `kp-badge` shows `Kp 3.0` from the fixture `/api/kp` value `3`.
- `topbar-box` keeps the same fixed box on Map, Queue, Upcoming, ISS view, Profile, and Log. Non-map pages pad `main` by the bar height. Map padding is 0.
- `topbar-tabs` keeps Queue, Upcoming, Map, ISS view, Profile, and Log at their full width. Wider than 700px, the one row scrolls when those tabs and the readout do not fit. At 700px and below, with room for two rows, `.tabs` scrolls on its own. The Kp badge and the username sit in the Status readout, not in that tab row. After a scroller brings a control into view, `elementFromPoint` at its center is that control.
- `sun-badge` stays hidden when the NASA sun image does not load.

## How to get to it (user POV)

- Open the app. The bar is stuck to the top. On Map the globe runs under it. On Queue the first heading starts below it.
- Wider than 700px, the row does not wrap. The ISS readout and the Kp chip sit in the left half. A drag on either one that moves at least 8px pans the bar. A tap still activates the chip or the tab under the finger.
- On a phone, tap Status to open the readout. Swipe the tab row to reach Queue, Upcoming, Map, ISS view, Profile, and Log. A short landscape window hides Status and the readout so the map keeps a single compact header.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Read the header.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive topbar`. The bar is `position: fixed`. `#iss-now` starts with `ISS` plus a latitude, and its title is the SGP4 sentence above. `#kp-widget` reads `Kp 3.0`. Stdout prints the full readout, longitude and region included.
- **Other tabs.** Queue pads `main` by the bar height, and the footer is no longer pinned.
- **Narrow window.** The drive sets the badge text to `👤 anilsamoilenko-astro` and checks 402x874, 874x402, 390x844, 844x390, and 834x1194. On the 402x874 and 390x844 frames it opens Status, then scrolls `.tabs` until each tab is fully inside that row. The Kp badge and the username chip are fully inside the open readout, each at least 44px, and `elementFromPoint` at the center is that control. Those two frames require `.tabs` `scrollWidth` greater than `clientWidth`. A drag on Queue in the left half of `.tabs` pans that row by the overflow. Queue is already the open view. A click on Queue stays there, and a click on Upcoming switches the view. The 874x402 and 844x390 frames are one compact row: Status, the readout, and the username are hidden, and each visible tab is fully inside `.tabs`. On the 834x1194 frame the single row scrolls (`.topbar` `scrollWidth` greater than `clientWidth`). A drag on the Kp chip, then one on `#iss-now`, each in the left half, moves `.topbar.scrollLeft` by more than 40px. `evidence/topbar-pan-left.png` is that frame after both drags return to the start. The drive then restores the badge text to `👤 Anil`.
- **Safe area.** When the browser accepts an inset override, left, right, and top padding on the bar include that inset.
- **Proof.** `evidence/topbar.png` is Map. `evidence/topbar-queue.png` is Queue. `evidence/topbar-iphone-17-pro.png`, `evidence/topbar-iphone-17-pro-land.png`, `evidence/topbar-iphone-13.png`, `evidence/topbar-iphone-13-land.png`, and `evidence/topbar-ipad.png` are the long-name frames. Stdout reports whether the sun badge stayed hidden.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- Kp is the fixture value 3, drawn to one decimal as `Kp 3.0`, not a live SWPC fetch.
- A hidden sun badge is an egress miss, not a failed drive, as long as stdout says `sun hidden=true` or the badge is actually visible. At 430px and narrower the stylesheet also hides `.sun-badge`, so the phone frames can omit the sun after stdout reported `sun hidden=false`.
- `drive phone` checks the 44px tab target and the top safe-area padding, and opens Status before measuring the Kp badge. This drive also requires 44px on each top-bar control it scrolls into view. It checks that the wide row scrolls from a drag on the left-half Kp chip and from a drag on the ISS readout, that the phone tab row scrolls from a drag on Queue, and that each control receives the tap.
