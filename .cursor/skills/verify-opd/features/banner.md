# Status banner

The footer tells you whether the shot queue data is current. After a healthy load the word Loading is replaced by the update age.

## Sub-features

- `banner-ready` replaces Loading with an update age once the manifest arrives.
- `banner-blocked` is the red sign-in footer. A redirect, a 401, a 403, or another HTTP error says `Please sign in again to open your own profile. Your saved data has been kept.` and adds Sign in and Reload. A 200 HTML page that does not contain `id="status-banner"` does the same. A non-JSON 404, or a 200 HTML body that contains that id, is a local copy. The app opens the `?u=` profile (`anil` when `u` is missing) and the footer has no Sign in link. A 200 JSON body whose `ok` is not true says `Could not verify your profile. Please reload when connected.` A failed fetch with no saved session paints the error in red and does not add Sign in or Reload. The Chrome pass uses the signed-in Anil fixture, so `drive banner` shows neither sentence. The WebKit pass at the end of every drive sets `opd-verify-session=deny` and requires the footer Sign in link and Reload button. `init` returns on that footer, so the one-second countdown never starts.
- `banner-held` is the footer after a signed-in load when the manifest is at least 150 minutes old and `GET /api/app` redirects. The text starts with `SIGN IN AGAIN` and ends with `Tap here.` There is no Sign in link and no Reload button. A click on the footer goes to `/api/app`, keeping `?u=` when a profile name is present. `setBanner` returns while that footer is up. The one-second countdown does not replace it with `STALE`. A failed refresh does not replace it with `LOS`. The click stays on the footer.

## How to get to it (user POV)

- Open the app. The banner is the footer on every tab. On Map it is pinned to the bottom of the viewport. On Queue, Upcoming, Profile, and Log the pane scrolls and the footer stays at the bottom of the window. Its position is `static`.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.

- **Read the footer.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive banner`. The footer contains `Last updated`, it does not contain a sign-in sentence, and on Map its position is `fixed`. The script then opens Queue and requires that position to be `static`.
- **Held sign-in.** The script sets the cookie `opd-verify-session=expired` and reloads. The proxy serves that manifest with `generated_at` 200 minutes ago and answers `GET /api/app` with a redirect. The footer starts with `SIGN IN AGAIN` and ends with `Tap here.` The script waits past one countdown tick. The footer text is the same sentence. It then rejects the next manifest fetch and fires `visibilitychange`, the resume the page already runs when you return to the tab. The footer text is still that sentence. A click on `#status-banner` opens `/api/app` with `u=anil`. The script clears the cookie and reloads the signed-in app before it returns.
- **Proof.** The command writes `evidence/banner.png` and `evidence/banner-hold.png`. `banner.png` shows the age footer and the SNAP title. `banner-hold.png` shows the `SIGN IN AGAIN` footer before the click. The same command then writes the WebKit device shots named in the skill, including `banner-hold.png` in each device directory. On the denied session, Sign in and Reload are on the footer, a tap hits that control, and Sign in or Reload navigates to `/api/app`, keeping `?u=` when the page has it, without clearing `opd-calib-queue`.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`. The denied footer shot is `banner-auth.png` in each of those directories.

## Gotchas

- A red sign-in footer during the Chrome pass, before the held-sign-in reload, means `/api/browser/session` was not ok. A 200 body with `ok` not true uses the verify sentence instead. Fix the proxy before driving anything else. The denied WebKit pass is the one that is supposed to show Sign in and Reload.
- The boot deny footer and the `SIGN IN AGAIN` footer are different holds. The boot footer has Sign in and Reload, and `init` returns before the countdown. The `SIGN IN AGAIN` footer is the one a countdown tick and a failed refresh must leave alone. `opd-verify-session=expired` is only for that second footer. `drive all` clears it before the next feature.
- The banner can lag the cards by a moment. Wait until Loading is gone.
