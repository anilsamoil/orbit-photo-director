import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timeStripLaidFailures } from './map-strip-contract.mjs';

const measured390 = {
  gap: 0,
  bottom: '0px',
  rowGap: '0px',
  columnGap: '0px',
  paddingTop: '0px',
  paddingRight: '0px',
  paddingBottom: '0px',
  paddingLeft: '0px',
  color: 'rgba(0, 0, 0, 0)',
  controls: 'rgba(7, 10, 13, 0.86)',
  covers: true,
  canvasBottom: 520,
  paneBottom: 520,
  stripTop: 378,
  stripBottom: 422,
  stripWidth: 362,
  stripHeight: 44,
  rightGap: 20,
  slider: 44,
  fitting: false,
  narrow: true,
  reserved: { height: 208, inset: 0, expect: 208 },
  paneWidth: 390,
  fullBleed: true,
  hide: false,
  legend: false,
  zoom: false,
  pip: false,
  events: 'none',
};

test('a 362px strip on a 390px pane passes the narrow-slider contract', () => {
  assert.equal(measured390.stripWidth > measured390.paneWidth - 80, true);
  assert.equal(measured390.rightGap <= 24, true);
  assert.deepEqual(timeStripLaidFailures(measured390), []);
});

test('a narrow strip that overlaps Hide fails without the full-bleed rule', () => {
  const failures = timeStripLaidFailures({ ...measured390, hide: true });
  assert.deepEqual(failures, ['hide']);
});

test('a narrow strip off the right edge fails', () => {
  const failures = timeStripLaidFailures({
    ...measured390,
    rightGap: -12,
    stripLeft: 40,
    stripRight: 402,
    paneLeft: 0,
    paneRight: 390,
    innerWidth: 390,
    innerHeight: 520,
  });
  assert.deepEqual(failures, ['offscreen']);
});

test('a narrow strip off the left edge fails', () => {
  const failures = timeStripLaidFailures({
    ...measured390,
    stripLeft: -16,
    paneLeft: 0,
    innerWidth: 390,
    innerHeight: 520,
  });
  assert.deepEqual(failures, ['offscreen']);
});

test('a narrow strip whose right gap is past 24px fails the narrow contract', () => {
  const failures = timeStripLaidFailures({ ...measured390, rightGap: 28 });
  assert.deepEqual(failures, ['narrow-right-gap']);
});

test('a pane at most 719px uses the narrow contract and 720px keeps full bleed', () => {
  assert.deepEqual(timeStripLaidFailures({
    ...measured390,
    paneWidth: 719,
    stripWidth: 680,
    rightGap: 20,
    fullBleed: true,
  }), []);
  assert.deepEqual(timeStripLaidFailures({
    ...measured390,
    paneWidth: 720,
    stripWidth: 680,
    rightGap: 40,
    narrow: false,
    fitting: false,
    fullBleed: true,
  }), ['full-bleed']);
});

test('a wide strip wider than the pane minus 80 still fails', () => {
  assert.deepEqual(timeStripLaidFailures({
    ...measured390,
    paneWidth: 1400,
    stripWidth: 1360,
    rightGap: 40,
    narrow: false,
    fitting: false,
    fullBleed: false,
  }), ['full-bleed']);
});

test('a fitting wide strip with the 204px corner clear still passes', () => {
  assert.deepEqual(timeStripLaidFailures({
    ...measured390,
    paneWidth: 1400,
    stripWidth: 1196,
    stripHeight: 96,
    rightGap: 204,
    slider: 44,
    narrow: false,
    fitting: true,
    fullBleed: false,
    reserved: null,
  }), []);
});
