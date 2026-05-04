import { defineConfig } from 'vite';

export default defineConfig({
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
