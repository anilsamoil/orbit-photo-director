import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLightningPlan } from './map-lightning.mjs';

const ACCEPTED = [
  ['iphone-17-pro', '402x874', 'webkit-iphone-17-pro-402x874'],
  ['iphone-17-pro', '874x402', 'webkit-iphone-17-pro-874x402'],
  ['ipad-pro-11', '834x1210', 'webkit-ipad-m4-834x1210'],
  ['ipad-pro-11', '1210x834', 'webkit-ipad-m4-1210x834'],
  ['ipad-pro-11', '820x1180', 'webkit-ipad-m4-820x1180'],
  ['ipad-3', '768x1024', 'webkit-ipad-3-768x1024'],
  ['desktop', '1440x900', 'webkit-desktop-1440x900'],
];

test('map-lightning accepts the legend-closed canvas sizes', () => {
  for (const [surface, viewport, id] of ACCEPTED) {
    const plan = mapLightningPlan(surface, viewport);
    assert.equal(plan.id, id);
    assert.equal(plan.desktop, surface === 'desktop');
  }
  assert.equal(mapLightningPlan('desktop', '1440x900').width, 1440);
  assert.equal(mapLightningPlan('ipad-3', '768x1024').deviceBase, 'iPad (gen 5)');
});

test('map-lightning rejects a size outside that set', () => {
  for (const [surface, viewport] of [
    ['iphone-17-pro', '390x844'],
    ['ipad-pro-11', '834x1194'],
    ['ipad-3', '1024x768'],
    ['desktop', '1280x800'],
    ['iphone-13', '390x844'],
    ['', ''],
  ]) {
    assert.throws(() => mapLightningPlan(surface, viewport), /one WebKit process per surface/);
  }
});
