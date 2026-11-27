import { createHash } from 'node:crypto';
import { cp, readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { TILE_COLORS, TILE_COUNT } from './probes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const offlinePolicy = [
  "default-src 'none'",
  "script-src 'self' capacitor://localhost",
  "style-src 'self' capacitor://localhost 'unsafe-inline'",
  "img-src 'self' capacitor://localhost data: blob:",
  "font-src 'self' capacitor://localhost",
  "connect-src 'self' capacitor://localhost",
  "worker-src 'self' capacitor://localhost",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function tilePNG(color = [0, 255, 0, 255]) {
  const chunk = (name, data) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256);
  header.writeUInt32BE(256, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(256 * (1 + 256 * 4));
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const start = y * 1025 + 1 + x * 4;
      pixels.set(color, start);
    }
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export function makeFixture(tle) {
  const now = Date.parse('2026-11-10T00:30:00Z');
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  const pass = {
    target_id: 'g1-synthetic', target_name: 'Synthetic proof target', target_regime: 'day', target_priority: 3,
    target_lat: 28, target_lon: -97, closest_approach: iso(30 * 60_000), nadir_distance_km: 100,
    pass_regime: 'day', obstruction_class: 'clear', p_unobstructed: 0.9, cloud_fraction: 0,
    cloud_source: 'synthetic fixture', score: 80,
    score_components: { p_unobstructed: 0.9, regime_fit: 1, nadir_proximity: 1, priority_weight: 1, tle_freshness: 1 },
    iss_at_closest: { lat: 28, lon: -97, alt_km: 420 },
  };
  const values = {
    passes: [pass], top5: [pass], top_24h: [{ ...pass, target_id: 'g1-later', closest_approach: iso(120 * 60_000) }],
    targets: [{ id: pass.target_id, name: pass.target_name, geom: { type: 'point', lat: 28, lon: -97 }, regime: 'day', priority: 3 }],
    track: {
      iss_polynomial: { start: iso(-60_000), duration_seconds: 14_400, lat_coeffs: [-0.001, 28], lon_coeffs: [0.012, -97], polynomial_order: 1 },
      track_points: [[0, 28, -97], [3600, 24.4, -53.8]], tle: { line1: tle[0], line2: tle[1] },
      tle_epoch: '2026-11-10T00:00:00Z', tle_age_hours: 0.5, tle_freshness_factor: 1,
    },
    status: {
      last_run: iso(), tick_minutes: 60, tle_age_hours: 0.5, tle_freshness_factor: 1, cloud_source: 'synthetic fixture',
      cloud_composite_hour: iso(), target_count: 1, pass_count: 2, version: 'g1-fixture', build_version: 'g1-proof',
    },
  };
  const files = Object.fromEntries(Object.entries(values).map(([name, value]) => [`/v/g1/${name}.json`, JSON.stringify(value)]));
  const manifest = {
    version: 'g1-fixture', generated_at: iso(), tle_epoch: values.track.tle_epoch, cloud_composite_hour: iso(),
    target_data_version: 'g1', build_version: 'g1-proof', freshness: { tle_hours: 0.5, cloud_hours: 0, ok: true },
    artifacts: Object.fromEntries(Object.entries(files).map(([path, body]) => [path.split('/').at(-1).replace('.json', ''), { path: path.slice(1), sha256: sha(body), bytes: Buffer.byteLength(body) }])),
  };
  files['/manifest.json'] = JSON.stringify(manifest);
  const profile = { name: 'g1-fixture', displayName: 'Proof fixture' };
  files['/api/browser/session'] = JSON.stringify({ ok: true, profile, profiles: [profile] });
  const tile = tilePNG();
  return { now, files, tile: tile.toString('base64'), tileSHA256: sha(tile), fixtureSHA256: sha(JSON.stringify(files)) };
}

function replaceRequired(source, anchor, replacement) {
  if (!source.includes(anchor)) throw new Error(`G1 proof build could not find ${anchor}`);
  return source.replace(anchor, replacement);
}

export async function buildProof() {
  const { build } = await import(pathToFileURL(resolve(root, 'frontend/node_modules/vite/dist/node/index.js')));
  const fixture = makeFixture((await readFile(resolve(root, 'tests/fixtures/iss-2026-11-10.txt'), 'utf8')).trim().split('\n'));
  const output = resolve(here, 'dist');
  const result = await build({
    configFile: false, root: resolve(root, 'frontend'),
    define: { __APP_VERSION__: JSON.stringify((await readFile(resolve(root, 'VERSION'), 'utf8')).trim()) },
    plugins: [{
      name: 'g1-proof-source',
      enforce: 'pre',
      transform(source, id) {
        if (id.endsWith('/src/crew-roster.ts')) {
          const withoutRoster = replaceRequired(source, "import rosterJson from '../../data/crew-roster/roster.json?raw';", "const rosterJson = '[]';");
          return replaceRequired(withoutRoster, "import.meta.glob<string>('../../data/crew-roster/*.csv', { query: '?raw', import: 'default', eager: true })", '{} as Record<string, string>');
        }
        if (id.endsWith('/map/adapters/maplibre/iss-g1-page.ts')) {
          return replaceRequired(source, 'void main();', 'export { checksFor, decodePair };');
        }
        if (id.endsWith('/src/map/index.ts')) {
          return replaceRequired(source, 'core = createMapCore(vendor, clock);',
            "core = createMapCore(Reflect.get(window, '__opdG1').guardMapCamera(vendor), clock);");
        }
        if (id.endsWith('/src/iss-view/index.ts')) {
          // The proof owns the camera during scripted jumps. Preset clicks
          // and normal ISS rendering continue to use the real scene.
          return replaceRequired(source, "void paint('timer');",
            "if (Reflect.get(window, '__opdG1')?.heldCamera !== 'iss') void paint('timer');");
        }
      },
    }, {
      name: 'g1-proof-assets',
      enforce: 'post',
      resolveId(id) {
        if (id === '/g1-entry.mjs') return resolve(here, 'entry.mjs');
        if (id === 'virtual:g1-fixture') return '\0g1-fixture';
      },
      load(id) { if (id === '\0g1-fixture') return `export default ${JSON.stringify(fixture)}`; },
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          const entry = replaceRequired(html, 'src="/src/main.ts"', 'src="/g1-entry.mjs"');
          return replaceRequired(entry, '<head>', `<head><meta http-equiv="Content-Security-Policy" content="${offlinePolicy}">`);
        },
      },
      generateBundle(_options, bundle) {
        if ([...this.getModuleIds()].some((id) => id.includes('/data/crew-roster/'))) throw new Error('Proof must omit private roster inputs');
        const html = bundle['index.html'];
        const css = Object.keys(bundle).find((name) => /maplibre-vendor-.*\.css$/.test(name));
        if (!html || !css || !Object.keys(bundle).some((name) => /maplibre-gl-worker-.*\.js$/.test(name))) throw new Error('Proof is missing the real map stylesheet or worker');
        html.source = String(html.source).replace('</head>', `<meta name="opd-map-stylesheet" content="/${css}"></head>`);
      },
    }],
    build: {
      target: 'es2022', outDir: output, emptyOutDir: true, manifest: true, copyPublicDir: false,
      rollupOptions: { output: { manualChunks: (id) => id.includes('node_modules/maplibre-gl/') ? 'maplibre-vendor' : undefined } },
    },
  });
  await mkdir(resolve(output, '__g1/tiles'), { recursive: true });
  const tile = tilePNG();
  await Promise.all([
    writeFile(resolve(output, '__g1/map.png'), tilePNG([...TILE_COLORS.map, 255])),
    writeFile(resolve(output, '__g1/iss.png'), tilePNG([...TILE_COLORS.iss, 255])),
    ...Array.from({ length: TILE_COUNT }, (_, index) => writeFile(resolve(output, `__g1/tiles/${index}.png`), tile)),
    ...['fonts', 'glyphs', 'ne_110m_coastline.geojson'].map((path) => cp(resolve(root, 'frontend/public', path), resolve(output, path), { recursive: true })),
  ]);
  const bundleHashes = {};
  for (const name of (await readdir(output, { recursive: true })).sort()) {
    const path = resolve(output, name);
    if ((await stat(path)).isFile()) bundleHashes[name] = sha(await readFile(path));
  }
  await writeFile(resolve(output, '__g1/build.json'), JSON.stringify({ requiredDeploymentTarget: '26.0', bundleSHA256: sha(JSON.stringify(bundleHashes)), bundleHashes, fixtureSHA256: fixture.fixtureSHA256, tileSHA256: fixture.tileSHA256, fixtureClock: fixture.now }, null, 2));
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildProof();
