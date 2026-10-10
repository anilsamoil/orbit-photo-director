# Phone

Phone checks the Map page at 390x844 portrait, then 844x390 landscape. Desktop Chrome sets those sizes. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same checks, and this drive sets those sizes again on each device. `drive topbar` checks 402x874, 874x402, 390x844, 844x390, and 834x1194, then restores the surface size. `drive tracked` with `OPD_VERIFY_TRACKED=elements` also frames 1400x900, 1024x768, and 390x844, then restores the surface size.

## Sub-features

- `phone-targets` checks that a tab and the Kp badge are at least 44px in portrait. The map ? button and the (i) credit button are not shown.
- `phone-dock` checks a scrolling dock in landscape and a dock button of at least 44px. `#map-chrome-toggle` stays 88 by 44, 12px from the right of `#map-pane`, when the chrome hides and shows.
- `phone-press` long-presses a whole-degree point. The pass popup stays open through the click that follows the finger lift. A later click on that same pin dismisses it.
- `phone-inset` sets a safe-area inset when Chrome accepts the emulation override. The top bar's top padding then includes that inset.

## How to get to it (user POV)

- Open the Map tab on a phone. A fresh profile, or any stored value other than `shown`, leaves the map clear except for the bottom-right `Controls` button, the top bar, and the status footer. A device that already stored `opd-map-chrome` as `shown` opens on `Hide` with the chrome up. Tap `Controls` and the dock comes back. The map ? button and the (i) credit button stay off. Tap `Hide` and the button stays in that same spot.
- Press and hold the map to drop a pin. The popup stays up when the finger lifts.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Portrait.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive phone`. The viewport is 390x844. If chrome is already shown, the script taps `Hide` first. `#map-chrome-toggle` reads `Controls`, is 88px wide and 44px tall, and sits 12px from the right of `#map-pane`. The Show toolbar and the Time strip are `display: none`, and the footer and Map tab stay up. `evidence/phone-chrome-hidden.png` is that frame. The script taps `Controls`, then Status, and waits until `#kp-widget` is visible. A tab and `#kp-widget` are each at least 44px wide and tall. The map ? button and the (i) credit button are not shown. Hiding and showing the chrome leaves `#map-chrome-toggle` in the same place, still 88 by 44 and 12px from the right.
- **Landscape.** The viewport is 844x390. The map ? button and the (i) credit button stay hidden. The dock's `scrollHeight` is greater than its `clientHeight`. A dock button is at least 44px.
- **Long press.** Follow is off. The press point is the reef latitude, and the reef longitude plus 30 degrees, both rounded to whole degrees, at zoom 4. A touch held there opens a popup whose text contains `Closest`. A capture listener on the canvas container calls `preventDefault` on `touchstart`. The script waits for that text, up to 5 seconds, with the finger still down. If the popup is not up, it lifts the finger, releases the mouse button, and presses once more for another 5 seconds. A click at that point just after the finger lift leaves the popup open. After the ignore window, a click on the dropped pin removes it. Popups are closed before the press, so the inspector is not open. That screen point is the dropped pin, because whole-degree snapping can leave the pin off the press coordinate. The point is on the MapLibre canvas. The window is 700ms from the drop, not from the lift. The portrait pin-drop while the inspector is open, including on iPhone 13, is `drive map`. This long press runs in the 844x390 frame.
- **Proof.** `evidence/phone-chrome-hidden.png`, `evidence/phone-portrait.png`, `evidence/phone-landscape.png`, and `evidence/phone-long-press.png`. Stdout says `safe-area applied` or `safe-area unsupported`.

Desktop Chrome runs the 390x844 and 844x390 viewports first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run those same viewport checks. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- `drive all` runs this after Log. The script restores the surface size before it returns. On desktop that size is 1400x900. On a WebKit device it is that device's viewport.
- Safe-area insets stay zero unless Chrome accepts `Emulation.setSafeAreaInsetsOverride`. `safe-area unsupported` is a completed drive. The 44px and dock checks still run.
- `drive map` right-clicks to open a pass popup. The ignore window is armed for this long press. Hold the touch for longer than 500ms before the finger lifts. The press point unwraps toward the map center the same way the map clicks do.
- The verify fixture has no `anils-targets` pass. This drive does not look for those pins.
- The WebKit pass after these checks opens a denied session. That footer says `Please sign in again` and shows Sign in and Reload. `init` returns before the countdown. The held footer that `drive banner` checks starts with `SIGN IN AGAIN`. That drive waits out a countdown tick and a failed refresh, then clicks the footer through to `/api/app`.
- `OPD_VERIFY_VIEWPORT=874x402` with `OPD_VERIFY_SURFACE=iphone-17-pro` starts that WebKit process at 874 by 402. `drive phone` then sets 390 by 844. WebKit keeps the layout viewport on the context size until the viewport meta names the new width and height. The harness then restores `width=device-width` when that original meta still yields the requested size, so Status is shown and `#kp-widget` is at least 44 by 44. The 402 by 874 start does the same.
