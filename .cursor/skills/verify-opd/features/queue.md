# Queue

Queue is the next passes to shoot. The fixture puts Verify Reef 20 minutes after the drive start and Verify Delta 50 minutes after it, so both cards sit inside the 90-minute queue and read a near-term time.

## Sub-features

- `queue-cards` shows both fixture passes.
- `queue-score` opens the score breakdown on the first card.
- `queue-sort` selects Score.
- `queue-remind` presses Remind and sets `aria-pressed` to true.
- `queue-shoot` logs Shoot and shows the toast.
- `queue-mine` shows the empty mine-filter message. Mine writes `opd_queue_filter_v1=mine` and the shared `opd_target_filter_v1=mine`. Upcoming and the map follow that shared key.
- `queue-launches` is the third filter. It is the only active queue filter, the shared cards leave, and All brings them back. One of All, Mine, and Launches is active. Launches writes `opd_queue_filter_v1=launches` and does not write `opd_target_filter_v1`.
- `queue-keepsake` opens the keepsake pane on Verify Keepsake.
- `queue-hide` hides Verify Delta and stores `verify-delta` in `removedCuratedIds` on `opd-profile-anil`. Verify Reef stays, and `#empty` stays hidden.
- `queue-empty` hides Verify Reef, the last card. That click shows `#empty` with `No passes in the next 90 minutes.` The script then restores Verify Reef and reloads, and leaves Verify Delta hidden.
- `queue-lightning` is the #346 chip (`74ce5a5`). `renderCard` in `frontend/src/card.ts` paints `.weather-lightning` only when `lightning_potential` is greater than 0.05. `glm-2m` with a positive flash rate shows `⚡ observed lightning flashes`. `gfs-cape`, and GLM with rate 0 (`glm-5m`), show `⚡ lightning forecast`. Potential 0, potential 0.05, and `glm-no-data` at potential 0 show no chip, and the card still renders. `glm-45m` with a positive rate shows `⚡ observed lightning flashes`. The age does not change that label to forecast.

## How to get to it (user POV)

- Choose the Queue tab.

## Driving it with opd-verify

Preconditions:

- `doctor` prints `ok`.
- The manifest `generated_at` is under 60 minutes old and `freshness.ok` is true, or Shoot stays disabled. `isStaleManifest` in `frontend/src/main.ts` is true when that age is at least 60 minutes or when `freshness.ok` is false.
- Each drive start, including desktop, PUTs `{ targets: [], removedCuratedIds: [] }` before the page loads. An earlier Hide does not hide the cards on the next drive. The profile reset does not rebuild pass times; each new `drive` separately restamps Reef and Delta from its captured start, including when `up` reused the instance.

- **Open Queue.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive queue`. The card list contains Verify Reef and Verify Delta.
- **Lightning chip.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive queue-lightning`. One process is one WebKit surface, and the Playwright context is created at that size. iPhone 17 Pro is `OPD_VERIFY_SURFACE=iphone-17-pro OPD_VERIFY_VIEWPORT=402x874`. iPad landscape is `OPD_VERIFY_SURFACE=ipad-pro-11 OPD_VERIFY_VIEWPORT=1210x834`. Desktop WebKit is `OPD_VERIFY_SURFACE=desktop OPD_VERIFY_VIEWPORT=1440x900`. Any other pair throws. `drive queue` and `drive all` leave it out. `queueSlots` in `frontend/src/launch-selectors.ts` keeps five ground cards, so the script writes at most five of these cards into that drive's private `top5.json`, checks them, then writes the rest and reloads the same context. It does not call `page.setViewportSize`. It does not rewrite `passes.json` or the home fixtures. Verify Reef and Verify Delta stay on the home fixtures, with no lightning fields. The Queue tab shows Verify GLM Fresh (`glm-2m`, rate 4) and Verify GLM Stale (`glm-45m`, rate 2) with `⚡ observed lightning flashes`. Verify GFS Cape (`gfs-cape`, rate 0) and Verify GLM Quiet (`glm-5m`, rate 0) show `⚡ lightning forecast`. Verify Potential Zero (potential 0), Verify Potential Floor (potential 0.05), and Verify GLM None (`glm-no-data`, potential 0) have no `.weather-lightning`, and each card name still renders. A chip's `scrollWidth` stays at most its `clientWidth`, its text rect stays inside the card and the viewport, and it does not overlap another `.tag` in that card. Stdout is `viewport queue-lightning surface <id> opened <WxH> now <WxH> created-at-size` and `queue lightning <id> observed 2 forecast 2 none 3`. Shots are `evidence/queue-lightning-<id>.png`.
- **Score.** The first score control opens a breakdown panel. The panel is visible, not only present while `hidden`.
- **Sort.** The Score button gains the active class.
- **Remind and Shoot.** Remind shows pressed. Shoot shows a toast that contains `Shoot logged`.
- **Mine filter.** The empty state names your targets. `opd_target_filter_v1` and `opd_queue_filter_v1` are both `mine`.
- **Launches filter.** Launches is the only active queue filter. Verify Reef and Verify Delta leave the card list. The empty state names launches, or the list is only the launch card. `opd_queue_filter_v1` is `launches`. `opd_target_filter_v1` stays `mine`. All is the only active filter again, both cards return, and both keys are `all`.
- **Keepsake.** The keepsake button reveals Verify Keepsake.
- **Hide.** Hide on the Verify Delta card removes that card. `removedCuratedIds` in `opd-profile-anil` contains `verify-delta`. The same list is what Upcoming and the map pins read. The script waits until `GET /api/browser/profiles/anil/targets` contains `verify-delta`. Verify Reef is still in `#cards`. `#empty` stays hidden. This step does not open a second Chrome. Upcoming's fresh-profile check is for Verify Mesa, the card that step hides.
- **Last card.** Hide on Verify Reef removes the last card. On that click `#empty` is shown and its text is `No passes in the next 90 minutes.` The script scrolls `#empty` into view, requires the element inside the viewport, and writes `evidence/queue-empty.png`. A shot that does not contain that sentence does not pass. The launch-coverage notice above the cards can push `#empty` below a phone viewport. The script then puts Verify Reef back: `opd-profile-anil` and `PUT /api/browser/profiles/anil/targets` drop `verify-reef` and keep `verify-delta`, the page reloads, and Verify Reef is in `#cards` again with `#empty` hidden. The map step hides that pin itself.
- **Proof.** `evidence/queue.png`, `evidence/queue-score.png`, `evidence/queue-shoot.png`, `evidence/queue-mine.png`, `evidence/queue-launches.png`, `evidence/queue-keepsake.png`, `evidence/queue-hide.png`, and `evidence/queue-empty.png`.

