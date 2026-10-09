import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hitOwnershipFailures, safeAreaChromeFailures } from './safe-area-chrome.mjs';

const clear = {
  controls: [
    { name: 'zoom stack', left: 55, width: 29, height: 88 },
    { name: 'compass', left: 55, width: 44, height: 44 },
    { name: 'time strip', left: 111, width: 400, height: 52 },
  ],
  banner: { bottom: 501, height: 23 },
  viewportHeight: 521,
  insets: { top: 24, right: 0, bottom: 20, left: 47 },
};

test('names a zoom stack that starts inside the left inset', () => {
  const failures = safeAreaChromeFailures({
    ...clear,
    controls: [
      { name: 'zoom stack', left: 8, width: 29, height: 88 },
      { name: 'compass', left: 8.2, width: 44, height: 44 },
      { name: 'time strip', left: 120, width: 400, height: 52 },
    ],
  });
  assert.deepEqual(failures, [
    'zoom stack x=8 inside left inset 47',
    'compass x=8 inside left inset 47',
  ]);
});

test('names the time strip when it starts inside the left inset', () => {
  const failures = safeAreaChromeFailures({
    ...clear,
    controls: [
      { name: 'zoom stack', left: 55, width: 29, height: 88 },
      { name: 'compass', left: 55, width: 44, height: 44 },
      { name: 'time strip', left: 8, width: 640, height: 96 },
    ],
  });
  assert.deepEqual(failures, ['time strip x=8 inside left inset 47']);
});

test('names the status banner when its bottom covers the home indicator', () => {
  const failures = safeAreaChromeFailures({
    ...clear,
    banner: { bottom: 521, height: 24 },
  });
  assert.deepEqual(failures, ['status banner bottom=521 over bottom inset 20']);
});

test('accepts chrome that clears the left inset and the bottom inset', () => {
  assert.deepEqual(safeAreaChromeFailures(clear), []);
});

test('names a control whose center belongs to something else', () => {
  const failures = hitOwnershipFailures(
    [{ name: 'zoom in', owned: false, hit: 'time-slider' }],
    { top: 24, right: 0, bottom: 20, left: 47 },
  );
  assert.deepEqual(failures, ['zoom in hit time-slider']);
});

test('refuses a zero-inset ownership pass', () => {
  const failures = hitOwnershipFailures(
    [{ name: 'zoom in', owned: true, hit: 'zoom in' }],
    { top: 0, right: 0, bottom: 0, left: 0 },
  );
  assert.deepEqual(failures, ['hit ownership requires a nonzero inset']);
});

test('accepts owned hits at a nonzero inset', () => {
  assert.deepEqual(hitOwnershipFailures(
    [{ name: 'Hide', owned: true, hit: 'Hide' }],
    { top: 24, right: 34, bottom: 0, left: 0 },
  ), []);
});

test('ignores a control with no box', () => {
  const failures = safeAreaChromeFailures({
    ...clear,
    controls: [{ name: 'zoom stack', left: 0, width: 0, height: 0 }],
  });
  assert.deepEqual(failures, []);
});
