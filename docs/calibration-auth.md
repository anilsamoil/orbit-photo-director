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
control remains. Profiles remain shared trusted-user namespaces, not individual ACLs.

The client sends same-origin credentials, preserves queued data on expired
sessions/network errors and accepts only an API `{ok:true}` receipt as a save.
A redirect or HTTP200 login page is not success. The Log tab provides the normal
sign-in link. Single-flight draining acknowledges records individually without
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

Phone recovery: open `/api/app?u=anil` in the same browser to fetch the latest
shell through the existing `/api/` service-worker navigation bypass. The route
is Google-protected, returns HTML with `Cache-Control: no-store`, uses root-relative
assets, and never clears storage. A standalone iOS Home Screen app may have its
own storage: keep it installed and preserve any unsynced ratings there. Opening
the URL in Safari does not copy data from that separate app.
