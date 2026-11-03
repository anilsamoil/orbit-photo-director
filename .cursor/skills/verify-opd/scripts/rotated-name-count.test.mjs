import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nameCountOk } from './plan-label-verdict.mjs';
import { countRotatedNames, decodePng, peekingGlyphInk } from './rotated-name-count.mjs';

function canvas(width, height) {
  return new Uint8Array(width * height * 4);
}

function stamp(pixels, width, height, x, y, w, h, tone = 230) {
  for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx += 1) {
      const index = (yy * width + xx) * 4;
      pixels[index] = tone;
      pixels[index + 1] = tone;
      pixels[index + 2] = tone;
      pixels[index + 3] = 255;
    }
  }
}

function word(pixels, width, height, angle, origin, count, step = 14) {
  const theta = angle * Math.PI / 180;
  for (let index = 0; index < count; index += 1) {
    const x = Math.round(origin[0] + Math.cos(theta) * step * index);
    const y = Math.round(origin[1] + Math.sin(theta) * step * index);
    stamp(pixels, width, height, x, y, 7, 11);
  }
}

test('blank tiles have no country name and fail when the anchor is on the plan', () => {
  const width = 478;
  const height = 690;
  const blank = canvas(width, height);
  assert.equal(countRotatedNames(blank, width, height), 0);
  assert.equal(nameCountOk(countRotatedNames(blank, width, height), true).ok, false);
  stamp(blank, width, height, 0, 40, width, 4, 220);
  assert.equal(countRotatedNames(blank, width, height), 0);
});

test('rotated border lettering counts, and a city dot does not', () => {
  const width = 274;
  const height = 984;
  const pixels = canvas(width, height);
  word(pixels, width, height, 40, [30, 180], 6, 16);
  assert.equal(countRotatedNames(pixels, width, height), 1);
  word(pixels, width, height, 0, [40, 640], 7, 12);
  assert.equal(countRotatedNames(pixels, width, height), 2);
  const city = canvas(width, height);
  word(city, width, height, 0, [80, 400], 5, 12);
  stamp(city, width, height, 70, 412, 10, 10);
  assert.equal(countRotatedNames(city, width, height), 0);
});

test('blank tiles and a halo beside the mask fail the pixel verdict', () => {
  const width = 80;
  const height = 40;
  const pixels = canvas(width, height);
  const mask = { left: 20, top: 8, right: 50, bottom: 28 };
  stamp(pixels, width, height, 22, 10, 20, 12, 70);
  assert.equal(peekingGlyphInk(pixels, width, height, [mask]), false);
  stamp(pixels, width, height, 52, 12, 6, 8, 220);
  assert.equal(peekingGlyphInk(pixels, width, height, [mask]), true);
  assert.equal(nameCountOk(1, true, { peek: true }).ok, false);
});

test('the off-centroid verdict counts screenshot ink, including the regressed cameras', () => {
  const drive = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8');
  const loop = drive.slice(drive.indexOf('const offCentroid'), drive.indexOf('const france = await readPlanLabelZoom'));
  assert.match(loop, /8\.6386,\s*10/);
  assert.match(loop, /8\.5,\s*11/);
  assert.match(loop, /37\.5,\s*2/);
  assert.match(loop, /\[\s*9,\s*10\s*\]/);
  assert.match(loop, /clippedRasterRemnant\(/);
  assert.match(loop, /symbolCrossesEdge\(/);
  assert.match(loop, /peekingGlyphInk\(/);
  assert.match(loop, /hasLabelInk\(/);
  assert.match(loop, /toDataURL\('image\/png'\)/);
  assert.match(loop, /nameCountOk\(total, placed\.inside, \{ peek:/);
});

test('the f4e981ec Nigeria canvases show the border name and the small label', () => {
  const root = fileURLToPath(new URL('./fixtures/label-cameras/', import.meta.url));
  const expect = {
    'nigeria-east-9-10.png': 1,
    'nigeria-diagonal-8.5-11.png': 2,
  };
  for (const [name, count] of Object.entries(expect)) {
    const decoded = decodePng(readFileSync(root + name));
    assert.ok(decoded, name);
    assert.equal(countRotatedNames(decoded.data, decoded.width, decoded.height), count, name);
  }
});
