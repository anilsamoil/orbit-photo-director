import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insetGateFits, planOpenFailures, planOpenPlan } from './plan-open.mjs';

const chrome = {
  helpHidden: true,
  snapOrder: true,
  snapLabel: 'Help — how to use SNAP',
  helpOpened: true,
  fullscreenPosition: 'absolute',
  fullscreenSize: 44,
  fullscreenCorner: true,
};

test('plan-open accepts the five created-at-size surfaces', () => {
  assert.equal(planOpenPlan('iphone-17-pro', '402x874').fits, false);
  assert.equal(planOpenPlan('iphone-17-pro', '874x402').id, 'webkit-iphone-17-pro-874x402');
  assert.equal(planOpenPlan('ipad-pro-11', '834x1210').engine, 'webkit');
  assert.equal(planOpenPlan('ipad-pro-11', '1210x834').fits, true);
  assert.equal(planOpenPlan('desktop', '1440x900').engine, 'chrome');
  assert.equal(insetGateFits(402, 874), false);
  assert.equal(insetGateFits(874, 402), false);
  assert.equal(insetGateFits(834, 1210), true);
  assert.equal(insetGateFits(1440, 900), true);
  assert.throws(() => planOpenPlan('desktop', '1280x800'), /one process per surface/);
  assert.throws(() => planOpenPlan('desktop', '1400x900'), /one process per surface/);
  assert.throws(() => planOpenPlan('all', '1440x900'), /one process per surface/);
  assert.throws(() => planOpenPlan('iphone-17-pro', '390x844'), /one process per surface/);
  assert.throws(() => planOpenPlan('', ''), /one process per surface/);
});

test('a phone under the 800 by 600 gate passes when the plan map stays hidden', () => {
  assert.deepEqual(planOpenFailures({ ...chrome, fits: false, planShown: false, split: false }), []);
  assert.match(planOpenFailures({ ...chrome, fits: false, planShown: true, split: false }).join(' '), /800x600/);
});

test('a fitting viewport passes when night, wheel, pointer pan, and the detail guard hold', () => {
  assert.deepEqual(planOpenFailures({
    ...chrome,
    fits: true,
    planShown: true,
    night: true,
    nightRebuilt: true,
    zoomDelta: 0.4,
    zoomHeld: true,
    panMoved: true,
    panOpened: false,
    detailClickOpened: false,
    enterView: 'view-map',
    spaceView: 'view-map',
  }), []);
  const opened = planOpenFailures({
    ...chrome,
    fits: true,
    planShown: true,
    night: true,
    nightRebuilt: true,
    zoomDelta: 0.4,
    zoomHeld: true,
    panMoved: true,
    panOpened: false,
    detailClickOpened: true,
    enterView: 'view-iss',
    spaceView: 'view-map',
  });
  assert.match(opened.join(' '), /detail click/);
  assert.match(opened.join(' '), /enter/);
});
