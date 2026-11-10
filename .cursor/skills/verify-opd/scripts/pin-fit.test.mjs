import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pinFitFailures, pinFitPlan } from './pin-fit.mjs';

const fit = {
  padding: { top: '8px', right: '12px', bottom: '8px', left: '12px' },
  box: 190,
  scrollWidth: 190,
  clientWidth: 190,
  passRows: 4,
  relRows: 4,
  narrowPassRows: 4,
  narrowRelRows: 4,
  narrowDisplay: 'flex',
};

test('pin-fit accepts the two created-at-size WebKit surfaces', () => {
  assert.equal(pinFitPlan('iphone-17-pro', '402x874').id, 'webkit-iphone-17-pro-402x874');
  assert.equal(pinFitPlan('ipad-pro-11', '834x1210').id, 'webkit-ipad-m4-834x1210');
  assert.throws(() => pinFitPlan('iphone-17-pro', '874x402'), /one process per surface/);
  assert.throws(() => pinFitPlan('ipad-pro-11', '1194x834'), /one process per surface/);
  assert.throws(() => pinFitPlan('desktop', '1440x900'), /one process per surface/);
});

test('pin-fit accepts the launch padding, a 190px box, and the class count', () => {
  assert.deepEqual(pinFitFailures(fit), []);
  assert.match(pinFitFailures({ ...fit, padding: { ...fit.padding, bottom: '12px' } }).join('\n'), /padding bottom 12px/);
  assert.match(pinFitFailures({ ...fit, scrollWidth: 218, clientWidth: 190 }).join('\n'), /scrollWidth 218/);
  assert.match(pinFitFailures({ ...fit, passRows: 0, relRows: 4 }).join('\n'), /pin-pass-row count 0/);
  assert.match(pinFitFailures({ ...fit, narrowPassRows: 0, narrowRelRows: 4, narrowDisplay: 'flex' }).join('\n'), /narrow pin-pass-row count 0/);
});
