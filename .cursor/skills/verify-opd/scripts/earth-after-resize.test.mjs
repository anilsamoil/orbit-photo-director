import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  earthAfterResizeReaders,
  missingListenerMutant,
  POISONED_EARTH,
  rafWrappedMutant,
  sameTurnEarthVerdict,
  settledEarthVerdict,
  syncListenerHealthy,
} from './earth-after-resize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const drive = readFileSync(resolve(here, 'drive.mjs'), 'utf8');

function emittedResize(listener) {
  let frameNumber = 0;
  let queued = [];
  let rafId = 0;
  const reads = [];
  const dispatches = [];
  class Frame {
    style = { width: '278px', height: '185px' };

    getBoundingClientRect() {
      const box = { width: parseFloat(this.style.width), height: parseFloat(this.style.height) };
      reads.push({ ...box, frameNumber });
      return box;
    }
  }
  const frame = new Frame();
  const requestAnimationFrame = (callback) => {
    queued.push(callback);
    return ++rafId;
  };
  const recover = () => Object.assign(frame.style, { width: '278px', height: '185px' });
  const result = runInNewContext(`${earthAfterResizeReaders()}\nsettleEarthAfterResize()`, {
    HTMLElement: Frame,
    Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame,
    document: {
      querySelector(selector) {
        assert.equal(selector, '[data-iss-frame]');
        return frame;
      },
    },
    window: {
      dispatchEvent(event) {
        dispatches.push({ type: event.type, ...frame.style });
        if (listener === 'sync') recover();
        if (listener === 'raf') requestAnimationFrame(recover);
        return true;
      },
    },
  });
  return {
    result,
    reads,
    dispatches,
    async advanceFrame() {
      frameNumber++;
      const callbacks = queued;
      queued = [];
      for (const callback of callbacks) callback(frameNumber * 1000 / 60);
      await Promise.resolve();
    },
  };
}

for (const listener of ['sync', 'raf', 'missing']) {
  test(`emitted resize reader waits two frames with a ${listener} listener`, async () => {
    const probe = emittedResize(listener);
    assert.deepEqual(probe.dispatches, [{ type: 'resize', width: '109px', height: '72px' }]);
    assert.deepEqual(probe.reads, [], 'must not read the poisoned frame in the dispatch turn');
    await probe.advanceFrame();
    assert.deepEqual(probe.reads, [], 'the first rAF is not the settling boundary');
    await probe.advanceFrame();
    const expected = listener === 'missing'
      ? { step: 'earth', width: 109, height: 72 }
      : { ok: true, width: 278, height: 185 };
    assert.deepEqual(probe.reads, [{ width: expected.width, height: expected.height, frameNumber: 2 }]);
    assert.deepEqual({ ...await probe.result }, expected);
  });
}

test('same-turn oracle fails a correct rAF-wrapped onResize', () => {
  const sample = rafWrappedMutant();
  const sameTurn = sameTurnEarthVerdict(sample);
  const settled = settledEarthVerdict(sample);
  assert.equal(sameTurn.ok, false);
  assert.equal(sameTurn.width, POISONED_EARTH.width);
  assert.equal(sameTurn.height, POISONED_EARTH.height);
  assert.equal(settled.ok, true);
  assert.ok(settled.width >= 240);
  assert.ok(settled.height >= 160);
});

test('settled oracle fails a missing resize listener at the poisoned frame', () => {
  const sample = missingListenerMutant();
  const settled = settledEarthVerdict(sample);
  assert.equal(settled.ok, false);
  assert.equal(settled.step, 'earth');
  assert.equal(settled.width, 109);
  assert.equal(settled.height, 72);
});

test('settled oracle accepts a sync listener that already cleared the poison', () => {
  const settled = settledEarthVerdict(syncListenerHealthy());
  assert.equal(settled.ok, true);
});

test('drive earth wait settles after resize instead of reading the same turn', () => {
  assert.match(drive, /settleEarthAfterResize/);
  assert.match(drive, /requestAnimationFrame/);
  assert.match(drive, /from '\.\/earth-after-resize\.mjs'/);
  assert.match(drive, /resize listener/);
  assert.equal(drive.includes("staleFrame.style.width = '109px';\n  staleFrame.style.height = '72px';\n  }\n  window.dispatchEvent(new Event('resize'));\n  const laidFrame"), false);
});
