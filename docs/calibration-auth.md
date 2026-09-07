# Calibration Authentication

Google sign-in to the map now authorizes Shoot, Skip, ratings and calibration-log
reads. A second user-entered calibration token is not required.

The Worker validates the signed Cloudflare Access assertion with `jose`: RS256
signature, configured issuer and application audience, expiration and required
user identity claims. An email header alone is never trusted. Session-authenticated
writes must be same-origin. Cloudflare public keys are cached with bounded fetch
timeouts. Invalid/missing credentials fail closed; no Access policy was expanded.

The existing legacy machine key remains supported. `/api/profiles` has a separate
server-to-server Access bypass and retains its original shared-key authorization.
Its optional UI lives under Profile > Legacy target-sync key, not in the rating
flow. Profiles remain shared trusted-user namespaces, not individual ACLs.

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
legacy-profile isolation, rating persistence/dedupe and queued-client failures.
Production smoke should use existing queued owner entries, never fabricate a
rating in the operational dataset. Anonymous public API requests must still
hit Access, and direct Worker requests without credentials must fail.

Deploy the Worker first, then additive web assets, index.html and sw.js last.
Rollback Worker via its recorded previous deployment; restore previous web root
files without deleting old assets or user storage. Do not restart local map,
relay, fantasy or VPN processes for this web-only change.

Primary reference: [Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
