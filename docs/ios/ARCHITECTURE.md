# SNAP for iPhone and iPad: architecture

The target shape for release 1 and the contracts between its parts. The decisions and their reasons are in [the design doc](../designs/ios-app.md). The order of work is in [WORK_PLAN.md](WORK_PLAN.md). Where this file says "gate G1 decides", the answer is not known yet and a work package exists to find it.

## The shape

```
Mac on Earth (unchanged)      Cloudflare (one new path)          iPad or iPhone
┌────────────────────┐        ┌──────────────────────────┐       ┌───────────────────────────────────┐
│ generator daemon   │ rclone │ R2 bucket                │       │ SNAP.app                          │
│ every 60 min       ├───────►│ Worker                   │       │ ┌───────────────────────────────┐ │
└────────────────────┘        │  /      website, Access  │       │ │ web view: the built frontend  │ │
                              │         (as today)       │       │ │ frontend/src/host  (the seam) │ │
                              │  /d/*   devices, token   │◄──────┤ └──────────────┬────────────────┘ │
                              │         checked by Worker│ HTTPS │                │ bridge           │
                              └──────────────────────────┘       │ ┌──────────────┴────────────────┐ │
                                                                 │ │ native: Sync, PlanStore,      │ │
                                                                 │ │ Outbox, TileGateway, Alerts,  │ │
                                                                 │ │ Credential, Diagnostics       │ │
                                                                 │ └───────────────────────────────┘ │
                                                                 └───────────────────────────────────┘
```

The web view draws every screen. Native code answers every request the screens make, from the device first and the network second.

## Nouns

Use these words and no synonyms.

| Word | Meaning |
| --- | --- |
| host | What SNAP runs inside: `browser` or `ios`. |
| host seam | `frontend/src/host/`. The only web code that knows the host. |
| bridge | How the `ios` side of the seam calls native code. Hidden behind the seam. |
| plan | One published version. The device receives a grant-filtered `manifest.json` and the artifacts it names. |
| installed plan | A plan the device has downloaded, verified and stored for an account. |
| extended queue | Passes the device computes from now to seven days ahead, replaced by published scored passes where they exist. Geometry and lighting only. |
| alert plan | The list of alerts the web side hands to native code. |
| outbox | The durable list of writes not yet acknowledged by the server. |
| baseline pack | The map tiles shipped inside the app. |
| tile store | Tiles kept on disk after they were fetched. |
| enrollment | The one-time sign-in that binds a device to a profile. |
| device token | The credential a device receives at enrollment. |

## Where things live

```
frontend/src/host/        the seam: types.ts, index.ts, browser.ts, ios.ts, routes.json, tile-layers.json
frontend/src/             everything else, unchanged in behaviour
app/                      everything app-specific
  OPDKit/                 pure Swift package. No UIKit, no WebKit. Builds and tests with `swift test` on macOS.
  OPDHost/                iOS-only glue: bridge, background task, notifications, Keychain, sign-in sheet
  ios/                    the Xcode project from the host template
  tiles/                  build script and SOURCES.md for the baseline pack. The pack is a release asset, not in git.
  fixtures/               a small plan for demo mode and tests
worker/src/device-auth.ts enrollment, token check, /d/* routing
docs/ios/                 these documents, DECISIONS.md, FOLLOWUPS.md, STATUS.md
.github/workflows/ios.yml
```

`app/ios/` is whatever the host template generates. Work package W-01 records the exact layout in `DECISIONS.md`.

## The host seam

One object, chosen once at startup. The browser side reproduces today's behaviour request for request. The iOS side calls the bridge.

```ts
export interface Host {
  readonly kind: 'browser' | 'ios';
  readonly capabilities: ReadonlySet<string>;      // 'plans.v1', 'outbox.v1', 'tiles.v1', 'alerts.v1', 'identity.v1', 'diagnostics.v1'

  /** Every request to SNAP's own origin. Never called for another origin. */
  request(path: string, init?: HostRequestInit): Promise<Response>;

  online(): boolean;
  probe(): Promise<boolean>;
  on(event: 'plan-installed' | 'connectivity' | 'foreground' | 'memory-warning', cb: () => void): () => void;

  snapshot: { read(): Snapshot | null; write(s: Snapshot): boolean; clear(): void };
  outbox:   { enqueue(p: CalibPayload): Promise<void>; count(): number; drain(): Promise<number>; list(): CalibPayload[] };
  tileUrl(layer: TileLayerId, upstream: string): string;

  identity?:    { current(): HostIdentity; enroll(): Promise<HostIdentity>; forget(): Promise<void> };
  alerts?:      { setPlan(p: AlertPlan): Promise<AlertStatus>; status(): Promise<AlertStatus>; requestPermission(): Promise<boolean> };
  diagnostics?: { snapshot(): Promise<DiagnosticsSnapshot>; export(): Promise<void> };
  keepAwake?(on: boolean): void;
}
```

