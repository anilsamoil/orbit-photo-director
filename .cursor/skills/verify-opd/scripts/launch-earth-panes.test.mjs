import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEarthPanes } from './drive.mjs';
import { acceptsNatural, acceptsPhone, NATURAL_CARD_PX, naturalFrame, placementScenes, PLACEMENT_CASES } from './placement-proof.mjs';

test('a 402 by 874 start checks 874 by 402 as a phone side pane', () => {
  const landscape = launchEarthPanes(402, 874).find((pane) => pane.label === '874x402');
  assert.deepEqual(
    { place: landscape.place, minShort: landscape.minShort, width: landscape.width, height: landscape.height },
    { place: 'side', minShort: 80, width: 874, height: 402 },
  );
});

test('an 874 by 402 start uses that same phone side pane', () => {
  const [pane] = launchEarthPanes(874, 402);
  assert.deepEqual(
    { label: pane.label, place: pane.place, minShort: pane.minShort, width: pane.width, height: pane.height },
    { label: '874x402', place: 'side', minShort: 80, width: 874, height: 402 },
  );
});

test('a 565 earth scene does not choose an overlay floor from the place it sees', () => {
  for (const [width, height, label] of [[390, 664, '390x565'], [402, 874, '402x565']]) {
    const scene = launchEarthPanes(width, height).find((pane) => pane.label === label);
    assert.equal(scene.place, '');
    assert.deepEqual(scene.places, ['below', 'over']);
    assert.equal(scene.belowMinShort, undefined);
    assert.equal(scene.minShort, 120);
    assert.equal(scene.sceneBox, true);
    assert.equal(scene.twoLine, true);
  }
});

test('placement cases state literal frames around 120 and 132', () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'placement-proof.mjs'), 'utf8');
  assert.equal(source.includes('pane-fit'), false);
  assert.equal(source.includes('fitIssPane'), false);
  assert.deepEqual(
    PLACEMENT_CASES.filter((item) => item.sceneWidth === 390).map((item) => [item.reservedShort, item.place, item.width, item.height]),
    [
      [134, 'below', 201, 134],
      [132, 'below', 198, 132],
      [120, 'below', 180, 120],
      [119, 'over', 333, 222],
      [120, 'over', 333, 222],
      [131, 'over', 333, 222],
      [132, 'below', 198, 132],
    ],
  );
  assert.deepEqual(
    PLACEMENT_CASES.filter((item) => item.sceneWidth === 402 && item.place === 'over').map((item) => [item.reservedShort, item.width, item.height]),
    [
      [119, 345, 230],
      [120, 345, 230],
      [131, 345, 230],
    ],
  );
});

test('a wide pane at least 800 by 600 still requires a 200px earth', () => {
  const [pane] = launchEarthPanes(874, 700);
  assert.equal(pane.minShort, 200);
  assert.equal(pane.width, 874);
  assert.equal(pane.height, 700);
  const drive = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'drive.mjs'), 'utf8');
  assert.equal(drive.includes("minShort: 180"), false);
  assert.match(drive, /width >= 800\) return \[\{ \.\.\.native, place: splitLaunchPlace\(width, height\) \|\| 'side', minShort: 200 \}\]/);
});

function phoneChrome(paneWidth, toolbar) {
  return {
    paneWidth,
    paneHeight: 565,
    padX: 24,
    padY: 20.8,
    gap: 7.2,
    toolbar,
    button: 44,
    sideWidth: 32.8,
    label: 72,
    cardHeight: 96,
    cardGap: 7.2,
    body: 0,
  };
}

function phoneRow(scene, width, height, card, place, chrome) {
  return {
    sceneWidth: scene.sceneWidth,
    sceneHeight: 565,
    innerWidth: scene.context.viewport.width,
    innerHeight: 726,
    meta: 'width=device-width, initial-scale=1, viewport-fit=cover',
    place,
    card,
    width,
    height,
    devicePixelRatio: scene.context.deviceScaleFactor,
    userAgent: scene.context.userAgent,
    coarse: true,
    standalone: true,
    chrome,
  };
}

test('each phone proof reads that phone and the unwrapped card', () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'placement-proof.mjs'), 'utf8');
  const drive = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'drive.mjs'), 'utf8');
  assert.equal(source.includes("place !== ''"), false);
  assert.equal(source.includes('launchPersistentContext'), false);
  assert.match(source, /webkit\.launch\(\)/);
  assert.match(source, /browser\.newContext\(/);
  assert.equal(source.includes("serviceWorkers: 'block'"), true);
  assert.equal(source.includes('maxTouchPoints'), false);
  assert.equal(source.includes('devicePixelRatio'), true);
  assert.equal(source.includes('(pointer: coarse)'), true);
  assert.equal(source.includes('displayStandalone'), false);
  assert.equal(source.includes('row.standalone'), false);
  assert.equal(NATURAL_CARD_PX, 96);
  assert.deepEqual(placementScenes(390).map((scene) => [scene.name, scene.sceneWidth]), [['iphone-13', 390]]);
  assert.deepEqual(placementScenes(402).map((scene) => [scene.name, scene.sceneWidth]), [['iphone-17-pro', 402]]);
  assert.equal(drive.includes('proveLaunchPlacement(baseUrl, evidenceDir, viewport.width)'), true);
  const iphone13 = placementScenes(390)[0];
  const iphone17 = placementScenes(402)[0];
  const here = phoneChrome(390, 252);
  const shorterToolbar = phoneChrome(390, 230);
  const here17 = phoneChrome(402, 252);
  assert.deepEqual(naturalFrame(here), { width: 195, height: 130 });
  assert.deepEqual(naturalFrame(shorterToolbar), { width: 228, height: 152 });
  assert.deepEqual(naturalFrame(here17), { width: 195, height: 130 });
  assert.equal(acceptsNatural(iphone13, phoneRow(iphone13, 195, 130, 96, 'below', here)), true);
  assert.equal(acceptsNatural(iphone17, phoneRow(iphone17, 195, 130, 96, 'below', here17)), true);
  assert.equal(acceptsNatural(iphone13, phoneRow(iphone13, 228, 152, 96, 'below', shorterToolbar)), true);
  assert.equal(acceptsNatural(iphone17, phoneRow(iphone17, 228, 152, 96, 'below', phoneChrome(402, 230))), true);
  assert.equal(acceptsNatural(iphone13, phoneRow(iphone13, 180, 120, 96, 'below', here)), false);
  assert.equal(acceptsNatural(iphone17, phoneRow(iphone17, 180, 120, 96, 'below', here17)), false);
  assert.equal(acceptsNatural(iphone13, phoneRow(iphone13, 213, 142, 96, 'below', shorterToolbar)), false);
  assert.equal(acceptsNatural(iphone13, phoneRow(iphone13, 315, 210, 138, 'below', { ...here, cardHeight: 138 })), false);
  assert.equal(acceptsNatural(iphone13, phoneRow(iphone13, 195, 130, 96, '', here)), false);
  assert.equal(acceptsNatural(iphone17, phoneRow(iphone13, 195, 130, 96, 'below', here)), false);
  const desktop = phoneRow(iphone13, 195, 130, 96, 'below', here);
  desktop.devicePixelRatio = 1;
  desktop.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
  desktop.coarse = false;
  assert.equal(acceptsPhone(iphone13, desktop), false);
  assert.equal(acceptsNatural(iphone13, desktop), false);
  assert.equal(acceptsPhone(iphone13, phoneRow(iphone13, 195, 130, 96, 'below', here)), true);
});
