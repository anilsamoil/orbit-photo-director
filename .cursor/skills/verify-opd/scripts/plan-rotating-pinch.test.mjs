import assert from 'node:assert/strict';
import test from 'node:test';
import { provePlanRotatingPinch } from './drive.mjs';
import { serveSnap, isolateSnapRequests } from './context-state-fixture.mjs';
import { launchChrome, launchWebkit, DESKTOP_CHROME_SPEC, WEBKIT_DEVICES, openDeviceContext, playwrightSend } from './webkit-devices.mjs';

for (const [engine, launch, base, width, height] of [
  ['webkit', launchWebkit, WEBKIT_DEVICES.find((entry) => entry.slug === 'ipad-pro-11'), 834, 1210],
  ['webkit', launchWebkit, WEBKIT_DEVICES.find((entry) => entry.slug === 'ipad-pro-11'), 1210, 834],
  ['chromium', launchChrome, DESKTOP_CHROME_SPEC, 1440, 900],
]) {
  for (const burst of [false, true]) test(`${engine} ${width}x${height}: ${burst ? 'unpainted pinch burst' : 'stock helper rotating pinch'} survives a queued resize`, { timeout: 90000 }, async () => {
    const served = await serveSnap();
    let browser;
    try {
      browser = await launch();
      isolateSnapRequests(browser, served.url);
      const session = await openDeviceContext(browser, { ...base, viewport: { width, height } });
      await session.page.goto(`${served.url}/?e2e`);
      await session.page.locator('#tab-iss').click();
      await session.page.waitForFunction(() => document.querySelector('[data-pip="plan"] [data-pip-frame]')?.__opdTrackInset?.isStyleLoaded());
      await session.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await session.page.waitForFunction(() => document.querySelector('[data-pip="plan"] [data-pip-frame]').__opdTrackInset.loaded());
      await session.page.evaluate(() => {
        const frame = document.querySelector('[data-pip="plan"] [data-pip-frame]');
        const map = frame.__opdTrackInset;
        const canvas = map.getCanvas();
        const trace = window.__planPinchTrace = { events: [], frames: 0, resize: null, originalWidth: canvas.clientWidth };
        map.on('render', () => { trace.frames += 1; });
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'touchend']) {
          frame.addEventListener(type, (event) => trace.events.push({
            type, pointerId: event.pointerId, pointerType: event.pointerType,
            touches: event.touches?.length, frame: trace.frames, zoom: map.getZoom(),
          }), true);
        }
        frame.addEventListener('touchstart', (event) => {
          if (event.touches.length !== 2 || trace.resize) return;
          frame.style.width = `${frame.clientWidth - 12}px`;
          map.resize();
          trace.resize = { requested: frame.clientWidth, during: canvas.clientWidth };
        });
      });
      if (!burst) await provePlanRotatingPinch(playwrightSend(session));
      else {
        await session.page.evaluate(() => {
          const map = document.querySelector('[data-pip="plan"] [data-pip-frame]').__opdTrackInset;
          const canvas = map.getCanvas();
          const box = canvas.getBoundingClientRect();
          const cx = box.left + box.width / 2;
          const cy = box.top + box.height / 2;
          const pair = (t) => [
            { id: 1, x: cx - 36 * (1 - t), y: cy - 90 * t },
            { id: 2, x: cx + 36 * (1 - t), y: cy + 90 * t },
          ];
          const send = (name, active, changed) => {
            const pointer = name === 'touchstart' ? 'pointerdown' : name === 'touchend' ? 'pointerup' : 'pointermove';
            for (const point of changed) canvas.dispatchEvent(new PointerEvent(pointer, {
              bubbles: true, cancelable: true, pointerId: point.id, pointerType: 'touch',
              clientX: point.x, clientY: point.y, isPrimary: point.id === 1,
            }));
            const touch = (point) => document.createTouch
              ? document.createTouch(window, canvas, point.id, point.x, point.y, point.x, point.y, point.x, point.y)
              : new Touch({ identifier: point.id, target: canvas, clientX: point.x, clientY: point.y, pageX: point.x, pageY: point.y });
            const list = (points) => document.createTouchList ? document.createTouchList(...points.map(touch)) : points.map(touch);
            canvas.dispatchEvent(new TouchEvent(name, { bubbles: true, cancelable: true, touches: list(active), targetTouches: list(active), changedTouches: list(changed) }));
          };
          canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 99, pointerType: 'touch', clientX: cx, clientY: cy }));
          canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 99, pointerType: 'touch', clientX: cx, clientY: cy }));
          window.__planPinchTrace.events = [];
          map.jumpTo({ zoom: 1, bearing: 0, pitch: 0 });
          const first = pair(0);
          send('touchstart', [first[0]], [first[0]]);
          send('touchstart', first, [first[1]]);
          for (let step = 1; step <= 6; step += 1) {
            const next = pair(step / 6);
            send('touchmove', next, next);
          }
          send('touchend', [], pair(1));
        });
        await session.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      const result = await session.page.evaluate(() => {
        const frame = document.querySelector('[data-pip="plan"] [data-pip-frame]');
        const map = frame.__opdTrackInset;
        return { ...window.__planPinchTrace, finalWidth: map.getCanvas().clientWidth, zoom: map.getZoom(), bearing: map.getBearing() };
      });
      assert.ok(result.zoom > 1.2, JSON.stringify(result));
      assert.equal(result.bearing, 0);
      assert.equal(result.resize.during, result.originalWidth, 'resize stays deferred while fingers are down');
      assert.equal(result.finalWidth, result.resize.requested, 'deferred resize completes on release');
      const pointers = (type) => result.events.filter((event) => event.type === type);
      assert.deepEqual(pointers('pointerdown').map((event) => event.pointerId), [1, 2]);
      assert.deepEqual(pointers('pointerup').map((event) => event.pointerId), [1, 2]);
      assert.equal(pointers('pointermove').length, 12);
      assert.ok(result.events.filter((event) => event.type.startsWith('pointer')).every((event) => event.pointerType === 'touch'));
      const moves = pointers('touchmove');
      assert.equal(moves.length, 6);
      if (burst) {
        assert.equal(new Set(moves.map((event) => event.frame)).size, 1, 'all moves were queued before rendering');
        assert.equal(pointers('pointerup')[0].zoom, 1, 'the release begins with zoom still queued');
        assert.ok(Math.abs(result.zoom - (1 + Math.log2(2.5))) < 0.02, 'the full queued zoom survives release');
      }
    } finally {
      await browser?.close();
      await served.close();
    }
  });
}
