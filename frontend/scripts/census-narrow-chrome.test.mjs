import assert from 'node:assert/strict';
import { test } from 'node:test';
import { narrowPlacementViolations } from './census-narrow-chrome.mjs';

test('permits measuring scrolled content without changing its scroll position', () => {
  assert.deepEqual(narrowPlacementViolations('', 'const contentBottom = rect.bottom + panel.scrollTop;'), []);
});

test('rejects scroll writes, increments, and scrolling methods', () => {
  for (const source of ['panel.scrollTop = 0;', 'dock.scrollLeft += 1;', 'panel.scrollTop++;', '--dock.scrollLeft;', 'panel.scrollTo(0, 0);', 'panel.scrollBy(0, 1);', 'panel.scroll(0, 0);']) {
    assert.deepEqual(narrowPlacementViolations('', source), ['map-chrome.ts writes a scroll offset'], source);
  }
});

test('still rejects a second narrow chrome positioner', () => {
  assert.equal(narrowPlacementViolations('@media (max-width: 719px) { .map-control-dock { left: 0; } }').length, 1);
});
