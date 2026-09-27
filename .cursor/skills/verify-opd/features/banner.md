# Status banner

The footer tells you whether the shot queue data is current. After a healthy load it leaves the word Loading.

## Sub-features

- `banner-ready` replaces Loading with an update age once the manifest arrives.
- `banner-blocked` is the red sign-in footer. It needs a session response that is not ok. This proxy always returns Anil, so `drive banner` does not show that footer.

## How to get to it (user POV)

- Open the app. The banner is the footer on every tab. On Map it is pinned to the bottom of the viewport. On the other tabs it stays in normal flow under the page.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Read the footer.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive banner`. The footer contains `Last updated`, it does not contain a sign-in sentence, and on Map its position is `fixed`.
- **Proof.** The command writes `evidence/banner.png`. The PNG shows the footer and the SNAP title.

## Gotchas

- A red sign-in footer means `/api/browser/session` did not return the Anil fixture. Fix the proxy before driving anything else.
- The banner can lag the cards by a moment. Wait until Loading is gone.
