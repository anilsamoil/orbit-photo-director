import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cornerPagehideFailures, formatBox, pagehidePlan } from './corner-pagehide.mjs';

const hide = { left: 1102, top: 1132, width: 88, height: 44, text: 'Hide', display: 'block' };
const legend = { left: 1006, top: 1132, width: 88, height: 44, text: 'Legend', display: 'block' };

function phase(observers, box = hide, legendBox = legend) {
  return { observers, hide: box, legend: legendBox, lift: '0px' };
}

function sample(overrides = {}) {
  return {
    before: phase(6),
    hidden: phase(0),
    cold: phase(0),
    shown: phase(6),
    ...overrides,
  };
}

test('map-pagehide accepts the six created-at-size surfaces', () => {
  assert.equal(pagehidePlan('ipad-pro-11', '834x1210').id, 'webkit-ipad-m4-834x1210');
  assert.equal(pagehidePlan('ipad-pro-11', '1210x834').engine, 'webkit');
  assert.equal(pagehidePlan('iphone-17-pro', '402x874').id, 'webkit-iphone-17-pro-402x874');
  assert.equal(pagehidePlan('iphone-17-pro', '874x402').id, 'webkit-iphone-17-pro-874x402');
  assert.equal(pagehidePlan('desktop', '1440x900').engine, 'chrome');
  assert.equal(pagehidePlan('desktop', '1280x800').id, 'chrome-1280x800');
  assert.throws(() => pagehidePlan('all', '1440x900'), /one process per surface/);
  assert.throws(() => pagehidePlan('desktop', '1400x900'), /one process per surface/);
  assert.throws(() => pagehidePlan('iphone-17-pro', '390x844'), /one process per surface/);
  assert.throws(() => pagehidePlan('chrome', '1440x900'), /one process per surface/);
  assert.throws(() => pagehidePlan('', ''), /one process per surface/);
});

test('a pagehide drop to 0 and a persisted pageshow that keeps Hide and Legend passes', () => {
  assert.deepEqual(cornerPagehideFailures(sample()), []);
  assert.equal(formatBox(hide), '1102,1132,88,44');
});

test('names a pagehide that leaves observers, a cold pageshow that reconnects, and a moved Hide', () => {
  const moved = { ...hide, top: 700 };
  const failures = cornerPagehideFailures(sample({
    hidden: phase(6),
    cold: phase(6),
    shown: phase(4, moved),
  }));
  assert.ok(failures.includes('observers pagehide 6'));
  assert.ok(failures.includes('observers pageshow cold 6'));
  assert.ok(failures.includes('observers pageshow 4'));
  assert.ok(failures.includes('hide pageshow 1102,700,88,44'));
});