Members marked `?` exist only on the `ios` host. Web code checks `capabilities`, never `kind`.

### What each member does on each host

| Member | `browser` | `ios` |
| --- | --- | --- |
| `request` | `fetch(path, init)` with the same options as today | Routed by `routes.json`, below |
| `online` | `navigator.onLine` | The system network path is usable |
| `probe` | Today's `/__opd_probe` fetch | Native asks the Worker; true only on a real answer |
| `snapshot` | `localStorage`, today's keys | `read` is built from the installed plan. `write` does nothing: native stored the plan at install. |
| `outbox` | Today's `opd-calib-queue` code, moved | Native outbox. `enqueue` resolves only after the entry is on disk. |
| `tileUrl` | Returns `upstream` unchanged | Returns the tile route for that layer |

### Request routes on the `ios` host

`frontend/src/host/routes.json` is the one table. Native code reads the same file from the app bundle. A test fails when the frontend requests a same-origin path the table does not classify, so a new web request cannot reach the app unrouted.

| Path | Class | How the `ios` host answers |
| --- | --- | --- |
| `/manifest.json`, `/v/<version>/*` | plan | From the active account's installed plan and granted artifacts. Never the network on the calling path. |
| `/launch/latest.json`, `/launch/v/*`, `/launch/catalog/*` | published | Stored copy at once; refreshed by sync |
| `/hazards/v1/*` | published | Network; last good copy, marked stale, when offline |
| `/lightning/latest.json` | live | Network only. It is stale after eight minutes by design. |
| `/api/browser/session` | identity | The active account's last answer from `/d/session`, stored at enrollment and refreshed by sync. Same JSON shape as the website's, so the profile menu and its granted profiles work unchanged. |
| `/api/log` POST | outbox | Not called. `calib.ts` uses `host.outbox` when the capability exists. |
| `/api/log` GET, `/api/browser/profiles/*`, `/api/kp`, `/api/aurora`, `/api/wx`, `/api/cloud` | api | Network with the device token, sent to `/d/api/...`. Offline, it rejects like a failed `fetch`, so today's error paths run. |
| `/api/cal` | local | The Remind flow uses `host.alerts` instead of a calendar file |
| `/api/app`, `/sw.js`, `/registerSW.js` | absent | Not built into the app. The iOS build has no service worker. |
| `/__opd_probe` | probe | Same as `host.probe()` |

Navigations are routed too. `/`, `/?u=<name>` and `/<name>` load the shell, because the profile menu switches profile with `location.assign` (`frontend/src/profile-menu.ts:89`). The sign-in recovery navigation to `/api/app` and the calendar navigation to `/api/cal` do not exist on the `ios` host. A link to another site opens in Safari.

The web side keeps polling `/manifest.json` every 60 seconds. On the `ios` host that read costs nothing and returns the newest installed plan. Native code also fires `plan-installed`, which triggers `refresh()` at once.

### Storage, in two tiers

- **Tier 1, durable native storage.** Installed plans, the profile binding, the device token, and the outbox. A write is acknowledged after it is on disk.
- **Tier 2, recoverable web storage.** The `ios` host mirrors `opd-` preferences, personal target copies, and caches to native storage for the active account. It restores only that account's mirror. Signed-out baseline state has its own namespace. The bundled curated targets and baseline map pack are shared.

Key installed plans, mirrored web storage, account-derived caches, and alert plans by the stable account ID. Account-derived caches include tiles prefetched around personal targets. On sign-out or account change, detach the old account's plan and caches and clear their web-view copies before loading another account or the baseline. Bind in-flight sync, mirror, and alert work to the account activation that started it. Discard results from an earlier activation, including one that finishes after a switch back. When sync confirms a grant was removed, stop serving the affected profile and clear its installed and staged artifacts, cached views, and alerts. Apply the new grants before publishing sync results. Clear notifications as described in [Alerts](#alerts).

### Tiles

`frontend/src/host/tile-layers.json` lists every tile layer once: an id, the upstream URL template, the attribution text, the deepest zoom and a storage policy. The web side builds map sources from it through `host.tileUrl`. Native code reads the same file. A tile URL template that is not in the catalogue fails a test.

