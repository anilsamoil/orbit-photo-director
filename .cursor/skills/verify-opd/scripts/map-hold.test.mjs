import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapHoldFailures, mapHoldPlan } from './map-hold.mjs';

const released = {
  idle: '0px',
  held: '0px',
  chord: '0px',
  released: '372px',
  otherPointer: '0px',
  otherReleased: '372px',
  cancelled: '372px',
  blurred: '372px',
  lost: '372px',
};

test('map-hold accepts the two created-at-size WebKit surfaces', () => {
  assert.equal(mapHoldPlan('iphone-17-pro', '402x874').id, 'webkit-iphone-17-pro-402x874');
  assert.equal(mapHoldPlan('ipad-pro-11', '834x1210').id, 'webkit-ipad-m4-834x1210');
  assert.throws(() => mapHoldPlan('iphone-17-pro', '874x402'), /one process per surface/);
  assert.throws(() => mapHoldPlan('ipad-pro-11', '1194x834'), /one process per surface/);
  assert.throws(() => mapHoldPlan('desktop', '1440x900'), /one process per surface/);
});

test('a chord keeps the corner lift until buttons are up', () => {
  assert.deepEqual(mapHoldFailures(released), []);
  const early = mapHoldFailures({ ...released, chord: '372px' });
  assert.match(early.join('\n'), /chord 372px/);
});
