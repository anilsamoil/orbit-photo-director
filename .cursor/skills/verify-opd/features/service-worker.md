# Service worker

The production build registers a Workbox service worker. Vite dev does not emit `sw.js`. This check uses a preview of a build kept outside the repo.

## Sub-features

- `sw-script` fetches `/sw.js` with a JavaScript content type.
- `sw-lifecycle` finds `skipWaiting` and `clientsClaim`.
- `sw-caches` finds NetworkFirst, CacheFirst, NetworkOnly, and the `opd-` cache names.
- `sw-manifest` fetches `/manifest.webmanifest` with `start_url`.

## How to get to it (user POV)

- Install or reload the built app. There is no button for the service worker.
- The eyes-on checklist for a real deploy is `docs/SW_UPGRADE_VERIFY.md`.

## Driving it with opd-verify

Preconditions:

- `bun` can build `frontend/`.
- Port `41733` is free, or set `OPD_VERIFY_PREVIEW_PORT`.

- **Build and check.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs sw`. The command builds into `$OPD_VERIFY_HOME/preview-dist`, serves it with the worker's JavaScript content type, and runs `scripts/verify-sw-upgrade.sh` against that origin.
- **Proof.** Exit code 0, and `evidence/service-worker.txt` names that origin. The preview process is stopped before the command returns.

## Gotchas

- `scripts/verify-sw-upgrade.sh https://map.astroanil.dev` fails closed while Cloudflare Access answers with a login redirect. That failure is not a bad build. Use `opd-verify sw`, or send Access service-token headers yourself.
- `docs/SW_UPGRADE_VERIFY.md` section 4 still treats a controller swap without navigation as a `clientsClaim` failure. The build sets `clientsClaim: true` in `frontend/vite.config.ts`, and `sw` requires `clientsClaim()` in `/sw.js`. That swap is the current behavior. The opening comment on the VitePWA block still says `clientsClaim: false`.
- `sw` does not start the dev server from `up`, and it does not need `doctor`.
- The build output stays under `$OPD_VERIFY_HOME/preview-dist`. It is not a product source change.
- Vite preview labels `sw.js` as `text/javascript`. `scripts/verify-sw-upgrade.sh` requires `application/javascript`, matching `worker/src/index.ts`. The skill's static server sets that type. Do not point the script at `vite preview` and expect this check to pass.
