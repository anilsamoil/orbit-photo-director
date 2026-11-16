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
| extended queue | Passes the device computes past the published horizon. Geometry and lighting only. |
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
| `durable` | Kept on disk after fetch, inside a size budget | GIBS daily true colour (latest two days), SNAP forecast cloud frames |
| `session` | Kept briefly | Geostationary IR, RealEarth Meteosat |
| `network` | Fetched as viewed with ordinary HTTP caching. Never bundled, never bulk-fetched. | Esri imagery, Esri dark grey, Esri reference labels |

The gateway answers in this order: baseline pack, tile store, network. A miss with no network returns nothing and the map overzooms the baseline. The baseline sits under the online layers in the map style, so a missing Esri tile shows Earth, not black.

Prefetch stays as modest as today: the world view of the dated layers once a day, and one tile per zoom near the top three targets after each new plan.

## Native parts

`OPDKit` holds the logic and is pure Swift so it can be built and tested on the Mac today, which has Swift but no Xcode. Tests use Swift Testing. Every part takes its clock, file system root and transport as parameters.

| Part | Job | The property its tests must hold |
| --- | --- | --- |
| PlanStore | Stores installed plans under Application Support. Keeps the current plan, the previous one and one more. | Stop the process between any two steps of an install: `current` still resolves to a complete plan whose every artifact matches its SHA-256. |
| SyncEngine | Checks the manifest, downloads to a staging folder, verifies, installs, backs off on failure. Runs on foreground, on connectivity, on a timer and in background refresh. | A failed or partial download never changes `current`. A newer version always wins; an older one never replaces a newer one. |
| Outbox | One file per unsent write, named by its dedupe key. | An entry is deleted only after the server answers `{ok:true}`. A lost response followed by a retry produces one server record. Nothing is dropped to make room. |
| TileGateway | The lookup order and the size budget. | The baseline is never evicted. Local bytes are returned without touching the network. |
| AlertPlanner | Chooses which alerts to schedule from the alert plan. | Never more than the system limit. The coverage end it reports equals the last scheduled alert. |
| CredentialStore | Protocol here; Keychain behind it in `OPDHost`. | The token never appears in a log, a diagnostics export or JavaScript. |
| Diagnostics | A capped event log and a snapshot. | The export contains no token and no personal target coordinates. |

`OPDHost` is the thin iOS layer: the bridge, the background refresh task, the notification centre, the Keychain, the sign-in sheet and the web view delegate.

## The queue past the published horizon

The generator scores passes for 36 hours (`generator/config.py:22`) and publishes the top 25 (`:26`). That stays the authority inside its horizon.

Past it, `frontend/src/plan-extend/` computes passes on the device for up to seven days, from the published target list, the personal targets and the newest orbit data. It reuses the pass finder that already serves dropped pins (`frontend/src/pin-drop.ts`) and the sun and terminator math. It fills geometry, lighting regime and a score from regime fit, distance from nadir and priority, the same three formulas as `generator/score.py`. It fills no cloud number.

Each computed pass is marked `provenance: 'device'`. The screens show them after the published passes, under their own heading, tagged "geometry only". A script in the repository runs the Python pass finder on a fixed orbit and target set and writes reference vectors. The TypeScript tests must match them inside the generator's own sampling step. That is what keeps the two from drifting.

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
 │ enroll ───────────► GET /api/device/enroll ──► Google or PIN ───────► verify the Access identity and the allowlist
 │                     ?challenge=...                                    create a one-time code (5 minutes),
 │                                                                       bound to the profile and the challenge
 │ ◄────────────────── redirect snap-enroll://done?code=... ◄────────────┘
 │ POST /d/enroll {code, verifier, label} ─────────────────────────────► check the code and the verifier, mint a token,
 │                                                                       store its SHA-256 with the profile and the label
 │ ◄──────────────────────────────── {token, profile, device_id} ◄──────┘
 │ store the token in the Keychain
 │ GET /d/manifest.json   Authorization: Bearer ... ───────────────────► check the hash, not revoked, act as that profile
```

- `/api/device/enroll` stays behind Access. A person signs in once, in the system sheet, with Google or the one-time PIN.
- `/d/*` gets an Access bypass application, as `/api/profiles` has today. The Worker is the only gate on that path, so it fails closed: no token, an unknown token or a revoked token is a 401 with no body detail.
- A device token carries the account that enrolled it. The Worker resolves that account to the same profile and granted profiles as it does for the website (`worker/src/browser-identity.ts`), and `/d/*` acts inside them and no further.
- A token does not expire. It is revoked per device, by the owner, through a route behind Access.
- Bearer-token requests carry no cookie, so the same-origin write rule that guards the website does not apply to `/d/*`. The design note for work package W-20 states that reasoning for the security review.
- Reading the installed plan never needs a valid token. A rejected token shows a clear state and keeps every stored byte.

The fallback, if the review prefers no new token code: one Cloudflare Access service token per device, mapped to a profile by its `common_name`, entered once by the owner. The Worker already recognises service principals on `/api/health` (`worker/src/calibration-auth.ts:149`).

## What happens when

| Moment | What happens |
| --- | --- |
| Cold launch, no signal | The shell loads from the app. `/manifest.json` and the artifacts come from the installed plan. The map draws from the baseline and the tile store. The ISS moves from the stored orbit data. The banner says LOS and the plan's age. |
| The link returns, app closed | If iOS grants a background refresh: sync installs a newer plan, the outbox drains, alerts roll forward. If it does not, all of that happens at the next open. |
| Shoot tapped with no signal | The entry is written to the outbox, then the screen confirms. It uploads once when the link returns. |
| The web process is killed | The web view delegate reloads the shell. The web side restores the tab and the aim from storage, as it does after a browser reload. |
| An install is interrupted | The staging folder is discarded at next launch. The previous plan stays current. |
| The token is rejected | Sync and the outbox pause. A banner offers sign-in. Reading continues. |
| The orbit data is old | Past 48 hours the position readout shows the age. Alerts keep firing with the age in their text. |
| Storage is nearly full | Tile storing stops first. Plans and the outbox are never trimmed. |
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