| Policy | Meaning | Layers in release 1 |
| --- | --- | --- |
| `baseline` | Bundle separate raster MBTiles at zoom 0 to 5 and a GeoJSON lines and labels asset. Include attribution for each asset. | Blue Marble, Black Marble 2016, Natural Earth lines and labels |
| `durable` | Kept on disk after fetch, inside the tile-store cap | GIBS daily true colour (latest two days), SNAP forecast cloud frames |
| `session` | Kept briefly | Geostationary IR, RealEarth Meteosat |
| `online` | Fetch on demand where the source terms permit. Prefetch and disk retention are disabled by default. Enable offline use only under [confirmed permission for the exact sources and use](../designs/ios-app.md#esri-rights). | Esri imagery, Esri dark grey, Esri reference labels |

The gateway answers in this order: baseline pack, tile store, network. A miss with no network returns nothing and the map overzooms the baseline. The baseline sits under the online layers in the map style, so a missing Esri tile shows Earth, not black.

The baseline MapLibre sources and gateway use XYZ coordinates. The pack stores rows in TMS order. For each baseline database lookup, the gateway converts the XYZ row to `tile_row = 2^z - 1 - y` once, at the MBTiles boundary. Tile-store keys and upstream requests keep XYZ coordinates. [MapLibre raster scheme](https://maplibre.org/maplibre-style-spec/sources/#raster-scheme) · [MBTiles tile rows](https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md#tiles)

The tile store has a 512 MiB cap (536,870,912 bytes), measured as the sum of downloaded tile payload bytes across all layers. The bundled baseline pack, installed plans and outbox are outside this cap. Before storing a tile, remove expired tiles, then evict least-recently-used tiles until the new tile fits. Do not store a tile larger than the cap. Layer retention rules are upper limits within this cap. A fill-and-evict test checks the byte total, eviction order and preservation of the baseline, plans and outbox.

The iOS host disables Esri world-view and per-target prefetch by default. For permitted GIBS prefetch, `frontend/src/tile-precache.ts` routes requests through `host.tileUrl` to the gateway after each new plan. The top three targets get one tile per source zoom at 6, 8, and 9. Requested zoom 10 clamps to source zoom 9. The browser host keeps its existing prefetch. W-42 verifies offline baseline rendering and attribution with Esri disabled.

## Native parts

`OPDKit` holds the logic and is pure Swift so it can be built and tested on the Mac today, which has Swift but no Xcode. Tests use Swift Testing. Every part takes its clock, file system root and transport as parameters.

| Part | Job | The property its tests must hold |
| --- | --- | --- |
| PlanStore | Stores installed plans under Application Support by account. Keeps the current plan, the previous one, and one more for each account. | Stop the process between any two steps of an install. `current` still resolves to a complete plan for the same account and every artifact matches its SHA-256. |
| SyncEngine | Downloads the account's filtered manifest and artifacts to a staging folder, verifies required fields and hashes, installs, and backs off on failure. Runs on foreground, on connectivity, on a timer, and in background refresh. | A failed or partial download leaves `current` intact. For the active account, the newer readable version wins. An unreadable version stays out of `current` and the app says an update is needed. |
| Outbox | One file per unsent write, keyed by the tuple of account, original selected profile, and dedupe key. | A drain removes an entry only after `{ok:true}`, which requires a completed or verified monthly log write. Interrupted writes and concurrent retries across month boundaries produce one canonical monthly record. Confirmed account deletion purges that account's entries. Nothing is dropped to make room. |
| TileGateway | The lookup order and the 512 MiB tile-store cap. | The baseline is never evicted. Local bytes are returned without touching the network. A fill test proves the cap and least-recently-used eviction. |
| AlertPlanner | Chooses which alerts to schedule from the alert plan. | Never more than the system limit. The coverage end it reports equals the last scheduled alert. |
| CredentialStore | Protocol here. `OPDHost` stores the device token in Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. | The token is usable while locked after the first unlock, stays on the issuing device, and never appears in a log, a diagnostics export or JavaScript. |
| Diagnostics | A capped event log and a snapshot. | The export contains no token and no personal target coordinates. |

`OPDHost` is the thin iOS layer: the bridge, the background refresh task, the notification centre, the Keychain, the sign-in sheet and the web view delegate.

Use `.completeUntilFirstUserAuthentication` file protection for files the background job reads or writes. These include the account binding, installed plans, staging files, outbox, and stored alert plan. Apply the protection to new files and atomic replacements. If protected storage is unavailable before first unlock, defer the run without making requests, modifying state, or starting sign-in recovery. Retry at the next eligible run or foreground launch after unlock. A restore to another device starts at the baseline even if it restores account files. Enrollment must issue a new device credential before account data can be restored to the active session. [Apple Keychain accessibility](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly) · [Apple file protection](https://developer.apple.com/documentation/foundation/fileprotectiontype/completeuntilfirstuserauthentication)

### Log acknowledgment and recovery

`POST /api/log` and `POST /d/api/log` keep their own authentication and authorization. Once authorized, both call the same log reservation and writer, including the existing machine-authenticated `/api/log` path. Resolve the stored profile on the server under each route's existing rules. The reservation is keyed by that profile and the original client dedupe key, independent of account, route, and arrival month. Requests without a dedupe key keep their append behavior.

The legacy key is `log/<arrival yyyymm>/<namespace><sanitized dedupe key>.json`. The payload stores the original key and a Worker-generated `received_at`. During cutover, return retryable failures on both write routes and drain in-flight legacy writes before scanning all retained legacy months. For each record with a nonempty stored key, use the stored profile and original key to seed a reservation. Use the existing legacy default profile for records without a profile field. Preserve the exact stored payload, first receipt time, and object path. If the same tuple already appears in several months, adopt the earliest receipt and break ties by object path. Keep historical objects intact. Legacy appends with an empty or absent key stay readable. Resume writes only when the scan is complete and all writers use the shared reservation. A rollback must keep that writer or pause writes again.

New deduped objects use `log/<arrival yyyymm>/~v2~<profile>~d~<encoded key>.json`. The encoded key is unpadded base64url of the original string's UTF-16 code units in big-endian order. This encoding preserves distinct keys that the old sanitizer collapsed. The reserved `~` delimiter separates fields and makes the format disjoint from legacy paths. Appends use `~a~<uuid>` in place of `~d~<encoded key>`. Monthly readers merge both formats before applying the result limit and still check the record's profile. The Worker conditionally creates the immutable reservation and stores the canonical payload and monthly path in it. A competing writer uses the winning reservation.

Every request completes or verifies the reserved monthly write before returning `{ok:true}`. Create the monthly object conditionally. If the object exists, verify it against the reserved payload. A failed or ambiguous write returns a retryable failure and leaves the outbox entry pending. R2 evaluates each conditional write atomically at its destination key. [R2 conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/)

Seed a legacy object with its own receipt timestamp. Retry in the same, next, and a non-adjacent month and verify that every acknowledgment refers to the unchanged legacy object. Include a fixture where a different tuple produces the same legacy path, plus two distinct raw keys that sanitize to the same string. Verify that the other tuple never adopts the wrong record, that new destinations are distinct, and that monthly reads return only the authorized profile in either format. Interrupt writes between reservation and monthly write and after the monthly write but before acknowledgment. Race retries across both routes and months. No retry succeeds while the reserved monthly record is missing. Identical entries for two granted profiles stay separate. Two authorized accounts writing the same shared profile dedupe to one record.

## The queue between syncs

The published plan covers little time. The Queue artifact holds the top 5 passes of the next 90 minutes, Upcoming the top 10 after that, and the map list the top 25 (`generator/config.py:25-27`). The generator scores 36 hours (`:22`) but does not publish all of it. So 90 minutes after the last sync the website's Queue is empty.

`frontend/src/plan-extend/` computes passes on the device from now to seven days ahead, from the published target list, the personal targets and the newest orbit data. It propagates the orbit once into a shared ephemeris and tests every target against it, using the generator's 800 km distance limit (`generator/config.py:56`). The dropped-pin finder in `frontend/src/pin-drop.ts` propagates per pin with a 1,500 km limit and is too slow for this; only its geometry helpers are reused, with the sun and terminator math. It fills geometry, lighting regime and a score from regime fit, distance from nadir and priority, the same three formulas as `generator/score.py`. It fills no cloud number.

A published scored pass replaces the device pass for the same target when their closest approaches are within five minutes. Queue shows up to five passes in the next 90 minutes. It lists published picks first by score, then device passes by time. Upcoming lists published picks first, then device passes by time. Each remaining device pass is marked `provenance: 'device'` and tagged "geometry only". A device pass is marked approximate when its closest-approach time minus the epoch of the orbit data used exceeds 48 hours, and the mark is recomputed when newer orbit data is installed; W-12's accuracy check may move that threshold. A script in the repository runs the Python pass finder on a fixed orbit and target set and writes reference vectors. The TypeScript tests must match them inside the generator's own sampling step. That is what keeps the two from drifting.

## Alerts

While SNAP is open, the web side builds an alert plan from the published passes and the extended queue and calls `host.alerts.setPlan`. One alert per target pass, fired a set lead time before closest approach. The text states only what does not go stale: the target, the minutes to go, the side and angle, day or night.

```ts
interface AlertPlan  { generatedAt: string; horizonEnd: string; items: AlertItem[] }
interface AlertItem  { id: string; fireAt: string; title: string; body: string; targetId: string; passTime: string; source: 'published' | 'device' }
interface AlertStatus { authorized: boolean; scheduled: number; coveredThrough: string | null; planHorizonEnd: string | null }
```

Native code stores the plan, schedules the earliest items up to the system limit of 64 less two reserved slots, and removes pending alerts that left the plan. One reserved slot holds "SNAP alerts run out soon. Open SNAP to set more." at the coverage end. The other holds an expiry alert only on the ground tester's TestFlight or ad hoc build. An App Store install clears any expiry request left by the ground build. In background refresh, native code rolls the window forward from the stored plan. It needs no orbit math to do that.

When an alert plan is submitted, native code binds it to the starting account activation and selected profile. Verify that the profile is still granted before storing or scheduling the plan. Scope each target notification ID by account, profile, and alert item. Keep the signed-out baseline in its own scope. On sign-out, account switch, or confirmed deletion, stop scheduling for the outgoing account and remove its pending requests and delivered notifications before loading the next account or baseline. On grant removal, clear the stored plan and both notification lists for the affected account and profile. Leave other scopes intact. Check both lists after removal so a request delivered during cleanup is cleared as well. Discard late work for an old activation or removed grant. [Apple delivered notification removal](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/removedeliverednotifications(withidentifiers:))

The screens show `coveredThrough` as "Alerts set through ...". Settings: lead time, which targets, and a sleep window with no alerts.

Background refresh only rolls forward the active account's alert plan or the signed-out baseline plan. Seed two previously enrolled accounts with installed plans, mirrored caches, and alert plans in the native test. Give both accounts one shared profile and give the first account an additional private profile. Put one of its private alerts in Notification Center and leave another pending. Switch the active account with the link down. Verify that neither alert remains, the incoming account can still schedule its shared-profile alert, and late sync or scheduling work cannot restore outgoing alerts. A switch without a verified incoming account shows the baseline until enrollment succeeds.

## Sign-in and device access

The problem has three parts. Google refuses to sign in inside an embedded web view. The Worker today admits only a human Access identity and same-origin writes. A session cookie expires.

```
App                 system sign-in sheet        Cloudflare Access       Worker
 │ enroll ───────────► GET /api/device/enroll ──► Google ─────────────► verify the Access identity
 │                     ?challenge=...                                    create a one-time code (5 minutes),
 │                                                                       bound to the profile and the challenge
 │ ◄────────────────── redirect snap-enroll://done?code=... ◄────────────┘
 │ POST /d/enroll {code, verifier, label} ─────────────────────────────► check the code and the verifier, mint a token,
 │                                                                       store its SHA-256 with the profile and the label
 │ ◄──────────────────────────────── {token, profile, device_id} ◄──────┘
 │ store the token in the Keychain
 │ GET /d/manifest.json   Authorization: Bearer ... ───────────────────► check the token and filter by current grants
```

- `/api/device/enroll` stays behind a separate Access application that admits anyone with a Google account, with no approval step. Google sign-in runs in the system sheet. The Worker verifies this enrollment application's audience and signed identity, without the website email allowlist. Existing website and owner routes keep their access rules.
- `/d/*` gets an Access bypass application, as `/api/profiles` has today. The Worker's email allowlist, including the check in `calibration-auth.ts`, must not apply to `/d/*` or the Google enrollment callback. The rate-limited `/d/enroll/apple/session` route starts Apple enrollment without a device token. The bootstrap routes `/d/enroll` and `/d/enroll/apple` verify enrollment proof. The deletion status route accepts only its deletion receipt. The [retained-account deletion check](#profiles-sign-out-and-deletion) accepts only a separate status credential. All other `/d/*` routes require a device token. Missing, unknown, and ordinarily revoked tokens return `401` with no body detail. Only `/d/session` can return the account deletion signal for a device token invalidated by deletion.
- A device token carries the account that enrolled it. The Worker resolves that account to the same profile and granted profiles as it does for the website (`worker/src/browser-identity.ts`), and `/d/*` acts inside them and no further.
- A token does not expire. It is revoked per device, by the owner, through a route behind Access.
- Every `/d/*` request carries the app's build number, and the owner's device list shows each device's last build. W-63 seeds a synthetic older contract. W-70 records real build contracts, which W-63 checks regardless of build reports.
- Bearer-token requests carry no cookie, so the same-origin write rule that guards the website does not apply to `/d/*`. The design note for work package W-20 states that reasoning for the security review.
- The active account can read its installed plan while offline or after an ordinary `401`. On ordinary rejection, the app shows a sign-in prompt and preserves the account's stored data.
- An enrollment test uses new Apple and Google accounts absent from the website allowlist. Each enrolls without approval, gets only its own profile, and still cannot reach website or owner-only routes without their existing authorization.

### Plan artifact authorization

For `/d/manifest.json`, the Worker keeps the known shared artifacts and filters `artifacts.profiles` to the account's own profile and current grants. Omit deleted profiles from acceptance onward, including when the current published manifest still lists them. Preserve the version and integrity metadata for the artifacts that remain. Return the projection with `Cache-Control: private, no-store`. Sync refreshes the account's view when grants change or a profile is deleted, even if the plan version stays the same.

For each `/d/v/*` request, resolve the canonical versioned path against the published plan artifact types before reading R2. Shared artifact paths are available to any authenticated device. A profile artifact path identifies its profile. Recheck current grants and the profile's deletion state on every request. Reject unknown, ungranted, and deleted profile paths with the same `404`, including on the current and retained versions. Return authorized device artifacts with `Cache-Control: private, no-store`. On both map hosts, check the same deletion state on the existing website personal-artifact paths before serving cached or R2 bytes. Require the check on any alternate server delivery path for those artifacts. Keep the website's existing access rules for other profiles.

On both map hosts, revalidate personal state with the Worker at browser startup, on reconnect, when a tab returns to the foreground, and during normal online refresh. Use the authenticated browser session route to return the complete set of profiles currently available to that browser, with deleted profiles omitted. The request and response bypass the service worker cache, browser HTTP cache, and edge cache. Revalidate even when the manifest version stays the same. While a connected browser waits for validation, hide unvalidated personal state. Send online personal-artifact requests to the Worker before serving bytes. During LOS, use the existing offline fallback for profiles that have no confirmed removal.

When authoritative revalidation removes a previously available profile, clear it from rendered views, including Queue and Upcoming. Remove its saved snapshots, personal target state, and cached personal artifacts on that origin. Include legacy unscoped entries that could contain the deleted profile and snapshots saved by its grantees. Invalidate in-flight refreshes for that profile and tell other open tabs on the origin to drop it. A reload or another LOS period must be unable to restore deleted data. Keep unrelated and shared data available. W-21 deploys the browser and service worker changes before enabling deletion.

Both artifact publishers, `scripts/deploy.sh` and `scripts/deploy_wrangler.sh`, publish through the same server-side check of the durable profile deletion marker. Coordinate writes to current and retained artifacts and the manifest flip with deletion acceptance. A stale upload cannot put deleted bytes into the published namespace or restore references to them. Wait for any writes accepted before deletion to finish or be fenced off before purging, then verify the purge before recording terminal status.

Use synthetic profile artifacts in the Worker tests. Compare manifests for accounts with different grants on the same version. Test direct artifact reads for the account's own profile, a legitimate shared grant, and an unrelated profile whose URL never appeared in the filtered manifest. Remove the shared grant between manifest and artifact reads and verify that the next direct request fails. Verify that every artifact referenced by a filtered manifest remains readable and matches its published hash while the grant and version are valid.

### Sign in with Apple

```
App                                                     Worker
 │ POST /d/enroll/apple/session ──────────────────────► create a short-lived session with an unpredictable nonce
 │ ◄────────────── {session_id, nonce} ────────────────┘
 │ Set the nonce on the native Apple authorization request
 │ Receive the identity token and authorization code from Apple
 │ POST /d/enroll/apple {session_id, identity_token, authorization_code, label}
 │                                                         ► verify proof, consume session, exchange code, save token response
 │ ◄────────────────── {token, profile} ─────────────────────┘
```

The Worker verifies the incoming identity token's signature against Apple's published keys, issuer (`https://appleid.apple.com`), audience (the app's bundle ID), and expiry. It requires the signed `nonce` claim to match the nonce stored for `session_id`. Only one request can atomically consume the unexpired session. The Worker then exchanges the single-use code at `POST https://appleid.apple.com/auth/token` with `grant_type=authorization_code`. Verify the returned identity token and require its Apple subject to match the nonce-verified token's subject.

On verified enrollment or re-enrollment, durably store the new encrypted token response and refresh token on the account before issuing SNAP device access. Re-enrollment replaces the previous credential. An older enrollment session cannot overwrite a credential committed by a newer session. Failed exchange, mismatched subject, missing refresh token, or failed storage leaves enrollment incomplete. A retry requires fresh authorization. Serialize the verified exchange and credential replacement with deletion acceptance for that account. The deletion job records the latest committed credential at acceptance. A pending enrollment that loses the race with deletion cannot update the account or issue device access. [Apple's identity-token verification](https://developer.apple.com/documentation/signinwithapple/verifying-a-user) · [Apple TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)

Look up the account by the Apple user identifier. Apple may supply a relay email address. Any Apple ID or Google account can sign up without approval. A new account created after deletion gets new internal account and profile IDs. The Worker's email allowlist does not apply to `/d/*`. Abuse control is the daily rate limit, per-account quotas on targets and log entries, and revocation from the owner's device list.

Apple deletion normally uses the retained refresh token without opening the Apple sheet. If the Worker cannot load a usable retained credential before acceptance, the app can request a fresh authorization code and identity token through the native sheet. The Worker verifies that the proof belongs to the account being deleted, exchanges the code, verifies the returned subject, and stores the revocable refresh or access token encrypted for the deletion job. Request fresh authorization again if the code expired or was already consumed. If fresh authorization cannot supply a revocable token, use the manual-revocation path below.

The owner configures a server-only Sign in with Apple private key with the capability enabled, its key ID, the Apple Developer Team ID and the app's client ID (bundle ID). The Worker uses these to sign a short-lived ES256 client-secret JWT. This is separate from the App Store Connect release key. No credential value goes in the repository, app bundle or logs. See Apple's [private-key setup](https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key), [token validation](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens) and [account deletion guidance](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple).

### Profiles, sign-out and deletion

- Each account has its own profile, resolved by the Worker as for the website. A new account starts with an empty personal target list on top of the curated baseline.
- One account per device at a time. Sign-out deletes the device token and keeps the account's unsent entries. Drain sends entries only for the signed-in account and uses each entry's original selected profile even if another profile is now selected. The Worker checks the account's grant for that profile on upload.
- "Delete account" asks once, then calls `/d/account/delete` with the signed-in device token. Reject wrong-account Apple recovery proof before acceptance. Persist a resumable job with its receipt binding and any encrypted provider credential. Acceptance durably blocks account access and profile reads and writes, including reads by still-enrolled grantees. Invalidate account device tokens at the same point. A replay with the old device token returns `401` and creates no job.
- The job removes the account record, device credentials and the profile's targets. Apply the published retention policy to both monthly log records and canonical dedupe payloads for the deleted profile. Any payload the policy requires to be removed must also be gone from its dedupe reservation by the same deadline. If the policy permits temporary retention, keep retained data inaccessible through the deleted profile and verify expiry. See [owner step 7a](OWNER_STEPS.md#7a-log-retention-policy). Purge the profile's personal artifacts from the current and every retained published version, including intermediary cache copies on any serving path. The job verifies the purge before reporting any terminal status. A failed or interrupted purge stays pending and retries while the profile stays blocked. Shared and unrelated artifacts remain available.
- For an Apple account, the job calls `POST https://appleid.apple.com/auth/revoke` with form fields `client_id`, the signed `client_secret`, `token`, and the matching `token_type_hint`. Send the credential recorded for this deletion job. A `200` response confirms revocation of the submitted token, including on a retry after Apple already invalidated it. The job removes the retained provider credentials after revocation. A transient failure or lost reply keeps the job pending for Worker-owned retries with backoff. Credential configuration failures remain visible for repair. Pending deletion returns `202`. Completion requires SNAP cleanup and, for Apple accounts, confirmed Apple revocation. [Apple's token revocation endpoint](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens)
- If no revocable Apple credential can be obtained, finish SNAP cleanup and report manual action required. Direct the person to revoke SNAP in their Apple account settings. [Apple TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)
- Keep a one-way verifier for each token invalidated by deletion so offline devices can learn of it on reconnect. Store only the verifier, with no account or profile identifier. A matching former token gets a private, uncached `410` from `/d/session` with only an `account_deleted` code. It grants no access to any other route. On reconnect, native code checks session status before installing a plan, draining logs, or rolling alerts forward. While offline, the active account continues to use its stored plan until it learns of the deletion.
- At Apple or Google enrollment, issue a separate high-entropy deletion-check credential for that device and internal account ID. Store it with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` before retaining account files. Keep it through sign-out, account switch, and ordinary token revocation while those files remain. At deletion acceptance, turn its server-side verifier into a deletion marker and remove the verifier's account and profile bindings. Keep this minimal marker available to returning devices while their retained state can need cleanup. The rate-limited `GET /d/account/deletion-check` returns a private, uncached `410` with only `account_deleted` for a matching deletion marker. It returns an empty `204` for a live or unknown verifier. This credential grants no account access and stays out of URLs, JavaScript, logs, and diagnostics. The initiating device's deletion receipt remains the only credential that can read job progress.
- On online launch, foreground, and reconnect, check deletion for every retained account, including signed-out and switched-away accounts. Check before reactivating retained state. An unavailable check or an ordinary rejection leaves the stored state intact. On the initiating device, receipt status or the acceptance response triggers cleanup. On other devices, a confirmed SNAP deletion signal triggers it. Durably mark that account unavailable and discard its in-flight work. Remove its stored and staged plans, mirrors, personal target caches, outbox entries and Keychain credentials. Clear matching pending and delivered notifications and any web view state for that account. If it was active, return to the baseline. Preserve another active account and its unrelated alerts. Resume incomplete local cleanup on relaunch. Grantees keep their own account and apply the profile removal when session sync refreshes their grants.
- On a native Apple credential-revocation notification for the local Apple account, sign out that account, stop sync and alert scheduling for it, and clear its pending and delivered alerts. If it was active, return to the baseline and hide its plan and mirrors. Keep its unsent logs and deletion-check credential until SNAP confirms account deletion. Apply the same rule when the notification arrives before the reconnect check. [Apple credential revocation](https://developer.apple.com/documentation/authenticationservices/asauthorizationappleidprovider/credentialrevokednotification) · [Apple Support](https://support.apple.com/en-us/102571)
- The owner's device list shows each account, its devices and their last build, and can revoke any of them.

### Apple deletion receipt

Before sending the deletion request, native code generates a high-entropy receipt and saves it separately from the account credential. It sends the receipt hash with the request. The Worker binds that hash to the deletion job when it accepts the request. `GET /d/account/delete/status` uses the receipt as a bearer credential and returns only deletion state and timing. The receipt grants no other access. Keep the status response uncached and the receipt out of JavaScript, URLs, logs, and diagnostics.

The app can check the receipt after clearing the account credential. Settings shows deletion status and the expected completion time, within 24 hours of acceptance. If more time is needed, keep showing pending and say that deletion is taking longer than expected. Recheck on relaunch or reconnect and show confirmation when the status is complete. The manual-revocation path reports that action is required. Keep status available while deletion is pending and for 30 days after it completes or reaches the manual-revocation state. A terminal status keeps no account identifier or provider token. Store the terminal status before removing the job state needed to recover after interruption. [Apple's account deletion guidance](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion)

If the initial response is lost, use the saved receipt to recover the result. A returned status confirms acceptance and triggers the same local cleanup as the initial response. If the Worker has no status for the receipt, the app shows that acceptance is unconfirmed and can retry with a valid account credential and fresh Apple proof if required. The same receipt and the same account can only identify one deletion job.

Test Apple deletion with the retained enrollment credential, a matching fresh code, wrong-account proof, an expired or consumed code, provider failures, and the manual-revocation path. Drop the initial response after acceptance, restart the app and Worker while pending, and delay revocation or artifact purge past the expected time. Verify that the app recovers the same receipt, clears local state, stays pending past the deadline, and confirms completion after revocation and cleanup succeed. A lost response before acceptance stays unconfirmed. An invalid receipt reveals no status and a valid receipt cannot read any other route.

### Before sign-in

A signed-out app needs no token. It reads the curated targets built into the app and fetches the ISS element set from CelesTrak directly, at most every few hours, falling back to the element set built into the app. Nothing behind the map's sign-in is served without a token.

## What happens when

| Moment | What happens |
| --- | --- |
| First launch, no account | The baseline: curated targets built into the app, passes computed on the device, the map and the ISS view. A Sign in button offers Sign in with Apple and Google. |
| Cold launch, no signal | The shell loads from the app. A signed-in device reads `/manifest.json` and its artifacts from the active account's installed plan. A signed-out device uses the baseline. The map draws from the baseline and the tile store. The ISS moves from the stored orbit data. The banner says LOS and the plan's age. |
| The link returns, app closed | If iOS grants a background refresh: sync installs a newer plan, the outbox drains, alerts roll forward. If it does not, all of that happens at the next open. |
| Shoot tapped with no signal | The entry is written to the outbox, then the screen confirms. It uploads once when the link returns. |
| The web process is killed | The web view delegate reloads the shell. The web side restores the tab and the aim from storage, as it does after a browser reload. |
| An install is interrupted | The staging folder is discarded at next launch. The previous plan stays current. |
| The token receives an ordinary `401` | Sync and the outbox pause. A banner offers sign-in. Reading the active account's installed plan continues. |
| Native sync learns the account was deleted | Local account cleanup runs before any further sync or alert work. The baseline replaces the deleted account's state. |
| The orbit data is old | Past 48 hours the position readout shows the age. Alerts keep firing with the age in their text. |
| Storage is nearly full | Tile storing stops first. Plans and the outbox are never trimmed. |
| A newer plan lacks a field this build needs | It is not installed. The previous plan stays current. A banner says an update is needed. |
| A new build is installed over the old one | The credential, installed plans, outbox, kept tiles and settings carry over. |
| A ground build nears expiry | Show a banner from 30 days out and an alert at 10 days. TestFlight uses its App Store Connect build deadline. Ad hoc uses the provisioning profile expiry. Ask the ground tester to install the replacement on the same channel. App Store installs have no expiry display or alert. Missing receipt data leaves launch available offline. |

## Rules the build enforces

These extend the rules in `AGENTS.md`. Each gets a test that fails with the file and the rule named.

- Nothing outside `frontend/src/host/` names the bridge, the host template or `webkit.messageHandlers`.
- No `fetch(` to a same-origin path outside `frontend/src/host/`.
- Every same-origin path the frontend requests is classified in `routes.json`.
- Every tile URL template is in `tile-layers.json`.
- Web code reads `host.capabilities`, never `host.kind`, outside the seam.
- `OPDKit` imports no UIKit and no WebKit, and its tests import `Testing`, not `XCTest`.
- No key, certificate, provisioning profile or token is in the repository. Workflows name secrets; they never print them.
- No iOS work package changes `generator/`.

## Not in release 1

Swift orbit math. Widgets and the Lock Screen countdown. Native screens. Notification buttons for Shoot and Skip. Server push. Device-to-device plan sharing. Updating the web bundle without a new build. A longer plan from the generator. Android.
