import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      // registerType: 'prompt' — vite-plugin-pwa's 'autoUpdate' silently
      // injects e.clientsClaim() into the SW, which forces the new SW to
      // take over existing tabs immediately. V2 plan explicitly forbids
      // this (it's the multi-tab race the plan was designed to prevent).
      // 'prompt' lets the workbox config below decide skipWaiting/claim
      // honestly. We don't show a UI prompt — main.ts silently triggers
      // update() so the new SW activates on install and takes over only
      // on next navigation.
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
        name: 'Orbit Photo Director',
        short_name: 'OPD',
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
        globPatterns: ['**/*.{js,css,html,svg,ico,woff2}'],

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
            // Carto basemap tiles: CacheFirst LRU bounded.
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
            // GIBS true-color tiles: CacheFirst with shorter TTL (imagery
            // is daily; the imagery-date badge surfaces staleness in the UI).
            urlPattern: /^https:\/\/gibs\.earthdata\.nasa\.gov\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opd-tiles-gibs',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24, // 24h
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

      // Don't auto-inject `<link rel="manifest">` — we'll keep index.html clean.
      // vite-plugin-pwa handles manifest.webmanifest generation; the link is
      // injected by injectRegister: 'auto' above.
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
