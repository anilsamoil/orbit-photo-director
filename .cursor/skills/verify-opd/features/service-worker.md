# Service worker

The production build registers a Workbox service worker. Vite dev does not emit `sw.js`. This check uses a preview of a build kept outside the repo.

## Sub-features

- `sw-script` fetches `/sw.js` with a JavaScript content type.
- `sw-lifecycle` finds `skipWaiting` and `clientsClaim`.
- `sw-caches` finds NetworkFirst, CacheFirst, NetworkOnly, and four `opd-` cache name substrings. The build defines more caches than those four checks name.
- `sw-register` finds `src="/registerSW.js"` and `rel="manifest"` in `/`.
- `sw-manifest` fetches `/manifest.webmanifest` with `start_url`.
- `sw-shell` is the shell contract in source. `sw` does not assert it. `frontend/public/registerSW.js` registers `/sw.js` with `updateViaCache: 'none'`. `frontend/vite.config.ts` precaches hashed assets, including both label catalogs through `**/label-catalog*.json` (`label-catalog.json` and `label-catalog-towns.json`), and the unhashed `ne_110m_coastline.geojson`. It does not precache `index.html`. It sets `navigateFallback: null` and imports `public/sw-shell.js`. `sw` does not grep those catalog filenames. `frontend/src/sw-navigation.ts` answers an app navigation with `fetch` of `/` using `cache: 'reload'` and falls back to the `opd-shell` cache. `public/sw-shell.js` seeds that cache on install and, on activate, calls `client.navigate` so an open tab reloads. `worker/src/index.ts` `cacheControlFor` returns `no-cache, max-age=0, must-revalidate` for HTML and for `sw.js`, `registerSW.js`, `sw-shell.js`, and `manifest.webmanifest` even when stored R2 metadata is immutable. Hashed `/assets/*` keep their immutable lifetime.

## How to get to it (user POV)

- Install or reload the built app. There is no button for the service worker.
- The eyes-on checklist for a real deploy is `docs/SW_UPGRADE_VERIFY.md`.

## Driving it with opd-verify

Preconditions:

- `bun` can build `frontend/`.
- Port `41733` is free, or set `OPD_VERIFY_PREVIEW_PORT`.

- **Build and check.** Run `node .cursor/skills/verify-opd/scripts/opd-verify.mjs sw`. The command builds into `$OPD_VERIFY_HOME/preview-dist`, serves `.js` as `application/javascript` from this process (the same type `worker/src/index.ts` uses), and runs `scripts/verify-sw-upgrade.sh` against that origin.
- **Proof.** Exit code 0, and `evidence/service-worker.txt` names that origin on the first line and the time on the second. The command deletes an older proof file before the build. The static server is inside this process and closes before the command returns.

This command does not open a browser. It does not cover iPhone or iPad. `drive` and `drive all` use the Vite dev server, which does not emit `sw.js`, so those WebKit passes do not exercise this worker either.

## Gotchas

- `scripts/verify-sw-upgrade.sh https://map.astroanil.dev` and the same script against `https://map.expedition75.com` fail closed while Cloudflare Access answers with a login redirect. That failure is not a bad build. The script sends no auth headers and no `Cf-Access-Jwt-Assertion`. Use `opd-verify sw` for a local preview. Do not fetch either public host from this skill. The Worker gate is the local vitest file named in `SKILL.md`. `ACCESS_ALLOWED_EMAILS` admits `allowed-one@example.test` and returns 403 `{error: email_not_allowlisted}` for `off-list@example.test` on `/`, `/sw.js`, and `/api/health`. An empty, unset, BOM, or U+00A0 list returns that 403 for every human. `worker/deploy.sh` exits 2 for a blank or newline `ACCESS_ALLOWED_EMAILS` under both `LC_ALL=C` and `LC_ALL=en_US.UTF-8`. Unset, `''`, whitespace-only, BOM-only, and BOM plus whitespace exit 2 with exactly `ERROR: ACCESS_ALLOWED_EMAILS is empty. Refusing to deploy.` and make 0 wrangler calls, on `--dry-run` and without it (#306, `7d4ed3d`). The smoke shim is on `PATH` and at `worker/node_modules/.bin/wrangler`. `bun` and `npm` put `node_modules/.bin` first. Log the `realpath` each entry point resolves, then restore the original link. The entry points are `bash worker/deploy.sh --dry-run`, `bun run deploy --dry-run`, and `npm run deploy -- --dry-run`. `npm run deploy --dry-run` without `--` drops the flag and does a real deploy. The Mac `/bin/bash` 3.2.57 dry run stays on the #288 login-gate checklist in `SKILL.md`. The same script's foreground parser exits 2 on a 10 second stall after `email-allowlist.mjs` loads, exits 127 when `node` is missing, and exits 2 with `parser failed (exit N)` for any other parser status. `DEPLOY_BASH` selects bash 3.2.57 or bash 5 for `worker/deploy.test.sh`. The Mac go-live dry-run is in `SKILL.md`. The Worker go-live is still pending. It is not deployed. When the Mac's wrangler has no R2 auth, `scripts/upload_frontend.sh` cannot run. The sanctioned fallback, used for #291, is additive `rclone copy` in the script's order, with `sw.js` last. It is never `rclone sync`. This skill does not run that fallback.
- `docs/SW_UPGRADE_VERIFY.md` section 4 expects an open tab's controller to swap to the new worker and the tab to reload onto the current shell. `frontend/vite.config.ts` sets `clientsClaim: true`. `sw` requires `clientsClaim()` in `/sw.js`. It does not read `registerSW.js`, `sw-shell.js`, `sw-navigation.ts`, or `cacheControlFor`. A tab that stays on the previous build after the new worker activates is the failure mode in that doc.
- `sw` does not start the dev server from `up`, and it does not need `doctor`.
- The build output stays under `$OPD_VERIFY_HOME/preview-dist`. It is not a product source change.
- Vite preview labels `sw.js` as `text/javascript`. `scripts/verify-sw-upgrade.sh` requires `application/javascript`, matching `worker/src/index.ts`. The skill's static server sets that type. Do not point the script at `vite preview` and expect this check to pass.
