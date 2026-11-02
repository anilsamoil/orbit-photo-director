import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coveringTiles } from '../node_modules/maplibre-gl/src/geo/projection/covering_tiles.ts';
import { MercatorTransform } from '../node_modules/maplibre-gl/src/geo/projection/mercator_transform.ts';
import { LngLat } from '../node_modules/maplibre-gl/src/geo/lng_lat.ts';

const levels = JSON.parse(readFileSync(new URL('../src/map/adapters/maplibre/country-raster-levels.json', import.meta.url), 'utf8'));
const product = readFileSync(new URL('../src/map/adapters/maplibre/track-inset.ts', import.meta.url), 'utf8');

function cover(center, zoom, maxzoom) {
  const transform = new MercatorTransform();
  transform.resize(800, 800);
  transform.setCenter(new LngLat(center[0], center[1]));
  transform.setZoom(zoom);
  return coveringTiles(transform, { tileSize: 256, roundZoom: true, maxzoom });
}

const cameras = [
  { center: [2, 46], zoom: 6.5 },
  { center: [2, 46], zoom: 6.51 },
  { center: [-0.33, 46], zoom: 5.5 },
];

test('the label source is capped where the renderer would otherwise fetch z7-z9', () => {
  assert.match(product, /inset-labels': \{ type: 'raster', tiles: ESRI_LABEL_TILES, tileSize: 256, maxzoom: COUNTRY_RASTER_LEVELS\.through \}/);
  for (const camera of cameras) {
    const open = cover(camera.center, camera.zoom, 19);
    const capped = cover(camera.center, camera.zoom, levels.through);
    assert.ok(open.some((tile) => tile.canonical.z > levels.through), `${camera.zoom} should request a tile above the audit when uncapped`);
    assert.ok(capped.length > 0, `${camera.zoom} cover`);
    for (const tile of capped) {
      assert.ok(tile.canonical.z <= levels.through, `${camera.zoom} canonical ${tile.canonical.z}`);
    }
  }
});
