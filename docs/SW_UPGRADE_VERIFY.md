# SW Upgrade Verification — Real-Chrome Checklist

This is the eyes-on-glass companion to `scripts/verify-sw-upgrade.sh`.
The script catches programmatic regressions in `dist/sw.js` shape; this
checklist catches the things only a real browser can show — multi-tab
controller races, PWA install drift, devtools-only signals, and the
"does it actually feel right" judgment.

**Run when:** any deploy that touches `frontend/vite.config.ts`,
`vite-plugin-pwa` config, the runtime caching rules, or after the V3.0
ship (which is the natural "v2" deploy in the V2-P0 recipe).

**Time:** ~5 minutes if everything passes. ~15 if you have to investigate.

---

## Setup (30 seconds)

1. Open `https://map.astroanil.dev` in a fresh Chrome window. **Don't**
   close the previous tab if you have one open — we want the multi-tab
   case live.
2. Open DevTools → Application → Service Workers (left sidebar).
3. Open DevTools → Application → Cache Storage (left sidebar).

---

## The 6 checks

### 1. SW activated cleanly

- **Look for:** "Status: activated and is running" in the SW panel
- **Source URL** should match `https://map.astroanil.dev/sw.js`
- **Console** should be free of red errors (warnings about workbox dev
  routing logs are fine)

❌ Fail mode: status stuck on "redundant" or "trying to install" → SW
script itself is throwing. Inspect `dist/sw.js` source for syntax errors
or import failures.

### 2. Caches populated

In Application → Cache Storage you should see:

- `workbox-precache-v2-https://map.astroanil.dev/` — 8+ entries, ~900 KB
- `opd-manifest` — 1 entry (just `manifest.json`)
- `opd-versioned-artifacts` — 3+ entries after a few seconds (top5,
  top_24h, track from the current version)
- `opd-tiles-carto` — populates only after you visit the Map tab and pan
  somewhere
- `opd-tiles-gibs` — same as carto

❌ Fail mode: precache empty or under 8 entries → globPatterns regression.
Cache names different from above → vite.config.ts cacheName changed
without intent.

### 3. Offline reload renders the queue from snapshot

1. DevTools → Network → set throttle to "Offline"
2. Refresh the page (Cmd-R)
3. Observe: queue cards render in <1s with "LOS · X min ago" banner
4. The queue should match what you saw before going offline

❌ Fail mode: blank page on reload → SW didn't precache app shell, OR the
snapshot path crashed. Console will tell you which.

### 4. SW upgrade lifecycle (multi-tab)

This is the V2-P0 multi-tab safety property:
**existing tabs keep their old SW until natural navigation; new tabs get
the new SW immediately.**

1. Open a SECOND tab to `map.astroanil.dev`.
2. Both tabs should show the same SW URL (`/sw.js`) and Status:
   activated.
3. Take note of the asset hash in the page source: `assets/index-XXXX.js`
4. Now deploy a new build to R2 (or wait for the next deploy).
5. In Tab 1, open DevTools → Application → Service Workers. Click
   "Update" — you should see "Status: redundant" on the OLD SW and a NEW
   SW appear with status "activated" but **NOT** controlling Tab 1 yet.
6. Tab 1's page source should still show the OLD asset hash.
7. Tab 1 → soft-navigate (e.g., click a tab) — SW should swap to NEW.
8. Tab 1 → reload — NEW asset hash now visible.
9. **Critical:** during steps 5-7, Tab 2 should ALSO still be on the OLD
   SW. The new tab you open AFTER the deploy gets the new SW.

❌ Fail mode: Tab 1 swaps controllers without nav → `clientsClaim`
regression in vite.config.ts.

### 5. localStorage snapshot survives the upgrade

After step 4, in either tab:

1. DevTools → Application → Local Storage → `https://map.astroanil.dev`
2. `opd-snapshot` key should still exist with the same recent timestamp
3. The frontend should not have re-fetched and re-rendered from scratch
   on the upgrade — the snapshot path should still be feeding it

❌ Fail mode: snapshot cleared → either init() crashed and clearSnapshot
fired, or the SW upgrade nuked storage (it shouldn't — service workers
don't touch localStorage).

### 6. Tile cache survives the upgrade

After step 4, switch to the Map tab. Pan around regions you previously
visited:

1. Tiles should load instantly (from `opd-tiles-carto` and
   `opd-tiles-gibs` caches)
2. Pan to a NEW region — tiles fetch from network (or fail if offline)
3. Cache Storage → `opd-tiles-carto` entry count should NOT have dropped
   to zero; LRU growth is normal

❌ Fail mode: Map tab blank for previously-cached regions → cache name
changed in vite.config.ts (Workbox treats a renamed cache as fresh and
abandons the old one).

---

## When checks pass

Update `TODOS.md` V2-P0 entry: change `Must pass before launch.` to
`Verified <date>: SW upgrade lifecycle clean on <commit-sha>.`

If running this against the V3.0 deploy, also note the verified-against
version in the V3.0 PR body.

## When checks fail

1. Don't deploy further until resolved.
2. The `kill-switch DNS` (V2-P1 Lane G TODO) is the recovery path if a
   buggy SW ships and reaches Chris's iPad.
3. Capture screenshots of the failing state for the incident log
   (`docs/MISSION_LOG.md`).