Desktop Chrome runs first. WebKit iPhone 13, iPhone 17 Pro, and iPad Pro 11 run the same steps. Their shots are `evidence/iphone-13/`, `evidence/iphone-17-pro/`, and `evidence/ipad-pro-11/`.

## Gotchas

- Shoot on a stale manifest is disabled, including when `freshness.ok` is false inside the 60-minute window. `up` stamps `generated_at` 30 seconds before it starts, and a reused `up` does not rebuild that stamp. A bare `doctor` fails about 13 minutes after `up`, while the manifest is still under the 60-minute Shoot gate.
- The queue lists a pass until its closest approach. The drive rewrites Verify Reef to 20 minutes after its captured start and Verify Delta to 50 minutes. The page clock is that start plus elapsed time, so the cards stay near-term for the drive. `resetFixtureProfile` clears hides and does not rebuild pass times. A new `drive` stamps the times again.
- The mine filter matches personal targets. The fixture cards are shared, and an added personal target has no pass in this fixture, so Mine stays empty. Mine writes the shared `opd_target_filter_v1=mine`, so Upcoming and the map follow Mine on purpose. Launches does not write that key. This drive clicks All after Launches, which sets both keys back to `all` before Hide.
- Forecast cards in Upcoming do not have Shoot. Shoot lives on Queue.
- Hide on Queue and Hide on Upcoming write the same `removedCuratedIds` list. Inside one drive the proxy keeps that list, and the next drive start clears it. `drive upcoming` reloads the same Chrome, then opens a new Chrome profile and checks that Verify Mesa is already gone. It does not check Verify Delta.
- A cold HTTP 401 still opens Queue. `#tab-queue` switches `#view` to `view-queue`, `#cards` stays empty, and `#tab-profile` stays `disabled` with `aria-disabled` `true`. `frontend/test/account-session.test.ts` is `a denied session keeps Queue and does not render or enable Profile` and `a cold session failure still switches to Queue`. `OPD_VERIFY_LOCK=queue node .cursor/skills/verify-opd/scripts/opd-verify.mjs drive session-lock` is one WebKit process. `OPD_VERIFY_SURFACE=iphone-17-pro OPD_VERIFY_VIEWPORT=402x874` and `OPD_VERIFY_SURFACE=ipad-pro-11 OPD_VERIFY_VIEWPORT=834x1210` are the two drives. The cookie is `opd-verify-session=deny`. Stdout is `session lock queue <id> view view-queue cards 0`. The shot is `evidence/session-lock-queue-<id>.png`. `drive queue` and `drive all` leave this probe out.
- The last-card empty state is `showQueueEmpty` from `handleHideAction` in `frontend/src/main.ts`. Hiding one card while another remains leaves `#empty` hidden because the queue host still has a child. The default sentence is `No passes in the next 90 minutes.` Mine and a stale manifest use different sentences. This drive is on All with a fresh manifest.
- `queue-empty.png` is taken before Verify Reef is restored. Restoring Reef is what lets the later map step find that pin and hide it. Delta stays hidden.
- Verify Reef and Verify Delta have no `lightning_potential`, so `drive queue` shows no lightning chip. `drive queue-lightning` replaces that drive's private `top5.json` with the chip cards. The queue shows five ground cards, so the second pair loads after a reload in the same context. The sampler publishes `glm-no-data` at potential 0, and the card gate is `lightning_potential > 0.05`, so that card renders with no chip. A GLM age suffix such as `glm-45m` stays observed when the flash rate is not 0.
