import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchEarthPanes } from './drive.mjs';

const phoneLandscapeFloor = { minShort: 160, minWidth: 240, minHeight: 160, place: 'side' };

function floorOf(pane) {
  return {
    place: pane.place,
    minShort: pane.minShort,
    minWidth: pane.minWidth,
    minHeight: pane.minHeight,
    width: pane.width,
    height: pane.height,
  };
}

test('844 by 390 shares one floor from a fresh start and from the iPhone 13 walk', () => {
  const fresh = launchEarthPanes(844, 390)[0];
  const walked = launchEarthPanes(390, 664).find((pane) => pane.label === '844x390');
  const expected = { ...phoneLandscapeFloor, width: 844, height: 390 };
  assert.deepEqual(floorOf(fresh), expected);
  assert.deepEqual(floorOf(walked), floorOf(fresh));
});

test('874 by 402 shares that same floor from a fresh start and from the iPhone 17 Pro walk', () => {
  const fresh = launchEarthPanes(874, 402)[0];
  const walked = launchEarthPanes(402, 874).find((pane) => pane.label === '874x402');
  const expected = { ...phoneLandscapeFloor, width: 874, height: 402 };
  assert.deepEqual(floorOf(fresh), expected);
  assert.deepEqual(floorOf(walked), floorOf(fresh));
});

test('a 402 by 874 start checks 874 by 402 as a phone side pane', () => {
  const landscape = launchEarthPanes(402, 874).find((pane) => pane.label === '874x402');
  assert.deepEqual(floorOf(landscape), { ...phoneLandscapeFloor, width: 874, height: 402 });
});

test('an 874 by 402 start uses that same phone side pane', () => {
  const [pane] = launchEarthPanes(874, 402);
  assert.deepEqual(
    { label: pane.label, ...floorOf(pane) },
    { label: '874x402', ...phoneLandscapeFloor, width: 874, height: 402 },
  );
});

test('a wide pane at least 800 by 600 still requires a 200px earth', () => {
  const [pane] = launchEarthPanes(874, 700);
  assert.equal(pane.minShort, 200);
  assert.equal(pane.minWidth, undefined);
  assert.equal(pane.width, 874);
  assert.equal(pane.height, 700);
});

test('a fresh start at least 800 wide that is not those two phones stays at 200', () => {
  const [pane] = launchEarthPanes(844, 700);
  assert.equal(pane.minShort, 200);
  assert.equal(pane.minWidth, undefined);
});
