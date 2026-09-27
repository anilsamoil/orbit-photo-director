# Phone

Phone is the same SNAP page at an iPhone size. Portrait is 390x844. Landscape is 844x390. The other drives stay at 1400x900 except for the narrow tab-strip check in `drive topbar`.

## Sub-features

- `phone-targets` checks that a tab, the Kp badge, the ? button, and the collapsed (i) button are at least 44px in portrait.
- `phone-dock` checks that the right-hand control dock stays above the (i) button and the ? button in landscape while the credits are collapsed, and that the dock scrolls. It then opens the credits in portrait and in landscape and checks that the dock stays above the ? button and the credit line, with 44px targets.
- `phone-press` long-presses a whole-degree point. The pass popup stays open through the click that follows the finger lift. A later click on that same pin dismisses it.
- `phone-inset` sets a safe-area inset when Chrome accepts the emulation override. The top bar's top padding then includes that inset.

## How to get to it (user POV)

- Open the Map tab on a phone. The dock is on the right. The ? button and the (i) credits sit at the bottom right. The dock stops above both while the credits are collapsed and while they are expanded.
- Press and hold the map to drop a pin. The popup stays up when the finger lifts.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Portrait.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive phone`. The viewport is 390x844. A tab, `#kp-widget`, `.help-fab`, and `.maplibregl-ctrl-attrib-button` are each at least 44px wide and tall.
- **Landscape.** The viewport is 844x390. The dock's bottom edge is above the ? button and the (i) button. The dock's `scrollHeight` is greater than its `clientHeight`. A dock button is at least 44px.
- **Expanded credits.** In portrait, and again in landscape, the script opens the credit line. The dock's bottom edge stays above the ? button and the credit line. The ? button and a dock button stay at least 44px. The script collapses the credits again before the long press.
- **Long press.** Follow is off. The press point is the reef latitude and longitude plus 30 degrees, rounded to whole degrees, at zoom 4. A touch held there opens a popup whose text contains `Closest`. A click at that point just after the finger lift leaves the popup open. A click after the ignore window removes it. The window is 700ms from the drop, not from the lift.
- **Proof.** `evidence/phone-portrait.png`, `evidence/phone-portrait-credits.png`, `evidence/phone-landscape.png`, `evidence/phone-landscape-credits.png`, and `evidence/phone-long-press.png`. Stdout says `safe-area applied` or `safe-area unsupported`.

## Gotchas

- `drive all` runs this after Log. The script restores the 1400x900 viewport before it returns.
- Safe-area insets stay zero unless Chrome accepts `Emulation.setSafeAreaInsetsOverride`. `safe-area unsupported` is a completed drive. The 44px and dock checks still run.
- `drive map` right-clicks to open a pass popup. The ignore window is armed for this long press. Hold the touch for longer than 500ms before the finger lifts.
- The verify fixture has no `anils-targets` pass. This drive does not look for those pins.
