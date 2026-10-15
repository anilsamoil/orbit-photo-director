import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceDescriptor, parseViewportOverride } from './webkit-devices.mjs';

test('iphone-17-pro accepts any WIDTHxHEIGHT, including a context created at 874x402', () => {
  assert.deepEqual(parseViewportOverride('iphone-17-pro', '874x402'), { width: 874, height: 402, raw: '874x402' });
  assert.deepEqual(parseViewportOverride('iphone-17-pro', '402x874'), { width: 402, height: 874, raw: '402x874' });
});

test('iphone-13 accepts only 844x390', () => {
  assert.deepEqual(parseViewportOverride('iphone-13', '844x390'), { width: 844, height: 390, raw: '844x390' });
  assert.throws(() => parseViewportOverride('iphone-13', '390x844'), /ipad-pro-11 with 834x1210 or 1210x834/);
});

test('ipad-pro-11 accepts the M4 sizes created at 834x1210 and 1210x834', () => {
  assert.deepEqual(parseViewportOverride('ipad-pro-11', '834x1210'), { width: 834, height: 1210, raw: '834x1210' });
  assert.deepEqual(parseViewportOverride('ipad-pro-11', '1210x834'), { width: 1210, height: 834, raw: '1210x834' });
  const portrait = deviceDescriptor({
    name: 'iPad Pro 11',
    viewport: { width: 834, height: 1210 },
  });
  const landscape = deviceDescriptor({
    name: 'iPad Pro 11',
    viewport: { width: 1210, height: 834 },
  });
  assert.equal(portrait.viewport.width, 834);
  assert.equal(portrait.viewport.height, 1210);
  assert.equal(landscape.viewport.width, 1210);
  assert.equal(landscape.viewport.height, 834);
  assert.equal(portrait.defaultBrowserType, 'webkit');
  assert.equal(portrait.isMobile, true);
  assert.equal(portrait.hasTouch, true);
});

test('ipad-pro-11 rejects the stock 834x1194 override and other sizes', () => {
  assert.throws(() => parseViewportOverride('ipad-pro-11', '834x1194'), /834x1210 or 1210x834/);
  assert.throws(() => parseViewportOverride('ipad-pro-11', '1024x768'), /834x1210 or 1210x834/);
  assert.throws(() => parseViewportOverride('desktop', '1400x900'), /834x1210 or 1210x834/);
});

test('an empty viewport override stays on the device descriptor', () => {
  assert.equal(parseViewportOverride('ipad-pro-11', ''), null);
  assert.equal(parseViewportOverride('ipad-pro-11', '   '), null);
  assert.throws(() => parseViewportOverride('ipad-pro-11', '834'), /WIDTHxHEIGHT/);
});
