import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopViewport, deviceDescriptor, parseViewportOverride } from './webkit-devices.mjs';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopLegal = '`OPD_VERIFY_VIEWPORT` is legal for `desktop` at `1440x900` or `1280x800`, for `iphone-17-pro` at any `WIDTHxHEIGHT`, for `iphone-13` at `844x390`, and for `ipad-pro-11` at `834x1210` or `1210x834`.';

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

test('desktop accepts 1440x900 and 1280x800, and the help text names them', () => {
  assert.deepEqual(parseViewportOverride('desktop', '1440x900'), { width: 1440, height: 900, raw: '1440x900' });
  assert.deepEqual(parseViewportOverride('desktop', '1280x800'), { width: 1280, height: 800, raw: '1280x800' });
  assert.deepEqual(desktopViewport('desktop', '1440x900'), { width: 1440, height: 900, mobile: false });
  assert.deepEqual(desktopViewport('desktop', '1280x800'), { width: 1280, height: 800, mobile: false });
  assert.deepEqual(desktopViewport('desktop', ''), { width: 1400, height: 900, mobile: false });
  assert.deepEqual(desktopViewport('iphone-13', '844x390'), { width: 1400, height: 900, mobile: false });
  assert.throws(() => parseViewportOverride('desktop', '1400x900'), /desktop with 1440x900 or 1280x800/);
  assert.throws(() => parseViewportOverride('desktop', '1280x700'), /desktop with 1440x900 or 1280x800/);
  assert.throws(() => desktopViewport('desktop', '1280x700'), /desktop with 1440x900 or 1280x800/);
  assert.throws(() => parseViewportOverride('ipad-pro-11', '1024x1366'), /desktop with 1440x900 or 1280x800/);
});

test('the skill documents the desktop viewport overrides the validator accepts', () => {
  const skill = readFileSync(resolve(skillRoot, 'SKILL.md'), 'utf8');
  const readme = readFileSync(resolve(skillRoot, 'features/README.md'), 'utf8');
  assert.equal(skill.includes(desktopLegal), true);
  assert.equal(readme.includes(desktopLegal), true);
});

test('an empty viewport override stays on the device descriptor', () => {
  assert.equal(parseViewportOverride('ipad-pro-11', ''), null);
  assert.equal(parseViewportOverride('ipad-pro-11', '   '), null);
  assert.throws(() => parseViewportOverride('ipad-pro-11', '834'), /WIDTHxHEIGHT/);
});

test('desktop accepts the two target overrides, retaining non-mobile metrics', () => {
  assert.deepEqual(parseViewportOverride('desktop', '1440x900'), { width: 1440, height: 900, raw: '1440x900' });
  assert.deepEqual(parseViewportOverride('desktop', '1280x800'), { width: 1280, height: 800, raw: '1280x800' });
  assert.throws(() => parseViewportOverride('desktop', '1280x700'));
});
