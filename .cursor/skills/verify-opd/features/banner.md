# Status banner

The footer tells you whether the shot queue data is current. After a healthy load it leaves the word Loading.

## Sub-features

- `banner-ready` replaces Loading with an update age once the manifest arrives.
- `banner-blocked` is a red footer. A session that is not ok, or a redirect, says `Please sign in again to open your own profile. Your saved data has been kept.` A 200 body whose `ok` is not true says `Could not verify your profile. Please reload when connected.` This proxy always returns Anil, so `drive banner` shows neither sentence.

## How to get to it (user POV)

- Open the app. The banner is the footer on every tab. On Map it is pinned to the bottom of the viewport. On the other tabs it stays in normal flow under the page.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Read the footer.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive banner`. The footer contains `Last updated`, it does not contain a sign-in sentence, and on Map its position is `fixed`.
- **Proof.** The command writes `evidence/banner.png`. The PNG shows the footer and the SNAP title.

## Gotchas

- A red sign-in footer means `/api/browser/session` was not ok. A 200 body with `ok` not true uses the verify sentence instead. Fix the proxy before driving anything else.
- The banner can lag the cards by a moment. Wait until Loading is gone.
