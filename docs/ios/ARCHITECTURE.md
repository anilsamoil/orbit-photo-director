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
| plan | One published version: `manifest.json` and the artifacts it names. Same as today. |
| installed plan | A plan the device has downloaded, verified and stored. |
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
| `/manifest.json`, `/v/<version>/*` | plan | From the installed plan. Never the network on the calling path. |
| `/launch/latest.json`, `/launch/v/*`, `/launch/catalog/*` | published | Stored copy at once; refreshed by sync |
| `/hazards/v1/*` | published | Network; last good copy, marked stale, when offline |
| `/lightning/latest.json` | live | Network only. It is stale after eight minutes by design. |
| `/api/browser/session` | identity | The last answer from `/d/session`, stored at enrollment and refreshed by sync. Same JSON shape as the website's, so the profile menu and its granted profiles work unchanged. |
| `/api/log` POST | outbox | Not called. `calib.ts` uses `host.outbox` when the capability exists. |
| `/api/log` GET, `/api/browser/profiles/*`, `/api/kp`, `/api/aurora`, `/api/wx`, `/api/cloud` | api | Network with the device token, sent to `/d/api/...`. Offline, it rejects like a failed `fetch`, so today's error paths run. |
| `/api/cal` | local | The Remind flow uses `host.alerts` instead of a calendar file |
| `/api/app`, `/sw.js`, `/registerSW.js` | absent | Not built into the app. The iOS build has no service worker. |
| `/__opd_probe` | probe | Same as `host.probe()` |

Navigations are routed too. `/`, `/?u=<name>` and `/<name>` load the shell, because the profile menu switches profile with `location.assign` (`frontend/src/profile-menu.ts:89`). The sign-in recovery navigation to `/api/app` and the calendar navigation to `/api/cal` do not exist on the `ios` host. A link to another site opens in Safari.

The web side keeps polling `/manifest.json` every 60 seconds. On the `ios` host that read costs nothing and returns the newest installed plan. Native code also fires `plan-installed`, which triggers `refresh()` at once.

### Storage, in two tiers

- **Tier 1, must never be lost.** Installed plans, the profile binding, the device token and the outbox. Native only. A write is acknowledged after it is on disk.
- **Tier 2, should survive.** Everything the web side keeps under an `opd-` key: preferences, the personal target copy, caches. The `ios` host mirrors these to a native file in the background and restores them when web storage comes up empty. No call site changes, so a storage key added by a later web change is covered without anyone thinking about the app.

### Tiles

`frontend/src/host/tile-layers.json` lists every tile layer once: an id, the upstream URL template, the attribution text, the deepest zoom and a storage policy. The web side builds map sources from it through `host.tileUrl`. Native code reads the same file. A tile URL template that is not in the catalogue fails a test.

| Policy | Meaning | Layers in release 1 |
| --- | --- | --- |
| `baseline` | In the baseline pack. Deeper zooms go to the tile store. | Blue Marble, Black Marble 2016, Natural Earth lines and labels |
| `durable` | Kept on disk after fetch, inside the tile-store cap | GIBS daily true colour (latest two days), SNAP forecast cloud frames |
| `session` | Kept briefly | Geostationary IR, RealEarth Meteosat |
| `website` | Fetched and kept exactly as the website's service worker does today: the world view at zoom 0 to 3 once a session, kept 30 days; dark grey at zoom 6, 8 and 10 near the top three targets after each new plan; viewed tiles up to 100 for 7 days. Never bundled. | Esri imagery, Esri dark grey, Esri reference labels |

The gateway answers in this order: baseline pack, tile store, network. A miss with no network returns nothing and the map overzooms the baseline. The baseline sits under the online layers in the map style, so a missing Esri tile shows Earth, not black.

The tile store has a 512 MiB cap (536,870,912 bytes), measured as the sum of downloaded tile payload bytes across all layers. The bundled baseline pack, installed plans and outbox are outside this cap. Before storing a tile, remove expired tiles, then evict least-recently-used tiles until the new tile fits. Do not store a tile larger than the cap. Layer retention rules are upper limits within this cap. A fill-and-evict test checks the byte total, eviction order and preservation of the baseline, plans and outbox.

