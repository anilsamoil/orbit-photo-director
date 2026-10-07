import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEarthPanes } from './drive.mjs';
import { PLACEMENT_CASES } from './placement-proof.mjs';

test('a 402 by 874 start checks 874 by 402 as a phone side pane', () => {
  const landscape = launchEarthPanes(402, 874).find((pane) => pane.label === '874x402');
  assert.deepEqual(
    { place: landscape.place, minShort: landscape.minShort, width: landscape.width, height: landscape.height },
    { place: 'side', minShort: 80, width: 874, height: 402 },
  );
});

test('an 874 by 402 start uses that same phone side pane', () => {
  const [pane] = launchEarthPanes(874, 402);
  assert.deepEqual(
    { label: pane.label, place: pane.place, minShort: pane.minShort, width: pane.width, height: pane.height },
    { label: '874x402', place: 'side', minShort: 80, width: 874, height: 402 },
  );
});

test('a 565 earth scene does not choose an overlay floor from the place it sees', () => {
  for (const [width, height, label] of [[390, 664, '390x565'], [402, 874, '402x565']]) {
    const scene = launchEarthPanes(width, height).find((pane) => pane.label === label);
    assert.equal(scene.place, '');
    assert.deepEqual(scene.places, ['below', 'over']);
    assert.equal(scene.belowMinShort, undefined);
    assert.equal(scene.minShort, 120);
    assert.equal(scene.sceneBox, true);
    assert.equal(scene.twoLine, true);
  }
});

test('placement cases state literal frames around 120 and 132', () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'placement-proof.mjs'), 'utf8');
  assert.equal(source.includes('pane-fit'), false);
  assert.equal(source.includes('fitIssPane'), false);
  assert.deepEqual(
    PLACEMENT_CASES.filter((item) => item.sceneWidth === 390).map((item) => [item.reservedShort, item.place, item.width, item.height]),
    [
      [134, 'below', 201, 134],
      [132, 'below', 198, 132],
      [120, 'below', 180, 120],
      [119, 'over', 333, 222],
      [120, 'over', 333, 222],
      [131, 'over', 333, 222],
      [132, 'below', 198, 132],
    ],
  );
  assert.deepEqual(
    PLACEMENT_CASES.filter((item) => item.sceneWidth === 402 && item.place === 'over').map((item) => [item.reservedShort, item.width, item.height]),
    [
      [119, 345, 230],
      [120, 345, 230],
      [131, 345, 230],
    ],
  );
});

test('a wide pane at least 800 by 600 still requires a 200px earth', () => {
  const [pane] = launchEarthPanes(874, 700);
  assert.equal(pane.minShort, 200);
  assert.equal(pane.width, 874);
  assert.equal(pane.height, 700);
});
