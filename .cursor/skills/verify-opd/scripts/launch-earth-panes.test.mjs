import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchEarthPanes } from './drive.mjs';

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

test('a wide pane at least 800 by 600 still requires a 200px earth', () => {
  const [pane] = launchEarthPanes(874, 700);
  assert.equal(pane.minShort, 200);
  assert.equal(pane.width, 874);
  assert.equal(pane.height, 700);
});
