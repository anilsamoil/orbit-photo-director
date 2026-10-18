import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearingPlan, bearingSamples } from './bearing-retarget.mjs';

test('map-bearing accepts the four standing surfaces and no other size', () => {
  assert.equal(bearingPlan('iphone-17-pro', '402x874').id, 'webkit-iphone-17-pro-402x874');
  assert.equal(bearingPlan('ipad-pro-11', '834x1210').engine, 'webkit');
  assert.equal(bearingPlan('ipad-pro-11', '1210x834').id, 'webkit-ipad-m4-1210x834');
  assert.equal(bearingPlan('chrome', '402x874').engine, 'chrome');
  assert.throws(() => bearingPlan('iphone-17-pro', '874x402'), /one surface per process/);
  assert.throws(() => bearingPlan('desktop', '1440x900'), /one surface per process/);
  assert.throws(() => bearingPlan('all', '402x874'), /one surface per process/);
  assert.throws(() => bearingPlan('', ''), /one surface per process/);
});

test('the standing track moves east so an order-0 verify polynomial is not the ease', () => {
  const { here, ahead } = bearingSamples();
  assert.ok(here && ahead);
  assert.equal(here.lat, ahead.lat);
  assert.ok(ahead.lon - here.lon > 1);
});
