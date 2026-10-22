import assert from 'node:assert/strict';
import { test } from 'node:test';
import { northPlan } from './north-follow.mjs';

test('map-north accepts the blocking matrix and no other size', () => {
  assert.equal(northPlan('desktop', '1440x900').id, 'chrome-desktop-1440x900');
  assert.equal(northPlan('desktop', '1280x800').engine, 'chrome');
  assert.equal(northPlan('iphone-17-pro', '402x874').engine, 'webkit');
  assert.equal(northPlan('iphone-17-pro', '874x402').id, 'webkit-iphone-17-pro-874x402');
  assert.equal(northPlan('ipad-pro-11', '834x1210').engine, 'webkit');
  assert.equal(northPlan('ipad-pro-11', '1210x834').id, 'webkit-ipad-m4-1210x834');
  assert.equal(northPlan('iphone-17-pro', '402x874').touch, true);
  assert.equal(northPlan('desktop', '1280x800').touch, false);
  assert.throws(() => northPlan('chrome', '402x874'), /one surface per process/);
  assert.throws(() => northPlan('iphone-13', '390x664'), /one surface per process/);
  assert.throws(() => northPlan('ipad-3', '768x1024'), /one surface per process/);
  assert.throws(() => northPlan('all', '1440x900'), /one surface per process/);
  assert.throws(() => northPlan('', ''), /one surface per process/);
});
