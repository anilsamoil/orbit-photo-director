# Calibration Authentication

Google sign-in to the map authorizes Shoot, Skip, ratings, calibration-log
reads and personal-target synchronization. A second user-entered calibration token is not required.

The Worker validates the signed Cloudflare Access assertion with `jose`: RS256
signature, configured issuer and application audience, expiration and required
user identity claims. An email header alone is never trusted. Session-authenticated
writes must be same-origin. Cloudflare public keys are cached with bounded fetch
timeouts. Invalid/missing credentials fail closed; no Access policy was expanded.

Browser target sync uses `/api/browser/profiles/<name>/targets`, under the
existing Google Access application. The legacy `/api/profiles` path keeps its
server-to-server Access bypass and existing machine-key clients. Both routes
validate authentication before reading or writing storage. No browser key
control remains. Browser ownership is resolved by `GET /api/browser/session`
from the verified issuer and subject; shared URL parameters cannot select another
account. Unknown accounts get a stable `u-` namespace. Browser target CRUD and
signed-session log reads/writes enforce that resolved profile before storage.
Machine-key clients retain explicit named-profile access for the generator.

`ACCESS_PROFILE_BINDINGS` is a private Worker secret containing optional explicit
legacy owner aliases: `{"email:<SHA256(normalized-email)>":"anil"}`. Stage it before
deploying identity enforcement. Never claim a legacy profile from a URL or let the
first visitor take it. Invalid configuration fails closed. Existing generated
opportunity artifacts remain shared map data; account target CRUD and ratings
are the owned data boundary.

The frontend waits for identity before personal hydration, cached snapshots or
rating queue drain. Offline reload can resume only this tab's last verified
identity, with a visible offline label and writes held until a fresh verification.
An HTTP/authentication failure never falls back to a previous account. Snapshots,
reminders and rating queues are account-scoped; only the verified Anil alias may
read legacy global caches. Foreign/unstamped queued entries are retained unsent.
No profiles or existing offline data are cleared during this migration.

The client sends same-origin credentials, preserves queued data on expired
sessions/network errors and accepts only an API `{ok:true}` receipt as a save.
A redirect or HTTP200 login page is not success. The Log tab offers a
profile-preserving `/api/app` sign-in link only after an authentication failure;
valid sessions show no extra sign-in control. Failed reads remain distinct from
empty history. Single-flight draining acknowledges records individually without
overwriting entries created during a network request. Existing R2 idempotency,
payload validation, size limits and daily rate limit are unchanged.

Configuration: `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` identify the existing map
Access application; neither is a secret. Do not copy a browser JWT into source,
logs or configuration. `CALIB_TOKEN` stays a Worker secret for legacy clients.

Verification includes real signed synthetic JWTs, expired/wrong audience/issuer/
signature cases, spoofed headers, cross-origin requests, key-service failures,
legacy-profile compatibility, rating persistence/dedupe and queued-client failures.
Production smoke should use existing queued owner entries, never fabricate a
rating in the operational dataset. Anonymous browser API requests must still hit Access; anonymous legacy-profile
requests reach the Worker and return 401. Direct Worker requests without credentials fail.

Deploy the Worker first, then additive web assets, index.html and sw.js last.
Rollback Worker via its recorded previous deployment; restore previous web root
files without deleting old assets or user storage. Do not restart local map,
relay, fantasy or VPN processes for this web-only change.

Primary reference: [Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

Phone recovery: open `/api/app` in the same browser to fetch the latest
shell through the existing `/api/` service-worker navigation bypass. The route
is Google-protected, returns HTML with `Cache-Control: no-store`, uses root-relative
assets, and never clears storage. A standalone iOS Home Screen app may have its
own storage: keep it installed and preserve any unsynced ratings there. Opening
the URL in Safari does not copy data from that separate app.

New accounts can save personal pins immediately. Tapping a saved pin offers
on-device geometric ISS passes from the current TLE, explicitly without weather
scoring. Automatic scored personal Queue/Upcoming artifacts are currently produced
only for the generator's existing named profiles; creating an account does not
silently enroll another expensive generator slice.

Cross-device additions are fetched on normal boot even when local targets exist.
Hydration adds missing valid server IDs and preserves local values and unsynced
items. It defers when edits are underway; reload after editing to sync again.
This is deliberately additive: remote edits/deletions of already-local IDs do not
automatically replace local work. The personal card Hide shortcut now performs
the same server DELETE as the profile list, with per-target rollback on failure.