Prefetch matches the website exactly: the world view of the switchable layers once a session, and one tile per zoom at 6, 8 and 10 near the top three targets after each new plan. `frontend/src/tile-precache.ts` builds those URLs through `host.tileUrl`, so in the app they go to the gateway and are stored; the app has no service worker to store them otherwise.

## Native parts

`OPDKit` holds the logic and is pure Swift so it can be built and tested on the Mac today, which has Swift but no Xcode. Tests use Swift Testing. Every part takes its clock, file system root and transport as parameters.

| Part | Job | The property its tests must hold |
| --- | --- | --- |
| PlanStore | Stores installed plans under Application Support. Keeps the current plan, the previous one and one more. | Stop the process between any two steps of an install: `current` still resolves to a complete plan whose every artifact matches its SHA-256. |
| SyncEngine | Checks the manifest, downloads to a staging folder, verifies, checks the plan has every field this build requires, installs, backs off on failure. Runs on foreground, on connectivity, on a timer and in background refresh. | A failed or partial download never changes `current`. A newer readable version always wins; an older one never replaces a newer one; an unreadable one is not installed and the app says an update is needed. |
| Outbox | One file per unsent write, keyed by the tuple of account, original selected profile, and dedupe key. | An entry is deleted only after the server answers `{ok:true}`, which requires a completed or verified monthly log write. Interrupted writes and concurrent retries across month boundaries produce one canonical monthly record. Nothing is dropped to make room. |
| TileGateway | The lookup order and the 512 MiB tile-store cap. | The baseline is never evicted. Local bytes are returned without touching the network. A fill test proves the cap and least-recently-used eviction. |
| AlertPlanner | Chooses which alerts to schedule from the alert plan. | Never more than the system limit. The coverage end it reports equals the last scheduled alert. |
| CredentialStore | Protocol here; Keychain behind it in `OPDHost`. | The token never appears in a log, a diagnostics export or JavaScript. |
| Diagnostics | A capped event log and a snapshot. | The export contains no token and no personal target coordinates. |

`OPDHost` is the thin iOS layer: the bridge, the background refresh task, the notification centre, the Keychain, the sign-in sheet and the web view delegate.

### Log acknowledgment and recovery

The Worker conditionally creates an immutable, month-independent record keyed by the server-authorized selected-profile namespace and dedupe key. It keeps the canonical payload, including the first receipt time, and the original monthly destination. Preserve the existing key format, `log/<arrival yyyymm>/<namespace><sanitized dedupe key>.json`, including the profile namespace used by existing readers. A competing request reads the winning record and uses its payload and destination.

Every request, including every retry, completes or verifies the monthly write from that record before returning `{ok:true}`. Create the monthly object conditionally. If it already exists, verify that it matches the canonical payload. A marker alone is not success. A failed or ambiguous write returns a retryable failure and leaves the outbox entry pending. R2 conditional writes are atomic per object, not across the two objects. See [R2 conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/).

Tests interrupt the request between the month-independent and monthly writes, after the monthly write but before acknowledgment, and during concurrent retries across adjacent and non-adjacent months. Each case leaves one canonical record at the original monthly destination, readable by existing monthly-prefix readers. No retry returns success while that record is missing. Identical entries for two profiles granted to one account are stored separately. Identical entries from two authorized accounts writing the same shared profile dedupe to one record.

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

Native code stores the plan, schedules the earliest items up to the system limit of 64 less two reserved slots, and removes pending alerts that left the plan. One reserved slot holds "SNAP alerts run out soon. Open SNAP to set more." at the coverage end. The other holds the build-expiry warning. In background refresh, native code rolls the window forward from the stored plan. It needs no orbit math to do that.

The screens show `coveredThrough` as "Alerts set through ...". Settings: lead time, which targets, and a sleep window with no alerts.

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
 │ GET /d/manifest.json   Authorization: Bearer ... ───────────────────► check the hash, not revoked, act as that profile
