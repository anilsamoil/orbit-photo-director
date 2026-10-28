import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const dist = new URL('../dist/', import.meta.url);

test('native imports, recovery metadata, and the service worker share one MapLibre stylesheet', async () => {
  const assets = await readdir(new URL('assets/', dist));
  const stylesheets = assets.filter((name) => /^maplibre[^/]*\.css$/.test(name));
  assert.equal(stylesheets.length, 1, `Duplicate MapLibre stylesheets: ${stylesheets.join(', ')}`);
  const [stylesheet] = stylesheets;
  const href = `/assets/${stylesheet}`;
  const html = await readFile(new URL('index.html', dist), 'utf8');
  const metadata = html.match(/<meta\s+name="opd-map-stylesheet"\s+content="([^"]+)"\s*\/?>/g) ?? [];
  assert.equal(metadata.length, 1, 'The shell must expose exactly one canonical recovery stylesheet');
  assert.ok(metadata[0].includes(`content="${href}"`));

  const scripts = await Promise.all(assets.filter((name) => name.endsWith('.js'))
    .map((name) => readFile(new URL(`assets/${name}`, dist), 'utf8')));
  assert.ok(scripts.some((source) => source.includes(`assets/${stylesheet}`)),
    'The native dynamic-import preload must use the same stylesheet');
  assert.ok(scripts.some((source) => source.includes('opd-map-stylesheet')),
    'Recovery must read the shell stylesheet identity');

  const worker = await readFile(new URL('sw.js', dist), 'utf8');
  const precache = [...worker.matchAll(/\burl:["']([^"']*maplibre[^"']*\.css)["']/g)].map((match) => match[1]);
  assert.deepEqual(precache, [href.slice(1)], 'The service worker must precache only the canonical stylesheet');
});
