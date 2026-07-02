import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Read the repo-root VERSION file at build time so the app version stamped
// into JSON export envelopes (and any other operator-visible build marker)
// tracks the slot/ship pipeline automatically. Previously hardcoded into
// `profile-crud.ts` as `APP_VERSION = '1.6.12.0'` — stale on every ship.
const APP_VERSION = readFileSync(resolve(__dirname, '../VERSION'), 'utf-8').trim();

export default defineConfig({
  define: {
    // Substituted as a string literal everywhere `__APP_VERSION__` appears
    // in src/. Vitest does NOT run vite's define pass; modules that read
    // this must provide a runtime fallback for the test environment.
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    VitePWA({
      // registerType: 'prompt' — vite-plugin-pwa's 'autoUpdate' silently
      // injects e.clientsClaim() into the SW, which forces the new SW to
      // take over existing tabs immediately. V2 plan explicitly forbids
      // this (it's the multi-tab race the plan was designed to prevent).
      // 'prompt' lets the workbox config below decide skipWaiting/claim
      // honestly. We don't show a UI prompt and don't import
      // virtual:pwa-register — workbox.skipWaiting:true (below) is what
      // makes the new SW activate on install; clientsClaim:false keeps
      // existing tabs on their old SW until natural navigation.
      registerType: 'prompt',
      injectRegister: 'auto',

      // Use generateSW (Workbox builds the SW from the routing config below).
      // injectManifest would be needed if we wanted custom non-Workbox SW logic,
      // which we don't — the V2 plan's routing rules are pure Workbox patterns.
      strategies: 'generateSW',

      // PWA manifest. SVG-only icons for V3.0 — most modern browsers accept
      // SVG. iOS Safari falls back to apple-touch-icon (the existing inline
      // SVG favicon in index.html). Real PNG icons are TODO V2-P3 polish.
      manifest: {
        name: 'SNAP (SNAP\'s Not an Astro Photographer)',
        short_name: 'SNAP',
        description: 'Earth-photography planner for the ISS shot queue.',
        theme_color: '#0b0d12',
        background_color: '#0b0d12',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            // Inline SVG matching the existing index.html favicon (satellite emoji).
            // Browsers that don't support SVG icons fall back to apple-touch-icon.
            src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%230b0d12'/%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%9B%B0%EF%B8%8F%3C/text%3E%3C/svg%3E",
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },

      workbox: {
        // Precache the app shell at install time. Hashed assets (index-X.js,
        // index-X.css, etc.) get content-hash filenames from Vite, so they're
        // safe to precache aggressively.
        // v1.4.3.0: added `geojson` so the coastline overlay
        // (ne_110m_coastline.geojson, ~80KB) is part of the offline shell.
        // Without this, the world-map outline goes missing as soon as the
        // operator loses connectivity, even though the basemap tiles and
        // ground track already work offline.
        globPatterns: ['**/*.{js,css,html,svg,ico,woff2,geojson}'],

        // skipWaiting: new SW activates as soon as installed (doesn't sit in
        // 'waiting' state). clientsClaim=false: existing tabs keep their old
        // SW until navigation. Per V2 plan: prevents the "new SW + old JS"
        // multi-tab race that comes with clientsClaim=true.
        skipWaiting: true,
        clientsClaim: false,

        // Don't precache the source-map files — they're huge and only useful
        // when the dev tools are open.
        globIgnores: ['**/*.map'],

        // Runtime cache routing per the locked V2 plan.
        runtimeCaching: [
          {
            // manifest.json: NetworkFirst with 2s timeout. Falls back to cache
            // when offline OR when the network is so slow it'd hang the boot
            // path. The frontend's snapshot-first boot already handles the
            // common LOS case; this is the SW-level second line of defense.
            urlPattern: /\/manifest\.json(\?.*)?$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'opd-manifest',
              networkTimeoutSeconds: 2,
              expiration: {
                maxEntries: 1,
                maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days; manifest changes hourly so this is just an upper bound
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // V4-P2 forecast cloud frames: CacheFirst, immutable — the path
            // carries the GFS run key (/clouds-fcst/<run>/<frame>/z/x/y.png)
            // so a new run never collides with a cached one. Online-only by
            // default (locked A5): nothing precaches these; the cache just
            // keeps already-viewed frames cheap while scrubbing. LRU-capped
            // at ~3 frames' worth of tiles; runs rotate twice a day so the
            // TTL is an upper bound, not the eviction driver.
            urlPattern: /\/clouds-fcst\/\d{8}T\d{6}Z\/.*\.png(\?.*)?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opd-tiles-fcst',
              expiration: {
                maxEntries: 256,
                maxAgeSeconds: 60 * 60 * 24, // 24h — two render cycles
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Versioned artifacts: CacheFirst, immutable. The path includes
            // the version slug (/v/YYYYMMDDTHHMMSSZ/...) so different
            // versions get different cache keys and never overwrite.
            urlPattern: /\/v\/\d{8}T\d{6}Z\/[^/]+\.json(\?.*)?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opd-versioned-artifacts',
              expiration: {
                // Cap at 60 entries (~10 versions × 6 artifacts) so the cache
                // doesn't grow unbounded as the daemon publishes new versions
                // hourly across the 8-month mission.
                maxEntries: 60,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // World-view basemap tiles (z0-3): a SEPARATE long-lived cache from
            // opd-tiles-carto below. The map opens at z2 (world view), but the
            // per-target precache only covers z6/8/10 — so the default view was
            // a cache miss → black map offline (observed 2026-06-06). These ~85
            // tiles (z0:1+z1:4+z2:16+z3:64) are static (the dark basemap never
            // changes), so 30d TTL and a dedicated cache that natural-pan LRU
            // eviction can never touch. MUST be registered BEFORE the general
            // carto rule below — Workbox matches routes in registration order,
            // and z0-3 URLs also match the general /cartocdn\.com\// pattern.
            urlPattern: /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/dark_all\/[0-3]\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opd-tiles-carto-base',
              expiration: {
                maxEntries: 90,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days — static basemap
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Carto basemap tiles: CacheFirst LRU bounded.
            // statuses [0, 200] — both opaque (status 0) and real-CORS
            // (status 200) responses cache. MapLibre's tile <img> fetches
            // are no-cors → opaque status 0; the V4-P2 precache uses
            // fetch() with default CORS → real status 200. Both code
            // paths need to populate this cache.
            //
            // Earlier v1.2.2.0 narrowed to [200] only to avoid caching
            // opaque 429/5xx as "valid" tiles. In production that
            // regressed both paths: precache fires before the SW takes
            // control on first load (so opd-tiles-* never seeds), and
            // MapLibre's natural pan path is the only fallback — and
            // its opaque responses were being rejected, leaving the map
            // blank on subsequent loads. The cached-error risk is
            // theoretical at our request volume; the broken-tile
            // operational failure was observed. Revert to [0, 200].
            urlPattern: /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opd-tiles-carto',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // World-view GIBS tiles (z0-3) for BOTH the cloud overlay and VIIRS
            // night-lights: a dedicated cache so the world view of those layers
            // survives offline regardless of natural-pan LRU. Without it, a
            // layer toggled on offline over an unvisited area shows nothing
            // (a hidden layer never fetched its tiles). The `Level\d/[0-3]/`
            // match pins it to z0-3 only (z10 etc. fall through to the general
            // gibs rule below). MUST precede that rule (Workbox first-match).
            urlPattern: /^https:\/\/gibs\.earthdata\.nasa\.gov\/.*GoogleMapsCompatible_Level\d\/[0-3]\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opd-tiles-gibs-base',
              expiration: {
                maxEntries: 200, // ~85 clouds + ~85 VIIRS at z0-3
                maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // GIBS true-color tiles: CacheFirst with shorter TTL (imagery
            // is daily; the imagery-date badge surfaces staleness in the UI).
            // statuses [0, 200] — see carto rationale above.
            urlPattern: /^https:\/\/gibs\.earthdata\.nasa\.gov\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opd-tiles-gibs',
              expiration: {
                maxEntries: 200,
                // 7 days (was 24h). A day-stale cloud layer beats a BLANK one
                // offline; the imagery-date badge already surfaces staleness.
                maxAgeSeconds: 60 * 60 * 24 * 7,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // World-view Esri imagery (z0-3): dedicated cache so the clouds-OFF
            // basemap renders offline at world view, like opd-tiles-carto-base
            // does for the clouds-ON basemap. /tile/[0-3]/ pins it to z0-3;
            // deeper zooms fall through to the general esri rule. MUST precede it.
            urlPattern: /^https:\/\/server\.arcgisonline\.com\/.*\/MapServer\/tile\/[0-3]\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opd-tiles-esri-base',
              expiration: {
                maxEntries: 90, // z0-3 = 85 tiles
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days — imagery is static
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Esri World Imagery tiles (v1.5.1.0 — clouds-off basemap for
            // Chris's "feature picking" workflow). CacheFirst LRU bounded
            // same as Carto. Tile size ~100KB vs Carto's ~30KB so total
            // cache footprint stays well under quota.
            urlPattern: /^https:\/\/server\.arcgisonline\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opd-tiles-esri',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // POST /api/log: NetworkOnly. The existing offline-queue logic in
            // calib.ts handles the "queue locally if network fails" path;
            // we don't want the SW to interfere with that.
            urlPattern: /\/api\/log(\?.*)?$/,
            handler: 'NetworkOnly',
            method: 'POST',
          },
        ],

        // Don't cache cross-origin opaque responses by default — opaque
        // responses inflate cache size and can mask 404s as cached "successes".
        // The runtimeCaching rules above scope the tile sources we DO want.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api\//,        // API routes go straight to network
          /^\/v\//,          // Versioned artifact paths handled by their own rule
          /\/manifest\.json/, // manifest.json handled by its own rule
        ],
      },

      // Don't include extra static assets in the precache from outside the
      // build dir. (vite-plugin-pwa generates manifest.webmanifest + injects
      // the <link rel="manifest"> + the registerSW <script> into index.html
      // automatically as part of injectRegister: 'auto'.)
      includeAssets: [],
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    minify: 'esbuild',
    // Bump warning threshold above MapLibre's natural ~800KB. We KNOW about
    // it, it's lazy-loaded on Map-tab click, and "your code is too big" is
    // the wrong signal for a vendor library.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Pin MapLibre into its own vendor chunk. App-only updates (most
        // commits) leave the MapLibre cache intact on the ISS-side device,
        // so the second visit re-downloads only the small app chunk
        // (~5 KB gzipped) instead of the full 220 KB.
        manualChunks: (id) => {
          if (id.includes('node_modules/maplibre-gl/')) return 'maplibre-vendor';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/map.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
