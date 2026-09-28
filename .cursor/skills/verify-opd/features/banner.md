# Status banner

The footer tells you whether the shot queue data is current. After a healthy load it leaves the word Loading.

## Sub-features

- `banner-ready` replaces Loading with an update age once the manifest arrives.
- `banner-blocked` is the red sign-in footer. A session that is not ok, or a redirect, says `Please sign in again to open your own profile. Your saved data has been kept.` A 200 body whose `ok` is not true says `Could not verify your profile. Please reload when connected.` The Chrome pass uses the signed-in Anil fixture, so `drive banner` shows neither sentence. The WebKit pass at the end of every drive sets `opd-verify-session=deny` and requires the footer Sign in link and Reload button.

## How to get to it (user POV)

- Open the app. The banner is the footer on every tab. On Map it is pinned to the bottom of the viewport. On the other tabs it stays in normal flow under the page.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Read the footer.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive banner`. The footer contains `Last updated`, it does not contain a sign-in sentence, and on Map its position is `fixed`.
- **Proof.** The command writes `evidence/banner.png`. The PNG shows the footer and the SNAP title. The same command then writes the WebKit device shots named in the skill. On the denied session, Sign in and Reload are on the footer, a tap hits that control, and Sign in or Reload navigates to `/api/app` without clearing `opd-calib-queue`.

## Gotchas

- A red sign-in footer during the Chrome pass means `/api/browser/session` was not ok. A 200 body with `ok` not true uses the verify sentence instead. Fix the proxy before driving anything else. The denied WebKit pass is the one that is supposed to show Sign in and Reload.
- The banner can lag the cards by a moment. Wait until Loading is gone.
