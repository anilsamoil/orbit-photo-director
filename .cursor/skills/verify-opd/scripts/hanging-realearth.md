# Verify painting while RealEarth is pending

Run the full stock Map regression from the repository root.

```sh
node --test .cursor/skills/verify-opd/scripts/hanging-realearth.test.mjs
```

The test starts the normal verify proxy, opens WebKit iPhone 17 Pro at 402x874, and runs every Map drive assertion. Its preload holds only `https://realearth.ssec.wisc.edu/` requests with `page.route` before each page navigates, including replacement contexts. It does not abort the requests or replace other imagery. The output names the retained temporary home, `drive.log`, and `hanging-requests.json`. `OPD_VERIFY_HANG_HOME` selects another home, and `OPD_VERIFY_HANG_PORT` selects the proxy port instead of 42841. The Vite port is the next port.

For another stock Map or ISS cell, use the normal `up`, `doctor`, and `down` commands with a separate `OPD_VERIFY_HOME` and port. Run its drive with the preload and an absolute evidence path.

```sh
OPD_VERIFY_HANG_EVIDENCE="$OPD_VERIFY_HOME/hanging-requests.json" \
node --import ./.cursor/skills/verify-opd/scripts/hanging-realearth-preload.mjs \
  .cursor/skills/verify-opd/scripts/opd-verify.mjs drive iss
```

Set `OPD_VERIFY_SURFACE` and `OPD_VERIFY_VIEWPORT` as for an ordinary drive. Leave `OPD_VERIFY_FIXED_SURFACE` unset. For the stock iPad 834x1194 descriptor, leave `OPD_VERIFY_VIEWPORT` unset. Desktop keeps the ordinary Chrome process and uses CDP `Fetch` to hold the same host. The receipt records intercepted requests, peak pending count, and pending counts before context or CDP teardown. Require a zero drive exit. The targeted Map regression also requires positive pending counts. If another stock drive issues no matching request, record that the interceptor was armed but the provider fault was not exercised on that path. Do not add synthetic requests or change app state to inflate those counts.

Replacement readiness waits for style bootstrap and a real render with a live, nontransparent framebuffer. MapLibre 6.11.2 clears its framebuffer to transparent before painting. The helper then permits up to 1200 ms for idle and validates another painted frame. The 30-second missing-paint deadline still fails. `loaded()` and `isStyleLoaded()` both wait for tiles and cannot define this readiness contract. The four-second clear-frame regression retains the predecessor until painting resumes and checks blue raster pixels at handoff.