```

- `/api/device/enroll` stays behind a separate Access application that admits anyone with a Google account, with no approval step. Google sign-in runs in the system sheet. The Worker verifies this enrollment application's audience and signed identity, without the website email allowlist. Existing website and owner routes keep their access rules.
- `/d/*` gets an Access bypass application, as `/api/profiles` has today. The Worker's email allowlist, including the check in `calibration-auth.ts`, must not apply to `/d/*` or the Google enrollment callback. The rate-limited `/d/enroll/apple/session` route starts Apple enrollment without a device token. The bootstrap routes `/d/enroll` and `/d/enroll/apple` verify their enrollment proof. Other `/d/*` routes require a device token and fail closed: no token, an unknown token or a revoked token is a 401 with no body detail.
- A device token carries the account that enrolled it. The Worker resolves that account to the same profile and granted profiles as it does for the website (`worker/src/browser-identity.ts`), and `/d/*` acts inside them and no further.
- A token does not expire. It is revoked per device, by the owner, through a route behind Access.
- Every `/d/*` request carries the app's build number, and the owner's device list shows each device's last build. W-63 uses it to know which builds are still in use.
- Bearer-token requests carry no cookie, so the same-origin write rule that guards the website does not apply to `/d/*`. The design note for work package W-20 states that reasoning for the security review.
- Reading the installed plan never needs a valid token. A rejected token shows a clear state and keeps every stored byte.
- An enrollment test uses new Apple and Google accounts absent from the website allowlist. Each enrolls without approval, gets only its own profile, and still cannot reach website or owner-only routes without their existing authorization.

### Sign in with Apple

```
App                                                     Worker
 │ POST /d/enroll/apple/session ──────────────────────► create a short-lived session with an unpredictable nonce
 │ ◄────────────── {session_id, nonce} ────────────────┘
 │ Set the nonce on the native Apple authorization request
 │ Receive the identity token from Apple
 │ POST /d/enroll/apple {session_id, identity_token, label} ─► verify the token and atomically consume the session
 │ ◄────────────────── {token, profile} ─────────────────────┘
```

The Worker verifies the token's signature against Apple's published keys, issuer (`https://appleid.apple.com`), audience (the app's bundle ID), and expiry. It requires the signed `nonce` claim to match the nonce stored for `session_id`. An atomic consume must succeed while the session is unexpired and unused before the Worker creates a new account or issues a device token. Only one request can consume the session. [Apple's identity-token verification](https://developer.apple.com/documentation/signinwithapple/verifying-a-user)

The account key is the Apple user identifier, not the email: an Apple ID can hide its email behind a relay address. Sign-up is open: any Apple ID or Google account gets a profile at once. The Worker's email allowlist does not apply to `/d/*`; abuse control is the daily rate limit, per-account quotas on targets and log entries, and revocation from the owner's device list.

An identity token proves identity but cannot revoke Apple's authorization. At account deletion, the native Apple sheet obtains a fresh authorization code, reauthenticating if needed. The app sends the code and identity token to `/d/account/delete` through native networking. The Worker verifies that the Apple subject matches the account being deleted and exchanges the code at `POST https://appleid.apple.com/auth/token` with `grant_type=authorization_code`. It verifies the returned identity and durably stores the revocable refresh or access token encrypted for the deletion job. An expired or already-used code needs a fresh authorization, not a retry of the same code.

The owner configures a server-only Sign in with Apple private key with the capability enabled, its key ID, the Apple Developer Team ID and the app's client ID (bundle ID). The Worker uses these to sign a short-lived ES256 client-secret JWT. This is separate from the App Store Connect release key. No credential value goes in the repository, app bundle or logs. See Apple's [private-key setup](https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key), [token validation](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens) and [account deletion guidance](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple).

### Profiles, sign-out and deletion

- Each account has its own profile, resolved by the Worker as for the website. A new account starts with an empty personal target list on top of the curated baseline.
- One account per device at a time. Sign-out deletes the device token and keeps the account's unsent entries. Drain sends entries only for the signed-in account and uses each entry's original selected profile even if another profile is now selected. The Worker checks the account's grant for that profile on upload.
- "Delete account" asks once, then calls `/d/account/delete` with the signed-in device token. For an Apple account it uses the fresh authorization flow above. Reject wrong-account Apple proof before accepting deletion. If that account has a revocable Apple token, persist a resumable deletion job with the encrypted provider token before invalidating device access. The Worker blocks account use, removes the profile's targets and device tokens, and applies the owner's log-retention rule to both monthly records and canonical dedupe payloads. For Google accounts, remove the account record directly. The app clears that account's local outbox, Keychain and stored personal data and returns to the baseline.
- For an Apple account, the job calls `POST https://appleid.apple.com/auth/revoke` with form fields `client_id`, the signed `client_secret`, `token`, and the matching `token_type_hint`. A `200` response, including for an already-revoked token, completes revocation. The job then removes the retained provider token and account record. See Apple's [token revocation endpoint](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens).
- A timeout, lost reply or transient Apple failure keeps the deletion job pending. Worker-owned retries resume that job with backoff using the retained provider token, even after a Worker interruption or app closure. Credential-configuration failures remain visible for repair. Pending revocation returns `202` and the app reports it as pending, never complete. A client replay with a revoked device token gets the normal `401`; it cannot create another deletion job or imply completion. Full completion requires both Apple revocation and SNAP cleanup.
- If the signed-in person confirms deletion but cannot obtain a revocable token or fresh code, SNAP still deletes the account record, account data and device credentials. The app states that Apple revocation is incomplete and directs the person to revoke SNAP in their Apple account settings, as TN3194 requires. Apple credential-revocation notifications clear any remaining local credential and return the app to the baseline.
- Deletion tests cover a matching fresh code, wrong-account proof, an expired or consumed code requiring reauthentication, Apple token-exchange and revocation failures, a lost revocation reply, interruption and repeated deletion, and the no-token manual-revocation path. They verify that account access is blocked, no false completion is reported, retries finish once, and deleted credentials and personal data are removed.
- The owner's device list shows each account, its devices and their last build, and can revoke any of them.

### Before sign-in

A signed-out app needs no token. It reads the curated targets built into the app and fetches the ISS element set from CelesTrak directly, at most every few hours, falling back to the element set built into the app. Nothing behind the map's sign-in is served without a token.

## What happens when

| Moment | What happens |
| --- | --- |
| First launch, no account | The baseline: curated targets built into the app, passes computed on the device, the map and the ISS view. A Sign in button offers Sign in with Apple and Google. |
| Cold launch, no signal | The shell loads from the app. `/manifest.json` and the artifacts come from the installed plan. The map draws from the baseline and the tile store. The ISS moves from the stored orbit data. The banner says LOS and the plan's age. |
| The link returns, app closed | If iOS grants a background refresh: sync installs a newer plan, the outbox drains, alerts roll forward. If it does not, all of that happens at the next open. |
| Shoot tapped with no signal | The entry is written to the outbox, then the screen confirms. It uploads once when the link returns. |
| The web process is killed | The web view delegate reloads the shell. The web side restores the tab and the aim from storage, as it does after a browser reload. |
| An install is interrupted | The staging folder is discarded at next launch. The previous plan stays current. |
| The token is rejected | Sync and the outbox pause. A banner offers sign-in. Reading continues. |
| The orbit data is old | Past 48 hours the position readout shows the age. Alerts keep firing with the age in their text. |
| Storage is nearly full | Tile storing stops first. Plans and the outbox are never trimmed. |
| A newer plan lacks a field this build needs | It is not installed. The previous plan stays current. A banner says an update is needed. |
| A new build is installed over the old one | The credential, installed plans, outbox, kept tiles and settings carry over. |
| The build nears expiry | A banner from 30 days out, an alert at 10 days out. |

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
