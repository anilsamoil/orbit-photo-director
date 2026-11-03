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

test('the dark basemap at zoom 6.5 draws z8, which has no audited lettering box', () => {
  assert.match(product, /const INSET_BASEMAP_MAX_ZOOM = 20/);
  assert.match(product, /inset-basemap': \{ type: 'raster', tiles: ESRI_DARK_TILES, tileSize: 256, maxzoom: INSET_BASEMAP_MAX_ZOOM \}/);
  assert.doesNotMatch(product, /bounds\?\.\[name\]\?\.\[tile\]/);
  for (const center of [[38, 1], [8, 10]]) {
    const dark = cover(center, 6.5, 20);
    const labels = cover(center, 6.5, levels.through);
    assert.ok(dark.length > 0, `${center} basemap cover`);
    assert.ok(dark.every((tile) => tile.canonical.z === 8), `${center} basemap drew ${dark.map((tile) => tile.canonical.z).join(',')}`);
    assert.ok(labels.length > 0 && labels.every((tile) => tile.canonical.z <= levels.through));
  }
  assert.equal(levels.bounds.Kenya['8'], undefined);
  assert.equal(levels.bounds.Nigeria['8'], undefined);
});

test('the label source uses main tile levels, including z7 and z8 above the audit', () => {
  assert.match(product, /const INSET_LABEL_MAX_ZOOM = 19/);
  assert.match(product, /inset-labels': \{ type: 'raster', tiles: ESRI_LABEL_TILES, tileSize: 256, maxzoom: INSET_LABEL_MAX_ZOOM \}/);
  for (const camera of cameras) {
    const labels = cover(camera.center, camera.zoom, 19);
    assert.ok(labels.length > 0, `${camera.zoom} cover`);
    assert.ok(labels.some((tile) => tile.canonical.z > levels.through), `${camera.zoom} drew ${labels.map((tile) => tile.canonical.z).join(',')}`);
  }
});
