import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  missingListenerMutant,
  POISONED_EARTH,
  rafWrappedMutant,
  sameTurnEarthVerdict,
  settledEarthVerdict,
  syncListenerHealthy,
} from './earth-after-resize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const drive = readFileSync(resolve(here, 'drive.mjs'), 'utf8');

test('same-turn oracle fails a correct rAF-wrapped onResize', () => {
  const sample = rafWrappedMutant();
  const sameTurn = sameTurnEarthVerdict(sample);
  const settled = settledEarthVerdict(sample);
  assert.equal(sameTurn.ok, false);
  assert.equal(sameTurn.width, POISONED_EARTH.width);
  assert.equal(sameTurn.height, POISONED_EARTH.height);
  assert.equal(settled.ok, true);
  assert.ok(settled.width >= 240);
  assert.ok(settled.height >= 160);
});

test('settled oracle fails a missing resize listener at the poisoned frame', () => {
  const sample = missingListenerMutant();
  const settled = settledEarthVerdict(sample);
  assert.equal(settled.ok, false);
  assert.equal(settled.step, 'earth');
  assert.equal(settled.width, 109);
  assert.equal(settled.height, 72);
});

test('settled oracle accepts a sync listener that already cleared the poison', () => {
  const settled = settledEarthVerdict(syncListenerHealthy());
  assert.equal(settled.ok, true);
});

test('drive earth wait settles after resize instead of reading the same turn', () => {
  assert.match(drive, /settleEarthAfterResize/);
  assert.match(drive, /requestAnimationFrame/);
  assert.match(drive, /from '\.\/earth-after-resize\.mjs'/);
  assert.match(drive, /resize listener/);
  assert.equal(drive.includes("staleFrame.style.width = '109px';\n  staleFrame.style.height = '72px';\n  }\n  window.dispatchEvent(new Event('resize'));\n  const laidFrame"), false);
});
