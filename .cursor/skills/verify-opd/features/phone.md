# Phone

Phone checks the Map page at 390x844 portrait, then 844x390 landscape. Desktop Chrome sets those sizes. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same checks, and this drive sets those sizes again on each device. `drive topbar` checks 402x874, 874x402, 390x844, 844x390, and 834x1194, then restores the surface size. `drive tracked` with `OPD_VERIFY_TRACKED=elements` also frames 1400x900, 1024x768, and 390x844, then restores the surface size.

## Sub-features

- `phone-targets` checks that a tab, the Kp badge, the ? button, and the collapsed (i) button are at least 44px in portrait.
- `phone-dock` opens the credits in portrait and requires the dock to stay above the ? button and the open credit line. Landscape with credits collapsed requires the dock above the ? button and the (i) button, a scrolling dock, and a dock button of at least 44px. Landscape with credits open repeats the clearance check and requires 44px on the ? button and a dock button.
- `phone-press` long-presses a whole-degree point. The pass popup stays open through the click that follows the finger lift. A later click on that same pin dismisses it.
- `phone-inset` sets a safe-area inset when Chrome accepts the emulation override. The top bar's top padding then includes that inset.

## How to get to it (user POV)

- Open the Map tab on a phone. A fresh profile, or any stored value other than `shown`, leaves the map clear except for the bottom-center `Controls` button, the top bar, and the status footer. A device that already stored `opd-map-chrome` as `shown` opens on `Hide` with the chrome up. Tap `Controls` and the dock, the ? button, and the (i) credits come back. The dock stops above both while the credits are collapsed and while they are expanded. Tap `Hide` and those controls leave again.
- Press and hold the map to drop a pin. The popup stays up when the finger lifts.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Portrait.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive phone`. The viewport is 390x844. If chrome is already shown, the script taps `Hide` first. `#map-chrome-toggle` reads `Controls` and is at least 44px, the toolbar is `display: none`, and the footer and Map tab stay up. `evidence/phone-chrome-hidden.png` is that frame. The script taps `Controls`. A tab, `#kp-widget`, `.help-fab`, and `.maplibregl-ctrl-attrib-button` are each at least 44px wide and tall. The script then opens the credit line. The dock's bottom edge stays above the ? button and the credit line.
- **Landscape.** The viewport is 844x390 and the credits are collapsed. The dock's bottom edge is above the ? button and the (i) button. The dock's `scrollHeight` is greater than its `clientHeight`. A dock button is at least 44px. The script then opens the credit line again and repeats the clearance check, including 44px on the ? button and a dock button. It collapses the credits before the long press.
- **Long press.** Follow is off. The press point is the reef latitude, and the reef longitude plus 30 degrees, both rounded to whole degrees, at zoom 4. A touch held there opens a popup whose text contains `Closest`. The script waits for that text, up to 5 seconds, with the finger still down. A click at that point just after the finger lift leaves the popup open. A click after the ignore window removes it. The window is 700ms from the drop, not from the lift.
- **Proof.** `evidence/phone-chrome-hidden.png`, `evidence/phone-portrait.png`, `evidence/phone-portrait-credits.png`, `evidence/phone-landscape.png`, `evidence/phone-landscape-credits.png`, and `evidence/phone-long-press.png`. Stdout says `safe-area applied` or `safe-area unsupported`.

Desktop Chrome runs the 390x844 and 844x390 viewports first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run those same viewport checks. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- `drive all` runs this after Log. The script restores the surface size before it returns. On desktop that size is 1400x900. On a WebKit device it is that device's viewport.
- Safe-area insets stay zero unless Chrome accepts `Emulation.setSafeAreaInsetsOverride`. `safe-area unsupported` is a completed drive. The 44px and dock checks still run.
- `drive map` right-clicks to open a pass popup. The ignore window is armed for this long press. Hold the touch for longer than 500ms before the finger lifts.
- The verify fixture has no `anils-targets` pass. This drive does not look for those pins.
- The WebKit pass after these checks opens a denied session. That footer says `Please sign in again` and shows Sign in and Reload. `init` returns before the countdown. The held footer that `drive banner` checks starts with `SIGN IN AGAIN`. That drive waits out a countdown tick and a failed refresh, then clicks the footer through to `/api/app`.
